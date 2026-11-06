import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const COOKIE_NAME = 'sh_session';
const SESSION_MS = 12 * 60 * 60 * 1000; // "beni hatırla" seçilmezse
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
// Hatırlanan oturum kullanıldıkça süresi yeniden 30 güne uzar (en fazla günde bir kez).
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 500;
const SAVE_DELAY_MS = 1000;

// Yalnızca belirtecin özeti tutulur; çerezdeki belirteç hiçbir yere yazılmaz.
// file verilirse oturumlar panelin durum klasöründe saklanır, servis yeniden başlayınca kapanmaz.
// authKey (kullanıcı adı ve şifre özeti) değişirse kayıtlı oturumlar geçersiz sayılır.
const digest = (token) => createHash('sha256').update(token).digest('hex');

export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in cookies)) cookies[name] = part.slice(i + 1).trim();
  }
  return cookies;
}

export const authKeyOf = (username, passwordHash) => digest(`${username}\n${passwordHash}`);

export function createSessions({ file = null, authKey = '', now = Date.now } = {}) {
  const sessions = new Map(); // digest -> { user, expires, remember }
  let key = authKey;
  let saveTimer = null;

  function load() {
    if (!file) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.authKey !== key) return; // şifre ya da kullanıcı adı değişmiş
      const t = now();
      for (const [k, s] of Object.entries(data.sessions ?? {})) {
        if (/^[0-9a-f]{64}$/.test(k) && typeof s?.user === 'string' && Number.isFinite(s.expires) && s.expires > t) {
          sessions.set(k, { user: s.user, expires: s.expires, remember: s.remember === true });
        }
      }
    } catch {
      /* dosya yok ya da bozuk: oturum yok */
    }
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ authKey: key, sessions: Object.fromEntries(sessions) }), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      console.warn(`Oturumlar kaydedilemedi: ${err.message}`);
    }
  }

  function save() {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
    saveTimer.unref();
  }

  load();

  setInterval(() => {
    const t = now();
    let removed = false;
    for (const [k, s] of sessions) {
      if (s.expires < t) {
        sessions.delete(k);
        removed = true;
      }
    }
    if (removed) save();
  }, 10 * 60 * 1000).unref();

  function lookup(cookieHeader) {
    const token = parseCookies(cookieHeader)[COOKIE_NAME];
    if (!token) return null;
    const k = digest(token);
    const session = sessions.get(k);
    if (!session) return null;
    if (session.expires < now()) {
      sessions.delete(k);
      save();
      return null;
    }
    return { key: k, token, session };
  }

  function cookie(value, { maxAge, secure }) {
    const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
    if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  return {
    create(user, { remember, secure }) {
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value); // en eskisi
      const token = randomBytes(32).toString('base64url');
      const ttl = remember ? REMEMBER_MS : SESSION_MS;
      sessions.set(digest(token), { user, expires: now() + ttl, remember: Boolean(remember) });
      save();
      // "Beni hatırla" yoksa tarayıcı kapanınca silinen oturum çerezi kullanılır.
      return cookie(token, { maxAge: remember ? Math.floor(ttl / 1000) : null, secure });
    },
    get(cookieHeader) {
      const s = lookup(cookieHeader);
      return s && { user: s.session.user };
    },
    // Hatırlanan oturum kullanılırken süresi uzatılır; yeni çerez dönerse yanıta eklenmelidir.
    renew(cookieHeader, { secure }) {
      const s = lookup(cookieHeader);
      if (!s?.session.remember) return null;
      const t = now();
      if (s.session.expires - t > REMEMBER_MS - RENEW_AFTER_MS) return null;
      s.session.expires = t + REMEMBER_MS;
      save();
      return cookie(s.token, { maxAge: Math.floor(REMEMBER_MS / 1000), secure });
    },
    // Şifre değişince bu tarayıcı dışındaki tüm oturumlar kapatılır; kayıtlı dosya yeni anahtarla yazılır.
    destroyOthers(cookieHeader, newAuthKey = key) {
      const keep = lookup(cookieHeader)?.key;
      for (const k of [...sessions.keys()]) if (k !== keep) sessions.delete(k);
      key = newAuthKey;
      saveNow();
    },
    destroy(cookieHeader, { secure }) {
      const s = lookup(cookieHeader);
      if (s) {
        sessions.delete(s.key);
        save();
      }
      return cookie('', { maxAge: 0, secure });
    },
    flush: saveNow,
  };
}
