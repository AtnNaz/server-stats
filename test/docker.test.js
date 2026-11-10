import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDockerRequest, summarizeContainer, statsSummary, parseImageRef, localDigests, createImageUpdates, remoteDigest } from '../src/docker-protocol.js';
import { createDockerHelper } from '../bin/serverhealth-docker.js';

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;

test('docker istek doğrulaması', () => {
  assert.deepEqual(validateDockerRequest({ op: 'overview' }), { op: 'overview' });
  assert.ok(validateDockerRequest({ op: 'action', action: 'restart', id: 'abcdef012345' }));
  for (const bad of [{ op: 'action', action: 'rm', id: 'abcdef012345' }, { op: 'action', action: 'stop', id: 'web' }, { op: 'action', action: 'stop', id: 'abc' }, { op: 'exec' }, null, []]) {
    assert.equal(validateDockerRequest(bad), null, JSON.stringify(bad));
  }
});

test('konteyner ve kaynak özeti', () => {
  const c = summarizeContainer({ Id: 'a'.repeat(64), Names: ['/web'], Image: 'nginx:alpine', ImageID: 'sha256:x', State: 'running', Status: 'Up 2 hours', Created: 1700000000, Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }, { PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }], Labels: { 'com.docker.compose.project': 'site' } });
  assert.deepEqual([c.id, c.name, c.ports, c.project, c.created], ['aaaaaaaaaaaa', 'web', ['8080→80/tcp'], 'site', 1700000000000]);
  const s = statsSummary({
    cpu_stats: { cpu_usage: { total_usage: 3_000 }, system_cpu_usage: 20_000, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 10_000 },
    memory_stats: { usage: 500, limit: 1000, stats: { inactive_file: 100 } },
    networks: { eth0: { rx_bytes: 10, tx_bytes: 20 }, eth1: { rx_bytes: 1, tx_bytes: 2 } },
    blkio_stats: { io_service_bytes_recursive: [{ op: 'read', value: 7 }, { op: 'write', value: 9 }] },
  });
  assert.deepEqual([s.cpu, s.mem, s.memLimit, s.netRx, s.netTx, s.blkRead, s.blkWrite], [80, 400, 1000, 11, 22, 7, 9]);
});

test('imaj adı ayrıştırma ve yerel özetler', () => {
  assert.deepEqual(parseImageRef('ghcr.io/sahip/imaj:v1.2'), { registry: 'ghcr.io', repo: 'sahip/imaj', tag: 'v1.2' });
  assert.deepEqual(parseImageRef('postgres'), { registry: 'docker.io', repo: 'library/postgres', tag: 'latest' });
  assert.deepEqual(parseImageRef('localhost:5000/app:dev'), { registry: 'localhost:5000', repo: 'app', tag: 'dev' });
  assert.deepEqual(parseImageRef(`x/y@${D1}`), { pinned: true });
  assert.equal(parseImageRef('Kötü İsim'), null);
  assert.deepEqual(localDigests([`ghcr.io/sahip/imaj@${D1}`, 'bozuk']), [D1]);
});

test('kayıt sunucusu: anonim token ile özet okunur, güncelleme durumu işaretlenir', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push([String(url), opts.headers?.Authorization ?? null]);
    const u = new URL(url);
    if (u.pathname.startsWith('/v2/') && !opts.headers?.Authorization) return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.ornek.io/token",service="ornek.io"' } });
    if (u.host === 'auth.ornek.io') return Response.json({ token: 'T' });
    if (u.pathname === '/v2/sahip/yeni/manifests/1') return new Response(null, { status: 200, headers: { 'docker-content-digest': D2 } });
    if (u.pathname === '/v2/sahip/ayni/manifests/1') return new Response(null, { status: 200, headers: { 'docker-content-digest': D1 } });
    return new Response(null, { status: 404 });
  };
  assert.equal(await remoteDigest({ registry: 'ornek.io', repo: 'sahip/yeni', tag: '1' }, fetchImpl), D2);
  assert.equal(new URL(calls[1][0]).searchParams.get('scope'), 'repository:sahip/yeni:pull');
  assert.equal(calls[2][1], 'Bearer T');

  const up = createImageUpdates({ fetchImpl });
  const containers = [
    { name: 'a', image: 'ornek.io/sahip/yeni:1', imageDigests: [`ornek.io/sahip/yeni@${D1}`] },
    { name: 'b', image: 'ornek.io/sahip/ayni:1', imageDigests: [`ornek.io/sahip/ayni@${D1}`] },
    { name: 'c', image: `ornek.io/sahip/sabit@${D1}`, imageDigests: [] },
    { name: 'd', image: 'ornek.io/sahip/yok:1', imageDigests: [`ornek.io/sahip/yok@${D1}`] },
    { name: 'e', image: 'kendi-imajim:dev', imageDigests: [] },
  ];
  assert.deepEqual(up.annotate(containers).map((c) => c.update), [null, null, null, null, null]);
  await up.refresh(containers);
  assert.deepEqual(
    up.annotate(containers).map((c) => c.update.state),
    ['available', 'current', 'pinned', 'not_found', 'local'],
  );
});

test('docker yardımcısı: özet, kaynak kullanımı ve yalnızca var olan konteynere işlem', async () => {
  const id = 'b'.repeat(64);
  const calls = [];
  const call = async (method, url) => {
    calls.push(`${method} ${url}`);
    if (url === '/containers/json?all=1') return { status: 200, body: [{ Id: id, Names: ['/db'], Image: 'postgres:16', ImageID: 'sha256:img', State: 'running', Status: 'Up', Labels: {} }] };
    if (url.startsWith(`/containers/${'b'.repeat(12)}/stats`)) return { status: 200, body: { cpu_stats: { cpu_usage: { total_usage: 2 }, system_cpu_usage: 4, online_cpus: 2 }, precpu_stats: { cpu_usage: { total_usage: 1 }, system_cpu_usage: 2 }, memory_stats: { usage: 10, limit: 100 } } };
    if (url === '/images/sha256%3Aimg/json') return { status: 200, body: { RepoDigests: [`postgres@${D1}`] } };
    if (url === `/containers/${'b'.repeat(12)}/json`) return { status: 200, body: { RestartCount: 3, State: { StartedAt: '2026-11-10T10:00:00Z' }, HostConfig: { RestartPolicy: { Name: 'unless-stopped' } } } };
    if (method === 'POST') return { status: 204, body: null };
    return { status: 404, body: null };
  };
  const helper = createDockerHelper({ call });
  const { containers } = await helper.handle({ op: 'overview' });
  assert.deepEqual([containers[0].name, containers[0].stats.cpu, containers[0].restartCount, containers[0].imageDigests[0]], ['db', 100, 3, `postgres@${D1}`]);
  assert.deepEqual(await helper.handle({ op: 'action', action: 'restart', id: 'bbbbbbbbbbbb' }), { ok: true, changed: true });
  assert.ok(calls.includes(`POST /containers/${id}/restart?t=15`));
  await assert.rejects(helper.handle({ op: 'action', action: 'stop', id: 'cccccccccccc' }), { code: 'not_found' });
});
