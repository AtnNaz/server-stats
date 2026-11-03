import net from 'node:net';
import { access } from 'node:fs/promises';

// Panel terminali: tarayıcıdaki WebSocket ile systemd'nin açtığı PTY köprüsü arasında aracılık eder.
// Kabuk panel kullanıcısıyla değil, root yardımcısının ayarladığı kullanıcıyla (serverhealth-term@.service) çalışır.
//
// Tarayıcı → panel (ikili mesaj): [0][girdi baytları] ya da [1][sütun u16][satır u16]
// Panel → köprü: [tür u8][uzunluk u32][veri]; köprü → panel: ham terminal çıktısı.
export const CLOSE = { idle: 4000, session: 4001, unavailable: 4002, busy: 4003 };
const MAX_TERMINALS = 4;
const CHECK_MS = 15_000;

const packet = (type, payload) => {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
};

export async function terminalAvailable(socketPath) {
  try {
    await access(socketPath);
    return true;
  } catch {
    return false;
  }
}

export function createTerminals({ socketPath, idleMinutes, connect = (p) => net.createConnection(p) }) {
  const open = new Set();

  function attach(ws, { ip, sessionAlive }) {
    if (open.size >= MAX_TERMINALS) return ws.close(CLOSE.busy, 'busy');
    const started = Date.now();
    let lastInput = started;
    const pty = connect(socketPath);
    const entry = { ws, pty };
    open.add(entry);
    let ended = false;
    const end = (code, reason) => {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      open.delete(entry);
      pty.destroy();
      ws.close(code, reason);
      console.log(`Terminal kapandı (${ip}, ${Math.round((Date.now() - started) / 1000)} sn${reason ? `, ${reason}` : ''})`);
    };

    pty.on('connect', () => console.log(`Terminal açıldı (${ip})`));
    pty.on('data', (chunk) => ws.send(chunk));
    pty.on('error', () => end(CLOSE.unavailable, 'unavailable'));
    pty.on('close', () => end(1000, ''));

    ws.on('message', (msg, binary) => {
      if (!binary || !msg.length) return;
      if (msg[0] === 0) {
        lastInput = Date.now();
        pty.write(packet(0, msg.subarray(1)));
      } else if (msg[0] === 1 && msg.length === 5) {
        const cols = msg.readUInt16BE(1);
        const rows = msg.readUInt16BE(3);
        if (cols >= 2 && cols <= 1000 && rows >= 1 && rows <= 500) pty.write(packet(1, msg.subarray(1)));
      }
    });
    ws.on('close', () => end(1000, ''));

    const timer = setInterval(() => {
      if (!sessionAlive()) end(CLOSE.session, 'session');
      else if (Date.now() - lastInput > idleMinutes * 60_000) end(CLOSE.idle, 'idle');
    }, CHECK_MS);
  }

  return {
    attach,
    closeAll() {
      for (const { ws, pty } of open) {
        pty.destroy();
        ws.terminate();
      }
      open.clear();
    },
  };
}
