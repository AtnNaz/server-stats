#!/usr/bin/env node
// Günlük rapor: son 24 saatin günlük kayıtlarını özetler, yerel Ollama modeline yorumlatır ve
// /var/lib/serverhealth/reports/YYYY-MM-DD.json dosyasına yazar. Root olarak, serverhealth-report
// servisiyle çalışır; servis yalnızca bu makinedeki Ollama'ya bağlanabilir.
import { execFile } from 'node:child_process';
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeJournal, askOllama, parseBoots, settleAi } from '../src/report.js';
import { loadConfig } from '../src/config.js';
import { smartCounters, acknowledged, ACK_COUNTERS } from '../src/disk-ack.js';

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

export { smartCounters };

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
export function diskFacts(smart, lsblk, history = {}, date, acks = []) {
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
    const known = bad && d.data.serial_number != null && acknowledged(acks, String(d.data.serial_number), counters);
    disks.push({
      name: base,
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
      ...(known ? { acknowledged: true } : {}),
      assessment: assessDisk({ smartPassed: d.data.smart_status?.passed, bad, role, trend, known }),
    });
  }
  return { disks, history: nextHistory };
}

// Diskin önemi kodla belirlenir; model bunu değiştirmez (küçük modeller ham sayılardan abartılı sonuç çıkarır).
export function assessDisk({ smartPassed, bad, role, trend, known = false }) {
  if (smartPassed === false) return { level: 'critical', reason: 'smart_failed' };
  if (!bad) return null;
  if (known) return { level: 'info', reason: 'acknowledged' };
  if (role === 'system') return { level: 'critical', reason: 'system_disk_sectors' };
  if (trend === 'increasing') return { level: 'critical', reason: 'sectors_increasing' };
  return { level: 'warning', reason: trend === 'stable' ? 'data_disk_sectors_stable' : 'data_disk_sectors_first_seen' };
}

function shiftDate(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const devicePattern = (names) => (names.length ? new RegExp(`/dev/(?:${names.map((n) => String(n).replace(/[^A-Za-z0-9]/g, '')).join('|')})(?![A-Za-z0-9])`) : null);
const SMART_UNIT = /^smart(?:d|montools)(?:\.service)?$/;

export function quietAcknowledged(entries, disks) {
  const pattern = devicePattern(disks.filter((d) => d.acknowledged).map((d) => d.name).filter(Boolean));
  if (!pattern) return entries;
  return entries.filter((e) => !(/^smartd$/.test(String(e.SYSLOG_IDENTIFIER ?? '')) || SMART_UNIT.test(String(e._SYSTEMD_UNIT ?? ''))) || !pattern.test(Array.isArray(e.MESSAGE) ? Buffer.from(e.MESSAGE.filter(Number.isInteger)).toString('utf8') : String(e.MESSAGE ?? '')));
}

export function reassessFacts(facts, acks = []) {
  const disks = (facts?.disks ?? []).map((d) => {
    if (d.acknowledged || d.smartPassed === false) return d;
    const ack = acks.find((a) => a.model && a.model === d.model);
    const bad = Object.values(d.counters ?? {}).some((v) => v > 0);
    if (!ack || !bad || !ACK_COUNTERS.every((k) => (d.counters?.[k] ?? 0) <= (ack.counters?.[k] ?? 0))) return d;
    return { ...d, acknowledged: true, assessment: { level: 'info', reason: 'acknowledged' } };
  });
  const pattern = devicePattern(disks.filter((d) => d.acknowledged).map((d) => d.device).filter(Boolean));
  const groups = pattern ? (facts?.groups ?? []).filter((g) => !(SMART_UNIT.test(String(g.unit ?? '')) && pattern.test(String(g.sample ?? '')))) : facts?.groups;
  return { ...facts, disks, ...(groups ? { groups } : {}) };
}

export async function buildReport({ entriesText, failedText, status, smart, lsblk = null, bootsText = '', smartHistory = {}, diskAcks = [], date = null, model, url, language, ask = askOllama, now = Date.now }) {
  const started = now();
  const boots = parseBoots(bootsText, started);
  const { disks, history } = diskFacts(smart, lsblk, smartHistory, date ?? localDate(started), diskAcks);
  const entries = quietAcknowledged(parseJournalJson(entriesText), disks);
  const facts = { ...analyzeJournal(entries, { boots }), failedUnits: parseFailedUnits(failedText), ...extraFacts(status, smart), disks: disks.map(({ name, ...d }) => d) };
  let ai = null;
  let aiError = null;
  if (!model) aiError = 'model_missing';
  else {
    try {
      ai = settleAi(await ask({ url, model, facts, language }), facts);
    } catch (err) {
      aiError = err.name === 'TimeoutError' ? 'timeout' : /^(ollama_|model_missing|invalid_ai_output)/.test(err.message) ? err.message : 'ollama_unreachable';
    }
  }
  return { createdAt: now(), durationMs: now() - started, model: model || null, language, facts, ai, aiError, smartHistory: history };
}

// Sunucunun yerel tarihi (YYYY-MM-DD); aynı gün tekrar oluşturulursa rapor güncellenir.
export const localDate = (ms) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

export async function reassessReport(report, { acks = [], model, url, language, ask = askOllama, now = Date.now }) {
  const facts = reassessFacts(report.facts ?? {}, acks);
  let { ai = null, aiError = null } = report;
  let used = report.model ?? null;
  if (model) {
    try {
      ai = await ask({ url, model, facts, language: report.language ?? language });
      aiError = null;
      used = model;
    } catch (err) {
      console.warn(`${report.date}: model yanıt vermedi (${err.message}), eski değerlendirme düzenleniyor`);
    }
  }
  return { ...report, model: used, facts, ai: settleAi(ai, facts), aiError, reassessedAt: now() };
}

async function reassessAll({ outDir, acks, model, url, language }) {
  const keep = path.join(outDir, 'original');
  await mkdir(keep, { recursive: true, mode: 0o750 });
  const names = (await readdir(outDir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  for (const name of names) {
    const file = path.join(outDir, name);
    const text = await readFile(file, 'utf8');
    await writeFile(path.join(keep, name), text, { flag: 'wx', mode: 0o640 }).catch((err) => {
      if (err.code !== 'EEXIST') throw err;
    });
    const before = JSON.parse(text);
    const after = await reassessReport({ date: name.slice(0, 10), ...before }, { acks, model, url, language });
    await writeFile(`${file}.tmp`, `${JSON.stringify(after)}\n`, { mode: 0o640 });
    await rename(`${file}.tmp`, file);
    console.log(`${name}: ${before.ai?.status ?? '-'} -> ${after.ai?.status ?? '-'} (${after.model ?? '-'})`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const config = loadConfig(opt('--config', '/etc/serverhealth/config.json'));
  const outDir = config.reports.dir;
  const state = (await readJson(STATE_FILE)) ?? {};
  const model = opt('--model', state.report?.model ?? '');
  const language = (await readJson(PANEL_SETTINGS))?.language ?? config.language ?? 'tr';
  const acks = Array.isArray(state.diskAcks) ? state.diskAcks : [];
  if (argv.includes('--reassess')) return reassessAll({ outDir, acks, model: argv.includes('--no-ai') ? '' : model, url: config.ollama.url, language });

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
  const { smartHistory: nextHistory, ...report } = await buildReport({ entriesText, failedText, status, smart, lsblk, bootsText, smartHistory: smartHistory ?? {}, diskAcks: acks, model, url: config.ollama.url, language });
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
