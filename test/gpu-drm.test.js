import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDrmGpuCollector, lookupPciName, marketingName, parseDpmClock } from '../src/collectors/gpu-drm.js';

const PCI_IDS = [
  '# pci.ids örneği',
  '1002  Advanced Micro Devices, Inc. [AMD/ATI]',
  '\t73a0  Navi 21',
  '\t73bf  Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]',
  '\t\t1002 0e3a  Radeon RX 6900 XT',
  '8086  Intel Corporation',
  '\ta780  Raptor Lake-S GT1 [UHD Graphics 770]',
  '',
].join('\n');

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${content}\n`);
}

// Çekirdeğin düzenini taklit eden sahte bir /sys ağacı kurar.
function fakeSysfs(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'serverhealth-sysfs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const drm = path.join(root, 'class', 'drm');
  const devices = path.join(root, 'devices');
  const drivers = path.join(root, 'bus', 'pci', 'drivers');
  mkdirSync(drm, { recursive: true });

  function card(name, pciAddr, driver, vendor, device, runtime = 'active') {
    const dev = path.join(devices, pciAddr);
    mkdirSync(path.join(drivers, driver), { recursive: true });
    mkdirSync(dev, { recursive: true });
    symlinkSync(path.join(drivers, driver), path.join(dev, 'driver'));
    write(path.join(dev, 'vendor'), vendor);
    write(path.join(dev, 'device'), device);
    write(path.join(dev, 'power', 'runtime_status'), runtime);
    mkdirSync(path.join(drm, name), { recursive: true });
    symlinkSync(dev, path.join(drm, name, 'device'));
    return dev;
  }

  const amd = card('card0', '0000:03:00.0', 'amdgpu', '0x1002', '0x73bf');
  write(path.join(amd, 'gpu_busy_percent'), '42');
  write(path.join(amd, 'mem_info_vram_total'), String(16 * 1024 ** 3));
  write(path.join(amd, 'mem_info_vram_used'), String(4 * 1024 ** 3));
  write(path.join(amd, 'pp_dpm_sclk'), '0: 500Mhz\n1: 1500Mhz\n2: 2250Mhz *');
  write(path.join(amd, 'hwmon', 'hwmon5', 'temp1_input'), '61000');
  write(path.join(amd, 'hwmon', 'hwmon5', 'power1_average'), '187000000');
  write(path.join(amd, 'hwmon', 'hwmon5', 'power1_cap'), '255000000');
  write(path.join(amd, 'hwmon', 'hwmon5', 'pwm1'), '102');
  write(path.join(amd, 'hwmon', 'hwmon5', 'fan1_input'), '1400');
  mkdirSync(path.join(drm, 'card0-DP-1'), { recursive: true }); // bağlantı noktası, kart değil

  card('card1', '0000:00:02.0', 'i915', '0x8086', '0xa780');
  write(path.join(drm, 'card1', 'gt', 'gt0', 'rc6_residency_ms'), '1000');
  write(path.join(drm, 'card1', 'gt', 'gt0', 'rps_act_freq_mhz'), '900');
  write(path.join(drm, 'card1', 'gt_RP0_freq_mhz'), '1600');

  card('card2', '0000:01:00.0', 'nvidia', '0x10de', '0x2571'); // nvidia-smi ile ayrıca okunur
  const sleeping = card('card3', '0000:05:00.0', 'amdgpu', '0x1002', '0x73a0', 'suspended');
  write(path.join(sleeping, 'gpu_busy_percent'), '99');
  card('card4', '0000:00:01.0', 'virtio-pci', '0x1af4', '0x1050');

  const pciIds = path.join(root, 'pci.ids');
  writeFileSync(pciIds, PCI_IDS);
  return { root, drm, pciIds };
}

test('pci.ids içinden pazarlama adı çıkarılır', () => {
  assert.equal(lookupPciName(PCI_IDS, '1002', '73bf'), 'Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]');
  assert.equal(lookupPciName(PCI_IDS, '8086', '73bf'), null); // başka satıcının aygıtı
  assert.equal(marketingName('AMD', 'Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]'), 'AMD Radeon RX 6800/6800 XT / 6900 XT');
  assert.equal(marketingName('AMD', 'Navi 21'), 'AMD Navi 21');
  assert.deepEqual(parseDpmClock('0: 500Mhz\n1: 1500Mhz *\n2: 2250Mhz'), { current: 1500, max: 2250 });
  assert.deepEqual(parseDpmClock(null), { current: null, max: null });
});

test('AMD ve Intel kartlar sysfs üzerinden okunur, diğerleri atlanır', async (t) => {
  const { root, drm, pciIds } = fakeSysfs(t);
  let clock = 1000;
  const collector = createDrmGpuCollector({ sysfs: root, pciIdFiles: [pciIds], now: () => clock });

  const first = await collector.collect();
  assert.deepEqual(first.gpus.map((g) => [g.id, g.vendor, g.driver, g.state]), [
    ['card0', 'AMD', 'amdgpu', 'active'],
    ['card1', 'Intel', 'i915', 'active'],
    ['card3', 'AMD', 'amdgpu', 'suspended'],
  ]);

  const amd = first.gpus[0];
  assert.equal(amd.name, 'AMD Radeon RX 6800/6800 XT / 6900 XT');
  assert.equal(amd.utilization, 42);
  assert.equal(amd.memoryPercent, 25);
  assert.equal(amd.temperature, 61);
  assert.equal(amd.powerDraw, 187);
  assert.equal(amd.powerLimit, 255);
  assert.equal(amd.fan, 40);
  assert.equal(amd.fanRpm, 1400);
  assert.deepEqual([amd.clock, amd.clockMax], [2250, 2250]);
  assert.equal(amd.processes, null);

  const intel = first.gpus[1];
  assert.equal(intel.name, 'Intel UHD Graphics 770');
  assert.equal(intel.utilization, null); // ilk ölçümde karşılaştırılacak önceki değer yok
  assert.equal(intel.sharedMemory, true);
  assert.deepEqual([intel.clock, intel.clockMax], [900, 1600]);

  // Uykudaki kartın dosyaları okunmaz (okumak kartı uyandırabilir).
  assert.equal(first.gpus[2].utilization, null);

  // 1 saniyede 750 ms boşta kaldı -> yaklaşık %25 kullanım
  write(path.join(drm, 'card1', 'gt', 'gt0', 'rc6_residency_ms'), '1750');
  clock = 2000;
  const second = await collector.collect();
  assert.equal(second.gpus[1].utilization, 25);
  assert.equal(second.gpus[1].utilizationApprox, true);
});
