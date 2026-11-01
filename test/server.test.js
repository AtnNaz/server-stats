import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function startServer(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'serverhealth-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const file = path.join(dir, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({ host: '127.0.0.1', port, auth: { username: 'admin', passwordHash: await hashPassword('dogru-sifre') }, system: { statusFile: path.join(dir, 'system.json') } }),
  );
  const env = { ...process.env, STATE_DIRECTORY: path.join(dir, 'state') };
  const child = spawn(process.execPath, ['src/server.js', '--config', file], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => String(chunk).includes('çalışıyor') && resolve());
    child.on('exit', (code) => reject(new Error(`sunucu kapandı (${code})`)));
  });
  return { base: `http://127.0.0.1:${port}`, dir };
}

const login = (base, body, headers = { Origin: base }) =>
  fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('giriş akışı: yönlendirme, giriş, çerez, çıkış ve Basic Auth', async (t) => {
  const { base } = await startServer(t);

  const root = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/login');

  const page = await fetch(`${base}/login`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Oturum açın/);

  const anonymous = await fetch(`${base}/api/stats`);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('www-authenticate'), null); // tarayıcı kendi penceresini açmasın

  assert.equal((await login(base, { username: 'admin', password: 'dogru-sifre' }, {})).status, 403); // Origin yok
  assert.equal((await login(base, { username: 'admin', password: 'dogru-sifre' }, { Origin: 'http://kotu.example' })).status, 403);

  const wrong = await login(base, { username: 'admin', password: 'yanlis' });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).attemptsLeft, 4);

  const ok = await login(base, { username: 'admin', password: 'dogru-sifre', remember: true });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Max-Age=2592000/);
  const cookie = setCookie.split(';')[0];

  const stats = await fetch(`${base}/api/stats`, { headers: { Cookie: cookie } });
  assert.equal(stats.status, 200);
  const data = await stats.json();
  assert.equal(data.user, 'admin');
  assert.ok('snapshot' in data && 'history' in data);

  const again = await fetch(`${base}/login`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(again.status, 302);
  assert.equal(again.headers.get('location'), '/');

  const basic = await fetch(`${base}/`, { headers: { Authorization: `Basic ${Buffer.from('admin:dogru-sifre').toString('base64')}` } });
  assert.equal(basic.status, 200);

  const logout = await fetch(`${base}/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: base } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(`${base}/api/stats`, { headers: { Cookie: cookie } })).status, 401);
});

const post = (base, pathname, body, cookie) =>
  fetch(`${base}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie && { Cookie: cookie }) }, body: JSON.stringify(body) });

async function signIn(base, password = 'dogru-sifre') {
  const res = await login(base, { username: 'admin', password });
  return res.ok ? res.headers.get('set-cookie').split(';')[0] : null;
}

test('ayarlar: kaydetme, dil, şifre değiştirme ve sistem isteği kuyruğu', async (t) => {
  const { base, dir } = await startServer(t);
  const cookie = await signIn(base);
  const basic = { Authorization: `Basic ${Buffer.from('admin:dogru-sifre').toString('base64')}` };

  const initial = await (await fetch(`${base}/api/settings`, { headers: { Cookie: cookie } })).json();
  assert.equal(initial.panel.language, 'tr');
  assert.equal(initial.system.available, false); // root yardımcısı bu testte yok
  assert.equal('passwordHash' in initial.panel, false);
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(initial.about.version, pkg.version); // Hakkında bölümü sürümü package.json'dan alır
  assert.equal(initial.about.author.name, pkg.author.name);

  // Geçersiz alan ve değerler reddedilir; Basic Auth ile ayar değiştirilemez.
  assert.equal((await post(base, '/api/settings', { intervalSeconds: 7 }, cookie)).status, 400);
  assert.equal((await post(base, '/api/settings', { shell: 'id' }, cookie)).status, 400);
  const viaBasic = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...basic }, body: '{}' });
  assert.equal(viaBasic.status, 401);

  const saved = await post(base, '/api/settings', { language: 'en', intervalSeconds: 5, thresholds: { disk: [70, 90] }, services: ['ssh', 'nginx'] }, cookie);
  assert.equal(saved.status, 200);
  const panel = (await saved.json()).panel;
  assert.equal(panel.intervalSeconds, 5);
  assert.deepEqual(panel.thresholds.disk, [70, 90]);
  assert.deepEqual(panel.thresholds.cpu, [80, 95]); // verilmeyen eşikler varsayılan kalır
  assert.equal((await (await fetch(`${base}/api/lang`)).json()).language, 'en');
  assert.match(await (await fetch(`${base}/login`)).text(), /<html lang="en">/);
  const stats = await (await fetch(`${base}/api/stats`, { headers: { Cookie: cookie } })).json();
  assert.equal(stats.intervalSeconds, 5); // örnekleyici yeni ayarla yeniden kuruldu

  // Sistem isteği doğrulanıp kuyruğa yazılır; geçersiz olan yazılmaz.
  assert.equal((await post(base, '/api/system', { rebootTime: '25:00' }, cookie)).status, 400);
  assert.equal((await post(base, '/api/actions', { action: 'rm -rf /' }, cookie)).status, 400);
  assert.equal((await post(base, '/api/system', { scheduledReboot: { enabled: true, day: 'sun', time: '04:00' } }, cookie)).status, 202);
  assert.equal((await post(base, '/api/actions', { action: 'refresh' }, cookie)).status, 202);
  const queue = path.join(dir, 'state', 'queue');
  const files = readdirSync(queue).sort();
  assert.equal(files.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(path.join(queue, files[0]), 'utf8')).settings.scheduledReboot, { enabled: true, day: 'sun', time: '04:00' });

  // Şifre değiştirme: mevcut şifre doğrulanır, eski şifre artık çalışmaz, diğer oturumlar kapanır.
  const other = await signIn(base);
  assert.equal((await post(base, '/api/password', { current: 'yanlis', next: 'yeni-sifre-123' }, cookie)).status, 401);
  assert.equal((await post(base, '/api/password', { current: 'dogru-sifre', next: 'kisa' }, cookie)).status, 400);
  assert.equal((await post(base, '/api/password', { current: 'dogru-sifre', next: 'yeni-sifre-123' }, cookie)).status, 200);
  assert.equal(await signIn(base, 'dogru-sifre'), null);
  assert.ok(await signIn(base, 'yeni-sifre-123'));
  assert.equal((await fetch(`${base}/api/stats`, { headers: { Cookie: other } })).status, 401);
  assert.equal((await fetch(`${base}/api/stats`, { headers: { Cookie: cookie } })).status, 200);
});
