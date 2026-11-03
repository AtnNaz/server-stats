import { createSystemCollector } from './collectors/system.js';
import { t } from './i18n.js';
import { createNetworkCollector } from './collectors/network.js';
import { createProcessCollector } from './collectors/processes.js';
import { createServiceCollector } from './collectors/services.js';
import { createDockerCollector } from './collectors/docker.js';
import { createGpuCollector } from './collectors/gpu.js';
import { createStorageCollector } from './collectors/storage.js';
import { createSensorCollector } from './collectors/sensors.js';
import { globMatcher } from './collectors/network.js';
import { withTimeout } from './util.js';

const COLLECT_TIMEOUT_MS = 2500;

// SATA disklerin sıcaklığı sensör olarak görünmez, yalnızca SMART'tan gelir; ikisi birlikte değerlendirilir.
function hottestDisk(s) {
  const temps = [s.sensors?.hottestDisk, ...(s.storage?.devices ?? []).map((d) => d.smart?.temperature)].filter((t) => t != null);
  return temps.length ? Math.max(...temps) : null;
}

function historyPoint(s) {
  return {
    t: s.time,
    cpu: s.system?.cpu?.usage ?? null,
    mem: s.system?.memory?.percent ?? null,
    swap: s.system?.memory?.swapPercent ?? null,
    net: Object.fromEntries((s.network?.interfaces ?? []).map((i) => [i.name, [i.rxRate, i.txRate]])),
    gpu: Object.fromEntries((s.gpu?.gpus ?? []).map((g) => [g.id, [g.utilization, g.memoryPercent]])),
    io: Object.fromEntries((s.storage?.devices ?? []).map((d) => [d.name, [d.readRate, d.writeRate]])),
    temp: [s.sensors?.cpu?.package ?? null, hottestDisk(s)],
  };
}

// Verileri arka planda düzenli aralıkla toplar; istekler yalnızca son anlık görüntüyü okur.
export function createSampler(config, { onSample } = {}) {
  const intervalMs = config.intervalSeconds * 1000;
  const historySize = Math.ceil((config.historyMinutes * 60) / config.intervalSeconds);
  const gpu = config.gpu.enabled ? createGpuCollector() : null;
  const collectors = {
    system: createSystemCollector(config.disks),
    network: createNetworkCollector(config.network),
    storage: createStorageCollector({
      smartFile: config.smart.file,
      hidden: config.disks.hide.length ? globMatcher(config.disks.hide) : null,
    }),
    sensors: createSensorCollector(),
    processes: createProcessCollector(config.processes),
    services: createServiceCollector(config.services),
    ...(config.docker.enabled && { docker: createDockerCollector(config.docker) }),
    ...(gpu && { gpu }),
  };
  const lastErrors = {};
  const history = [];
  let snapshot = null;
  let timer = null;
  let stopped = false;
  let first = true;

  function logChange(name, message) {
    if (message === (lastErrors[name] ?? null)) return;
    if (message) console.warn(`[${name}] ${message}`);
    else console.log(`[${name}] yeniden çalışıyor`);
    lastErrors[name] = message;
  }

  // Zaman aşımı yalnızca beklemeyi bırakır; önceki toplama bitmeden aynı toplayıcı yeniden
  // başlatılmaz, böylece iptal edilemeyen okumalar turdan tura birikmez.
  const running = new Set();

  async function tick() {
    const started = Date.now();
    const results = await Promise.all(
      Object.entries(collectors).map(([name, c]) => {
        if (running.has(name)) return [name, { error: t('err.timeout') }];
        running.add(name);
        const work = c.collect().finally(() => running.delete(name));
        return withTimeout(work, COLLECT_TIMEOUT_MS, t('err.timeout')).then(
          (value) => [name, value],
          (err) => [name, { error: err.message }],
        );
      }),
    );
    for (const [name, value] of results) logChange(name, value.error ?? value.warning ?? null);

    snapshot = { time: started, ...Object.fromEntries(results) };
    if (!config.docker.enabled) snapshot.docker = { disabled: true };
    if (!gpu) snapshot.gpu = { disabled: true };
    history.push(historyPoint(snapshot));
    if (history.length > historySize) history.shift();
    try {
      onSample?.(snapshot);
    } catch (err) {
      console.warn(`Örnek kaydedilemedi: ${err.message}`);
    }

    if (stopped) return;
    // İlk örnek yalnızca sayaçları hazırlar; oranlar için ikinci örneği hızlıca al.
    const delay = first ? 1000 : Math.max(250, intervalMs - (Date.now() - started));
    first = false;
    timer = setTimeout(tick, delay);
  }

  return {
    start() {
      tick();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    current() {
      return { intervalSeconds: config.intervalSeconds, historySize, snapshot, history };
    },
  };
}
