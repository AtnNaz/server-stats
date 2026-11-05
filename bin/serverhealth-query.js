#!/usr/bin/env node
// Node Stats sorgu yardımcısı (root, yalnızca okur).
// systemd soketi (serverhealth-query.socket) her bağlantı için bunu başlatır: girişten tek satır JSON
// istek okur, isteği yeniden doğrular, sonucu tek satır JSON olarak yazar ve çıkar.
// Yapabildikleri: bir klasör ağacının disk kullanımını ölçmek (dosya içeriği okunmaz, yalnızca ad ve
// boyut), sistem günlüklerini ve Docker konteyner kayıtlarını okumak, dinlenen portları, SSH ayarlarını
// ve giriş denemelerini çıkarmak. Hiçbir şeye yazmaz; birim dosyası da dosya sistemini salt okunur açar.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateQuery,
  journalArgs,
  parseJournal,
  parseDockerLine,
  guessPriority,
  parseSshdConfig,
  analyzeSshLog,
  parseListening,
  addressScope,
  SINCE_SECONDS,
} from '../src/query-protocol.js';
import { hexToIPv4, hexToIPv6 } from '../src/collectors/network.js';

const MAX_REQUEST = 16 * 1024;
const SCAN_SECONDS = 150;
const LARGEST = 25;
const MAX_TAIL_SCAN = 64 * 1024 * 1024;
const MAX_FORWARD = 8 * 1024 * 1024;
const SOCKET_FILES = ['tcp', 'tcp6', 'udp', 'udp6'];

const fail = (code) => Object.assign(new Error(code), { code });

export function runProcess(cmd, args, { timeout = 15_000, maxBytes = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let size = 0;
    let stderr = '';
    let truncated = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => {
      if (truncated) return;
      size += d.length;
      if (size > maxBytes) {
        truncated = true;
        child.kill('SIGKILL');
      } else out.push(d);
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 4096) stderr += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: err.message, truncated });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr, truncated });
    });
  });
}

// --- Disk kullanımı ---

// Aynı dosya sisteminde kalır (du -x gibi); başka bir diske bağlanan klasörler ayrıca listelenir.
// Boyut, dosyanın diskte kapladığı yerdir (blok sayısı); sabit bağlantılar bir kez sayılır.
export function scanUsage(root, { deadline = Infinity, rootPrefix = '' } = {}) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(rootPrefix + root);
  } catch (err) {
    throw fail(err.code === 'ENOENT' ? 'not_found' : 'unreadable');
  }
  if (!rootStat.isDirectory()) throw fail('not_dir');
  const dev = rootStat.dev;
  const seen = new Set();
  const largest = [];
  const mounts = [];
  const stats = { files: 0, dirs: 0, errors: 0, partial: false };

  function noteLargest(p, size) {
    if (largest.length >= LARGEST && size <= largest[largest.length - 1].size) return;
    let i = largest.length;
    while (i > 0 && largest[i - 1].size < size) i--;
    largest.splice(i, 0, { path: p, size });
    if (largest.length > LARGEST) largest.pop();
  }

  function walk(dir, name, ownSize, depth) {
    const node = { n: name, s: ownSize, f: 0, d: [] };
    stats.dirs++;
    let entries;
    try {
      entries = fs.readdirSync(rootPrefix + dir, { withFileTypes: true });
    } catch {
      stats.errors++;
      return node;
    }
    for (const e of entries) {
      if (stats.partial) break;
      if ((stats.files & 1023) === 0 && Date.now() > deadline) {
        stats.partial = true;
        break;
      }
      const p = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`;
      let st;
      try {
        st = fs.lstatSync(rootPrefix + p);
      } catch {
        stats.errors++;
        continue;
      }
      if (st.isDirectory()) {
        if (st.dev !== dev) {
          mounts.push(p);
          continue;
        }
        if (depth > 500) {
          stats.errors++;
          continue;
        }
        const child = walk(p, e.name, st.blocks * 512, depth + 1);
        node.d.push(child);
        node.s += child.s;
        node.f += child.f;
        continue;
      }
      if (st.nlink > 1) {
        if (seen.has(st.ino)) continue;
        seen.add(st.ino);
      }
      const size = st.blocks * 512;
      node.s += size;
      node.f++;
      stats.files++;
      if (st.isFile()) noteLargest(p, size);
    }
    return node;
  }

  const tree = walk(root, root, rootStat.blocks * 512, 0);
  return { tree, stats, largest, mounts };
}

// Tarayıcıya gidecek ağaç: küçük klasörler ayrıca gösterilmez (üst klasörün "diğer" payına kalır),
// derinlik sınırında kesilen klasörler "x" ile işaretlenir; tıklanınca o klasör yeniden taranır.
export function pruneTree(tree, { maxDepth = 5, maxChildren = 60, maxNodes = 3000 } = {}) {
  const minSize = Math.max(tree.s * 0.002, 64 * 1024);
  let count = 0;
  function prune(src, depth) {
    const out = { n: src.n, s: src.s, f: src.f };
    const kids = (src.d ?? []).filter((c) => c.s >= minSize).sort((a, b) => b.s - a.s);
    if (!kids.length) return out;
    if (depth >= maxDepth || count >= maxNodes) {
      out.x = true;
      return out;
    }
    out.d = [];
    for (const k of kids.slice(0, maxChildren)) {
      if (count >= maxNodes) {
        out.x = true;
        break;
      }
      count++;
      out.d.push(prune(k, depth + 1));
    }
    return out;
  }
  return prune(tree, 0);
}

// --- Yardımcı okuyucular ---

function globFiles(pattern, P) {
  if (!pattern.includes('*') && !pattern.includes('?')) return [pattern];
  const dir = path.posix.dirname(pattern);
  const re = new RegExp(`^${path.posix.basename(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  try {
    return fs
      .readdirSync(P(dir))
      .filter((n) => re.test(n))
      .sort()
      .map((n) => `${dir}/${n}`);
  } catch {
    return [];
  }
}

function parsePasswd(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(':'))
    .filter((f) => f.length >= 7)
    .map((f) => ({ name: f[0], uid: Number(f[2]), gid: Number(f[3]), home: f[5], shell: f[6] }));
}

export function createQuery({ root = '', run = runProcess, now = Date.now } = {}) {
  const P = (p) => (root ? path.join(root, p) : p);
  const read = (p) => fs.readFileSync(P(p), 'utf8');
  const readOr = (p, fallback = '') => {
    try {
      return read(p);
    } catch {
      return fallback;
    }
  };
  const DOCKER = '/var/lib/docker/containers';

  function containers() {
    let ids;
    try {
      ids = fs.readdirSync(P(DOCKER));
    } catch {
      return [];
    }
    return ids
      .filter((id) => /^[0-9a-f]{64}$/.test(id))
      .map((id) => {
        try {
          const cfg = JSON.parse(read(`${DOCKER}/${id}/config.v2.json`));
          let host = {};
          try {
            host = JSON.parse(read(`${DOCKER}/${id}/hostconfig.json`));
          } catch {
            /* eski kurulumlarda bulunmayabilir */
          }
          return {
            id,
            name: String(cfg.Name ?? '').replace(/^\//, '') || id.slice(0, 12),
            running: Boolean(cfg.State?.Running),
            image: String(cfg.Config?.Image ?? ''),
            driver: host.LogConfig?.Type || 'json-file',
            bindings: host.PortBindings ?? {},
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // --- Disk kullanımı ---
  function du(q) {
    const started = now();
    const { tree, stats, largest, mounts } = scanUsage(q.path, { deadline: started + SCAN_SECONDS * 1000, rootPrefix: root });
    let capacity = null;
    try {
      const s = fs.statfsSync(P(q.path));
      capacity = { size: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      /* statfs yoksa kapasite gösterilmez */
    }
    return {
      path: q.path,
      tree: pruneTree(tree),
      total: tree.s,
      files: stats.files,
      dirs: stats.dirs,
      errors: stats.errors,
      partial: stats.partial,
      mounts: mounts.slice(0, 50),
      largest,
      capacity,
      seconds: Math.round((now() - started) / 100) / 10,
    };
  }

  // --- Günlükler ---
  async function journalLogs(q) {
    let filtered = false;
    let r = await run('journalctl', journalArgs(q), { timeout: 12_000 });
    if (r.code !== 0 && q.search && /pattern|pcre|regex/i.test(r.stderr)) {
      filtered = true;
      r = await run('journalctl', journalArgs(q, { grep: false }), { timeout: 12_000 });
    }
    if (r.code !== 0 && !r.stdout.trim()) {
      if (/specified boot|boot ID|No such boot/i.test(r.stderr)) return { entries: [], cursor: null, note: 'no_boot' };
      if (/cursor/i.test(r.stderr)) throw fail('bad_cursor');
      // Arama eşleşmeyince journalctl 1 ile çıkar.
      if (q.search && r.code === 1) return { entries: [], cursor: q.after };
      throw fail('journal');
    }
    let entries = parseJournal(r.stdout, filtered ? q.search : '');
    if (filtered) entries = entries.slice(-q.limit);
    if (q.before) entries = entries.filter((e) => e.b && BigInt(e.b) < BigInt(q.before));
    // İmleç günlükteki sıraya göredir; gösterim için kayıtlar zamana göre sıralanır.
    let cursor = entries.at(-1)?.c ?? q.after;
    entries.sort((a, b) => a.t - b.t);
    if (!cursor) {
      // Hiç kayıt yoksa canlı izleme için günlüğün sonundaki imleç alınır.
      const tail = await run('journalctl', ['--no-pager', '-q', '-o', 'json', '--output-fields=MESSAGE', '-n', '1'], { timeout: 5000 });
      cursor = parseJournal(tail.stdout).at(-1)?.c ?? null;
    }
    return { entries, cursor, more: entries.length >= q.limit };
  }

  function containerLogs(q) {
    const c = containers().find((x) => x.name === q.source.name);
    if (!c) throw fail('not_found');
    if (c.driver !== 'json-file') throw fail('log_driver');
    let fd;
    try {
      fd = fs.openSync(P(`${DOCKER}/${c.id}/${c.id}-json.log`), 'r');
    } catch {
      return { entries: [], cursor: '0' };
    }
    try {
      const size = fs.fstatSync(fd).size;
      const needle = q.search.toLowerCase();
      const entries = [];
      const accept = (line, offset) => {
        const e = parseDockerLine(line);
        if (!e || !e.msg) return null;
        const p = guessPriority(e.msg, e.stream);
        if (p > q.priority || (needle && !e.msg.toLowerCase().includes(needle))) return e;
        entries.push({ t: e.t, p, src: c.name, id: e.stream, pid: null, msg: e.msg, c: null, b: String(offset) });
        return e;
      };

      if (q.after !== null) {
        // Canlı izleme: son okunan konumdan dosya sonuna kadar. Dosya döndürüldüyse baştan okunur.
        let start = Number(q.after);
        if (start > size) start = 0;
        let skipFirst = false;
        if (size - start > MAX_FORWARD) {
          start = size - MAX_FORWARD;
          skipFirst = true;
        }
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        let lineStart = 0;
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] !== 10) continue;
          if (!skipFirst) accept(buf.subarray(lineStart, i).toString('utf8'), start + lineStart);
          skipFirst = false;
          lineStart = i + 1;
        }
        return { entries: entries.slice(-q.limit), cursor: String(start + lineStart) };
      }

      // Sondan geriye doğru okunur: istenen sayıya ya da süre sınırına ulaşınca durulur.
      const secs = SINCE_SECONDS[q.since] ?? 86_400;
      const minT = now() - secs * 1000;
      const end = q.before !== null ? Math.min(Number(q.before), size) : size;
      const CHUNK = 512 * 1024;
      let pos = end;
      let carry = Buffer.alloc(0);
      let scanned = 0;
      let done = false;
      const handle = (lineBuf, offset) => {
        const e = accept(lineBuf.toString('utf8'), offset);
        if (e && e.t && e.t < minT) {
          if (entries.at(-1)?.b === String(offset)) entries.pop();
          done = true;
        } else if (entries.length >= q.limit) done = true;
      };
      while (pos > 0 && !done && scanned < MAX_TAIL_SCAN) {
        const len = Math.min(CHUNK, pos);
        pos -= len;
        scanned += len;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        const data = Buffer.concat([buf, carry]);
        let lineEnd = data.length;
        for (let i = data.length - 1; i >= 0 && !done; i--) {
          if (data[i] !== 10) continue;
          if (i + 1 < lineEnd) handle(data.subarray(i + 1, lineEnd), pos + i + 1);
          lineEnd = i;
        }
        carry = data.subarray(0, lineEnd);
      }
      if (!done && pos === 0 && carry.length) handle(carry, 0);
      entries.reverse();
      return { entries, cursor: String(size), more: done && entries.length >= q.limit };
    } finally {
      fs.closeSync(fd);
    }
  }

  async function logSources() {
    const r = await run('journalctl', ['--no-pager', '-F', '_SYSTEMD_UNIT'], { timeout: 10_000 });
    const units = [
      ...new Set(
        r.stdout
          .split('\n')
          .map((s) => s.trim())
          // Soketle açılan tek seferlik örnekler (ör. serverhealth-exec@3-…) listeyi kalabalıklaştırmasın.
          .filter((u) => /^[A-Za-z0-9][A-Za-z0-9@._:\\-]*\.service$/.test(u) && !/@\d+-/.test(u)),
      ),
    ]
      .sort()
      .slice(0, 800);
    return { units, containers: containers().map((c) => ({ name: c.name, running: c.running, image: c.image })) };
  }

  // --- Güvenlik ---
  function socketOwners(wanted) {
    const owners = new Map();
    let pids;
    try {
      pids = fs.readdirSync(P('/proc')).filter((n) => /^\d+$/.test(n));
    } catch {
      return owners;
    }
    for (const pid of pids) {
      let fds;
      try {
        fds = fs.readdirSync(P(`/proc/${pid}/fd`));
      } catch {
        continue;
      }
      for (const fd of fds) {
        let link;
        try {
          link = fs.readlinkSync(P(`/proc/${pid}/fd/${fd}`));
        } catch {
          continue;
        }
        const m = /^socket:\[(\d+)\]$/.exec(link);
        if (!m || !wanted.has(m[1])) continue;
        if (!owners.has(m[1])) owners.set(m[1], new Set());
        owners.get(m[1]).add(Number(pid));
      }
    }
    return owners;
  }

  async function security() {
    const passwd = parsePasswd(readOr('/etc/passwd'));
    const userName = (uid) => passwd.find((u) => u.uid === uid)?.name ?? String(uid);

    // Dinlenen portlar ve sahibi olan süreçler
    const sockets = SOCKET_FILES.flatMap((f) => parseListening(readOr(`/proc/net/${f}`), f, { hexToIPv4, hexToIPv6 }));
    const owners = socketOwners(new Set(sockets.map((s) => s.inode)));
    const procInfo = new Map();
    const proc = (pid) => {
      if (!procInfo.has(pid)) {
        const comm = readOr(`/proc/${pid}/comm`).trim();
        const uid = Number(/^Uid:\s+(\d+)/m.exec(readOr(`/proc/${pid}/status`))?.[1] ?? -1);
        procInfo.set(pid, { pid, name: comm || '?', user: uid >= 0 ? userName(uid) : '?' });
      }
      return procInfo.get(pid);
    };
    const docker = containers();
    const published = new Map();
    for (const c of docker) {
      if (!c.running) continue;
      for (const [key, binds] of Object.entries(c.bindings)) {
        const proto = key.split('/')[1] || 'tcp';
        for (const b of binds ?? []) {
          const k = `${proto}/${Number(b.HostPort)}`;
          if (!published.has(k)) published.set(k, new Set());
          published.get(k).add(c.name);
        }
      }
    }
    const RANK = { local: 0, tailscale: 1, specific: 2, all: 3 };
    const groups = new Map();
    for (const s of sockets) {
      const key = `${s.proto}/${s.port}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { proto: s.proto, port: s.port, addresses: [], scope: 'local', processes: new Map(), containers: [...(published.get(key) ?? [])] }));
      if (!g.addresses.includes(s.address)) g.addresses.push(s.address);
      const scope = addressScope(s.address);
      if (RANK[scope] > RANK[g.scope]) g.scope = scope;
      for (const pid of owners.get(s.inode) ?? []) {
        const p = proc(pid);
        if (!g.processes.has(p.name)) g.processes.set(p.name, p);
      }
    }
    // Geçici UDP istemci portları (DNS sorguları vb.) dinleyen servis değildir.
    const range = readOr('/proc/sys/net/ipv4/ip_local_port_range').trim().split(/\s+/).map(Number);
    const ports = [...groups.values()]
      .filter((g) => !(g.proto === 'udp' && range.length === 2 && g.port >= range[0] && g.port <= range[1] && !g.containers.length))
      .map((g) => ({ ...g, processes: [...g.processes.values()].slice(0, 5) }))
      .sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));

    // SSH
    const sshInstalled = fs.existsSync(P('/etc/ssh/sshd_config'));
    const ssh = sshInstalled ? parseSshdConfig(read, '/etc/ssh/sshd_config', (p) => globFiles(p, P)) : null;
    const sshRun = await run('journalctl', ['--no-pager', '-q', '-o', 'json', '--output-fields=MESSAGE', '--since', '-7d', '-t', 'sshd', '-t', 'sshd-session', '-t', 'sshd-auth'], { timeout: 12_000, maxBytes: 64 * 1024 * 1024 });
    const sshLog = analyzeSshLog(parseJournal(sshRun.stdout), now());
    const sudoRun = await run('journalctl', ['--no-pager', '-q', '-o', 'json', '--output-fields=MESSAGE', '--since', '-7d', '-t', 'sudo'], { timeout: 8000 });
    const sudoFailures = parseJournal(sudoRun.stdout).filter((e) => /incorrect password attempt|authentication failure/i.test(e.msg)).length;

    // Güvenlik duvarı
    const ufwConf = readOr('/etc/ufw/ufw.conf', null);
    const ufw = ufwConf === null ? 'missing' : /^\s*ENABLED\s*=\s*yes/im.test(ufwConf) ? 'enabled' : 'disabled';
    const active = async (unit) => (await run('systemctl', ['is-active', unit], { timeout: 5000 })).stdout.trim() === 'active';
    const firewalld = await active('firewalld');
    const fail2ban = fs.existsSync(P('/usr/bin/fail2ban-client')) ? ((await active('fail2ban')) ? 'active' : 'inactive') : 'missing';

    // Oturum açabilen kullanıcılar
    const shadow = new Map(
      readOr('/etc/shadow')
        .split('\n')
        .map((l) => l.split(':'))
        .filter((f) => f.length > 1)
        .map((f) => [f[0], f[1]]),
    );
    const admins = new Set();
    for (const line of readOr('/etc/group').split('\n')) {
      const f = line.split(':');
      if (['sudo', 'wheel', 'admin'].includes(f[0]) && f[3]) f[3].split(',').forEach((u) => admins.add(u));
    }
    const users = passwd
      .filter((u) => (u.uid === 0 || (u.uid >= 1000 && u.uid < 65534)) && !/(nologin|false|sync)$/.test(u.shell))
      .map((u) => {
        const hash = shadow.get(u.name);
        const keys = readOr(`${u.home}/.ssh/authorized_keys`)
          .split('\n')
          .filter((l) => l.trim() && !l.trim().startsWith('#')).length;
        return {
          name: u.name,
          uid: u.uid,
          admin: u.uid === 0 || admins.has(u.name),
          password: hash === undefined ? 'unknown' : hash === '' ? 'empty' : /^[!*]/.test(hash) ? 'locked' : 'set',
          keys,
        };
      });

    return { ports, ssh, sshLog, sudoFailures, firewall: { ufw, firewalld }, fail2ban, users };
  }

  return {
    containers,
    async handle(q) {
      if (q.op === 'du') return du(q);
      if (q.op === 'logs') return q.source.kind === 'container' ? containerLogs(q) : journalLogs(q);
      if (q.op === 'log-sources') return logSources();
      if (q.op === 'security') return security();
      throw fail('invalid');
    },
  };
}

function readRequest(stream) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      data += chunk;
      const nl = data.indexOf('\n');
      if (nl !== -1) {
        stream.pause();
        resolve(data.slice(0, nl));
      } else if (data.length > MAX_REQUEST) reject(fail('too_large'));
    });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

async function main() {
  const reply = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`, () => process.exit(0));
  let request;
  try {
    request = JSON.parse(await readRequest(process.stdin));
  } catch {
    return reply({ error: 'invalid' });
  }
  const q = validateQuery(request);
  if (!q) return reply({ error: 'invalid' });
  try {
    reply(await createQuery().handle(q));
  } catch (err) {
    if (!err.code || !/^[a-z_]+$/.test(err.code)) console.error(`serverhealth-query: ${err.message}`);
    reply({ error: err.code && /^[a-z_]+$/.test(err.code) ? err.code.toLowerCase() : 'failed' });
  }
}

// Test dosyaları içe aktarınca main çalışmasın.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
