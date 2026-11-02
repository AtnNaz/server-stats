// Panelin root yardımcısından isteyebileceği sistem ayarları ve işlemleri.
// Hem panel (kuyruğa koymadan önce) hem yardımcı (uygulamadan önce) aynı kurallarla doğrular;
// yardımcı panelin yazdığı dosyaya asla güvenmez.

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const UPDATE_MODES = ['off', 'security', 'all'];
export const ACTIONS = ['update', 'reboot', 'refresh', 'report', 'self-update'];
// Ollama model adı, ör. "qwen3.5:4b" ya da "hf.co/kullanici/model:Q4_0"
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

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
  return { errors, value };
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
    '// Sunucu Durumu paneli tarafından yönetilir; elle değiştirmeyin, panelin Ayarlar bölümünü kullanın.',
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
export function countAptUpgrades(text) {
  const lines = text.split('\n').filter((l) => l.startsWith('Inst '));
  return { pending: lines.length, security: lines.filter((l) => /securi/i.test(l)).length };
}
