import path from 'node:path';

export const FILE_OPS = ['list', 'read', 'write', 'abort', 'mkdir', 'delete', 'rename'];
export const CHUNK_SIZE = 4 * 1024 * 1024;
export const MAX_FILE = 64 * 1024 ** 3;
const UPLOAD_ID = /^[a-f0-9]{16,32}$/;

export function cleanPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.length > 4096 || /[\0\r\n]/.test(p)) return null;
  return path.posix.normalize(p).replace(/(.)\/+$/, '$1');
}

export function cleanName(name) {
  if (typeof name !== 'string' || !name || name.length > 255 || name === '.' || name === '..' || /[/\0\r\n]/.test(name)) return null;
  return name;
}

const nonRoot = (p) => (p && p !== '/' ? p : null);
const isInt = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

export function validateFilesRequest(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q) || !FILE_OPS.includes(q.op)) return null;
  if (q.op === 'list') {
    if (q.path === '' || q.path === undefined) return { op: 'list', path: '' };
    const p = cleanPath(q.path);
    return p ? { op: 'list', path: p } : null;
  }
  if (q.op === 'read') {
    const p = nonRoot(cleanPath(q.path));
    return p ? { op: 'read', path: p } : null;
  }
  if (q.op === 'write' || q.op === 'abort') {
    const p = nonRoot(cleanPath(q.path));
    if (!p || !cleanName(path.posix.basename(p)) || typeof q.upload !== 'string' || !UPLOAD_ID.test(q.upload)) return null;
    if (q.op === 'abort') return { op: 'abort', path: p, upload: q.upload };
    if (!isInt(q.offset, MAX_FILE) || !isInt(q.size, CHUNK_SIZE) || q.offset + q.size > MAX_FILE) return null;
    return { op: 'write', path: p, upload: q.upload, offset: q.offset, size: q.size, final: q.final === true, overwrite: q.overwrite === true };
  }
  if (q.op === 'mkdir') {
    const p = nonRoot(cleanPath(q.path));
    return p && cleanName(path.posix.basename(p)) ? { op: 'mkdir', path: p } : null;
  }
  if (q.op === 'delete') {
    const p = nonRoot(cleanPath(q.path));
    return p ? { op: 'delete', path: p, recursive: q.recursive === true } : null;
  }
  if (q.op === 'rename') {
    const from = nonRoot(cleanPath(q.from));
    const to = nonRoot(cleanPath(q.to));
    if (!from || !to || from === to || !cleanName(path.posix.basename(to))) return null;
    if (to.startsWith(`${from}/`)) return null;
    return { op: 'rename', from, to };
  }
  return null;
}

export const partName = (target, upload) => path.posix.join(path.posix.dirname(target), `.${path.posix.basename(target).slice(0, 200)}.${upload}.part`);
