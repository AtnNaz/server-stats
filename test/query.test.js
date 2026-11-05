import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateQuery,
  validScanPath,
  journalArgs,
  parseJournal,
  guessPriority,
  parseDockerLine,
  parseSshdConfig,
  analyzeSshLog,
  parseListening,
  addressScope,
  cleanMessage,
} from '../src/query-protocol.js';
import { scanUsage, pruneTree, createQuery } from '../bin/serverhealth-query.js';
import { runQuery } from '../src/query.js';
import { hexToIPv4, hexToIPv6 } from '../src/collectors/network.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsq-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test('istek doğrulama: tarama yolu, günlük ölçütleri ve bilinmeyen işlemler', () => {
  for (const ok of ['/', '/mnt/disk', '/home/a b']) assert.equal(validScanPath(ok), true, ok);
  for (const bad of ['', 'rel', '/mnt/', '/a/../b', '/a//b', '/proc', '/proc/1', '/sys/x', '/dev', '/run/user', '/a\0b', 5]) assert.equal(validScanPath(bad), false, String(bad));
  assert.equal(validateQuery({ op: 'du', path: '/mnt' }).path, '/mnt');
  assert.equal(validateQuery({ op: 'rm' }), null);
  assert.equal(validateQuery([]), null);

  const q = validateQuery({ op: 'logs', source: { kind: 'unit', name: 'ssh.service' } });
  assert.deepEqual([q.priority, q.since, q.limit, q.search], [7, '1h', 300, '']);
  assert.equal(validateQuery({ op: 'logs', source: { kind: 'unit', name: '-x' } }), null);
  assert.equal(validateQuery({ op: 'logs', source: { kind: 'unit', name: 'a;rm' } }), null);
  assert.equal(validateQuery({ op: 'logs', source: { kind: 'shell' } }), null);
  assert.equal(validateQuery({ op: 'logs', source: { kind: 'all' }, since: 'forever' }), null);
  assert.equal(validateQuery({ op: 'logs', source: { kind: 'all' }, limit: 5000 }), null);
  assert.equal(validateQuery({ op: 'logs', source: { kind: 'all' }, search: 'a\nb' }), null);
  // Konteynerde imleç bayt konumudur, günlükte journald imleci.
  assert.ok(validateQuery({ op: 'logs', source: { kind: 'container', name: 'web-app' }, after: '1234' }));
  assert.equal(validateQuery({ op: 'logs', source: { kind: 'container', name: 'web-app' }, after: 's=ab;i=1' }), null);
  assert.ok(validateQuery({ op: 'logs', source: { kind: 'all' }, after: 's=ab12;i=1f;b=cd' }));
  assert.equal(validateQuery({ op: 'logs', source: { kind: 'all' }, after: 's=a', before: '1' }), null);
});

test('journalctl argümanları: kaynak, önem, zaman, imleç ve düz metin arama', () => {
  const q = validateQuery({ op: 'logs', source: { kind: 'unit', name: 'nginx.service' }, priority: 4, since: '24h', search: 'a.b(c)', limit: 50 });
  const args = journalArgs(q);
  assert.deepEqual(args.slice(args.indexOf('-u'), args.indexOf('-u') + 2), ['-u', 'nginx.service']);
  assert.ok(args.includes('0..4'));
  assert.deepEqual(args.slice(args.indexOf('--since'), args.indexOf('--since') + 2), ['--since', '-24h']);
  assert.equal(args[args.indexOf('-g') + 1], 'a\\.b\\(c\\)');
  assert.equal(args.at(-1), '50');
  const noGrep = journalArgs(q, { grep: false });
  assert.ok(!noGrep.includes('-g'));
  assert.equal(noGrep.at(-1), '1000');

  const live = journalArgs(validateQuery({ op: 'logs', source: { kind: 'kernel' }, after: 's=1;i=2' }));
  assert.ok(live.includes('_TRANSPORT=kernel') && live.includes('--after-cursor') && !live.includes('--since'));
  const older = journalArgs(validateQuery({ op: 'logs', source: { kind: 'all' }, since: 'boot', before: '1700000000123456' }));
  assert.deepEqual(older.slice(older.indexOf('-b'), older.indexOf('-b') + 2), ['-b', '0']);
  assert.ok(older.includes('@1700000000'));
});

test('günlük ayrıştırma: bayt dizisi mesajlar, renk kodları ve arama', () => {
  const lines = [
    { __CURSOR: 'c1', __REALTIME_TIMESTAMP: '1700000000000000', PRIORITY: '3', _SYSTEMD_UNIT: 'ssh.service', MESSAGE: '\u001b[31mHata\u001b[0m oldu' },
    { __CURSOR: 'c2', __REALTIME_TIMESTAMP: '1700000001000000', _TRANSPORT: 'kernel', MESSAGE: [104, 105] },
    'bozuk satır',
  ].map((l) => (typeof l === 'string' ? l : JSON.stringify(l)));
  const out = parseJournal(lines.join('\n'));
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].msg, out[0].p, out[0].src, out[0].t, out[0].b], ['Hata oldu', 3, 'ssh.service', 1700000000000, '1700000000000000']);
  assert.deepEqual([out[1].msg, out[1].src, out[1].p], ['hi', 'kernel', 6]);
  assert.equal(parseJournal(lines.join('\n'), 'HATA').length, 1);
  assert.equal(cleanMessage('a\x07b\tc  \n'), 'ab\tc');
});

test('konteyner kayıtları: önem tahmini ve json-file satırı', () => {
  assert.equal(guessPriority('[App] ERROR boom'), 3);
  assert.equal(guessPriority('WARN something'), 4);
  assert.equal(guessPriority('FATAL crash'), 2);
  assert.equal(guessPriority('listening on 8000'), 6);
  assert.equal(guessPriority('plain', 'stderr'), 5);
  const e = parseDockerLine('{"log":"\\u001b[32mLOG\\u001b[39m hello\\n","stream":"stderr","time":"2026-11-05T04:12:11.822509061Z"}');
  assert.deepEqual([e.msg, e.stream, e.t], ['LOG hello', 'stderr', Date.parse('2026-11-05T04:12:11.822Z')]);
  assert.equal(parseDockerLine('x'), null);
});

test('sshd_config: ilk değer geçerli, Include izlenir, Match sonrası sayılmaz', () => {
  const files = {
    '/etc/ssh/sshd_config': 'Include /etc/ssh/sshd_config.d/*.conf\nPort 22\nPort 2222\nPasswordAuthentication yes\n#PermitRootLogin yes\nMatch User x\nPermitRootLogin yes\n',
    '/etc/ssh/sshd_config.d/50-cloud.conf': 'PasswordAuthentication no\n',
  };
  const read = (f) => {
    if (!(f in files)) throw new Error('yok');
    return files[f];
  };
  const cfg = parseSshdConfig(read, '/etc/ssh/sshd_config', (p) => (p.includes('*') ? ['/etc/ssh/sshd_config.d/50-cloud.conf'] : [p]));
  assert.deepEqual(cfg.ports, ['22', '2222']);
  assert.equal(cfg.passwordAuthentication, false);
  assert.equal(cfg.permitRootLogin, 'prohibit-password');
  assert.equal(cfg.pubkeyAuthentication, true);
  assert.equal(parseSshdConfig(() => '', '/x').passwordAuthentication, true);
});

test('SSH denemeleri: olmayan kullanıcı iki kez sayılmaz, başarılı girişler ayrı', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const e = (h, msg) => ({ t: now - h * 3600_000, msg });
  const log = analyzeSshLog(
    [
      e(1, 'Invalid user admin from 1.2.3.4 port 5555'),
      e(1, 'Failed password for invalid user admin from 1.2.3.4 port 5555 ssh2'),
      e(2, 'Failed password for root from 1.2.3.4 port 1 ssh2'),
      e(30, 'Failed publickey for deniz from 5.6.7.8 port 2 ssh2'),
      e(3, 'Accepted publickey for deniz from 100.64.0.2 port 3 ssh2: ED25519 SHA256:x'),
    ],
    now,
  );
  assert.equal(log.failures, 3);
  assert.equal(log.last24h, 2);
  assert.deepEqual(log.topIps[0], { ip: '1.2.3.4', count: 2 });
  assert.deepEqual(log.accepted.map((a) => [a.user, a.ip, a.method, a.count]), [['deniz', '100.64.0.2', 'publickey', 1]]);
  assert.equal(log.lastFailure.user, 'admin');
});

test('dinlenen soketler ve erişim kapsamı', () => {
  const tcp = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000   995        0 4242 1\n   1: 0100007F:0CEA 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 99 1\n';
  assert.deepEqual(parseListening(tcp, 'tcp', { hexToIPv4, hexToIPv6 }), [{ proto: 'tcp', address: '0.0.0.0', port: 8080, uid: 995, inode: '4242' }]);
  assert.equal(addressScope('0.0.0.0'), 'all');
  assert.equal(addressScope('::'), 'all');
  assert.equal(addressScope('127.0.0.53'), 'local');
  assert.equal(addressScope('100.80.1.2'), 'tailscale');
  assert.equal(addressScope('100.20.1.1'), 'specific');
  assert.equal(addressScope('fd7a:115c:a1e0::1'), 'tailscale');
  assert.equal(addressScope('192.168.1.5'), 'specific');
});

test('disk taraması: boyutlar, sabit bağlantı bir kez, en büyük dosyalar ve budama', (t) => {
  const dir = tmp(t);
  write(path.join(dir, 'a/big.bin'), Buffer.alloc(300_000, 1));
  write(path.join(dir, 'a/deep/x/y.bin'), Buffer.alloc(200_000, 1));
  write(path.join(dir, 'b/small.txt'), 'merhaba');
  fs.linkSync(path.join(dir, 'a/big.bin'), path.join(dir, 'b/link.bin'));
  const { tree, stats, largest } = scanUsage(dir);
  assert.equal(stats.files, 3); // sabit bağlantı ikinci kez sayılmaz
  assert.equal(stats.partial, false);
  const a = tree.d.find((c) => c.n === 'a');
  assert.ok(a.s >= 500_000);
  assert.ok(tree.s >= a.s);
  assert.equal(path.basename(largest[0].path), 'big.bin');
  assert.throws(() => scanUsage(path.join(dir, 'yok')), { code: 'not_found' });
  assert.throws(() => scanUsage(path.join(dir, 'b/small.txt')), { code: 'not_dir' });

  const pruned = pruneTree(tree, { maxDepth: 1 });
  const pa = pruned.d.find((c) => c.n === 'a');
  assert.equal(pa.d, undefined);
  assert.equal(pa.x, true); // derinlik sınırında kesildi, tıklanınca yeniden taranır
  assert.equal(scanUsage(dir, { deadline: 0 }).stats.partial, true);
});

test('konteyner kayıtları: sondan okuma, daha eskiler ve canlı izleme', async (t) => {
  const root = tmp(t);
  const id = 'a'.repeat(64);
  const dir = path.join(root, 'var/lib/docker/containers', id);
  write(path.join(dir, 'config.v2.json'), JSON.stringify({ Name: '/web-app', State: { Running: true }, Config: { Image: 'web' } }));
  write(path.join(dir, 'hostconfig.json'), JSON.stringify({ LogConfig: { Type: 'json-file' }, PortBindings: { '8000/tcp': [{ HostIp: '', HostPort: '8000' }] } }));
  const now = Date.parse('2026-11-06T12:00:00Z');
  const line = (i, text) => `${JSON.stringify({ log: `${text} ${i}\n`, stream: 'stdout', time: new Date(now - (100 - i) * 1000).toISOString() })}\n`;
  const file = path.join(dir, `${id}-json.log`);
  fs.writeFileSync(file, Array.from({ length: 100 }, (_, i) => line(i, i % 10 === 0 ? 'ERROR boom' : 'LOG ok')).join(''));
  const q = createQuery({ root, now: () => now });
  const req = (extra) => validateQuery({ op: 'logs', source: { kind: 'container', name: 'web-app' }, since: '15m', limit: 5, ...extra });

  const last = await q.handle(req());
  assert.deepEqual(last.entries.map((e) => e.msg), ['LOG ok 95', 'LOG ok 96', 'LOG ok 97', 'LOG ok 98', 'LOG ok 99']);
  assert.equal(last.more, true);
  assert.equal(last.cursor, String(fs.statSync(file).size));
  const older = await q.handle(req({ before: last.entries[0].b }));
  assert.deepEqual(older.entries.map((e) => e.msg).at(-1), 'LOG ok 94');
  const errors = await q.handle(req({ priority: 3, limit: 100 }));
  assert.equal(errors.entries.length, 10);
  assert.ok(errors.entries.every((e) => e.p === 3));
  const recent = await q.handle(req({ since: '15m', limit: 1000 }));
  assert.equal(recent.entries.length, 100);

  fs.appendFileSync(file, line(100, 'LOG yeni'));
  const live = await q.handle(req({ after: last.cursor }));
  assert.deepEqual(live.entries.map((e) => e.msg), ['LOG yeni 100']);
  assert.equal(live.cursor, String(fs.statSync(file).size));
  await assert.rejects(q.handle(validateQuery({ op: 'logs', source: { kind: 'container', name: 'yok' } })), { code: 'not_found' });
});

test('güvenlik özeti: port sahibi süreç, Docker yayını, SSH ve kullanıcılar', async (t) => {
  const root = tmp(t);
  const P = (p) => path.join(root, p);
  write(P('proc/net/tcp'), '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 00000000:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 777 1\n   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000   995        0 888 1\n');
  for (const f of ['tcp6', 'udp', 'udp6']) write(P(`proc/net/${f}`), 'header\n');
  write(P('proc/sys/net/ipv4/ip_local_port_range'), '32768\t60999\n');
  write(P('proc/42/comm'), 'docker-proxy\n');
  write(P('proc/42/status'), 'Name:\tdocker-proxy\nUid:\t0\t0\t0\t0\n');
  fs.mkdirSync(P('proc/42/fd'), { recursive: true });
  fs.symlinkSync('socket:[777]', P('proc/42/fd/3'));
  fs.symlinkSync('/dev/null', P('proc/42/fd/0'));
  const id = 'b'.repeat(64);
  write(P(`var/lib/docker/containers/${id}/config.v2.json`), JSON.stringify({ Name: '/postgresql', State: { Running: true } }));
  write(P(`var/lib/docker/containers/${id}/hostconfig.json`), JSON.stringify({ PortBindings: { '5432/tcp': [{ HostIp: '', HostPort: '5432' }] } }));
  write(P('etc/passwd'), 'root:x:0:0:root:/root:/bin/bash\ndeniz:x:1000:1000::/home/deniz:/bin/bash\nnobody:x:65534:65534::/nonexistent:/usr/sbin/nologin\n');
  write(P('etc/shadow'), 'root:!:1::::::\ndeniz:$y$abc:1::::::\n');
  write(P('etc/group'), 'sudo:x:27:deniz\n');
  write(P('home/deniz/.ssh/authorized_keys'), '# yorum\nssh-ed25519 AAAA deniz\n');
  write(P('etc/ssh/sshd_config'), 'PasswordAuthentication no\n');
  write(P('etc/ufw/ufw.conf'), 'ENABLED=no\n');
  const sshLine = JSON.stringify({ __REALTIME_TIMESTAMP: String((Date.now() - 1000) * 1000), MESSAGE: 'Failed password for deniz from 9.9.9.9 port 1 ssh2' });
  const run = async (cmd, args) => {
    if (cmd === 'journalctl' && args.includes('sshd')) return { code: 0, stdout: `${sshLine}\n`, stderr: '' };
    if (cmd === 'systemctl') return { code: 3, stdout: 'inactive\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const s = await createQuery({ root, run }).handle({ op: 'security' });
  const pg = s.ports.find((p) => p.port === 5432);
  assert.deepEqual([pg.scope, pg.containers, pg.processes.map((p) => [p.name, p.user])], ['all', ['postgresql'], [['docker-proxy', 'root']]]);
  assert.equal(s.ports.find((p) => p.port === 8080).scope, 'local');
  assert.equal(s.ssh.passwordAuthentication, false);
  assert.equal(s.sshLog.failures, 1);
  assert.deepEqual(s.firewall, { ufw: 'disabled', firewalld: false });
  assert.equal(s.fail2ban, 'missing');
  assert.deepEqual(
    s.users.map((u) => [u.name, u.admin, u.password, u.keys]),
    [
      ['root', true, 'locked', 0],
      ['deniz', true, 'set', 1],
    ],
  );
});

test('sorgu istemcisi: tek satır istek, hata kodu ve zaman aşımı', async (t) => {
  const base = os.tmpdir().length < 60 ? os.tmpdir() : '/tmp';
  const sock = path.join(base, `nsq-${process.pid}.sock`);
  fs.rmSync(sock, { force: true });
  const server = net.createServer((c) => {
    c.once('data', (d) => {
      const req = JSON.parse(String(d).split('\n')[0]);
      if (req.op === 'slow') return;
      c.end(`${JSON.stringify(req.op === 'bad' ? { error: 'invalid' } : { ok: req.op })}\n`);
    });
  });
  await new Promise((r) => server.listen(sock, r));
  t.after(() => server.close());
  assert.deepEqual(await runQuery({ socketPath: sock, request: { op: 'x' } }), { ok: 'x' });
  await assert.rejects(runQuery({ socketPath: sock, request: { op: 'bad' } }), { code: 'invalid' });
  await assert.rejects(runQuery({ socketPath: sock, request: { op: 'slow' }, timeoutMs: 100 }), { code: 'timeout' });
  await assert.rejects(runQuery({ socketPath: path.join(base, 'yok.sock'), request: {} }), { code: 'unavailable' });
});
