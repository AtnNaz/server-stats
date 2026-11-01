import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiskstats, parseMountinfo, summarizeSmart, smartFor } from '../src/collectors/storage.js';
import { buildSensors } from '../src/collectors/sensors.js';

const ataAttr = (id, name, raw, extra = {}) => ({ id, name, raw: { value: raw }, ...extra });

// Örnek bir 2 TB HDD'nin smartctl çıktısı
const exampleHdd = {
  model_name: 'EXAMPLE-HDD-2000',
  smart_status: { passed: true },
  temperature: { current: 37 },
  power_on_time: { hours: 57534 },
  power_cycle_count: 2681,
  ata_smart_attributes: {
    table: [
      ataAttr(5, 'Reallocated_Sector_Ct', 83),
      ataAttr(187, 'Reported_Uncorrect', 86),
      ataAttr(197, 'Current_Pending_Sector', 2),
      ataAttr(198, 'Offline_Uncorrectable', 2),
      ataAttr(199, 'UDMA_CRC_Error_Count', 0),
    ],
  },
};

test('diskstats ve mountinfo okunur', () => {
  const stats = parseDiskstats('   8       0 sda 115328 736011 171826824 2027663 790 4324 5114 35927 0 560588 2063597 0 0 0 0 2 6\n');
  assert.deepEqual(stats.sda, { readIos: 115328, readSectors: 171826824, writeIos: 790, writeSectors: 5114, ioMs: 560588 });

  const mounts = parseMountinfo(
    [
      '29 1 252:0 / / rw,relatime shared:1 - ext4 /dev/mapper/vg-root rw',
      '120 29 8:1 / /mnt/yedek\\040disk rw,relatime shared:60 - exfat /dev/sda1 rw,uid=1000',
      '30 29 0:5 / /dev rw,nosuid shared:2 master:1 - devtmpfs udev rw',
    ].join('\n'),
  );
  assert.deepEqual(mounts.map((m) => [m.devno, m.mount, m.fstype]), [
    ['252:0', '/', 'ext4'],
    ['8:1', '/mnt/yedek disk', 'exfat'],
    ['0:5', '/dev', 'devtmpfs'],
  ]);
});

test('bozuk ve bekleyen sektörlü HDD kritik sayılır, gerekçeleri listelenir', () => {
  const s = summarizeSmart(exampleHdd);
  assert.equal(s.status, 'crit');
  assert.deepEqual(s.reasons, [
    '2 bekleyen (okunamayan) sektör',
    '2 düzeltilemeyen sektör',
    '83 yeniden atanmış sektör',
    '86 bildirilmiş okuma hatası',
  ]);
  assert.equal(s.powerOnHours, 57534);
  assert.equal(s.temperature, 37);
});

test('sağlıklı SATA SSD: aşınma ve yazılan veri hesaplanır', () => {
  const s = summarizeSmart({
    model_name: 'Example SSD 500GB',
    smart_status: { passed: true },
    logical_block_size: 512,
    ata_smart_attributes: { table: [ataAttr(5, 'Reallocated_Sector_Ct', 0), ataAttr(241, 'Total_LBAs_Written', 341507593033)] },
    ata_device_statistics: { pages: [{ table: [{ name: 'Percentage Used Endurance Indicator', value: 6 }] }] },
  });
  assert.equal(s.status, 'ok');
  assert.equal(s.wearPercent, 6);
  assert.equal(s.writtenBytes, 341507593033 * 512);
  assert.deepEqual(s.reasons, []);
});

test('NVMe: kritik uyarı bayrağı ve yıpranma değerlendirilir', () => {
  const healthy = summarizeSmart({
    smart_status: { passed: true },
    nvme_smart_health_information_log: { critical_warning: 0, temperature: 22, available_spare: 100, available_spare_threshold: 10, percentage_used: 50, data_units_written: 73264840, power_on_hours: 48228, media_errors: 0, num_err_log_entries: 109685 },
  });
  assert.equal(healthy.status, 'ok'); // hata günlüğü kayıtları tek başına sorun sayılmaz
  assert.equal(healthy.writtenBytes, 73264840 * 512000);

  const worn = summarizeSmart({ smart_status: { passed: true }, nvme_smart_health_information_log: { critical_warning: 0, percentage_used: 85, media_errors: 0 } });
  assert.equal(worn.status, 'warn');

  const failing = summarizeSmart({ smart_status: { passed: false }, nvme_smart_health_information_log: { critical_warning: 4, available_spare: 5, available_spare_threshold: 10 } });
  assert.equal(failing.status, 'crit');
  assert.equal(failing.reasons.length, 3);
});

test('SMART kaydı yalnızca aynı modeldeki diske eşlenir; uykudaki diskin durumu korunur', () => {
  const entries = [{ name: '/dev/sda', standby: true, data: exampleHdd }];
  assert.equal(smartFor(entries, 'sda', 'Example SSD'), null); // ad değişmiş, başka disk
  const sleeping = smartFor(entries, 'sda', 'EXAMPLE-HDD-2000');
  assert.equal(sleeping.status, 'crit'); // uyuyor diye "sağlıklı" görünmez
  assert.equal(sleeping.standby, true);
  assert.equal(smartFor(entries, 'sdb', 'X'), null);
  assert.equal(smartFor([{ name: '/dev/sdc', error: 'SMART desteklenmiyor' }], 'sdc', 'USB').status, 'unknown');

  // NVMe: smartctl denetleyici adını (/dev/nvme0) bildirir, disk adı nvme0n1'dir.
  const nvme = [{ name: '/dev/nvme0', data: { model_name: 'EXAMPLE NVME 256GB', smart_status: { passed: true }, nvme_smart_health_information_log: { critical_warning: 0, percentage_used: 50 } } }];
  assert.equal(smartFor(nvme, 'nvme0n1', 'EXAMPLE NVME 256GB').wearPercent, 50);
  assert.equal(smartFor(nvme, 'nvme10n1', 'EXAMPLE NVME 256GB'), null);
});

test('sensörler: işlemci özetlenir, Dell tekrarları ve anlamsız NVMe eşikleri atılır', () => {
  const t = (index, label, value, max = null, crit = null) => ({ index, label, value, max, crit });
  const sensors = buildSensors([
    { id: 'hwmon9', name: 'coretemp', temps: [t(1, 'Package id 0', 41, 80, 100), t(2, 'Core 0', 30, 80, 100), t(6, 'Core 4', 38, 80, 100)], fans: [] },
    { id: 'hwmon0', name: 'nvme', model: 'EXAMPLE NVME 256GB', temps: [t(1, 'Composite', 21.9, 77.9, 81.9), t(2, 'Sensor 1', 21.9)], fans: [] },
    { id: 'hwmon6', name: 'dell_ddv', temps: [t(1, 'CPU', 36), t(4, 'Other', 23), t(5, 'Other', 27)], fans: [{ index: 1, label: 'CPU Fan', rpm: 737 }, { index: 2, label: 'Chassis Motherboard Fan', rpm: 703 }, { index: 3, label: 'Chassis Motherboard Fan', rpm: 696 }] },
    { id: 'hwmon8', name: 'dell_smm', temps: [t(1, null, 36)], fans: [{ index: 1, label: null, rpm: 737, max: 4500 }] },
    { id: 'hwmon3', name: 'ucsi_source_psy_USBC000:001', temps: [], fans: [] },
    { id: 'hwmon7', name: 'iwlwifi_1', temps: [t(1, null, 24)], fans: [] },
  ]);
  assert.deepEqual(sensors.cpu, { package: 41, hottestCore: 38, high: 80, crit: 100 });
  assert.equal(sensors.hottestDisk, 21.9);
  assert.deepEqual(sensors.groups.map((g) => g.name), ['İşlemci', 'NVMe disk · EXAMPLE NVME 256GB', 'Anakart ve kasa', 'Kablosuz ağ kartı']);
  assert.deepEqual(sensors.groups[0].temps.map((x) => [x.label, x.value]), [['Paket', 41], ['En sıcak çekirdek', 38], ['Çekirdek ortalaması', 34]]);
  assert.deepEqual(sensors.groups[1].temps.map((x) => x.label), ['Genel']);
  assert.deepEqual(sensors.groups[2].temps.map((x) => x.label), ['İşlemci', 'Diğer 1', 'Diğer 2']);
  assert.deepEqual(sensors.groups[2].fans.map((f) => f.label), ['İşlemci fanı', 'Kasa fanı 1', 'Kasa fanı 2']);
  assert.deepEqual(sensors.groups[3].temps.map((x) => x.label), ['Sıcaklık']);
});
