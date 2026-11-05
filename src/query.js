import net from 'node:net';
import { stat } from 'node:fs/promises';

// Root sorgu yardımcısına (serverhealth-query@.service) tek satır JSON istek gönderir ve yanıtını okur.
const MAX_REPLY = 32 * 1024 * 1024;

export async function queryAvailable(socketPath) {
  try {
    return (await stat(socketPath)).isSocket();
  } catch {
    return false;
  }
}

export function runQuery({ socketPath, request, timeoutMs = 15_000, connect = (p) => net.createConnection(p) }) {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      sock.destroy();
      finish(reject, Object.assign(new Error('timeout'), { code: 'timeout' }));
    }, timeoutMs);
    sock.on('connect', () => sock.write(`${JSON.stringify(request)}\n`));
    sock.on('data', (d) => {
      size += d.length;
      if (size > MAX_REPLY) return sock.destroy(Object.assign(new Error('too_large'), { code: 'too_large' }));
      chunks.push(d);
    });
    sock.on('error', (err) => finish(reject, Object.assign(err, { code: err.code === 'too_large' ? 'too_large' : 'unavailable' })));
    sock.on('close', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const result = JSON.parse(text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n')));
        if (result.error) return finish(reject, Object.assign(new Error(result.error), { code: result.error }));
        finish(resolve, result);
      } catch {
        finish(reject, Object.assign(new Error('bad_reply'), { code: 'unavailable' }));
      }
    });
  });
}
