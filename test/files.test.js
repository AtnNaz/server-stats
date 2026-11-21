import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, readdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { validateFilesRequest, cleanPath, partName, CHUNK_SIZE } from '../src/files-protocol.js';
import { createFiles, readHeader, readExactly, errorCode } from '../bin/serverhealth-files.js';
import { filesCall, filesRead, contentDisposition } from '../src/files-client.js';

const BRIDGE = fileURLToPath(new URL('../bin/serverhealth-files.js', import.meta.url));
const ID = 'a1b2c3d4e5f60718';

async function tmp() {
  return mkdtemp(path.join(os.tmpdir(), 'files-'));
}

test('istekler doğrulanır', () => {
  assert.equal(cleanPath('/a//b/../c/'), '/a/c');
  assert.equal(cleanPath('a/b'), null);
  assert.equal(cleanPath('/a\0b'), null);
  assert.deepEqual(validateFilesRequest({ op: 'list' }), { op: 'list', path: '' });
  assert.deepEqual(validateFilesRequest({ op: 'list', path: '/srv/' }), { op: 'list', path: '/srv' });
  assert.equal(validateFilesRequest({ op: 'read', path: '/' }), null);
  assert.equal(validateFilesRequest({ op: 'delete', path: '/' }), null);
  assert.equal(validateFilesRequest({ op: 'mkdir', path: '/x/..' }), null);
  assert.deepEqual(validateFilesRequest({ op: 'delete', path: '/x/y', recursive: 'yes' }), { op: 'delete', path: '/x/y', recursive: false });
  assert.equal(validateFilesRequest({ op: 'rename', from: '/a', to: '/a/b' }), null);
  assert.equal(validateFilesRequest({ op: 'write', path: '/a/b', upload: 'xyz', offset: 0, size: 1 }), null);
  assert.equal(validateFilesRequest({ op: 'write', path: '/a/b', upload: ID, offset: 0, size: CHUNK_SIZE + 1 }), null);
  assert.deepEqual(validateFilesRequest({ op: 'write', path: '/a/b', upload: ID, offset: 4, size: 2, final: true }), { op: 'write', path: '/a/b', upload: ID, offset: 4, size: 2, final: true, overwrite: false });
  assert.equal(validateFilesRequest({ op: 'chmod', path: '/a' }), null);
  assert.equal(partName('/d/film.mkv', ID), `/d/.film.mkv.${ID}.part`);
  assert.equal(errorCode({ code: 'EACCES' }), 'denied');
  assert.match(contentDisposition('rapor ş.pdf'), /filename="rapor _.pdf"; filename\*=UTF-8''rapor%20%C5%9F\.pdf/);
});

test('köprü: listeleme, parçalı yükleme, çakışma, yeniden adlandırma ve silme', async () => {
  const dir = await tmp();
  try {
    const f = createFiles({ home: dir });
    await writeFile(path.join(dir, 'b.txt'), 'eski');
    await chmod(path.join(dir, 'b.txt'), 0o600);
    await mkdir(path.join(dir, 'Klasor'));
    await symlink('b.txt', path.join(dir, 'bag'));
    const l = await f.list('');
    assert.equal(l.path, dir);
    assert.equal(l.writable, true);
    assert.deepEqual(l.entries.map((e) => [e.name, e.type]), [['b.txt', 'file'], ['bag', 'link'], ['Klasor', 'dir']]);
    assert.equal(l.entries.find((e) => e.name === 'bag').targetType, 'file');
    assert.equal(l.entries.find((e) => e.name === 'b.txt').mode, '600');

    const target = path.join(dir, 'yeni.bin');
    const w = (q, data) => f.write({ op: 'write', path: target, upload: ID, overwrite: false, final: false, ...q, size: data.length }, data);
    assert.deepEqual(await w({ offset: 0 }, Buffer.from('abc')), { ok: true, received: 3 });
    await assert.rejects(w({ offset: 5 }, Buffer.from('x')), { code: 'offset' });
    assert.deepEqual(await w({ offset: 3, final: true }, Buffer.from('def')), { ok: true, done: true, size: 6 });
    assert.equal(await readFile(target, 'utf8'), 'abcdef');
    assert.equal((await readdir(dir)).some((n) => n.endsWith('.part')), false);

    const over = (overwrite) => f.write({ op: 'write', path: path.join(dir, 'b.txt'), upload: ID, offset: 0, size: 3, final: true, overwrite }, Buffer.from('yen'));
    await assert.rejects(over(false), { code: 'exists' });
    await over(true);
    assert.equal(await readFile(path.join(dir, 'b.txt'), 'utf8'), 'yen');
    assert.equal((await stat(path.join(dir, 'b.txt'))).mode & 0o777, 0o600);

    await f.write({ op: 'write', path: path.join(dir, 'yarim'), upload: ID, offset: 0, size: 1, final: false, overwrite: false }, Buffer.from('z'));
    await f.handle({ op: 'abort', path: path.join(dir, 'yarim'), upload: ID });
    assert.equal((await readdir(dir)).some((n) => n.endsWith('.part')), false);

    await f.handle({ op: 'mkdir', path: path.join(dir, 'Klasor', 'ic') });
    await writeFile(path.join(dir, 'Klasor', 'ic', 'x'), '1');
    await assert.rejects(f.handle({ op: 'rename', from: target, to: path.join(dir, 'b.txt') }), { code: 'exists' });
    await f.handle({ op: 'rename', from: target, to: path.join(dir, 'tasindi.bin') });
    await assert.rejects(f.handle({ op: 'delete', path: path.join(dir, 'Klasor'), recursive: false }), { code: 'ENOTEMPTY' });
    await f.handle({ op: 'delete', path: path.join(dir, 'Klasor'), recursive: true });
    await f.handle({ op: 'delete', path: path.join(dir, 'bag'), recursive: false });
    assert.equal(await readFile(path.join(dir, 'b.txt'), 'utf8'), 'yen');
    assert.deepEqual((await readdir(dir)).sort(), ['b.txt', 'tasindi.bin']);
    await assert.rejects(f.openRead(dir), { code: 'is_dir' });
    assert.deepEqual(await f.openRead(path.join(dir, 'b.txt')).then((r) => [r.name, r.size]), ['b.txt', 3]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('başlık satırı ve gövde akıştan ayrılır', async () => {
  const s = new PassThrough();
  const head = readHeader(s);
  s.write(Buffer.from('{"op":"write"}\nAB'));
  const { line, rest } = await head;
  assert.equal(line, '{"op":"write"}');
  const body = readExactly(s, 5, rest);
  s.write(Buffer.from('CDEF'));
  assert.equal((await body).toString(), 'ABCDE');
});

test('panel istemcisi gerçek köprüyle konuşur', async () => {
  const dir = await tmp();
  const sock = path.join(dir, 'f.sock');
  const server = net.createServer((c) => {
    const child = spawn(process.execPath, [BRIDGE], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, HOME: dir } });
    c.pipe(child.stdin);
    child.stdout.pipe(c);
    c.on('error', () => child.kill());
  });
  await new Promise((r) => server.listen(sock, r));
  try {
    const call = (request, body) => filesCall({ socketPath: sock, request, body });
    const listed = await call({ op: 'list', path: '' });
    assert.equal(listed.path, dir);
    const big = Buffer.alloc(300_000, 7);
    const target = path.join(dir, 'veri.bin');
    await call({ op: 'write', path: target, upload: ID, offset: 0, size: 200_000, final: false, overwrite: false }, big.subarray(0, 200_000));
    await call({ op: 'write', path: target, upload: ID, offset: 200_000, size: 100_000, final: true, overwrite: false }, big.subarray(200_000));
    assert.equal((await stat(target)).size, 300_000);
    const r = await filesRead({ socketPath: sock, path: target });
    assert.equal(r.info.size, 300_000);
    const chunks = [r.rest];
    const ended = new Promise((res) => r.socket.on('end', res));
    r.socket.on('data', (d) => chunks.push(d));
    r.socket.resume();
    await ended;
    assert.equal(Buffer.concat(chunks).length, 300_000);
    await assert.rejects(call({ op: 'list', path: path.join(dir, 'yok') }), { code: 'not_found' });
    await assert.rejects(filesRead({ socketPath: sock, path: dir }), { code: 'is_dir' });
    await assert.rejects(call({ op: 'bogus' }), { code: 'invalid' });
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
