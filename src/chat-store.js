import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Yapay zekâ sohbetleri panelin durum klasöründe, sohbet başına bir JSON dosyası olarak saklanır.
// Böylece aynı sohbete başka bir cihazdan da devam edilebilir. Şifreler hiçbir zaman buraya girmez:
// tarayıcı sudo şifresini yalnızca komut isteğine ekler, sohbet mesajlarına değil.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CHATS = 200;
const MAX_MESSAGES = 400;
const MAX_TEXT = 64_000;
const MAX_OUTPUT = 16_000;
const CALL_STATES = new Set(['done', 'rejected', 'error']);

const text = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(v) ? v : null);

// Tarayıcıdan gelen mesajlardan yalnızca bilinen alanlar saklanır.
function cleanCall(c) {
  if (!c || typeof c.command !== 'string') return null;
  const state = CALL_STATES.has(c.state) ? c.state : 'rejected';
  const r = c.result;
  return {
    command: text(c.command, 2000),
    reason: text(c.reason, 300),
    auto: c.auto === true,
    state,
    ...(state === 'done' && r && { result: { code: num(r.code), output: text(r.output, MAX_OUTPUT), truncated: r.truncated === true, timedOut: r.timedOut === true } }),
    ...(typeof c.error === 'string' && { error: text(c.error, 40) }),
  };
}

function cleanMessage(m) {
  if (m?.role === 'user') return typeof m.content === 'string' ? { role: 'user', content: text(m.content) } : null;
  if (m?.role !== 'assistant') return null;
  const calls = Array.isArray(m.calls) ? m.calls.slice(0, 8).map(cleanCall).filter(Boolean) : [];
  const s = m.stats;
  return {
    role: 'assistant',
    content: text(m.content),
    ...(m.thinking && { thinking: text(m.thinking) }),
    ...(typeof m.model === 'string' && { model: text(m.model, 128) }),
    ...(calls.length && { calls }),
    ...(s && { stats: { generated: num(s.generated), generateRate: num(s.generateRate), prompt: num(s.prompt), promptRate: num(s.promptRate) } }),
    ...(typeof m.error === 'string' && { error: text(m.error, 60) }),
  };
}

export function cleanChat(input) {
  if (!Array.isArray(input?.messages)) return null;
  const messages = input.messages.slice(-MAX_MESSAGES).map(cleanMessage).filter(Boolean);
  const first = messages.find((m) => m.role === 'user')?.content ?? '';
  return {
    title: text(input.title, 80).trim() || first.replace(/\s+/g, ' ').trim().slice(0, 60),
    model: text(input.model, 128),
    messages,
  };
}

export function createChatStore({ dir, now = Date.now }) {
  const file = (id) => path.join(dir, `${id}.json`);
  const valid = (id) => typeof id === 'string' && ID.test(id);

  async function readChat(id) {
    if (!valid(id)) return null;
    try {
      return JSON.parse(await readFile(file(id), 'utf8'));
    } catch {
      return null;
    }
  }

  async function list() {
    const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json') && valid(n.slice(0, -5)));
    const chats = await Promise.all(names.map((n) => readChat(n.slice(0, -5))));
    return chats
      .filter(Boolean)
      .map(({ id, title, model, createdAt, updatedAt, messages }) => ({ id, title, model, createdAt, updatedAt, count: messages?.length ?? 0 }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // id verilmezse yeni sohbet açılır. Sınır aşılınca en eski sohbetler silinir.
  async function save(id, input) {
    const chat = cleanChat(input);
    if (!chat) return null;
    if (id !== undefined && id !== null && !valid(id)) return null;
    const previous = id ? await readChat(id) : null;
    const record = { id: previous?.id ?? randomUUID(), createdAt: previous?.createdAt ?? now(), updatedAt: now(), ...chat };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file(record.id)}.tmp`;
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
    await rename(tmp, file(record.id));
    const all = await list();
    for (const old of all.slice(MAX_CHATS)) await unlink(file(old.id)).catch(() => {});
    return record;
  }

  async function remove(id) {
    if (!valid(id)) return false;
    try {
      await unlink(file(id));
      return true;
    } catch {
      return false;
    }
  }

  return { list, get: readChat, save, remove };
}
