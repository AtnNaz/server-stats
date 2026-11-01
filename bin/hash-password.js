#!/usr/bin/env node
// Panel şifresi için scrypt hash üretir.
//   node bin/hash-password.js                                → hash'i ekrana yazar
//   node bin/hash-password.js --set config.json [--user ad]  → hash'i doğrudan yapılandırmaya yazar
// Şifre terminalden gizli olarak sorulur ya da standart girdiden okunur.
import { readFile, writeFile } from 'node:fs/promises';
import { hashPassword } from '../src/auth.js';

const MIN_LENGTH = 8;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readHidden(prompt) {
  return new Promise((resolve) => {
    const { stdin, stderr } = process;
    let value = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stderr.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stderr.write(prompt);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.split(/\r?\n/)[0];
}

async function main() {
  const target = arg('--set');
  const user = arg('--user');

  let password;
  if (process.stdin.isTTY) {
    password = await readHidden('Şifre: ');
    if (password !== (await readHidden('Şifre (tekrar): '))) fail('Şifreler eşleşmiyor.');
  } else {
    password = await readStdin();
  }
  if (password.length < MIN_LENGTH) fail(`Şifre en az ${MIN_LENGTH} karakter olmalı.`);

  const hash = await hashPassword(password);
  if (!target) {
    console.log(hash);
    console.error('Bu değeri config.json içindeki auth.passwordHash alanına yapıştırın.');
    return;
  }

  let config;
  try {
    config = JSON.parse(await readFile(target, 'utf8'));
  } catch (err) {
    fail(`${target} okunamadı: ${err.message}`);
  }
  config.auth = { ...config.auth, ...(user && { username: user }), passwordHash: hash };
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`);
  console.error(`Şifre ${target} dosyasına yazıldı (kullanıcı: ${config.auth.username}).`);
}

main();
