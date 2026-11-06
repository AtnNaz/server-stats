#!/usr/bin/env node
// Node Stats GitHub yedeği. serverhealth-github.service (zamanlayıcı ya da "Şimdi yedekle") çalıştırır.
//   serverhealth-github-backup.js --config /var/lib/serverhealth/github-backup.json [--trigger manual]
// Token, systemd'nin LoadCredential= ile verdiği dosyadan okunur; komut satırına ya da günlüğe yazılmaz.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGithubBackup } from '../src/github-backup.js';
import { validateGithubBackup } from '../src/system-settings.js';

function parseArgs(argv) {
  const opts = { config: '/var/lib/serverhealth/github-backup.json', trigger: 'timer' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') opts.config = argv[++i];
    else if (argv[i] === '--trigger' && ['timer', 'manual'].includes(argv[i + 1])) opts.trigger = argv[++i];
    else throw new Error(`bilinmeyen seçenek: ${argv[i]}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(await readFile(opts.config, 'utf8'));
  const { errors, value } = validateGithubBackup(raw);
  if (errors.length || !value.username || !value.dir) throw new Error(`yapılandırma geçersiz: ${errors.join(', ') || 'username/dir'}`);
  const credDir = process.env.CREDENTIALS_DIRECTORY;
  const token = credDir ? (await readFile(path.join(credDir, 'github-token'), 'utf8').catch(() => '')).trim() : '';
  const stateDir = process.env.STATE_DIRECTORY?.split(':')[0] ?? '/var/lib/serverhealth-backup';
  const backup = createGithubBackup({ config: value, token, stateDir, log: (m) => console.log(m) });
  // "Şimdi yedekle" isteği systemd'nin ortam değişkeniyle gelir.
  const trigger = process.env.SERVERHEALTH_TRIGGER === 'manual' ? 'manual' : opts.trigger;
  const s = await backup.run({ trigger });
  const t = s.totals;
  console.log(t ? `GitHub yedeği bitti: ${t.repos} repo, ${t.failed} hatalı, ${t.releases} release, ${t.issues} issue/PR${s.error ? ` (${s.error})` : ''}` : `GitHub yedeği yapılamadı: ${s.error}`);
  if (!s.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`serverhealth-github-backup: ${err.message}`);
    process.exit(1);
  });
}
