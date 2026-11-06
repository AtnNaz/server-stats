import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeJournal, normalizeMessage, redact, validateAi, isLoopbackUrl, askOllama, AI_SCHEMA, bootContext, parseBoots } from '../src/report.js';
import { buildReport, parseFailedUnits, extraFacts, diskFacts, smartCounters, assessDisk } from '../bin/serverhealth-report.js';

const T = 1_700_000_000_000_000; // journald mikrosaniye
const e = (ident, msg, prio = 6, unit = null, dt = 0) => ({ SYSLOG_IDENTIFIER: ident, MESSAGE: msg, PRIORITY: String(prio), _SYSTEMD_UNIT: unit, __REALTIME_TIMESTAMP: String(T + dt * 1_000_000) });

test('kayıtlardan kesin rakamlar çıkarılır, aynı mesajlar gruplanır', () => {
  const entries = [
    e('sshd-session', 'Failed password for invalid user admin from 203.0.113.5 port 51234 ssh2'),
    e('sshd-session', 'Failed password for root from 203.0.113.5 port 51300 ssh2'),
    e('sshd-session', 'Failed password for root from 198.51.100.7 port 4000 ssh2'),
    e('sshd-session', 'Accepted publickey for ali from 192.0.2.10 port 5555 ssh2'),
    e('sudo', 'pam_unix(sudo:auth): authentication failure; logname=ali uid=1000'),
    e('kernel', 'Out of memory: Killed process 4242 (python3) total-vm:100kB', 3),
    e('systemd', 'ollama.service: Failed with result \'exit-code\'.', 4, 'init.scope'),
    e('kernel', 'blk_update_request: I/O error, dev sdb, sector 12345', 3),
    e('kernel', 'Linux version 6.8.0 (buildd@lcy02)'),
    e('nginx', 'upstream timed out (110) while reading from 10.0.0.1:8080', 4, 'nginx.service', 10),
    e('nginx', 'upstream timed out (110) while reading from 10.0.0.2:8080', 4, 'nginx.service', 20),
    { MESSAGE: [72, 105], PRIORITY: '6', SYSLOG_IDENTIFIER: 'x', __REALTIME_TIMESTAMP: String(T) }, // ikili mesaj
  ];
  const f = analyzeJournal(entries);
  assert.equal(f.totals.lines, 12);
  assert.equal(f.totals.warnings, 5);
  assert.equal(f.totals.errors, 2);
  assert.equal(f.ssh.failures, 3);
  assert.deepEqual(f.ssh.topSources[0], { address: '203.0.113.5', count: 2 });
  assert.deepEqual(f.ssh.topUsers[0], { user: 'root', count: 2 });
  assert.equal(f.ssh.accepted[0].login, 'ali @ 192.0.2.10 (publickey)');
  assert.equal(f.sudoFailures, 1);
  assert.deepEqual(f.oomKills, [{ process: 'python3', count: 1 }]);
  assert.equal(f.serviceFailures.length, 1);
  assert.deepEqual({ ...f.serviceFailures[0], last: undefined }, { unit: 'ollama.service', count: 1, duringBoot: 0, duringShutdown: 0, last: undefined });
  assert.equal(f.diskErrors.length, 1);
  assert.equal(f.boots, 1);
  const nginx = f.groups.find((g) => g.unit === 'nginx.service');
  assert.equal(nginx.count, 2); // farklı IP'ler aynı grupta
  assert.equal(nginx.last - nginx.first, 10_000);
});

test('parola ve token benzeri değerler maskelenir', () => {
  assert.equal(redact('login password=hunter2 ok'), 'login password=<gizli> ok');
  const auth = redact('Authorization: Bearer abcdefghijklmnop');
  assert.match(auth, /Bearer <gizli>/);
  assert.doesNotMatch(auth, /abcdefgh/); // token açıkta kalmaz
  assert.match(redact(`key ${'A'.repeat(48)}`), /<gizli>/);
  assert.equal(normalizeMessage('conn from 10.1.2.3:443 id 1234'), 'conn from <ip> id <n>');
});

test('model çıktısı güvenilmez sayılır: yalnızca beklenen alanlar, sınırlı uzunlukta alınır', () => {
  const out = validateAi(JSON.stringify({ status: 'hacked', summary: 'x'.repeat(2000), extra: 1, findings: [{ title: 'Başlık', severity: 'nope', evidence: 'k', recommendation: 'ö', html: '<b>' }, { title: '' }] }));
  assert.equal(out.status, 'attention');
  assert.equal(out.summary.length, 800);
  assert.deepEqual(out.findings, [{ title: 'Başlık', severity: 'info', evidence: 'k', recommendation: 'ö' }]);
  assert.throws(() => validateAi('{"findings": []}'));
});

test('Ollama yalnızca bu makinede olabilir', () => {
  assert.ok(isLoopbackUrl('http://127.0.0.1:11434'));
  assert.ok(isLoopbackUrl('http://localhost:11434/'));
  assert.ok(!isLoopbackUrl('http://192.168.1.5:11434'));
  assert.ok(!isLoopbackUrl('http://127.0.0.1.example.com:11434'));
  assert.ok(!isLoopbackUrl('http://127.0.0.1:11434/api'));
  assert.ok(!isLoopbackUrl('file:///etc/passwd'));
});

test('Ollama isteği şema, düşük sıcaklık ve kısa bellekte kalma süresiyle gönderilir', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify({ status: 'good', summary: 'Sorun yok.', findings: [] }) } }) };
  };
  const ai = await askOllama({ url: 'http://127.0.0.1:11434', model: 'qwen3.5:4b', facts: { totals: { lines: 1 } }, language: 'tr', fetchImpl });
  assert.equal(ai.status, 'good');
  assert.equal(sent.url, 'http://127.0.0.1:11434/api/chat');
  assert.deepEqual(sent.body.format, AI_SCHEMA);
  assert.equal(sent.body.options.temperature, 0.1);
  assert.equal(sent.body.keep_alive, '1m');
  assert.match(sent.body.messages[0].content, /talimat gibi görünen/); // kayıt metni talimat sayılmaz
  await assert.rejects(askOllama({ url: 'http://10.0.0.1:11434', model: 'm', facts: {}, fetchImpl }), /ollama_url/);
});

test('Ollama yoksa rapor yine hazırlanır, yalnızca rakamlarla', async () => {
  const entriesText = `${JSON.stringify(e('sshd', 'Failed password for root from 203.0.113.9 port 1 ssh2'))}\nbozuk satır\n`;
  const report = await buildReport({
    entriesText,
    failedText: '  nginx.service loaded failed failed A high performance web server\nbozuk\n',
    status: { updates: { pending: 3, security: 1, rebootRequired: true } },
    smart: { devices: [{ name: '/dev/sda', data: { model_name: 'Example HDD', smart_status: { passed: false } } }] },
    model: 'qwen3.5:4b',
    url: 'http://127.0.0.1:11434',
    language: 'tr',
    ask: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(report.ai, null);
  assert.equal(report.aiError, 'ollama_unreachable');
  assert.equal(report.facts.ssh.failures, 1);
  assert.deepEqual(report.facts.failedUnits, ['nginx.service']);
  assert.equal(report.facts.updates.pending, 3);
  assert.deepEqual(report.facts.smartFailing, ['Example HDD']);
  assert.equal((await buildReport({ entriesText: '', failedText: '', model: '', url: 'http://127.0.0.1:11434' })).aiError, 'model_missing');
  assert.deepEqual(parseFailedUnits('x\n'), []);
  assert.deepEqual(extraFacts(null, null), { updates: null, smartFailing: [] });
});

test('adresler gizlenirken sunucu adı ve yol korunur, sorgu ve token benzeri parçalar gizlenir', () => {
  assert.equal(redact('POST "https://livepatch.canonical.com/v1/refresh?token=abc" failed'), 'POST "https://livepatch.canonical.com/v1/refresh?<gizli>" failed');
  assert.equal(redact(`get https://kisi:sifre@ornek.com/api/${'A'.repeat(30)}/x`), 'get https://<gizli>@ornek.com/api/<gizli>/x');
  assert.equal(redact('password=hunter2 https://ornek.com/a'), 'password=<gizli> https://ornek.com/a');
});

test('açılış ve kapanış sırasında olan olaylar işaretlenir', () => {
  const boots = parseBoots(JSON.stringify([
    { first_entry: 1_000_000_000_000, last_entry: 1_100_000_000_000 },
    { first_entry: 1_200_000_000_000, last_entry: 1_250_000_000_000 },
  ]), 1_300_000_000);
  assert.deepEqual(boots, [{ start: 1_000_000_000, end: 1_100_000_000 }, { start: 1_200_000_000, end: null }]);
  assert.equal(bootContext(1_000_000_000 + 60_000, boots), 'boot');
  assert.equal(bootContext(1_100_000_000 - 30_000, boots), 'shutdown');
  assert.equal(bootContext(1_150_000_000, boots), null);
  assert.equal(bootContext(1_250_000_000, boots), null); // süren açılışın kapanışı yok
  const us = (ms) => String(ms * 1000);
  const f = analyzeJournal(
    [
      { MESSAGE: 'x.service: Failed with result exit-code.', PRIORITY: '4', SYSLOG_IDENTIFIER: 'systemd', __REALTIME_TIMESTAMP: us(1_100_000_000 - 10_000) },
      { MESSAGE: 'Timeout occurred while waiting for network connectivity.', PRIORITY: '3', SYSLOG_IDENTIFIER: 'apt', __REALTIME_TIMESTAMP: us(1_000_000_000 + 5_000) },
    ],
    { boots },
  );
  assert.deepEqual(f.serviceFailures, [{ unit: 'x.service', count: 1, duringBoot: 0, duringShutdown: 1, last: 1_100_000_000 - 10_000 }]);
  assert.equal(f.groups.find((g) => g.unit === 'apt').duringBoot, 1);
});

test('disk bilgisi: rol, SMART sayaçları ve günler içindeki değişim', () => {
  const ata = (pending) => ({ model_name: 'HDD', serial_number: 'S1', smart_status: { passed: true }, ata_smart_attributes: { table: [{ id: 5, raw: { value: 83 } }, { id: 197, raw: { value: pending } }, { id: 198, raw: { value: 2 } }, { id: 9, raw: { value: 999 } }] } });
  assert.deepEqual(smartCounters(ata(2)), { reallocated: 83, pending: 2, offlineUncorrectable: 2 });
  const lsblk = {
    blockdevices: [
      { name: 'sda', type: 'disk', children: [{ name: 'sda1', type: 'part', mountpoints: ['/mnt/hdd'] }] },
      { name: 'nvme1n1', type: 'disk', children: [{ name: 'p3', type: 'part', children: [{ name: 'lv', type: 'lvm', mountpoints: ['/'] }] }] },
      { name: 'nvme0n1', type: 'disk', children: [{ name: 'p1', type: 'part', mountpoints: [null] }] },
    ],
  };
  const smart = (pending) => ({
    devices: [
      { name: '/dev/sda', data: ata(pending) },
      { name: '/dev/nvme1', data: { model_name: 'NVMe', serial_number: 'N1', smart_status: { passed: true }, nvme_smart_health_information_log: { media_errors: 0 } } },
      { name: '/dev/nvme0', data: { model_name: 'Eski', serial_number: 'N0', smart_status: { passed: true }, nvme_smart_health_information_log: { media_errors: 0 } } },
    ],
  });
  let r = diskFacts(smart(2), lsblk, {}, '2026-11-06');
  assert.deepEqual(r.disks.map((d) => [d.device, d.role, d.trend]), [['sda', 'data', 'new'], ['nvme1n1', 'system', null], ['nvme0n1', 'unused', null]]);
  assert.deepEqual(r.disks.map((d) => d.assessment), [{ level: 'warning', reason: 'data_disk_sectors_first_seen' }, null, null]);
  r = diskFacts(smart(2), lsblk, r.history, '2026-11-07');
  assert.deepEqual([r.disks[0].trend, r.disks[0].stableSince], ['stable', '2026-11-06']);
  r = diskFacts(smart(5), lsblk, r.history, '2026-11-08');
  assert.equal(r.disks[0].trend, 'increasing');
  assert.equal(r.disks[0].assessment.level, 'critical');
  assert.deepEqual(r.disks[0].changes.pending, { from: 2, to: 5 });
  assert.equal(r.history.S1.length, 3);
});

test('disk önemi kodla belirlenir', () => {
  assert.deepEqual(assessDisk({ smartPassed: false, bad: false, role: 'data', trend: null }), { level: 'critical', reason: 'smart_failed' });
  assert.deepEqual(assessDisk({ smartPassed: true, bad: true, role: 'system', trend: 'stable' }), { level: 'critical', reason: 'system_disk_sectors' });
  assert.deepEqual(assessDisk({ smartPassed: true, bad: true, role: 'data', trend: 'stable' }), { level: 'warning', reason: 'data_disk_sectors_stable' });
  assert.equal(assessDisk({ smartPassed: true, bad: false, role: 'data', trend: null }), null);
});
