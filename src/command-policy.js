// Yapay zekânın önerdiği bir komutun onaysız çalışıp çalışamayacağına karar verir.
// Yalnızca bilgi okuyan, bilinen komutlar otomatik çalışır; gerisi kullanıcı onayı bekler.
// Kural tutucudur: emin olunamayan her şey (yönlendirme, alt kabuk, değişken, bilinmeyen seçenek) onaya düşer.

const MAX_COMMAND = 2000;

// Kabuğun yorumladığı ve okuma dışı iş yapabilen karakterler: zincirleme, yönlendirme, alt kabuk, genişletme.
const UNSAFE_CHARS = /[;&><`$(){}\\\n\r!*?[\]~]/;

const any = () => true;
const noArgs = (args) => args.length === 0;
const deny = (...flags) => (args) => !args.some((a) => flags.some((f) => a === f || (f.endsWith('=') ? a.startsWith(f) : a.startsWith(`${f}=`))));
const firstIn = (...subs) => (args) => {
  const sub = args.find((a) => !a.startsWith('-'));
  return sub === undefined || subs.includes(sub);
};
const all = (...checks) => (args) => checks.every((c) => c(args));

// nvidia-smi: yalnızca sorgu seçenekleri; ayar değiştiren (-pl, -pm, -r, mig, ...) her şey onaya düşer.
const SMI_FLAGS = new Set(['-q', '--query', '-L', '--list-gpus', '-x', '--xml-format', '-u', '--unit', 'topo', '-m', '--matrix']);
const SMI_VALUE_FLAGS = new Set(['-i', '--id', '-d', '--display', '--format', '--query-gpu', '--query-compute-apps', '--query-accounted-apps']);
function nvidiaSmi(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (SMI_FLAGS.has(a)) continue;
    const eq = a.indexOf('=');
    if (eq > 0 && SMI_VALUE_FLAGS.has(a.slice(0, eq)) && /^[\w.,:-]+$/.test(a.slice(eq + 1))) continue;
    if (SMI_VALUE_FLAGS.has(a) && /^[\w.,:-]+$/.test(args[i + 1] ?? '')) {
      i++;
      continue;
    }
    return false;
  }
  return true;
}

// Komut adı → bağımsız değişkenleri onaysız çalıştırmaya uygun mu?
const READ_ONLY = {
  journalctl: deny('-f', '--follow', '--vacuum-size', '--vacuum-time', '--vacuum-files', '--rotate', '--flush', '--sync', '--relinquish-var', '--smart-relinquish-var', '--setup-keys', '--update-catalog', '-o', '--output-fields'),
  systemctl: all(firstIn('status', 'show', 'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'list-dependencies', 'is-active', 'is-enabled', 'is-failed', 'is-system-running', 'cat'), deny('-H', '--host', '-M', '--machine')),
  'systemd-analyze': firstIn('blame', 'critical-chain', 'time'),
  lsblk: any,
  df: any,
  du: deny('--files0-from'),
  free: any,
  uptime: any,
  uname: any,
  hostname: noArgs,
  hostnamectl: firstIn('status'),
  timedatectl: firstIn('status', 'show', 'timesync-status'),
  ip: all(firstIn('addr', 'a', 'address', 'link', 'l', 'route', 'r', 'neigh', 'n', '-s', '-br', '-c', '-4', '-6'), (args) => !args.some((a) => ['add', 'del', 'delete', 'set', 'flush', 'change', 'replace', 'append', 'save', 'restore'].includes(a))),
  ss: deny('-K', '--kill'),
  lspci: any,
  lsusb: any,
  lscpu: any,
  lsmod: any,
  lsof: any,
  dmesg: deny('-C', '--clear', '-c', '--read-clear', '-D', '--console-off', '-E', '--console-on', '-n', '--console-level'),
  'nvidia-smi': nvidiaSmi,
  sensors: noArgs,
  ps: any,
  pgrep: any,
  top: (args) => args.includes('-b') && args.some((a) => /^-n\d*$/.test(a) || a === '-n'),
  vmstat: any,
  iostat: any,
  who: any,
  w: any,
  last: any,
  lastlog: any,
  id: any,
  date: noArgs,
  cat: any,
  head: any,
  tail: deny('-f', '-F', '--follow'),
  wc: any,
  grep: any,
  egrep: any,
  zgrep: any,
  sort: deny('-o', '--output', '-T', '--temporary-directory', '--compress-program'),
  uniq: (args) => args.filter((a) => !a.startsWith('-')).length <= 1,
  cut: any,
  tr: any,
  column: any,
  ls: any,
  stat: any,
  file: any,
  find: deny('-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'),
  findmnt: any,
  mount: noArgs,
  echo: any,
  which: any,
  whereis: any,
  ping: (args) => args.some((a) => /^-c\d*$/.test(a) || a === '-c'),
  ollama: firstIn('list', 'ls', 'ps', 'show', '--version', '-v'),
  apt: firstIn('list', 'show', 'policy', 'search', 'depends', 'rdepends', 'changelog'),
  'apt-cache': firstIn('policy', 'show', 'search', 'depends', 'rdepends', 'showpkg'),
  dpkg: (args) => args.length > 0 && args.every((a) => /^(-l|--list|-L|--listfiles|-s|--status|-S|--search|--print-architecture|[\w.+:*-]+)$/.test(a)) && args.some((a) => /^(-l|--list|-L|--listfiles|-s|--status|-S|--search|--print-architecture)$/.test(a)),
  tailscale: firstIn('status', 'ip', 'netcheck', 'version'),
  resolvectl: firstIn('status', 'dns', 'domain', 'statistics'),
  smartctl: (args) => !args.some((a) => /^(-t|--test|-s|--smart|-o|--offlineauto|-S|--saveauto|-X|--abort|--set)/.test(a)),
  zpool: firstIn('status', 'list', 'iostat'),
  zfs: firstIn('list', 'get'),
  btrfs: (args) => ['filesystem', 'fi', 'device', 'dev', 'subvolume', 'sub'].includes(args[0]) && ['show', 'df', 'usage', 'stats', 'list'].includes(args[1]),
  docker: firstIn('ps', 'images', 'stats', 'logs', 'inspect', 'info', 'version'),
};

// Basit sözcüklere ayırma: tırnaklı parçalar desteklenir; tırnak içinde de güvensiz karakter olmamalıdır.
function words(segment) {
  const out = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Komutu doğrular; geçersizse null, değilse { command, readOnly } döner.
export function classifyCommand(input) {
  if (typeof input !== 'string') return null;
  const command = input.trim();
  if (!command || command.length > MAX_COMMAND || command.includes('\0')) return null;
  return { command, readOnly: isReadOnly(command) };
}

export function isReadOnly(command) {
  if (UNSAFE_CHARS.test(command)) return false;
  // Tekli boru (|) izinli: her parça ayrı ayrı denetlenir. "||" ve "|&" yukarıda ya da burada reddedilir.
  if (command.includes('||')) return false;
  const segments = command.split('|');
  return segments.every((segment) => {
    const parts = words(segment.trim());
    if (!parts.length) return false;
    let [name, ...args] = parts;
    // Ortam değişkeni atamaları (A=b komut) ve yol belirtilen komutlar onaya düşer.
    if (name.includes('=') || name.includes('/')) return false;
    if (name === 'sudo' || name === 'env' || name === 'nohup' || name === 'timeout' || name === 'xargs') return false;
    const check = READ_ONLY[name];
    return Boolean(check) && Object.hasOwn(READ_ONLY, name) && check(args);
  });
}
