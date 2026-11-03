import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHistoryStore, sampleOf } from '../src/history-store.js';
import { createConnection, acceptKey } from '../src/websocket.js';
import { createTerminals } from '../src/terminal.js';
import { createOllama, validateChat } from '../src/ollama.js';
import { createHelper } from '../bin/serverhealth-helper.js';
import { validateRequest } from '../src/system-settings.js';

const MINUTE = 60_000;
const tempDir = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'serverhealth-feat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const snapshot = (time, cpu, extra = {}) => ({
  time,
  system: { cpu: { usage: cpu, load: [0.5, 0.4, 0.3] }, memory: { percent: 40, swapPercent: 0 } },
  sensors: { cpu: { package: 50 } },
  network: { interfaces: [{ name: 'eth0', rxRate: 1000, txRate: 500 }] },
  storage: { devices: [{ name: 'sda', readRate: 10, writeRate: 20, smart: { temperature: 35 } }] },
  gpu: { gpus: [{ id: 'nvidia0', utilization: cpu, memoryPercent: 10, temperature: 40, powerDraw: 15 }] },
  ...extra,
});

test('geçmiş: anlık görüntüler dakikalık ortalamalara indirilir, aralıklara bölünür, eskiler silinir', async (t) => {
  const dir = tempDir(t);
  const base = Date.UTC(2026, 10, 3, 10, 0, 0);
  let clock = base;
  // Süre sınırından eski bir dosya ve bozuk satır içeren bir dosya
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '2026-09-01.jsonl'), '{"t":0}\n');
  const store = createHistoryStore({ dir, retentionDays: 30, now: () => clock });

  assert.equal(sampleOf(snapshot(base, 10)).gpu.nvidia0[3], 15);
  store.add(snapshot(base + 1000, 10));
  store.add(snapshot(base + 30_000, 30));
  store.add(snapshot(base + MINUTE + 1000, 50)); // dakika değişti: ilk dakika yazılır
  store.add(snapshot(base + 2 * MINUTE, 70, { gpu: { gpus: [] } }));
  await store.flush(); // kapanışta yarım dakika da yazılır
  clock = base + 3 * MINUTE;

  const lines = readFileSync(path.join(dir, '2026-11-03.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.deepEqual([lines[0].t, lines[0].cpu, lines[0].net.eth0], [base, 20, [1000, 500]]);
  assert.deepEqual([lines[1].cpu, lines[2].cpu, lines[2].gpu], [50, 70, {}]);
  assert.equal(existsSync(path.join(dir, '2026-09-01.jsonl')), false);

  writeFileSync(path.join(dir, '2026-11-03.jsonl'), `${readFileSync(path.join(dir, '2026-11-03.jsonl'), 'utf8')}{"t":yarım\n`);
  const day = await store.query('1d');
  assert.equal(day.step, 5 * MINUTE);
  const filled = day.points.filter((p) => p.cpu != null);
  assert.equal(filled.length, 1);
  assert.equal(filled[0].cpu, 46.7); // üç dakikanın ortalaması
  assert.deepEqual(filled[0].gpu.nvidia0, [35, 10, 40, 15]); // GPU'suz dakika ortalamaya girmez
  assert.deepEqual(filled[0].io.sda, [10, 20]);
  assert.ok(day.points.length >= 288 && day.points.length <= 289);
  await assert.rejects(store.query('1y'));
});

// İstemci çerçevesi: FIN + maske zorunlu
function clientFrame(opcode, payload, { mask = true } = {}) {
  const key = Buffer.from([1, 2, 3, 4]);
  const body = Buffer.from(payload);
  const head = Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | body.length]);
  if (!mask) return Buffer.concat([head, body]);
  return Buffer.concat([head, key, Buffer.from(body.map((b, i) => b ^ key[i & 3]))]);
}

function socketPair(t) {
  return new Promise((resolve) => {
    const server = net.createServer((s) => resolve({ server: s, client }));
    t.after(() => server.close());
    let client;
    server.listen(0, '127.0.0.1', () => {
      client = net.createConnection(server.address().port, '127.0.0.1');
      t.after(() => client.destroy());
    });
  });
}

test('websocket: el sıkışma anahtarı, maskeli mesajlar, ping ve maskesiz çerçevenin reddi', async (t) => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');

  const { server, client } = await socketPair(t);
  const ws = createConnection(server);
  const got = new Promise((resolve) => ws.on('message', (msg, binary) => resolve([msg.toString(), binary])));
  const pong = new Promise((resolve) => client.once('data', resolve));
  client.write(clientFrame(0x9, 'p'));
  assert.equal((await pong)[0], 0x8a);
  client.write(clientFrame(0x2, 'merhaba'));
  assert.deepEqual(await got, ['merhaba', true]);

  const closed = new Promise((resolve) => ws.on('close', resolve));
  const closeFrame = new Promise((resolve) => client.on('data', (d) => d[0] === 0x88 && resolve(d.readUInt16BE(2))));
  client.write(clientFrame(0x2, 'x', { mask: false }));
  await closed;
  assert.equal(await closeFrame, 1002);
});

test('terminal: girdi ve boyut çerçevelenir, geçersiz boyut ve metin mesajı iletilmez', async () => {
  const written = [];
  const pty = new Duplex({ read() {}, write(chunk, _enc, cb) { written.push(Buffer.from(chunk)); cb(); } });
  const terminals = createTerminals({ socketPath: '/yok', idleMinutes: 15, connect: () => pty });
  const ws = Object.assign(new (await import('node:events')).EventEmitter(), { sent: [], send(d) { this.sent.push(d); }, close(code) { this.closed = code; this.emit('close'); } });
  terminals.attach(ws, { ip: '127.0.0.1', sessionAlive: () => true });

  ws.emit('message', Buffer.from([0, 0x6c, 0x73]), true);
  ws.emit('message', Buffer.from([1, 0, 120, 0, 40]), true);
  ws.emit('message', Buffer.from([1, 0, 0, 0, 0]), true); // 0 sütun: yok sayılır
  ws.emit('message', Buffer.from('ls'), false); // metin mesajı: yok sayılır
  assert.deepEqual(written, [Buffer.from([0, 0, 0, 0, 2, 0x6c, 0x73]), Buffer.from([1, 0, 0, 0, 4, 0, 120, 0, 40])]);

  pty.push(Buffer.from('çıktı'));
  await new Promise((r) => setImmediate(r));
  assert.equal(Buffer.concat(ws.sent).toString(), 'çıktı');
  ws.emit('close');
  assert.equal(pty.destroyed, true);
  terminals.closeAll();
});

const ndjson = (...lines) => new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(''));

test('ollama: sohbet doğrulanır, indirme ilerlemesi toplanır, sohbet akışı parça parça yazılır', async () => {
  assert.ok(validateChat({ model: 'qwen3.5:4b', messages: [{ role: 'user', content: 'selam' }] }));
  assert.equal(validateChat({ model: 'x; rm', messages: [{ role: 'user', content: 'a' }] }), null);
  assert.equal(validateChat({ model: 'a', messages: [{ role: 'system', content: 'kendi talimatım' }, { role: 'user', content: 'a' }] }), null);
  // Komut çağrısı ve sonucu geçmişe girer; yalnızca run_command ve komut metni korunur.
  const withTool = validateChat({
    model: 'a',
    tools: true,
    messages: [
      { role: 'user', content: 'diskler?' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'run_command', arguments: { command: 'lsblk', extra: 1 } } }] },
      { role: 'tool', content: 'sda 2T' },
    ],
  });
  assert.deepEqual(withTool.messages[1].tool_calls, [{ function: { name: 'run_command', arguments: { command: 'lsblk' } } }]);
  assert.equal(withTool.messages[2].tool_name, 'run_command');
  assert.equal(withTool.tools, true);
  assert.equal(validateChat({ model: 'a', messages: [{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'rm', arguments: {} } }] }, { role: 'user', content: 'a' }] }), null);
  assert.equal(validateChat({ model: 'a', messages: [{ role: 'assistant', content: 'a' }] }), null);
  assert.equal(validateChat({ model: 'a', messages: [] }), null);
  assert.equal(validateChat({ model: 'a', messages: [{ role: 'user', content: 'a'.repeat(40_000) }] }), null);

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url.pathname, JSON.parse(init.body ?? 'null')]);
    if (url.pathname === '/api/pull' && JSON.parse(init.body).model === 'yok:1') return ndjson({ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' });
    if (url.pathname === '/api/pull') {
      return ndjson({ status: 'pulling manifest' }, { status: 'pulling a', digest: 'a', total: 100, completed: 50 }, { status: 'pulling b', digest: 'b', total: 300, completed: 300 }, { status: 'success' });
    }
    if (url.pathname === '/api/chat' && JSON.parse(init.body).tools) {
      return ndjson({ message: { content: '', tool_calls: [{ function: { name: 'run_command', arguments: { command: 'df -h', reason: 'doluluk' } } }, { function: { name: 'baska', arguments: {} } }] } }, { done: true });
    }
    if (url.pathname === '/api/chat') {
      return ndjson({ message: { content: 'Mer' } }, { message: { content: 'haba' } }, { done: true, eval_count: 10, eval_duration: 2e9, prompt_eval_count: 5, prompt_eval_duration: 1e8 });
    }
    return new Response('{}', { status: 404 });
  };
  const ollama = createOllama({ url: 'http://127.0.0.1:11434', fetchImpl });
  const waitPull = async () => {
    for (let i = 0; i < 50 && !ollama.pullStatus().done; i++) await new Promise((r) => setTimeout(r, 5));
    return ollama.pullStatus();
  };

  assert.equal(ollama.startPull('qwen3:8b'), true);
  assert.equal(ollama.startPull('baska:1'), false); // aynı anda tek indirme
  const done = await waitPull();
  assert.deepEqual([done.error, done.total, done.completed, done.status], [null, 400, 350, 'success']);
  assert.equal(ollama.startPull('yok:1'), true);
  assert.equal((await waitPull()).error, 'not_found');

  const parts = [];
  await ollama.chat({ model: 'qwen3.5:4b', messages: [{ role: 'user', content: 'selam' }], think: false }, { signal: AbortSignal.timeout(1000), write: (p) => parts.push(p) });
  assert.equal(parts.filter((p) => p.t).map((p) => p.t).join(''), 'Merhaba');
  assert.deepEqual(parts.at(-1), { done: true, stats: { generated: 10, generateRate: 5, prompt: 5, promptRate: 50 } });
  assert.equal(calls.find(([p]) => p === '/api/chat')[1].stream, true);
  const toolParts = [];
  await ollama.chat({ model: 'qwen3.5:4b', messages: [{ role: 'user', content: 'disk' }], tools: [{ type: 'function' }] }, { signal: AbortSignal.timeout(1000), write: (p) => toolParts.push(p) });
  assert.deepEqual(toolParts[0], { calls: [{ command: 'df -h', reason: 'doluluk' }] });
});

test('terminal ayarı: kullanıcı doğrulanır, systemd ek dosyası yazılır, kapatınca kaldırılır', async (t) => {
  assert.ok(validateRequest({ type: 'settings', settings: { terminal: { enabled: true, user: 'ali' } } }).request);
  assert.ok(validateRequest({ type: 'settings', settings: { terminal: { enabled: true, user: '' } } }).errors);
  assert.ok(validateRequest({ type: 'settings', settings: { terminal: { enabled: true, user: 'ali\nUser=root' } } }).errors);
  assert.ok(validateRequest({ type: 'settings', settings: { terminal: { enabled: false } } }).request);

  const root = tempDir(t);
  const queue = path.join(root, 'var/lib/serverhealth-queue');
  mkdirSync(queue, { recursive: true });
  const put = (name, obj) => writeFileSync(path.join(queue, name), JSON.stringify(obj));
  const platform = { packageManager: 'apt', systemctl: '/usr/bin/systemctl', autoUpdates: true, updateNow: true, smartTests: true, unattendedInstalled: true, terminal: true, terminalUsers: ['ali'] };
  const helper = createHelper({ root, dryRun: true, now: () => 1700000000000, platformOverride: platform });
  const dropIn = path.join(root, 'etc/systemd/system/serverhealth-term@.service.d/user.conf');
  const actions = () => readFileSync(path.join(root, 'var/lib/serverhealth/actions.jsonl'), 'utf8');

  put('1.json', { type: 'settings', settings: { terminal: { enabled: true, user: 'root' } } });
  await helper.processQueue();
  assert.equal(existsSync(dropIn), false);
  assert.match(actions(), /terminal_user/);

  put('2.json', { type: 'settings', settings: { terminal: { enabled: true, user: 'ali' } } });
  await helper.processQueue();
  assert.equal(readFileSync(dropIn, 'utf8'), '[Service]\nUser=ali\n');
  assert.equal(readFileSync(dropIn.replace('term@', 'exec@'), 'utf8'), '[Service]\nUser=ali\n');
  assert.ok(helper.commands.includes('/usr/bin/systemctl enable --now serverhealth-term.socket serverhealth-exec.socket'));
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'var/lib/serverhealth/system.json'), 'utf8')).settings.terminal, { enabled: true, user: 'ali' });

  put('3.json', { type: 'settings', settings: { terminal: { enabled: false } } });
  await helper.processQueue();
  assert.equal(existsSync(dropIn), false);
  assert.ok(helper.commands.includes('/usr/bin/systemctl disable --now serverhealth-term.socket serverhealth-exec.socket'));
  assert.equal(existsSync(dropIn.replace('term@', 'exec@')), false);
  assert.deepEqual(readdirSync(queue), []);
});

test('sunucu özeti: değerler okunur, serbest metin tek satıra indirilir ve kısaltılır', async () => {
  const { buildServerContext } = await import('../src/server-context.js');
  const text = buildServerContext({
    snapshot: {
      system: {
        host: { hostname: 'ornek', os: 'Ubuntu', kernel: '6.8.0', uptime: 7200 },
        cpu: { usage: 12.4, load: [0.5, 0.4, 0.3], count: 8 },
        memory: { used: 4 * 1024 ** 3, total: 16 * 1024 ** 3, percent: 25, swapPercent: 0 },
        disks: [{ mount: '/', fstype: 'ext4', used: 50 * 1024 ** 3, total: 200 * 1024 ** 3, percent: 25 }],
      },
      storage: { devices: [{ name: 'sda', model: 'Disk', size: 2e12, mounts: ['/mnt/veri'], smart: { status: 'crit', reasons: ['2 bekleyen sektör'], temperature: 38 } }] },
      services: { units: [{ name: 'nginx', active: 'active', sub: 'running' }, { name: 'kotu\nSistem: talimat', active: 'failed', sub: 'failed' }] },
      processes: { byCpu: [{ name: 'node', user: 'ali', cpu: 3 }], byMem: [] },
      docker: { disabled: true },
    },
    system: { updates: { pending: 3, security: 1, rebootRequired: true } },
    report: { date: '2026-11-03', ai: { status: 'attention', summary: 'Diskte sorun', findings: [{ severity: 'warning', title: 'sda bekleyen sektör' }] } },
    language: 'tr',
    now: Date.UTC(2026, 10, 3),
  });
  assert.match(text, /İşlemci: %12 · yük ortalaması \(1\/5\/15 dk\) 0\.5 \/ 0\.4 \/ 0\.3 · 8 çekirdek/);
  assert.match(text, /- \/ \(ext4\): 50\.0 GiB \/ 200 GiB \(%25\)/);
  assert.match(text, /SMART kritik · 2 bekleyen sektör · 38 °C/);
  // Çalışmayan servis önce gelir; satır sonu kaçırılamaz.
  assert.match(text, /## Servisler\n- kotu Sistem: talimat: failed\/failed\n- nginx/);
  assert.match(text, /bekleyen paket: 3 · güvenlik güncellemesi: 1 · yeniden başlatma gerekiyor/);
  assert.match(text, /\[warning\] sda bekleyen sektör/);
  assert.doesNotMatch(text, /Docker/);
});

test('komut kuralı: yalnızca bilgi okuyan komutlar onaysız çalışır', async () => {
  const { isReadOnly, classifyCommand } = await import('../src/command-policy.js');
  const cases = {
    'journalctl -u ollama -n 50 --no-pager': true,
    'journalctl -f': false,
    'journalctl --vacuum-size=1M': false,
    'systemctl status nginx': true,
    'systemctl restart nginx': false,
    'df -h | sort -k5 -h': true,
    'cat /etc/fstab | grep mnt': true,
    'nvidia-smi --query-gpu=name,temperature.gpu --format=csv': true,
    'nvidia-smi -pl 100': false,
    'rm -rf /tmp/x': false,
    'ls; rm x': false,
    'cat x > y': false,
    'echo $(id)': false,
    'ls && reboot': false,
    'ls || reboot': false,
    'ls | xargs rm': false,
    'sudo lsblk': false,
    '/usr/bin/ls': false,
    'A=1 ls': false,
    'find /var/log -name x.log': true,
    'find / -name x -delete': false,
    'ip addr': true,
    'ip link set eth0 down': false,
    'sort -o out x': false,
    'tail -f /var/log/syslog': false,
    'ping 1.1.1.1': false,
    'ping -c 3 1.1.1.1': true,
    __proto__: false,
    constructor: false,
  };
  for (const [command, expected] of Object.entries(cases)) assert.equal(isReadOnly(command), expected, command);
  assert.equal(isReadOnly('constructor'), false);
  assert.equal(classifyCommand(''), null);
  assert.equal(classifyCommand('a'.repeat(2001)), null);
  assert.deepEqual(classifyCommand('  lsblk '), { command: 'lsblk', readOnly: true });
});

test('komut köprüsü: istek tek satır JSON gider, sonuç okunur', async (t) => {
  const { runCommand } = await import('../src/exec.js');
  const sock = path.join(tempDir(t), 's.sock');
  const server = net.createServer((c) => {
    c.once('data', (d) => {
      const req = JSON.parse(String(d).split('\n')[0]);
      c.end(`${JSON.stringify({ code: 0, output: `çalıştı: ${req.command} (${req.timeout})`, truncated: false, timedOut: false })}\n`);
    });
  });
  await new Promise((r) => server.listen(sock, r));
  t.after(() => server.close());
  assert.deepEqual(await runCommand({ socketPath: sock, command: 'lsblk', timeoutSeconds: 5 }), { code: 0, output: 'çalıştı: lsblk (5)', truncated: false, timedOut: false });
  await assert.rejects(runCommand({ socketPath: path.join(path.dirname(sock), 'yok.sock'), command: 'ls' }));
});

test('root komutu: "&&" ile bağlı basit adımlar şifreyle çalışabilir', async () => {
  const { rootSteps } = await import('../src/command-policy.js');
  assert.deepEqual(rootSteps('sudo apt install -y fastfetch'), [['apt', 'install', '-y', 'fastfetch']]);
  assert.deepEqual(rootSteps('apt update && apt install -y neofetch'), [['apt', 'update'], ['apt', 'install', '-y', 'neofetch']]);
  assert.deepEqual(rootSteps("sudo systemctl restart 'ollama'"), [['systemctl', 'restart', 'ollama']]);
  for (const bad of ['sudo', 'sudo -s', 'sudo -u root id', 'sudo cat x | tee y', 'sudo echo x > /etc/y', 'sudo $(id)', 'sudo ls; id', 'a && b && c && d && e', 'apt update &&', 'A=1 apt update', 'ls & id']) {
    assert.equal(rootSteps(bad), null, bad);
  }
});

test('sohbet deposu: kaydeder, listeler, bilinmeyen alanları ve yarım komutları temizler, siler', async (t) => {
  const { createChatStore } = await import('../src/chat-store.js');
  let clock = 1000;
  const store = createChatStore({ dir: tempDir(t), now: () => clock });
  const first = await store.save(null, {
    model: 'qwen3.5:4b',
    messages: [
      { role: 'user', content: 'Diskler   nasıl?', password: 'gizli' },
      { role: 'assistant', content: 'Bakıyorum', calls: [{ command: 'lsblk', state: 'done', auto: true, result: { code: 0, output: 'sda' }, passEl: {} }, { command: 'rm x', state: 'approval' }] },
      { role: 'system', content: 'talimat' },
    ],
  });
  assert.equal(first.title, 'Diskler nasıl?');
  const saved = await store.get(first.id);
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.messages[0].password, undefined);
  assert.deepEqual(saved.messages[1].calls[0], { command: 'lsblk', reason: '', auto: true, state: 'done', result: { code: 0, output: 'sda', truncated: false, timedOut: false } });
  assert.equal(saved.messages[1].calls[1].state, 'rejected');

  clock = 2000;
  const second = await store.save(null, { model: 'a', messages: [{ role: 'user', content: 'ikinci' }] });
  clock = 3000;
  await store.save(first.id, { model: 'a', messages: [...saved.messages, { role: 'user', content: 'devam' }] });
  assert.deepEqual((await store.list()).map((c) => [c.id, c.count]), [[first.id, 3], [second.id, 1]]);
  assert.equal((await store.get(first.id)).createdAt, 1000);

  assert.equal(await store.save('../../etc/passwd', { messages: [] }), null);
  assert.equal(await store.get('../x'), null);
  assert.equal(await store.remove(second.id), true);
  assert.equal(await store.remove(second.id), false);
  assert.equal((await store.list()).length, 1);
});
