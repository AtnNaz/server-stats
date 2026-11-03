import { MODEL_NAME } from './system-settings.js';

// Sistem mesajını panel kendisi ekler; tarayıcıdan gelen geçmişte yalnızca bu roller olabilir.
const ROLES = new Set(['user', 'assistant', 'tool']);
const MAX_CALLS = 8;
const MAX_COMMAND = 2000;

// Yapay zekânın kullanabildiği tek araç: sunucuda komut çalıştırmak.
export const RUN_COMMAND_TOOL = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      'Run a shell command on this Linux server and return its output. Prefer read-only diagnostic commands (journalctl, systemctl status, lsblk, df, dmesg, nvidia-smi, ls, cat). Commands that change something wait for the user to approve them.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run, e.g. "journalctl -u ollama -n 50 --no-pager"' },
        reason: { type: 'string', description: 'One short sentence telling the user why this command is needed' },
      },
      required: ['command'],
    },
  },
};

// Model bir araç çağrısında komutu düzgün vermediyse çağrı yok sayılır.
function toolCall(c) {
  const fn = c?.function;
  if (fn?.name !== 'run_command') return null;
  let args = fn.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  const command = typeof args?.command === 'string' ? args.command.trim() : '';
  if (!command || command.length > MAX_COMMAND) return null;
  return { command, reason: typeof args.reason === 'string' ? args.reason.slice(0, 300) : '' };
}
const MAX_MESSAGES = 200;
const MAX_CONTENT = 32_000;
// İndirme sırasında bu kadar süre hiç veri gelmezse indirme durdurulur.
const PULL_STALL_MS = 120_000;
const BENCH_PROMPT = 'Write about 150 words explaining how a computer boots, in plain English.';

const toNumber = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const perSecond = (count, ns) => (count && ns ? Math.round((count / (ns / 1e9)) * 10) / 10 : null);

// Sohbet geçmişini doğrular; yalnızca rol, metin ve komut çağrıları geçer.
export function validateChat(body) {
  if (typeof body?.model !== 'string' || !MODEL_NAME.test(body.model)) return null;
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > MAX_MESSAGES) return null;
  const messages = [];
  for (const m of body.messages) {
    if (!m || !ROLES.has(m.role) || typeof m.content !== 'string' || m.content.length > MAX_CONTENT) return null;
    const msg = { role: m.role, content: m.content };
    if (m.role === 'assistant' && m.tool_calls !== undefined) {
      if (!Array.isArray(m.tool_calls) || m.tool_calls.length > MAX_CALLS) return null;
      const calls = m.tool_calls.map(toolCall);
      if (calls.some((c) => !c)) return null;
      msg.tool_calls = calls.map(({ command }) => ({ function: { name: 'run_command', arguments: { command } } }));
    }
    if (m.role === 'tool') msg.tool_name = 'run_command';
    messages.push(msg);
  }
  if (!['user', 'tool'].includes(messages.at(-1).role)) return null;
  return { model: body.model, messages, think: body.think === true, tools: body.tools === true };
}

// Ollama'nın satır satır JSON akışını okur.
async function* readLines(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // Bozuk satır atlanır.
      }
    }
  }
  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer);
    } catch {
      // Yarım kalan son satır atlanır.
    }
  }
}

// Panelin Ollama ile konuşan kısmı. Adres yalnızca bu makine olabilir (config doğrulaması).
export function createOllama({ url, fetchImpl = fetch }) {
  const call = (p, options = {}, timeoutMs = 3000) =>
    fetchImpl(new URL(p, url), {
      redirect: 'error',
      ...options,
      ...(options.body && { headers: { 'Content-Type': 'application/json' } }),
      signal: options.signal ?? AbortSignal.timeout(timeoutMs),
    });
  const get = (p) => call(p).then((r) => (r.ok ? r.json() : null));

  async function models() {
    try {
      const data = await get('/api/tags');
      if (!data) return { available: false, models: [] };
      const list = (data.models ?? [])
        .filter((m) => typeof m?.name === 'string')
        .map((m) => ({ name: m.name, size: Number(m.size) || null, parameters: m.details?.parameter_size ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { available: true, models: list };
    } catch {
      return { available: false, models: [] };
    }
  }

  // Yüklü modeller ve şu an bellekte olanlar.
  async function info() {
    try {
      const [version, tags, ps] = await Promise.all([get('/api/version').catch(() => null), get('/api/tags'), get('/api/ps').catch(() => null)]);
      if (!tags) return { available: false };
      return {
        available: true,
        version: typeof version?.version === 'string' ? version.version : null,
        installed: (tags.models ?? [])
          .filter((m) => typeof m?.name === 'string')
          .map((m) => ({ name: m.name, size: Number(m.size) || null, modified: m.modified_at ?? null, parameters: m.details?.parameter_size ?? null, quantization: m.details?.quantization_level ?? null, family: m.details?.family ?? null }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        loaded: (ps?.models ?? [])
          .filter((m) => typeof m?.name === 'string')
          .map((m) => ({ name: m.name, size: Number(m.size) || null, vram: Number(m.size_vram) || 0, expiresAt: m.expires_at ?? null, context: Number(m.context_length) || null })),
        pull: pullStatus(),
      };
    } catch {
      return { available: false };
    }
  }

  async function unload(model) {
    const r = await call('/api/generate', { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }) }, 15_000);
    if (!r.ok) throw new Error(`ollama_http_${r.status}`);
  }

  async function remove(model) {
    const r = await call('/api/delete', { method: 'DELETE', body: JSON.stringify({ model }) }, 30_000);
    if (r.status === 404) throw Object.assign(new Error('not_found'), { status: 404 });
    if (!r.ok) throw new Error(`ollama_http_${r.status}`);
  }

  // Aynı anda tek indirme yapılır; ilerleme bellekte tutulur, sayfa yoklayarak okur.
  let pull = null;
  function pullStatus() {
    if (!pull) return null;
    const { controller, layers, ...rest } = pull;
    const sizes = [...layers.values()];
    const total = sizes.reduce((s, l) => s + l.total, 0);
    const completed = sizes.reduce((s, l) => s + l.completed, 0);
    return { ...rest, total: total || null, completed: total ? completed : null };
  }

  function startPull(model) {
    if (pull && !pull.done) return false;
    const controller = new AbortController();
    pull = { model, status: 'starting', done: false, error: null, startedAt: Date.now(), finishedAt: null, controller, layers: new Map() };
    const current = pull;
    let stall = setTimeout(() => controller.abort(new Error('stalled')), PULL_STALL_MS);
    const finish = (error) => {
      clearTimeout(stall);
      current.done = true;
      current.error = error;
      current.finishedAt = Date.now();
      console.log(error ? `Ollama model indirilemedi: ${model} (${error})` : `Ollama modeli indirildi: ${model}`);
    };
    (async () => {
      try {
        const res = await call('/api/pull', { method: 'POST', body: JSON.stringify({ model, stream: true }), signal: controller.signal });
        if (!res.ok) return finish(res.status === 404 ? 'not_found' : `ollama_http_${res.status}`);
        for await (const msg of readLines(res.body)) {
          clearTimeout(stall);
          stall = setTimeout(() => controller.abort(new Error('stalled')), PULL_STALL_MS);
          if (typeof msg.error === 'string') return finish(/not found|file does not exist/i.test(msg.error) ? 'not_found' : msg.error.slice(0, 200));
          if (typeof msg.status === 'string') current.status = msg.status.slice(0, 120);
          if (typeof msg.digest === 'string' && Number(msg.total) > 0) {
            current.layers.set(msg.digest, { total: Number(msg.total), completed: Number(msg.completed) || 0 });
          }
        }
        finish(current.status === 'success' ? null : 'incomplete');
      } catch (err) {
        const reason = controller.signal.reason?.message;
        finish(reason === 'cancelled' ? 'cancelled' : reason === 'stalled' ? 'stalled' : 'ollama');
      }
    })();
    console.log(`Ollama model indirmesi başladı: ${model}`);
    return true;
  }

  function cancelPull() {
    if (!pull || pull.done) return false;
    pull.controller.abort(new Error('cancelled'));
    return true;
  }

  // Sabit bir istemle üretim ve istem işleme hızını ölçer.
  async function bench(model) {
    const body = { model, prompt: BENCH_PROMPT, stream: false, think: false, keep_alive: '5m', options: { temperature: 0, num_predict: 256, seed: 1 } };
    let r = await call('/api/generate', { method: 'POST', body: JSON.stringify(body) }, 5 * 60_000);
    if (r.status === 400) {
      delete body.think;
      r = await call('/api/generate', { method: 'POST', body: JSON.stringify(body) }, 5 * 60_000);
    }
    if (r.status === 404) throw Object.assign(new Error('not_found'), { status: 404 });
    if (!r.ok) throw new Error(`ollama_http_${r.status}`);
    const d = await r.json();
    return {
      model,
      generated: toNumber(d.eval_count),
      generateRate: perSecond(d.eval_count, d.eval_duration),
      prompt: toNumber(d.prompt_eval_count),
      promptRate: perSecond(d.prompt_eval_count, d.prompt_eval_duration),
      loadMs: d.load_duration ? Math.round(d.load_duration / 1e6) : null,
      totalMs: d.total_duration ? Math.round(d.total_duration / 1e6) : null,
    };
  }

  // Sohbet yanıtını parça parça aktarır. write() her parça için çağrılır; signal iptal edince akış durur.
  // Model komut çağırırsa çağrılar akışın sonunda { calls } olarak bildirilir; çalıştırma kararı panelindir.
  async function chat({ model, messages, think, numCtx, tools }, { signal, write }) {
    const body = { model, messages, stream: true, keep_alive: '10m', think, ...(numCtx && { options: { num_ctx: numCtx } }), ...(tools && { tools }) };
    let r = await call('/api/chat', { method: 'POST', body: JSON.stringify(body), signal });
    if (r.status === 400 && !think) {
      delete body.think;
      r = await call('/api/chat', { method: 'POST', body: JSON.stringify(body), signal });
    }
    if (r.status === 404) throw Object.assign(new Error('not_found'), { status: 404 });
    if (r.status === 400 && tools) {
      const text = await r.text().catch(() => '');
      if (/tools?/i.test(text)) throw Object.assign(new Error('no_tools'), { status: 400, code: 'no_tools' });
    }
    if (!r.ok) throw new Error(`ollama_http_${r.status}`);
    const calls = [];
    for await (const msg of readLines(r.body)) {
      if (typeof msg.error === 'string') throw new Error(msg.error.slice(0, 200));
      const content = msg.message?.content;
      const thinking = msg.message?.thinking;
      if (thinking) write({ th: String(thinking) });
      if (content) write({ t: String(content) });
      for (const c of msg.message?.tool_calls ?? []) {
        const call = toolCall(c);
        if (call && calls.length < MAX_CALLS) calls.push(call);
      }
      if (msg.done) {
        if (calls.length) write({ calls });
        write({
          done: true,
          stats: {
            generated: toNumber(msg.eval_count),
            generateRate: perSecond(msg.eval_count, msg.eval_duration),
            prompt: toNumber(msg.prompt_eval_count),
            promptRate: perSecond(msg.prompt_eval_count, msg.prompt_eval_duration),
          },
        });
      }
    }
  }

  return { models, info, unload, remove, startPull, cancelPull, pullStatus, bench, chat };
}
