import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGES } from '../src/messages.js';
import { WEEKDAYS } from '../src/system-settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const LANGS = ['tr', 'en', 'de', 'es', 'fr', 'ru'];

function loadBrowserDict() {
  const win = {};
  const doc = { documentElement: { lang: 'tr' }, querySelectorAll: () => [] };
  for (const lang of LANGS) new Function('window', read(`public/i18n/${lang}.js`))(win);
  new Function('window', 'document', read('public/i18n.js'))(win, doc);
  return win.I18N.DICT;
}

function assertSameKeysAndVars(dict, label) {
  for (const lang of LANGS) {
    assert.ok(dict[lang], `${label}: ${lang} sözlüğü yok`);
    assert.deepEqual(Object.keys(dict[lang]).sort(), Object.keys(dict.tr).sort(), `${label}: ${lang} anahtarları Türkçeyle aynı olmalı`);
    for (const key of Object.keys(dict.tr)) {
      assert.ok(String(dict[lang][key]).length, `${label}: ${lang} "${key}" boş`);
      assert.deepEqual(vars(dict[lang][key]), vars(dict.tr[key]), `${label}: ${lang} "${key}" aynı değişkenleri kullanmalı`);
    }
  }
}

test('arayüz sözlüğü: bütün diller aynı anahtar ve değişkenlere sahip', () => {
  const dict = loadBrowserDict();
  assertSameKeysAndVars(dict, 'arayüz');
  assert.deepEqual(Object.keys(languageNames()), LANGS);
});

function languageNames() {
  const win = {};
  new Function('window', 'document', read('public/i18n.js'))(win, { documentElement: { lang: 'en' }, querySelectorAll: () => [] });
  return win.I18N.NAMES;
}

test('arayüzde kullanılan her anahtar sözlükte var', () => {
  const dict = loadBrowserDict().tr;
  const used = new Set();
  for (const f of ['public/app.js', 'public/login.js', 'public/setup.js']) for (const m of read(f).matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(m[1]);
  for (const f of ['public/index.html', 'public/login.html', 'public/setup.html']) for (const m of read(f).matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);
  for (const s of ['code', 'language', 'account', 'services', 'review']) used.add(`setup.h.${s}`).add(`setup.sub.${s}`);
  for (const s of ['language', 'account', 'services', 'review']) used.add(`setup.step.${s}`);
  for (let i = 0; i <= 4; i++) used.add(`setup.strength.${i}`);
  // settingsCard('set.x', ...) gibi dolaylı kullanımlar ve dinamik anahtarlar
  for (const m of read('public/app.js').matchAll(/settingsCard\(\s*'([\w.]+)'/g)) used.add(m[1]);
  for (const d of ['daily', ...WEEKDAYS]) used.add(`day.${d}`);
  for (const c of ['updates', 'scheduledReboot', 'smartTests']) used.add(`hist.change.${c}`);
  for (const k of ['short', 'long']) used.add(`hist.test.${k}`);
  for (const m of read('bin/serverhealth-helper.js').matchAll(/(?:new Error|message): ?\(?'([a-z_]+)'/g)) used.add(`hist.err.${m[1]}`);
  const missing = [...used].filter((k) => !(k in dict));
  assert.deepEqual(missing, []);
});

test('sunucu metinleri: iki dil eşit ve kullanılan her anahtar var', () => {
  assertSameKeysAndVars(MESSAGES, 'sunucu');
  const files = ['src/sampler.js', ...readdirSync(path.join(ROOT, 'src/collectors')).map((f) => `src/collectors/${f}`)];
  const used = new Set();
  for (const f of files) for (const m of read(f).matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(m[1]);
  for (const m of read('src/collectors/sensors.js').matchAll(/'(sensor\.\w+|label\.\w+)'/g)) used.add(m[1]);
  assert.deepEqual([...used].filter((k) => !(k in MESSAGES.tr)), []);
});
