import os from 'node:os';
import { t } from '../i18n.js';
import { statfs } from 'node:fs/promises';
import { percent, readText, round, withTimeout } from '../util.js';
import { globMatcher } from './network.js';

// Gerçek depolama taşıyan dosya sistemleri. proc, tmpfs, overlay (Docker), squashfs (snap) gibi sanal olanlar gösterilmez.
const DISK_FS = new Set([
  'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'bcachefs', 'zfs', 'f2fs', 'jfs', 'reiserfs',
  'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'nfs', 'nfs4', 'cifs', 'smb3', 'ceph',
  'fuse.sshfs', 'fuse.mergerfs', 'fuse.glusterfs',
]);

export function parseCpuStat(text) {
  const result = { total: null, cores: [] };
  for (const line of text.split('\n')) {
    if (!line.startsWith('cpu')) continue;
    const [label, ...fields] = line.trim().split(/\s+/);
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields.map(Number);
    const times = {
      idle: idle + iowait,
      iowait,
      steal,
      total: user + nice + system + idle + iowait + irq + softirq + steal,
    };
    if (label === 'cpu') result.total = times;
    else result.cores.push(times);
  }
  return result;
}

export function cpuUsage(prev, cur) {
  const total = cur.total - prev.total;
  if (!(total > 0)) return null;
  return {
    usage: percent(total - (cur.idle - prev.idle), total),
    iowait: percent(cur.iowait - prev.iowait, total),
    steal: percent(cur.steal - prev.steal, total),
  };
}

export function parseMeminfo(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const m = /^([\w()]+):\s+(\d+)(\s+kB)?/.exec(line);
    if (m) values[m[1]] = Number(m[2]) * (m[3] ? 1024 : 1);
  }
  return values;
}

export function memoryFromMeminfo(m) {
  const total = m.MemTotal ?? 0;
  const available = m.MemAvailable ?? (m.MemFree ?? 0) + (m.Buffers ?? 0) + (m.Cached ?? 0);
  const swapTotal = m.SwapTotal ?? 0;
  const swapUsed = swapTotal - (m.SwapFree ?? 0);
  return {
    total,
    used: total - available,
    available,
    percent: percent(total - available, total),
    cached: (m.Cached ?? 0) + (m.SReclaimable ?? 0) + (m.Buffers ?? 0),
    swapTotal,
    swapUsed,
    swapPercent: percent(swapUsed, swapTotal),
  };
}

const unescapeMount = (s) => s.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

export function parseMounts(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [source = '', mount = '', fstype = '', options = ''] = line.split(' ');
      return { source: unescapeMount(source), mount: unescapeMount(mount), fstype, readOnly: options.split(',').includes('ro') };
    })
    .filter((m) => m.mount);
}

// Aynı aygıt birden çok yere bağlıysa (btrfs alt birimleri, bind mount) tek satırda gösterilir.
// hidden ile eşleşen bağlama noktaları (varsayılan /boot, /boot/efi) hiç listelenmez.
export function selectDisks(mounts, hidden = null) {
  const bySource = new Map();
  for (const m of mounts) {
    if (!DISK_FS.has(m.fstype) || hidden?.test(m.mount)) continue;
    const existing = bySource.get(m.source);
    if (!existing) {
      bySource.set(m.source, { ...m, alsoMounted: [] });
    } else if (m.mount.length < existing.mount.length) {
      bySource.set(m.source, { ...m, alsoMounted: [existing.mount, ...existing.alsoMounted] });
    } else {
      existing.alsoMounted.push(m.mount);
    }
  }
  return [...bySource.values()].sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)));
}

async function readMounts() {
  // PID 1'in tablosu, servisin kendi ad alanındaki (PrivateTmp vb.) ek bağlamaları içermez.
  try {
    return await readText('/proc/1/mounts');
  } catch {
    return readText('/proc/self/mounts');
  }
}

// Yanıt vermeyen bir ağ diski (ör. kopmuş NFS) iş parçacığı havuzunu tüketmesin diye önceki
// statfs çağrısı bitmeden aynı bağlama noktası tekrar sorgulanmaz. Zaman aşımını geçip askıda
// kalan çağrılar en çok maxStuck olabilir (giriş doğrulaması da bu havuzu kullanır); normal,
// hızlı biten çağrılar bu sınıra sayılmaz.
export function createStatfsGuard({ statfsImpl = statfs, timeoutMs = 1500, maxStuck = 2, now = Date.now } = {}) {
  const pending = new Map(); // bağlama noktası -> başlama zamanı
  const stuck = () => [...pending.values()].filter((since) => now() - since > timeoutMs).length;
  return function query(mount) {
    if (pending.has(mount) || stuck() >= maxStuck) return Promise.reject(new Error(t('err.notResponding')));
    pending.set(mount, now());
    const request = statfsImpl(mount).finally(() => pending.delete(mount));
    return withTimeout(request, timeoutMs, t('err.notResponding'));
  };
}

export function createSystemCollector({ hide = [] } = {}) {
  const hidden = hide.length ? globMatcher(hide) : null;
  let prevCpu = null;
  let staticInfo = null;
  const queryStatfs = createStatfsGuard();

  async function hostInfo() {
    if (!staticInfo) {
      let osName = `${os.type()} ${os.release()}`;
      try {
        const m = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(await readText('/etc/os-release'));
        if (m) osName = m[1];
      } catch {
        /* os-release yoksa çekirdek adı kullanılır */
      }
      const model = os.cpus()[0]?.model?.trim();
      staticInfo = { os: osName, kernel: os.release(), arch: os.arch(), cpuModel: model && model !== 'unknown' ? model : null };
    }
    const uptime = Math.floor(os.uptime());
    return { hostname: os.hostname(), ...staticInfo, uptime };
  }

  async function diskUsage(disk) {
    const base = { mount: disk.mount, source: disk.source, fstype: disk.fstype, readOnly: disk.readOnly, alsoMounted: disk.alsoMounted };
    try {
      const s = await queryStatfs(disk.mount);
      const total = s.blocks * s.bsize;
      const used = (s.blocks - s.bfree) * s.bsize;
      const available = s.bavail * s.bsize;
      return {
        ...base,
        total,
        used,
        available,
        // df ile aynı hesap: root'a ayrılmış bloklar hariç
        percent: percent(used, used + available),
        inodesPercent: s.files > 0 ? percent(s.files - s.ffree, s.files) : null,
      };
    } catch (err) {
      return { ...base, error: err.code === 'EACCES' ? t('err.noAccess') : err.message };
    }
  }

  async function collect() {
    const [statText, memText, mountsText, host] = await Promise.all([
      readText('/proc/stat'),
      readText('/proc/meminfo'),
      readMounts(),
      hostInfo(),
    ]);

    const cpuTimes = parseCpuStat(statText);
    const total = prevCpu && cpuTimes.total ? cpuUsage(prevCpu.total, cpuTimes.total) : null;
    const cores = prevCpu ? cpuTimes.cores.map((c, i) => (prevCpu.cores[i] ? cpuUsage(prevCpu.cores[i], c)?.usage ?? null : null)) : [];
    prevCpu = cpuTimes;

    const disks = await Promise.all(selectDisks(parseMounts(mountsText), hidden).map(diskUsage));

    return {
      host,
      cpu: {
        usage: total?.usage ?? null,
        iowait: total?.iowait ?? null,
        steal: total?.steal ?? null,
        count: cpuTimes.cores.length,
        cores,
        load: os.loadavg().map((v) => round(v, 2)),
      },
      memory: memoryFromMeminfo(parseMeminfo(memText)),
      disks,
    };
  }

  return { collect };
}
