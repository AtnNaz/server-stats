#!/usr/bin/env node
// Günlük rapor: son 24 saatin günlük kayıtlarını özetler, yerel Ollama modeline yorumlatır ve
// /var/lib/serverhealth/reports/YYYY-MM-DD.json dosyasına yazar. Root olarak, serverhealth-report
// servisiyle çalışır; servis yalnızca bu makinedeki Ollama'ya bağlanabilir.
import { execFile } from 'node:child_process';
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeJournal, askOllama } from '../src/report.js';
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

export async function buildReport({ entriesText, failedText, status, smart, model, url, language, ask = askOllama, now = Date.now }) {
  const started = now();
  const facts = { ...analyzeJournal(parseJournalJson(entriesText)), failedUnits: parseFailedUnits(failedText), ...extraFacts(status, smart) };
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
  return { createdAt: now(), durationMs: now() - started, model: model || null, language, facts, ai, aiError };
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

  const [entriesText, failedText, status, smart] = await Promise.all([
    run('journalctl', ['--since=-24h', '-o', 'json', '--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER', '-n', String(MAX_LINES), '--no-pager', '-q'], 256 * 1024 * 1024),
    run('systemctl', ['--failed', '--plain', '--no-legend', '--no-pager']),
    readJson(STATUS_FILE),
    readJson(config.smart.file),
  ]);
  const report = await buildReport({ entriesText, failedText, status, smart, model, url: config.ollama.url, language });
  const date = localDate(report.createdAt);

  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${date}.json`);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ date, ...report })}\n`, { mode: 0o640 });
  await rename(tmp, file);

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
