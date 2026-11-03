import net from 'node:net';

// Yapay zekâ komutlarını systemd'nin açtığı köprüye (serverhealth-exec@.service) gönderir.
// Köprü komutu terminal kullanıcısıyla çalıştırır ve tek satır JSON sonuç döner.
const MAX_REPLY = 256 * 1024;

// sudoPassword verilirse köprü komutu "sudo -k -S" ile çalıştırır ve şifreyi yalnızca sudo'nun girişine yazar.
export function runCommand({ socketPath, command, timeoutSeconds = 30, sudoPassword = null, connect = (p) => net.createConnection(p) }) {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
    }, (timeoutSeconds + 10) * 1000);
    sock.on('connect', () => sock.write(`${JSON.stringify({ command, timeout: timeoutSeconds, ...(sudoPassword !== null && { sudo_password: sudoPassword }) })}\n`));
    sock.on('data', (d) => {
      size += d.length;
      if (size > MAX_REPLY) return sock.destroy(new Error('too_large'));
      chunks.push(d);
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(Object.assign(err, { code: err.code ?? 'unavailable' }));
    });
    sock.on('close', () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8').split('\n')[0]);
        if (result.error) return reject(Object.assign(new Error(result.error), { code: result.error }));
        resolve({ code: Number(result.code), output: String(result.output ?? ''), truncated: Boolean(result.truncated), timedOut: Boolean(result.timedOut) });
      } catch {
        reject(Object.assign(new Error('bad_reply'), { code: 'unavailable' }));
      }
    });
  });
}
