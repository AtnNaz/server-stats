import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDiskHealth, healthSample } from '../src/disk-health.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const snap = (pending, wear = null, temp = 35) => ({
  storage: {
    devices: [
      { name: 'sda', model: 'HDD 2TB', serial: 'S1', type: 'HDD', smart: { status: 'warn', temperature: temp, powerOnHours: 1000, attributes: { reallocated: 83, pending, offlineUncorrectable: 2 } } },
      { name: 'nvme0n1', model: 'SSD 1TB', serial: 'N1', type: 'NVMe SSD', smart: { status: 'ok', temperature: 40, wearPercent: wear, writtenBytes: 1e12, attributes: { mediaErrors: 0 } } },
      { name: 'sdb', model: 'Uyuyan', serial: 'Z', smart: { status: 'ok', standby: true, attributes: {} } },
      { name: 'sdc', model: 'Okunamayan', serial: 'Y', smart: { status: 'unknown' } },
    ],
  },
});

test('SMART özeti kayda dönüşür; uykudaki ve okunamayan diskler atlanır', () => {
  assert.equal(healthSample({ smart: { status: 'unknown' } }), null);
  assert.equal(healthSample({ smart: { status: 'ok', standby: true } }), null);
  assert.deepEqual(healthSample(snap(2).storage.devices[0]), { temp: 35, poh: 1000, wear: null, written: null, realloc: 83, pending: 2, offline: 2, reported: null, media: null });
});

test('disk sağlığı: saatte bir kayıt, artış uyarısı, aşınma tahmini ve seyreltme', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nsdh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const dh = createDiskHealth({ dir, now: () => clock });

  await dh.record(snap(2, 10));
  await dh.record(snap(2, 10)); // aynı saat içinde ikinci kayıt alınmaz
  assert.equal(readFileSync(path.join(dir, 'disk-health.jsonl'), 'utf8').trim().split('\n').length, 2);

  // 30 gün, saatte bir; aşınma %10'dan %13'e çıkar, son gün bozuk sektör artar.
  for (let h = 1; h <= 30 * 24; h++) {
    clock += HOUR;
    const pending = h > 29 * 24 ? 5 : 2;
    await dh.record(snap(pending, 10 + Math.floor((h / (30 * 24)) * 3), 30 + (h % 10)));
  }
  const q = await dh.query('30d');
  assert.equal(q.disks.length, 2);
  const hdd = q.disks.find((d) => d.name === 'sda');
  assert.deepEqual(hdd.increases, [{ counter: 'pending', from: 2, to: 5 }]);
  assert.equal(hdd.latest.pending, 5);
  assert.ok(hdd.points.length <= 121 && hdd.points.length >= 119); // 6 saatlik dilimler
  assert.ok(hdd.points.every((p) => p.temp >= 30 && p.temp <= 39));
  const ssd = q.disks.find((d) => d.name === 'nvme0n1');
  assert.deepEqual(ssd.increases, []);
  // 30 günde %3 aşınma → kalan %87 için ~2,4 yıl
  assert.ok(ssd.yearsLeft > 2 && ssd.yearsLeft < 3, String(ssd.yearsLeft));
  assert.equal((await dh.query('7d')).disks[0].points.length >= 160, true);

  const alerts = await dh.alerts();
  assert.deepEqual(alerts.map((a) => [a.name, a.increases[0].counter]), [['sda', 'pending']]);

  // Yeniden açılınca kayıtlar dosyadan okunur; 30 günden uzun görülmeyen disk listelenmez.
  clock += 31 * DAY;
  const again = createDiskHealth({ dir, now: () => clock });
  assert.deepEqual((await again.query('365d')).disks, []);
  clock -= 31 * DAY;
  const again2 = createDiskHealth({ dir, now: () => clock });
  assert.equal((await again2.query('365d')).disks.length, 2);
});
