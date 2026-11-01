import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { t } from '../i18n.js';
import path from 'node:path';
import { readText } from '../util.js';

// Fiziksel diskler: kimlik ve tür /sys/block'tan, okuma/yazma hızı /proc/diskstats'tan,
// sağlık bilgisi root zamanlayıcısının yazdığı SMART dosyasından okunur.
const SECTOR = 512;
const SKIP_DEVICES = /^(loop|ram|zram|sr|fd|dm-|md|nbd|zd)/;

const read = (file) => readFile(file, 'utf8').then((s) => s.trim(), () => null);

export function parseDiskstats(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    out[f[2]] = {
      readIos: Number(f[3]),
      readSectors: Number(f[5]),
      writeIos: Number(f[7]),
      writeSectors: Number(f[9]),
      ioMs: Number(f[12]),
    };
  }
  return out;
}

// /proc/self/mountinfo: "id parent major:minor root mountpoint ... - fstype source ..."
export function parseMountinfo(text) {
  const unescape = (s) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const f = line.split(' ');
      const sep = f.indexOf('-');
      return { devno: f[2], mount: unescape(f[4] ?? ''), fstype: f[sep + 1] };
    })
    .filter((m) => m.devno && m.mount);
}

// Bir blok aygıtın oturduğu fiziksel diskleri bulur (bölüm -> disk, LVM/RAID -> alt diskler).
async function physicalDisks(sysfs, blockDir, depth = 0) {
  if (depth > 4) return [];
  const name = path.basename(blockDir);
  try {
    await stat(path.join(blockDir, 'partition'));
    return [path.basename(path.dirname(blockDir))];
  } catch {
    /* bölüm değil */
  }
  const slaves = await readdir(path.join(blockDir, 'slaves')).catch(() => []);
  if (!slaves.length) return [name];
  const nested = await Promise.all(
    slaves.map(async (s) => physicalDisks(sysfs, await realpath(path.join(sysfs, 'class', 'block', s)).catch(() => ''), depth + 1)),
  );
  return [...new Set(nested.flat().filter(Boolean))];
}

// --- SMART özeti ---

const attr = (data, id) => data.ata_smart_attributes?.table?.find((a) => a.id === id);
const rawValue = (a) => (a ? Number(a.raw?.value ?? 0) : null);

function ataStatistic(data, name) {
  for (const page of data.ata_device_statistics?.pages ?? []) {
    const entry = page.table?.find((t) => t.name === name);
    if (entry && entry.value != null) return Number(entry.value);
  }
  return null;
}

// smartctl JSON çıktısından durum (ok / warn / crit) ve okunur gerekçeler üretir.
export function summarizeSmart(data) {
  const nvme = data.nvme_smart_health_information_log;
  const passed = data.smart_status?.passed ?? null;
  const reasons = { crit: [], warn: [] };
  const summary = {
    passed,
    temperature: data.temperature?.current ?? nvme?.temperature ?? null,
    powerOnHours: data.power_on_time?.hours ?? nvme?.power_on_hours ?? null,
    powerCycles: data.power_cycle_count ?? nvme?.power_cycles ?? null,
    wearPercent: null,
    writtenBytes: null,
    selfTest: data.ata_smart_data?.self_test?.status?.string ?? null,
    attributes: {},
  };

  if (passed === false) reasons.crit.push(t('smart.failed'));

  if (nvme) {
    summary.wearPercent = nvme.percentage_used ?? null;
    summary.writtenBytes = nvme.data_units_written != null ? nvme.data_units_written * 512000 : null;
    Object.assign(summary.attributes, {
      availableSpare: nvme.available_spare,
      spareThreshold: nvme.available_spare_threshold,
      mediaErrors: nvme.media_errors,
      unsafeShutdowns: nvme.unsafe_shutdowns,
      errorLogEntries: nvme.num_err_log_entries,
    });
    if (nvme.critical_warning) reasons.crit.push(t('smart.criticalWarning', { flag: `0x${nvme.critical_warning.toString(16)}` }));
    if (nvme.available_spare != null && nvme.available_spare_threshold != null && nvme.available_spare < nvme.available_spare_threshold) {
      reasons.crit.push(t('smart.spareLow', { p: nvme.available_spare }));
    }
    if (nvme.media_errors > 0) reasons.warn.push(t('smart.mediaErrors', { n: nvme.media_errors }));
  } else if (data.ata_smart_attributes) {
    const reallocated = rawValue(attr(data, 5));
    const reportedUncorrect = rawValue(attr(data, 187));
    const pending = rawValue(attr(data, 197));
    const offlineUncorrectable = rawValue(attr(data, 198));
    const crc = rawValue(attr(data, 199));
    Object.assign(summary.attributes, { reallocated, reportedUncorrect, pending, offlineUncorrectable, crcErrors: crc });
    if (pending > 0) reasons.crit.push(t('smart.pending', { n: pending }));
    if (offlineUncorrectable > 0) reasons.crit.push(t('smart.offline', { n: offlineUncorrectable }));
    if (reallocated > 0) reasons.warn.push(t('smart.reallocated', { n: reallocated }));
    if (reportedUncorrect > 0) reasons.warn.push(t('smart.reported', { n: reportedUncorrect }));
    if (crc > 0) reasons.warn.push(t('smart.crc', { n: crc }));
    for (const a of data.ata_smart_attributes.table ?? []) {
      if (a.when_failed === 'now') reasons.crit.push(t('smart.attrFailing', { name: a.name }));
    }
    summary.wearPercent = ataStatistic(data, 'Percentage Used Endurance Indicator');
    const lbas = attr(data, 241);
    if (lbas?.name === 'Total_LBAs_Written') summary.writtenBytes = rawValue(lbas) * (data.logical_block_size ?? SECTOR);
  }

  if (summary.wearPercent != null) {
    if (summary.wearPercent >= 100) reasons.crit.push(t('smart.wornOut', { p: summary.wearPercent }));
    else if (summary.wearPercent >= 80) reasons.warn.push(t('smart.wear', { p: summary.wearPercent }));
  }
  if (summary.temperature != null && summary.temperature >= 60) reasons.warn.push(t('smart.hot', { c: summary.temperature }));

  summary.status = reasons.crit.length ? 'crit' : reasons.warn.length ? 'warn' : passed === null ? 'unknown' : 'ok';
  summary.reasons = [...reasons.crit, ...reasons.warn];
  return summary;
}

// Aygıt adları açılışta değişebilir; model tutmuyorsa SMART kaydı bu diske ait sayılmaz.
// Uykudaki diskte son bilinen sağlık durumu korunur, yalnızca "uykuda" işareti eklenir.
export function smartFor(entries, name, model) {
  // smartctl NVMe diskleri denetleyici adıyla bildirir: nvme0n1 diskinin kaydı /dev/nvme0'dır.
  const controller = /^(nvme\d+)n\d+$/.exec(name)?.[1];
  const entry = entries.find((d) => d.name === `/dev/${name}`) ?? (controller ? entries.find((d) => d.name === `/dev/${controller}`) : null);
  if (!entry) return null;
  const smartModel = entry.data?.model_name?.replace(/\s+/g, ' ');
  if (smartModel && model && !smartModel.startsWith(model)) return null;
  const summary = entry.data ? summarizeSmart(entry.data) : { status: 'unknown', reasons: [entry.error ?? t('smart.unreadable')] };
  return { ...summary, standby: Boolean(entry.standby) };
}

export function createStorageCollector({ sysfs = '/sys', proc = '/proc', smartFile = '/var/lib/serverhealth/smart.json', hidden = null } = {}) {
  let prev = null;
  let prevTime = 0;
  let smartCache = { mtimeMs: -1, value: null };

  async function readSmart() {
    try {
      const { mtimeMs } = await stat(smartFile);
      if (mtimeMs !== smartCache.mtimeMs) {
        const parsed = JSON.parse(await readFile(smartFile, 'utf8'));
        smartCache = { mtimeMs, value: { available: true, updated: parsed.updated ?? mtimeMs, devices: parsed.devices ?? [] } };
      }
      return smartCache.value;
    } catch (err) {
      smartCache = { mtimeMs: -1, value: null };
      return { available: false, reason: err.code === 'ENOENT' ? 'missing' : err.message };
    }
  }

  async function describe(name) {
    const dir = path.join(sysfs, 'block', name);
    const [model, size, rotational, removable, link, serial] = await Promise.all([
      read(path.join(dir, 'device', 'model')),
      read(path.join(dir, 'size')),
      read(path.join(dir, 'queue', 'rotational')),
      read(path.join(dir, 'removable')),
      realpath(dir).catch(() => dir),
      read(path.join(dir, 'device', 'serial')),
    ]);
    const nvme = name.startsWith('nvme');
    const usb = link.includes('/usb');
    const type = nvme ? 'NVMe SSD' : usb ? 'USB' : rotational === '1' ? 'HDD' : 'SATA SSD';
    return { name, model: model?.replace(/\s+/g, ' ') || name, serial: serial || null, size: Number(size) * SECTOR, type, removable: removable === '1' };
  }

  async function collect() {
    const now = Date.now();
    const names = (await readdir(path.join(sysfs, 'block'))).filter((n) => !SKIP_DEVICES.test(n));
    const [statsText, mountText, smart] = await Promise.all([
      readText(path.join(proc, 'diskstats')),
      readText(path.join(proc, '1', 'mountinfo')).catch(() => readText(path.join(proc, 'self', 'mountinfo'))),
      readSmart(),
    ]);
    const stats = parseDiskstats(statsText);
    const elapsed = prevTime ? (now - prevTime) / 1000 : 0;

    // Her bağlama noktasını fiziksel diskine eşle.
    const mountsByDisk = {};
    for (const m of parseMountinfo(mountText)) {
      if (hidden?.test(m.mount)) continue;
      const blockDir = await realpath(path.join(sysfs, 'dev', 'block', m.devno)).catch(() => null);
      if (!blockDir) continue;
      for (const disk of await physicalDisks(sysfs, blockDir)) {
        (mountsByDisk[disk] ??= new Set()).add(m.mount);
      }
    }

    const devices = await Promise.all(
      names.map(async (name) => {
        const info = await describe(name);
        const cur = stats[name];
        const old = prev?.[name];
        const rate = (key, scale = 1) => (elapsed > 0 && cur && old && cur[key] >= old[key] ? Math.round(((cur[key] - old[key]) * scale) / elapsed) : null);
        return {
          ...info,
          mounts: [...(mountsByDisk[name] ?? [])].sort(),
          readRate: rate('readSectors', SECTOR),
          writeRate: rate('writeSectors', SECTOR),
          iops: elapsed > 0 && cur && old ? Math.round((cur.readIos + cur.writeIos - old.readIos - old.writeIos) / elapsed) : null,
          busy: elapsed > 0 && cur && old ? Math.min(100, Math.round(((cur.ioMs - old.ioMs) / (elapsed * 1000)) * 1000) / 10) : null,
          smart: smart.available ? smartFor(smart.devices, name, info.model) : null,
        };
      }),
    );
    prev = stats;
    prevTime = now;

    return {
      devices: devices.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
      smart: smart.available ? { available: true, updated: smart.updated } : { available: false, reason: smart.reason },
    };
  }

  return { collect };
}
