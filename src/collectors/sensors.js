import { readdir, readFile, realpath } from 'node:fs/promises';
import { t } from '../i18n.js';
import path from 'node:path';

// Sıcaklık ve fan sensörleri /sys/class/hwmon'dan okunur; root gerekmez.

const read = (file) => readFile(file, 'utf8').then((s) => s.trim(), () => null);

// [sürücü adı kalıbı, başlık anahtarı, tür]
const CHIPS = [
  [/^(coretemp|k10temp|zenpower)$/, 'sensor.cpu', 'cpu'],
  [/^nvme$/, 'sensor.nvme', 'disk'],
  [/^drivetemp$/, 'sensor.disk', 'disk'],
  [/^(dell_ddv|dell_smm|thinkpad|asus.*|nct\d+|it\d+|f71.*|w83.*|applesmc)$/, 'sensor.board', 'board'],
  [/^acpitz$/, 'sensor.acpi', 'board'],
  [/^pch_/, 'sensor.chipset', 'board'],
  [/^iwlwifi/, 'sensor.wifi', 'net'],
  [/^(amdgpu|nouveau|radeon|i915|xe)$/, 'sensor.gpu', 'gpu'],
];
// Pil ve USB-C güç kaynakları sıcaklık taşımaz.
const SKIP_CHIP = /^(ucsi_source_psy|BAT|AC|ADP|hidpp_battery)/;

// Sürücünün bildirdiği etiket -> çeviri anahtarı
const LABELS = {
  'Package id 0': 'label.package',
  Composite: 'label.composite',
  CPU: 'label.cpu',
  Ambient: 'label.ambient',
  Video: 'label.video',
  Other: 'label.other',
  SODIMM: 'label.memory',
  Tctl: 'label.tctl',
  Tdie: 'label.tdie',
  edge: 'label.edge',
  junction: 'label.junction',
  mem: 'label.memory',
  'CPU Fan': 'label.cpuFan',
  'Chassis Motherboard Fan': 'label.caseFan',
  'Video Fan': 'label.gpuFan',
  'Power Supply Fan': 'label.psuFan',
};
const label = (raw) => (LABELS[raw] ? t(LABELS[raw]) : raw);

// Sürücüler "değer yok" için 0 ya da anlamsız eşikler (ör. 65261 °C) bildirebilir.
const validTemp = (v) => (v != null && v !== 0 && v > -40 && v < 150 ? v : null);
const toCelsius = (milli) => (milli == null ? null : Math.round(Number(milli) / 100) / 10);

export async function readHwmon(sysfs = '/sys') {
  const dir = path.join(sysfs, 'class', 'hwmon');
  const entries = await readdir(dir).catch(() => []);
  const chips = await Promise.all(
    entries
      .filter((e) => e.startsWith('hwmon'))
      .map(async (entry) => {
        const base = path.join(dir, entry);
        const [name, files, device] = await Promise.all([read(path.join(base, 'name')), readdir(base).catch(() => []), realpath(path.join(base, 'device')).catch(() => null)]);
        const indices = (prefix) => [...new Set(files.map((f) => new RegExp(`^${prefix}(\\d+)_input$`).exec(f)?.[1]).filter(Boolean))].map(Number).sort((a, b) => a - b);
        const temps = await Promise.all(
          indices('temp').map(async (i) => {
            const [value, label, max, crit] = await Promise.all(['input', 'label', 'max', 'crit'].map((k) => read(path.join(base, `temp${i}_${k}`))));
            return { index: i, label, value: validTemp(toCelsius(value)), max: validTemp(toCelsius(max)), crit: validTemp(toCelsius(crit)) };
          }),
        );
        const fans = await Promise.all(
          indices('fan').map(async (i) => {
            const [rpm, label, max] = await Promise.all(['input', 'label', 'max'].map((k) => read(path.join(base, `fan${i}_${k}`))));
            return { index: i, label, rpm: rpm == null ? null : Number(rpm), max: max && Number(max) > 0 ? Number(max) : null };
          }),
        );
        const model = device ? await read(path.join(device, 'model')) : null;
        return { id: entry, name: name ?? entry, model, temps, fans };
      }),
  );
  return chips;
}

// Aynı etiketten birden fazla varsa numaralandırır: "Kasa fanı 1", "Kasa fanı 2"...
function numberLabels(items) {
  const counts = {};
  for (const it of items) counts[it.label] = (counts[it.label] ?? 0) + 1;
  const seen = {};
  return items.map((it) => {
    if (counts[it.label] < 2) return it;
    seen[it.label] = (seen[it.label] ?? 0) + 1;
    return { ...it, label: `${it.label} ${seen[it.label]}` };
  });
}

export function buildSensors(chips) {
  // dell_ddv ve dell_smm aynı sensörleri bildirir; etiketli olan (dell_ddv) yeterli.
  const hasDdv = chips.some((c) => c.name === 'dell_ddv');
  const groups = [];
  let cpu = null;

  for (const chip of chips) {
    if (SKIP_CHIP.test(chip.name) || (hasDdv && chip.name === 'dell_smm')) continue;
    const [, titleKey, kind] = CHIPS.find(([re]) => re.test(chip.name)) ?? [null, null, 'other'];
    const title = titleKey ? t(titleKey) : chip.name;
    let temps = chip.temps.filter((x) => x.value != null);
    const fans = numberLabels(
      chip.fans.filter((f) => f.rpm != null).map((f) => ({ label: f.label ? label(f.label) : t('label.fanN', { n: f.index }), rpm: f.rpm, max: f.max })),
    );

    if (kind === 'cpu' && chip.name === 'coretemp') {
      // 20+ çekirdeği tek tek listelemek yerine paket, en sıcak çekirdek ve ortalama gösterilir.
      const packages = temps.filter((x) => /^Package/.test(x.label ?? ''));
      const cores = temps.filter((x) => /^Core/.test(x.label ?? ''));
      const ref = packages[0] ?? cores[0];
      const high = ref?.max ?? 80;
      const crit = ref?.crit ?? 100;
      temps = [
        ...packages.map((p, i) => ({ ...p, label: packages.length > 1 ? t('label.packageN', { n: i }) : t('label.package') })),
        ...(cores.length ? [{ label: t('label.hottestCore'), value: Math.max(...cores.map((c) => c.value)), max: high, crit }] : []),
        ...(cores.length ? [{ label: t('label.coreAvg'), value: Math.round((cores.reduce((s, c) => s + c.value, 0) / cores.length) * 10) / 10, max: high, crit }] : []),
      ];
      cpu = { package: packages[0]?.value ?? temps[0]?.value ?? null, hottestCore: cores.length ? Math.max(...cores.map((c) => c.value)) : null, high, crit };
    } else if (kind === 'cpu') {
      const main = temps.find((x) => /Tctl|Tdie/.test(x.label ?? '')) ?? temps[0];
      if (main) cpu = { package: main.value, hottestCore: null, high: main.max ?? 85, crit: main.crit ?? 95 };
    } else if (chip.name === 'nvme') {
      // NVMe'nin ek "Sensor N" değerlerinin eşikleri anlamsızdır; genel (Composite) değer yeterli.
      temps = temps.filter((x) => x.label === 'Composite' || x.index === 1).slice(0, 1);
    }

    if (!temps.length && !fans.length) continue;
    groups.push({
      id: chip.id,
      name: chip.model && kind === 'disk' ? `${title} · ${chip.model}` : title,
      kind,
      temps: numberLabels(
        temps.map((x) => ({ label: x.label ? label(x.label) : temps.length === 1 ? t('label.temperature') : t('label.sensorN', { n: x.index }), value: x.value, high: x.max, crit: x.crit })),
      ),
      fans,
    });
  }

  const order = { cpu: 0, gpu: 1, disk: 2, board: 3, net: 4, other: 5 };
  groups.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name, 'tr'));
  const diskTemps = groups.filter((g) => g.kind === 'disk').flatMap((g) => g.temps.map((x) => x.value));
  return { cpu, hottestDisk: diskTemps.length ? Math.max(...diskTemps) : null, groups };
}

export function createSensorCollector({ sysfs = '/sys' } = {}) {
  return {
    async collect() {
      return buildSensors(await readHwmon(sysfs));
    },
  };
}
