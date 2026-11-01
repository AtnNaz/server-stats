import http from 'node:http';
import { t } from '../i18n.js';

const MAX_BODY = 5 * 1024 * 1024;

function describeError(err) {
  if (err.code === 'EACCES') return new Error(t('err.dockerPermission'));
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') return new Error(t('err.dockerDown'));
  return err;
}

function dockerGet(socketPath, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path, timeout: 2000, headers: { Host: 'docker' } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) req.destroy(new Error(t('err.dockerTooLarge')));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(t('err.dockerStatus', { code: res.statusCode })));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error(t('err.dockerParse')));
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(t('err.dockerTimeout'))));
    req.on('error', (err) => reject(describeError(err)));
  });
}

// Docker aynı yayını IPv4 ve IPv6 için ayrı listeler; etiketler tekilleştirilir.
export function summarizePorts(ports = []) {
  const labels = ports.map((p) => (p.PublicPort ? `${p.PublicPort}→${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`));
  return [...new Set(labels)];
}

export function createDockerCollector({ socket }) {
  return {
    async collect() {
      const list = await dockerGet(socket, '/containers/json?all=1');
      const containers = list
        .map((c) => {
          const id = String(c.Id).slice(0, 12);
          return {
            id,
            name: (c.Names?.[0] ?? '').replace(/^\//, '') || id,
            image: c.Image,
            state: c.State,
            status: c.Status,
            ports: summarizePorts(c.Ports),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return { containers, running: containers.filter((c) => c.state === 'running').length, total: containers.length };
    },
  };
}
