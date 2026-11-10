// Panel ile Docker yardımcısı (bin/serverhealth-docker.js) arasındaki istek biçimi ve Docker
// yanıtlarının özetlenmesi. İki taraf da aynı doğrulamayı yapar; yardımcı panele güvenmez.

export const DOCKER_ACTIONS = ['start', 'stop', 'restart'];
const ID = /^[0-9a-f]{12,64}$/;

export function validateDockerRequest(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return null;
  if (q.op === 'overview') return { op: 'overview' };
  if (q.op === 'action' && DOCKER_ACTIONS.includes(q.action) && typeof q.id === 'string' && ID.test(q.id)) return { op: 'action', action: q.action, id: q.id };
  return null;
}

// Docker aynı yayını IPv4 ve IPv6 için ayrı listeler; etiketler tekilleştirilir.
const portLabels = (ports = []) => [...new Set(ports.map((p) => (p.PublicPort ? `${p.PublicPort}→${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`)))];

export function summarizeContainer(c) {
  const labels = c.Labels ?? {};
  return {
    id: String(c.Id).slice(0, 12),
    name: (c.Names?.[0] ?? '').replace(/^\//, '') || String(c.Id).slice(0, 12),
    image: String(c.Image ?? ''),
    imageId: String(c.ImageID ?? ''),
    state: String(c.State ?? ''),
    status: String(c.Status ?? ''),
    created: c.Created ? c.Created * 1000 : null,
    ports: portLabels(c.Ports),
    project: labels['com.docker.compose.project'] ?? null,
    service: labels['com.docker.compose.service'] ?? null,
  };
}

// /containers/{id}/stats?stream=false yanıtından CPU yüzdesi, bellek, ağ ve disk.
export function statsSummary(s) {
  if (!s) return null;
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats?.online_cpus ?? s.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
  const cpu = cpuDelta > 0 && sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * cpus * 1000) / 10 : 0;
  const usage = s.memory_stats?.usage ?? null;
  const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.total_inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
  const mem = usage != null ? Math.max(0, usage - cache) : null;
  const limit = s.memory_stats?.limit ?? null;
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks ?? {})) {
    rx += n.rx_bytes ?? 0;
    tx += n.tx_bytes ?? 0;
  }
  let read = 0;
  let write = 0;
  for (const e of s.blkio_stats?.io_service_bytes_recursive ?? []) {
    if (/^read$/i.test(e.op)) read += e.value ?? 0;
    if (/^write$/i.test(e.op)) write += e.value ?? 0;
  }
  return { cpu, mem, memLimit: limit, netRx: rx, netTx: tx, blkRead: read, blkWrite: write, pids: s.pids_stats?.current ?? null };
}

// --- İmaj güncelleme denetimi (panel yapar; yardımcının ağ erişimi yoktur) ---

const REGISTRY = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;
const REPO = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const TAG = /^[\w][\w.-]{0,127}$/;

// "ghcr.io/sahip/imaj:v1" → { registry, repo, tag }; "postgres:16" → docker.io/library/postgres
export function parseImageRef(ref) {
  const s = String(ref ?? '').trim();
  if (!s || s.length > 255) return null;
  if (s.includes('@')) return { pinned: true };
  let rest = s;
  let registry = 'docker.io';
  const first = rest.split('/')[0];
  if (rest.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first;
    rest = rest.slice(first.length + 1);
  }
  let tag = 'latest';
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (registry === 'docker.io' && !rest.includes('/')) rest = `library/${rest}`;
  if (registry === 'index.docker.io') registry = 'docker.io';
  const okRegistry = registry === 'docker.io' || REGISTRY.test(registry) || /^localhost(:\d{1,5})?$/.test(registry);
  if (!okRegistry || !REPO.test(rest) || !TAG.test(tag)) return null;
  return { registry, repo: rest, tag };
}

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

// Kayıt sunucusundaki etiketin özeti (Docker-Content-Digest). Gerekirse anonim token alınır.
export async function remoteDigest({ registry, repo, tag }, fetchImpl = fetch) {
  const host = registry === 'docker.io' ? 'registry-1.docker.io' : registry;
  const url = `https://${host}/v2/${repo}/manifests/${encodeURIComponent(tag)}`;
  const opts = (extra = {}) => ({ method: 'HEAD', headers: { Accept: ACCEPT, 'User-Agent': 'node-stats', ...extra }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  let res = await fetchImpl(url, opts());
  if (res.status === 401) {
    const auth = res.headers.get('www-authenticate') ?? '';
    const realm = /realm="([^"]+)"/i.exec(auth)?.[1];
    const service = /service="([^"]+)"/i.exec(auth)?.[1];
    if (!realm || !/^https:\/\//.test(realm)) throw new Error('auth');
    const tokenUrl = new URL(realm);
    if (service) tokenUrl.searchParams.set('service', service);
    tokenUrl.searchParams.set('scope', `repository:${repo}:pull`);
    const tr = await fetchImpl(tokenUrl, { headers: { 'User-Agent': 'node-stats' }, signal: AbortSignal.timeout(15_000) });
    if (!tr.ok) throw new Error('auth');
    const body = await tr.json();
    const token = body.token ?? body.access_token;
    if (!token) throw new Error('auth');
    res = await fetchImpl(url, opts({ Authorization: `Bearer ${token}` }));
  }
  if (!res.ok) throw new Error(`http_${res.status}`);
  const digest = res.headers.get('docker-content-digest');
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('no_digest');
  return digest;
}

// Yerel imajın RepoDigests listesinde uzak özet yoksa yeni sürüm vardır.
export function localDigests(repoDigests = []) {
  return repoDigests.map((d) => String(d).split('@')[1]).filter((d) => /^sha256:[0-9a-f]{64}$/.test(d ?? ''));
}

export function createImageUpdates({ fetchImpl = fetch, now = Date.now, ttlMs = 6 * 3_600_000 } = {}) {
  const cache = new Map(); // ref -> { at, remote, error }
  let running = null;

  async function check(containers, { force = false } = {}) {
    const refs = new Map();
    for (const c of containers) if (!refs.has(c.image)) refs.set(c.image, c);
    for (const [ref, c] of refs) {
      const hit = cache.get(ref);
      if (!force && hit && now() - hit.at < (hit.error ? 3_600_000 : ttlMs)) continue;
      // Kayıt sunucusundan çekilmemiş (yerelde derlenmiş) imajın karşılaştırılacak özeti yoktur.
      if (!localDigests(c.imageDigests).length && !String(ref).includes('@')) {
        cache.set(ref, { at: now(), remote: null, error: 'local' });
        continue;
      }
      const parsed = parseImageRef(ref);
      if (!parsed) {
        cache.set(ref, { at: now(), remote: null, error: 'unsupported' });
        continue;
      }
      if (parsed.pinned) {
        cache.set(ref, { at: now(), remote: null, error: 'pinned' });
        continue;
      }
      try {
        cache.set(ref, { at: now(), remote: await remoteDigest(parsed, fetchImpl), error: null });
      } catch (err) {
        cache.set(ref, { at: now(), remote: null, error: err.message.startsWith('http_404') ? 'not_found' : 'unreachable' });
      }
    }
  }

  return {
    // Arka planda denetler; aynı anda tek denetim.
    refresh(containers, opts) {
      running ??= check(containers, opts).finally(() => {
        running = null;
      });
      return running;
    },
    annotate(containers) {
      return containers.map((c) => {
        const hit = cache.get(c.image);
        if (!hit) return { ...c, update: null };
        if (hit.error) return { ...c, update: { state: hit.error, checkedAt: hit.at } };
        const local = localDigests(c.imageDigests);
        return { ...c, update: { state: !local.length ? 'local' : local.includes(hit.remote) ? 'current' : 'available', checkedAt: hit.at } };
      });
    },
    get running() {
      return Boolean(running);
    },
  };
}
