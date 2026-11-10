import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Disk sağlığı geçmişi: her fiziksel diskin SMART değerleri saatte bir kaydedilir (13 ay saklanır).
// Grafikler sıcaklığı, bozuk sektör sayaçlarını, aşınmayı ve yazılan veriyi gösterir; sayaçlar
// artarsa uyarı verilir, SSD aşınması artıyorsa kalan ömür kabaca tahmin edilir.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEEP_MS = 400 * DAY;
export const COUNTERS = ['realloc', 'pending', 'offline', 'reported', 'media'];
export const HEALTH_RANGES = { '7d': { span: 7 * DAY, step: HOUR }, '30d': { span: 30 * DAY, step: 6 * HOUR }, '365d': { span: 365 * DAY, step: DAY } };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Anlık görüntüdeki bir diskten kayda girecek değerler (SMART okunamadıysa null).
export function healthSample(d) {
  const s = d.smart;
  if (!s || s.status === 'unknown' || s.standby) return null;
  const a = s.attributes ?? {};
  return {
    temp: num(s.temperature),
    poh: num(s.powerOnHours),
    wear: num(s.wearPercent),
    written: num(s.writtenBytes),
    realloc: num(a.reallocated),
    pending: num(a.pending),
    offline: num(a.offlineUncorrectable),
    reported: num(a.reportedUncorrect),
    media: num(a.mediaErrors),
  };
}

export const diskKey = (d) => `${d.model ?? d.name}|${d.serial ?? d.name}`;

export function createDiskHealth({ dir, now = Date.now }) {
  const file = path.join(dir, 'disk-health.jsonl');
  let rows = [];
  let loaded = false;
  const lastAt = new Map();

  async function load() {
    if (loaded) return;
    loaded = true;
    const text = await readFile(file, 'utf8').catch(() => '');
    const cutoff = now() - KEEP_MS;
    let trimmed = false;
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r.t < cutoff) {
          trimmed = true;
          continue;
        }
        rows.push(r);
        lastAt.set(r.key, Math.max(lastAt.get(r.key) ?? 0, r.t));
      } catch {
        /* yarım satır */
      }
    }
    if (trimmed) {
      await writeFile(`${file}.tmp`, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    }
  }

  async function record(snapshot) {
    await load();
    const t = now();
    const out = [];
    for (const d of snapshot?.storage?.devices ?? []) {
      const key = diskKey(d);
      if (t - (lastAt.get(key) ?? 0) < HOUR - 60_000) continue;
      const sample = healthSample(d);
      if (!sample) continue;
      const row = { t, key, name: d.name, model: d.model ?? null, type: d.type ?? null, ...sample };
      rows.push(row);
      lastAt.set(key, t);
      out.push(JSON.stringify(row));
    }
    if (out.length) {
      await mkdir(dir, { recursive: true });
      await appendFile(file, `${out.join('\n')}\n`, { mode: 0o600 });
    }
  }

  // Değişimler: son 7 günde artan bozuk sektör sayaçları; SSD aşınma hızına göre kalan ömür.
  function assess(list) {
    const last = list.at(-1);
    const t = last.t;
    // Karşılaştırma: 7 gün önceki son kayıt (yoksa ilk kayıt).
    const base = list.filter((r) => r.t <= t - 7 * DAY).at(-1) ?? list[0];
    const increases = [];
    for (const k of COUNTERS) {
      const before = base[k] ?? list.find((r) => r[k] != null)?.[k];
      if (last[k] != null && before != null && last[k] > before) increases.push({ counter: k, from: before, to: last[k] });
    }
    let yearsLeft = null;
    const wearRows = list.filter((r) => r.wear != null);
    if (wearRows.length > 1) {
      const first = wearRows[0];
      const days = (last.t - first.t) / DAY;
      const grew = (wearRows.at(-1).wear ?? 0) - first.wear;
      if (days >= 14 && grew > 0) yearsLeft = Math.round(((100 - wearRows.at(-1).wear) / (grew / days) / 365) * 10) / 10;
    }
    const since = list[0].t;
    return { increases, yearsLeft, since };
  }

  // Aralığa göre seyreltilmiş noktalar: sıcaklık ortalama, sayaçlar dilimin son değeri.
  function downsample(list, from, step) {
    const out = [];
    let cur = null;
    for (const r of list) {
      if (r.t < from) continue;
      const slot = Math.floor(r.t / step) * step;
      if (!cur || cur.t !== slot) {
        if (cur) out.push(finish(cur));
        cur = { t: slot, tempSum: 0, tempN: 0, last: r };
      }
      if (r.temp != null) {
        cur.tempSum += r.temp;
        cur.tempN++;
      }
      cur.last = r;
    }
    if (cur) out.push(finish(cur));
    return out;
  }
  const finish = (c) => {
    const { last } = c;
    return { t: c.t, temp: c.tempN ? Math.round((c.tempSum / c.tempN) * 10) / 10 : null, wear: last.wear, written: last.written, poh: last.poh, ...Object.fromEntries(COUNTERS.map((k) => [k, last[k]])) };
  };

  function byDisk() {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.key)) map.set(r.key, []);
      map.get(r.key).push(r);
    }
    return map;
  }

  return {
    record,
    async query(range = '30d') {
      await load();
      const r = HEALTH_RANGES[range] ?? HEALTH_RANGES['30d'];
      const t = now();
      const disks = [];
      for (const [key, list] of byDisk()) {
        const last = list.at(-1);
        // 30 günden uzun süredir görülmeyen (çıkarılmış) diskler listelenmez.
        if (t - last.t > 30 * DAY) continue;
        disks.push({ key, name: last.name, model: last.model, type: last.type, latest: last, ...assess(list), points: downsample(list, t - r.span, r.step) });
      }
      disks.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
      return { range, step: r.step, span: r.span, disks };
    },
    // Genel bakış uyarısı: son 7 günde bozuk sektör sayacı artan diskler.
    async alerts() {
      await load();
      const out = [];
      for (const [, list] of byDisk()) {
        if (now() - list.at(-1).t > 2 * DAY) continue;
        const { increases } = assess(list);
        if (increases.length) out.push({ name: list.at(-1).name, model: list.at(-1).model, increases });
      }
      return out;
    },
  };
}
