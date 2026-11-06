import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGithubBackup, safeName, nextLink, runGit } from '../src/github-backup.js';
import { createHelper } from '../bin/serverhealth-helper.js';
import { validateRequest, validateGithubBackup, validBackupDir } from '../src/system-settings.js';

const tmp = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nsgh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Deneme', GIT_AUTHOR_EMAIL: 'deneme@example.com', GIT_COMMITTER_NAME: 'Deneme', GIT_COMMITTER_EMAIL: 'deneme@example.com' } }).trim();

// "GitHub" yerine yerel bir çalışma deposu ve ondan beslenen çıplak depo.
function makeRemote(base, name) {
  const work = path.join(base, 'kaynak', name);
  mkdirSync(work, { recursive: true });
  sh(work, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(work, 'a.txt'), '1');
  sh(work, 'add', '.');
  sh(work, 'commit', '-qm', 'ilk');
  sh(work, 'branch', 'dal');
  sh(work, 'tag', 'v1.0.0');
  const bare = path.join(base, 'github', `${name}.git`);
  sh(base, 'clone', '-q', '--bare', work, bare);
  sh(work, 'remote', 'add', 'origin', bare);
  return { work, bare };
}

function fakeGithub(api) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization ?? null });
    const handler = api(url);
    if (!handler) return new Response('{}', { status: 404 });
    if (handler.status) return new Response('{}', { status: handler.status, headers: handler.headers ?? {} });
    if (handler.bytes) return new Response(handler.bytes, { status: 200, headers: { 'x-ratelimit-remaining': '4999' } });
    return new Response(JSON.stringify(handler.json), { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999', ...(handler.link && { link: handler.link }) } });
  };
  return { fetchImpl, calls };
}

const repoJson = (name, bare, extra = {}) => ({ id: name === 'proje' ? 1 : 2, name, full_name: `deneme/${name}`, owner: { login: 'deneme' }, private: false, fork: false, archived: false, has_wiki: false, clone_url: bare, default_branch: 'main', ...extra });

test('ad güvenliği ve sayfalama bağlantısı', () => {
  assert.equal(safeName('../../etc/passwd'), '__.._etc_passwd');
  assert.equal(safeName('v1.0/rc'), 'v1.0_rc');
  assert.equal(safeName(''), 'adsiz');
  assert.equal(nextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'), 'https://api.github.com/x?page=2');
  assert.equal(nextLink('<https://api.github.com/x?page=1>; rel="prev"'), null);
});

test('ayar doğrulaması: kullanıcı adı, token ve klasör', () => {
  assert.ok(validateRequest({ type: 'settings', settings: { githubBackup: { enabled: true, username: 'octo-cat', dir: '/srv/yedek', time: '04:30', token: `github_pat_${'A'.repeat(40)}` } } }).request);
  assert.ok(validateRequest({ type: 'settings', settings: { githubBackup: { token: '' } } }).request);
  assert.ok(validateRequest({ type: 'action', action: 'github-backup' }).request);
  for (const bad of [{ username: '-x' }, { username: 'a--b' }, { username: 'x'.repeat(40) }, { token: 'abc' }, { token: 'ghp_x;rm' }, { dir: '/etc/yedek' }, { dir: '/mnt' }, { dir: '/srv/a b' }, { dir: '/srv/../etc' }, { enabled: true, username: 'a' }]) {
    assert.ok(validateGithubBackup(bad).errors.length, JSON.stringify(bad));
  }
  assert.equal(validBackupDir('/var/lib/serverhealth-backup/x'), false);
  assert.equal(validBackupDir('/mnt/disk/github-yedek'), true);
});

test('GitHub yedeği: ayna, release dosyası, issue/PR; force-push, silinen branch, repo ve release saklanır', async (t) => {
  const base = tmp(t);
  const { work, bare } = makeRemote(base, 'proje');
  const other = makeRemote(base, 'eski');
  const root = path.join(base, 'yedek');
  mkdirSync(root);
  const stateDir = path.join(base, 'durum');
  const asset = Buffer.from('ikili-dosya');
  const digest = `sha256:${createHash('sha256').update(asset).digest('hex')}`;
  const world = {
    repos: [repoJson('proje', bare, { has_wiki: true }), repoJson('eski', other.bare)],
    releases: [{ id: 10, tag_name: 'v1.0.0', name: 'İlk', draft: false, prerelease: false, tarball_url: 'https://api.github.com/repos/deneme/proje/tarball/v1.0.0', assets: [{ id: 100, name: 'uygulama.bin', size: asset.length, updated_at: '2026-01-01T00:00:00Z', digest, url: 'https://api.github.com/repos/deneme/proje/releases/assets/100', browser_download_url: 'https://github.com/deneme/proje/releases/download/v1.0.0/uygulama.bin' }] }],
    rateLimited: false,
  };
  const { fetchImpl, calls } = fakeGithub((url) => {
    const u = new URL(url);
    if (u.pathname === '/users/deneme/repos') return { json: world.repos };
    if (world.rateLimited && u.pathname.includes('/releases')) return { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' } };
    if (u.pathname === '/repos/deneme/proje/releases') return { json: world.releases };
    if (u.pathname === '/repos/deneme/eski/releases') return { json: [] };
    if (u.pathname.endsWith('/uygulama.bin')) return { bytes: asset };
    if (u.pathname.includes('/tarball/')) return { bytes: Buffer.from('tar') };
    if (u.pathname === '/repos/deneme/proje/issues')
      return { json: [{ number: 1, comments: 1, comments_url: 'https://api.github.com/repos/deneme/proje/issues/1/comments', title: 'Hata' }, { number: 2, comments: 0, pull_request: {}, title: 'Düzeltme' }] };
    if (u.pathname === '/repos/deneme/eski/issues') return { json: [] };
    if (u.pathname === '/repos/deneme/proje/issues/1/comments') return { json: [{ id: 5, body: 'yorum' }] };
    if (u.pathname === '/repos/deneme/proje/pulls/2') return { json: { number: 2, merged: true } };
    if (u.pathname === '/repos/deneme/proje/pulls/2/comments') return { json: [] };
    return null;
  });
  let clock = Date.parse('2026-11-03T04:30:00Z'); // salı: tam doğrulama değil
  const make = (cfg = {}) => createGithubBackup({ config: { username: 'deneme', dir: root, forks: true, issues: true, wiki: true, ...cfg }, stateDir, fetchImpl, now: () => clock });

  // 1. ilk yedek
  let s = await make().run();
  assert.equal(s.ok, true, JSON.stringify(s.repos.map((r) => r.errors)));
  const repoDir = path.join(root, 'deneme', 'proje');
  const kod = path.join(repoDir, 'kod.git');
  assert.equal(sh(kod, 'rev-parse', 'refs/heads/dal'), sh(work, 'rev-parse', 'dal'));
  assert.equal(sh(kod, 'rev-parse', 'refs/tags/v1.0.0'), sh(work, 'rev-parse', 'v1.0.0'));
  assert.equal(readFileSync(path.join(repoDir, 'release/v1.0.0/dosyalar/uygulama.bin'), 'utf8'), 'ikili-dosya');
  assert.ok(existsSync(path.join(repoDir, 'release/v1.0.0/kaynak.tar.gz')));
  assert.equal(JSON.parse(readFileSync(path.join(repoDir, 'issue/1.json'), 'utf8')).comments[0].body, 'yorum');
  assert.equal(JSON.parse(readFileSync(path.join(repoDir, 'issue/2.json'), 'utf8')).pull.merged, true);
  assert.equal(existsSync(path.join(repoDir, 'wiki.git')), false); // wiki boş: hata sayılmaz
  const p = s.repos.find((r) => r.name === 'deneme/proje');
  assert.deepEqual([p.branches, p.tags, p.releases, p.assets, p.issues], [2, 1, 1, 1, 2]);
  assert.equal(s.totals.repos, 2);
  assert.ok(calls.every((c) => c.auth === null)); // token yokken yetki başlığı gönderilmez

  // 1b. push yoksa repo yeniden çekilmez (git fetch çalışmaz)
  const fetches = [];
  const spy = async (args, opts) => {
    if (args[0] === 'fetch' || args[0] === 'clone') fetches.push(opts?.cwd ?? args.at(-1));
    return runGit(args, opts);
  };
  world.repos = world.repos.map((r) => ({ ...r, pushed_at: '2026-11-01T00:00:00Z' }));
  clock += 3600_000;
  await createGithubBackup({ config: { username: 'deneme', dir: root, forks: true, issues: true, wiki: true }, stateDir, fetchImpl, git: spy, now: () => clock }).run(); // pushed_at ilk kez kaydedilir
  fetches.length = 0;
  clock += 3600_000;
  s = await createGithubBackup({ config: { username: 'deneme', dir: root, forks: true, issues: true, wiki: true }, stateDir, fetchImpl, git: spy, now: () => clock }).run();
  assert.equal(s.ok, true);
  assert.deepEqual(fetches.filter((c) => c.endsWith('kod.git')), []);
  assert.ok(s.repos.every((r) => r.skipped));
  world.repos = world.repos.map((r) => ({ ...r, pushed_at: '2026-11-02T00:00:00Z' })); // yeni push: tekrar çekilir

  // 2. force-push, branch silme, release silme, repo kaldırılması
  const old = sh(work, 'rev-parse', 'main');
  writeFileSync(path.join(work, 'a.txt'), '2');
  sh(work, 'commit', '-qa', '--amend', '-m', 'yeniden yazıldı');
  sh(work, 'push', '-qf', 'origin', 'main');
  sh(work, 'push', '-q', 'origin', '--delete', 'dal');
  world.releases = [];
  world.repos = [world.repos[0]];
  clock += 86_400_000;
  s = await make().run();
  assert.equal(s.ok, true);
  assert.equal(sh(kod, 'rev-parse', 'refs/heads/main'), sh(work, 'rev-parse', 'main'));
  assert.ok(sh(kod, 'for-each-ref', '--format=%(refname)', 'refs/heads/dal')); // GitHub'da silinen branch yedekte kalır
  const saved = sh(kod, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/yedek/zorla/');
  assert.match(saved, new RegExp(`^${old} refs/yedek/zorla/\\d{8}T\\d{6}Z/heads/main$`));
  const relIndex = JSON.parse(readFileSync(path.join(repoDir, 'release/index.json'), 'utf8'));
  assert.ok(relIndex['10'].deletedOnGithub);
  assert.ok(existsSync(path.join(repoDir, 'release/v1.0.0/dosyalar/uygulama.bin')));
  const gone = s.repos.find((r) => r.name === 'deneme/eski');
  assert.ok(gone.deletedOnGithub);
  assert.ok(existsSync(path.join(root, 'deneme/eski/kod.git')));
  assert.ok(JSON.parse(readFileSync(path.join(root, 'deneme/eski/repo.json'), 'utf8')).deletedOnGithub);
  assert.equal(s.repos.find((r) => r.name === 'deneme/proje').forcedSaved, 1);

  // 3. istek sınırı: kod yine güncellenir, durum "rate_limited" olur ve sıfırlanma zamanı verilir
  world.rateLimited = true;
  writeFileSync(path.join(work, 'b.txt'), '3');
  sh(work, 'add', '.');
  sh(work, 'commit', '-qm', 'yeni');
  sh(work, 'push', '-q', 'origin', 'main');
  world.repos = world.repos.map((r) => ({ ...r, pushed_at: '2026-11-03T00:00:00Z' }));
  clock += 86_400_000;
  s = await make().run();
  assert.equal(s.ok, false);
  assert.equal(s.error, 'rate_limited');
  assert.equal(s.rateReset, 1800000000 * 1000);
  assert.equal(sh(kod, 'rev-parse', 'refs/heads/main'), sh(work, 'rev-parse', 'main'));
  assert.ok(s.lastOk); // önceki başarılı yedek zamanı korunur
  const pr = s.repos.find((r) => r.name === 'deneme/proje');
  assert.deepEqual([pr.ok, pr.pending, pr.releases], [true, ['release', 'issue'], 1]); // sınır hata değil, eski sayılar korunur
  assert.equal(statSync(path.join(stateDir, 'status.json')).mode & 0o777, 0o644); // panel okuyabilmeli

  const runs = JSON.parse(readFileSync(path.join(stateDir, 'runs.json'), 'utf8'));
  assert.deepEqual(runs.map((r) => r.ok), [true, true, true, true, false]);
});

test('GitHub yedeği: bozuk release dosyası reddedilir, klasör yoksa hiçbir şey yazılmaz, kullanıcı yoksa açık hata', async (t) => {
  const base = tmp(t);
  const { bare } = makeRemote(base, 'proje');
  const root = path.join(base, 'yedek');
  mkdirSync(root);
  const stateDir = path.join(base, 'durum');
  const { fetchImpl } = fakeGithub((url) => {
    const u = new URL(url);
    if (u.pathname === '/users/deneme/repos') return { json: [repoJson('proje', bare)] };
    if (u.pathname === '/repos/deneme/proje/releases') return { json: [{ id: 1, tag_name: 'v1', assets: [{ id: 9, name: 'x.bin', size: 3, updated_at: 'a', digest: 'sha256:0000', browser_download_url: 'https://github.com/x.bin' }] }] };
    if (u.pathname === '/x.bin') return { bytes: Buffer.from('abc') };
    if (u.pathname.endsWith('/issues')) return { json: [] };
    return null;
  });
  const cfg = { username: 'deneme', dir: root, forks: true, issues: true, wiki: false };
  const s = await createGithubBackup({ config: cfg, stateDir, fetchImpl }).run();
  const r = s.repos[0];
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /asset_digest/);
  assert.ok(!existsSync(path.join(root, 'deneme/proje/release/v1/dosyalar/x.bin')));
  assert.ok(existsSync(path.join(root, 'deneme/proje/kod.git'))); // kod yine alındı

  const missing = await createGithubBackup({ config: { ...cfg, dir: path.join(base, 'bagli-degil') }, stateDir, fetchImpl }).run();
  assert.equal(missing.error, 'dir_missing');
  assert.ok(!existsSync(path.join(base, 'bagli-degil')));

  const nobody = await createGithubBackup({ config: { ...cfg, username: 'yok' }, stateDir, fetchImpl }).run();
  assert.equal(nobody.error, 'user_not_found');
});

test('GitHub yedeği: token sahibinin kendi hesabıysa özel repolar listelenir, token git komut satırına girmez', async (t) => {
  const base = tmp(t);
  const root = path.join(base, 'yedek');
  mkdirSync(root);
  const token = `github_pat_${'x'.repeat(40)}`;
  const { fetchImpl, calls } = fakeGithub((url) => {
    const u = new URL(url);
    if (u.pathname === '/user') return { json: { login: 'Deneme' } };
    if (u.pathname === '/user/repos') return { json: [] };
    return null;
  });
  const gitCalls = [];
  const git = async (args, opts) => {
    gitCalls.push({ args, env: opts?.env ?? {} });
    return { code: 0, stdout: '', stderr: '' };
  };
  const s = await createGithubBackup({ config: { username: 'deneme', dir: root, forks: false, issues: false, wiki: false }, token, stateDir: path.join(base, 'd'), fetchImpl, git }).run();
  assert.equal(s.ok, true);
  assert.ok(calls.some((c) => c.url.includes('/user/repos?affiliation=owner&visibility=all')));
  assert.ok(calls.every((c) => c.auth === `Bearer ${token}`));
  assert.ok(gitCalls.every((c) => !c.args.join(' ').includes(token)));
});

test('yardımcı: GitHub yedeği ayarı, token dosyası, zamanlayıcı ve klasör; token geçmişe yazılmaz', async (t) => {
  const root = tmp(t);
  const queue = path.join(root, 'var/lib/serverhealth-queue');
  mkdirSync(queue, { recursive: true });
  mkdirSync(path.join(root, 'etc/systemd/system'), { recursive: true });
  writeFileSync(path.join(root, 'etc/systemd/system/serverhealth-github.service'), '[Service]\n');
  writeFileSync(path.join(root, 'etc/passwd'), 'root:x:0:0::/root:/bin/bash\nserverhealth-backup:x:990:990::/var/lib/serverhealth-backup:/usr/sbin/nologin\n');
  mkdirSync(path.join(root, 'mnt/disk'), { recursive: true });
  const token = `github_pat_${'T'.repeat(40)}`;
  const put = (name, obj) => writeFileSync(path.join(queue, name), JSON.stringify(obj));
  const helper = createHelper({ root, dryRun: true, nodeBin: '/usr/bin/node', appDir: '/opt/serverhealth', now: () => 1700000000000, platformOverride: { packageManager: null, systemctl: '/usr/bin/systemctl', autoUpdates: false, git: true, githubBackup: true } });

  put('1.json', { type: 'settings', settings: { githubBackup: { enabled: true, username: 'deneme', dir: '/mnt/disk/github', time: '04:30', forks: true, issues: true, wiki: false, token } } });
  await helper.processQueue();
  const units = path.join(root, 'etc/systemd/system');
  assert.match(readFileSync(path.join(units, 'serverhealth-github.timer'), 'utf8'), /OnCalendar=\*-\*-\* 04:30:00\nPersistent=true\nUnit=serverhealth-github.service/);
  assert.equal(readFileSync(path.join(units, 'serverhealth-github.service.d/dir.conf'), 'utf8'), '[Service]\nReadWritePaths=/mnt/disk/github\n');
  assert.match(readFileSync(path.join(units, 'serverhealth-github.service.d/token.conf'), 'utf8'), /LoadCredential=github-token:\/etc\/serverhealth\/github-token/);
  const tokenFile = path.join(root, 'etc/serverhealth/github-token');
  assert.equal(readFileSync(tokenFile, 'utf8').trim(), token);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  assert.ok(statSync(path.join(root, 'mnt/disk/github')).isDirectory());
  const cfg = JSON.parse(readFileSync(path.join(root, 'var/lib/serverhealth/github-backup.json'), 'utf8'));
  assert.deepEqual(cfg, { username: 'deneme', dir: '/mnt/disk/github', time: '04:30', forks: true, issues: true, wiki: false });
  const status = readFileSync(path.join(root, 'var/lib/serverhealth/system.json'), 'utf8');
  const history = readFileSync(path.join(root, 'var/lib/serverhealth/actions.jsonl'), 'utf8');
  const state = readFileSync(path.join(root, 'var/lib/serverhealth/system-settings.json'), 'utf8');
  for (const text of [status, history, state, JSON.stringify(cfg)]) assert.doesNotMatch(text, /github_pat_/);
  assert.equal(JSON.parse(status).settings.githubBackup.tokenSet, true);

  // Şimdi yedekle, sonra token'ı sil ve kapat
  put('2.json', { type: 'action', action: 'github-backup' });
  await helper.processQueue();
  assert.ok(helper.commands.includes('/usr/bin/systemctl start --no-block serverhealth-github.service'));
  put('3.json', { type: 'settings', settings: { githubBackup: { enabled: false, token: '' } } });
  await helper.processQueue();
  assert.equal(existsSync(tokenFile), false);
  assert.equal(existsSync(path.join(units, 'serverhealth-github.service.d/token.conf')), false);
  assert.equal(existsSync(path.join(units, 'serverhealth-github.timer')), false);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'var/lib/serverhealth/system.json'), 'utf8')).settings.githubBackup.tokenSet, false);

  // Üst klasörü olmayan (bağlı olmayan disk) ya da başkasına ait dolu klasör kabul edilmez.
  put('4.json', { type: 'settings', settings: { githubBackup: { enabled: true, username: 'deneme', dir: '/mnt/yok/github', time: '04:30' } } });
  await helper.processQueue();
  assert.match(readFileSync(path.join(root, 'var/lib/serverhealth/actions.jsonl'), 'utf8').trim().split('\n').at(-1), /backup_dir_parent/);
  assert.equal(existsSync(path.join(root, 'mnt/yok')), false);
  mkdirSync(path.join(root, 'mnt/disk/dolu'));
  writeFileSync(path.join(root, 'mnt/disk/dolu/dosya'), 'x');
  symlinkSync('/etc', path.join(root, 'mnt/disk/bag'));
  for (const [i, dir] of [['5', '/mnt/disk/dolu'], ['6', '/mnt/disk/bag']]) {
    put(`${i}.json`, { type: 'settings', settings: { githubBackup: { enabled: true, username: 'deneme', dir, time: '04:30' } } });
    await helper.processQueue();
    assert.match(readFileSync(path.join(root, 'var/lib/serverhealth/actions.jsonl'), 'utf8').trim().split('\n').at(-1), /backup_dir/);
  }
  assert.deepEqual(readdirSync(path.join(root, 'mnt/disk/dolu')), ['dosya']);
});
