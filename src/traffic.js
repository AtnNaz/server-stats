import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HOUR = 3_600_000;
const KEEP_MONTHS = 13;
const FLUSH_MS = 5 * 60_000;
const MONTH_FILE = /^(\d{4}-\d{2})\.json$/;
export const PHYSICAL = ['ethernet', 'wifi'];

const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const hourOf = (ms) => Math.floor(ms / HOUR) * HOUR;
const finite = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function counterDelta(cur, old) {
  if (!finite(cur) || !finite(old)) return 0;
  return cur >= old ? cur - old : cur;
}

function addTo(target, name, rx, tx) {
  if (!rx && !tx) return;
  const v = (target[name] ??= [0, 0]);
  v[0] += rx;
  v[1] += tx;
}

function merge(target, source) {
  for (const [name, [rx, tx]] of Object.entries(source ?? {})) addTo(target, name, rx, tx);
}

export function localKey(ms, offsetMinutes, unit) {
  const iso = new Date(ms - offsetMinutes * 60_000).toISOString();
  return unit === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}

function shiftKey(key, unit, by) {
  if (unit === 'month') {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + by, 1));
    return d.toISOString().slice(0, 7);
  }
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

export function summarize(hours, { now, offsetMinutes = 0, hourCount = 24, dayCount = 30, monthCount = 12 }) {
  const current = hourOf(now);
  const hourly = [];
  for (let i = hourCount - 1; i >= 0; i--) {
    const t = current - i * HOUR;
    const b = hours.get(t);
    hourly.push({ key: String(t), t, ifaces: structuredClone(b?.i ?? {}), containers: structuredClone(b?.c ?? {}) });
  }
  const group = (unit, count) => {
    const last = localKey(now, offsetMinutes, unit);
    const keys = Array.from({ length: count }, (_, i) => shiftKey(last, unit, i - count + 1));
    const items = new Map(keys.map((key) => [key, { key, ifaces: {}, containers: {} }]));
    for (const [t, b] of hours) {
      const item = items.get(localKey(t, offsetMinutes, unit));
      if (!item) continue;
      merge(item.ifaces, b.i);
      merge(item.containers, b.c);
    }
    return [...items.values()];
  };
  return { hourly, daily: group('day', dayCount), monthly: group('month', monthCount) };
}

export function createTraffic({ dir, now = Date.now, bootId = async () => null }) {
  const hours = new Map();
  const kinds = {};
  const dirty = new Set();
  let last = { boot: null, ifaces: {}, containers: {} };
  let loaded = null;
  let timer = null;

  function bucket(t) {
    const h = hourOf(t);
    let b = hours.get(h);
    if (!b) hours.set(h, (b = { i: {}, c: {} }));
    dirty.add(monthOf(h));
    return b;
  }

  async function load() {
    await mkdir(dir, { recursive: true });
    for (const name of await readdir(dir).catch(() => [])) {
      const m = MONTH_FILE.exec(name);
      if (!m) continue;
      try {
        const data = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
        for (const [t, b] of Object.entries(data.hours ?? {})) hours.set(Number(t), { i: b.i ?? {}, c: b.c ?? {} });
        Object.assign(kinds, data.kinds ?? {});
      } catch {
        continue;
      }
    }
    const boot = await bootId();
    try {
      const saved = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
      if (boot && saved.boot === boot) last = { boot, ifaces: saved.ifaces ?? {}, containers: saved.containers ?? {} };
      else last = { boot, ifaces: {}, containers: saved.containers ?? {} };
    } catch {
      last = { boot, ifaces: {}, containers: {} };
    }
  }

  const ready = () => (loaded ??= load());

  async function flush() {
    await ready();
    const cutoff = monthOf(Date.UTC(new Date(now()).getUTCFullYear(), new Date(now()).getUTCMonth() - KEEP_MONTHS + 1, 1));
    for (const t of [...hours.keys()]) if (monthOf(t) < cutoff) hours.delete(t);
    for (const month of [...dirty]) {
      dirty.delete(month);
      const data = { kinds, hours: Object.fromEntries([...hours].filter(([t]) => monthOf(t) === month)) };
      const file = path.join(dir, `${month}.json`);
      await writeFile(`${file}.tmp`, JSON.stringify(data));
      await rename(`${file}.tmp`, file);
    }
    for (const name of await readdir(dir).catch(() => [])) {
      const m = MONTH_FILE.exec(name);
      if (m && m[1] < cutoff) await unlink(path.join(dir, name)).catch(() => {});
    }
    const file = path.join(dir, 'state.json');
    await writeFile(`${file}.tmp`, JSON.stringify(last));
    await rename(`${file}.tmp`, file);
  }

  return {
    ready,
    async record(interfaces = []) {
      await ready();
      const t = now();
      const b = bucket(t);
      for (const i of interfaces) {
        if (!i?.name || !finite(i.rxTotal) || !finite(i.txTotal)) continue;
        if (i.kind) kinds[i.name] = i.kind;
        const old = last.ifaces[i.name];
        if (old) addTo(b.i, i.name, counterDelta(i.rxTotal, old[0]), counterDelta(i.txTotal, old[1]));
        last.ifaces[i.name] = [i.rxTotal, i.txTotal];
      }
    },
    async recordContainers(list = []) {
      await ready();
      const t = now();
      const b = bucket(t);
      const seen = {};
      for (const c of list) {
        if (!c?.id || !c.name || !finite(c.rx) || !finite(c.tx)) continue;
        const old = last.containers[c.id];
        if (old) addTo(b.c, c.name, counterDelta(c.rx, old[0]), counterDelta(c.tx, old[1]));
        seen[c.id] = [c.rx, c.tx];
      }
      last.containers = seen;
    },
    async query({ offsetMinutes = 0 } = {}) {
      await ready();
      return { interfaces: Object.entries(kinds).map(([name, kind]) => ({ name, kind, physical: PHYSICAL.includes(kind) })), ...summarize(hours, { now: now(), offsetMinutes }) };
    },
    flush,
    start() {
      if (timer) return;
      timer = setInterval(() => flush().catch((err) => console.warn(`Trafik geçmişi kaydedilemedi: ${err.message}`)), FLUSH_MS);
      timer.unref?.();
    },
    async stop() {
      clearInterval(timer);
      timer = null;
      await flush().catch(() => {});
    },
  };
}
