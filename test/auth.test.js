import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashPassword, parseHash, verifyPassword, createAuth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { effectiveConfig } from '../src/settings.js';
import { createSessions, parseCookies } from '../src/sessions.js';

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

test('şifre hash değeri doğrulanır', async () => {
  const hash = await hashPassword('dogru-sifre');
  const parsed = parseHash(hash);
  assert.ok(parsed);
  assert.equal(await verifyPassword('dogru-sifre', parsed), true);
  assert.equal(await verifyPassword('yanlis-sifre', parsed), false);
});

test('bozuk hash reddedilir', () => {
  assert.equal(parseHash(''), null);
  assert.equal(parseHash('duzsifre'), null);
  assert.equal(parseHash('scrypt$1000$8$1$c2FsdHNhbHQ=$a2V5a2V5a2V5a2V5a2V5'), null); // N 2'nin kuvveti değil
});

test('doğru kimlik geçer, 5 hatalı denemeden sonra IP kilitlenir', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const auth = createAuth({ username: 'admin', passwordHash: await hashPassword('dogru-sifre') });

  assert.deepEqual(await auth.check(undefined, '10.0.0.1'), { ok: false, status: 401 });
  assert.deepEqual(await auth.check(basic('admin', 'dogru-sifre'), '10.0.0.1'), { ok: true });
  assert.deepEqual(await auth.check(basic('baskasi', 'dogru-sifre'), '10.0.0.1'), { ok: false, status: 401, attemptsLeft: 4 });

  for (let i = 0; i < 5; i++) await auth.check(basic('admin', `yanlis${i}`), '10.0.0.2');
  const locked = await auth.check(basic('admin', 'dogru-sifre'), '10.0.0.2');
  assert.equal(locked.status, 429);
  assert.ok(locked.retryAfter > 0);

  // Kilit yalnızca o IP'yi etkiler.
  assert.deepEqual(await auth.check(basic('admin', 'dogru-sifre'), '10.0.0.3'), { ok: true });
});

test('giriş formu kalan deneme hakkını bildirir, beşinci hatada kilitler', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const auth = createAuth({ username: 'admin', passwordHash: await hashPassword('dogru-sifre') });
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await auth.login('admin', 'yanlis', '10.0.0.9'));
  assert.deepEqual(results.slice(0, 4).map((r) => r.attemptsLeft), [4, 3, 2, 1]);
  assert.equal(results[4].status, 429);
  assert.equal((await auth.login('admin', 'dogru-sifre', '10.0.0.9')).status, 429);
  assert.deepEqual(await auth.login('admin', 'dogru-sifre', '10.0.0.10'), { ok: true });
});

test('oturum çerezi oluşturulur, okunur ve kapatılır', () => {
  const sessions = createSessions();
  const cookie = sessions.create('admin', { remember: false, secure: false });
  assert.match(cookie, /^sh_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
  const header = `diger=1; ${cookie.split(';')[0]}`;
  assert.deepEqual(sessions.get(header), { user: 'admin' });
  assert.equal(sessions.get('sh_session=uydurma'), null);

  const remembered = sessions.create('admin', { remember: true, secure: true });
  assert.match(remembered, /Max-Age=2592000; Secure$/);

  assert.match(sessions.destroy(header, { secure: false }), /^sh_session=; .*Max-Age=0/);
  assert.equal(sessions.get(header), null);
  assert.deepEqual(parseCookies('a=1; b = 2;c=x=y'), { a: '1', b: '2', c: 'x=y' });
});

test('yapılandırma doğrulanır', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serverhealth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const passwordHash = await hashPassword('dogru-sifre');

  writeFileSync(file, JSON.stringify({ auth: { username: 'admin', passwordHash }, services: ['nginx', 'nginx', 'ssh.service'] }));
  const cfg = loadConfig(file);
  assert.equal(cfg.port, 8080);
  assert.deepEqual(cfg.services, ['nginx', 'ssh.service']);

  writeFileSync(file, JSON.stringify({ port: 70000, auth: { username: 'admin', passwordHash: 'duz' }, services: ['--root'] }));
  assert.throws(() => loadConfig(file), (err) => /port/.test(err.message) && /passwordHash/.test(err.message) && /services/.test(err.message));
});

test('adres değiştirerek kilitten kaçılamaz: toplam 30 hatadan sonra giriş kapanır', async () => {
  const auth = createAuth({ username: 'admin', passwordHash: await hashPassword('dogru-sifre', { N: 1024, r: 8, p: 1 }) });
  for (let i = 0; i < 30; i++) assert.equal((await auth.login('admin', 'yanlis', `127.0.0.${i + 2}`)).status, 401);
  const next = await auth.login('admin', 'dogru-sifre', '127.0.1.1'); // yeni bir adres bile
  assert.equal(next.status, 429);
  assert.ok(next.retryAfter > 0);
});

test('config.json sonradan değişirse arayüzde ayarlanan şifre geçersiz olur', () => {
  const config = { auth: { username: 'admin', passwordHash: 'A' }, disks: {}, network: {} };
  assert.equal(effectiveConfig(config, { passwordHash: 'B', passwordBase: 'A' }).auth.passwordHash, 'B');
  const reset = { ...config, auth: { username: 'admin', passwordHash: 'C' } }; // hash-password.js --set
  assert.equal(effectiveConfig(reset, { passwordHash: 'B', passwordBase: 'A' }).auth.passwordHash, 'C');
});
