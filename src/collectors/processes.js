import os from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { mapLimit, readText, round } from '../util.js';

const MAX_COMMAND_LENGTH = 300;

function getconf(name, fallback) {
  try {
    const value = Number(execFileSync('getconf', [name], { encoding: 'utf8', timeout: 2000 }).trim());
    return value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

// Süreç adı (comm) boşluk ve parantez içerebilir; bu yüzden son ')' karakterinden bölünür.
export function parseProcStat(text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open === -1 || close === -1) return null;
  const rest = text.slice(close + 2).split(' ');
  // rest[n - 3], proc(5) belgesindeki n. alana karşılık gelir.
  return {
    pid: Number(text.slice(0, open)),
    comm: text.slice(open + 1, close),
    state: rest[0],
    ppid: Number(rest[1]),
    ticks: Number(rest[11]) + Number(rest[12]),
    threads: Number(rest[17]),
    start: Number(rest[19]),
    rssPages: Number(rest[21]),
  };
}

function createUserLookup() {
  let names = new Map();
  let loadedAt = 0;
  return {
    async refresh() {
      if (Date.now() - loadedAt < 5 * 60_000) return;
      loadedAt = Date.now();
      try {
        const lines = (await readText('/etc/passwd')).split('\n').filter(Boolean);
        names = new Map(lines.map((l) => l.split(':')).map((f) => [Number(f[2]), f[0]]));
      } catch {
        /* kullanıcı adları yerine uid gösterilir */
      }
    },
    name: (uid) => names.get(uid) ?? String(uid),
  };
}

export function createProcessCollector({ top, showCommandLine }) {
  const clockTicks = getconf('CLK_TCK', 100);
  const pageSize = getconf('PAGESIZE', 4096);
  const users = createUserLookup();
  let prev = new Map();
  let prevTime = 0;

  async function details(p) {
    const [status, cmdline] = await Promise.all([
      readText(`/proc/${p.pid}/status`).catch(() => ''),
      showCommandLine ? readFile(`/proc/${p.pid}/cmdline`).catch(() => null) : null,
    ]);
    const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
    let command = cmdline?.length ? cmdline.toString('utf8').replace(/\0+$/, '').replaceAll('\0', ' ') : '';
    if (!command) command = p.pid === 2 || p.ppid === 2 ? `[${p.comm}]` : p.comm;
    return {
      pid: p.pid,
      name: p.comm,
      user: uid == null ? '?' : users.name(Number(uid)),
      state: p.state,
      threads: p.threads,
      cpu: round(p.cpu),
      memory: p.rss,
      memoryPercent: round((p.rss / os.totalmem()) * 100),
      command: command.slice(0, MAX_COMMAND_LENGTH),
    };
  }

  async function collect() {
    const now = Date.now();
    const pids = (await readdir('/proc')).filter((n) => /^\d+$/.test(n));
    const procs = [];
    await mapLimit(pids, 64, async (pid) => {
      try {
        const p = parseProcStat(await readText(`/proc/${pid}/stat`));
        if (p) procs.push(p);
      } catch {
        /* süreç okunurken sonlanmış olabilir */
      }
    });

    const elapsed = prevTime ? (now - prevTime) / 1000 : 0;
    const next = new Map();
    for (const p of procs) {
      const old = prev.get(p.pid);
      // Aynı PID yeniden kullanıldıysa (başlangıç zamanı farklı) önceki değer geçersizdir.
      p.cpu = elapsed > 0 && old && old.start === p.start ? Math.max(0, ((p.ticks - old.ticks) / clockTicks / elapsed) * 100) : null;
      p.rss = p.rssPages * pageSize;
      next.set(p.pid, { ticks: p.ticks, start: p.start });
    }
    prev = next;
    prevTime = now;

    const byMem = [...procs].sort((a, b) => b.rss - a.rss).slice(0, top);
    const byCpu = elapsed > 0 ? [...procs].sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0) || b.rss - a.rss).slice(0, top) : null;

    await users.refresh();
    const wanted = new Map([...byMem, ...(byCpu ?? [])].map((p) => [p.pid, p]));
    const detailed = new Map(await Promise.all([...wanted.values()].map(async (p) => [p.pid, await details(p)])));

    return {
      total: procs.length,
      threads: procs.reduce((sum, p) => sum + (p.threads || 0), 0),
      running: procs.filter((p) => p.state === 'R').length,
      zombie: procs.filter((p) => p.state === 'Z').length,
      byCpu: byCpu && byCpu.map((p) => detailed.get(p.pid)),
      byMem: byMem.map((p) => detailed.get(p.pid)),
    };
  }

  return { collect };
}
