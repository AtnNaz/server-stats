#!/usr/bin/env node
// Node Stats root yardımcısı.
// Panel yetkisiz çalışır; sistem ayarı istediğinde kuyruğa bir istek dosyası bırakır. Bu yardımcı
// (systemd path birimiyle tetiklenir) isteği izin verilen değerler listesine göre yeniden doğrular,
// yalnızca önceden tanımlı işlemleri uygular ve sonucu panelin okuyacağı durum dosyasına yazar.
// Panelden gelen hiçbir değer komut satırına ya da kabuğa serbest metin olarak geçmez.
//
//   serverhealth-helper.js                     kuyruğu işle, durumu yaz
//   serverhealth-helper.js --smart-test short  bütün disklerde kısa SMART testini başlat
//   --root DİZİN --dry-run                      testler için: dosyaları DİZİN altına yaz, komut çalıştırma
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, readdir, lstat, unlink, rename, mkdir, stat, appendFile, access, open, rm, constants } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateRequest,
  aptConfig,
  parseAptConfigDump,
  countAptUpgrades,
  onCalendarWeekly,
  onCalendarMonthly,
  TERM_USER,
} from '../src/system-settings.js';
import { isNewer, parseVersion, repoFromUrl } from '../src/update-check.js';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_REQUEST = 16 * 1024;
// Kuyruk, root'a ait /var/lib altında durur; panel kullanıcısı klasörün kendisini değiştiremez.
const QUEUE_DIR = '/var/lib/serverhealth-queue';
const STALE_TEMP_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const opts = { root: '', dryRun: false, queue: QUEUE_DIR, smartTest: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opts.root = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--queue') opts.queue = argv[++i];
    else if (a === '--smart-test' && ['short', 'long'].includes(argv[i + 1])) opts.smartTest = argv[++i];
    else throw new Error(`bilinmeyen seçenek: ${a}`);
  }
  return opts;
}

export function createHelper({ root = '', dryRun = false, queue, nodeBin = process.execPath, appDir = APP_DIR, now = () => Date.now(), platformOverride = null, fetchImpl = fetch } = {}) {
  const P = (p) => path.join(root || '/', p);
  const files = {
    apt: P('/etc/apt/apt.conf.d/52serverhealth'),
    units: P('/etc/systemd/system'),
    state: P('/var/lib/serverhealth/system-settings.json'),
    status: P('/var/lib/serverhealth/system.json'),
    history: P('/var/lib/serverhealth/actions.jsonl'),
    updateLog: P('/var/lib/serverhealth/update.log'),
    queue: queue ? (root ? path.join(root, queue) : queue) : P(QUEUE_DIR),
  };
  const commands = []; // --dry-run'da çalıştırılacak komutların kaydı (testler için)

  function run(cmd, args, { timeout = 120_000, env = {}, logFile = null } = {}) {
    commands.push([cmd, ...args].join(' '));
    if (dryRun) return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { env: { ...process.env, LC_ALL: 'C', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
      child.stdout.on('data', (d) => {
        stdout += d;
        if (logFile) appendFile(logFile, d).catch(() => {});
      });
      child.stderr.on('data', (d) => {
        stderr += d;
        if (logFile) appendFile(logFile, d).catch(() => {});
      });
      child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  async function which(cmd) {
    for (const dir of ['/usr/sbin', '/usr/bin', '/sbin', '/bin']) {
      try {
        await access(path.join(dir, cmd), constants.X_OK);
        return path.join(dir, cmd);
      } catch {
        /* sıradaki */
      }
    }
    return null;
  }

  async function writeAtomic(file, content, mode = 0o644) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, content, { mode });
    await rename(tmp, file);
  }

  async function record(entry) {
    await mkdir(path.dirname(files.history), { recursive: true });
    await appendFile(files.history, `${JSON.stringify({ time: now(), ...entry })}\n`);
  }

  async function detectPlatform() {
    if (platformOverride) return { ...platformOverride };
    const [apt, dnf, systemctl, smartctl, python3] = await Promise.all(['apt-get', 'dnf', 'systemctl', 'smartctl', 'python3'].map(which));
    const termUnit = await access(path.join(files.units, TERM_SOCKET)).then(() => true, () => false);
    const packageManager = apt ? 'apt' : dnf ? 'dnf' : null;
    let unattendedInstalled = false;
    if (packageManager === 'apt' && !dryRun) {
      const r = await run('dpkg-query', ['-W', '-f=${Status}', 'unattended-upgrades']);
      unattendedInstalled = r.stdout.includes('install ok installed');
    }
    return {
      packageManager,
      systemctl: systemctl ?? '/usr/bin/systemctl',
      autoUpdates: packageManager === 'apt',
      updateNow: Boolean(packageManager),
      smartTests: Boolean(smartctl),
      unattendedInstalled,
      terminal: Boolean(python3 && termUnit),
      terminalUsers: await terminalUsers(),
    };
  }

  const DEFAULT_STATE = {
    scheduledReboot: { enabled: false, day: 'sun', time: '04:00' },
    smartTests: { enabled: false, shortDay: 'sun', longDay: 1, time: '03:00' },
    report: { enabled: false, time: '07:00', model: '' },
    terminal: { enabled: false, user: '' },
    rebootTime: '04:00',
  };

  async function loadState() {
    try {
      const saved = JSON.parse(await readFile(files.state, 'utf8'));
      return {
        ...DEFAULT_STATE,
        ...saved,
        scheduledReboot: { ...DEFAULT_STATE.scheduledReboot, ...saved.scheduledReboot },
        smartTests: { ...DEFAULT_STATE.smartTests, ...saved.smartTests },
        report: { ...DEFAULT_STATE.report, ...saved.report },
        terminal: { ...DEFAULT_STATE.terminal, ...saved.terminal },
      };
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  // --- systemd zamanlayıcıları ---

  async function setTimer(name, { description, exec, onCalendar }) {
    const service = path.join(files.units, `${name}.service`);
    const timer = path.join(files.units, `${name}.timer`);
    await writeAtomic(service, `[Unit]\nDescription=${description}\n\n[Service]\nType=oneshot\nExecStart=${exec}\n`);
    // Persistent=false: kaçırılan bir zaman (sunucu kapalıyken) açılışta telafi edilmez.
    await writeAtomic(timer, `[Unit]\nDescription=${description}\n\n[Timer]\nOnCalendar=${onCalendar}\nPersistent=false\n\n[Install]\nWantedBy=timers.target\n`);
    await run(platform.systemctl, ['daemon-reload']);
    await run(platform.systemctl, ['enable', '--now', `${name}.timer`]);
  }

  async function removeTimer(name) {
    await run(platform.systemctl, ['disable', '--now', `${name}.timer`]);
    await Promise.all([`${name}.service`, `${name}.timer`].map((f) => unlink(path.join(files.units, f)).catch(() => {})));
    await run(platform.systemctl, ['daemon-reload']);
  }

  // Günlük rapor servisi (serverhealth-report.service) kurulumla gelir ve sıkı kısıtlıdır;
  // burada yalnızca onu tetikleyen zamanlayıcı yazılır ya da kaldırılır.
  const REPORT_TIMER = 'serverhealth-report.timer';
  async function setReportTimer(time) {
    // Persistent=true: sunucu o saatte kapalıysa rapor açılışta oluşturulur.
    await writeAtomic(path.join(files.units, REPORT_TIMER), `[Unit]\nDescription=Node Stats - günlük rapor\n\n[Timer]\nOnCalendar=${onCalendarWeekly('daily', time)}\nPersistent=true\nUnit=serverhealth-report.service\n\n[Install]\nWantedBy=timers.target\n`);
    await run(platform.systemctl, ['daemon-reload']);
    await run(platform.systemctl, ['enable', '--now', REPORT_TIMER]);
  }
  async function removeReportTimer() {
    await run(platform.systemctl, ['disable', '--now', REPORT_TIMER]);
    await unlink(path.join(files.units, REPORT_TIMER)).catch(() => {});
    await run(platform.systemctl, ['daemon-reload']);
  }

  // Panel terminali: soket ve şablon servis kurulumla gelir; burada yalnızca kabuğun hangi
  // kullanıcıyla açılacağı yazılır ve soket açılıp kapatılır.
  const TERM_SOCKET = 'serverhealth-term.socket';
  const termDropIn = () => path.join(files.units, 'serverhealth-term@.service.d', 'user.conf');

  // Terminal için seçilebilecek kullanıcılar: gerçek giriş kabuğu olan normal hesaplar (root değil).
  async function terminalUsers() {
    const text = await readFile(P('/etc/passwd'), 'utf8').catch(() => '');
    return text
      .split('\n')
      .map((l) => l.split(':'))
      .filter((f) => f.length >= 7 && Number(f[2]) >= 1000 && Number(f[2]) < 65534 && TERM_USER.test(f[0]) && !/(nologin|false)$/.test(f[6]))
      .map((f) => f[0]);
  }

  async function setTerminal(user) {
    await writeAtomic(termDropIn(), `[Service]\nUser=${user}\n`);
    await run(platform.systemctl, ['daemon-reload']);
    await run(platform.systemctl, ['enable', '--now', TERM_SOCKET]);
  }
  async function removeTerminal() {
    await run(platform.systemctl, ['disable', '--now', TERM_SOCKET]);
    await run(platform.systemctl, ['stop', 'serverhealth-term@*.service']);
    await unlink(termDropIn()).catch(() => {});
    await run(platform.systemctl, ['daemon-reload']);
  }

  let platform;

  async function applySettings(requested) {
    const state = await loadState();
    const next = {
      ...state,
      ...requested,
      scheduledReboot: { ...state.scheduledReboot, ...requested.scheduledReboot },
      smartTests: { ...state.smartTests, ...requested.smartTests },
      report: { ...state.report, ...requested.report },
      terminal: { ...state.terminal, ...requested.terminal },
    };
    const changes = [];

    if ('updates' in requested || 'rebootAfterUpdate' in requested || 'rebootTime' in requested) {
      if (!platform.autoUpdates) throw new Error('unsupported');
      const current = await readAptSettings();
      const apt = { updates: next.updates ?? current.updates, rebootAfterUpdate: next.rebootAfterUpdate ?? current.rebootAfterUpdate, rebootTime: next.rebootTime ?? current.rebootTime };
      if (apt.updates !== 'off' && !platform.unattendedInstalled) {
        const r = await run('apt-get', ['install', '-y', 'unattended-upgrades'], { timeout: 15 * 60_000, env: { DEBIAN_FRONTEND: 'noninteractive' } });
        if (r.code !== 0) throw new Error('unattended_install_failed');
        platform.unattendedInstalled = true;
      }
      await writeAtomic(files.apt, aptConfig(apt));
      if (apt.updates !== 'off') await run(platform.systemctl, ['enable', '--now', 'apt-daily.timer', 'apt-daily-upgrade.timer']);
      Object.assign(next, apt);
      changes.push('updates');
    }

    if (requested.scheduledReboot) {
      const r = next.scheduledReboot;
      if (r.enabled) {
        await setTimer('serverhealth-reboot', {
          description: 'Node Stats - planlı yeniden başlatma',
          exec: `${platform.systemctl} reboot`,
          onCalendar: onCalendarWeekly(r.day, r.time),
        });
      } else {
        await removeTimer('serverhealth-reboot');
      }
      changes.push('scheduledReboot');
    }

    if (requested.smartTests) {
      const s = next.smartTests;
      if (s.enabled && !platform.smartTests) throw new Error('smartctl_missing');
      const helper = `${nodeBin} ${path.join(appDir, 'bin', 'serverhealth-helper.js')}`;
      if (s.enabled) {
        await setTimer('serverhealth-smarttest-short', { description: 'Node Stats - haftalık kısa SMART testi', exec: `${helper} --smart-test short`, onCalendar: onCalendarWeekly(s.shortDay, s.time) });
        await setTimer('serverhealth-smarttest-long', { description: 'Node Stats - aylık uzun SMART testi', exec: `${helper} --smart-test long`, onCalendar: onCalendarMonthly(s.longDay, s.time) });
      } else {
        await removeTimer('serverhealth-smarttest-short');
        await removeTimer('serverhealth-smarttest-long');
      }
      changes.push('smartTests');
    }

    if (requested.report) {
      const r = next.report;
      if (r.enabled && !r.model) throw new Error('model_missing');
      if (r.enabled) await setReportTimer(r.time);
      else await removeReportTimer();
      changes.push('report');
    }

    if (requested.terminal) {
      const tm = next.terminal;
      if (tm.enabled) {
        if (!platform.terminal) throw new Error('terminal_unsupported');
        if (!platform.terminalUsers.includes(tm.user)) throw new Error('terminal_user');
        await setTerminal(tm.user);
      } else {
        await removeTerminal();
      }
      changes.push('terminal');
    }

    await writeAtomic(files.state, `${JSON.stringify(next, null, 2)}\n`, 0o644);
    return changes;
  }

  async function readAptSettings() {
    if (dryRun) {
      // Deneme modunda apt-config yerine yazılan dosyanın kendisi okunur.
      try {
        const text = await readFile(files.apt, 'utf8');
        const parsed = parseAptConfigDump(text);
        if (parsed.updates !== 'off' && /Allowed-Origins \{ ".*-updates/.test(text)) parsed.updates = 'all';
        return parsed;
      } catch {
        return { updates: 'security', rebootAfterUpdate: false, rebootTime: '02:00' };
      }
    }
    return parseAptConfigDump((await run('apt-config', ['dump'])).stdout);
  }

  async function runUpdate() {
    await writeAtomic(files.updateLog, '');
    const log = files.updateLog;
    if (platform.packageManager === 'apt') {
      const env = { DEBIAN_FRONTEND: 'noninteractive' };
      const refresh = await run('apt-get', ['update'], { timeout: 15 * 60_000, env, logFile: log });
      if (refresh.code !== 0) throw new Error('apt_update_failed');
      // Değiştirilmiş yapılandırma dosyalarında mevcut sürüm korunur; kurulum soru sormaz.
      const upgrade = await run('apt-get', ['-y', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', 'upgrade'], { timeout: 60 * 60_000, env, logFile: log });
      if (upgrade.code !== 0) throw new Error('apt_upgrade_failed');
    } else if (platform.packageManager === 'dnf') {
      const r = await run('dnf', ['-y', 'upgrade', '--refresh'], { timeout: 60 * 60_000, logFile: log });
      if (r.code !== 0) throw new Error('dnf_upgrade_failed');
    } else {
      throw new Error('unsupported');
    }
  }

  async function checkUpdates({ refresh = false } = {}) {
    const result = { pending: null, security: null, rebootRequired: false, rebootPackages: [], lastAutoRun: null };
    if (platform.packageManager === 'apt') {
      if (refresh) await run('apt-get', ['update'], { timeout: 15 * 60_000, env: { DEBIAN_FRONTEND: 'noninteractive' } });
      const sim = await run('apt-get', ['-s', '-o', 'Debug::NoLocking=1', 'upgrade']);
      if (!dryRun) Object.assign(result, countAptUpgrades(sim.stdout));
      try {
        await access(P('/run/reboot-required'));
        result.rebootRequired = true;
        result.rebootPackages = (await readFile(P('/run/reboot-required.pkgs'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
      } catch {
        /* yeniden başlatma gerekmiyor */
      }
      result.lastAutoRun = await stat(P('/var/lib/apt/periodic/unattended-upgrades-stamp')).then((s) => s.mtimeMs, () => null);
    } else if (platform.packageManager === 'dnf') {
      const r = await run('dnf', ['-q', 'check-update'], { timeout: 10 * 60_000 });
      if (!dryRun) result.pending = r.code === 100 ? r.stdout.split('\n').filter((l) => /^\S+\.\S+\s+\S+\s+\S+/.test(l)).length : 0;
      const nr = await run('needs-restarting', ['-r']);
      result.rebootRequired = nr.code === 1;
    }
    return result;
  }

  async function writeStatus(extra = {}) {
    const state = await loadState();
    const apt = platform.autoUpdates ? await readAptSettings() : {};
    const history = (await readFile(files.history, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .slice(-30)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
    const updateLog = (await readFile(files.updateLog, 'utf8').catch(() => '')).split('\n').slice(-40).join('\n');
    const previous = await readFile(files.status, 'utf8').then((s) => JSON.parse(s), () => ({}));
    const status = {
      updated: now(),
      platform,
      settings: {
        updates: platform.autoUpdates ? apt.updates : null,
        rebootAfterUpdate: platform.autoUpdates ? apt.rebootAfterUpdate : null,
        rebootTime: platform.autoUpdates ? apt.rebootTime : state.rebootTime,
        scheduledReboot: state.scheduledReboot,
        smartTests: state.smartTests,
        report: state.report,
        terminal: state.terminal,
      },
      updates: extra.updates ?? previous.updates ?? null,
      running: extra.running ?? null,
      updateLog,
      history,
    };
    await writeAtomic(files.status, `${JSON.stringify(status)}\n`);
    return status;
  }

  // Bir kuyruk dosyasını sembolik bağı izlemeden açar; tür ve boyut açılan dosyanın kendisinde
  // denetlenir, böylece denetimle okuma arasında dosya değiştirilemez.
  async function readRequestFile(file) {
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (err) {
      if (err.code === 'ELOOP') return { invalid: true };
      throw err;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_REQUEST) return { invalid: true };
      const buf = Buffer.alloc(MAX_REQUEST + 1);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_REQUEST) return { invalid: true };
      return { text: buf.subarray(0, bytesRead).toString('utf8') };
    } finally {
      await handle.close();
    }
  }

  // Panelin yarıda bıraktığı geçici dosyalar (.tmp) kuyruğu dolu gösterip yardımcıyı sürekli
  // tetiklemesin: yeni olanların bitmesi biraz beklenir, eskileri silinir.
  async function settleQueue() {
    for (let attempt = 0; ; attempt++) {
      const names = await readdir(files.queue);
      let fresh = false;
      for (const name of names.filter((n) => !n.endsWith('.json'))) {
        const file = path.join(files.queue, name);
        const info = await lstat(file).catch(() => null);
        if (!info || info.isDirectory()) continue;
        if (info.isFile() && now() - info.mtimeMs < STALE_TEMP_MS && attempt < 5) fresh = true;
        else await unlink(file).catch(() => {});
      }
      if (!fresh || dryRun) return names.filter((n) => n.endsWith('.json')).sort();
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Kuyruktaki istek dosyalarını okur. Sembolik bağlantı ve büyük dosyalar reddedilir:
  // panel ele geçirilse bile yardımcıya başka bir dosyayı (ör. /etc/shadow) okutamaz.
  async function readQueue() {
    const dirInfo = await lstat(files.queue).catch(() => null);
    if (!dirInfo) return [];
    if (!dirInfo.isDirectory()) {
      await record({ type: 'rejected', ok: false, message: 'invalid_queue' });
      return [];
    }
    const names = await settleQueue();
    const requests = [];
    for (const name of names) {
      const file = path.join(files.queue, name);
      try {
        const { invalid, text } = await readRequestFile(file);
        if (invalid) {
          await record({ type: 'rejected', ok: false, message: 'invalid_file' });
          continue;
        }
        const { errors, request } = validateRequest(JSON.parse(text));
        if (errors) await record({ type: 'rejected', ok: false, message: 'invalid_request' });
        else requests.push(request);
      } catch {
        await record({ type: 'rejected', ok: false, message: 'unreadable' });
      } finally {
        await unlink(file).catch(() => {});
      }
    }
    return requests;
  }

  async function processQueue() {
    platform = await detectPlatform();
    const requests = await readQueue();
    let updates = null;
    let reboot = false;
    // Aynı turda birden çok "güncelle" isteği gelirse bir kez çalıştırılır.
    const seen = new Set();
    for (const req of requests) {
      if (req.type === 'settings') {
        try {
          const changes = await applySettings(req.settings);
          await record({ type: 'settings', ok: true, changes, settings: req.settings });
        } catch (err) {
          await record({ type: 'settings', ok: false, message: err.message, settings: req.settings });
        }
        continue;
      }
      if (seen.has(req.action)) continue;
      seen.add(req.action);
      if (req.action === 'update') {
        const startedAt = now();
        await writeStatus({ running: { action: 'update', startedAt } });
        try {
          await runUpdate();
          await record({ type: 'action', action: 'update', ok: true, startedAt });
        } catch (err) {
          await record({ type: 'action', action: 'update', ok: false, message: err.message, startedAt });
        }
        updates = await checkUpdates();
      } else if (req.action === 'refresh') {
        updates = await checkUpdates({ refresh: true });
        await record({ type: 'action', action: 'refresh', ok: true });
      } else if (req.action === 'reboot') {
        reboot = true;
      } else if (req.action === 'self-update') {
        try {
          const r = await selfUpdate();
          await record({ type: 'action', action: 'self-update', ok: true, version: r.version, upToDate: Boolean(r.upToDate) });
        } catch (err) {
          await record({ type: 'action', action: 'self-update', ok: false, message: err.message });
        }
      } else if (req.action === 'report') {
        // Rapor birkaç dakika sürebilir; servis arka planda başlatılır, sonucu Raporlar sayfasında görünür.
        const r = await run(platform.systemctl, ['start', '--no-block', 'serverhealth-report.service']);
        await record({ type: 'action', action: 'report', ok: r.code === 0, ...(r.code !== 0 && { message: 'report_start_failed' }) });
      }
    }
    if (!updates) updates = await checkUpdates();
    if (reboot) {
      await record({ type: 'action', action: 'reboot', ok: true });
      await writeStatus({ updates, running: { action: 'reboot', startedAt: now() } });
      await run(platform.systemctl, ['reboot']);
      return;
    }
    await writeStatus({ updates });
  }

  // Panelden güncelleme: hangi sürümün kurulacağına panel değil yardımcı karar verir. Kurulu
  // package.json'daki GitHub deposunun son sürümü, mevcut sürümden yeniyse indirilip kurulur.
  const MAX_ARCHIVE = 20 * 1024 * 1024;
  async function selfUpdate() {
    const pkg = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
    const repo = repoFromUrl(pkg.homepage);
    if (!repo) throw new Error('no_repo');
    const headers = { 'User-Agent': 'server-stats' };
    let tag;
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { ...headers, Accept: 'application/vnd.github+json' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      tag = res.ok ? String((await res.json())?.tag_name ?? '') : '';
    } catch {
      tag = '';
    }
    if (!parseVersion(tag)) throw new Error('release_check_failed');
    if (!isNewer(tag, pkg.version)) return { version: pkg.version, upToDate: true };

    const dir = P('/var/lib/serverhealth/update');
    await rm(dir, { recursive: true, force: true });
    const src = path.join(dir, 'src');
    await mkdir(src, { recursive: true, mode: 0o700 });
    let archive;
    try {
      const res = await fetchImpl(`https://codeload.github.com/${repo}/tar.gz/refs/tags/${tag}`, { headers, redirect: 'error', signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error();
      archive = Buffer.from(await res.arrayBuffer());
    } catch {
      throw new Error('download_failed');
    }
    if (archive.length > MAX_ARCHIVE) throw new Error('download_failed');
    const file = path.join(dir, 'release.tar.gz');
    await writeFile(file, archive, { mode: 0o600 });
    const x = await run('tar', ['-xzf', file, '-C', src, '--strip-components=1', '--no-same-owner', '--no-same-permissions']);
    if (x.code !== 0) throw new Error('extract_failed');
    // install.sh paneli ve bu yardımcıyı yeniden başlatır; içeriden beklenirse kilitlenirdi.
    // Bu yüzden ayrı, geçici bir systemd biriminde çalıştırılır.
    const r = await run((await which('systemd-run')) ?? '/usr/bin/systemd-run', ['--unit=serverhealth-update', '--collect', '--quiet', '/bin/bash', path.join(src, 'deploy', 'install.sh')]);
    if (r.code !== 0) throw new Error('install_start_failed');
    return { version: tag.replace(/^v/, '') };
  }

  async function smartTest(kind) {
    platform = await detectPlatform();
    const scan = JSON.parse((await run('smartctl', ['--scan-open', '--json=c'])).stdout || '{"devices":[]}');
    const started = [];
    for (const dev of scan.devices ?? []) {
      if (dev.open_error) continue;
      const r = await run('smartctl', ['-t', kind, '-d', dev.type, dev.name]);
      if (r.code === 0 || (r.code & 0b11) === 0) started.push(dev.name);
    }
    await record({ type: 'smart-test', action: kind, ok: true, devices: started });
    await writeStatus({});
  }

  return { processQueue, smartTest, applySettings, readQueue, files, commands, setPlatform: (p) => (platform = p) };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const helper = createHelper({ root: opts.root, dryRun: opts.dryRun, queue: opts.queue });
  if (opts.smartTest) await helper.smartTest(opts.smartTest);
  else await helper.processQueue();
}

// Test dosyaları içe aktarınca main çalışmasın.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`serverhealth-helper: ${err.message}`);
    process.exit(1);
  });
}
