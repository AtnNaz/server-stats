import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

// Bağımlılıksız, küçük bir WebSocket (RFC 6455) sunucu tarafı: yalnızca panel terminalinin ihtiyacı kadar.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;

export const acceptKey = (key) => createHash('sha1').update(key + GUID).digest('base64');

function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (len < 126) head[1] = len;
  else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

// Yükseltme isteğini doğrular ve 101 yanıtını yazar. Geçersizse null döner (yanıtı çağıran yazar).
export function upgrade(req, socket, headers = {}) {
  const key = req.headers['sec-websocket-key'];
  if (
    req.method !== 'GET' ||
    String(req.headers.upgrade).toLowerCase() !== 'websocket' ||
    req.headers['sec-websocket-version'] !== '13' ||
    typeof key !== 'string' ||
    Buffer.from(key, 'base64').length !== 16
  ) {
    return null;
  }
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  return createConnection(socket);
}

// Olaylar: 'message' (Buffer, isBinary), 'close'. İstemci çerçeveleri maskeli olmak zorunda.
export function createConnection(socket) {
  const ws = new EventEmitter();
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;
  let closed = false;

  const fail = (code = 1002) => ws.close(code);

  ws.send = (data, binary = true) => {
    if (closed) return;
    socket.write(frame(binary ? 0x2 : 0x1, Buffer.isBuffer(data) ? data : Buffer.from(String(data))));
  };
  ws.close = (code = 1000, reason = '') => {
    if (closed) return;
    closed = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    socket.end(frame(0x8, payload));
    setTimeout(() => socket.destroy(), 2000).unref();
    ws.emit('close');
  };
  ws.terminate = () => {
    if (!closed) {
      closed = true;
      ws.emit('close');
    }
    socket.destroy();
  };

  function parse() {
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (!masked || buffer[0] & 0x70) return fail();
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return fail(1009);
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_MESSAGE) return fail(1009);
      if (buffer.length < offset + 4 + len) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffer = buffer.subarray(offset + 4 + len);

      if (opcode >= 0x8) {
        if (!fin || len > 125) return fail();
        if (opcode === 0x8) return ws.close();
        if (opcode === 0x9) socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0x0) {
        if (!fragmentOpcode) return fail();
      } else if (fragmentOpcode) {
        return fail();
      } else {
        fragmentOpcode = opcode;
      }
      fragments.push(payload);
      if (fragments.reduce((s, b) => s + b.length, 0) > MAX_MESSAGE) return fail(1009);
      if (fin) {
        const message = Buffer.concat(fragments);
        const binary = fragmentOpcode === 0x2;
        fragments = [];
        fragmentOpcode = 0;
        ws.emit('message', message, binary);
      }
    }
  }

  socket.on('data', (chunk) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MESSAGE + 16) return fail(1009);
    parse();
  });
  socket.on('close', () => {
    if (!closed) {
      closed = true;
      ws.emit('close');
    }
  });
  socket.on('error', () => socket.destroy());
  return ws;
}
