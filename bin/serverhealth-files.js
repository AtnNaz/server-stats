#!/usr/bin/env node
import { constants, createReadStream } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readdir, readlink, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { partName, validateFilesRequest } from '../src/files-protocol.js';

const MAX_HEADER = 16 * 1024;
const MAX_ENTRIES = 5000;
const ERRORS = {
  ENOENT: 'not_found',
  EACCES: 'denied',
  EPERM: 'denied',
  EEXIST: 'exists',
  ENOTDIR: 'not_dir',
  EISDIR: 'is_dir',
  ENOTEMPTY: 'not_empty',
  ENOSPC: 'no_space',
  EDQUOT: 'no_space',
  EXDEV: 'cross_device',
  EROFS: 'read_only',
  ENAMETOOLONG: 'invalid',
  ELOOP: 'invalid',
  EBUSY: 'busy',
};
const fail = (code) => Object.assign(new Error(code), { code });
export const errorCode = (err) => ERRORS[err?.code] ?? (typeof err?.code === 'string' && /^[a-z_]+$/.test(err.code) ? err.code : 'failed');

const kindOf = (st) => (st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'other');
const exists = (p) => lstat(p).then(() => true, (err) => (err.code === 'ENOENT' ? false : Promise.reject(err)));
const writable = (p) => access(p, constants.W_OK).then(() => true, () => false);

export function createFiles({ home = os.homedir() } = {}) {
  async function list(p) {
    const dir = p || home;
    if (!(await stat(dir)).isDirectory()) throw fail('not_dir');
    const names = (await readdir(dir)).sort((a, b) => a.localeCompare(b));
    const entries = [];
    for (const name of names.slice(0, MAX_ENTRIES)) {
      const full = path.posix.join(dir, name);
      try {
        const l = await lstat(full);
        const e = { name, type: kindOf(l), size: l.size, mtime: Math.round(l.mtimeMs), mode: (l.mode & 0o7777).toString(8).padStart(3, '0') };
        if (l.isSymbolicLink()) {
          e.target = await readlink(full).catch(() => null);
          const t = await stat(full).catch(() => null);
          e.targetType = t ? kindOf(t) : null;
          e.size = t?.isFile() ? t.size : null;
        }
        entries.push(e);
      } catch {
        entries.push({ name, type: 'other', size: null, mtime: null, mode: null });
      }
    }
    return { path: dir, home, user: os.userInfo().username, writable: await writable(dir), entries, truncated: names.length > MAX_ENTRIES };
  }

  async function openRead(p) {
    const st = await stat(p);
    if (st.isDirectory()) throw fail('is_dir');
    if (!st.isFile()) throw fail('not_file');
    await access(p, constants.R_OK);
    return { size: st.size, mtime: Math.round(st.mtimeMs), name: path.posix.basename(p) };
  }

  async function write(q, data) {
    if (data.length !== q.size) throw fail('incomplete');
    const part = partName(q.path, q.upload);
    let fh;
    if (q.offset === 0) {
      if (!(await stat(path.posix.dirname(q.path))).isDirectory()) throw fail('not_dir');
      if (!q.overwrite && (await exists(q.path))) throw fail('exists');
      fh = await open(part, 'wx', 0o644);
    } else {
      fh = await open(part, 'r+');
      if ((await fh.stat()).size !== q.offset) {
        await fh.close();
        throw fail('offset');
      }
    }
    try {
      if (data.length) await fh.write(data, 0, data.length, q.offset);
    } finally {
      await fh.close();
    }
    if (!q.final) return { ok: true, received: q.offset + data.length };
    const target = await lstat(q.path).catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)));
    if (target && (!q.overwrite || target.isDirectory())) {
      await unlink(part).catch(() => {});
      throw fail(target.isDirectory() ? 'is_dir' : 'exists');
    }
    if (target?.isFile()) await chmod(part, target.mode & 0o7777).catch(() => {});
    await rename(part, q.path);
    return { ok: true, done: true, size: q.offset + data.length };
  }

  async function remove(q) {
    const st = await lstat(q.path);
    if (!st.isDirectory()) await unlink(q.path);
    else if (q.recursive) await rm(q.path, { recursive: true });
    else await rmdir(q.path);
    return { ok: true };
  }

  return {
    list,
    openRead,
    write,
    async handle(q) {
      if (q.op === 'list') return list(q.path);
      if (q.op === 'abort') {
        await unlink(partName(q.path, q.upload)).catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)));
        return { ok: true };
      }
      if (q.op === 'mkdir') {
        await mkdir(q.path, { mode: 0o755 });
        return { ok: true };
      }
      if (q.op === 'delete') return remove(q);
      if (q.op === 'rename') {
        if (await exists(q.to)) throw fail('exists');
        await rename(q.from, q.to);
        return { ok: true };
      }
      throw fail('invalid');
    },
  };
}

export function readHeader(stream) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(10);
      if (nl !== -1) {
        stream.pause();
        stream.off('data', onData);
        resolve({ line: buf.subarray(0, nl).toString('utf8'), rest: buf.subarray(nl + 1) });
      } else if (buf.length > MAX_HEADER) {
        stream.off('data', onData);
        reject(fail('too_large'));
      }
    };
    stream.on('data', onData);
    stream.on('end', () => resolve({ line: buf.toString('utf8'), rest: Buffer.alloc(0) }));
    stream.on('error', reject);
  });
}

export function readExactly(stream, size, first) {
  return new Promise((resolve, reject) => {
    const chunks = [first];
    let got = first.length;
    if (got >= size) return resolve(Buffer.concat(chunks).subarray(0, size));
    const onData = (chunk) => {
      chunks.push(chunk);
      got += chunk.length;
      if (got >= size) {
        stream.off('data', onData);
        resolve(Buffer.concat(chunks).subarray(0, size));
      }
    };
    stream.on('data', onData);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    stream.resume();
  });
}

async function main() {
  const reply = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`, () => process.exit(0));
  if (process.getuid?.() === 0) return reply({ error: 'root' });
  let header;
  let q;
  try {
    header = await readHeader(process.stdin);
    q = validateFilesRequest(JSON.parse(header.line));
  } catch {
    return reply({ error: 'invalid' });
  }
  if (!q) return reply({ error: 'invalid' });
  const files = createFiles();
  try {
    if (q.op === 'read') {
      const info = await files.openRead(q.path);
      process.stdout.write(`${JSON.stringify({ ok: true, ...info })}\n`);
      await pipeline(createReadStream(q.path), process.stdout);
      return process.exit(0);
    }
    if (q.op === 'write') {
      const data = await readExactly(process.stdin, q.size, header.rest);
      return reply(await files.write(q, data));
    }
    if (q.op === 'delete' || q.op === 'rename') console.error(`serverhealth-files: ${q.op} ${q.path ?? `${q.from} -> ${q.to}`}`);
    reply(await files.handle(q));
  } catch (err) {
    const code = errorCode(err);
    if (code === 'failed') console.error(`serverhealth-files: ${err.message}`);
    reply({ error: code });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
