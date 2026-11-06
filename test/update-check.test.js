import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUpdateChecker, isNewer, parseVersion, repoFromUrl } from '../src/update-check.js';

test('sürüm numaraları karşılaştırılır', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(isNewer('1.10.0', '1.9.9'), true);
  assert.equal(isNewer('v1.0.0', '1.0.0'), false);
  assert.equal(isNewer('0.9.0', '1.0.0'), false);
  assert.equal(isNewer('bozuk', '1.0.0'), false);
  assert.equal(repoFromUrl('https://github.com/sahip/depo'), 'sahip/depo');
  assert.equal(repoFromUrl('https://github.com/sahip/depo.git'), 'sahip/depo');
  assert.equal(repoFromUrl('https://ornek.com/sahip/depo'), null);
});

function checker(t, respond) {
  const dir = mkdtempSync(path.join(tmpdir(), 'serverhealth-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { dir, calls, updates: createUpdateChecker({ repo: 'sahip/depo', current: '1.0.0', stateDir: dir, fetchImpl, now: () => 1700000000000 }) };
}

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('yeni sürüm bulunur, yalnızca herkese açık sürüm adresi sorulur', async (t) => {
  const { dir, calls, updates } = checker(t, () => json(200, { tag_name: 'v1.1.0', html_url: 'https://github.com/sahip/depo/releases/tag/v1.1.0' }));
  const s = await updates.check();
  assert.equal(s.available, true);
  assert.equal(s.latest, '1.1.0');
  assert.equal(s.url, 'https://github.com/sahip/depo/releases/tag/v1.1.0');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/sahip/depo/releases/latest');
  assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ['Accept', 'User-Agent']); // sunucuya dair bilgi yok
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'update-check.json'), 'utf8')).latest, '1.1.0');
});

test('aynı sürüm, yayın yok, bozuk yanıt ve yabancı bağlantı güvenle işlenir', async (t) => {
  assert.equal((await checker(t, () => json(200, { tag_name: 'v1.0.0' })).updates.check()).available, false);
  const none = await checker(t, () => json(404, {})).updates.check();
  assert.equal(none.available, false);
  assert.equal(none.error, null);
  const bad = await checker(t, () => json(200, { tag_name: '<script>' })).updates.check();
  assert.equal(bad.error, 'failed');
  const foreign = await checker(t, () => json(200, { tag_name: 'v2.0.0', html_url: 'https://kotu.example/indir' })).updates.check();
  assert.equal(foreign.url, 'https://github.com/sahip/depo/releases/latest');
  const down = await checker(t, () => {
    throw new Error('ağ yok');
  }).updates.check();
  assert.equal(down.error, 'failed');
  assert.equal(down.available, false);
});

test('denetim kapalıysa GitHub\'a istek gitmez', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serverhealth-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let called = false;
  const updates = createUpdateChecker({ repo: 'sahip/depo', current: '1.0.0', stateDir: dir, enabled: false, fetchImpl: async () => (called = true) });
  assert.equal((await updates.check()).enabled, false);
  assert.equal(called, false);
});

test('API istek sınırı dolunca son sürüm sürüm sayfası yönlendirmesinden okunur', async (t) => {
  const { calls, updates } = checker(t, () => {
    if (calls.length === 1) return { status: 403, ok: false, json: async () => ({}) };
    return { status: 302, ok: false, headers: new Headers({ location: 'https://github.com/sahip/depo/releases/tag/v1.2.0' }) };
  });
  const s = await updates.check();
  assert.deepEqual([s.error, s.latest, s.available, s.url], [null, '1.2.0', true, 'https://github.com/sahip/depo/releases/tag/v1.2.0']);
  assert.equal(calls[1].url, 'https://github.com/sahip/depo/releases/latest');
  assert.equal(calls[1].init.redirect, 'manual');
  // Başka bir yere yönlendirme kabul edilmez.
  const { updates: bad } = checker(t, () => ({ status: 302, ok: false, headers: new Headers({ location: 'https://kotu.example/releases/tag/v9.9.9' }), json: async () => ({}) }));
  assert.equal((await bad.check()).error, 'failed');
});
