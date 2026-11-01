'use strict';

const $ = (id) => document.getElementById(id);
const { t } = window.I18N;

try {
  const theme = localStorage.getItem('serverhealth-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  /* depolama kapalıysa sistem teması kullanılır */
}

const form = $('login-form');
const username = $('username');
const password = $('password');
const submit = $('submit');
const submitLabel = submit.querySelector('.btn-label');
const alertBox = $('login-alert');
const alertText = $('login-alert-text');
let lockTimer = null;

function showAlert(message, kind = 'error') {
  alertText.textContent = message;
  alertBox.dataset.kind = kind;
  alertBox.hidden = false;
}

const hideAlert = () => {
  alertBox.hidden = true;
};

function setBusy(busy, label = t('login.checking')) {
  submit.disabled = busy;
  submit.classList.toggle('busy', busy);
  submitLabel.textContent = busy ? label : t('login.submit');
}

function shake() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  form.classList.remove('shake');
  void form.offsetWidth; // animasyonu yeniden başlatır
  form.classList.add('shake');
}

function startLockout(seconds) {
  clearInterval(lockTimer);
  const until = Date.now() + seconds * 1000;
  submit.disabled = true;
  const tick = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (!left) {
      clearInterval(lockTimer);
      hideAlert();
      submit.disabled = false;
      return;
    }
    const time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    showAlert(t('login.locked', { time }), 'locked');
  };
  tick();
  lockTimer = setInterval(tick, 1000);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  const user = username.value.trim();
  if (!user || !password.value) {
    showAlert(t('login.required'));
    (user ? password : username).focus();
    return;
  }

  hideAlert();
  setBusy(true);
  try {
    const res = await fetch(new URL('/login', window.location.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: password.value, remember: $('remember').checked }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setBusy(true, t('login.redirecting'));
      // Oturum düşmeden önce açık olan bölüme (ör. #/ayarlar) geri dönülür.
      window.location.replace(`/${/^#\/[\w-]+(\/[\w-]+)?$/.test(window.location.hash) ? window.location.hash : ''}`);
      return;
    }
    setBusy(false);
    password.value = '';
    shake();
    if (res.status === 429) {
      startLockout(data.retryAfter || 60);
      return;
    }
    password.focus();
    if (res.status === 401) {
      const left = data.attemptsLeft;
      showAlert(left != null && left <= 2 ? t('login.attemptsLeft', { n: left }) : t('login.bad'));
    } else {
      showAlert(t('login.unexpected', { status: res.status }));
    }
  } catch {
    setBusy(false);
    showAlert(t('login.unreachable'));
  }
});

$('toggle-password').addEventListener('click', (event) => {
  const button = event.currentTarget;
  const show = password.type === 'password';
  password.type = show ? 'text' : 'password';
  button.classList.toggle('on', show);
  button.setAttribute('aria-pressed', String(show));
  button.setAttribute('aria-label', t(show ? 'login.hidePassword' : 'login.showPassword'));
  password.focus();
});

const capsHint = $('caps-hint');
for (const type of ['keydown', 'keyup']) {
  password.addEventListener(type, (event) => {
    if (event.getModifierState) capsHint.hidden = !event.getModifierState('CapsLock');
  });
}
password.addEventListener('blur', () => {
  capsHint.hidden = true;
});

$('forgot').addEventListener('click', (event) => {
  const help = $('forgot-help');
  help.hidden = !help.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!help.hidden));
});

// Bağlantının şifreli olup olmadığını dürüstçe göster.
const note = $('conn-note');
const local = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
if (window.location.protocol === 'https:') {
  note.dataset.kind = 'secure';
  $('conn-note-text').textContent = t('login.secure');
} else if (local) {
  $('conn-note-text').textContent = t('login.local');
} else {
  note.dataset.kind = 'insecure';
  $('conn-note-text').textContent = t('login.insecure');
  note.title = t('login.insecureTitle');
}
