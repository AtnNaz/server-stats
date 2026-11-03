import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// İnternet hız testi: sunucu ile Cloudflare'in hız testi sunucusu (speed.cloudflare.com) arasında
// gecikme, indirme ve yükleme ölçülür. Ek araç gerekmez; yalnızca test çalışırken dışarıya bağlanılır.
const BASE = 'https://speed.cloudflare.com';
const STREAMS = 4;
const PHASE_MS = 8_000;
// Bir aşamada aktarılacak en fazla veri (hızlı bağlantılarda kotayı korumak için).
const MAX_BYTES = 400 * 1024 * 1024;
// Büyük parça az istek demek: Cloudflare çok sık isteği geçici olarak sınırlar (429);
// 100 MB'tan büyük parçayı ise hiç kabul etmez (403).
const DOWN_CHUNK = 50_000_000;
// Yükleme parçası küçük başlar, hızlı bağlantıda büyür: yavaş hatta bir parça süre içinde biter,
// hızlı hatta istek başına gecikme ölçümü düşürmez.
const UP_START = 1024 * 1024;
const UP_MAX = 16 * 1024 * 1024;
const MAX_HISTORY = 500;
export const SCHEDULE_HOURS = [0, 1, 3, 6, 12, 24];

// "cfSpeedEdge;dur=7, cfSpeedWorker;dur=12" → 19 (cfL4 bağlantı bilgisidir, sayılmaz)
export function serverMs(header) {
  if (!header) return 0;
  return header
    .split(',')
    .filter((part) => !/^\s*cfL4/.test(part))
    .reduce((sum, part) => sum + (Number(/dur=([\d.]+)/.exec(part)?.[1]) || 0), 0);
}

// Cloudflare bir yanıt veremezse (ör. 429 sınırlama) test sıfır sonuçla kaydedilmez, hata verir.
function checked(r) {
  if (!r.ok) throw Object.assign(new Error(`http_${r.status}`), { status: r.status });
  return r;
}

const mbps = (bytes, ms) => (ms > 0 ? Math.round(((bytes * 8) / (ms / 1000) / 1e6) * 10) / 10 : null);
const median = (values) => {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

export function createSpeedtest({ dir, fetchImpl = fetch, now = Date.now, phaseMs = PHASE_MS, maxBytes = MAX_BYTES }) {
  const file = path.join(dir, 'speedtest.jsonl');
  let state = { running: false, phase: null, progress: null, error: null };
  let history = null;

  async function loadHistory() {
    if (history) return history;
    const text = await readFile(file, 'utf8').catch(() => '');
    history = text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-MAX_HISTORY);
    return history;
  }

  async function record(result) {
    const list = await loadHistory();
    list.push(result);
    await mkdir(dir, { recursive: true });
    if (list.length > MAX_HISTORY) {
      history = list.slice(-MAX_HISTORY);
      await writeFile(file, `${history.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o640 });
    } else {
      await appendFile(file, `${JSON.stringify(result)}\n`, { mode: 0o640 });
    }
  }

  // Gecikme: istek süresinden Cloudflare'in kendi işlem süresi (Server-Timing) çıkarılır.
  async function latency() {
    const times = [];
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now();
      const r = checked(await fetchImpl(`${BASE}/__down?bytes=0`, { signal: AbortSignal.timeout(5000) }));
      await r.arrayBuffer();
      const elapsed = performance.now() - t0;
      if (i > 1) times.push(Math.max(0, elapsed - serverMs(r.headers.get('server-timing')))); // ilk istekler bağlantı kurulumunu içerir
    }
    const jitter = times.length > 1 ? times.slice(1).reduce((s, t, i) => s + Math.abs(t - times[i]), 0) / (times.length - 1) : null;
    return { ping: Math.round(median(times) * 10) / 10, jitter: jitter == null ? null : Math.round(jitter * 10) / 10 };
  }

  // Birkaç paralel akışla süre dolana ya da veri sınırına ulaşana kadar aktarır.
  async function transfer(kind) {
    let bytes = 0;
    const started = performance.now();
    const deadline = started + phaseMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), phaseMs + 2000);
    const payload = kind === 'up' ? new Uint8Array(UP_MAX) : null;
    const worker = async () => {
      let size = UP_START;
      while (performance.now() < deadline && bytes < maxBytes) {
        if (kind === 'down') {
          const r = checked(await fetchImpl(`${BASE}/__down?bytes=${DOWN_CHUNK}`, { signal: controller.signal }));
          for await (const chunk of r.body) {
            bytes += chunk.length;
            state.progress = mbps(bytes, performance.now() - started);
            if (performance.now() >= deadline || bytes >= maxBytes) {
              controller.abort();
              break;
            }
          }
        } else {
          const t0 = performance.now();
          await fetchImpl(`${BASE}/__up`, { method: 'POST', body: payload.subarray(0, size), signal: controller.signal, headers: { 'Content-Type': 'application/octet-stream' } }).then((r) => checked(r).arrayBuffer());
          bytes += size;
          state.progress = mbps(bytes, performance.now() - started);
          if (performance.now() - t0 < 1000 && size < UP_MAX) size *= 2;
        }
      }
    };
    await Promise.all(Array.from({ length: STREAMS }, () => worker().catch((err) => {
      if (!controller.signal.aborted) throw err;
    })));
    clearTimeout(timer);
    if (!bytes) throw new Error('no_data');
    return { mbps: mbps(bytes, Math.min(performance.now(), deadline + 2000) - started), bytes };
  }

  // Test sunucusunun konumu (ör. IST); genel IP adresi saklanmaz.
  async function serverInfo() {
    try {
      const text = await (await fetchImpl(`${BASE}/cdn-cgi/trace`, { signal: AbortSignal.timeout(5000) })).text();
      const field = (k) => new RegExp(`^${k}=([A-Za-z0-9-]{1,10})$`, 'm').exec(text)?.[1] ?? null;
      return { colo: field('colo'), country: field('loc') };
    } catch {
      return { colo: null, country: null };
    }
  }

  async function run(trigger) {
    state = { running: true, phase: 'ping', progress: null, error: null, startedAt: now() };
    try {
      const info = await serverInfo();
      const ping = await latency();
      state.phase = 'download';
      const down = await transfer('down');
      state.phase = 'upload';
      state.progress = null;
      const up = await transfer('up');
      const result = { time: now(), trigger, download: down.mbps, upload: up.mbps, ...ping, ...info, bytes: down.bytes + up.bytes };
      await record(result);
      console.log(`Hız testi (${trigger}): indirme ${result.download} Mbps, yükleme ${result.upload} Mbps, gecikme ${result.ping} ms`);
      state = { running: false, phase: null, progress: null, error: null };
      return result;
    } catch (err) {
      console.warn(`Hız testi yapılamadı: ${err.message}`);
      state = { running: false, phase: null, progress: null, error: err.status === 429 ? 'rate_limited' : 'failed' };
      return null;
    }
  }

  return {
    // Arka planda başlatır; aynı anda tek test çalışır.
    start(trigger = 'manual') {
      if (state.running) return false;
      run(trigger);
      return true;
    },
    run,
    async status(limit = 200) {
      const list = await loadHistory();
      return { ...state, history: list.slice(-limit) };
    },
    async lastTime() {
      const list = await loadHistory();
      return list.at(-1)?.time ?? 0;
    },
    get running() {
      return state.running;
    },
  };
}
