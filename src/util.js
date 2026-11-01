import { readFile } from 'node:fs/promises';

export const readText = (file) => readFile(file, 'utf8');

export function withTimeout(promise, ms, message = 'zaman aşımı') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// fn'i aynı anda en fazla `limit` öğe için çalıştırır.
export async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function round(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export const percent = (part, whole) => (whole > 0 ? round(Math.min(100, Math.max(0, (part / whole) * 100))) : null);
