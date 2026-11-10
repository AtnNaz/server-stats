import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUptime, validateMonitor, validateMonitorList } from '../src/uptime.js';

const tmp = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nsup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('izleme hedefi doğrulaması', () => {
  assert.equal(validateMonitor({ name: 'Web', type: 'http', target: 'http://127.0.0.1:3000' }).target, 'http://127.0.0.1:3000/');
  assert.equal(validateMonitor({ name: 'DB', type: 'tcp', target: 'db.local:5432', interval: 30 }).interval, 30);
  assert.equal(validateMonitor({ name: 'x', type: 'tcp', target: '127.0.0.1:5432', interval: 7 }).interval, 60);
  for (const bad of [
    { name: '', type: 'http', target: 'http://a' },
    { name: 'a', type: 'http', target: 'file:///etc/passwd' },
    { name: 'a', type: 'http', target: 'http://kisi:sifre@a.com' },
    { name: 'a', type: 'tcp', target: 'a.com' },
    { name: 'a', type: 'tcp', target: 'a.com:70000' },
    { name: 'a', type: 'tcp', target: 'a b:22' },
    { name: 'a', type: 'icmp', target: 'a.com' },
  ]) {
    assert.equal(validateMonitor(bad), null, JSON.stringify(bad));
  }
  assert.equal(validateMonitorList(Array.from({ length: 31 }, (_, i) => ({ name: `m${i}`, type: 'tcp', target: `h:${i + 1}` }))), null);
});

test('izleme: denetim, iki başarısızlıkta kesinti, düzelince kapanır, yeniden başlayınca geçmiş korunur', async (t) => {
  const dir = tmp(t);
  let clock = Date.parse('2026-11-10T10:00:00Z');
  let httpStatus = 200;
  let tcpOpen = true;
  const fetchImpl = async () => {
    if (httpStatus === 0) throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } });
    return new Response('', { status: httpStatus });
  };
  const connect = () => {
    const s = new EventEmitter();
    s.setTimeout = () => {};
    s.destroy = () => {};
    setImmediate(() => (tcpOpen ? s.emit('connect') : s.emit('error', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))));
    return s;
  };
  const up = createUptime({ dir, fetchImpl, connect, now: () => clock });
  await up.start();
  t.after(() => up.stop());
  const saved = await up.save([
    { name: 'Web', type: 'http', target: 'http://127.0.0.1:3000', interval: 60 },
    { name: 'DB', type: 'tcp', target: '127.0.0.1:5432', interval: 60 },
  ]);
  const [web, db] = saved;
  await up.checkNow(web.id);
  await up.checkNow(db.id);
  let s = await up.status();
  assert.deepEqual(s.monitors.map((m) => [m.name, m.status, m.last.ok]), [['Web', 'up', true], ['DB', 'up', true]]);
  assert.equal(s.monitors[0].last.code, 200);

  // 401 de ayakta sayılır (giriş isteyen panel); 503 ve ağ hatası kesinti.
  httpStatus = 401;
  clock += 60_000;
  assert.equal((await up.checkNow(web.id)).ok, true);
  httpStatus = 503;
  clock += 60_000;
  await up.checkNow(web.id);
  s = await up.status();
  assert.equal(s.monitors[0].status, 'flaky'); // tek başarısızlık henüz kesinti değil
  assert.deepEqual(up.down(), []);
  httpStatus = 0;
  clock += 60_000;
  await up.checkNow(web.id);
  s = await up.status();
  assert.equal(s.monitors[0].status, 'down');
  assert.equal(s.monitors[0].last.err, 'refused');
  assert.equal(up.down()[0].name, 'Web');
  assert.equal(s.incidents[0].start, clock - 60_000); // ilk başarısız denetimden
  assert.equal(s.incidents[0].end, null);

  httpStatus = 200;
  clock += 60_000;
  await up.checkNow(web.id);
  s = await up.status();
  assert.equal(s.monitors[0].status, 'up');
  assert.equal(s.incidents[0].end, clock);
  assert.equal(s.monitors[0].uptime24h, 60); // 5 denetimden 3'ü başarılı
  assert.equal(s.monitors[0].buckets.length, 48);

  tcpOpen = false;
  clock += 60_000;
  assert.equal((await up.checkNow(db.id)).err, 'refused');

  // Dosyalar: hedefler, günlük denetimler, kesintiler; yeniden açılınca geçmiş geri gelir.
  assert.ok(readdirSync(dir).some((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)));
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'monitors.json'), 'utf8')).length, 2);
  const again = createUptime({ dir, fetchImpl, connect, now: () => clock });
  await again.start();
  t.after(() => again.stop());
  const s2 = await again.status();
  assert.equal(s2.monitors[0].uptime24h, 60);
  assert.equal(s2.incidents.length, 1);

  // Silinen hedefin durumu da gider.
  await up.save([saved[1]]);
  assert.deepEqual((await up.status()).monitors.map((m) => m.name), ['DB']);
  assert.equal(await up.checkNow(web.id), null);
});
