#!/usr/bin/env node
// Disklerin SMART bilgisini root olarak toplar ve panelin okuyacağı JSON dosyasına yazar.
// Panel yetkisiz çalıştığı için bu iş ayrı bir systemd zamanlayıcısıyla (serverhealth-smart.timer) yapılır.
// Uykudaki diskler uyandırılmaz (-n standby); onlar için son bilinen veri korunur.
//   kullanım: collect-smart.js [/var/lib/serverhealth/smart.json]
import { execFile } from 'node:child_process';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = process.argv[2] ?? '/var/lib/serverhealth/smart.json';

// Panelin kullandığı alanlar; dosya küçük kalsın diye smartctl çıktısının geri kalanı atılır.
const KEEP = [
  'device', 'model_family', 'model_name', 'serial_number', 'firmware_version', 'user_capacity', 'logical_block_size',
  'rotation_rate', 'form_factor', 'smart_status', 'temperature', 'power_on_time', 'power_cycle_count',
  'ata_smart_attributes', 'nvme_smart_health_information_log',
];
const STATISTICS = new Set(['Percentage Used Endurance Indicator']);

function smartctl(args) {
  return new Promise((resolve, reject) => {
    // smartctl uyarı durumlarında da sıfır dışı kodla çıkar; JSON yine standart çıktıdadır.
    execFile('smartctl', args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(err ?? new Error('smartctl çıktısı çözümlenemedi'));
      }
    });
  });
}

function trim(data) {
  const out = Object.fromEntries(KEEP.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
  const selfTest = data.ata_smart_data?.self_test?.status;
  if (selfTest) out.ata_smart_data = { self_test: { status: selfTest } };
  const pages = (data.ata_device_statistics?.pages ?? [])
    .map((p) => ({ table: (p.table ?? []).filter((t) => STATISTICS.has(t.name)).map(({ name, value }) => ({ name, value })) }))
    .filter((p) => p.table.length);
  if (pages.length) out.ata_device_statistics = { pages };
  return out;
}

const messages = (data) => (data.smartctl?.messages ?? []).map((m) => m.string).join(' ');

async function main() {
  let previous = [];
  try {
    previous = JSON.parse(await readFile(OUT, 'utf8')).devices ?? [];
  } catch {
    /* ilk çalıştırma */
  }

  const scan = await smartctl(['--scan-open', '--json=c']);
  const devices = [];
  for (const dev of scan.devices ?? []) {
    if (dev.open_error) continue;
    const entry = { name: dev.name, type: dev.type, standby: false, error: null, data: null };
    try {
      const data = await smartctl(['-x', '--json=c', '-n', 'standby,0', '-d', dev.type, dev.name]);
      if (/STANDBY|SLEEP/i.test(messages(data)) && !data.smart_status) {
        entry.standby = true;
        entry.data = previous.find((p) => p.name === dev.name)?.data ?? null;
      } else {
        entry.data = trim(data);
        if (!data.smart_status && !data.nvme_smart_health_information_log) entry.error = messages(data) || 'SMART desteklenmiyor';
      }
    } catch (err) {
      entry.error = err.message;
    }
    devices.push(entry);
  }

  // Panel yarım yazılmış dosya okumasın diye önce geçici dosyaya yazılıp taşınır.
  await mkdir(path.dirname(OUT), { recursive: true });
  const tmp = `${OUT}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ updated: Date.now(), smartctl: scan.smartctl?.version?.join('.') ?? null, devices })}\n`, { mode: 0o644 });
  await rename(tmp, OUT);
  console.log(`${devices.length} disk okundu: ${devices.map((d) => `${d.name}${d.standby ? ' (uykuda)' : d.error ? ' (hata)' : ''}`).join(', ')}`);
}

main().catch((err) => {
  console.error(`SMART toplanamadı: ${err.message}`);
  process.exit(1);
});
