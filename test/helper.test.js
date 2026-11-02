import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHelper } from '../bin/serverhealth-helper.js';
import { validateRequest, aptConfig, parseAptConfigDump, countAptUpgrades, onCalendarWeekly, onCalendarMonthly } from '../src/system-settings.js';

test('istekler izin verilen değerler listesine göre doğrulanır', () => {
  assert.ok(validateRequest({ type: 'settings', settings: { updates: 'all', rebootTime: '04:30' } }).request);
  assert.ok(validateRequest({ type: 'action', action: 'reboot' }).request);
  assert.deepEqual(validateRequest({ type: 'action', action: 'rm -rf /' }).errors, ['type']);
  assert.deepEqual(validateRequest({ type: 'shell', cmd: 'id' }).errors, ['type']);
  assert.deepEqual(validateRequest({ type: 'settings', settings: { rebootTime: '04:00; reboot' } }).errors, ['rebootTime']);
  assert.deepEqual(validateRequest({ type: 'settings', settings: { evil: true } }).errors, ['evil']);
  assert.deepEqual(validateRequest({ type: 'settings', settings: { scheduledReboot: { day: 'Sun; id', time: '25:00' } } }).errors, ['scheduledReboot.day', 'scheduledReboot.time']);
  assert.deepEqual(validateRequest({ type: 'settings', settings: { smartTests: { longDay: 31 } } }).errors, ['smartTests.longDay']);
});

test('apt ayarı üretilir ve apt-config çıktısından geri okunur', () => {
  const text = aptConfig({ updates: 'all', rebootAfterUpdate: true, rebootTime: '04:30' });
  assert.match(text, /APT::Periodic::Unattended-Upgrade "1";/);
  assert.match(text, /Automatic-Reboot "true";/);
  assert.match(text, /Automatic-Reboot-Time "04:30";/);
  assert.match(text, /-updates"; };/);
  assert.match(aptConfig({ updates: 'off', rebootAfterUpdate: false, rebootTime: '02:00' }), /Unattended-Upgrade "0";/);

  const dump = [
    'APT::Periodic::Update-Package-Lists "1";',
    'APT::Periodic::Unattended-Upgrade "1";',
    'Unattended-Upgrade::Allowed-Origins "";',
    'Unattended-Upgrade::Allowed-Origins:: "${distro_id}:${distro_codename}-security";',
    'Unattended-Upgrade::Automatic-Reboot "false";',
  ].join('\n');
  assert.deepEqual(parseAptConfigDump(dump), { updates: 'security', rebootAfterUpdate: false, rebootTime: '02:00' });
  assert.equal(parseAptConfigDump(`${dump}\nUnattended-Upgrade::Allowed-Origins:: "\${distro_id}:\${distro_codename}-updates";`).updates, 'all');
  assert.equal(parseAptConfigDump('APT::Periodic::Unattended-Upgrade "0";').updates, 'off');
});

test('bekleyen güncellemeler ve zamanlayıcı ifadeleri', () => {
  const sim = [
    'Inst libssl3 [3.0.2-0ubuntu1.1] (3.0.2-0ubuntu1.2 Ubuntu:22.04/jammy-security [amd64])',
    'Inst curl [7.81.0-1] (7.81.0-1ubuntu1.4 Ubuntu:22.04/jammy-updates [amd64])',
    'Conf libssl3 (3.0.2-0ubuntu1.2 Ubuntu:22.04/jammy-security [amd64])',
  ].join('\n');
  assert.deepEqual(countAptUpgrades(sim), { pending: 2, security: 1 });
  assert.equal(onCalendarWeekly('sun', '04:00'), 'Sun *-*-* 04:00:00');
  assert.equal(onCalendarWeekly('daily', '23:15'), '*-*-* 23:15:00');
  assert.equal(onCalendarMonthly(1, '03:00'), '*-*-01 03:00:00');
});

test('yardımcı: kuyruğu işler, dosyaları yazar, zararlı istekleri reddeder', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'serverhealth-helper-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const queue = path.join(root, 'var/lib/serverhealth-queue');
  mkdirSync(queue, { recursive: true });
  const put = (name, obj) => writeFileSync(path.join(queue, name), JSON.stringify(obj));

  put('1.json', {
    type: 'settings',
    settings: { updates: 'all', rebootAfterUpdate: true, rebootTime: '04:30', scheduledReboot: { enabled: true, day: 'sun', time: '05:00' }, smartTests: { enabled: true, shortDay: 'sat', longDay: 2, time: '03:00' } },
  });
  put('2.json', { type: 'settings', settings: { rebootTime: '$(reboot)' } });
  put('3.json', { type: 'action', action: 'refresh' });
  writeFileSync(path.join(queue, '4.json'), 'x'.repeat(20000)); // çok büyük
  writeFileSync(path.join(root, 'secret.txt'), 'GIZLI-ICERIK');
  symlinkSync(path.join(root, 'secret.txt'), path.join(queue, '5.json')); // başka bir dosyaya bağlantı

  const helper = createHelper({
    root,
    dryRun: true,
    nodeBin: '/usr/bin/node',
    appDir: '/opt/serverhealth',
    now: () => 1700000000000,
    platformOverride: { packageManager: 'apt', systemctl: '/usr/bin/systemctl', autoUpdates: true, updateNow: true, smartTests: true, unattendedInstalled: true },
  });
  await helper.processQueue();

  assert.deepEqual(readdirSync(queue), []); // kuyruk boşaltılır
  assert.equal(readFileSync(path.join(root, 'secret.txt'), 'utf8'), 'GIZLI-ICERIK'); // bağlantının hedefi silinmez

  const apt = readFileSync(path.join(root, 'etc/apt/apt.conf.d/52serverhealth'), 'utf8');
  assert.match(apt, /Automatic-Reboot-Time "04:30";/);
  assert.doesNotMatch(apt, /reboot\)/);

  const units = path.join(root, 'etc/systemd/system');
  assert.match(readFileSync(path.join(units, 'serverhealth-reboot.timer'), 'utf8'), /OnCalendar=Sun \*-\*-\* 05:00:00\nPersistent=false/);
  assert.match(readFileSync(path.join(units, 'serverhealth-reboot.service'), 'utf8'), /ExecStart=\/usr\/bin\/systemctl reboot/);
  assert.match(readFileSync(path.join(units, 'serverhealth-smarttest-long.timer'), 'utf8'), /OnCalendar=\*-\*-02 03:00:00/);
  assert.match(readFileSync(path.join(units, 'serverhealth-smarttest-short.service'), 'utf8'), /serverhealth-helper\.js --smart-test short/);

  const status = JSON.parse(readFileSync(path.join(root, 'var/lib/serverhealth/system.json'), 'utf8'));
  assert.equal(status.settings.updates, 'all');
  assert.equal(status.settings.rebootAfterUpdate, true);
  assert.deepEqual(status.settings.scheduledReboot, { enabled: true, day: 'sun', time: '05:00' });
  assert.equal(status.settings.smartTests.shortDay, 'sat');

  const history = readFileSync(path.join(root, 'var/lib/serverhealth/actions.jsonl'), 'utf8');
  assert.equal((history.match(/"rejected"/g) ?? []).length, 3);
  assert.doesNotMatch(history, /GIZLI/); // reddedilen dosyanın içeriği hiçbir yere yazılmaz
  assert.doesNotMatch(JSON.stringify(status), /GIZLI/);

  // Çalıştırılan komutlar sabit; istekten gelen serbest metin içermez.
  assert.ok(helper.commands.includes('/usr/bin/systemctl enable --now serverhealth-reboot.timer'));
  assert.ok(helper.commands.includes('apt-get update'));
  assert.ok(helper.commands.every((c) => !c.includes('$(')));

  // Planlı yeniden başlatma kapatılınca zamanlayıcı kaldırılır.
  put('6.json', { type: 'settings', settings: { scheduledReboot: { enabled: false } } });
  await helper.processQueue();
  assert.equal(existsSync(path.join(units, 'serverhealth-reboot.timer')), false);
  assert.ok(helper.commands.includes('/usr/bin/systemctl disable --now serverhealth-reboot.timer'));
});

test('doğrulayıcı Object.prototype adlarını alan olarak kabul etmez', () => {
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const input = JSON.parse(`{"${key}": {"x": 1}}`);
    assert.ok(validateRequest({ type: 'settings', settings: input }).errors, key);
    assert.ok(validateRequest({ type: 'settings', settings: { scheduledReboot: input } }).errors, `scheduledReboot.${key}`);
  }
});

const PLATFORM = { packageManager: 'apt', systemctl: '/usr/bin/systemctl', autoUpdates: true, updateNow: true, smartTests: true, unattendedInstalled: true };

test('yardımcı: sembolik bağ olan kuyruk klasörü işlenmez, hedefindeki dosyalar silinmez', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'serverhealth-helper-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'etc/onemli');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'config.json'), '{}');
  mkdirSync(path.join(root, 'var/lib'), { recursive: true });
  symlinkSync(target, path.join(root, 'var/lib/serverhealth-queue'));

  const helper = createHelper({ root, dryRun: true, now: () => 1700000000000, platformOverride: PLATFORM });
  await helper.processQueue();
  assert.ok(existsSync(path.join(target, 'config.json'))); // root başka klasördeki dosyayı silmedi
  assert.match(readFileSync(path.join(root, 'var/lib/serverhealth/actions.jsonl'), 'utf8'), /invalid_queue/);
});

test('yardımcı: yarım kalmış eski geçici dosyalar temizlenir', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'serverhealth-helper-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const queue = path.join(root, 'var/lib/serverhealth-queue');
  mkdirSync(queue, { recursive: true });
  const stale = path.join(queue, '.1.json.tmp');
  writeFileSync(stale, '{');
  utimesSync(stale, new Date(1600000000000), new Date(1600000000000));
  writeFileSync(path.join(queue, '2.json'), JSON.stringify({ type: 'action', action: 'refresh' }));

  const helper = createHelper({ root, dryRun: true, now: () => 1700000000000, platformOverride: PLATFORM });
  await helper.processQueue();
  assert.deepEqual(readdirSync(queue), []);
});

test('günlük rapor: model adı doğrulanır, zamanlayıcı kurulur ve kaldırılır, "şimdi oluştur" servisi başlatır', async (t) => {
  assert.ok(validateRequest({ type: 'settings', settings: { report: { enabled: true, time: '07:00', model: 'hf.co/kisi/model:Q4_0' } } }).request);
  assert.ok(validateRequest({ type: 'settings', settings: { report: { model: 'qwen; rm -rf /' } } }).errors);
  assert.ok(validateRequest({ type: 'settings', settings: { report: { time: '7:00' } } }).errors);
  assert.ok(validateRequest({ type: 'action', action: 'report' }).request);

  const root = mkdtempSync(path.join(tmpdir(), 'serverhealth-helper-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const queue = path.join(root, 'var/lib/serverhealth-queue');
  mkdirSync(queue, { recursive: true });
  const put = (name, obj) => writeFileSync(path.join(queue, name), JSON.stringify(obj));
  const helper = createHelper({ root, dryRun: true, now: () => 1700000000000, platformOverride: PLATFORM });
  const timer = path.join(root, 'etc/systemd/system/serverhealth-report.timer');

  put('1.json', { type: 'settings', settings: { report: { enabled: true, time: '06:30', model: 'qwen3.5:4b' } } });
  await helper.processQueue();
  assert.match(readFileSync(timer, 'utf8'), /OnCalendar=\*-\*-\* 06:30:00\nPersistent=true\nUnit=serverhealth-report.service/);
  assert.ok(helper.commands.includes('/usr/bin/systemctl enable --now serverhealth-report.timer'));
  assert.equal(JSON.parse(readFileSync(path.join(root, 'var/lib/serverhealth/system.json'), 'utf8')).settings.report.model, 'qwen3.5:4b');

  put('2.json', { type: 'action', action: 'report' });
  await helper.processQueue();
  assert.ok(helper.commands.includes('/usr/bin/systemctl start --no-block serverhealth-report.service'));

  put('3.json', { type: 'settings', settings: { report: { enabled: false } } });
  await helper.processQueue();
  assert.equal(existsSync(timer), false);

  put('4.json', { type: 'settings', settings: { report: { enabled: true, model: '' } } });
  await helper.processQueue();
  assert.match(readFileSync(path.join(root, 'var/lib/serverhealth/actions.jsonl'), 'utf8'), /model_missing/);
});

test('panelden güncelleme: yalnızca daha yeni sürüm indirilir ve ayrı birimde kurulur', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'serverhealth-helper-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'opt/serverhealth');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ version: '1.0.0', homepage: 'https://github.com/sahip/depo' }));
  const queue = path.join(root, 'var/lib/serverhealth-queue');
  mkdirSync(queue, { recursive: true });
  const history = () => readFileSync(path.join(root, 'var/lib/serverhealth/actions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.action === 'self-update');

  let latest = 'v1.2.0';
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).startsWith('https://api.github.com/')) return { ok: true, status: 200, json: async () => ({ tag_name: latest }) };
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const helper = createHelper({ root, dryRun: true, appDir, fetchImpl, now: () => 1700000000000, platformOverride: PLATFORM });
  const run = async () => {
    writeFileSync(path.join(queue, `${urls.length}.json`), JSON.stringify({ type: 'action', action: 'self-update' }));
    await helper.processQueue();
  };

  await run();
  assert.deepEqual(urls, ['https://api.github.com/repos/sahip/depo/releases/latest', 'https://codeload.github.com/sahip/depo/tar.gz/refs/tags/v1.2.0']);
  assert.ok(helper.commands.some((c) => c.startsWith('tar -xzf ') && c.includes('--strip-components=1 --no-same-owner')));
  assert.ok(helper.commands.some((c) => /systemd-run --unit=serverhealth-update --collect --quiet \/bin\/bash .*\/deploy\/install\.sh$/.test(c)));
  assert.deepEqual(history().at(-1), { time: 1700000000000, type: 'action', action: 'self-update', ok: true, version: '1.2.0', upToDate: false });

  latest = 'v1.0.0'; // aynı sürüm: indirme yapılmaz
  urls.length = 0;
  await run();
  assert.equal(urls.length, 1);
  assert.equal(history().at(-1).upToDate, true);

  latest = '<script>'; // bozuk etiket
  await run();
  assert.equal(history().at(-1).message, 'release_check_failed');
});
