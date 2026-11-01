import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { createDrmGpuCollector } from './gpu-drm.js';

const MIB = 1024 * 1024;

// İsimden sonra gelen alanların sayısı sabittir; GPU adı virgül içerse bile doğru bölünür.
const GPU_FIELDS = [
  'index', 'uuid', 'name',
  'driver_version', 'utilization.gpu', 'utilization.memory', 'memory.total', 'memory.used',
  'temperature.gpu', 'power.draw', 'power.limit', 'fan.speed', 'clocks.sm', 'clocks.max.sm', 'pstate',
];
const TAIL_FIELDS = GPU_FIELDS.length - 3;

// "[N/A]", "[Not Supported]" gibi değerler desteklenmeyen ölçümlerdir.
const toNumber = (v) => {
  const t = (v ?? '').trim();
  if (!t || /^\[.*\]$/.test(t) || t === 'N/A') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const percent = (part, whole) => (part != null && whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export function parseGpus(text) {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const f = line.split(',').map((s) => s.trim());
      const [driverVersion, util, memUtil, memTotal, memUsed, temp, powerDraw, powerLimit, fan, clock, clockMax, pstate] = f.slice(-TAIL_FIELDS);
      const index = toNumber(f[0]);
      const total = toNumber(memTotal);
      const used = toNumber(memUsed);
      return {
        id: `nvidia${index}`,
        uuid: f[1],
        vendor: 'NVIDIA',
        name: f.slice(2, f.length - TAIL_FIELDS).join(', '),
        driver: 'nvidia',
        driverVersion,
        state: 'active',
        utilization: toNumber(util),
        utilizationApprox: false,
        memoryUtilization: toNumber(memUtil),
        memoryTotal: total == null ? null : total * MIB,
        memoryUsed: used == null ? null : used * MIB,
        memoryPercent: percent(used, total),
        sharedMemory: false,
        temperature: toNumber(temp),
        powerDraw: toNumber(powerDraw),
        powerLimit: toNumber(powerLimit),
        fan: toNumber(fan),
        fanRpm: null,
        clock: toNumber(clock),
        clockMax: toNumber(clockMax),
        pstate: pstate && !/^\[/.test(pstate) ? pstate : null,
      };
    });
}

export function parseGpuApps(text) {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const f = line.split(',').map((s) => s.trim());
      const command = f.slice(2, -1).join(', ');
      const memory = toNumber(f[f.length - 1]);
      return { uuid: f[0], pid: toNumber(f[1]), name: path.basename(command) || command, command, memory: memory == null ? null : memory * MIB };
    })
    .filter((a) => a.pid != null);
}

export function findExecutable(name, searchPath = process.env.PATH ?? '') {
  for (const dir of searchPath.split(':').filter(Boolean)) {
    const file = path.join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      /* bu dizinde yok */
    }
  }
  return null;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 2000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      // nvidia-smi hata iletisini çoğunlukla standart çıktıya yazar.
      const message = (stdout || stderr || err.message).trim().split('\n')[0];
      reject(new Error(`nvidia-smi: ${message}`));
    });
  });
}

export function createNvidiaCollector() {
  const bin = findExecutable('nvidia-smi');
  if (!bin) return null;
  const gpuArgs = [`--query-gpu=${GPU_FIELDS.join(',')}`, '--format=csv,noheader,nounits'];
  const appArgs = ['--query-compute-apps=gpu_uuid,pid,process_name,used_memory', '--format=csv,noheader,nounits'];

  return {
    async collect() {
      const [gpuText, appText] = await Promise.all([run(bin, gpuArgs), run(bin, appArgs).catch(() => '')]);
      const apps = parseGpuApps(appText);
      const gpus = parseGpus(gpuText).map(({ uuid, ...gpu }) => ({
        ...gpu,
        processes: apps
          .filter((a) => a.uuid === uuid)
          .map(({ uuid: _uuid, ...a }) => a)
          .sort((a, b) => (b.memory ?? 0) - (a.memory ?? 0)),
      }));
      return { gpus };
    },
  };
}

// NVIDIA (nvidia-smi) ve AMD/Intel (sysfs) kartlarını tek listede birleştirir.
// Biri hata verirse diğerinin kartları yine gösterilir; hata iletisi "warning" alanında taşınır.
export function createGpuCollector(options = {}) {
  const sources = [createNvidiaCollector(), createDrmGpuCollector(options)].filter(Boolean);
  return {
    async collect() {
      const results = await Promise.allSettled(sources.map((s) => s.collect()));
      const gpus = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.gpus : []));
      const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
      if (failures.length && !gpus.length) throw new Error(failures[0]);
      return failures.length ? { gpus, warning: failures.join('; ') } : { gpus };
    },
  };
}
