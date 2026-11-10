#!/usr/bin/env node
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveConfigPath } from './config.js';
import { createAuth, hashPassword } from './auth.js';
import { createSettingsStore, effectiveConfig, publicSettings, validatePanelSettings } from './settings.js';
import { validateRequest, MODEL_NAME } from './system-settings.js';
import { setLanguage } from './i18n.js';
import { createSessions, authKeyOf } from './sessions.js';
import { createSampler } from './sampler.js';
import { createUpdateChecker, repoFromUrl } from './update-check.js';
import { createHistoryStore, RANGES } from './history-store.js';
import { createOllama, validateChat, RUN_COMMAND_TOOL } from './ollama.js';
import { classifyCommand, rootSteps } from './command-policy.js';
import { runCommand } from './exec.js';
import { buildServerContext } from './server-context.js';
import { createChatStore } from './chat-store.js';
import { updateSummaryMessages } from './update-summary.js';
import { createSpeedtest } from './speedtest.js';
import { createUptime } from './uptime.js';
import { createDiskHealth, HEALTH_RANGES } from './disk-health.js';
import { upgrade } from './websocket.js';
import { createTerminals, terminalAvailable } from './terminal.js';
import { runQuery, queryAvailable } from './query.js';
import { validateQuery, validScanPath } from './query-protocol.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Sürüm ve proje bilgisi package.json'dan gelir; kurulum dosyayı uygulama klasörüne kopyalar.
const ABOUT = readAbout();
function readAbout() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PUBLIC_DIR, '..', 'package.json'), 'utf8'));
    return { version: pkg.version ?? null, author: pkg.author ?? null, homepage: pkg.homepage ?? null, license: pkg.license ?? null };
  } catch {
    return { version: null, author: null, homepage: null, license: null };
  }
}
const TEXT = 'text/plain; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 4096;
// Sohbet isteği tüm konuşmayı taşır.
const MAX_CHAT_BODY = 512 * 1024;
// Kaydedilen sohbet komut çıktılarını da taşır.
const MAX_SAVE_BODY = 4 * 1024 * 1024;

// Yalnızca bu dosyalar sunulur; dosya yolu istekten türetilmez.
// public: true olanlar oturum açmadan da yüklenebilir (giriş sayfası için).
const ASSETS = [
  { route: '/', file: 'index.html', type: 'text/html; charset=utf-8' },
  { route: '/app.js', file: 'app.js', type: 'text/javascript; charset=utf-8' },
  { route: '/login', file: 'login.html', type: 'text/html; charset=utf-8', public: true },
  { route: '/login.js', file: 'login.js', type: 'text/javascript; charset=utf-8', public: true },
  { route: '/i18n.js', file: 'i18n.js', type: 'text/javascript; charset=utf-8', public: true },
  { route: '/style.css', file: 'style.css', type: 'text/css; charset=utf-8', public: true },
  { route: '/favicon.svg', file: 'favicon.svg', type: 'image/svg+xml', public: true },
  { route: '/terminal', file: 'terminal.html', type: 'text/html; charset=utf-8', headers: 'terminal' },
  { route: '/terminal.js', file: 'terminal.js', type: 'text/javascript; charset=utf-8' },
  { route: '/vendor/xterm.js', file: 'vendor/xterm.js', type: 'text/javascript; charset=utf-8' },
  { route: '/vendor/xterm-addon-fit.js', file: 'vendor/xterm-addon-fit.js', type: 'text/javascript; charset=utf-8' },
  { route: '/vendor/xterm.css', file: 'vendor/xterm.css', type: 'text/css; charset=utf-8' },
];

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

// Terminal sayfası panelin içinde iframe olarak açılır; xterm.js çalışırken <style> etiketi eklediği için
// satır içi stillere yalnızca bu sayfada izin verilir (betikler yine yalnızca 'self').
const ASSET_HEADERS = {
  terminal: {
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    'X-Frame-Options': 'SAMEORIGIN',
  },
};

const isLoopback = (addr) => addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');

function loadAssets() {
  return new Map(ASSETS.map((a) => [a.route, { ...a, body: readFileSync(path.join(PUBLIC_DIR, a.file)) }]));
}

function send(req, res, status, type, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': buf.length, ...headers });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

const sendJson = (req, res, status, data, headers) => send(req, res, status, JSON_TYPE, JSON.stringify(data), headers);
const redirect = (req, res, location) => send(req, res, 302, TEXT, '', { Location: location });

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // Sınır aşılınca gövde saklanmadan sonuna kadar okunur, böylece istemci 413 yanıtını alabilir;
    // süre requestTimeout ile sınırlıdır.
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > limit) reject(Object.assign(new Error('İstek gövdesi çok büyük'), { status: 413 }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

// Başka bir sitenin, kullanıcının tarayıcısı üzerinden giriş/çıkış isteği göndermesini engeller.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// İsteğin Host başlığındaki ad (küçük harf, port olmadan; IPv6 köşeli parantezli).
function requestHostname(req) {
  try {
    return new URL(`http://${req.headers.host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Sunucunun kendi adları: localhost, makine adı ve arayüz adresleri (ör. yerel ağ ve Tailscale).
function localHostnames() {
  const names = new Set(['localhost', '127.0.0.1', '[::1]']);
  const host = os.hostname().toLowerCase();
  names.add(host).add(host.split('.')[0]).add(`${host.split('.')[0]}.local`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) names.add(a.family === 'IPv6' || a.family === 6 ? `[${a.address.split('%')[0].toLowerCase()}]` : a.address);
  }
  return names;
}

// Örnekleyiciyi etkileyen ayarlar değişince yeniden kurulur.
const SAMPLER_KEYS = ['intervalSeconds', 'historyMinutes', 'services', 'disks', 'network'];

function listServiceUnits() {
  return new Promise((resolve, reject) => {
    execFile('systemctl', ['list-unit-files', '--type=service', '--no-legend', '--no-pager'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
      if (err) return reject(err);
      const units = stdout
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .filter(([unit, state]) => unit?.endsWith('.service') && !unit.includes('@') && state && !['alias', 'static', 'indirect', 'transient', 'generated'].includes(state))
        .map(([unit, state]) => ({ name: unit.slice(0, -'.service'.length), state }));
      resolve(units.sort((a, b) => a.name.localeCompare(b.name)));
    });
  });
}

function main() {
  const configPath = resolveConfigPath();
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (process.platform !== 'linux') console.warn('Uyarı: bu uygulama Linux için yazıldı; çoğu veri bu sistemde toplanamaz.');

  // systemd StateDirectory= bu değişkeni verir; geliştirme ortamında proje içindeki "state" kullanılır.
  const stateDir = process.env.STATE_DIRECTORY?.split(':')[0] ?? config.stateDirectory ?? path.join(path.dirname(PUBLIC_DIR), 'state');
  // systemd biriminde root'a ait kuyruk klasörü verilir; geliştirmede durum klasörü kullanılır.
  const queueDir = process.env.SERVERHEALTH_QUEUE ?? path.join(stateDir, 'queue');
  const settingsStore = createSettingsStore(stateDir);
  const stored = settingsStore.get();
  if (stored.passwordHash && stored.passwordBase === undefined) {
    // Eski sürümde arayüzden değiştirilmiş şifre: hangi config.json'a göre ayarlandığı kaydedilir.
    settingsStore.setPasswordHash(stored.passwordHash, config.auth.passwordHash).catch((err) => console.error(err.message));
  } else if (stored.passwordHash && stored.passwordBase !== config.auth.passwordHash) {
    console.log("config.json'daki şifre sonradan değiştirilmiş; arayüzde ayarlanan şifre yerine o kullanılıyor.");
  }
  let effective = effectiveConfig(config, settingsStore.get());
  setLanguage(effective.language);

  let auth = createAuth(effective.auth);
  // Oturumlar durum klasöründe saklanır: "beni hatırla" panel yeniden başlayınca da geçerli kalır.
  const sessions = createSessions({ file: path.join(stateDir, 'sessions.json'), authKey: authKeyOf(effective.auth.username, effective.auth.passwordHash) });
  const history = createHistoryStore({ dir: path.join(stateDir, 'history'), retentionDays: config.history.retentionDays });
  // Disk sağlığı geçmişi: SMART değerleri saatte bir kaydedilir.
  const diskHealth = createDiskHealth({ dir: path.join(stateDir, 'disk-health') });
  let diskAlerts = [];
  const refreshDiskAlerts = () => diskHealth.alerts().then((a) => (diskAlerts = a), () => {});
  setInterval(refreshDiskAlerts, 10 * 60_000).unref();
  refreshDiskAlerts();
  const samplerHooks = {
    onSample: (snapshot) => {
      history.add(snapshot);
      diskHealth.record(snapshot).catch((err) => console.warn(`Disk sağlığı kaydedilemedi: ${err.message}`));
    },
  };
  let sampler = createSampler(effective, samplerHooks);
  const assets = loadAssets();
  const updates = createUpdateChecker({ repo: repoFromUrl(ABOUT.homepage), current: ABOUT.version, stateDir, enabled: config.updateCheck });

  async function applySettings(previous) {
    effective = effectiveConfig(config, settingsStore.get());
    setLanguage(effective.language);
    if (SAMPLER_KEYS.some((k) => JSON.stringify(previous[k]) !== JSON.stringify(effective[k]))) {
      sampler.stop();
      sampler = createSampler(effective, samplerHooks);
      sampler.start();
    }
  }

  // Günlük raporlar root yardımcısının servisi tarafından yazılır; panel yalnızca okur.
  const REPORT_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
  async function listReports() {
    const names = (await readdir(config.reports.dir).catch(() => [])).filter((n) => REPORT_FILE.test(n)).sort().reverse().slice(0, 60);
    const items = await Promise.all(
      names.map(async (name) => {
        try {
          const r = JSON.parse(await readFile(path.join(config.reports.dir, name), 'utf8'));
          return { date: name.slice(0, 10), createdAt: r.createdAt ?? null, status: r.ai?.status ?? null, findings: r.ai?.findings?.length ?? 0, aiError: r.aiError ?? null };
        } catch {
          return null;
        }
      }),
    );
    return items.filter(Boolean);
  }

  const ollama = createOllama({ url: config.ollama.url });
  const chats = createChatStore({ dir: path.join(stateDir, 'chats') });
  const speedtest = createSpeedtest({ dir: stateDir });
  // Servis izleme: tanımlanan adreslere düzenli bağlanır; sonuçlar panelin durum klasöründe.
  const uptime = createUptime({ dir: path.join(stateDir, 'uptime') });
  uptime.start().catch((err) => console.warn(`Servis izleme başlatılamadı: ${err.message}`));

  async function handleUptimeSave(req, res) {
    const body = await readJsonBody(req, res, 32 * 1024);
    if (!body) return;
    const saved = await uptime.save(body.monitors);
    if (!saved) return sendJson(req, res, 400, { code: 'invalid' });
    return sendJson(req, res, 200, await uptime.status());
  }

  async function handleUptimeCheck(req, res) {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const r = await uptime.checkNow(String(body.id ?? ''));
    if (!r) return sendJson(req, res, 404, { code: 'not_found' });
    return sendJson(req, res, 200, await uptime.status());
  }

  // Zamanlanmış hız testi: Ayarlar'da seçilen aralıkla; son testten bu yana süre dolduysa başlar.
  const speedtestTimer = setInterval(async () => {
    const hours = effective.speedtestHours;
    if (!hours || speedtest.running) return;
    if (Date.now() - (await speedtest.lastTime()) >= hours * 3600_000) speedtest.start('scheduled');
  }, 60_000);
  speedtestTimer.unref();

  async function handleSpeedtest(req, res) {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (!speedtest.start('manual')) return sendJson(req, res, 409, { code: 'busy' });
    console.log(`Hız testi istendi (${clientIp(req)})`);
    return sendJson(req, res, 202, { started: true });
  }

  // --- Root sorgu yardımcısı: disk alanı analizi, günlükler, güvenlik ---

  const QUERY_ERRORS = { unavailable: 409, timeout: 504, invalid: 400, not_found: 404, not_dir: 400, bad_cursor: 409 };
  function sendQueryError(req, res, err) {
    const code = err.code === 'unavailable' ? 'query_unavailable' : err.code ?? 'failed';
    return sendJson(req, res, QUERY_ERRORS[err.code] ?? 502, { code });
  }
  const query = (request, timeoutMs = 20_000) => runQuery({ socketPath: config.query.socket, request, timeoutMs });

  // Disk taraması uzun sürebilir: arka planda yürür, tarayıcı durumu yoklar. Aynı anda tek tarama
  // çalışır; son sonuçlar bir süre bellekte tutulur, aynı klasör yeniden istenince hemen gelir.
  const USAGE_TTL = 30 * 60_000;
  const usage = { job: null, results: new Map() };
  function usageStatus(p) {
    const cached = usage.results.get(p);
    return { running: usage.job?.path ?? null, startedAt: usage.job?.startedAt ?? null, result: cached?.result ?? null, error: cached?.error ?? null, at: cached?.at ?? null };
  }

  async function handleDiskUsage(req, res) {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (!validScanPath(body.path)) return sendJson(req, res, 400, { code: 'invalid' });
    if (!(await queryAvailable(config.query.socket))) return sendJson(req, res, 409, { code: 'query_unavailable' });
    const cached = usage.results.get(body.path);
    if (body.refresh !== true && cached?.result && Date.now() - cached.at < USAGE_TTL) return sendJson(req, res, 200, usageStatus(body.path));
    if (usage.job) return sendJson(req, res, usage.job.path === body.path ? 202 : 409, { ...usageStatus(body.path), ...(usage.job.path !== body.path && { code: 'busy' }) });
    usage.job = { path: body.path, startedAt: Date.now() };
    console.log(`Disk alanı analizi: ${body.path} (${clientIp(req)})`);
    query({ op: 'du', path: body.path }, 210_000)
      .then(
        (result) => usage.results.set(body.path, { result, at: Date.now() }),
        (err) => usage.results.set(body.path, { error: err.code ?? 'failed', at: Date.now() }),
      )
      .finally(() => {
        usage.job = null;
        while (usage.results.size > 8) usage.results.delete(usage.results.keys().next().value);
      });
    return sendJson(req, res, 202, usageStatus(body.path));
  }

  async function handleLogs(req, res, params) {
    const opt = (k) => params.get(k) ?? undefined;
    const num = (k) => (params.has(k) ? Number(params.get(k)) : undefined);
    const request = validateQuery({
      op: 'logs',
      source: { kind: opt('source') ?? 'all', name: opt('name') },
      priority: num('priority'),
      since: opt('since'),
      search: opt('q'),
      limit: num('limit'),
      after: opt('after'),
      before: opt('before'),
    });
    if (!request) return sendJson(req, res, 400, { code: 'invalid' });
    try {
      return sendJson(req, res, 200, await query(request));
    } catch (err) {
      return sendQueryError(req, res, err);
    }
  }

  // Güvenlik özeti birkaç saniye sürebilir (süreçlerin soketleri, 7 günlük SSH kayıtları); kısa süre saklanır.
  let securityCache = null;
  async function handleSecurity(req, res, params) {
    if (securityCache && params.get('refresh') !== '1' && Date.now() - securityCache.at < 30_000) return sendJson(req, res, 200, securityCache.data);
    try {
      const data = { ...(await query({ op: 'security' }, 30_000)), at: Date.now() };
      securityCache = { data, at: Date.now() };
      return sendJson(req, res, 200, data);
    } catch (err) {
      return sendQueryError(req, res, err);
    }
  }

  // --- GitHub yedeği: durum dosyaları yedek servisinin kendi klasöründe, panel yalnızca okur ---
  const backupCache = { mtime: 0, status: null };
  async function backupStatus() {
    const file = path.join(config.backup.dir, 'status.json');
    try {
      const { mtimeMs } = await stat(file);
      if (mtimeMs !== backupCache.mtime) Object.assign(backupCache, { mtime: mtimeMs, status: JSON.parse(await readFile(file, 'utf8')) });
    } catch {
      Object.assign(backupCache, { mtime: 0, status: null });
    }
    return backupCache.status;
  }

  // Genel bakış uyarısı için kısa özet: açık mı, son yedek ne zaman, başarılı mı.
  async function backupSummary(system) {
    const g = system.settings?.githubBackup;
    if (!g?.enabled) return null;
    const s = await backupStatus();
    return { running: Boolean(s?.running), ok: s?.ok ?? null, error: s?.error ?? null, lastOk: s?.lastOk ?? null, finishedAt: s?.finishedAt ?? null, enabledAt: system.updated ?? null };
  }

  async function handleBackup(req, res) {
    const system = await readSystemStatus();
    const runs = await readFile(path.join(config.backup.dir, 'runs.json'), 'utf8').then((t) => JSON.parse(t), () => []);
    return sendJson(req, res, 200, {
      available: Boolean(system.platform?.githubBackup),
      git: Boolean(system.platform?.git),
      settings: system.settings?.githubBackup ?? null,
      status: await backupStatus(),
      runs: runs.slice(-20).reverse(),
    });
  }

  // Bekleyen güncellemelerin yapay zekâ özeti; aynı paket listesi için sonuç bellekte tutulur.
  let updateSummary = null;
  async function handleUpdateSummary(req, res) {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const system = await readSystemStatus();
    const packages = system.updates?.packages ?? [];
    if (!packages.length) return sendJson(req, res, 409, { code: 'no_updates' });
    const key = JSON.stringify(packages.map((p) => [p.name, p.to]));
    if (updateSummary?.key === key && updateSummary.language === effective.language) return sendJson(req, res, 200, updateSummary.result);
    const { models: installed } = await ollama.models();
    const names = installed.map((m) => m.name);
    const preferred = system.settings?.report?.model;
    const model = names.includes(preferred) ? preferred : names[0];
    if (!model) return sendJson(req, res, 409, { code: 'no_model' });
    try {
      const summary = await ollama.complete({ model, messages: updateSummaryMessages(packages, effective.language) });
      const result = { summary, model, count: packages.length, createdAt: Date.now() };
      updateSummary = { key, language: effective.language, result };
      return sendJson(req, res, 200, result);
    } catch {
      return sendJson(req, res, 502, { code: 'ollama' });
    }
  }

  async function handleChatSave(req, res) {
    const body = await readJsonBody(req, res, MAX_SAVE_BODY);
    if (!body) return;
    const saved = await chats.save(body.id ?? null, body);
    if (!saved) return sendJson(req, res, 400, { code: 'invalid' });
    return sendJson(req, res, 200, { id: saved.id, title: saved.title, updatedAt: saved.updatedAt });
  }

  async function handleChatDelete(req, res) {
    const body = await readJsonBody(req, res);
    if (!body) return;
    return sendJson(req, res, (await chats.remove(body.id)) ? 200 : 404, { ok: true });
  }

  async function latestReport() {
    const [last] = await listReports();
    if (!last) return null;
    try {
      return JSON.parse(await readFile(path.join(config.reports.dir, `${last.date}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  // Bellekteki bir modeli boşaltır (Ollama: keep_alive 0). Yalnızca o an yüklü bir model kabul edilir.
  async function handleOllamaUnload(req, res) {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (typeof body.model !== 'string' || !MODEL_NAME.test(body.model)) return sendJson(req, res, 400, { code: 'invalid' });
    const info = await ollama.info();
    if (!info.loaded?.some((m) => m.name === body.model)) return sendJson(req, res, 404, { code: 'not_loaded' });
    try {
      await ollama.unload(body.model);
      console.log(`Ollama modeli bellekten çıkarıldı: ${body.model}`);
      return sendJson(req, res, 200, { ok: true });
    } catch {
      return sendJson(req, res, 502, { code: 'ollama' });
    }
  }

  // Model indirme/silme/hız testi: model adı her istekte doğrulanır.
  async function handleOllamaModel(req, res, action) {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (action === 'cancel') return sendJson(req, res, 200, { cancelled: ollama.cancelPull() });
    if (typeof body.model !== 'string' || !MODEL_NAME.test(body.model)) return sendJson(req, res, 400, { code: 'invalid' });
    try {
      if (action === 'pull') {
        if (!ollama.startPull(body.model)) return sendJson(req, res, 409, { code: 'busy' });
        return sendJson(req, res, 202, { pull: ollama.pullStatus() });
      }
      if (action === 'delete') {
        await ollama.remove(body.model);
        console.log(`Ollama modeli silindi: ${body.model} (${clientIp(req)})`);
        return sendJson(req, res, 200, { ok: true });
      }
      return sendJson(req, res, 200, await ollama.bench(body.model));
    } catch (err) {
      if (err.status === 404) return sendJson(req, res, 404, { code: 'not_found' });
      return sendJson(req, res, 502, { code: 'ollama' });
    }
  }

  // Sohbet yanıtı satır satır JSON olarak akar; tarayıcı bağlantıyı kapatınca Ollama isteği de iptal edilir.
  async function handleOllamaChat(req, res) {
    const body = await readJsonBody(req, res, MAX_CHAT_BODY);
    if (!body) return;
    const chat = validateChat(body);
    if (!chat) return sendJson(req, res, 400, { code: 'invalid' });
    if (chat.tools && !(await terminalAvailable(config.terminal.execSocket))) return sendJson(req, res, 409, { code: 'exec_unavailable' });
    // Panelin anlık özeti her sohbetin başına sistem mesajı olarak eklenir; komut çalıştırma açıksa araç tanımı da verilir.
    const system = await readSystemStatus();
    const context = buildServerContext({ snapshot: sampler.current().snapshot, system, report: await latestReport(), language: effective.language, commands: chat.tools ? { user: system.settings?.terminal?.user ?? null, timeoutSeconds: config.terminal.commandTimeoutSeconds } : null });
    chat.messages = [{ role: 'system', content: context }, ...chat.messages];
    chat.numCtx = chat.tools ? 16384 : 8192;
    chat.tools = chat.tools ? [RUN_COMMAND_TOOL] : null;
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    let started = false;
    const write = (obj) => {
      if (!started) {
        started = true;
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
      }
      // Komut çağrıları panelde sınıflandırılır: yalnızca okuyan komutlar onaysız çalışabilir.
      if (obj.calls) obj = { calls: obj.calls.map((c) => ({ ...c, auto: classifyCommand(c.command)?.readOnly === true })) };
      res.write(`${JSON.stringify(obj)}\n`);
    };
    try {
      await ollama.chat(chat, { signal: controller.signal, write });
      if (!started) write({ done: true, stats: null });
      res.end();
    } catch (err) {
      if (controller.signal.aborted) return res.destroy();
      if (!started) return sendJson(req, res, err.status === 404 ? 404 : err.code === 'no_tools' ? 400 : 502, { code: err.status === 404 ? 'not_found' : err.code === 'no_tools' ? 'no_tools' : 'ollama' });
      write({ error: 'ollama' });
      res.end();
    }
  }

  // Yapay zekânın istediği bir komutu çalıştırır. Yalnızca okuyan komutlar onaysız; diğerleri için
  // tarayıcı kullanıcının "Çalıştır" demesinden sonra approved: true gönderir.
  async function handleAiExec(req, res) {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const cmd = classifyCommand(body.command);
    if (!cmd) return sendJson(req, res, 400, { code: 'invalid' });
    if (!cmd.readOnly && body.approved !== true) return sendJson(req, res, 403, { code: 'approval' });
    // sudo şifresi yalnızca onaylanmış ve basit adımlardan oluşan bir komut için kabul edilir; günlüğe yazılmaz.
    const password = body.sudoPassword;
    let steps = null;
    if (password !== undefined) {
      if (typeof password !== 'string' || !password || password.length > 256 || /[\r\n\0]/.test(password)) return sendJson(req, res, 400, { code: 'invalid' });
      steps = rootSteps(cmd.command);
      if (body.approved !== true || !steps) return sendJson(req, res, 400, { code: 'sudo_form' });
    }
    if (!(await terminalAvailable(config.terminal.execSocket))) return sendJson(req, res, 409, { code: 'exec_unavailable' });
    console.log(`Yapay zekâ komutu (${cmd.readOnly ? 'otomatik' : password ? 'onaylı, sudo' : 'onaylı'}, ${clientIp(req)}): ${cmd.command.slice(0, 300).replace(/\s+/g, ' ')}`);
    try {
      const run = (command, sudoPassword = null) =>
        runCommand({ socketPath: config.terminal.execSocket, command, timeoutSeconds: cmd.readOnly ? config.terminal.commandTimeoutSeconds : config.terminal.approvedTimeoutSeconds, sudoPassword });
      if (!steps) return sendJson(req, res, 200, await run(cmd.command));
      // Root adımları sırayla çalışır; biri başarısız olursa sonrakiler çalışmaz ("&&" gibi).
      const result = { code: 0, output: '', truncated: false, timedOut: false };
      for (const step of steps) {
        const line = `sudo ${step.map((w) => (/^[\w./:=@+,-]+$/.test(w) ? w : `'${w}'`)).join(' ')}`;
        const r = await run(line, password);
        result.output += `${steps.length > 1 ? `$ ${line}\n` : ''}${r.output}`;
        Object.assign(result, { code: r.code, truncated: result.truncated || r.truncated, timedOut: result.timedOut || r.timedOut });
        if (r.code !== 0) break;
      }
      return sendJson(req, res, 200, result);
    } catch {
      return sendJson(req, res, 502, { code: 'exec_failed' });
    }
  }

  async function readSystemStatus() {
    try {
      return { available: true, ...JSON.parse(await readFile(config.system.statusFile, 'utf8')) };
    } catch {
      return { available: false };
    }
  }

  // İstek dosyası önce geçici adla yazılıp taşınır; yardımcı yarım dosya görmez.
  // Yardımcı adları sıralayarak işler; aynı milisaniyedeki istekler sayaçla sırasını korur.
  // Geçici dosya kuyruk klasörünün içine yazılır: farklı bağlama noktaları arasında taşıma yapılamaz.
  let enqueued = 0;
  async function enqueue(request) {
    await mkdir(queueDir, { recursive: true });
    const name = `${Date.now()}-${String(++enqueued).padStart(8, '0')}-${randomUUID()}.json`;
    const tmp = path.join(queueDir, `.${name}.tmp`);
    await writeFile(tmp, JSON.stringify({ ...request, requestedAt: Date.now() }), { mode: 0o640 });
    await rename(tmp, path.join(queueDir, name));
  }

  async function readJsonBody(req, res, limit = MAX_BODY) {
    if (!sameOrigin(req)) {
      sendJson(req, res, 403, { code: 'origin' });
      return null;
    }
    if (!String(req.headers['content-type']).startsWith('application/json')) {
      sendJson(req, res, 415, { code: 'content_type' });
      return null;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, limit));
    } catch (err) {
      sendJson(req, res, err.status ?? 400, { code: 'bad_request' });
      return null;
    }
    // Yalnızca JSON nesnesi kabul edilir; 0, false, "" gibi değerler de yanıtsız kalmaz.
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(req, res, 400, { code: 'bad_request' });
      return null;
    }
    return body;
  }

  // DNS rebinding'e karşı: yalnızca sunucunun kendi adları ve allowedHosts kabul edilir.
  const allowedHosts = new Set(config.allowedHosts.map((h) => h.toLowerCase()));
  let knownHosts = null;
  let knownHostsAt = 0;
  function hostAllowed(req) {
    if (allowedHosts.has('*')) return true;
    const name = requestHostname(req);
    if (!name) return false;
    if (allowedHosts.has(name)) return true;
    if (!knownHosts || Date.now() - knownHostsAt > 30_000) {
      knownHosts = localHostnames();
      knownHostsAt = Date.now();
    }
    return knownHosts.has(name);
  }

  function clientIp(req) {
    const remote = req.socket.remoteAddress ?? '';
    if (config.trustProxy && isLoopback(remote)) {
      const real = req.headers['x-real-ip'];
      if (typeof real === 'string' && real.trim()) return real.trim();
      const forwarded = req.headers['x-forwarded-for'];
      const last = typeof forwarded === 'string' ? forwarded.split(',').map((s) => s.trim()).filter(Boolean).pop() : null;
      if (last) return last;
    }
    return remote;
  }

  const isSecure = (req) =>
    Boolean(config.tls.cert) ||
    (config.trustProxy && isLoopback(req.socket.remoteAddress ?? '') && req.headers['x-forwarded-proto'] === 'https');

  async function handleLogin(req, res) {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { username = '', password = '', remember = false } = body;
    const verifier = auth;
    const result = await verifier.login(username, password, clientIp(req));
    // Doğrulama sürerken şifre değiştiyse eski şifreyle oturum açılmaz.
    if (result.ok && verifier !== auth) return sendJson(req, res, 401, { code: 'bad_credentials' });
    if (result.status === 429) {
      return sendJson(req, res, 429, { code: 'locked', retryAfter: result.retryAfter }, { 'Retry-After': String(result.retryAfter) });
    }
    if (!result.ok) return sendJson(req, res, 401, { code: 'bad_credentials', attemptsLeft: result.attemptsLeft });
    const cookie = sessions.create(auth.username, { remember: remember === true, secure: isSecure(req) });
    return sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/healthz' && !hostAllowed(req)) {
      return send(req, res, 403, TEXT, `Bilinmeyen adres: ${requestHostname(req) ?? '?'}. Bu adla erişmek için config.json içindeki allowedHosts listesine ekleyin.\n`);
    }
    if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    if (req.method === 'POST') {
      if (pathname === '/login') return handleLogin(req, res);
      if (pathname === '/logout') {
        if (!sameOrigin(req)) return sendJson(req, res, 403, { code: 'origin' });
        return sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': sessions.destroy(req.headers.cookie, { secure: isSecure(req) }) });
      }
      // Ayar değiştiren istekler yalnızca tarayıcı oturumuyla yapılabilir (Basic Auth ile değil).
      if (!sessions.get(req.headers.cookie)) return sendJson(req, res, 401, { code: 'no_session' });
      if (pathname === '/api/settings') return handleSettings(req, res);
      if (pathname === '/api/password') return handlePassword(req, res);
      if (pathname === '/api/system') return handleSystem(req, res);
      if (pathname === '/api/actions') return handleAction(req, res);
      if (pathname === '/api/update-check') return handleUpdateCheck(req, res);
      if (pathname === '/api/ollama/unload') return handleOllamaUnload(req, res);
      if (pathname === '/api/ollama/pull') return handleOllamaModel(req, res, 'pull');
      if (pathname === '/api/ollama/pull/cancel') return handleOllamaModel(req, res, 'cancel');
      if (pathname === '/api/ollama/delete') return handleOllamaModel(req, res, 'delete');
      if (pathname === '/api/ollama/bench') return handleOllamaModel(req, res, 'bench');
      if (pathname === '/api/ollama/chat') return handleOllamaChat(req, res);
      if (pathname === '/api/ai/exec') return handleAiExec(req, res);
      if (pathname === '/api/chats/save') return handleChatSave(req, res);
      if (pathname === '/api/updates/summary') return handleUpdateSummary(req, res);
      if (pathname === '/api/speedtest') return handleSpeedtest(req, res);
      if (pathname === '/api/chats/delete') return handleChatDelete(req, res);
      if (pathname === '/api/disk-usage') return handleDiskUsage(req, res);
      if (pathname === '/api/uptime/save') return handleUptimeSave(req, res);
      if (pathname === '/api/uptime/check') return handleUptimeCheck(req, res);
      return send(req, res, 405, TEXT, 'Method not allowed\n', { Allow: 'GET, HEAD' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, TEXT, 'İzin verilmeyen yöntem\n', { Allow: 'GET, HEAD, POST' });

    if (pathname === '/healthz') return send(req, res, 200, TEXT, 'ok\n');
    if (pathname === '/api/lang') return sendJson(req, res, 200, { language: effective.language });

    const session = sessions.get(req.headers.cookie);
    const asset = assets.get(pathname);
    if (pathname === '/login' && session) return redirect(req, res, '/');
    if (asset?.public) return sendAsset(req, res, asset);

    let user = session?.user;
    // Hatırlanan oturum kullanıldıkça çerezin süresi yenilenir.
    if (session) {
      const renewed = sessions.renew(req.headers.cookie, { secure: isSecure(req) });
      if (renewed) res.setHeader('Set-Cookie', renewed);
    }
    if (!user && req.headers.authorization) {
      const result = await auth.check(req.headers.authorization, clientIp(req));
      if (result.status === 429) {
        return sendJson(req, res, 429, { code: 'locked', retryAfter: result.retryAfter }, { 'Retry-After': String(result.retryAfter) });
      }
      if (result.ok) user = auth.username;
    }
    if (!user) {
      // Sayfa istekleri giriş ekranına yönlenir; API istemcileri 401 alır.
      // WWW-Authenticate gönderilmez, böylece tarayıcı kendi şifre penceresini açmaz.
      if (!pathname.startsWith('/api/')) return redirect(req, res, '/login');
      return sendJson(req, res, 401, { code: 'no_session' });
    }

    if (pathname === '/api/stats') {
      const update = updates.status();
      return sendJson(req, res, 200, {
        user,
        settings: { language: effective.language, thresholds: effective.thresholds },
        update: update.available ? { latest: update.latest } : null,
        backup: await backupSummary(await readSystemStatus()),
        uptimeDown: uptime.down(),
        diskAlerts,
        ...sampler.current(),
      });
    }
    if (pathname === '/api/settings') {
      return sendJson(req, res, 200, { user, panel: publicSettings(effective), system: await readSystemStatus(), about: { ...ABOUT, update: updates.status() } });
    }
    if (pathname === '/api/reports') return sendJson(req, res, 200, { reports: await listReports() });
    const reportMatch = /^\/api\/reports\/(\d{4}-\d{2}-\d{2})$/.exec(pathname);
    if (reportMatch) {
      try {
        return send(req, res, 200, JSON_TYPE, await readFile(path.join(config.reports.dir, `${reportMatch[1]}.json`)));
      } catch {
        return sendJson(req, res, 404, { code: 'not_found' });
      }
    }
    if (pathname === '/api/ollama/models') return sendJson(req, res, 200, await ollama.models());
    if (pathname === '/api/ollama') return sendJson(req, res, 200, await ollama.info());
    if (pathname === '/api/chats') return sendJson(req, res, 200, { chats: await chats.list() });
    if (pathname === '/api/speedtest') return sendJson(req, res, 200, { ...(await speedtest.status()), scheduleHours: effective.speedtestHours });
    const chatMatch = /^\/api\/chats\/([0-9a-f-]{36})$/.exec(pathname);
    if (chatMatch) {
      const chat = await chats.get(chatMatch[1]);
      return chat ? sendJson(req, res, 200, chat) : sendJson(req, res, 404, { code: 'not_found' });
    }
    if (pathname === '/api/history') {
      const range = new URL(req.url, 'http://localhost').searchParams.get('range') ?? '1d';
      if (!Object.hasOwn(RANGES, range)) return sendJson(req, res, 400, { code: 'invalid' });
      return sendJson(req, res, 200, await history.query(range));
    }
    if (pathname === '/api/terminal') {
      return sendJson(req, res, 200, {
        available: await terminalAvailable(config.terminal.socket),
        execAvailable: await terminalAvailable(config.terminal.execSocket),
        user: (await readSystemStatus()).settings?.terminal?.user || null,
        idleMinutes: config.terminal.idleMinutes,
      });
    }
    if (pathname === '/api/disk-usage') {
      const p = new URL(req.url, 'http://localhost').searchParams.get('path');
      if (!validScanPath(p)) return sendJson(req, res, 400, { code: 'invalid' });
      return sendJson(req, res, 200, { available: await queryAvailable(config.query.socket), ...usageStatus(p) });
    }
    if (pathname === '/api/logs') return handleLogs(req, res, new URL(req.url, 'http://localhost').searchParams);
    if (pathname === '/api/logs/sources') {
      try {
        return sendJson(req, res, 200, await query({ op: 'log-sources' }));
      } catch (err) {
        return sendQueryError(req, res, err);
      }
    }
    if (pathname === '/api/backup') return handleBackup(req, res);
    if (pathname === '/api/uptime') return sendJson(req, res, 200, await uptime.status());
    if (pathname === '/api/disk-health') {
      const range = new URL(req.url, 'http://localhost').searchParams.get('range') ?? '30d';
      if (!Object.hasOwn(HEALTH_RANGES, range)) return sendJson(req, res, 400, { code: 'invalid' });
      return sendJson(req, res, 200, await diskHealth.query(range));
    }
    if (pathname === '/api/security') return handleSecurity(req, res, new URL(req.url, 'http://localhost').searchParams);
    if (pathname === '/api/services/available') {
      try {
        return sendJson(req, res, 200, { units: await listServiceUnits() });
      } catch {
        return sendJson(req, res, 500, { code: 'systemctl' });
      }
    }
    if (asset) return sendAsset(req, res, asset);
    return send(req, res, 404, TEXT, 'Not found\n');
  }

  function sendAsset(req, res, asset) {
    const body = asset.type.startsWith('text/html') ? Buffer.from(asset.body.toString('utf8').replace('<html lang="tr">', `<html lang="${effective.language}">`)) : asset.body;
    return send(req, res, 200, asset.type, body, ASSET_HEADERS[asset.headers]);
  }

  async function handleSettings(req, res) {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { errors, value } = validatePanelSettings(body);
    if (errors.length) return sendJson(req, res, 400, { code: 'invalid', fields: errors });
    const previous = effective;
    await settingsStore.update(value);
    await applySettings(previous);
    return sendJson(req, res, 200, { panel: publicSettings(effective) });
  }

  async function handlePassword(req, res) {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { current = '', next = '' } = body;
    if (typeof next !== 'string' || next.length < 8 || next.length > 200) return sendJson(req, res, 400, { code: 'weak_password' });
    // Mevcut şifre giriş ekranıyla aynı kilitleme kurallarıyla doğrulanır.
    const result = await auth.login(auth.username, String(current), clientIp(req));
    if (result.status === 429) return sendJson(req, res, 429, { code: 'locked', retryAfter: result.retryAfter });
    if (!result.ok) return sendJson(req, res, 401, { code: 'bad_password', attemptsLeft: result.attemptsLeft });
    const previous = effective;
    await settingsStore.setPasswordHash(await hashPassword(next), config.auth.passwordHash);
    await applySettings(previous);
    auth = createAuth(effective.auth);
    sessions.destroyOthers(req.headers.cookie, authKeyOf(effective.auth.username, effective.auth.passwordHash));
    console.log('Panel şifresi arayüzden değiştirildi; diğer oturumlar kapatıldı.');
    return sendJson(req, res, 200, { ok: true });
  }

  async function handleSystem(req, res) {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { errors, request } = validateRequest({ type: 'settings', settings: body });
    if (errors) return sendJson(req, res, 400, { code: 'invalid', fields: errors });
    await enqueue(request);
    return sendJson(req, res, 202, { queued: true });
  }

  // "Şimdi denetle": son bir dakika içinde başarıyla denetlendiyse GitHub'a tekrar sorulmaz.
  async function handleUpdateCheck(req, res) {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const current = updates.status();
    if (current.checkedAt && !current.error && Date.now() - current.checkedAt < 60_000) return sendJson(req, res, 200, current);
    return sendJson(req, res, 200, await updates.check());
  }

  async function handleAction(req, res) {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { errors, request } = validateRequest({ type: 'action', action: body.action });
    if (errors) return sendJson(req, res, 400, { code: 'invalid' });
    await enqueue(request);
    console.log(`Arayüzden işlem istendi: ${request.action} (${clientIp(req)})`);
    return sendJson(req, res, 202, { queued: true });
  }

  const handler = (req, res) => {
    handle(req, res).catch((err) => {
      console.error('İstek işlenemedi:', err);
      if (!res.headersSent) send(req, res, 500, TEXT, 'Sunucu hatası\n');
      else res.destroy();
    });
  };

  let server;
  if (config.tls.cert) {
    try {
      server = https.createServer({ cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) }, handler);
    } catch (err) {
      console.error(`TLS sertifikası okunamadı: ${err.message}`);
      process.exit(1);
    }
  } else {
    server = http.createServer(handler);
  }
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  // Terminal: yalnızca tarayıcı oturumu (çerez) ve aynı kaynaktan gelen WebSocket isteği kabul edilir.
  // Origin denetimi, başka bir sitenin kullanıcının tarayıcısı üzerinden terminale bağlanmasını engeller.
  const terminals = createTerminals({
    socketPath: config.terminal.socket,
    idleMinutes: config.terminal.idleMinutes,
  });
  server.on('upgrade', (req, socket) => {
    const reject = (status, text) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    socket.on('error', () => socket.destroy());
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/api/terminal') return reject(404, 'Not Found');
    if (!hostAllowed(req) || !sameOrigin(req)) return reject(403, 'Forbidden');
    const cookie = req.headers.cookie;
    if (!sessions.get(cookie)) return reject(401, 'Unauthorized');
    terminalAvailable(config.terminal.socket).then((available) => {
      if (!available) return reject(503, 'Service Unavailable');
      const ws = upgrade(req, socket);
      if (!ws) return reject(400, 'Bad Request');
      terminals.attach(ws, { ip: clientIp(req), sessionAlive: () => Boolean(sessions.get(cookie)) });
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} başka bir uygulama tarafından kullanılıyor.`);
    else if (err.code === 'EACCES') console.error(`Port ${config.port} için yetki yok (1024 altındaki portlar ek yetki ister).`);
    else console.error(err.message);
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    const scheme = config.tls.cert ? 'https' : 'http';
    console.log(`Node Stats paneli ${scheme}://${config.host}:${config.port}/ adresinde çalışıyor (yapılandırma: ${configPath})`);
    if (!config.tls.cert && !isLoopback(config.host)) {
      console.warn('Uyarı: TLS kapalı, şifre ağda düz metin olarak gider. HTTPS açın ya da host: "127.0.0.1" ile nginx veya SSH tüneli arkasına alın.');
    }
  });
  sampler.start();
  updates.start();

  const shutdown = () => {
    sampler.stop();
    updates.stop();
    terminals.closeAll();
    history.flush();
    sessions.flush();
    uptime.stop();
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main();
