import { readFile, readdir, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// AMD (amdgpu) ve Intel (i915, xe) kartlar çekirdeğin /sys/class/drm dosyalarından okunur;
// root yetkisi ya da ek araç gerekmez. NVIDIA kartlar nvidia-smi ile ayrıca okunur.
const VENDORS = { '0x1002': 'AMD', '0x8086': 'Intel' };
const PCI_ID_FILES = ['/usr/share/misc/pci.ids', '/usr/share/hwdata/pci.ids', '/usr/share/pci.ids'];

const read = (file) => readFile(file, 'utf8').then((s) => s.trim(), () => null);

async function readNumber(file, divisor = 1) {
  const text = await read(file);
  if (text == null || text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n / divisor : null;
}

async function firstExisting(files, divisor) {
  for (const file of files) {
    const value = await readNumber(file, divisor);
    if (value != null) return value;
  }
  return null;
}

const clampPercent = (v) => (v == null ? null : Math.round(Math.min(100, Math.max(0, v)) * 10) / 10);

// pci.ids içinde satıcı satırını bulup altındaki aygıt satırlarını tarar.
export function lookupPciName(text, vendor, device) {
  const start = text.indexOf(`\n${vendor}  `);
  if (start === -1) return null;
  for (const line of text.slice(start + 1).split('\n').slice(1)) {
    if (line && !line.startsWith('\t') && !line.startsWith('#')) break; // sonraki satıcı
    if (line.startsWith(`\t${device}  `)) return line.slice(device.length + 3).trim();
  }
  return null;
}

// "Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]" -> "AMD Radeon RX 6800/6800 XT / 6900 XT"
export function marketingName(vendor, pciName) {
  if (!pciName) return null;
  const bracket = /\[([^\]]+)\]\s*$/.exec(pciName);
  return `${vendor} ${bracket ? bracket[1] : pciName}`;
}

// amdgpu pp_dpm_sclk: "0: 500Mhz\n1: 1800Mhz *" -> { current: 1800, max: 1800 }
export function parseDpmClock(text) {
  if (!text) return { current: null, max: null };
  let current = null;
  let max = null;
  for (const line of text.split('\n')) {
    const m = /^\s*\w+:\s*(\d+)\s*Mhz(\s*\*)?/i.exec(line);
    if (!m) continue;
    const mhz = Number(m[1]);
    max = Math.max(max ?? 0, mhz);
    if (m[2]) current = mhz;
  }
  return { current, max };
}

async function firstHwmon(deviceDir) {
  try {
    const entries = (await readdir(path.join(deviceDir, 'hwmon'))).filter((e) => e.startsWith('hwmon')).sort();
    return entries.length ? path.join(deviceDir, 'hwmon', entries[0]) : null;
  } catch {
    return null;
  }
}

export function createDrmGpuCollector({ sysfs = '/sys', pciIdFiles = PCI_ID_FILES, now = () => Date.now() } = {}) {
  const drmDir = path.join(sysfs, 'class', 'drm');
  const previous = new Map(); // kart -> { idle, energy, t } (oran hesapları için)
  const names = new Map();
  let pciIds;

  function pciName(vendorId, deviceId) {
    const key = `${vendorId}:${deviceId}`;
    if (!names.has(key)) {
      if (pciIds === undefined) {
        pciIds = null;
        for (const file of pciIdFiles) {
          try {
            pciIds = readFileSync(file, 'utf8');
            break;
          } catch {
            /* sıradaki konumu dene */
          }
        }
      }
      const raw = pciIds && lookupPciName(pciIds, vendorId.replace(/^0x/, ''), deviceId.replace(/^0x/, ''));
      names.set(key, marketingName(VENDORS[vendorId], raw) ?? `${VENDORS[vendorId]} GPU (${deviceId})`);
    }
    return names.get(key);
  }

  // Bir önceki ölçümle karşılaştırıp saniye başına oran üretir.
  function delta(card, key, value, t) {
    const prev = previous.get(card) ?? {};
    const result = value != null && prev[key] != null && t > prev.t && value >= prev[key] ? { amount: value - prev[key], ms: t - prev.t } : null;
    return result;
  }

  async function readAmd(card, dev, base) {
    const hwmon = await firstHwmon(dev);
    const h = (f) => (hwmon ? path.join(hwmon, f) : '/nonexistent');
    const [busy, vramTotal, vramUsed, sclk, temp, power, powerCap, pwm, rpm, productName] = await Promise.all([
      readNumber(path.join(dev, 'gpu_busy_percent')),
      readNumber(path.join(dev, 'mem_info_vram_total')),
      readNumber(path.join(dev, 'mem_info_vram_used')),
      read(path.join(dev, 'pp_dpm_sclk')),
      readNumber(h('temp1_input'), 1000),
      firstExisting([h('power1_average'), h('power1_input')], 1e6),
      readNumber(h('power1_cap'), 1e6),
      readNumber(h('pwm1')),
      readNumber(h('fan1_input')),
      read(path.join(dev, 'product_name')),
    ]);
    const clock = parseDpmClock(sclk);
    return {
      ...base,
      name: productName || base.name,
      utilization: clampPercent(busy),
      memoryTotal: vramTotal,
      memoryUsed: vramUsed,
      memoryPercent: vramTotal ? clampPercent((vramUsed / vramTotal) * 100) : null,
      temperature: temp,
      powerDraw: power,
      powerLimit: powerCap || null,
      fan: pwm == null ? null : clampPercent((pwm / 255) * 100),
      fanRpm: rpm,
      clock: clock.current,
      clockMax: clock.max,
    };
  }

  async function readIntel(card, dev, base, driver, t) {
    const cardDir = path.join(drmDir, card);
    // Kullanım, grafik biriminin uyku (RC6 / gtidle) sayacındaki artıştan yaklaşık hesaplanır.
    const idleFiles =
      driver === 'xe'
        ? [path.join(dev, 'tile0', 'gt0', 'gtidle', 'idle_residency_ms')]
        : [path.join(cardDir, 'gt', 'gt0', 'rc6_residency_ms'), path.join(cardDir, 'power', 'rc6_residency_ms')];
    const actFiles =
      driver === 'xe'
        ? [path.join(dev, 'tile0', 'gt0', 'freq0', 'act_freq')]
        : [path.join(cardDir, 'gt', 'gt0', 'rps_act_freq_mhz'), path.join(cardDir, 'gt_act_freq_mhz')];
    const maxFiles =
      driver === 'xe'
        ? [path.join(dev, 'tile0', 'gt0', 'freq0', 'rp0_freq')]
        : [path.join(cardDir, 'gt_RP0_freq_mhz'), path.join(cardDir, 'gt_max_freq_mhz')];
    const hwmon = await firstHwmon(dev);
    const [idle, act, max, temp, energy, powerCap] = await Promise.all([
      firstExisting(idleFiles),
      firstExisting(actFiles),
      firstExisting(maxFiles),
      hwmon ? firstExisting([path.join(hwmon, 'temp1_input'), path.join(hwmon, 'temp2_input')], 1000) : null,
      hwmon ? readNumber(path.join(hwmon, 'energy1_input')) : null, // mikrojoule
      hwmon ? readNumber(path.join(hwmon, 'power1_max'), 1e6) : null,
    ]);
    const idleDelta = delta(card, 'idle', idle, t);
    const energyDelta = delta(card, 'energy', energy, t);
    previous.set(card, { idle, energy, t });
    const integrated = path.basename(dev) === '0000:00:02.0';
    return {
      ...base,
      utilization: idleDelta ? clampPercent(100 - (idleDelta.amount / idleDelta.ms) * 100) : null,
      utilizationApprox: true,
      sharedMemory: integrated,
      temperature: temp,
      powerDraw: energyDelta ? Math.round((energyDelta.amount / 1e6 / (energyDelta.ms / 1000)) * 10) / 10 : null,
      powerLimit: powerCap || null,
      clock: act,
      clockMax: max,
    };
  }

  async function readCard(card, t) {
    const dev = await realpath(path.join(drmDir, card, 'device')).catch(() => null);
    if (!dev) return null;
    const driver = await realpath(path.join(dev, 'driver')).then((p) => path.basename(p), () => null);
    if (!['amdgpu', 'i915', 'xe'].includes(driver)) return null;
    const [vendorId, deviceId, runtime] = await Promise.all([
      read(path.join(dev, 'vendor')),
      read(path.join(dev, 'device')),
      read(path.join(dev, 'power', 'runtime_status')),
    ]);
    if (!VENDORS[vendorId]) return null;

    const base = {
      id: card,
      vendor: VENDORS[vendorId],
      name: pciName(vendorId, deviceId ?? ''),
      driver,
      driverVersion: null,
      state: runtime === 'suspended' ? 'suspended' : 'active',
      utilization: null,
      utilizationApprox: false,
      memoryTotal: null,
      memoryUsed: null,
      memoryPercent: null,
      sharedMemory: false,
      temperature: null,
      powerDraw: null,
      powerLimit: null,
      fan: null,
      fanRpm: null,
      clock: null,
      clockMax: null,
      pstate: null,
      processes: null, // süreç başına VRAM yalnızca NVIDIA için okunabiliyor
    };
    // Güç tasarrufu için uyuyan bir kartın dosyalarını okumak onu uyandırabilir; dokunulmaz.
    if (base.state === 'suspended') {
      previous.delete(card);
      return base;
    }
    return driver === 'amdgpu' ? readAmd(card, dev, base) : readIntel(card, dev, base, driver, t);
  }

  async function listCards() {
    try {
      return (await readdir(drmDir)).filter((e) => /^card\d+$/.test(e)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
    } catch {
      return [];
    }
  }

  return {
    listCards,
    async collect() {
      const t = now();
      const gpus = await Promise.all((await listCards()).map((card) => readCard(card, t)));
      return { gpus: gpus.filter(Boolean) };
    },
  };
}
