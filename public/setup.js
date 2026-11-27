'use strict';

const $ = (id) => document.getElementById(id);
const { t, NAMES, LANGUAGES } = window.I18N;
const params = new URLSearchParams(window.location.search);
const STEPS = ['language', 'account', 'services', 'review'];
const state = { step: 0, code: params.get('code') ?? '', info: null, username: 'admin', password: '', confirm: '', services: new Set(), filter: '', all: false, busy: false };

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

function applyTheme() {
  const root = document.documentElement;
  let theme = null;
  try {
    theme = localStorage.getItem('serverhealth-theme');
  } catch {
    theme = null;
  }
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  root.dataset.mode = theme === 'light' || theme === 'dark' ? theme : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function setTheme(value) {
  try {
    if (value === 'system') localStorage.removeItem('serverhealth-theme');
    else localStorage.setItem('serverhealth-theme', value);
  } catch {
    return applyTheme();
  }
  applyTheme();
}

function currentTheme() {
  try {
    return localStorage.getItem('serverhealth-theme') ?? 'system';
  } catch {
    return 'system';
  }
}

function alertBox(text) {
  $('setup-alert').hidden = !text;
  $('setup-alert-text').textContent = text ?? '';
}

function field(labelKey, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, t(labelKey)), h('span', { class: 'input-wrap' }, input), hint ? h('span', { class: 'field-hint' }, hint) : null);
}

function seg(options, value, onPick) {
  const buttons = options.map(([v, label]) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(v === value) }, label);
    b.addEventListener('click', () => {
      for (const x of buttons) x.setAttribute('aria-pressed', String(x === b));
      onPick(v);
    });
    return b;
  });
  return h('div', { class: 'seg', role: 'group' }, buttons);
}

function strength(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return pw.length < 8 ? 0 : Math.min(4, score);
}

function renderTrack() {
  $('setup-track').replaceChildren(
    ...STEPS.map((s, i) => h('li', { class: i < state.step ? 'done' : i === state.step ? 'current' : '' }, h('span', { class: 'setup-dot' }, String(i + 1)), h('span', null, t(`setup.step.${s}`)))),
  );
}

function codeStep() {
  const input = h('input', { type: 'text', id: 'setup-code', autocomplete: 'off', spellcheck: 'false', value: state.code, placeholder: '0123456789abcdef…' });
  input.addEventListener('input', () => (state.code = input.value.trim().toLowerCase()));
  return [field('setup.code', input, t('setup.codeHint')), h('code', { class: 'setup-cmd' }, 'sudo cat /var/lib/serverhealth-panel/setup-token')];
}

function languageStep() {
  const select = h('select', { class: 'select', id: 'setup-lang' }, LANGUAGES.map((l) => h('option', { value: l }, NAMES[l])));
  select.value = window.I18N.lang;
  select.addEventListener('change', () => {
    const next = new URLSearchParams({ code: state.code, lang: select.value });
    window.location.search = next.toString();
  });
  return [
    field('setup.language', select),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('set.theme')), seg([['system', t('set.themeSystem')], ['light', t('set.themeLight')], ['dark', t('set.themeDark')]], currentTheme(), setTheme)),
  ];
}

function accountStep() {
  const user = h('input', { type: 'text', id: 'setup-user', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', value: state.username, maxlength: '32' });
  const pass = h('input', { type: 'password', id: 'setup-pass', autocomplete: 'new-password', value: state.password, maxlength: '200' });
  const again = h('input', { type: 'password', id: 'setup-pass2', autocomplete: 'new-password', value: state.confirm, maxlength: '200' });
  const meter = h('span', { class: 'strength' }, h('span'));
  const meterText = h('span', { class: 'field-hint' });
  const update = () => {
    const s = strength(pass.value);
    meter.dataset.level = String(s);
    meter.firstChild.style.width = `${(s / 4) * 100}%`;
    meterText.textContent = pass.value ? t(`setup.strength.${s}`) : t('setup.passwordHint');
  };
  user.addEventListener('input', () => (state.username = user.value.trim()));
  pass.addEventListener('input', () => {
    state.password = pass.value;
    update();
  });
  again.addEventListener('input', () => (state.confirm = again.value));
  const show = h('label', { class: 'check' }, h('input', { type: 'checkbox' }), h('span', null, t('setup.showPassword')));
  show.firstChild.addEventListener('change', () => {
    pass.type = again.type = show.firstChild.checked ? 'text' : 'password';
  });
  update();
  setTimeout(() => (state.username ? pass : user).focus());
  return [field('login.username', user, t('setup.usernameHint')), h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('login.password')), h('span', { class: 'input-wrap' }, pass), meter, meterText), field('setup.passwordAgain', again), show];
}

function servicesStep() {
  const known = new Set((state.info?.units ?? []).map((u) => u.name));
  const units = [...(state.info?.units ?? []), ...[...state.services].filter((n) => !known.has(n)).map((name) => ({ name, state: 'enabled' }))].sort((a, b) => a.name.localeCompare(b.name));
  const list = h('ul', { class: 'setup-services' });
  const filter = h('input', { type: 'search', class: 'input', placeholder: t('setup.filter'), value: state.filter });
  const count = h('span', { class: 'field-hint' });
  const draw = () => {
    const q = state.filter.toLowerCase();
    const shown = units.filter((u) => (state.all || u.state === 'enabled' || state.services.has(u.name)) && (!q || u.name.toLowerCase().includes(q)));
    list.replaceChildren(
      ...shown.map((u) => {
        const box = h('input', { type: 'checkbox' });
        box.checked = state.services.has(u.name);
        box.addEventListener('change', () => {
          if (box.checked) state.services.add(u.name);
          else state.services.delete(u.name);
          count.textContent = t('setup.selected', { n: state.services.size });
        });
        return h('li', null, h('label', { class: 'check' }, box, h('span', null, u.name), u.state !== 'enabled' ? h('small', { class: 'muted' }, u.state) : null));
      }),
    );
    if (!shown.length) list.append(h('li', { class: 'muted' }, t('setup.noServices')));
    count.textContent = t('setup.selected', { n: state.services.size });
  };
  filter.addEventListener('input', () => {
    state.filter = filter.value;
    draw();
  });
  const all = h('label', { class: 'check' }, h('input', { type: 'checkbox' }), h('span', null, t('setup.showAll')));
  all.firstChild.checked = state.all;
  all.firstChild.addEventListener('change', () => {
    state.all = all.firstChild.checked;
    draw();
  });
  draw();
  return [h('div', { class: 'setup-filter' }, filter, all), list, count];
}

function reviewStep() {
  const row = (k, v) => [h('dt', null, t(k)), h('dd', null, v)];
  return [
    h(
      'dl',
      { class: 'setup-summary' },
      row('setup.server', state.info?.hostname ?? '—'),
      row('setup.language', NAMES[window.I18N.lang]),
      row('login.username', state.username),
      row('setup.services', state.services.size ? [...state.services].sort().join(', ') : t('setup.none')),
    ),
    h('p', { class: 'field-hint' }, t('setup.reviewHint')),
  ];
}

function render() {
  renderTrack();
  const needCode = !state.info;
  const step = needCode ? 'code' : STEPS[state.step];
  $('setup-step-label').textContent = needCode ? '' : t('setup.stepOf', { n: state.step + 1, total: STEPS.length });
  $('setup-heading').textContent = t(`setup.h.${step}`);
  $('setup-sub').textContent = t(`setup.sub.${step}`);
  $('setup-body').replaceChildren(...{ code: codeStep, language: languageStep, account: accountStep, services: servicesStep, review: reviewStep }[step]());
  $('setup-back').hidden = needCode || state.step === 0;
  $('setup-next-label').textContent = t(needCode ? 'setup.continue' : step === 'review' ? 'setup.finish' : 'setup.next');
}

function setBusy(on) {
  state.busy = on;
  $('setup-next').classList.toggle('busy', on);
  $('setup-next').disabled = on;
}

async function loadInfo() {
  if (!/^[a-f0-9]{32}$/.test(state.code)) {
    if (state.code) alertBox(t('setup.badCode'));
    return render();
  }
  setBusy(true);
  try {
    const res = await fetch(`/api/setup?code=${encodeURIComponent(state.code)}&lang=${window.I18N.lang}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      state.info = data;
      state.services = new Set(data.services ?? []);
      alertBox(null);
      const url = new URL(window.location.href);
      url.searchParams.set('code', state.code);
      window.history.replaceState(null, '', url);
    } else if (res.status === 429) alertBox(t('setup.locked', { m: Math.ceil((data.retryAfter ?? 600) / 60) }));
    else if (res.status === 403) alertBox(t('setup.badCode'));
    else if (data.code === 'setup_required' || res.status === 404) alertBox(t('setup.failed'));
    else window.location.replace('/');
  } catch {
    alertBox(t('login.unreachable'));
  }
  setBusy(false);
  render();
}

function validateStep() {
  const step = STEPS[state.step];
  if (step === 'account') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(state.username)) return t('setup.badUsername');
    if (state.password.length < 8) return t('setup.shortPassword');
    if (state.password !== state.confirm) return t('setup.mismatch');
  }
  return null;
}

async function finish() {
  setBusy(true);
  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: state.code, language: window.I18N.lang, username: state.username, password: state.password, services: [...state.services] }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      $('setup-next-label').textContent = t('login.redirecting');
      window.location.replace('/');
      return;
    }
    alertBox(res.status === 403 ? t('setup.badCode') : res.status === 429 ? t('setup.locked', { m: Math.ceil((data.retryAfter ?? 600) / 60) }) : t('setup.failed'));
  } catch {
    alertBox(t('login.unreachable'));
  }
  setBusy(false);
}

$('setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.busy) return;
  if (!state.info) return loadInfo();
  const problem = validateStep();
  alertBox(problem);
  if (problem) return;
  if (STEPS[state.step] === 'review') return finish();
  state.step += 1;
  render();
});

$('setup-back').addEventListener('click', () => {
  alertBox(null);
  state.step = Math.max(0, state.step - 1);
  render();
});

function connectionNote() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  const secure = window.location.protocol === 'https:';
  const note = $('conn-note');
  note.dataset.kind = secure ? 'secure' : local ? 'local' : 'insecure';
  $('conn-note-text').textContent = t(secure ? 'login.secure' : local ? 'login.local' : 'login.insecure');
  if (!secure && !local) note.title = t('login.insecureTitle');
}

applyTheme();
connectionNote();
render();
loadInfo();
