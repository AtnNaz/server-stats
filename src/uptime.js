import net from 'node:net';
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Servis izleme: panel, tanımlanan adreslere (HTTP/HTTPS ya da TCP portu) düzenli aralıkla bağlanır;
// yanıt süresini, çalışma yüzdesini ve kesintileri kaydeder. İstekler sunucunun kendisinden çıkar.
//   <dir>/monitors.json        izlenen hedefler
//   <dir>/YYYY-MM-DD.jsonl     her denetim: { id, t, ok, ms, code, err }
//   <dir>/incidents.json       kesintiler (en fazla 300)

export const INTERVALS = [30, 60, 120, 300];
export const MAX_MONITORS = 30;
const KEEP_DAYS = 31;
const DAY = 86_400_000;
const FAILS_FOR_DOWN = 2; // tek bir zaman aşımı kesinti sayılmaz
const MAX_INCIDENTS = 300;
const FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const HOST = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$|^\d{1,3}(?:\.\d{1,3}){3}$|^\[[0-9a-fA-F:.]+\]$/;

export function validateMonitor(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const name = typeof m.name === 'string' ? m.name.trim() : '';
  if (!name || name.length > 40 || /[\0-\x1f]/.test(name)) return null;
  const interval = INTERVALS.includes(m.interval) ? m.interval : 60;
  const id = typeof m.id === 'string' && /^[0-9a-f-]{36}$/.test(m.id) ? m.id : randomUUID();
  if (m.type === 'http') {
    let u;
    try {
      u = new URL(String(m.target ?? '').trim());
    } catch {
      return null;
    }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || String(m.target).length > 300) return null;
    return { id, name, type: 'http', target: u.href, interval };
  }
  if (m.type === 'tcp') {
    const t = String(m.target ?? '').trim();
    const match = /^(.+):(\d{1,5})$/.exec(t);
    if (!match || !HOST.test(match[1]) || Number(match[2]) < 1 || Number(match[2]) > 65535) return null;
    return { id, name, type: 'tcp', target: `${match[1]}:${Number(match[2])}`, interval };
  }
  return null;
}

export function validateMonitorList(list) {
  if (!Array.isArray(list) || list.length > MAX_MONITORS) return null;
  const out = [];
  for (const m of list) {
    const v = validateMonitor(m);
    if (!v || out.some((x) => x.id === v.id)) return null;
    out.push(v);
  }
  return out;
}

function tcpCheck(target, timeoutMs, connect = net.connect) {
  const i = target.lastIndexOf(':');
  const host = target.slice(0, i).replace(/^\[|\]$/g, '');
  const port = Number(target.slice(i + 1));
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (r) => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => done({ ok: false, err: 'timeout' }));
    sock.once('connect', () => done({ ok: true }));
    sock.once('error', (e) => done({ ok: false, err: e.code === 'ECONNREFUSED' ? 'refused' : e.code === 'ENOTFOUND' ? 'dns' : 'error' }));
  });
}

async function httpCheck(target, timeoutMs, fetchImpl) {
  try {
    const res = await fetchImpl(target, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'node-stats-uptime' } });
    res.body?.cancel?.().catch(() => {});
    // Sunucu yanıt verdiyse ayaktadır; yalnızca 5xx (ve ağ hatası) kesinti sayılır. Giriş isteyen
    // paneller 401/302 döndürebilir.
    return { ok: res.status < 500, code: res.status };
  } catch (e) {
    const name = e.cause?.code ?? e.name;
    return { ok: false, err: name === 'TimeoutError' ? 'timeout' : name === 'ENOTFOUND' ? 'dns' : name === 'ECONNREFUSED' ? 'refused' : /CERT|TLS|SSL/i.test(String(name)) ? 'tls' : 'error' };
  }
}

export function createUptime({ dir, fetchImpl = fetch, connect = net.connect, now = Date.now, timeoutMs = 10_000 }) {
  const monitorsFile = path.join(dir, 'monitors.json');
  const incidentsFile = path.join(dir, 'incidents.json');
  let monitors = [];
  let incidents = [];
  // Bellekte: her hedefin son 24 saatlik sonuçları ve anlık durumu.
  const recent = new Map(); // id -> [{ t, ok, ms }]
  const state = new Map(); // id -> { last, fails, running, nextAt }
  let timer = null;

  async function writeJson(file, data) {
    await mkdir(dir, { recursive: true });
    await writeFile(`${file}.tmp`, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }

  async function readDay(day) {
    const text = await readFile(path.join(dir, `${day}.jsonl`), 'utf8').catch(() => '');
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* yarım satır */
      }
    }
    return out;
  }

  async function load() {
    monitors = (await readFile(monitorsFile, 'utf8').then(JSON.parse, () => [])) ?? [];
    monitors = validateMonitorList(monitors) ?? [];
    incidents = await readFile(incidentsFile, 'utf8').then(JSON.parse, () => []);
    const t = now();
    const rows = [...(await readDay(dayOf(t - DAY))), ...(await readDay(dayOf(t)))].filter((r) => r.t > t - DAY);
    for (const r of rows) {
      if (!recent.has(r.id)) recent.set(r.id, []);
      recent.get(r.id).push({ t: r.t, ok: r.ok, ms: r.ms ?? null });
    }
    for (const m of monitors) {
      const list = recent.get(m.id) ?? [];
      const last = list.at(-1) ?? null;
      let fails = 0;
      for (let i = list.length - 1; i >= 0 && !list[i].ok; i--) fails++;
      state.set(m.id, { last, fails, running: false, nextAt: t + Math.random() * 5000 });
    }
    // 31 günden eski günlük dosyalar silinir.
    const cutoff = dayOf(t - KEEP_DAYS * DAY);
    for (const name of await readdir(dir).catch(() => [])) {
      const m = FILE.exec(name);
      if (m && m[1] < cutoff) await unlink(path.join(dir, name)).catch(() => {});
    }
  }

  async function check(m) {
    const st = state.get(m.id) ?? { last: null, fails: 0 };
    if (st.running) return st.last;
    st.running = true;
    state.set(m.id, st);
    const t0 = now();
    const started = performance.now();
    const r = m.type === 'tcp' ? await tcpCheck(m.target, timeoutMs, connect) : await httpCheck(m.target, timeoutMs, fetchImpl);
    const ms = r.ok ? Math.round(performance.now() - started) : null;
    const row = { id: m.id, t: t0, ok: r.ok, ms, ...(r.code != null && { code: r.code }), ...(r.err && { err: r.err }) };
    st.running = false;
    st.nextAt = t0 + m.interval * 1000;
    // Hedef silindiyse sonuç kaydedilmez.
    if (!monitors.some((x) => x.id === m.id)) return row;
    st.last = row;
    const wasDown = st.fails >= FAILS_FOR_DOWN;
    st.fails = r.ok ? 0 : st.fails + 1;
    const isDown = st.fails >= FAILS_FOR_DOWN;
    if (!recent.has(m.id)) recent.set(m.id, []);
    const list = recent.get(m.id);
    list.push({ t: t0, ok: r.ok, ms });
    while (list.length && list[0].t < t0 - DAY) list.shift();
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, `${dayOf(t0)}.jsonl`), `${JSON.stringify(row)}\n`, { mode: 0o600 }).catch(() => {});
    if (!wasDown && isDown) {
      // Kesinti ilk başarısız denetimden başlar.
      const firstFail = [...list].reverse().find((x, i, arr) => !x.ok && (arr[i + 1]?.ok ?? true))?.t ?? t0;
      incidents.push({ id: m.id, name: m.name, start: firstFail, end: null, reason: r.err ?? (r.code ? `HTTP ${r.code}` : 'error') });
      incidents = incidents.slice(-MAX_INCIDENTS);
      await writeJson(incidentsFile, incidents).catch(() => {});
    } else if (wasDown && !isDown) {
      const open = [...incidents].reverse().find((x) => x.id === m.id && !x.end);
      if (open) open.end = t0;
      await writeJson(incidentsFile, incidents).catch(() => {});
    }
    return row;
  }

  function tick() {
    const t = now();
    for (const m of monitors) {
      const st = state.get(m.id);
      if (!st || st.running || st.nextAt > t) continue;
      check(m).catch(() => {});
    }
  }

  function uptimeOf(list) {
    if (!list.length) return null;
    return Math.round((list.filter((x) => x.ok).length / list.length) * 10000) / 100;
  }

  // Uzun aralıkların çalışma yüzdesi günlük dosyalardan hesaplanır (önbellekli, 10 dakikada bir).
  let longCache = { at: 0, data: {} };
  async function longStats() {
    if (now() - longCache.at < 10 * 60_000) return longCache.data;
    const t = now();
    const data = {};
    for (let d = 0; d < 30; d++) {
      for (const r of await readDay(dayOf(t - d * DAY))) {
        if (r.t < t - 30 * DAY) continue;
        const s = (data[r.id] ??= { d7: [0, 0], d30: [0, 0] });
        s.d30[0]++;
        if (r.ok) s.d30[1]++;
        if (r.t >= t - 7 * DAY) {
          s.d7[0]++;
          if (r.ok) s.d7[1]++;
        }
      }
    }
    longCache = { at: t, data };
    return data;
  }
  const pct = ([n, ok]) => (n ? Math.round((ok / n) * 10000) / 100 : null);

  // Son 24 saat 48 dilimde (30 dk): ortalama yanıt süresi ve dilimde kesinti olup olmadığı.
  function buckets(list, t) {
    const size = 30 * 60_000;
    const out = Array.from({ length: 48 }, (_, i) => ({ t: t - (48 - i) * size, ms: null, down: false, n: 0 }));
    const sums = new Array(48).fill(0);
    const counts = new Array(48).fill(0);
    for (const x of list) {
      const i = Math.floor((x.t - (t - 48 * size)) / size);
      if (i < 0 || i >= 48) continue;
      out[i].n++;
      if (!x.ok) out[i].down = true;
      if (x.ms != null) {
        sums[i] += x.ms;
        counts[i]++;
      }
    }
    out.forEach((b, i) => (b.ms = counts[i] ? Math.round(sums[i] / counts[i]) : null));
    return out;
  }

  return {
    async start() {
      await load();
      timer = setInterval(tick, 5000);
      timer.unref();
      tick();
    },
    stop() {
      clearInterval(timer);
    },
    list: () => monitors,
    async save(list) {
      const valid = validateMonitorList(list);
      if (!valid) return null;
      const t = now();
      for (const m of valid) {
        const old = monitors.find((x) => x.id === m.id);
        // Yeni ya da hedefi değişen izleme hemen denetlenir.
        if (!old || old.target !== m.target || old.type !== m.type) state.set(m.id, { last: null, fails: 0, running: false, nextAt: t });
        else if (!state.has(m.id)) state.set(m.id, { last: null, fails: 0, running: false, nextAt: t });
        if (old && (old.target !== m.target || old.type !== m.type)) recent.delete(m.id);
      }
      for (const m of monitors) if (!valid.some((x) => x.id === m.id)) {
        state.delete(m.id);
        recent.delete(m.id);
      }
      monitors = valid;
      await writeJson(monitorsFile, monitors);
      setTimeout(tick, 100).unref?.();
      return monitors;
    },
    async checkNow(id) {
      const m = monitors.find((x) => x.id === id);
      return m ? check(m) : null;
    },
    async status() {
      const t = now();
      const long = await longStats();
      return {
        monitors: monitors.map((m) => {
          const st = state.get(m.id) ?? {};
          const list = recent.get(m.id) ?? [];
          const msList = list.filter((x) => x.ms != null).map((x) => x.ms);
          return {
            ...m,
            status: !st.last ? 'pending' : st.fails >= FAILS_FOR_DOWN ? 'down' : st.last.ok ? 'up' : 'flaky',
            last: st.last ?? null,
            uptime24h: uptimeOf(list),
            uptime7d: long[m.id] ? pct(long[m.id].d7) : uptimeOf(list),
            uptime30d: long[m.id] ? pct(long[m.id].d30) : uptimeOf(list),
            avgMs: msList.length ? Math.round(msList.reduce((a, b) => a + b, 0) / msList.length) : null,
            buckets: buckets(list, t),
          };
        }),
        incidents: incidents.slice(-50).reverse(),
      };
    },
    // Genel bakış uyarısı için: şu an kesintide olanlar.
    down() {
      return monitors.filter((m) => (state.get(m.id)?.fails ?? 0) >= FAILS_FOR_DOWN).map((m) => ({ id: m.id, name: m.name, since: [...incidents].reverse().find((x) => x.id === m.id && !x.end)?.start ?? null }));
    },
  };
}
