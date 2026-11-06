// Panelin root yardımcısından isteyebileceği sistem ayarları ve işlemleri.
// Hem panel (kuyruğa koymadan önce) hem yardımcı (uygulamadan önce) aynı kurallarla doğrular;
// yardımcı panelin yazdığı dosyaya asla güvenmez.

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const UPDATE_MODES = ['off', 'security', 'all'];
export const ACTIONS = ['update', 'reboot', 'refresh', 'report', 'self-update', 'github-backup'];
// Panel terminalinin açılacağı Linux kullanıcı adı
export const TERM_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
// Ollama model adı, ör. "qwen3.5:4b" ya da "hf.co/kullanici/model:Q4_0"
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// GitHub kullanıcı adı ve token biçimleri (klasik ghp_, ince ayarlı github_pat_ ve diğer gh*_ türleri)
export const GITHUB_USER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
export const GITHUB_TOKEN = /^(?:gh[pousr]_[A-Za-z0-9_]{20,251}|github_pat_[A-Za-z0-9_]{20,251})$/;
// Yedek klasörü sistem klasörlerinden birinde olamaz; boşluk ve özel karakter içermez (systemd ayarına yazılır).
const SYSTEM_DIRS = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/boot', '/proc', '/sys', '/dev', '/run', '/root', '/tmp', '/var/tmp', '/var/log', '/var/cache', '/var/lib/docker', '/snap', '/opt/serverhealth', '/var/lib/serverhealth', '/var/lib/serverhealth-panel', '/var/lib/serverhealth-queue', '/var/lib/serverhealth-backup'];
export function validBackupDir(p) {
  if (typeof p !== 'string' || p.length > 200 || !/^(\/[A-Za-z0-9._-]+){2,}$/.test(p)) return false;
  if (p.split('/').some((part) => part === '.' || part === '..')) return false;
  return !SYSTEM_DIRS.some((d) => p === d || p.startsWith(`${d}/`));
}

const isBool = (v) => typeof v === 'boolean';
const isTime = (v) => typeof v === 'string' && TIME.test(v);

function validateObject(input, fields) {
  const errors = [];
  const value = {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { errors: ['invalid'], value };
  for (const [key, v] of Object.entries(input)) {
    // Object.prototype'tan gelen adlar (constructor, toString…) denetçi sayılmaz.
    const check = Object.hasOwn(fields, key) ? fields[key] : null;
    if (check && check(v)) value[key] = v;
    else errors.push(key);
  }
  return { errors, value };
}

export function validateSystemSettings(input) {
  const errors = [];
  const top = validateObject(input, {
    updates: (v) => UPDATE_MODES.includes(v),
    rebootAfterUpdate: isBool,
    rebootTime: isTime,
    scheduledReboot: (v) => typeof v === 'object' && v !== null,
    smartTests: (v) => typeof v === 'object' && v !== null,
    report: (v) => typeof v === 'object' && v !== null,
    terminal: (v) => typeof v === 'object' && v !== null,
    githubBackup: (v) => typeof v === 'object' && v !== null,
  });
  errors.push(...top.errors);
  const value = top.value;
  if (value.scheduledReboot) {
    const r = validateObject(value.scheduledReboot, { enabled: isBool, day: (v) => v === 'daily' || WEEKDAYS.includes(v), time: isTime });
    errors.push(...r.errors.map((e) => `scheduledReboot.${e}`));
    value.scheduledReboot = r.value;
  }
  if (value.smartTests) {
    const r = validateObject(value.smartTests, {
      enabled: isBool,
      shortDay: (v) => WEEKDAYS.includes(v),
      longDay: (v) => Number.isInteger(v) && v >= 1 && v <= 28,
      time: isTime,
    });
    errors.push(...r.errors.map((e) => `smartTests.${e}`));
    value.smartTests = r.value;
  }
  if (value.report) {
    const r = validateObject(value.report, { enabled: isBool, time: isTime, model: (v) => v === '' || (typeof v === 'string' && MODEL_NAME.test(v)) });
    errors.push(...r.errors.map((e) => `report.${e}`));
    value.report = r.value;
  }
  if (value.terminal) {
    const r = validateObject(value.terminal, { enabled: isBool, user: (v) => v === '' || (typeof v === 'string' && TERM_USER.test(v)) });
    errors.push(...r.errors.map((e) => `terminal.${e}`));
    if (r.value.enabled && !r.value.user) errors.push('terminal.user');
    value.terminal = r.value;
  }
  if (value.githubBackup) {
    const r = validateGithubBackup(value.githubBackup);
    errors.push(...r.errors.map((e) => `githubBackup.${e}`));
    value.githubBackup = r.value;
  }
  return { errors, value };
}

// token: verilmezse kayıtlı token korunur, boş metin kayıtlı token'ı siler.
export function validateGithubBackup(input) {
  const r = validateObject(input, {
    enabled: isBool,
    username: (v) => v === '' || (typeof v === 'string' && GITHUB_USER.test(v)),
    time: isTime,
    dir: validBackupDir,
    forks: isBool,
    issues: isBool,
    wiki: isBool,
    token: (v) => v === '' || (typeof v === 'string' && GITHUB_TOKEN.test(v)),
  });
  if (r.value.enabled && (!r.value.username || !r.value.dir)) r.errors.push(r.value.username ? 'dir' : 'username');
  return r;
}

export function validateRequest(req) {
  if (req?.type === 'settings') {
    const { errors, value } = validateSystemSettings(req.settings);
    return errors.length ? { errors } : { request: { type: 'settings', settings: value } };
  }
  if (req?.type === 'action' && ACTIONS.includes(req.action)) return { request: { type: 'action', action: req.action } };
  return { errors: ['type'] };
}

// --- Yardımcının ürettiği yapılandırma metinleri (saf fonksiyonlar, test edilebilir) ---

const capitalize = (day) => day[0].toUpperCase() + day.slice(1);

export function onCalendarWeekly(day, time) {
  return day === 'daily' ? `*-*-* ${time}:00` : `${capitalize(day)} *-*-* ${time}:00`;
}

export function onCalendarMonthly(dayOfMonth, time) {
  return `*-*-${String(dayOfMonth).padStart(2, '0')} ${time}:00`;
}

// Debian/Ubuntu unattended-upgrades ayarı. Dosya 50unattended-upgrades'ten sonra okunur ve onu ezer.
export function aptConfig({ updates, rebootAfterUpdate, rebootTime }) {
  const lines = [
    '// Node Stats paneli tarafından yönetilir; elle değiştirmeyin, panelin Ayarlar bölümünü kullanın.',
    'APT::Periodic::Update-Package-Lists "1";',
    `APT::Periodic::Unattended-Upgrade "${updates === 'off' ? 0 : 1}";`,
    `Unattended-Upgrade::Automatic-Reboot "${rebootAfterUpdate ? 'true' : 'false'}";`,
    `Unattended-Upgrade::Automatic-Reboot-Time "${rebootTime}";`,
  ];
  // Varsayılan yalnızca güvenlik güncellemeleridir; "tümü" normal güncellemeleri de ekler.
  if (updates === 'all') lines.push('Unattended-Upgrade::Allowed-Origins { "${distro_id}:${distro_codename}-updates"; };');
  return `${lines.join('\n')}\n`;
}

// "apt-config dump" çıktısından etkin ayarları okur.
export function parseAptConfigDump(text) {
  const get = (key) => new RegExp(`^${key.replace(/[:]/g, '\\:')} "([^"]*)";`, 'm').exec(text)?.[1];
  const enabled = get('APT::Periodic::Unattended-Upgrade');
  const updatesOrigin = /^Unattended-Upgrade::(Allowed-Origins|Origins-Pattern):: ".*-updates.*";/m.test(text);
  return {
    updates: enabled && enabled !== '0' ? (updatesOrigin ? 'all' : 'security') : 'off',
    rebootAfterUpdate: get('Unattended-Upgrade::Automatic-Reboot') === 'true',
    rebootTime: get('Unattended-Upgrade::Automatic-Reboot-Time') || '02:00',
  };
}

// "apt-get -s upgrade" çıktısında kurulacak paketler "Inst" ile başlar.
// "apt-get -s upgrade" çıktısındaki her "Inst" satırı: paket, eski ve yeni sürüm, kaynak depo.
// Ör. "Inst libssl3 [3.0.2-0ubuntu1.1] (3.0.2-0ubuntu1.2 Ubuntu:22.04/jammy-security [amd64])"
const INST = /^Inst (\S+)(?: \[([^\]]*)\])? \((\S+) ([^[)]*?)\s*(?:\[[^\]]*\])?\)/;
export function parseAptUpgrades(text) {
  return text
    .split('\n')
    .map((l) => INST.exec(l))
    .filter(Boolean)
    .map(([, name, from, to, repo]) => ({ name, from: from || null, to, repo: repo.trim(), security: /securi/i.test(repo) }));
}

export function countAptUpgrades(text) {
  const lines = text.split('\n').filter((l) => l.startsWith('Inst '));
  return { pending: lines.length, security: lines.filter((l) => /securi/i.test(l)).length };
}
