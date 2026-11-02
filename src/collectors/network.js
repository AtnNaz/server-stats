import os from 'node:os';
import { readText } from '../util.js';

const LITTLE_ENDIAN = os.endianness() === 'LE';
const SOCKET_FILES = ['tcp', 'tcp6', 'udp', 'udp6'];
const TCP_LISTEN = '0A';
const UDP_UNCONNECTED = '07';
const EXPOSURE_RANK = { local: 0, specific: 1, all: 2 };

// '*' içeren basit kalıp eşleme. Düzenli ifade yerine geri izlemesiz döngü kullanılır;
// çok yıldızlı bir kalıp uzun bir bağlama yolunda olay döngüsünü kilitleyemez.
export function globMatch(pattern, text) {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = s;
    } else if (p < pattern.length && pattern[p] === text[s]) {
      p++;
      s++;
    } else if (star !== -1) {
      p = star + 1;
      s = ++mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

export function globMatcher(patterns) {
  return { test: (text) => patterns.some((p) => globMatch(p, text)) };
}

export function parseNetDev(text) {
  const out = {};
  for (const line of text.split('\n').slice(2)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const f = line.slice(idx + 1).trim().split(/\s+/).map(Number);
    out[line.slice(0, idx).trim()] = { rxBytes: f[0], rxErrors: f[2], rxDrop: f[3], txBytes: f[8], txErrors: f[10], txDrop: f[11] };
  }
  return out;
}

// /proc/net/* adresleri 32 bitlik sözcükler halinde, makinenin bayt sırasıyla yazılır.
function wordBytes(hex) {
  const bytes = hex.match(/../g).map((b) => parseInt(b, 16));
  return LITTLE_ENDIAN ? bytes.reverse() : bytes;
}

export function hexToIPv4(hex) {
  return wordBytes(hex).join('.');
}

export function formatIPv6(groups) {
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) [bestStart, bestLen] = [i, j - i];
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

export function hexToIPv6(hex) {
  const bytes = [0, 8, 16, 24].flatMap((i) => wordBytes(hex.slice(i, i + 8)));
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `::ffff:${bytes.slice(12).join('.')}`;
  }
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
  return formatIPv6(groups);
}

export function parseSockets(text, file) {
  const tcp = file.startsWith('tcp');
  const v6 = file.endsWith('6');
  const out = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    if (f[3] !== (tcp ? TCP_LISTEN : UDP_UNCONNECTED)) continue;
    if (!tcp && !/^0+:0000$/.test(f[2])) continue; // bağlı (istemci) UDP soketi
    const [addrHex, portHex] = f[1].split(':');
    const port = parseInt(portHex, 16);
    if (!port) continue;
    out.push({ proto: tcp ? 'tcp' : 'udp', address: v6 ? hexToIPv6(addrHex) : hexToIPv4(addrHex), port });
  }
  return out;
}

export function exposure(address) {
  if (address === '0.0.0.0' || address === '::') return 'all';
  if (address.startsWith('127.') || address === '::1' || address.startsWith('::ffff:127.')) return 'local';
  return 'specific';
}

// Aynı port birden çok adreste dinleniyorsa (0.0.0.0 ve ::) tek satırda birleştirilir.
export function groupPorts(sockets, ephemeral = null) {
  const groups = new Map();
  const seen = new Set(); // aynı adres tekrar eklenmez; dizi taraması binlerce sokette yavaşlardı
  for (const s of sockets) {
    // Geçici port aralığındaki UDP soketleri genelde istemcidir (DNS sorguları vb.)
    if (s.proto === 'udp' && ephemeral && s.port >= ephemeral[0] && s.port <= ephemeral[1]) continue;
    const key = `${s.proto}/${s.port}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { proto: s.proto, port: s.port, addresses: [], exposure: 'local' }));
    if (!seen.has(`${key} ${s.address}`)) {
      seen.add(`${key} ${s.address}`);
      g.addresses.push(s.address);
    }
    const e = exposure(s.address);
    if (EXPOSURE_RANK[e] > EXPOSURE_RANK[g.exposure]) g.exposure = e;
  }
  return [...groups.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}

const readOr = (file, fallback) => readText(file).then((t) => t.trim(), () => fallback);

export function createNetworkCollector({ hideInterfaces }) {
  const hidden = globMatcher(hideInterfaces);
  let prev = null;
  let prevTime = 0;
  let ephemeral;

  async function collect() {
    const now = Date.now();
    if (ephemeral === undefined) {
      const range = (await readOr('/proc/sys/net/ipv4/ip_local_port_range', '')).split(/\s+/).map(Number);
      ephemeral = range.length === 2 && range.every(Number.isFinite) ? range : null;
    }
    const [devText, ...socketTexts] = await Promise.all([
      readText('/proc/net/dev'),
      ...SOCKET_FILES.map((f) => readOr(`/proc/net/${f}`, '')),
    ]);

    const counters = parseNetDev(devText);
    const elapsed = prevTime ? (now - prevTime) / 1000 : 0;
    const ifaddrs = os.networkInterfaces();
    const rate = (cur, old) => (elapsed > 0 && old != null && cur >= old ? Math.round((cur - old) / elapsed) : null);

    // Adresi olmayan ve hiç trafik görmemiş arayüzler (gre0, sit0, tunl0 gibi çekirdeğin
    // yedek tünel aygıtları) listeyi kalabalıklaştırmasın.
    const unused = (n) => !ifaddrs[n]?.length && counters[n].rxBytes === 0 && counters[n].txBytes === 0;
    const names = Object.keys(counters).filter((n) => !hidden.test(n) && !unused(n));
    const states = await Promise.all(names.map((n) => readOr(`/sys/class/net/${n}/operstate`, 'unknown')));
    const interfaces = names.map((name, i) => {
      const c = counters[name];
      const old = prev?.[name];
      const addrs = ifaddrs[name] ?? [];
      return {
        name,
        state: states[i],
        mac: addrs[0]?.mac && addrs[0].mac !== '00:00:00:00:00:00' ? addrs[0].mac : null,
        addresses: addrs.filter((a) => !a.address.startsWith('fe80:')).map((a) => a.cidr ?? a.address),
        rxRate: rate(c.rxBytes, old?.rxBytes),
        txRate: rate(c.txBytes, old?.txBytes),
        rxTotal: c.rxBytes,
        txTotal: c.txBytes,
        errors: c.rxErrors + c.txErrors,
        drops: c.rxDrop + c.txDrop,
      };
    });
    prev = counters;
    prevTime = now;

    const sockets = socketTexts.flatMap((text, i) => parseSockets(text, SOCKET_FILES[i]));
    return { interfaces, ports: groupPorts(sockets, ephemeral) };
  }

  return { collect };
}
