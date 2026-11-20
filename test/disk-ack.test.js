import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acknowledged, validAcks, markAcknowledged, findAck } from '../src/disk-ack.js';
import { validateRequest } from '../src/system-settings.js';
import { summarizeSmart } from '../src/collectors/storage.js';
import { diskFacts, assessDisk, quietAcknowledged, buildReport } from '../bin/serverhealth-report.js';

const ack = { serial: 'S1', model: 'HDD', counters: { reallocated: 83, pending: 2, offlineUncorrectable: 2 }, at: 1_700_000_000_000 };
const ata = (pending, crc = 0) => ({
  model_name: 'HDD',
  serial_number: 'S1',
  smart_status: { passed: true },
  ata_smart_attributes: { table: [{ id: 5, raw: { value: 83 } }, { id: 197, raw: { value: pending } }, { id: 198, raw: { value: 2 } }, { id: 199, raw: { value: crc } }] },
});

test('onay: sayaçlar işaretlenen değeri aşmadıkça geçerli', () => {
  assert.equal(acknowledged([ack], 'S1', { reallocated: 83, pending: 2, offlineUncorrectable: 2 }), true);
  assert.equal(acknowledged([ack], 'S1', { reallocated: 83, pending: 0, offlineUncorrectable: 2 }), true);
  assert.equal(acknowledged([ack], 'S1', { reallocated: 84, pending: 2, offlineUncorrectable: 2 }), false);
  assert.equal(acknowledged([ack], 'S1', { reallocated: 83, mediaErrors: 1 }), false);
  assert.equal(acknowledged([ack], 'S2', { reallocated: 0 }), false);
  assert.equal(acknowledged([], 'S1', {}), false);
  assert.equal(findAck([ack], null), null);
});

test('onay listesi doğrulanır', () => {
  assert.equal(validAcks([ack]), true);
  assert.equal(validAcks([]), true);
  assert.equal(validAcks([ack, ack]), false);
  assert.equal(validAcks([{ ...ack, counters: { crcErrors: 1 } }]), false);
  assert.equal(validAcks([{ ...ack, counters: { pending: -1 } }]), false);
  assert.equal(validAcks([{ ...ack, extra: 1 }]), false);
  assert.equal(validAcks([{ ...ack, serial: '' }]), false);
  assert.equal(validAcks([{ ...ack, serial: 'a\nb' }]), false);
  assert.equal(validAcks(Array.from({ length: 33 }, (_, i) => ({ ...ack, serial: `S${i}` }))), false);
  assert.deepEqual(validateRequest({ type: 'settings', settings: { diskAcks: [ack] } }), { request: { type: 'settings', settings: { diskAcks: [ack] } } });
  assert.deepEqual(validateRequest({ type: 'settings', settings: { diskAcks: 'x' } }), { errors: ['diskAcks'] });
});

test('SMART özeti sektör dışı durumu ayrı verir', () => {
  const s = summarizeSmart(ata(2));
  assert.equal(s.status, 'crit');
  assert.equal(s.statusWithoutSectors, 'ok');
  assert.equal(s.serial, 'S1');
  assert.deepEqual(s.counters, { reallocated: 83, pending: 2, offlineUncorrectable: 2 });
  assert.equal(s.sectorReasons.length, 3);
  assert.equal(summarizeSmart(ata(2, 5)).statusWithoutSectors, 'warn');
});

test('panel verisinde onaylı diskler işaretlenir', () => {
  const devices = [{ name: 'sda', smart: summarizeSmart(ata(2)) }, { name: 'sdb', smart: null }];
  const [a, b] = markAcknowledged(devices, [ack]);
  assert.equal(a.smart.acknowledged, true);
  assert.equal(a.smart.ackedAt, ack.at);
  assert.equal(b, devices[1]);
  assert.equal(markAcknowledged([{ name: 'sda', smart: summarizeSmart(ata(3)) }], [ack])[0].smart.acknowledged, false);
  assert.equal(markAcknowledged(devices, []), devices);
});

test('raporda onaylı disk bilgi düzeyine iner ve smartd kayıtları düşer', () => {
  const smart = (pending) => ({ devices: [{ name: '/dev/sda', data: ata(pending) }] });
  const lsblk = { blockdevices: [{ name: 'sda', type: 'disk', children: [{ name: 'sda1', type: 'part', mountpoints: ['/mnt/hdd'] }] }] };
  let r = diskFacts(smart(2), lsblk, {}, '2026-11-06', [ack]);
  assert.equal(r.disks[0].acknowledged, true);
  assert.deepEqual(r.disks[0].assessment, { level: 'info', reason: 'acknowledged' });
  r = diskFacts(smart(3), lsblk, {}, '2026-11-06', [ack]);
  assert.equal(r.disks[0].acknowledged, undefined);
  assert.equal(r.disks[0].assessment.level, 'warning');
  assert.deepEqual(assessDisk({ smartPassed: false, bad: true, role: 'data', trend: 'stable', known: true }), { level: 'critical', reason: 'smart_failed' });

  const entries = [
    { SYSLOG_IDENTIFIER: 'smartd', MESSAGE: 'Device: /dev/sda [SAT], 2 Currently unreadable (pending) sectors' },
    { SYSLOG_IDENTIFIER: 'smartd', MESSAGE: 'Device: /dev/sdab [SAT], 1 Currently unreadable (pending) sectors' },
    { SYSLOG_IDENTIFIER: 'smartd', MESSAGE: [...Buffer.from('Device: /dev/sda [SAT], warning')] },
    { SYSLOG_IDENTIFIER: 'kernel', MESSAGE: 'sd 0:0:0:0: [sda] /dev/sda read error' },
  ];
  const kept = quietAcknowledged(entries, [{ name: 'sda', acknowledged: true }]);
  assert.deepEqual(kept, [entries[1], entries[3]]);
  assert.equal(quietAcknowledged(entries, [{ name: 'sda' }]), entries);
});

test('rapor olgularında onaylı disk adı taşınmaz', async () => {
  const smart = { devices: [{ name: '/dev/sda', data: ata(2) }] };
  const r = await buildReport({ entriesText: '', failedText: '', status: null, smart, diskAcks: [ack], date: '2026-11-06', model: '', language: 'tr' });
  assert.equal(r.facts.disks[0].acknowledged, true);
  assert.equal('name' in r.facts.disks[0], false);
  assert.equal(r.aiError, 'model_missing');
});
