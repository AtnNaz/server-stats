import { randomBytes, createHash } from 'node:crypto';

const COOKIE_NAME = 'sh_session';
const SESSION_MS = 12 * 60 * 60 * 1000; // "beni hatırla" seçilmezse
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 500;

// Bellekte yalnızca belirtecin özeti tutulur; servis yeniden başlayınca oturumlar kapanır.
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

export function createSessions() {
  const sessions = new Map(); // digest -> { user, expires }

  setInterval(() => {
    const now = Date.now();
    for (const [key, s] of sessions) if (s.expires < now) sessions.delete(key);
  }, 10 * 60 * 1000).unref();

  function lookup(cookieHeader) {
    const token = parseCookies(cookieHeader)[COOKIE_NAME];
    if (!token) return null;
    const key = digest(token);
    const session = sessions.get(key);
    if (!session) return null;
    if (session.expires < Date.now()) {
      sessions.delete(key);
      return null;
    }
    return { key, ...session };
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
      sessions.set(digest(token), { user, expires: Date.now() + ttl });
      // "Beni hatırla" yoksa tarayıcı kapanınca silinen oturum çerezi kullanılır.
      return cookie(token, { maxAge: remember ? Math.floor(ttl / 1000) : null, secure });
    },
    get(cookieHeader) {
      const s = lookup(cookieHeader);
      return s && { user: s.user };
    },
    // Şifre değişince bu tarayıcı dışındaki tüm oturumlar kapatılır.
    destroyOthers(cookieHeader) {
      const keep = lookup(cookieHeader)?.key;
      for (const key of [...sessions.keys()]) if (key !== keep) sessions.delete(key);
    },
    destroy(cookieHeader, { secure }) {
      const s = lookup(cookieHeader);
      if (s) sessions.delete(s.key);
      return cookie('', { maxAge: 0, secure });
    },
  };
}
