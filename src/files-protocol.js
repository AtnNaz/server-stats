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
    if (!p) return null;
    if (q.range === undefined || q.range === null) return { op: 'read', path: p };
    const r = q.range;
    if (!r || typeof r !== 'object') return null;
    if (r.suffix !== undefined) return isInt(r.suffix, MAX_FILE) && r.suffix > 0 && r.start === undefined && r.end === undefined ? { op: 'read', path: p, range: { suffix: r.suffix } } : null;
    if (!isInt(r.start, MAX_FILE) || (r.end !== undefined && (!isInt(r.end, MAX_FILE) || r.end < r.start))) return null;
    return { op: 'read', path: p, range: r.end === undefined ? { start: r.start } : { start: r.start, end: r.end } };
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

export function parseRange(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) return { suffix: Number(m[2]) };
  return m[2] ? { start: Number(m[1]), end: Number(m[2]) } : { start: Number(m[1]) };
}

export function resolveRange(range, size) {
  if (!range) return { start: 0, end: size - 1, partial: false };
  if (range.suffix !== undefined) return size > 0 ? { start: Math.max(0, size - range.suffix), end: size - 1, partial: true } : null;
  if (range.start >= size) return null;
  return { start: range.start, end: Math.min(range.end ?? size - 1, size - 1), partial: true };
}

export const PREVIEW_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
};

export const previewType = (name) => PREVIEW_TYPES[String(name).toLowerCase().split('.').pop()] ?? null;
