import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

// Saklanan biçim: scrypt$N$r$p$<tuz-base64>$<anahtar-base64>
const KEY_LENGTH = 32;
const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1 };

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const CACHE_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_VERIFICATIONS = 4;

function scryptAsync(password, salt, keylen, { N, r, p }) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const sha256 = (value) => createHash('sha256').update(value).digest();

export async function hashPassword(password, params = DEFAULT_PARAMS) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export function parseHash(stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64');
  const key = Buffer.from(parts[5], 'base64');
  const validParams = [N, r, p].every(Number.isInteger) && N > 1 && (N & (N - 1)) === 0 && r > 0 && p > 0;
  if (!validParams || salt.length < 8 || key.length < 16) return null;
  return { params: { N, r, p }, salt, key };
}

export async function verifyPassword(password, parsed) {
  const key = await scryptAsync(password, parsed.salt, parsed.key.length, parsed.params);
  return timingSafeEqual(key, parsed.key);
}

export function createAuth({ username, passwordHash }) {
  const parsed = parseHash(passwordHash);
  if (!parsed) throw new Error('auth.passwordHash geçersiz');
  const expectedUser = sha256(String(username));
  const failures = new Map(); // ip -> { count, since, lockedUntil }
  const verified = new Map(); // sha256(token) -> geçerlilik bitişi; pano her 3 sn'de scrypt çalıştırmasın diye
  let inFlight = 0;

  setInterval(() => {
    const now = Date.now();
    for (const [ip, f] of failures) if (f.lockedUntil < now && now - f.since > LOCK_MS) failures.delete(ip);
    for (const [k, exp] of verified) if (exp < now) verified.delete(k);
  }, 60_000).unref();

  function registerFailure(ip, now) {
    let f = failures.get(ip);
    if (!f || now - f.since > LOCK_MS) f = { count: 0, since: now, lockedUntil: 0 };
    f.count++;
    if (f.count >= MAX_FAILURES) {
      f.lockedUntil = now + LOCK_MS;
      console.warn(`${ip} ${f.count} hatalı denemeden sonra ${LOCK_MS / 60000} dakika kilitlendi`);
    } else {
      console.warn(`Hatalı giriş denemesi: ${ip} (${f.count}/${MAX_FAILURES})`);
    }
    failures.set(ip, f);
    return f;
  }

  const lockedFor = (ip, now) => {
    const f = failures.get(ip);
    return f && f.lockedUntil > now ? Math.ceil((f.lockedUntil - now) / 1000) : 0;
  };

  // Döner: { ok: true } | { ok: false, status: 401, attemptsLeft } | { ok: false, status: 429, retryAfter }
  async function login(user, pass, ip) {
    const now = Date.now();
    const locked = lockedFor(ip, now);
    if (locked) return { ok: false, status: 429, retryAfter: locked };
    if (inFlight >= MAX_CONCURRENT_VERIFICATIONS) return { ok: false, status: 429, retryAfter: 1 };

    inFlight++;
    let valid = false;
    try {
      // Kullanıcı adı yanlış olsa bile scrypt çalışır; yanıt süresi kullanıcı adını ele vermez.
      const userOk = timingSafeEqual(sha256(String(user)), expectedUser);
      const passOk = await verifyPassword(String(pass), parsed);
      valid = userOk && passOk;
    } finally {
      inFlight--;
    }

    if (valid) {
      failures.delete(ip);
      return { ok: true };
    }
    const f = registerFailure(ip, now);
    if (f.lockedUntil) return { ok: false, status: 429, retryAfter: Math.ceil(LOCK_MS / 1000) };
    return { ok: false, status: 401, attemptsLeft: MAX_FAILURES - f.count };
  }

  // HTTP Basic Auth (curl -u gibi betikler için). Doğrulanan başlık birkaç dakika önbellekte tutulur.
  async function check(header, ip) {
    const now = Date.now();
    const locked = lockedFor(ip, now);
    if (locked) return { ok: false, status: 429, retryAfter: locked };

    const match = typeof header === 'string' ? /^Basic\s+(\S+)\s*$/i.exec(header) : null;
    if (!match) return { ok: false, status: 401 };

    const cacheKey = sha256(match[1]).toString('hex');
    if (verified.get(cacheKey) > now) return { ok: true };

    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const result = await login(sep === -1 ? decoded : decoded.slice(0, sep), sep === -1 ? '' : decoded.slice(sep + 1), ip);
    if (result.ok) {
      if (verified.size >= 100) verified.clear();
      verified.set(cacheKey, now + CACHE_MS);
    }
    return result;
  }

  return { login, check, username };
}
