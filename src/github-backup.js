import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// GitHub yedeği: kullanıcının repolarını her gün yerel bir klasöre kopyalar.
//   <kök>/<sahip>/<repo>/kod.git        bütün branch, tag ve PR referanslarıyla çıplak ayna
//   <kök>/<sahip>/<repo>/wiki.git       wiki varsa
//   <kök>/<sahip>/<repo>/release/<tag>/ release.json, kaynak.tar.gz ve ekli dosyalar
//   <kök>/<sahip>/<repo>/issue/<no>.json issue ve PR'lar yorumlarıyla
//   <kök>/<sahip>/<repo>/repo.json      açıklama, görünürlük, yedek bilgisi
// Hiçbir şey silinmez: GitHub'da silinen repo, branch, tag ve release yedekte kalır ve işaretlenir;
// üzerine yazılan (force-push) branch'in önceki hâli refs/yedek/zorla/ altında saklanır.

const API = 'https://api.github.com';
const STATE_DIR = '.yedek';
const MAX_ASSET = 4 * 1024 * 1024 * 1024;

export const GITHUB_USER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

// Dosya adı olarak güvenli hâle getirir (tag ve dosya adları kullanıcıdan gelir).
export function safeName(name, fallback = 'adsiz') {
  const s = String(name ?? '')
    .replace(/[\0-\x1f\x7f/\\]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 200)
    .trim();
  return s || fallback;
}

export function nextLink(header) {
  const m = /<([^>]+)>;\s*rel="next"/.exec(header ?? '');
  return m ? m[1] : null;
}

const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

export function runGit(args, { cwd, env = {}, timeout = 60 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

const exists = (p) => lstat(p).then(() => true, () => false);
const readJson = (p, fallback) => readFile(p, 'utf8').then((t) => JSON.parse(t), () => fallback);

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, file);
}

async function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += (await stat(p).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
}

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

export function createGithubBackup({ config, token = '', stateDir, fetchImpl = fetch, git = runGit, now = Date.now, log = () => {} }) {
  const root = config.dir;
  const statusFile = path.join(stateDir, 'status.json');
  const runsFile = path.join(stateDir, 'runs.json');
  const metaDir = path.join(root, STATE_DIR);
  let rate = { remaining: null, reset: null };
  let apiBlocked = null;
  let status = null;

  const authEnv = token
    ? {
        // Token komut satırında ya da depo ayarlarında görünmez; yalnızca git sürecinin ortamında durur.
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      }
    : {};

  async function request(url, { accept = 'application/vnd.github+json', raw = false } = {}) {
    if (apiBlocked) throw fail('rate_limited', { reset: apiBlocked });
    const headers = { Accept: accept, 'User-Agent': 'node-stats-backup', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetchImpl(url.startsWith('http') ? url : `${API}${url}`, { headers, signal: AbortSignal.timeout(raw ? 30 * 60_000 : 60_000) });
    } catch {
      throw fail('network');
    }
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining != null) rate = { remaining: Number(remaining), reset: Number(res.headers.get('x-ratelimit-reset')) * 1000 || null };
    if ((res.status === 403 || res.status === 429) && (remaining === '0' || res.headers.get('retry-after'))) {
      apiBlocked = rate.reset ?? now() + 3600_000;
      throw fail('rate_limited', { reset: apiBlocked });
    }
    if (res.status === 401) throw fail('token_invalid');
    if (res.status === 404 || res.status === 410) throw fail('not_found', { status: res.status });
    if (!res.ok) throw fail('github_error', { status: res.status });
    return res;
  }

  async function getJson(url) {
    const res = await request(url);
    return { data: await res.json(), next: nextLink(res.headers.get('link')) };
  }

  async function getAll(url) {
    const out = [];
    for (let next = url; next; ) {
      const page = await getJson(next);
      out.push(...(Array.isArray(page.data) ? page.data : []));
      next = page.next;
    }
    return out;
  }

  async function saveStatus(patch) {
    status = { ...status, ...patch, updated: now(), rate };
    await writeJson(statusFile, status);
  }

  // --- Repo listesi ---
  async function listRepos() {
    let own = false;
    if (token) {
      const me = (await getJson('/user')).data;
      own = String(me.login).toLowerCase() === config.username.toLowerCase();
    }
    let repos;
    try {
      repos = own ? await getAll('/user/repos?affiliation=owner&visibility=all&per_page=100') : await getAll(`/users/${encodeURIComponent(config.username)}/repos?type=owner&per_page=100`);
    } catch (err) {
      if (err.code === 'not_found') throw fail('user_not_found');
      throw err;
    }
    return { repos: repos.filter((r) => config.forks || !r.fork), own };
  }

  // --- Git aynası ---
  async function refs(dir) {
    const r = await git(['for-each-ref', '--format=%(objectname) %(refname)'], { cwd: dir });
    return new Map(
      r.stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split(' '))
        .map(([sha, ref]) => [ref, sha]),
    );
  }

  async function configureMirror(dir) {
    // Silinen referanslar budanmaz, referans günlüğü hiç silinmez: eski commit'lere her zaman ulaşılır.
    for (const [k, v] of [
      ['remote.origin.prune', 'false'],
      ['fetch.prune', 'false'],
      ['core.logAllRefUpdates', 'always'],
      ['gc.reflogExpire', 'never'],
      ['gc.reflogExpireUnreachable', 'never'],
      ['gc.pruneExpire', 'never'],
    ]) {
      await git(['config', k, v], { cwd: dir });
    }
  }

  // Ayna oluşturur ya da günceller. Dönen: { created, changed, forced, missing }
  async function mirror(url, dir) {
    if (!(await exists(dir))) {
      const tmp = `${dir}.yeni`;
      await rm(tmp, { recursive: true, force: true });
      const r = await git(['clone', '--mirror', '--quiet', url, tmp], { env: authEnv });
      if (r.code !== 0) {
        await rm(tmp, { recursive: true, force: true });
        if (/not found|does not exist|repository .* not found/i.test(r.stderr)) return { missing: true };
        throw fail('git_clone', { detail: r.stderr.trim().split('\n').pop() });
      }
      await configureMirror(tmp);
      await rename(tmp, dir);
      return { created: true, changed: true, forced: 0 };
    }
    await configureMirror(dir);
    const before = await refs(dir);
    const r = await git(['fetch', '--quiet', '--no-prune', 'origin'], { cwd: dir, env: authEnv });
    if (r.code !== 0) {
      if (/not found|does not exist/i.test(r.stderr)) return { missing: true };
      throw fail('git_fetch', { detail: r.stderr.trim().split('\n').pop() });
    }
    const after = await refs(dir);
    let changed = false;
    let forced = 0;
    for (const [ref, sha] of after) {
      const old = before.get(ref);
      if (old === sha) continue;
      changed = true;
      if (!old || ref.startsWith('refs/yedek/')) continue;
      // Eski uç yeninin atası değilse geçmiş yeniden yazılmıştır: önceki hâl saklanır.
      const anc = await git(['merge-base', '--is-ancestor', old, sha], { cwd: dir });
      if (anc.code === 1) {
        await git(['update-ref', `refs/yedek/zorla/${stamp(now())}/${ref.replace(/^refs\//, '')}`, old], { cwd: dir });
        forced++;
      }
    }
    return { created: false, changed, forced };
  }

  async function verify(dir, full) {
    const r = await git(['fsck', '--no-progress', '--no-dangling', ...(full ? [] : ['--connectivity-only'])], { cwd: dir, timeout: 2 * 60 * 60_000 });
    if (r.code !== 0) throw fail('fsck', { detail: r.stderr.trim().split('\n').slice(-1)[0] });
  }

  async function gitStats(dir) {
    const all = await refs(dir);
    const names = [...all.keys()];
    const last = await git(['log', '-1', '--format=%ct', 'HEAD'], { cwd: dir });
    return {
      branches: names.filter((r) => r.startsWith('refs/heads/')).length,
      tags: names.filter((r) => r.startsWith('refs/tags/')).length,
      pulls: names.filter((r) => /^refs\/pull\/\d+\/head$/.test(r)).length,
      forcedSaved: names.filter((r) => r.startsWith('refs/yedek/zorla/')).length,
      lastCommit: last.code === 0 && last.stdout.trim() ? Number(last.stdout.trim()) * 1000 : null,
    };
  }

  // --- Release'ler ---
  async function download(url, file, { accept, digest, size }) {
    if (size > MAX_ASSET) throw fail('asset_too_large');
    const res = await request(url, { accept, raw: true });
    const tmp = `${file}.indiriliyor`;
    await mkdir(path.dirname(file), { recursive: true });
    const hash = createHash('sha256');
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => hash.update(chunk));
    await pipeline(body, createWriteStream(tmp));
    const sha256 = hash.digest('hex');
    if (digest && digest.startsWith('sha256:') && digest.slice(7) !== sha256) {
      await rm(tmp, { force: true });
      throw fail('asset_digest');
    }
    await rename(tmp, file);
    return sha256;
  }

  async function backupReleases(repo, base) {
    const dir = path.join(base, 'release');
    const indexFile = path.join(dir, 'index.json');
    const index = await readJson(indexFile, {});
    const releases = await getAll(`/repos/${repo.full_name}/releases?per_page=100`);
    let assets = 0;
    const seen = new Set();
    for (const rel of releases) {
      const key = String(rel.id);
      seen.add(key);
      const folderName = index[key]?.folder ?? safeName(rel.tag_name || `taslak-${rel.id}`);
      const folder = path.join(dir, folderName);
      const entry = { folder: folderName, tag: rel.tag_name, name: rel.name, draft: rel.draft, prerelease: rel.prerelease, publishedAt: rel.published_at, firstSeen: index[key]?.firstSeen ?? now(), deletedOnGithub: null, assets: index[key]?.assets ?? {} };
      await writeJson(path.join(folder, 'release.json'), rel);
      for (const a of rel.assets ?? []) {
        const file = path.join(folder, 'dosyalar', safeName(a.name));
        const known = entry.assets[a.id];
        const onDisk = await stat(file).then((s) => s.size, () => -1);
        if (known && known.updatedAt === a.updated_at && onDisk === a.size) {
          assets++;
          continue;
        }
        // Özel repolarda dosya API adresinden indirilir; herkese açık olanlarda doğrudan bağlantıdan.
        const sha256 = token
          ? await download(a.url, file, { accept: 'application/octet-stream', digest: a.digest, size: a.size })
          : await download(a.browser_download_url, file, { accept: '*/*', digest: a.digest, size: a.size });
        entry.assets[a.id] = { name: a.name, size: a.size, updatedAt: a.updated_at, sha256 };
        assets++;
      }
      // Kaynak arşivi bir kez alınır (aynı tag git aynasında da var).
      const tarball = path.join(folder, 'kaynak.tar.gz');
      if (rel.tarball_url && !rel.draft && !(await exists(tarball))) {
        try {
          await download(rel.tarball_url, tarball, { accept: '*/*', size: 0 });
        } catch (err) {
          if (err.code === 'rate_limited') throw err;
          log(`${repo.full_name} ${rel.tag_name}: kaynak arşivi alınamadı (${err.code})`);
        }
      }
      index[key] = entry;
    }
    for (const [key, entry] of Object.entries(index)) {
      if (!seen.has(key) && !entry.deletedOnGithub) entry.deletedOnGithub = now();
    }
    await writeJson(indexFile, index);
    return { releases: Object.keys(index).length, deleted: Object.values(index).filter((e) => e.deletedOnGithub).length, assets };
  }

  // --- Issue ve PR'lar (yorumlarıyla); yalnızca son yedekten bu yana değişenler alınır ---
  async function backupIssues(repo, base, since) {
    const dir = path.join(base, 'issue');
    const started = new Date(now()).toISOString();
    const issues = await getAll(`/repos/${repo.full_name}/issues?state=all&sort=updated&direction=asc&per_page=100${since ? `&since=${encodeURIComponent(since)}` : ''}`);
    for (const issue of issues) {
      const data = { issue, comments: issue.comments ? await getAll(`${issue.comments_url}?per_page=100`) : [] };
      if (issue.pull_request) {
        data.pull = (await getJson(`/repos/${repo.full_name}/pulls/${issue.number}`)).data;
        data.reviewComments = await getAll(`/repos/${repo.full_name}/pulls/${issue.number}/comments?per_page=100`);
      }
      await writeJson(path.join(dir, `${issue.number}.json`), data);
    }
    const count = (await readdir(dir).catch(() => [])).filter((n) => /^\d+\.json$/.test(n)).length;
    return { issues: count, since: started };
  }

  // --- Bir repo ---
  async function backupRepo(repo, state, full) {
    const owner = safeName(repo.owner?.login ?? config.username);
    const rel = path.join(owner, safeName(repo.name));
    const base = path.join(root, rel);
    const prev = state.repos[repo.id];
    // Yeniden adlandırılan repo: klasör yeni ada taşınır.
    if (prev?.path && prev.path !== rel && (await exists(path.join(root, prev.path))) && !(await exists(base))) {
      await mkdir(path.dirname(base), { recursive: true });
      await rename(path.join(root, prev.path), base);
    }
    await mkdir(base, { recursive: true });
    const result = { id: repo.id, name: repo.full_name, path: rel, private: repo.private, fork: repo.fork, archived: repo.archived, deletedOnGithub: null, ok: true, errors: [] };

    const code = await mirror(repo.clone_url, path.join(base, 'kod.git'));
    if (code.missing) throw fail('git_clone', { detail: 'repository not found' });
    if (code.changed || full) await verify(path.join(base, 'kod.git'), full);
    Object.assign(result, await gitStats(path.join(base, 'kod.git')), { forcedNow: code.forced });

    if (config.wiki && repo.has_wiki) {
      try {
        const w = await mirror(repo.clone_url.replace(/\.git$/, '.wiki.git'), path.join(base, 'wiki.git'));
        result.wiki = !w.missing;
      } catch (err) {
        result.errors.push(`wiki: ${err.code}`);
      }
    }

    const api = async (label, fn) => {
      try {
        return await fn();
      } catch (err) {
        result.errors.push(`${label}: ${err.code ?? err.message}`);
        return null;
      }
    };
    const rels = await api('release', () => backupReleases(repo, base));
    if (rels) Object.assign(result, { releases: rels.releases, releasesDeleted: rels.deleted, assets: rels.assets });
    let since = prev?.issuesSince ?? null;
    if (config.issues) {
      const iss = await api('issue', () => backupIssues(repo, base, since));
      if (iss) {
        result.issues = iss.issues;
        since = iss.since;
      }
    }
    await writeJson(path.join(base, 'repo.json'), {
      id: repo.id,
      fullName: repo.full_name,
      description: repo.description,
      private: repo.private,
      fork: repo.fork,
      archived: repo.archived,
      defaultBranch: repo.default_branch,
      htmlUrl: repo.html_url,
      topics: repo.topics ?? [],
      createdAt: repo.created_at,
      pushedAt: repo.pushed_at,
      firstBackup: prev?.firstBackup ?? now(),
      lastBackup: now(),
      deletedOnGithub: null,
    });
    result.size = await dirSize(base);
    result.ok = result.errors.length === 0;
    state.repos[repo.id] = { path: rel, name: repo.full_name, private: repo.private, firstBackup: prev?.firstBackup ?? now(), lastOk: result.ok ? now() : prev?.lastOk ?? null, issuesSince: since, deletedOnGithub: null, last: result };
    return result;
  }

  async function run({ trigger = 'timer' } = {}) {
    const startedAt = now();
    // Önceki sonuç (repo listesi, son başarılı yedek) çalışırken de görünsün.
    const previous = await readJson(statusFile, {});
    status = { running: true, trigger, startedAt, finishedAt: null, ok: null, error: null, username: config.username, current: null, done: 0, total: null, repos: previous.repos ?? [], totals: previous.totals ?? null, lastOk: previous.lastOk ?? null };
    await saveStatus({});
    const fail2 = async (code, extra = {}) => {
      await saveStatus({ running: false, finishedAt: now(), ok: false, error: code, ...extra });
      await appendRun();
      return status;
    };
    // Disk bağlı değilse (klasör yoksa) sistem diskine yazmamak için durulur.
    if (!(await stat(root).then((s) => s.isDirectory(), () => false))) return fail2('dir_missing');
    const state = await readJson(path.join(metaDir, 'state.json'), { repos: {} });
    let listing;
    try {
      listing = await listRepos();
    } catch (err) {
      return fail2(err.code ?? 'failed', err.reset ? { rateReset: err.reset } : {});
    }
    const full = new Date(startedAt).getDay() === 0; // pazar günleri tam doğrulama
    await saveStatus({ total: listing.repos.length, private: listing.own && Boolean(token) });
    const results = [];
    for (const repo of listing.repos) {
      await saveStatus({ current: repo.full_name, done: results.length });
      try {
        results.push(await backupRepo(repo, state, full));
      } catch (err) {
        log(`${repo.full_name}: ${err.code ?? err.message}${err.detail ? ` (${err.detail})` : ''}`);
        const prev = state.repos[repo.id];
        results.push({ id: repo.id, name: repo.full_name, path: prev?.path ?? null, private: repo.private, fork: repo.fork, ok: false, errors: [`${err.code ?? 'failed'}${err.detail ? `: ${err.detail}` : ''}`] });
      }
      await writeJson(path.join(metaDir, 'state.json'), state);
    }
    // Listede olmayan eski repolar: GitHub'da silinmiş ya da artık görülemiyor. Yedekte kalır.
    const listed = new Set(listing.repos.map((r) => String(r.id)));
    for (const [id, s] of Object.entries(state.repos)) {
      if (listed.has(id)) continue;
      if (!s.deletedOnGithub) {
        s.deletedOnGithub = now();
        const meta = await readJson(path.join(root, s.path, 'repo.json'), null);
        if (meta) await writeJson(path.join(root, s.path, 'repo.json'), { ...meta, deletedOnGithub: s.deletedOnGithub });
      }
      results.push({ ...(s.last ?? { name: s.name, path: s.path, private: s.private }), deletedOnGithub: s.deletedOnGithub, ok: true, errors: [] });
    }
    await writeJson(path.join(metaDir, 'state.json'), state);
    const failed = results.filter((r) => !r.ok);
    await saveStatus({
      running: false,
      finishedAt: now(),
      current: null,
      done: listing.repos.length,
      ok: failed.length === 0 && !apiBlocked,
      error: apiBlocked ? 'rate_limited' : failed.length ? 'repo_errors' : null,
      rateReset: apiBlocked,
      repos: results.sort((a, b) => a.name.localeCompare(b.name)),
      totals: {
        repos: results.length,
        failed: failed.length,
        size: results.reduce((s, r) => s + (r.size ?? 0), 0),
        releases: results.reduce((s, r) => s + (r.releases ?? 0), 0),
        assets: results.reduce((s, r) => s + (r.assets ?? 0), 0),
        issues: results.reduce((s, r) => s + (r.issues ?? 0), 0),
      },
      lastOk: failed.length === 0 && !apiBlocked ? now() : status.lastOk ?? null,
    });
    await appendRun();
    return status;
  }

  async function appendRun() {
    const runs = await readJson(runsFile, []);
    runs.push({ startedAt: status.startedAt, finishedAt: status.finishedAt, ok: status.ok, error: status.error, trigger: status.trigger, repos: status.totals?.repos ?? 0, failed: status.totals?.failed ?? 0 });
    await writeJson(runsFile, runs.slice(-60));
  }

  return { run, request, listRepos };
}
