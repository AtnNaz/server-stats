import net from 'node:net';

const MAX_REPLY = 16 * 1024 * 1024;
const fail = (code) => Object.assign(new Error(code), { code });

export function filesCall({ socketPath, request, body = null, timeoutMs = 30_000, connect = (p) => net.createConnection(p) }) {
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
      finish(reject, fail('timeout'));
    }, timeoutMs);
    sock.on('connect', () => {
      sock.write(`${JSON.stringify(request)}\n`);
      if (body?.length) sock.write(body);
    });
    sock.on('data', (d) => {
      size += d.length;
      if (size > MAX_REPLY) return sock.destroy(fail('too_large'));
      chunks.push(d);
    });
    sock.on('error', (err) => finish(reject, fail(err.code === 'too_large' ? 'too_large' : 'unavailable')));
    sock.on('close', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const nl = text.indexOf('\n');
        const result = JSON.parse(nl === -1 ? text : text.slice(0, nl));
        if (result.error) return finish(reject, fail(result.error));
        finish(resolve, result);
      } catch {
        finish(reject, fail('unavailable'));
      }
    });
  });
}

export function filesRead({ socketPath, path, timeoutMs = 30_000, connect = (p) => net.createConnection(p) }) {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      sock.destroy();
      done(reject, fail('timeout'));
    }, timeoutMs);
    function done(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    }
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(10);
      if (nl === -1) {
        if (buf.length > 64 * 1024) sock.destroy(fail('too_large'));
        return;
      }
      sock.off('data', onData);
      sock.pause();
      let head;
      try {
        head = JSON.parse(buf.subarray(0, nl).toString('utf8'));
      } catch {
        sock.destroy();
        return done(reject, fail('unavailable'));
      }
      if (head.error) {
        sock.destroy();
        return done(reject, fail(head.error));
      }
      done(resolve, { info: head, rest: buf.subarray(nl + 1), socket: sock });
    };
    sock.on('connect', () => sock.write(`${JSON.stringify({ op: 'read', path })}\n`));
    sock.on('data', onData);
    sock.on('error', (err) => done(reject, fail(err.code === 'too_large' ? 'too_large' : 'unavailable')));
    sock.on('close', () => done(reject, fail('unavailable')));
  });
}

export function contentDisposition(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]|["\\%;]/g, '_') || 'dosya';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export const FILE_STATUS = { not_found: 404, denied: 403, exists: 409, not_empty: 409, busy: 409, no_space: 507, files_unavailable: 409, unavailable: 502, timeout: 504, root: 409 };
