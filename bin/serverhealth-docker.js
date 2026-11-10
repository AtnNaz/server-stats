#!/usr/bin/env node
// Node Stats Docker yardımcısı (root). systemd soketi (serverhealth-docker.socket) her bağlantı için
// bunu başlatır: girişten tek satır JSON istek okur, Docker'a sorar, tek satır JSON yanıt yazar.
// Yapabildikleri sabittir: konteynerleri ve kaynak kullanımlarını listelemek; bir konteyneri
// başlatmak, durdurmak ya da yeniden başlatmak. Konteyner oluşturma, silme, komut çalıştırma yoktur.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDockerRequest, summarizeContainer, statsSummary } from '../src/docker-protocol.js';

const DOCKER_SOCKET = '/run/docker.sock';
const MAX_REQUEST = 4096;
const MAX_BODY = 8 * 1024 * 1024;

export function dockerApi(socketPath = DOCKER_SOCKET) {
  return function call(method, url, { timeout = 15_000 } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath, method, path: url, timeout, headers: { Host: 'docker' } }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY) req.destroy(Object.assign(new Error('too_large'), { code: 'too_large' }));
          else chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode, body });
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })));
      req.on('error', (err) => reject(Object.assign(err, { code: err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? 'docker_down' : err.code ?? 'docker_error' })));
      req.end();
    });
  };
}

const fail = (code) => Object.assign(new Error(code), { code });

export function createDockerHelper({ call = dockerApi() } = {}) {
  async function list() {
    const r = await call('GET', '/containers/json?all=1');
    if (r.status !== 200 || !Array.isArray(r.body)) throw fail('docker_error');
    return r.body;
  }

  async function overview() {
    const raw = await list();
    const containers = raw.map(summarizeContainer);
    // Çalışan konteynerlerin kaynak kullanımı: Docker iki ölçüm arasındaki farkı hesaplar (~1 sn).
    await Promise.all(
      containers
        .filter((c) => c.state === 'running')
        .map(async (c) => {
          try {
            const r = await call('GET', `/containers/${c.id}/stats?stream=false`, { timeout: 10_000 });
            if (r.status === 200) c.stats = statsSummary(r.body);
          } catch {
            /* ölçülemezse boş kalır */
          }
        }),
    );
    // İmaj bilgisi (güncelleme denetimi için yerel özetler) ve yeniden başlama sayısı.
    const images = new Map();
    await Promise.all(
      [...new Set(containers.map((c) => c.imageId).filter(Boolean))].map(async (id) => {
        try {
          const r = await call('GET', `/images/${encodeURIComponent(id)}/json`);
          if (r.status === 200) images.set(id, { digests: (r.body.RepoDigests ?? []).slice(0, 10), created: r.body.Created ?? null });
        } catch {
          /* yok sayılır */
        }
      }),
    );
    await Promise.all(
      containers.map(async (c) => {
        try {
          const r = await call('GET', `/containers/${c.id}/json`);
          if (r.status === 200) {
            c.restartCount = r.body.RestartCount ?? 0;
            c.startedAt = Date.parse(r.body.State?.StartedAt) || null;
            c.health = r.body.State?.Health?.Status ?? null;
            c.restartPolicy = r.body.HostConfig?.RestartPolicy?.Name ?? null;
          }
        } catch {
          /* yok sayılır */
        }
      }),
    );
    for (const c of containers) c.imageDigests = images.get(c.imageId)?.digests ?? [];
    return { containers };
  }

  async function action(q) {
    // Yalnızca var olan bir konteyner için; ad değil kimlik ile.
    const raw = await list();
    const target = raw.find((c) => c.Id === q.id || c.Id.startsWith(q.id));
    if (!target) throw fail('not_found');
    const r = await call('POST', `/containers/${target.Id}/${q.action}${q.action === 'start' ? '' : '?t=15'}`, { timeout: 60_000 });
    if (r.status === 204 || r.status === 304) return { ok: true, changed: r.status === 204 };
    if (r.status === 404) throw fail('not_found');
    throw fail('docker_error');
  }

  return {
    async handle(q) {
      if (q.op === 'overview') return overview();
      if (q.op === 'action') return action(q);
      throw fail('invalid');
    },
  };
}

function readRequest(stream) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      data += chunk;
      const nl = data.indexOf('\n');
      if (nl !== -1) {
        stream.pause();
        resolve(data.slice(0, nl));
      } else if (data.length > MAX_REQUEST) reject(fail('too_large'));
    });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

async function main() {
  const reply = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`, () => process.exit(0));
  let request;
  try {
    request = JSON.parse(await readRequest(process.stdin));
  } catch {
    return reply({ error: 'invalid' });
  }
  const q = validateDockerRequest(request);
  if (!q) return reply({ error: 'invalid' });
  if (q.op === 'action') console.error(`serverhealth-docker: ${q.action} ${q.id}`);
  try {
    reply(await createDockerHelper().handle(q));
  } catch (err) {
    const code = typeof err.code === 'string' && /^[a-z_]+$/.test(err.code) ? err.code : 'failed';
    if (code === 'failed') console.error(`serverhealth-docker: ${err.message}`);
    reply({ error: code });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
