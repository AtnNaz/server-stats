'use strict';

// Panel terminali: ana panelde iframe içinde açılır. xterm.js stil etiketleri eklediği için bu sayfanın
// güvenlik politikası satır içi stillere izin verir; ana panel sıkı politikayla kalır.
const $ = (id) => document.getElementById(id);
const { t } = window.I18N;

try {
  const theme = localStorage.getItem('serverhealth-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  /* depolama kapalıysa sistem teması kullanılır */
}

const CLOSE_TEXT = { 4000: 'term.closedIdle', 4001: 'term.closedSession', 4002: 'term.closedUnavailable', 4003: 'term.closedBusy' };
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const encoder = new TextEncoder();

const term = new window.Terminal({
  cursorBlink: true,
  fontFamily: css('--mono') || 'ui-monospace, monospace',
  fontSize: 14,
  scrollback: 5000,
  allowProposedApi: false,
  theme: themeColors(),
});
const fit = new window.FitAddon.FitAddon();
term.loadAddon(fit);
term.open($('term-screen'));

function themeColors() {
  return { background: css('--surface'), foreground: css('--ink'), cursor: css('--accent'), selectionBackground: css('--accent-soft') };
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => (term.options.theme = themeColors()));
window.addEventListener('storage', (e) => {
  if (e.key !== 'serverhealth-theme') return;
  if (e.newValue === 'light' || e.newValue === 'dark') document.documentElement.dataset.theme = e.newValue;
  else delete document.documentElement.dataset.theme;
  term.options.theme = themeColors();
});

let ws = null;

function setState(kind, key) {
  $('term-state').dataset.state = kind;
  $('term-state-text').textContent = t(key);
  $('term-reconnect').hidden = kind !== 'closed';
}

function sendResize() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const msg = new Uint8Array(5);
  const view = new DataView(msg.buffer);
  msg[0] = 1;
  view.setUint16(1, term.cols);
  view.setUint16(3, term.rows);
  ws.send(msg);
}

function connect() {
  setState('connecting', 'term.connecting');
  term.reset();
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal`);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => {
    setState('open', 'term.connected');
    fit.fit();
    sendResize();
    term.focus();
  });
  ws.addEventListener('message', (e) => {
    if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data));
  });
  ws.addEventListener('close', (e) => {
    ws = null;
    setState('closed', CLOSE_TEXT[e.code] ?? (e.code === 1000 ? 'term.closedExit' : 'term.closedError'));
    term.write(`\r\n\x1b[2m${t(CLOSE_TEXT[e.code] ?? (e.code === 1000 ? 'term.closedExit' : 'term.closedError'))}\x1b[0m\r\n`);
  });
}

term.onData((data) => {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const bytes = encoder.encode(data);
  const msg = new Uint8Array(bytes.length + 1);
  msg.set(bytes, 1);
  ws.send(msg);
});
term.onResize(sendResize);
new ResizeObserver(() => fit.fit()).observe($('term-screen'));
$('term-reconnect').addEventListener('click', connect);

connect();
