import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTraffic, counterDelta, localKey, summarize } from '../src/traffic.js';
import { validateDockerRequest } from '../src/docker-protocol.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 20, 21, 30);
const eth = (rx, tx) => ({ name: 'eth0', kind: 'ethernet', rxTotal: rx, txTotal: tx });

test('sayaç farkı: ilk görülen sıfır, sıfırlanan sayaç baştan sayılır', () => {
  assert.equal(counterDelta(150, 100), 50);
  assert.equal(counterDelta(30, 100), 30);
  assert.equal(counterDelta(100, undefined), 0);
  assert.equal(counterDelta(-1, 5), 0);
});

test('yerel gün ve ay anahtarı saat dilimine göre', () => {
  assert.equal(localKey(T0, 0, 'day'), '2026-11-20');
  assert.equal(localKey(T0, -180, 'day'), '2026-11-21');
  assert.equal(localKey(Date.UTC(2026, 10, 30, 22), -180, 'month'), '2026-12');
});

test('trafik saatlik toplanır, yeniden başlatmada aynı açılışta kaldığı yerden sürer', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'traffic-'));
  try {
    let now = T0;
    const tr = createTraffic({ dir, now: () => now, bootId: async () => 'boot-a' });
    await tr.record([eth(1000, 500), { name: 'tun0', kind: 'virtual', rxTotal: 10, txTotal: 10 }]);
    now += 60_000;
    await tr.record([eth(3000, 900), { name: 'tun0', kind: 'virtual', rxTotal: 15, txTotal: 12 }]);
    now += HOUR;
    await tr.record([eth(200, 100)]);
    await tr.recordContainers([{ id: 'abc', name: 'web', rx: 100, tx: 10 }]);
    now += 60_000;
    await tr.recordContainers([{ id: 'abc', name: 'web', rx: 600, tx: 60 }, { id: 'def', name: 'db', rx: 5, tx: 5 }]);
    await tr.stop();
    assert.ok((await readdir(dir)).includes('2026-11.json'));

    const again = createTraffic({ dir, now: () => now, bootId: async () => 'boot-a' });
    await again.record([eth(700, 300)]);
    const q = await again.query({ offsetMinutes: 0 });
    assert.deepEqual(q.interfaces.find((i) => i.name === 'eth0'), { name: 'eth0', kind: 'ethernet', physical: true });
    assert.equal(q.interfaces.find((i) => i.name === 'tun0').physical, false);
    const last = q.hourly.at(-1);
    assert.deepEqual(last.ifaces.eth0, [200 + 500, 100 + 200]);
    assert.deepEqual(last.containers, { web: [500, 50] });
    assert.deepEqual(q.hourly.at(-2).ifaces, { eth0: [2000, 400], tun0: [5, 2] });
    assert.deepEqual(q.daily.at(-1).ifaces.eth0, [2700, 700]);
    assert.equal(q.daily.length, 30);
    assert.equal(q.monthly.length, 12);
    assert.equal(q.monthly.at(-1).key, '2026-11');

    const otherBoot = createTraffic({ dir, now: () => now, bootId: async () => 'boot-b' });
    await otherBoot.record([eth(50, 50)]);
    const q2 = await otherBoot.query();
    assert.deepEqual(q2.hourly.at(-1).ifaces.eth0, [200, 100]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('özet: günler yerel saate göre bölünür', () => {
  const hours = new Map([
    [Date.UTC(2026, 10, 20, 20), { i: { eth0: [10, 1] }, c: {} }],
    [Date.UTC(2026, 10, 20, 22), { i: { eth0: [20, 2] }, c: { web: [3, 3] } }],
  ]);
  const s = summarize(hours, { now: Date.UTC(2026, 10, 20, 23), offsetMinutes: -180, dayCount: 2, monthCount: 1 });
  assert.deepEqual(s.daily.map((d) => [d.key, d.ifaces.eth0 ?? null]), [['2026-11-20', [10, 1]], ['2026-11-21', [20, 2]]]);
  assert.deepEqual(s.daily[1].containers, { web: [3, 3] });
  assert.equal(s.hourly.length, 24);
});

test('Docker yardımcısı trafik isteğini kabul eder', () => {
  assert.deepEqual(validateDockerRequest({ op: 'traffic' }), { op: 'traffic' });
  assert.equal(validateDockerRequest({ op: 'traffic2' }), null);
});
