import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

// Panel iki günde bir GitHub'daki son sürüme bakar. İstekte yalnızca herkese açık sürüm
// bilgisi sorulur; sunucuya dair hiçbir bilgi gönderilmez. config.json: "updateCheck": false kapatır.
export const CHECK_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;
const RETRY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60 * 1000;
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(value) {
  const m = VERSION.exec(String(value ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}

export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// "https://github.com/sahip/depo" → "sahip/depo"
export function repoFromUrl(url) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url ?? '');
  return m ? `${m[1]}/${m[2]}` : null;
}

// GitHub API'nin hesapsız istek sınırı (saatte 60, aynı ağdaki herkes için ortak) dolarsa son sürüm,
// sınır olmayan github.com/<depo>/releases/latest yönlendirmesinden okunur.
export async function latestFromRedirect(repo, fetchImpl = fetch) {
  const res = await fetchImpl(`https://github.com/${repo}/releases/latest`, {
    headers: { 'User-Agent': 'server-stats' },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  const location = res.headers?.get?.('location') ?? '';
  const prefix = `https://github.com/${repo}/releases/tag/`;
  if (res.status < 300 || res.status >= 400 || !location.startsWith(prefix)) throw new Error(`HTTP ${res.status}`);
  const tag = decodeURIComponent(location.slice(prefix.length));
  if (!parseVersion(tag)) throw new Error('geçersiz sürüm etiketi');
  return { tag, url: `${prefix}${encodeURIComponent(tag)}` };
}

export function createUpdateChecker({ repo, current, stateDir, enabled = true, fetchImpl = fetch, now = Date.now }) {
  const file = path.join(stateDir, 'update-check.json');
  let state = { checkedAt: null, latest: null, url: null, error: null };
  let timer = null;
  let running = null;

  async function load() {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      state = { ...state, ...saved };
    } catch {
      /* henüz denetlenmemiş */
    }
  }

  async function save() {
    await mkdir(stateDir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state)}\n`);
    await rename(tmp, file);
  }

  function status() {
    return {
      enabled: Boolean(enabled && repo),
      current,
      checkedAt: state.checkedAt,
      latest: state.latest,
      url: state.url,
      error: state.error,
      available: Boolean(state.latest && isNewer(state.latest, current)),
    };
  }

  async function fetchLatest() {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'server-stats' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return { latest: null, url: null }; // henüz sürüm yayınlanmamış
    if (res.status === 403 || res.status === 429) {
      const r = await latestFromRedirect(repo, fetchImpl);
      return { latest: r.tag.replace(/^v/, ''), url: r.url };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const latest = String(body?.tag_name ?? '').replace(/^v/, '');
    if (!parseVersion(latest)) throw new Error('geçersiz sürüm etiketi');
    // Bağlantı yalnızca bu deponun sürüm sayfası olabilir.
    const prefix = `https://github.com/${repo}/releases/`;
    const url = typeof body.html_url === 'string' && body.html_url.startsWith(prefix) ? body.html_url : `${prefix}latest`;
    return { latest, url };
  }

  // Aynı anda tek denetim çalışır; ikinci çağrı ilkinin sonucunu bekler.
  function check() {
    if (!enabled || !repo) return Promise.resolve(status());
    running ??= (async () => {
      try {
        state = { checkedAt: now(), ...(await fetchLatest()), error: null };
      } catch (err) {
        state = { ...state, checkedAt: now(), error: err.name === 'TimeoutError' ? 'timeout' : 'failed' };
        console.warn(`Sürüm denetimi yapılamadı: ${err.message}`);
      }
      await save().catch((err) => console.warn(`Sürüm denetimi kaydedilemedi: ${err.message}`));
      return status();
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function schedule() {
    if (!enabled || !repo) return;
    const due = (state.checkedAt ?? 0) + (state.error ? RETRY_MS : CHECK_INTERVAL_MS);
    const delay = Math.min(Math.max(FIRST_CHECK_DELAY_MS, due - now()), 2 ** 31 - 1);
    timer = setTimeout(async () => {
      await check();
      schedule();
    }, delay);
    timer.unref();
  }

  return {
    async start() {
      await load();
      schedule();
    },
    stop() {
      clearTimeout(timer);
    },
    check,
    status,
  };
}
