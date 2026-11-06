#!/usr/bin/env node
// Günlük rapor: son 24 saatin günlük kayıtlarını özetler, yerel Ollama modeline yorumlatır ve
// /var/lib/serverhealth/reports/YYYY-MM-DD.json dosyasına yazar. Root olarak, serverhealth-report
// servisiyle çalışır; servis yalnızca bu makinedeki Ollama'ya bağlanabilir.
import { execFile } from 'node:child_process';
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeJournal, askOllama, parseBoots } from '../src/report.js';
import { loadConfig } from '../src/config.js';

const STATE_FILE = '/var/lib/serverhealth/system-settings.json';
const STATUS_FILE = '/var/lib/serverhealth/system.json';
const PANEL_SETTINGS = '/var/lib/serverhealth-panel/settings.json';
const KEEP_DAYS = 30;
const MAX_LINES = 200_000;

function run(cmd, args, maxBuffer = 4 * 1024 * 1024) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer, timeout: 120_000, env: { ...process.env, LC_ALL: 'C', SYSTEMD_PAGER: '' } }, (err, stdout) => resolve(err && !stdout ? '' : stdout));
  });
}

const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null);

export function parseJournalJson(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* yarım satır */
    }
  }
  return entries;
}

export function parseFailedUnits(text) {
  return text
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u) => /^[\w@.:\\-]+\.(service|socket|mount|timer|target|path)$/.test(u ?? ''));
}

// Panelin bildiği ek durumlar: bekleyen güncellemeler ve SMART uyarısı veren diskler.
export function extraFacts(status, smart) {
  const disks = (smart?.devices ?? smart?.entries ?? []).filter((d) => d?.data?.smart_status?.passed === false);
  return {
    updates: status?.updates ? { pending: status.updates.pending ?? null, security: status.updates.security ?? null, rebootRequired: status.updates.rebootRequired ?? null } : null,
    smartFailing: disks.map((d) => d.data.model_name ?? d.name ?? '?').slice(0, 10),
  };
}

// SMART'ta bozulmayı gösteren sayaçlar: yedek alana taşınan, bekleyen ve düzeltilemeyen sektörler (SATA),
// ortam hataları (NVMe).
const ATA_COUNTERS = { 5: 'reallocated', 187: 'reportedUncorrect', 197: 'pending', 198: 'offlineUncorrectable' };
export function smartCounters(data) {
  const out = {};
  for (const a of data?.ata_smart_attributes?.table ?? []) {
    if (ATA_COUNTERS[a.id] && Number.isFinite(a.raw?.value)) out[ATA_COUNTERS[a.id]] = a.raw.value;
  }
  const nvme = data?.nvme_smart_health_information_log;
  if (nvme && Number.isFinite(nvme.media_errors)) out.mediaErrors = nvme.media_errors;
  return out;
}

// lsblk ağacından her fiziksel diskin bağlama noktaları (bölümler ve LVM dahil).
function diskMounts(lsblk) {
  const map = new Map();
  const collect = (node, acc) => {
    for (const m of node.mountpoints ?? []) if (m && !m.startsWith('[')) acc.push(m);
    for (const c of node.children ?? []) collect(c, acc);
    return acc;
  };
  for (const d of lsblk?.blockdevices ?? []) if (d.type === 'disk') map.set(d.name, collect(d, []));
  return map;
}

const SYSTEM_MOUNTS = ['/', '/boot', '/boot/efi', '/efi', '/usr', '/var'];

// Disklerin rolü (sistem / veri / kullanılmıyor), SMART sayaçları ve günler içindeki değişimi.
// history: { [seri no]: [{ date, ...sayaçlar }] } — raporla birlikte saklanır.
export function diskFacts(smart, lsblk, history = {}, date) {
  const mounts = diskMounts(lsblk);
  const nextHistory = { ...history };
  const disks = [];
  for (const d of smart?.devices ?? []) {
    if (!d?.data) continue;
    const base = String(d.name ?? '').replace('/dev/', '');
    const block = mounts.has(base) ? base : [...mounts.keys()].find((n) => n.startsWith(`${base}n`)) ?? base;
    const points = mounts.get(block) ?? [];
    const counters = smartCounters(d.data);
    const serial = String(d.data.serial_number ?? block);
    const past = (history[serial] ?? []).filter((h) => h.date < date);
    nextHistory[serial] = [...past, { date, ...counters }].slice(-90);
    const changes = {};
    const first = past[0];
    // Sayaçların en son değiştiği gün (yoksa ilk kayıt): "o günden beri sabit".
    let stableSince = first?.date ?? null;
    for (let i = 1; i <= past.length; i++) {
      const cur = i < past.length ? past[i] : counters;
      if (Object.keys(counters).some((k) => cur[k] !== past[i - 1][k])) stableSince = i < past.length ? past[i].date : date;
    }
    for (const [k, v] of Object.entries(counters)) {
      const old7 = [...past].reverse().find((h) => h.date <= shiftDate(date, -7)) ?? first;
      if (old7 && Number.isFinite(old7[k]) && v !== old7[k]) changes[k] = { from: old7[k], to: v };
    }
    const bad = Object.values(counters).some((v) => v > 0);
    const role = points.some((m) => SYSTEM_MOUNTS.includes(m)) ? 'system' : points.length ? 'data' : 'unused';
    const trend = !bad ? null : !first ? 'new' : Object.keys(changes).length ? 'increasing' : 'stable';
    disks.push({
      device: block,
      model: d.data.model_name ?? null,
      role,
      mounts: points.slice(0, 6),
      smartPassed: d.data.smart_status?.passed ?? null,
      counters,
      // Eğilim: geçmiş yoksa "new"; son 7 günde değişim varsa "increasing"; yoksa ilk kayıttan beri sabit.
      trend,
      stableSince: bad && first ? stableSince : null,
      changes,
      assessment: assessDisk({ smartPassed: d.data.smart_status?.passed, bad, role, trend }),
    });
  }
  return { disks, history: nextHistory };
}

// Diskin önemi kodla belirlenir; model bunu değiştirmez (küçük modeller ham sayılardan abartılı sonuç çıkarır).
export function assessDisk({ smartPassed, bad, role, trend }) {
  if (smartPassed === false) return { level: 'critical', reason: 'smart_failed' };
  if (!bad) return null;
  if (role === 'system') return { level: 'critical', reason: 'system_disk_sectors' };
  if (trend === 'increasing') return { level: 'critical', reason: 'sectors_increasing' };
  return { level: 'warning', reason: trend === 'stable' ? 'data_disk_sectors_stable' : 'data_disk_sectors_first_seen' };
}

function shiftDate(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function buildReport({ entriesText, failedText, status, smart, lsblk = null, bootsText = '', smartHistory = {}, date = null, model, url, language, ask = askOllama, now = Date.now }) {
  const started = now();
  const boots = parseBoots(bootsText, started);
  const { disks, history } = diskFacts(smart, lsblk, smartHistory, date ?? localDate(started));
  const facts = { ...analyzeJournal(parseJournalJson(entriesText), { boots }), failedUnits: parseFailedUnits(failedText), ...extraFacts(status, smart), disks };
  let ai = null;
  let aiError = null;
  if (!model) aiError = 'model_missing';
  else {
    try {
      ai = await ask({ url, model, facts, language });
    } catch (err) {
      aiError = err.name === 'TimeoutError' ? 'timeout' : /^(ollama_|model_missing|invalid_ai_output)/.test(err.message) ? err.message : 'ollama_unreachable';
    }
  }
  return { createdAt: now(), durationMs: now() - started, model: model || null, language, facts, ai, aiError, smartHistory: history };
}

// Sunucunun yerel tarihi (YYYY-MM-DD); aynı gün tekrar oluşturulursa rapor güncellenir.
export const localDate = (ms) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const config = loadConfig(opt('--config', '/etc/serverhealth/config.json'));
  const outDir = config.reports.dir;
  const state = (await readJson(STATE_FILE)) ?? {};
  const model = opt('--model', state.report?.model ?? '');
  const language = (await readJson(PANEL_SETTINGS))?.language ?? config.language ?? 'tr';

  const historyFile = path.join(outDir, 'smart-history.json');
  const [entriesText, failedText, status, smart, lsblkText, bootsText, smartHistory] = await Promise.all([
    run('journalctl', ['--since=-24h', '-o', 'json', '--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER', '-n', String(MAX_LINES), '--no-pager', '-q'], 256 * 1024 * 1024),
    run('systemctl', ['--failed', '--plain', '--no-legend', '--no-pager']),
    readJson(STATUS_FILE),
    readJson(config.smart.file),
    run('lsblk', ['-J', '-o', 'NAME,TYPE,MOUNTPOINTS']),
    run('journalctl', ['--list-boots', '-o', 'json', '--no-pager']),
    readJson(historyFile),
  ]);
  let lsblk = null;
  try {
    lsblk = JSON.parse(lsblkText);
  } catch {
    /* lsblk yoksa diskin rolü bilinmez */
  }
  const { smartHistory: nextHistory, ...report } = await buildReport({ entriesText, failedText, status, smart, lsblk, bootsText, smartHistory: smartHistory ?? {}, model, url: config.ollama.url, language });
  const date = localDate(report.createdAt);

  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${date}.json`);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ date, ...report })}\n`, { mode: 0o640 });
  await rename(tmp, file);
  // SMART sayaçlarının günlük geçmişi: bir sonraki rapor değişimi buna göre söyler.
  await writeFile(`${historyFile}.tmp`, `${JSON.stringify(nextHistory)}\n`, { mode: 0o640 });
  await rename(`${historyFile}.tmp`, historyFile);

  // 30 günden eski raporlar silinir.
  const cutoff = localDate(Date.now() - KEEP_DAYS * 86_400_000);
  for (const name of await readdir(outDir)) {
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < cutoff) await unlink(path.join(outDir, name)).catch(() => {});
  }
  console.log(`Rapor yazıldı: ${file} (${report.facts.totals.lines} satır, model: ${report.model ?? '-'}${report.aiError ? `, model hatası: ${report.aiError}` : ''})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`serverhealth-report: ${err.message}`);
    process.exit(1);
  });
}
