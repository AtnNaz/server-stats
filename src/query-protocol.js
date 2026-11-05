import path from 'node:path';

// Panel ile root sorgu yardımcısı (bin/serverhealth-query.js) arasındaki istek biçimi.
// İki taraf da aynı doğrulamayı yapar: panel hatalı isteği hiç göndermez, yardımcı panele güvenmez.
// Yardımcı yalnızca okur; buradaki hiçbir değer kabuğa serbest metin olarak geçmez.

export const LOG_SINCE = {
  '15m': ['--since', '-15min'],
  '1h': ['--since', '-1h'],
  '6h': ['--since', '-6h'],
  '24h': ['--since', '-24h'],
  '7d': ['--since', '-7d'],
  boot: ['-b', '0'],
  prevboot: ['-b', '-1'],
};
// Saniye cinsinden (konteyner kayıtları için); açılış seçenekleri konteynerde "son 24 saat" sayılır.
export const SINCE_SECONDS = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, boot: null, prevboot: null };
export const LOG_KINDS = ['all', 'kernel', 'unit', 'container'];
export const MAX_LOG_LIMIT = 1000;
export const MAX_SEARCH = 200;

const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9@._:\\-]{0,199}$/;
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CURSOR_RE = /^[A-Za-z0-9=;_-]{1,600}$/;
const DIGITS_RE = /^\d{1,20}$/;
// Sanal dosya sistemleri taranmaz.
const NO_SCAN = ['/proc', '/sys', '/dev', '/run'];

export function validScanPath(p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0') || !p.startsWith('/')) return false;
  if (path.posix.normalize(p) !== p || (p.length > 1 && p.endsWith('/'))) return false;
  return !NO_SCAN.some((x) => p === x || p.startsWith(`${x}/`));
}

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function validLogs(q) {
  const src = q.source;
  if (!src || typeof src !== 'object' || !LOG_KINDS.includes(src.kind)) return null;
  const source = { kind: src.kind };
  if (src.kind === 'unit') {
    if (typeof src.name !== 'string' || !UNIT_RE.test(src.name)) return null;
    source.name = src.name;
  }
  if (src.kind === 'container') {
    if (typeof src.name !== 'string' || !CONTAINER_RE.test(src.name)) return null;
    source.name = src.name;
  }
  const priority = q.priority ?? 7;
  if (!isInt(priority, 0, 7)) return null;
  const since = q.since ?? '1h';
  if (!Object.hasOwn(LOG_SINCE, since)) return null;
  const search = q.search ?? '';
  if (typeof search !== 'string' || search.length > MAX_SEARCH || /[\0-\x1f\x7f]/.test(search)) return null;
  const limit = q.limit ?? 300;
  if (!isInt(limit, 1, MAX_LOG_LIMIT)) return null;
  // after: canlı izlemede son görülen kayıttan sonrası; before: "daha eski" için ilk kaydın öncesi.
  // Günlükte after bir imleç, before mikro saniyedir; konteynerde ikisi de dosyadaki bayt konumudur.
  const container = source.kind === 'container';
  const after = q.after ?? null;
  if (after !== null && (typeof after !== 'string' || !(container ? DIGITS_RE : CURSOR_RE).test(after))) return null;
  const before = q.before ?? null;
  if (before !== null && (typeof before !== 'string' || !DIGITS_RE.test(before))) return null;
  if (after !== null && before !== null) return null;
  return { op: 'logs', source, priority, since, search: search.trim(), limit, after, before };
}

export function validateQuery(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return null;
  switch (q.op) {
    case 'du':
      return validScanPath(q.path) ? { op: 'du', path: q.path } : null;
    case 'logs':
      return validLogs(q);
    case 'log-sources':
      return { op: 'log-sources' };
    case 'security':
      return { op: 'security' };
    default:
      return null;
  }
}

// Arama metni journalctl'e düz metin olarak gider: düzenli ifade karakterleri kaçırılır.
export const escapeRegex = (s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

const OUTPUT_FIELDS = 'MESSAGE,PRIORITY,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_COMM,_PID,_TRANSPORT';

export function journalArgs(q, { grep = true } = {}) {
  const args = ['--no-pager', '-q', '-o', 'json', `--output-fields=${OUTPUT_FIELDS}`];
  if (q.source.kind === 'unit') args.push('-u', q.source.name);
  if (q.source.kind === 'kernel') args.push('_TRANSPORT=kernel');
  if (q.priority < 7) args.push('-p', `0..${q.priority}`);
  if (q.after) args.push('--after-cursor', q.after);
  else args.push(...LOG_SINCE[q.since]);
  if (q.before) args.push('--until', `@${Math.floor(Number(q.before) / 1e6)}`);
  if (q.search && grep) args.push('-g', escapeRegex(q.search), '--case-sensitive=false');
  // Arama düzenli ifade desteği olmadan yapılırsa daha çok satır okunup burada süzülür.
  args.push('-n', String(q.search && !grep ? Math.min(20_000, q.limit * 20) : q.limit));
  return args;
}

// Renk kodları ve kontrol karakterleri temizlenir; çok uzun satırlar kısaltılır.
export function cleanMessage(text, max = 2000) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\0-\x08\x0b-\x1f\x7f]/g, '')
    .trimEnd()
    .slice(0, max);
}

function messageText(m) {
  if (Array.isArray(m)) return Buffer.from(m.filter((b) => Number.isInteger(b) && b >= 0 && b < 256)).toString('utf8');
  return typeof m === 'string' ? m : '';
}

// journalctl -o json çıktısı → panelin gösterdiği kayıtlar (eskiden yeniye).
export function parseJournal(text, search = '') {
  const needle = search.toLowerCase();
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = cleanMessage(messageText(e.MESSAGE));
    if (needle && !msg.toLowerCase().includes(needle)) continue;
    const us = String(e.__REALTIME_TIMESTAMP ?? '');
    out.push({
      t: Math.floor(Number(us) / 1000),
      p: e.PRIORITY == null ? 6 : Number(e.PRIORITY),
      src: e._TRANSPORT === 'kernel' ? 'kernel' : e._SYSTEMD_UNIT || e.SYSLOG_IDENTIFIER || e._COMM || '?',
      id: typeof e.SYSLOG_IDENTIFIER === 'string' ? e.SYSLOG_IDENTIFIER : null,
      pid: e._PID ? Number(e._PID) : null,
      msg,
      c: e.__CURSOR,
      b: DIGITS_RE.test(us) ? us : null,
    });
  }
  return out;
}

// Konteyner kayıtlarında önem derecesi yoktur; satırdaki sözcüklerden tahmin edilir.
export function guessPriority(text, stream) {
  if (/\b(FATAL|PANIC|CRIT(?:ICAL)?|EMERG)\b/i.test(text)) return 2;
  if (/\b(ERROR|ERR|Exception|Traceback)\b/.test(text) || /\berror\b/i.test(text.slice(0, 120))) return 3;
  if (/\bWARN(?:ING)?\b/i.test(text)) return 4;
  if (/\bDEBUG|VERBOSE|TRACE\b/.test(text)) return 7;
  return stream === 'stderr' ? 5 : 6;
}

// Docker json-file satırı: {"log":"...\n","stream":"stdout","time":"2026-...Z"}
export function parseDockerLine(line) {
  try {
    const e = JSON.parse(line);
    if (typeof e.log !== 'string') return null;
    const msg = cleanMessage(e.log);
    return { t: Date.parse(e.time) || 0, stream: e.stream === 'stderr' ? 'stderr' : 'stdout', msg };
  } catch {
    return null;
  }
}

// --- Güvenlik ---

// sshd_config: ilk geçen değer geçerlidir; Match bloğundan sonrası genel ayar değildir.
export const SSH_DEFAULTS = {
  port: '22',
  permitrootlogin: 'prohibit-password',
  passwordauthentication: 'yes',
  pubkeyauthentication: 'yes',
  kbdinteractiveauthentication: 'yes',
  permitemptypasswords: 'no',
  x11forwarding: 'no',
  maxauthtries: '6',
};

export function parseSshdConfig(readFn, file = '/etc/ssh/sshd_config', globFn = () => [], seen = new Set()) {
  const values = {};
  const ports = [];
  let stop = false;
  function visit(f) {
    if (stop || seen.has(f) || seen.size > 50) return;
    seen.add(f);
    let text;
    try {
      text = readFn(f);
    } catch {
      return;
    }
    for (const raw of text.split('\n')) {
      if (stop) return;
      const line = raw.replace(/#.*/, '').trim();
      if (!line) continue;
      const m = /^(\S+)\s*(?:=\s*|\s+)(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim().replace(/^"(.*)"$/, '$1');
      if (key === 'match') {
        stop = true;
        return;
      }
      if (key === 'include') {
        for (const pattern of value.split(/\s+/)) {
          const abs = pattern.startsWith('/') ? pattern : `/etc/ssh/${pattern}`;
          for (const inc of globFn(abs)) visit(inc);
        }
        continue;
      }
      if (key === 'port') ports.push(value);
      else if (!(key in values)) values[key] = value.toLowerCase();
    }
  }
  visit(file);
  const get = (k) => values[k] ?? SSH_DEFAULTS[k];
  return {
    ports: ports.length ? [...new Set(ports)] : [SSH_DEFAULTS.port],
    permitRootLogin: get('permitrootlogin'),
    passwordAuthentication: get('passwordauthentication') === 'yes',
    pubkeyAuthentication: get('pubkeyauthentication') === 'yes',
    kbdInteractive: (values.kbdinteractiveauthentication ?? values.challengeresponseauthentication ?? SSH_DEFAULTS.kbdinteractiveauthentication) === 'yes',
    permitEmptyPasswords: get('permitemptypasswords') === 'yes',
    x11Forwarding: get('x11forwarding') === 'yes',
    maxAuthTries: Number(get('maxauthtries')) || null,
  };
}

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const topList = (map, n, field) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, n)
    .map(([key, count]) => ({ [field]: key, count }));

// sshd kayıtlarından başarısız ve başarılı girişler (son 7 gün).
export function analyzeSshLog(entries, now = Date.now()) {
  const failIps = new Map();
  const failUsers = new Map();
  const days = new Map();
  const accepted = new Map();
  let failures = 0;
  let last24h = 0;
  let lastFailure = null;
  for (const e of entries) {
    // Olmayan kullanıcıyla deneme önce "Invalid user" satırı yazar; şifre sorulursa ardından
    // "Failed password for invalid user" gelir. Aynı deneme iki kez sayılmasın diye ikincisi atlanır.
    if (/Failed \S+ for invalid user /.test(e.msg)) continue;
    let m = /Failed \S+ for (\S+) from (\S+)/.exec(e.msg) ?? /Invalid user (\S*) from (\S+)/.exec(e.msg);
    if (m) {
      const user = m[1] || '?';
      const ip = m[2];
      failures++;
      bump(failUsers, user);
      bump(failIps, ip);
      bump(days, new Date(e.t).toISOString().slice(0, 10));
      if (now - e.t < 86_400_000) last24h++;
      if (!lastFailure || e.t > lastFailure.t) lastFailure = { t: e.t, user, ip };
      continue;
    }
    if ((m = /Accepted (\S+) for (\S+) from (\S+)/.exec(e.msg))) {
      // Aynı kullanıcı aynı adresten tekrar tekrar girince tek satırda toplanır.
      const key = `${m[2]} ${m[3]} ${m[1]}`;
      const a = accepted.get(key);
      if (a) {
        a.count++;
        a.t = Math.max(a.t, e.t);
      } else accepted.set(key, { t: e.t, method: m[1], user: m[2], ip: m[3], count: 1 });
    }
  }
  return {
    failures,
    last24h,
    lastFailure,
    topIps: topList(failIps, 10, 'ip'),
    topUsers: topList(failUsers, 10, 'user'),
    perDay: [...days.entries()].sort().map(([day, count]) => ({ day, count })),
    accepted: [...accepted.values()].sort((a, b) => b.t - a.t).slice(0, 15),
  };
}

// /proc/net/{tcp,udp}[6]: dinlenen soketler ve soket numaraları (sürece eşlemek için).
export function parseListening(text, file, { hexToIPv4, hexToIPv6 }) {
  const tcp = file.startsWith('tcp');
  const v6 = file.endsWith('6');
  const out = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    if (f[3] !== (tcp ? '0A' : '07')) continue;
    if (!tcp && !/^0+:0000$/.test(f[2])) continue;
    const [addrHex, portHex] = f[1].split(':');
    const port = parseInt(portHex, 16);
    if (!port) continue;
    out.push({ proto: tcp ? 'tcp' : 'udp', address: v6 ? hexToIPv6(addrHex) : hexToIPv4(addrHex), port, uid: Number(f[7]), inode: f[9] });
  }
  return out;
}

// Tailscale adresleri (100.64.0.0/10 ve fd7a:115c:a1e0::/48) ayrı gösterilir.
export function addressScope(address) {
  if (address === '0.0.0.0' || address === '::') return 'all';
  if (address.startsWith('127.') || address === '::1' || address.startsWith('::ffff:127.')) return 'local';
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\./.exec(address);
  if (v4 && Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127) return 'tailscale';
  if (/^fd7a:115c:a1e0:/i.test(address)) return 'tailscale';
  return 'specific';
}
