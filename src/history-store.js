import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

// Aralık başına nokta aralığı: grafik ~300 nokta gösterir, dosyalar dakikalık tutulur.
export const RANGES = {
  '1d': { span: DAY, step: 5 * MINUTE },
  '7d': { span: 7 * DAY, step: 30 * MINUTE },
  '30d': { span: 30 * DAY, step: 2 * 60 * MINUTE },
};

const SCALARS = ['cpu', 'mem', 'swap', 'load', 'cpuTemp', 'diskTemp'];
const MAPS = ['net', 'io', 'gpu'];

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const round1 = (v) => Math.round(v * 10) / 10;

// Bir anlık görüntüden kalıcı geçmişe giren değerler.
export function sampleOf(s) {
  const disks = [s.sensors?.hottestDisk, ...(s.storage?.devices ?? []).map((d) => d.smart?.temperature)].filter((v) => v != null);
  return {
    cpu: s.system?.cpu?.usage ?? null,
    mem: s.system?.memory?.percent ?? null,
    swap: s.system?.memory?.swapPercent ?? null,
    load: s.system?.cpu?.load?.[0] ?? null,
    cpuTemp: s.sensors?.cpu?.package ?? null,
    diskTemp: disks.length ? Math.max(...disks) : null,
    net: Object.fromEntries((s.network?.interfaces ?? []).map((i) => [i.name, [i.rxRate, i.txRate]])),
    io: Object.fromEntries((s.storage?.devices ?? []).map((d) => [d.name, [d.readRate, d.writeRate]])),
    gpu: Object.fromEntries((s.gpu?.gpus ?? []).map((g) => [g.id, [g.utilization, g.memoryPercent, g.temperature, g.powerDraw]])),
  };
}

// Toplayıcı: sayıların ortalamasını, null'ları atlayarak tutar.
function createAccumulator() {
  const sums = {};
  const counts = {};
  const add = (key, v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    sums[key] = (sums[key] ?? 0) + v;
    counts[key] = (counts[key] ?? 0) + 1;
  };
  return {
    add(sample) {
      for (const k of SCALARS) add(k, sample[k]);
      for (const m of MAPS) {
        for (const [name, values] of Object.entries(sample[m] ?? {})) {
          values.forEach((v, i) => add(`${m}\u0000${name}\u0000${i}`, v));
        }
      }
    },
    result() {
      const out = {};
      for (const k of SCALARS) out[k] = counts[k] ? round1(sums[k] / counts[k]) : null;
      for (const m of MAPS) out[m] = {};
      for (const key of Object.keys(sums)) {
        const [m, name, i] = key.split('\u0000');
        if (!MAPS.includes(m)) continue;
        (out[m][name] ??= [])[Number(i)] = round1(sums[key] / counts[key]);
      }
      for (const m of MAPS) for (const values of Object.values(out[m])) for (let i = 0; i < values.length; i++) values[i] ??= null;
      return out;
    },
    get empty() {
      return Object.keys(counts).length === 0;
    },
  };
}

// Uzun süreli ölçüm geçmişi: örnekler dakikalık ortalamalara indirilir ve günlük JSONL dosyalarına eklenir.
// Panel yeniden başlasa da geçmiş kalır; retentionDays'ten eski dosyalar silinir.
export function createHistoryStore({ dir, retentionDays = 30, now = Date.now }) {
  let minute = null;
  let acc = createAccumulator();
  let lastCleanup = null;
  let writing = Promise.resolve();
  const cache = new Map();

  async function cleanup(today) {
    if (lastCleanup === today) return;
    lastCleanup = today;
    const cutoff = dayOf(now() - retentionDays * DAY);
    for (const name of await readdir(dir).catch(() => [])) {
      const m = FILE.exec(name);
      if (m && m[1] < cutoff) await unlink(path.join(dir, name)).catch(() => {});
    }
  }

  function flush() {
    if (minute === null || acc.empty) return writing;
    const line = `${JSON.stringify({ t: minute, ...acc.result() })}\n`;
    const day = dayOf(minute);
    acc = createAccumulator();
    writing = writing
      .then(async () => {
        await mkdir(dir, { recursive: true, mode: 0o750 });
        await appendFile(path.join(dir, `${day}.jsonl`), line, { mode: 0o640 });
        await cleanup(dayOf(now()));
      })
      .catch((err) => console.warn(`Geçmiş yazılamadı: ${err.message}`));
    return writing;
  }

  async function readRange(from, to) {
    const days = [];
    for (let d = from - (from % DAY); d <= to; d += DAY) days.push(dayOf(d));
    const points = [];
    for (const day of days) {
      let text;
      try {
        text = await readFile(path.join(dir, `${day}.jsonl`), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const p = JSON.parse(line);
          if (typeof p?.t === 'number' && p.t >= from && p.t <= to) points.push(p);
        } catch {
          // Yarım kalmış satır (ör. elektrik kesintisi) atlanır.
        }
      }
    }
    return points;
  }

  return {
    // Örnekleyici her turda çağırır; dakika değişince önceki dakika diske yazılır.
    add(snapshot) {
      const m = snapshot.time - (snapshot.time % MINUTE);
      if (minute !== null && m !== minute) flush();
      minute = m;
      acc.add(sampleOf(snapshot));
    },
    flush,
    async query(range) {
      const r = RANGES[range];
      if (!r) throw new Error('range');
      const to = now();
      const cached = cache.get(range);
      if (cached && to - cached.at < 60_000) return cached.data;
      const from = to - r.span;
      const start = from - (from % r.step);
      const count = Math.ceil((to - start) / r.step);
      const buckets = Array.from({ length: count }, createAccumulator);
      for (const p of await readRange(start, to)) {
        const i = Math.floor((p.t - start) / r.step);
        if (i >= 0 && i < count) buckets[i].add(p);
      }
      const data = {
        range,
        step: r.step,
        points: buckets.map((b, i) => ({ t: start + i * r.step, ...(b.empty ? {} : b.result()) })),
      };
      cache.set(range, { at: to, data });
      return data;
    },
  };
}
