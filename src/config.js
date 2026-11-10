import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHash } from './auth.js';
import { UNIT_NAME } from './collectors/services.js';
import { isLoopbackUrl } from './report.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8080,
  intervalSeconds: 3,
  historyMinutes: 10,
  trustProxy: false,
  allowedHosts: [],
  updateCheck: true,
  auth: { username: '', passwordHash: '' },
  tls: { cert: '', key: '' },
  services: [],
  // helperSocket: Konteynerler sayfasının kullandığı root Docker yardımcısı (panel Docker soketine erişmez).
  docker: { enabled: false, socket: '/var/run/docker.sock', helperSocket: '/run/serverhealth-docker.sock' },
  gpu: { enabled: true },
  processes: { top: 10, showCommandLine: true },
  network: { hideInterfaces: ['lo', 'veth*', 'br-*', 'docker*', 'virbr*'] },
  disks: { hide: ['/boot', '/boot/efi', '/efi'] },
  smart: { file: '/var/lib/serverhealth/smart.json' },
  system: { statusFile: '/var/lib/serverhealth/system.json' },
  // Günlük rapor: Ollama yalnızca bu makinede olabilir, kayıtlar dışarı gönderilmez.
  ollama: { url: 'http://127.0.0.1:11434' },
  reports: { dir: '/var/lib/serverhealth/reports' },
  // Uzun süreli ölçüm geçmişi panelin durum klasöründe dakikalık tutulur.
  history: { retentionDays: 30 },
  // Panel terminali: root yardımcısının açtığı systemd soketine bağlanır; boşta kalan oturum kapanır.
  terminal: { socket: '/run/serverhealth-term.sock', execSocket: '/run/serverhealth-exec.sock', idleMinutes: 15, commandTimeoutSeconds: 30, approvedTimeoutSeconds: 300 },
  // Disk alanı analizi, günlükler ve güvenlik sayfası: root'a ait, yalnızca okuyan sorgu yardımcısının soketi.
  query: { socket: '/run/serverhealth-query.sock' },
  // GitHub yedeği servisinin yazdığı durum dosyaları (panel yalnızca okur).
  backup: { dir: '/var/lib/serverhealth-backup' },
};

export function resolveConfigPath(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--config');
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  if (env.SERVERHEALTH_CONFIG) return path.resolve(env.SERVERHEALTH_CONFIG);
  return path.join(ROOT, 'config.json');
}

// systemd LoadCredential= ile verilen sertifikalar için: "${CREDENTIALS_DIRECTORY}/tls.key"
const expandCredentials = (value) =>
  value.replaceAll('${CREDENTIALS_DIRECTORY}', process.env.CREDENTIALS_DIRECTORY ?? '');

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function validate(cfg) {
  const errors = [];
  if (typeof cfg.host !== 'string' || !cfg.host) errors.push('host boş olamaz');
  if (!isInt(cfg.port, 1, 65535)) errors.push('port 1-65535 arasında bir tam sayı olmalı');
  if (typeof cfg.intervalSeconds !== 'number' || cfg.intervalSeconds < 1 || cfg.intervalSeconds > 60)
    errors.push('intervalSeconds 1-60 arasında olmalı');
  if (typeof cfg.historyMinutes !== 'number' || cfg.historyMinutes < 1 || cfg.historyMinutes > 1440)
    errors.push('historyMinutes 1-1440 arasında olmalı');
  if (typeof cfg.auth.username !== 'string' || !cfg.auth.username) errors.push('auth.username boş olamaz');
  if (!parseHash(cfg.auth.passwordHash))
    errors.push('auth.passwordHash geçersiz; "node bin/hash-password.js" ile üretin');
  if (Boolean(cfg.tls.cert) !== Boolean(cfg.tls.key)) errors.push('tls.cert ve tls.key birlikte verilmeli');
  if (!Array.isArray(cfg.services) || cfg.services.some((s) => typeof s !== 'string' || !UNIT_NAME.test(s)))
    errors.push('services, geçerli systemd birim adlarından oluşan bir liste olmalı (ör. "nginx", "ssh.service")');
  if (typeof cfg.docker.socket !== 'string' || !cfg.docker.socket) errors.push('docker.socket boş olamaz');
  if (typeof cfg.docker.helperSocket !== 'string' || !path.isAbsolute(cfg.docker.helperSocket)) errors.push('docker.helperSocket mutlak bir yol olmalı');
  if (typeof cfg.gpu.enabled !== 'boolean') errors.push('gpu.enabled true ya da false olmalı');
  if (!isInt(cfg.processes.top, 1, 50)) errors.push('processes.top 1-50 arasında olmalı');
  if (!Array.isArray(cfg.network.hideInterfaces) || cfg.network.hideInterfaces.some((s) => typeof s !== 'string'))
    errors.push('network.hideInterfaces bir metin listesi olmalı');
  if (!Array.isArray(cfg.disks.hide) || cfg.disks.hide.some((s) => typeof s !== 'string'))
    errors.push('disks.hide bir metin listesi olmalı');
  if (typeof cfg.smart.file !== 'string' || !cfg.smart.file) errors.push('smart.file boş olamaz');
  if (!isLoopbackUrl(cfg.ollama.url)) errors.push('ollama.url yalnızca bu makineyi gösterebilir (ör. "http://127.0.0.1:11434")');
  if (typeof cfg.reports.dir !== 'string' || !cfg.reports.dir) errors.push('reports.dir boş olamaz');
  if (!isInt(cfg.history.retentionDays, 1, 365)) errors.push('history.retentionDays 1-365 arasında olmalı');
  if (typeof cfg.terminal.socket !== 'string' || !path.isAbsolute(cfg.terminal.socket)) errors.push('terminal.socket mutlak bir yol olmalı');
  if (!isInt(cfg.terminal.idleMinutes, 1, 1440)) errors.push('terminal.idleMinutes 1-1440 arasında olmalı');
  if (typeof cfg.terminal.execSocket !== 'string' || !path.isAbsolute(cfg.terminal.execSocket)) errors.push('terminal.execSocket mutlak bir yol olmalı');
  if (!isInt(cfg.terminal.commandTimeoutSeconds, 1, 120)) errors.push('terminal.commandTimeoutSeconds 1-120 arasında olmalı');
  if (!isInt(cfg.terminal.approvedTimeoutSeconds, 1, 600)) errors.push('terminal.approvedTimeoutSeconds 1-600 arasında olmalı');
  if (typeof cfg.backup.dir !== 'string' || !path.isAbsolute(cfg.backup.dir)) errors.push('backup.dir mutlak bir yol olmalı');
  if (typeof cfg.query.socket !== 'string' || !path.isAbsolute(cfg.query.socket)) errors.push('query.socket mutlak bir yol olmalı');
  if (typeof cfg.updateCheck !== 'boolean') errors.push('updateCheck true ya da false olmalı');
  if (!Array.isArray(cfg.allowedHosts) || cfg.allowedHosts.some((s) => typeof s !== 'string' || !s))
    errors.push('allowedHosts bir ana makine adı listesi olmalı (ör. ["panel.example.com"])');
  if (errors.length) throw new Error(`Yapılandırma hatalı:\n  - ${errors.join('\n  - ')}`);
}

export function loadConfig(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Yapılandırma okunamadı (${file}): ${err.message}`);
  }
  const cfg = {
    ...DEFAULTS,
    ...raw,
    auth: { ...DEFAULTS.auth, ...raw.auth },
    tls: { ...DEFAULTS.tls, ...raw.tls },
    docker: { ...DEFAULTS.docker, ...raw.docker },
    gpu: { ...DEFAULTS.gpu, ...raw.gpu },
    processes: { ...DEFAULTS.processes, ...raw.processes },
    network: { ...DEFAULTS.network, ...raw.network },
    disks: { ...DEFAULTS.disks, ...raw.disks },
    smart: { ...DEFAULTS.smart, ...raw.smart },
    system: { ...DEFAULTS.system, ...raw.system },
    ollama: { ...DEFAULTS.ollama, ...raw.ollama },
    reports: { ...DEFAULTS.reports, ...raw.reports },
    history: { ...DEFAULTS.history, ...raw.history },
    terminal: { ...DEFAULTS.terminal, ...raw.terminal },
    query: { ...DEFAULTS.query, ...raw.query },
    backup: { ...DEFAULTS.backup, ...raw.backup },
  };
  validate(cfg);
  cfg.services = [...new Set(cfg.services)];
  cfg.tls.cert = expandCredentials(cfg.tls.cert);
  cfg.tls.key = expandCredentials(cfg.tls.key);
  return cfg;
}
