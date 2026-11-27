import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UNIT_NAME } from './collectors/services.js';

export const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const CODE = /^[a-f0-9]{32}$/;
const MAX_FAILURES = 20;
const LOCK_MS = 10 * 60_000;

export function pickLanguage(header, languages, fallback = 'en') {
  const wanted = String(header ?? '')
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { lang: tag.toLowerCase().split('-')[0], q: q === undefined ? 1 : Number(q) || 0 };
    })
    .filter((x) => x.lang && x.q > 0)
    .sort((a, b) => b.q - a.q);
  return wanted.find((x) => languages.includes(x.lang))?.lang ?? fallback;
}

export function validateSetup(body, { languages }) {
  const errors = [];
  const value = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: ['invalid'], value };
  if (languages.includes(body.language)) value.language = body.language;
  else errors.push('language');
  if (typeof body.username === 'string' && USERNAME.test(body.username)) value.username = body.username;
  else errors.push('username');
  if (typeof body.password === 'string' && body.password.length >= 8 && body.password.length <= 200) value.password = body.password;
  else errors.push('password');
  if (Array.isArray(body.services) && body.services.length <= 100 && body.services.every((s) => typeof s === 'string' && s.length <= 128 && UNIT_NAME.test(s))) value.services = [...new Set(body.services)];
  else errors.push('services');
  return { errors, value };
}

export function createSetupGate({ dir, now = Date.now, random = () => randomBytes(16).toString('hex') }) {
  const file = path.join(dir, 'setup-token');
  let token = null;
  let failures = 0;
  let lockedUntil = 0;

  return {
    file,
    async open() {
      const saved = (await readFile(file, 'utf8').catch(() => '')).trim();
      token = CODE.test(saved) ? saved : random();
      if (token !== saved) await writeFile(file, `${token}\n`, { mode: 0o600 });
      return token;
    },
    check(code) {
      const t = now();
      if (t < lockedUntil) return { ok: false, locked: true, retryAfter: Math.ceil((lockedUntil - t) / 1000) };
      const ok = Boolean(token) && typeof code === 'string' && CODE.test(code) && timingSafeEqual(Buffer.from(code), Buffer.from(token));
      if (ok) return { ok: true };
      failures += 1;
      if (failures >= MAX_FAILURES) {
        lockedUntil = t + LOCK_MS;
        failures = 0;
      }
      return { ok: false, locked: false };
    },
    async close() {
      token = null;
      await unlink(file).catch(() => {});
    },
  };
}
