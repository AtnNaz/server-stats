'use strict';

const $ = (id) => document.getElementById(id);
const { t, locale } = window.I18N;

// ---------- Biçimlendirme ----------

const pctFormat = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
const num0 = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
const num2 = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeFormat = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const fmtPct = (v) => (v == null ? '—' : pctFormat.format(v / 100));
const pct0Format = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
const pctAxis = (v) => pct0Format.format(v / 100);

function fmtBytes(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  // 1000 eşiği, 1023,9 MiB'ın "1.024 MiB" yerine "1 GiB" yazılmasını sağlar.
  while (bytes >= 1000 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${(i === 0 ? num0 : num1).format(bytes)} ${units[i]}`;
}

function fmtRate(bytesPerSec) {
  if (bytesPerSec == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'].map((unit) => t('unit.perSecond', { unit }));
  let i = 0;
  while (bytesPerSec >= 1000 && i < units.length - 1) {
    bytesPerSec /= 1000;
    i++;
  }
  return `${(i === 0 ? num0 : num1).format(bytesPerSec)} ${units[i]}`;
}

function fmtDuration(seconds) {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return t('dur.dh', { d, h });
  if (h) return t('dur.hm', { h, m });
  if (m) return t('dur.m', { m });
  return t('dur.s', { s });
}

// Uyarı eşikleri; sunucu her yanıtta Ayarlar'daki güncel değerleri gönderir.
let TH = { disk: [85, 95], memory: [85, 95], cpu: [80, 95], temperature: [80, 90] };

const level = (p, warn = 85, crit = 95) => (p == null ? '' : p >= crit ? 'crit' : p >= warn ? 'warn' : '');

const WELL_KNOWN_PORTS = {
  21: 'ftp', 22: 'ssh', 25: 'smtp', 53: 'dns', 67: 'dhcp', 80: 'http', 110: 'pop3', 111: 'rpcbind',
  123: 'ntp', 143: 'imap', 161: 'snmp', 323: 'chrony', 389: 'ldap', 443: 'https', 445: 'smb', 465: 'smtps',
  587: 'submission', 631: 'ipp', 993: 'imaps', 995: 'pop3s', 1433: 'mssql', 1521: 'oracle',
  2049: 'nfs', 2375: 'docker', 2376: 'docker-tls', 3306: 'mysql', 3389: 'rdp', 5353: 'mdns',
  5432: 'postgresql', 5672: 'amqp', 6379: 'redis', 8080: 'http-alt', 8443: 'https-alt',
  9090: 'prometheus', 9100: 'node-exporter', 9200: 'elasticsearch', 11211: 'memcached',
  11434: 'ollama', 27017: 'mongodb', 41641: 'tailscale',
};

// ---------- DOM yardımcıları ----------

// Tüm metinler textContent ile eklenir; süreç komutları veya konteyner adları HTML olarak yorumlanmaz.
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// Yerleşik replaceChildren null değerini "null" metni olarak ekler; bu yardımcı boş değerleri atlar.
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

// Sabit simge şekilleri (kullanıcı verisi içermez).
const ICONS = {
  ok: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>',
  crit: '<circle cx="12" cy="12" r="9"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>',
  warn: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4M12 17v.1"/>',
  off: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12h7"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.2v.1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  server: '<rect x="3.5" y="3.5" width="17" height="7" rx="2"/><rect x="3.5" y="13.5" width="17" height="7" rx="2"/><path d="M7.5 7h.01M7.5 17h.01"/>',
  kernel: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chip: '<rect x="5" y="5" width="14" height="14" rx="2.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/>',
  memory: '<rect x="2.5" y="7" width="19" height="10" rx="2"/><path d="M6.5 7v10M10.5 7v10M14.5 7v10"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  power: '<path d="M12 3.5v8M6.6 6.6a7.5 7.5 0 1 0 10.8 0"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/>',
  disk: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
};
const iconTemplate = document.createElement('template');
function icon(name) {
  iconTemplate.innerHTML = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  return iconTemplate.content.firstElementChild;
}

const errorBox = (message) => h('p', { class: 'card-error' }, icon('error'), h('span', null, message));
const placeholder = (text) => h('p', { class: 'placeholder' }, text);
const tag = (kind, iconName, label) => h('span', { class: `tag ${kind}` }, icon(iconName), label);

function meter(value, warn, crit) {
  const bar = h('span');
  bar.style.width = `${Math.min(100, Math.max(0, value ?? 0))}%`;
  return h('div', { class: `meter ${level(value, warn, crit)}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': value ?? 0 }, bar);
}

function mini(value) {
  const bar = h('span');
  bar.style.width = `${Math.min(100, Math.max(0, value ?? 0))}%`;
  return h('span', { class: 'mini', 'aria-hidden': 'true' }, bar);
}

function table(headers, rows) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      null,
      h('thead', null, h('tr', null, headers.map(([label, cls]) => h('th', { class: cls, scope: 'col' }, label)))),
      h('tbody', null, rows),
    ),
  );
}

// ---------- Grafikler ----------

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function withAlpha(hex, alpha) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

function niceMax(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (value * 1.1 <= m * magnitude) return m * magnitude;
  return 10 * magnitude;
}

const tooltip = $('tooltip');

// Zaman serisi çizgi grafiği: ince çizgiler, hafif alan dolgusu, artı imleci ve ipucu kutusu.
class LineChart {
  constructor(canvas, { max = null, format = String, axes = true, interactive = true, timeLabel = timeFormat } = {}) {
    Object.assign(this, { canvas, max, format, axes, interactive, timeLabel, data: null, hover: null });
    if (!interactive) return;
    canvas.addEventListener('pointermove', (e) => this.onPointer(e));
    canvas.addEventListener('pointerleave', () => this.clearHover());
    canvas.addEventListener('blur', () => this.clearHover());
    canvas.addEventListener('focus', () => this.moveHover(this.count() - 1));
    canvas.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      this.moveHover((this.hover ?? this.count() - 1) + (e.key === 'ArrowLeft' ? -1 : 1));
    });
  }

  count() {
    return this.data?.times.length ?? 0;
  }

  set(data) {
    this.data = data;
    if (this.hover != null) this.hover = Math.min(this.hover, this.count() - 1);
    this.draw();
    if (this.hover != null) this.showTooltip();
  }

  layout() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const padTop = this.axes ? 16 : 3;
    const padRight = this.axes ? 6 : 2; // son noktadaki işaret kenarda kırpılmasın
    const capacity = Math.max(2, this.data.capacity);
    const step = (width - padRight) / (capacity - 1);
    const offset = capacity - this.count(); // en yeni nokta her zaman sağ kenarda
    const values = this.data.series.flatMap((s) => s.values).filter((v) => v != null);
    const top = this.max ?? niceMax(Math.max(0, ...values));
    const plot = height - padTop - 2;
    return { width, height, padTop, step, offset, top, plot, x: (i) => (offset + i) * step, y: (v) => padTop + plot - (Math.min(v, top) / top) * plot };
  }

  draw() {
    const { canvas } = this;
    if (!this.data) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const g = this.layout();
    const surface = cssVar('--surface');

    if (this.axes) {
      ctx.strokeStyle = cssVar('--grid');
      ctx.lineWidth = 1;
      ctx.fillStyle = cssVar('--axis');
      ctx.font = `11px ${cssVar('--sans')}`;
      ctx.textBaseline = 'bottom';
      for (const f of [0, 0.5, 1]) {
        const yy = Math.round(g.padTop + g.plot * f) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(width, yy);
        ctx.stroke();
        if (f < 1) ctx.fillText(this.format(g.top * (1 - f)), 2, yy - 2);
      }
    }

    for (const s of this.data.series) {
      const color = cssVar(s.color);
      const segments = [];
      let current = [];
      s.values.forEach((v, i) => {
        if (v == null) {
          if (current.length) segments.push(current);
          current = [];
        } else {
          current.push([g.x(i), g.y(v)]);
        }
      });
      if (current.length) segments.push(current);

      for (const pts of segments) {
        if (s.fill && pts.length > 1) {
          const gradient = ctx.createLinearGradient(0, g.padTop, 0, height);
          gradient.addColorStop(0, withAlpha(color, 0.18));
          gradient.addColorStop(1, withAlpha(color, 0));
          ctx.beginPath();
          pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.lineTo(pts[pts.length - 1][0], height);
          ctx.lineTo(pts[0][0], height);
          ctx.closePath();
          ctx.fillStyle = gradient;
          ctx.fill();
        }
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.strokeStyle = color;
        ctx.lineWidth = this.axes ? 2 : 1.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      // Son değerde nokta (yüzey renginde halkayla)
      const lastIndex = s.values.length - 1;
      if (this.axes && this.hover == null && s.values[lastIndex] != null) {
        this.dot(ctx, g.x(lastIndex), g.y(s.values[lastIndex]), color, surface);
      }
    }

    if (this.hover != null) {
      const x = g.x(this.hover);
      ctx.strokeStyle = cssVar('--axis');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, g.padTop);
      ctx.lineTo(Math.round(x) + 0.5, height);
      ctx.stroke();
      for (const s of this.data.series) {
        const v = s.values[this.hover];
        if (v != null) this.dot(ctx, x, g.y(v), cssVar(s.color), surface);
      }
    }
  }

  dot(ctx, x, y, color, surface) {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = surface;
    ctx.stroke();
  }

  onPointer(event) {
    if (!this.count()) return;
    const g = this.layout();
    const x = event.clientX - this.canvas.getBoundingClientRect().left;
    this.moveHover(Math.round(x / g.step) - g.offset, event.clientX, event.clientY);
  }

  moveHover(index, clientX, clientY) {
    const n = this.count();
    if (!n) return;
    this.hover = Math.max(0, Math.min(n - 1, index));
    this.draw();
    this.showTooltip(clientX, clientY);
  }

  clearHover() {
    if (this.hover == null) return;
    this.hover = null;
    tooltip.hidden = true;
    this.draw();
  }

  showTooltip(clientX, clientY) {
    const i = this.hover;
    const rect = this.canvas.getBoundingClientRect();
    const g = this.layout();
    // Klavyeyle gezinirken kutu, seçili noktanın yanına konur.
    const px = clientX ?? rect.left + g.x(i);
    const py = clientY ?? rect.top + g.padTop + 10;
    fill(
      tooltip,
      h('div', { class: 'tt-time' }, this.timeLabel.format(new Date(this.data.times[i]))),
      this.data.series.map((s) =>
        h('div', { class: 'tt-row' }, h('i', { class: `key ${s.key}` }), h('strong', null, s.values[i] == null ? '—' : this.format(s.values[i])), h('span', { class: 'tt-name' }, s.name)),
      ),
    );
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth;
    const left = px + 14 + tw > window.innerWidth - 8 ? px - 14 - tw : px + 14;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, py - 12)}px`;
  }
}

const loadChart = new LineChart($('load-chart'), { max: 100, format: pctAxis });
const netChart = new LineChart($('net-chart'), { format: fmtRate });
const netSpark = new LineChart(document.querySelector('#kpi-net [data-spark]'), { axes: false, interactive: false });
const gpuChart = new LineChart($('gpu-chart'), { max: 100, format: pctAxis });
const ioChart = new LineChart($('io-chart'), { format: fmtRate });
const tempChart = new LineChart($('temp-chart'), { format: (v) => `${num0.format(v)} °C` });
const allCharts = [loadChart, netChart, netSpark, gpuChart, ioChart, tempChart];
const redrawCharts = () => allCharts.forEach((c) => c.draw());

// ---------- Özet kutucukları ----------

function setKpi(id, { value, sub, detail, percent, warn = 85, crit = 95, label }) {
  const card = $(id);
  card.querySelector('[data-value]').textContent = value;
  const subEl = card.querySelector('[data-sub]');
  subEl.textContent = sub || '\u00a0';
  subEl.title = detail ?? sub ?? '';
  if (label) card.querySelector('[data-label]').textContent = label;
  const ring = card.querySelector('[data-ring]');
  const lvl = level(percent, warn, crit);
  const circumference = 2 * Math.PI * Number(ring.getAttribute('r'));
  const share = Math.min(100, Math.max(0, percent ?? 0)) / 100;
  ring.setAttribute('stroke-dasharray', `${(share * circumference).toFixed(2)} ${circumference.toFixed(2)}`);
  ring.setAttribute('class', `ring-fill ${lvl}`);
  const pill = card.querySelector('[data-status]');
  pill.hidden = !lvl;
  if (lvl) {
    pill.className = `status-pill ${lvl}`;
    fill(pill, icon(lvl === 'crit' ? 'crit' : 'warn'), t(lvl === 'crit' ? 'level.crit' : 'level.warn'));
  }
}

function renderHost(sys, cpuCount) {
  const host = sys?.host;
  if (!host) return;
  $('hostname').textContent = host.hostname;
  $('host-os').textContent = host.os;
  $('side-uptime').textContent = t('host.uptime', { d: fmtDuration(host.uptime) });
  hostName = host.hostname;
  updateTitle();
  fill(
    $('host-meta'),
    h('span', null, icon('server'), host.os),
    h('span', null, icon('kernel'), t('host.kernel', { kernel: host.kernel, arch: host.arch })),
    h('span', null, icon('clock'), t('host.uptime', { d: fmtDuration(host.uptime) })),
    cpuCount ? h('span', null, icon('chip'), t('host.cpuCores', { n: cpuCount })) : null,
    sys.memory ? h('span', null, icon('memory'), t('host.memory', { size: fmtBytes(sys.memory.total) })) : null,
  );
}

function renderSystemKpis(sys, sensors) {
  if (sys.error) {
    for (const id of ['kpi-cpu', 'kpi-mem', 'kpi-disk']) setKpi(id, { value: '—', sub: sys.error, percent: null });
    return;
  }
  const { cpu, memory: m, disks } = sys;
  setKpi('kpi-cpu', {
    value: fmtPct(cpu.usage),
    sub: `${t('kpi.load', { n: num2.format(cpu.load[0]) })}${sensors?.cpu?.package != null ? ` · ${num0.format(sensors.cpu.package)} °C` : ''}`,
    detail: t('kpi.loadDetail', { v: cpu.load.map((v) => num2.format(v)).join(' / ') }),
    percent: cpu.usage,
    warn: TH.cpu[0],
    crit: TH.cpu[1],
  });
  setKpi('kpi-mem', { value: fmtPct(m.percent), sub: `${fmtBytes(m.used)} / ${fmtBytes(m.total)}`, percent: m.percent, warn: TH.memory[0], crit: TH.memory[1] });

  const usable = disks.filter((d) => !d.error);
  const fullest = usable.reduce((a, d) => (a == null || d.percent > a.percent ? d : a), null);
  if (fullest) {
    setKpi('kpi-disk', {
      value: fmtPct(fullest.percent),
      sub: t('disk.free', { size: fmtBytes(fullest.available) }),
      detail: `${usable.length > 1 ? t('kpi.fullestDisk') : ''}${fullest.mount} · ${fmtBytes(fullest.used)} / ${fmtBytes(fullest.total)}`,
      percent: fullest.percent,
      warn: TH.disk[0],
      crit: TH.disk[1],
      label: t('kpi.disk', { name: fullest.mount === '/' ? '/' : fullest.mount.split('/').pop() }),
    });
  } else {
    setKpi('kpi-disk', { value: '—', sub: t('kpi.noDisk'), percent: null });
  }
}

function renderNetKpi(net, history, capacity) {
  const card = $('kpi-net');
  if (net.error) {
    card.querySelector('[data-rx]').textContent = '—';
    card.querySelector('[data-tx]').textContent = '—';
    card.querySelector('[data-sub]').textContent = net.error;
    return;
  }
  const sum = (key) => net.interfaces.reduce((s, i) => s + (i[key] ?? 0), 0);
  card.querySelector('[data-rx]').textContent = `↓ ${fmtRate(sum('rxRate'))}`;
  card.querySelector('[data-tx]').textContent = `↑ ${fmtRate(sum('txRate'))}`;
  card.querySelector('[data-sub]').textContent = t('kpi.ifaces', { n: net.interfaces.length });
  const total = (p, k) => (p.net ? Object.values(p.net).reduce((s, v) => s + (v[k] ?? 0), 0) : null);
  netSpark.set({
    times: history.map((p) => p.t),
    capacity,
    series: [
      { values: history.map((p) => total(p, 0)), color: '--series-1', fill: true },
      { values: history.map((p) => total(p, 1)), color: '--series-2' },
    ],
  });
}

// ---------- Kartlar ----------

function renderLoad(sys, history, capacity) {
  if (sys.error) return;
  const { cpu } = sys;
  $('load-meta').textContent = t('cpu.cores', { n: cpu.count });
  loadChart.set({
    times: history.map((p) => p.t),
    capacity,
    series: [
      { name: t('cpu.label'), key: 's1', color: '--series-1', fill: true, values: history.map((p) => p.cpu) },
      { name: t('mem.label'), key: 's2', color: '--series-2', values: history.map((p) => p.mem) },
    ],
  });

  fill(
    $('cores'),
    cpu.cores.map((v, i) => {
      const bar = h('span');
      bar.style.height = `${Math.max(2, v ?? 0)}%`;
      return h('div', { class: `core ${level(v, 80, 95)}`, title: t('cpu.coreTitle', { i, p: fmtPct(v) }) }, bar);
    }),
  );
  const busiest = cpu.cores.length ? Math.max(...cpu.cores.map((v) => v ?? 0)) : null;
  $('cores-label').textContent = cpu.cores.length ? t('cpu.coresLabel', { p: fmtPct(busiest) }) : t('cpu.coresWaiting');
  $('cpu-model').textContent = sys.host.cpuModel ?? '';
}

function renderDisks(sys) {
  const body = $('disk-body');
  if (sys.error) return fill(body, errorBox(sys.error));
  const disks = sys.disks;
  $('disk-meta').textContent = disks.length ? t('fs.count', { n: disks.length }) : '';
  if (!disks.length) return fill(body, placeholder(t('disk.none')));
  fill(
    body,
    h(
      'ul',
      { class: 'list' },
      disks.map((d) =>
        h(
          'li',
          null,
          h(
            'div',
            { class: 'row-head' },
            h('span', { class: 'row-title' }, h('span', { class: 'mono', title: d.source }, d.mount), h('span', { class: 'tag' }, d.fstype), d.readOnly ? h('span', { class: 'tag' }, t('disk.readOnly')) : null),
            d.error ? tag('crit', 'crit', d.error) : h('span', { class: 'row-value' }, fmtPct(d.percent)),
          ),
          d.error ? null : meter(d.percent, ...TH.disk),
          d.error
            ? null
            : h(
                'div',
                { class: 'row-foot' },
                t('disk.usage', { used: fmtBytes(d.used), total: fmtBytes(d.total), free: fmtBytes(d.available) }),
                d.inodesPercent >= 80 ? t('disk.inodes', { p: fmtPct(d.inodesPercent) }) : null,
                d.alsoMounted.length ? t('disk.alsoMounted', { list: d.alsoMounted.join(', ') }) : null,
              ),
        ),
      ),
    ),
  );
}

const IF_STATES = {
  up: ['ok', 'ok', 'iface.up'],
  down: ['crit', 'crit', 'iface.down'],
  dormant: ['warn', 'warn', 'iface.dormant'],
  lowerlayerdown: ['crit', 'crit', 'iface.noCable'],
};

// Sekme düğmelerini yalnızca liste değişince yeniden kurar; böylece her güncellemede
// odak ve tıklama kaybolmaz. items: [{ id, label, title }]
function renderTabs(container, items, selectedId, onSelect) {
  const signature = items.map((i) => `${i.id}\u0000${i.label}`).join('\u0001');
  if (container.dataset.signature !== signature) {
    container.dataset.signature = signature;
    fill(
      container,
      items.map((item) => {
        const button = h('button', { type: 'button', 'data-id': item.id, title: item.title }, item.label);
        button.addEventListener('click', () => onSelect(item.id));
        return button;
      }),
    );
  }
  for (const button of container.children) button.setAttribute('aria-pressed', String(button.dataset.id === selectedId));
  container.hidden = items.length < 2;
}

let selectedIface = null;

function renderNetwork(net, history, capacity) {
  const body = $('net-body');
  const tabs = $('iface-tabs');
  if (net.error) {
    renderTabs(tabs, [], null, () => {});
    return fill(body, errorBox(net.error));
  }
  const ifaces = net.interfaces;
  if (!ifaces.length) {
    renderTabs(tabs, [], null, () => {});
    return fill(body, placeholder(t('net.none')));
  }
  if (!ifaces.some((i) => i.name === selectedIface)) {
    // Varsayılan: en çok trafik gören arayüz
    selectedIface = [...ifaces].sort((a, b) => b.rxTotal + b.txTotal - (a.rxTotal + a.txTotal))[0].name;
  }

  renderTabs(
    tabs,
    ifaces.map((i) => ({ id: i.name, label: i.name })),
    selectedIface,
    (id) => {
      selectedIface = id;
      if (lastData) render(lastData);
    },
  );

  netChart.set({
    times: history.map((p) => p.t),
    capacity,
    series: [
      { name: t('net.rx'), key: 's1', color: '--series-1', fill: true, values: history.map((p) => p.net?.[selectedIface]?.[0] ?? null) },
      { name: t('net.tx'), key: 's2', color: '--series-2', values: history.map((p) => p.net?.[selectedIface]?.[1] ?? null) },
    ],
  });
  $('net-chart').setAttribute('aria-label', t('net.chartLabel', { name: selectedIface }));

  fill(
    body,
    ifaces.map((i) => {
      const [cls, iconName, labelKey] = IF_STATES[i.state] ?? ['', 'off', 'iface.unknown'];
      return h(
        'div',
        { class: 'iface' },
        h('div', { class: 'iface-top' }, h('span', null, i.name), tag(cls, iconName, t(labelKey))),
        h('div', { class: 'iface-rates' }, h('span', null, h('i', { class: 'key s1' }), `↓ ${fmtRate(i.rxRate)}`), h('span', null, h('i', { class: 'key s2' }), `↑ ${fmtRate(i.txRate)}`)),
        i.addresses.length ? h('div', { class: 'addr mono' }, i.addresses.map((a) => h('div', null, a))) : null,
        h(
          'div',
          { class: 'row-foot' },
          t('net.totals', { rx: fmtBytes(i.rxTotal), tx: fmtBytes(i.txTotal) }),
          i.errors ? t('net.errors', { n: num0.format(i.errors) }) : null,
          i.drops ? t('net.drops', { n: num0.format(i.drops) }) : null,
        ),
      );
    }),
  );
}

const EXPOSURE = {
  all: ['info', 'globe', 'ports.all'],
  specific: ['info', 'target', 'ports.specific'],
  local: ['', 'lock', 'ports.local'],
};

function renderPorts(net) {
  const body = $('ports-body');
  if (net.error) return fill(body, errorBox(net.error));
  const ports = net.ports;
  const open = ports.filter((p) => p.exposure !== 'local').length;
  $('ports-meta').textContent = ports.length ? t('ports.summary', { n: ports.length, open }) : '';
  if (!ports.length) return fill(body, placeholder(t('ports.none')));
  fill(
    body,
    table(
      [[t('ports.port')], [t('ports.address')], [t('ports.access'), 'r']],
      ports.map((p) => {
        const [cls, iconName, labelKey] = EXPOSURE[p.exposure];
        return h(
          'tr',
          null,
          h('td', { class: 'nowrap' }, h('strong', { class: 'num' }, p.port), ' ', h('span', { class: 'muted small' }, `${p.proto.toUpperCase()}${WELL_KNOWN_PORTS[p.port] ? ` · ${WELL_KNOWN_PORTS[p.port]}` : ''}`)),
          h('td', { class: 'mono break' }, p.addresses.join(', ')),
          h('td', { class: 'r' }, tag(cls, iconName, t(labelKey))),
        );
      }),
    ),
  );
}

let procSort = 'cpu';

function renderProcesses(p) {
  const body = $('proc-body');
  if (p.error) {
    $('proc-meta').textContent = '';
    return fill(body, errorBox(p.error));
  }
  $('proc-meta').textContent = [t('proc.count', { n: num0.format(p.total) }), t('proc.threads', { n: num0.format(p.threads) }), p.zombie ? t('proc.zombies', { n: p.zombie }) : null]
    .filter(Boolean)
    .join(' · ');
  const list = procSort === 'cpu' ? p.byCpu : p.byMem;
  if (!list) return fill(body, placeholder(t('proc.waiting')));
  const cpuScale = Math.max(100, ...list.map((r) => r.cpu ?? 0));
  fill(
    body,
    table(
      [['PID'], [t('proc.user')], ['CPU', 'r'], [t('proc.memory'), 'r'], [t('proc.command')]],
      list.map((r) =>
        h(
          'tr',
          null,
          h('td', { class: 'mono' }, r.pid),
          h('td', null, h('span', { class: 'user-cell' }, h('span', { class: 'user-dot', 'aria-hidden': 'true' }, String(r.user).slice(0, 1)), r.user)),
          h('td', { class: 'r' }, h('span', { class: 'bar-cell' }, mini(((r.cpu ?? 0) / cpuScale) * 100), r.cpu == null ? '—' : fmtPct(r.cpu))),
          h('td', { class: 'r' }, h('span', { class: 'bar-cell' }, mini(r.memoryPercent), fmtBytes(r.memory))),
          h('td', { class: 'cmd', title: r.command }, r.command),
        ),
      ),
    ),
    h('p', { class: 'row-foot' }, t('proc.cpuNote')),
  );
}

function serviceState(s) {
  if (s.load === 'not-found') return ['off', 'off', t('svc.notFound')];
  if (s.active === 'active') return ['ok', 'ok', s.sub === 'running' ? t('state.running') : s.sub === 'exited' ? t('svc.exited') : s.sub];
  if (s.active === 'failed') return ['crit', 'crit', t('svc.failed')];
  if (s.active === 'activating') return ['warn', 'warn', t('svc.activating')];
  if (s.active === 'deactivating') return ['warn', 'warn', t('svc.deactivating')];
  if (s.active === 'reloading') return ['warn', 'warn', t('svc.reloading')];
  if (s.active === 'inactive') return ['off', 'off', t('state.stopped')];
  return ['off', 'off', s.active];
}

function renderServices(svc) {
  const body = $('svc-body');
  if (svc.error) return fill(body, errorBox(svc.error));
  const units = svc.units;
  if (!units.length) {
    $('svc-meta').textContent = '';
    return fill(body, placeholder(t('svc.none')));
  }
  const healthy = units.filter((u) => u.active === 'active').length;
  $('svc-meta').textContent = t('svc.running', { a: healthy, b: units.length });
  fill(
    body,
    h(
      'ul',
      { class: 'list' },
      units.map((u) => {
        const [cls, iconName, label] = serviceState(u);
        const details = [u.activeFor != null ? fmtDuration(u.activeFor) : null, u.memory != null ? fmtBytes(u.memory) : null].filter(Boolean);
        return h(
          'li',
          { class: 'svc' },
          h('span', { class: `svc-icon ${cls}` }, icon(iconName)),
          h('div', { class: 'svc-main' }, h('div', { class: 'svc-name' }, u.name), h('div', { class: 'svc-desc', title: u.description }, u.description || u.unit)),
          h(
            'div',
            { class: 'svc-side' },
            h('div', { class: 'svc-state' }, label),
            details.length ? h('div', { class: 'muted' }, details.join(' · ')) : null,
            u.restarts ? h('div', { class: 'muted' }, t('svc.restarts', { n: u.restarts })) : null,
          ),
        );
      }),
    ),
  );
}

function containerState(c) {
  if (c.state === 'running') return /unhealthy/.test(c.status) ? ['warn', 'warn', t('docker.unhealthy')] : ['ok', 'ok', t('state.running')];
  if (c.state === 'exited') {
    const code = Number(/Exited \((\d+)\)/.exec(c.status)?.[1] ?? 0);
    return code ? ['crit', 'crit', t('docker.exitCode', { code })] : ['', 'off', t('state.stopped')];
  }
  if (c.state === 'restarting') return ['warn', 'warn', t('docker.restarting')];
  if (c.state === 'paused') return ['warn', 'warn', t('docker.paused')];
  if (c.state === 'dead') return ['crit', 'crit', t('docker.dead')];
  return ['', 'off', c.state];
}

function renderDocker(docker) {
  const card = $('docker-card');
  card.hidden = Boolean(docker.disabled);
  if (docker.disabled) return;
  const body = $('docker-body');
  if (docker.error) {
    $('docker-meta').textContent = '';
    return fill(body, errorBox(docker.error));
  }
  $('docker-meta').textContent = t('docker.running', { a: docker.running, b: docker.total });
  if (!docker.containers.length) return fill(body, placeholder(t('docker.none')));
  fill(
    body,
    table(
      [[t('docker.name')], [t('docker.image')], [t('docker.state')], [t('docker.ports'), 'r']],
      docker.containers.map((c) => {
        const [cls, iconName, label] = containerState(c);
        return h(
          'tr',
          null,
          h('td', null, h('strong', null, c.name), h('div', { class: 'mono muted' }, c.id)),
          h('td', { class: 'mono' }, c.image),
          h('td', null, tag(cls, iconName, label), h('div', { class: 'muted small' }, c.status)),
          h('td', { class: 'r mono' }, c.ports.join(', ') || '—'),
        );
      }),
    ),
  );
}

// ---------- Depolama: disk etkinliği ve sağlık ----------

let selectedDisk = null;

const SMART_STATES = {
  ok: ['ok', 'ok', 'smart.ok'],
  warn: ['warn', 'warn', 'smart.warn'],
  crit: ['crit', 'crit', 'smart.crit'],
  unknown: ['', 'off', 'smart.unknown'],
};

// Diski kullanıcının tanıdığı adla gösterir: sistem diski ya da bağlandığı klasörün adı.
function diskLabel(d) {
  if (d.mounts.includes('/')) return t('disk.system');
  const mount = d.mounts.find((m) => /^\/(mnt|media|srv|data)\//.test(m)) ?? d.mounts[0];
  return mount ? mount.split('/').filter(Boolean).pop() : d.name;
}

// Disk boyutları üreticiler gibi ondalık birimle yazılır (1 TB = 10^12 bayt).
const fmtDiskSize = (bytes) => (bytes >= 1e12 ? `${num1.format(bytes / 1e12)} TB` : `${num0.format(bytes / 1e9)} GB`);

function fmtHours(hours) {
  if (hours == null) return '—';
  if (hours < 48) return t('dur.hours', { n: num0.format(hours) });
  if (hours < 24 * 365) return t('dur.days', { n: num0.format(hours / 24) });
  return t('dur.years', { n: num1.format(hours / 8766) });
}

const fmtAgo = (ts) => t('time.ago', { d: fmtDuration(Math.max(0, (Date.now() - ts) / 1000)) });
const metric = (label, value, title) => h('div', null, h('dt', null, label), h('dd', { title: title ?? value }, value));

function physTile(d) {
  const sm = d.smart;
  const [cls, iconName, labelKey] = sm ? SMART_STATES[sm.status] ?? SMART_STATES.unknown : ['', 'off', 'smart.none'];
  const problem = sm && (sm.status === 'warn' || sm.status === 'crit');
  return h(
    'div',
    { class: `phys ${problem ? sm.status : ''}` },
    h(
      'div',
      { class: 'phys-head' },
      h('div', { class: 'phys-title' }, h('strong', null, diskLabel(d)), h('span', { title: d.model }, `${d.model} · ${fmtDiskSize(d.size)} · /dev/${d.name}`)),
      h('div', { class: 'phys-tags' }, h('span', { class: 'tag' }, d.type), sm?.standby ? tag('', 'off', t('disk.standby')) : null, tag(cls, iconName, t(labelKey))),
    ),
    d.mounts.length ? h('div', { class: 'mono muted' }, d.mounts.join('  ')) : h('div', { class: 'muted small' }, t('disk.notMounted')),
    h(
      'dl',
      { class: 'metrics' },
      metric(t('io.read'), fmtRate(d.readRate)),
      metric(t('io.write'), fmtRate(d.writeRate)),
      metric(t('disk.busy'), fmtPct(d.busy)),
      metric(t('temp.label'), sm?.temperature != null ? `${num0.format(sm.temperature)} °C` : '—'),
      metric(t('disk.powerOn'), fmtHours(sm?.powerOnHours), sm?.powerOnHours != null ? t('dur.hoursLong', { n: num0.format(sm.powerOnHours) }) : undefined),
      metric(t('disk.wear'), sm?.wearPercent != null ? fmtPct(sm.wearPercent) : '—'),
    ),
    sm?.reasons?.length ? h('ul', { class: 'reasons' }, sm.reasons.map((r) => h('li', null, r))) : null,
    sm && (sm.writtenBytes != null || sm.powerCycles != null)
      ? h(
          'div',
          { class: 'row-foot' },
          [sm.writtenBytes != null ? t('disk.written', { size: fmtBytes(sm.writtenBytes) }) : null, sm.powerCycles != null ? t('disk.powerCycles', { n: num0.format(sm.powerCycles) }) : null]
            .filter(Boolean)
            .join(' · '),
        )
      : null,
  );
}

function renderStorage(st, history, capacity) {
  const body = $('phys-body');
  if (st.error) {
    $('phys-meta').textContent = '';
    return fill(body, errorBox(st.error));
  }
  const devices = st.devices;
  if (!devices.some((d) => d.name === selectedDisk)) {
    // Varsayılan: şu an en çok okuma/yazma yapan disk
    selectedDisk = [...devices].sort((a, b) => (b.readRate ?? 0) + (b.writeRate ?? 0) - ((a.readRate ?? 0) + (a.writeRate ?? 0)))[0]?.name ?? null;
  }
  renderTabs(
    $('io-tabs'),
    devices.map((d) => ({ id: d.name, label: diskLabel(d), title: `${d.model} (/dev/${d.name})` })),
    selectedDisk,
    (id) => {
      selectedDisk = id;
      if (lastData) render(lastData);
    },
  );
  ioChart.set({
    times: history.map((p) => p.t),
    capacity,
    series: [
      { name: t('io.read'), key: 's1', color: '--series-1', fill: true, values: history.map((p) => p.io?.[selectedDisk]?.[0] ?? null) },
      { name: t('io.write'), key: 's2', color: '--series-2', values: history.map((p) => p.io?.[selectedDisk]?.[1] ?? null) },
    ],
  });
  const sum = (key) => devices.reduce((s, d) => s + (d[key] ?? 0), 0);
  $('io-meta').textContent = t('io.meta', { r: fmtRate(sum('readRate')), w: fmtRate(sum('writeRate')) });

  const smart = st.smart;
  $('phys-meta').textContent = [t('disk.count', { n: devices.length }), smart.available ? t('disk.smartRead', { ago: fmtAgo(smart.updated) }) : null].filter(Boolean).join(' · ');
  const notice = smart.available
    ? null
    : h(
        'p',
        { class: 'notice' },
        icon('error'),
        h('span', null, t('smart.missing.before'), h('code', null, 'smartmontools'), t('smart.missing.after')),
      );
  // Sorunlu diskler başa alınır.
  const rank = { crit: 0, warn: 1 };
  const sorted = [...devices].sort((a, b) => (rank[a.smart?.status] ?? 2) - (rank[b.smart?.status] ?? 2));
  fill(body, notice, h('div', { class: 'phys-grid' }, sorted.map(physTile)));
}

// ---------- Sıcaklık ve fanlar ----------

function tempLevel(sensor) {
  const crit = sensor.crit ?? TH.temperature[1];
  const high = sensor.high ?? Math.min(crit - 5, TH.temperature[0]);
  return sensor.value >= crit ? 'crit' : sensor.value >= high ? 'warn' : '';
}

function tempRow(sensor) {
  const crit = sensor.crit ?? TH.temperature[1];
  const high = sensor.high ?? Math.min(crit - 5, TH.temperature[0]);
  const lvl = tempLevel(sensor);
  return statRow(
    h('span', null, sensor.label, lvl ? ' ' : null, lvl ? tag(lvl, lvl === 'crit' ? 'crit' : 'warn', t(lvl === 'crit' ? 'level.crit' : 'level.warn')) : null),
    `${num1.format(sensor.value)} °C`,
    meter((sensor.value / crit) * 100, (high / crit) * 100, 100),
  );
}

const fanRow = (f) => statRow(f.label, t('fan.rpm', { n: num0.format(f.rpm) }), f.max ? meter((f.rpm / f.max) * 100, 101, 101) : null);

// SATA disklerin sıcaklığı hwmon'da değil SMART'ta olduğu için ayrı bir grup olarak eklenir.
function smartTempGroup(storage) {
  const temps = (storage?.devices ?? [])
    .filter((d) => d.type !== 'NVMe SSD' && d.smart?.temperature != null)
    .map((d) => ({ label: diskLabel(d), value: d.smart.temperature, high: d.type === 'HDD' ? 50 : 60, crit: d.type === 'HDD' ? 60 : 70 }));
  return temps.length ? { name: t('temp.sataGroup'), kind: 'disk', temps, fans: [] } : null;
}

function renderSensors(sensors, history, capacity, storage) {
  if (sensors.error) {
    fill($('sensor-body'), errorBox(sensors.error));
    fill($('fan-body'), errorBox(sensors.error));
    return;
  }
  const cpu = sensors.cpu;
  $('temp-meta').textContent = cpu ? t('temp.meta', { cpu: num0.format(cpu.package), high: num0.format(cpu.high) }) : '';
  tempChart.set({
    times: history.map((p) => p.t),
    capacity,
    series: [
      { name: t('temp.cpuPackage'), key: 's1', color: '--series-1', fill: true, values: history.map((p) => p.temp?.[0] ?? null) },
      { name: t('temp.hottestDisk'), key: 's2', color: '--series-2', values: history.map((p) => p.temp?.[1] ?? null) },
    ],
  });

  const fans = sensors.groups.flatMap((g) => g.fans);
  $('fan-meta').textContent = fans.length ? t('fan.count', { n: fans.length }) : '';
  fill($('fan-body'), fans.length ? h('ul', { class: 'list' }, fans.map(fanRow)) : placeholder(t('fan.none')));

  const groups = [...sensors.groups, smartTempGroup(storage)].filter((g) => g?.temps.length);
  $('sensor-meta').textContent = t('sensor.count', { n: groups.reduce((sum, g) => sum + g.temps.length, 0) });
  fill(
    $('sensor-body'),
    groups.length
      ? groups.map((g) => h('div', { class: 'sensor-group' }, h('h3', null, g.name), h('ul', { class: 'list' }, g.temps.map(tempRow))))
      : placeholder(t('temp.none')),
  );
}

// ---------- Genel bakış: dikkat gerektirenler ----------

function renderAlerts(s) {
  const items = [];
  for (const d of s.storage?.devices ?? []) {
    const sm = d.smart;
    if (sm && (sm.status === 'crit' || sm.status === 'warn')) {
      items.push({
        level: sm.status,
        title: t(sm.status === 'crit' ? 'alert.diskCrit' : 'alert.diskWarn', { disk: diskLabel(d) }),
        detail: `${d.model} · ${sm.reasons.join(' · ')}`,
        href: '#/depolama',
      });
    }
  }
  for (const u of s.services?.units ?? []) {
    if (u.active === 'failed') items.push({ level: 'crit', title: t('alert.svcFailed', { name: u.name }), detail: u.description || u.unit, href: '#/servisler' });
  }
  for (const d of s.system?.disks ?? []) {
    if (d.percent >= TH.disk[0]) items.push({ level: d.percent >= TH.disk[1] ? 'crit' : 'warn', title: t('alert.diskFull', { mount: d.mount, p: fmtPct(d.percent) }), detail: t('alert.diskSpace', { size: fmtBytes(d.available) }), href: '#/depolama' });
  }
  for (const g of s.sensors?.groups ?? []) {
    const hot = g.temps.filter((x) => tempLevel(x)).sort((a, b) => b.value - a.value)[0];
    if (hot) items.push({ level: tempLevel(hot), title: `${g.name}: ${num0.format(hot.value)} °C`, detail: t('alert.tempHigh', { label: hot.label }), href: '#/donanim' });
  }
  for (const g of s.gpu?.gpus ?? []) {
    const lvl = level(g.temperature, ...TH.temperature);
    if (lvl) items.push({ level: lvl, title: `${g.name}: ${num0.format(g.temperature)} °C`, detail: t('alert.gpuTemp'), href: '#/ekran-karti' });
  }
  items.sort((a, b) => (a.level === 'crit' ? 0 : 1) - (b.level === 'crit' ? 0 : 1));

  const box = $('alerts');
  box.hidden = !items.length;
  fill(
    box,
    items.map((it) =>
      h(
        'a',
        { class: `alert-row ${it.level}`, href: it.href },
        icon(it.level === 'crit' ? 'crit' : 'warn'),
        h('div', { class: 'alert-text' }, h('strong', null, it.title), h('span', { title: it.detail }, it.detail)),
        h('span', { class: 'alert-go' }, t('common.details')),
      ),
    ),
  );
}

let selectedGpu = null;

function statRow(label, value, meterEl) {
  return h('li', null, h('div', { class: 'row-head' }, h('span', { class: 'row-title' }, label), h('span', { class: 'row-value' }, value)), meterEl);
}

// Sekme etiketleri: tek kartta üretici adı, aynı üreticiden birden fazla kart varsa sıra numarası.
function gpuLabels(gpus) {
  const counts = {};
  for (const g of gpus) counts[g.vendor] = (counts[g.vendor] ?? 0) + 1;
  const seen = {};
  return gpus.map((g) => {
    seen[g.vendor] = (seen[g.vendor] ?? 0) + 1;
    return counts[g.vendor] > 1 ? `${g.vendor} ${seen[g.vendor]}` : g.vendor;
  });
}

function gpuStats(g) {
  if (g.state === 'suspended') {
    return h('p', { class: 'muted small' }, t('gpu.suspended'));
  }
  const tempLevel = level(g.temperature, ...TH.temperature);
  let memoryRow = null;
  if (g.memoryTotal != null) {
    memoryRow = statRow('VRAM', g.memoryUsed == null ? '—' : `${fmtBytes(g.memoryUsed)} / ${fmtBytes(g.memoryTotal)}`, meter(g.memoryPercent));
  } else if (g.sharedMemory) {
    memoryRow = statRow(t('gpu.memory'), t('gpu.shared'));
  }
  return [
    h(
      'ul',
      { class: 'list' },
      memoryRow,
      g.temperature != null
        ? statRow(
            h('span', null, t('gpu.temp'), tempLevel ? ' ' : null, tempLevel ? tag(tempLevel, tempLevel === 'crit' ? 'crit' : 'warn', t(tempLevel === 'crit' ? 'level.crit' : 'level.warn')) : null),
            `${num0.format(g.temperature)} °C`,
            meter(g.temperature, ...TH.temperature),
          )
        : null,
      g.powerDraw != null
        ? statRow(t('gpu.power'), g.powerLimit ? `${num1.format(g.powerDraw)} / ${num0.format(g.powerLimit)} W` : `${num1.format(g.powerDraw)} W`, g.powerLimit ? meter((g.powerDraw / g.powerLimit) * 100, 101, 101) : null)
        : null,
    ),
    h(
      'div',
      { class: 'gpu-facts' },
      g.fan != null ? h('span', null, t('gpu.fan', { v: fmtPct(g.fan) })) : g.fanRpm != null ? h('span', null, `Fan ${num0.format(g.fanRpm)} RPM`) : null,
      g.clock != null || g.clockMax != null ? h('span', null, t('gpu.clock', { cur: g.clock == null ? '—' : num0.format(g.clock), max: g.clockMax ? ` / ${num0.format(g.clockMax)}` : '' })) : null,
      g.memoryUtilization != null ? h('span', null, t('gpu.memBus', { p: fmtPct(g.memoryUtilization) })) : null,
    ),
  ];
}

function gpuProcesses(g) {
  if (g.processes == null) {
    return [h('h3', null, t('gpu.procs')), h('p', { class: 'muted small' }, t('gpu.procsNvidiaOnly'))];
  }
  return [
    h('h3', null, t('gpu.procs')),
    g.processes.length
      ? table(
          [['PID'], [t('gpu.process')], ['VRAM', 'r']],
          g.processes.map((p) =>
            h(
              'tr',
              null,
              h('td', { class: 'mono' }, p.pid),
              h('td', { class: 'cmd', title: p.command }, p.command),
              h('td', { class: 'r' }, h('span', { class: 'bar-cell' }, mini(g.memoryTotal ? (p.memory / g.memoryTotal) * 100 : 0), fmtBytes(p.memory))),
            ),
          ),
        )
      : h('p', { class: 'muted small' }, t('gpu.noProcs')),
  ];
}

function renderGpu(gpu, history, capacity) {
  const card = $('gpu-card');
  const gpus = gpu.gpus ?? [];
  // Kapalıysa ya da sistemde desteklenen kart yoksa kart hiç gösterilmez.
  card.hidden = Boolean(gpu.disabled) || (!gpu.error && !gpus.length);
  $('nav-gpu').hidden = card.hidden;
  if (card.hidden) {
    if (currentRoute() === 'ekran-karti') window.location.replace('#/genel');
    return;
  }
  const body = $('gpu-body');
  const tabs = $('gpu-tabs');
  if (gpu.error) {
    $('gpu-meta').textContent = '';
    renderTabs(tabs, [], null, () => {});
    fill($('gpu-procs'));
    return fill(body, errorBox(gpu.error));
  }
  if (!gpus.some((g) => g.id === selectedGpu)) selectedGpu = gpus[0].id;
  const g = gpus.find((x) => x.id === selectedGpu);
  const labels = gpuLabels(gpus);

  const driver = g.driverVersion ? t('gpu.driverVersion', { v: g.driverVersion }) : t('gpu.driverName', { name: g.driver });
  $('gpu-meta').textContent = gpus.length > 1 ? t('gpu.count', { n: gpus.length, driver }) : driver;
  renderTabs(
    tabs,
    gpus.map((x, i) => ({ id: x.id, label: labels[i], title: x.name })),
    selectedGpu,
    (id) => {
      selectedGpu = id;
      if (lastData) render(lastData);
    },
  );

  gpuChart.set({
    times: history.map((p) => p.t),
    capacity,
    series: [
      { name: t('gpu.util'), key: 's1', color: '--series-1', fill: true, values: history.map((p) => p.gpu?.[g.id]?.[0] ?? null) },
      { name: 'VRAM', key: 's2', color: '--series-2', values: history.map((p) => p.gpu?.[g.id]?.[1] ?? null) },
    ],
  });

  fill(
    body,
    h(
      'div',
      { class: 'gpu-top' },
      h(
        'div',
        null,
        h('div', { class: 'gpu-name' }, g.name),
        h('div', { class: 'muted small' }, [g.vendor, g.pstate ? t('gpu.pstate', { p: g.pstate }) : null, g.sharedMemory ? t('gpu.integrated') : null].filter(Boolean).join(' · ')),
      ),
      h('div', { class: 'gpu-big' }, fmtPct(g.utilization), h('small', null, t(g.utilizationApprox ? 'gpu.usageApprox' : 'gpu.usage'))),
    ),
    gpuStats(g),
    gpu.warning ? h('p', { class: 'card-error' }, icon('warn'), h('span', null, gpu.warning)) : null,
  );
  fill($('gpu-procs'), gpuProcesses(g));
}

// Genel bakıştaki ekran kartı kutucuğu: birden çok kart varsa ilk (genellikle harici) kart gösterilir.
function renderGpuKpi(gpu) {
  const tile = $('kpi-gpu');
  const g = gpu?.gpus?.find((x) => x.state !== 'suspended');
  tile.hidden = !g;
  if (!g) return;
  const sub = g.memoryTotal != null ? `VRAM ${fmtPct(g.memoryPercent)}` : g.temperature != null ? `${num0.format(g.temperature)} °C` : g.vendor;
  const detail = [g.name, g.memoryTotal != null ? `VRAM ${fmtBytes(g.memoryUsed)} / ${fmtBytes(g.memoryTotal)}` : null, g.temperature != null ? `${num0.format(g.temperature)} °C` : null]
    .filter(Boolean)
    .join(' · ');
  setKpi('kpi-gpu', { value: fmtPct(g.utilization), sub, detail, percent: g.utilization, warn: 90, crit: 98, label: t('kpi.gpu', { vendor: g.vendor }) });
}

function setBadge(route, kind, text) {
  const badge = document.querySelector(`[data-badge="${route}"]`);
  if (!badge) return;
  badge.hidden = !text;
  badge.className = `nav-badge ${kind ?? ''}`;
  badge.textContent = text ?? '';
}

// Menüdeki rozetler sorunlu bir şey olduğunda dikkat çeker.
function renderBadges(s) {
  const units = s.services?.units ?? [];
  const failed = units.filter((u) => u.active === 'failed').length;
  const stopped = units.filter((u) => u.active !== 'active').length;
  const exited = (s.docker?.containers ?? []).filter((c) => containerState(c)[0] === 'crit').length;
  if (failed + exited) setBadge('servisler', 'crit', String(failed + exited));
  else if (stopped) setBadge('servisler', 'warn', String(stopped));
  else setBadge('servisler', null, null);

  const disks = (s.system?.disks ?? []).filter((d) => !d.error);
  const fullest = Math.max(0, ...disks.map((d) => d.percent ?? 0));
  const diskLevel = level(fullest, ...TH.disk);
  const smartStates = (s.storage?.devices ?? []).map((d) => d.smart?.status);
  const smartCrit = smartStates.filter((x) => x === 'crit').length;
  const smartWarn = smartStates.filter((x) => x === 'warn').length;
  // SMART sorunu, doluluktan daha önemlidir.
  if (smartCrit) setBadge('depolama', 'crit', String(smartCrit));
  else if (smartWarn) setBadge('depolama', 'warn', String(smartWarn));
  else setBadge('depolama', diskLevel || null, diskLevel ? fmtPct(fullest) : null);

  const hotSensor = (s.sensors?.groups ?? []).flatMap((g) => g.temps).filter((x) => tempLevel(x)).sort((a, b) => b.value - a.value)[0];
  setBadge('donanim', hotSensor ? tempLevel(hotSensor) : null, hotSensor ? `${num0.format(hotSensor.value)} °C` : null);

  const hottest = Math.max(0, ...(s.gpu?.gpus ?? []).map((g) => g.temperature ?? 0));
  const gpuLevel = level(hottest, ...TH.temperature);
  setBadge('ekran-karti', gpuLevel || null, gpuLevel ? `${num0.format(hottest)} °C` : null);

  const zombies = s.processes?.zombie ?? 0;
  setBadge('surecler', zombies ? 'warn' : null, zombies ? String(zombies) : null);
}

// Bir kart hata verirse diğerleri çizilmeye devam eder.
function safely(fn, ...args) {
  try {
    fn(...args);
  } catch (err) {
    console.error(err);
  }
}

let lastData = null;

function renderUser(user) {
  if (!user) return;
  $('avatar').textContent = user.slice(0, 1);
  $('username-label').textContent = user;
  $('menu-user').textContent = user;
}

function render(data) {
  lastData = data;
  if (data.settings?.thresholds) TH = { ...TH, ...data.settings.thresholds };
  const s = data.snapshot;
  if (!s) return;
  const { history, historySize: capacity } = data;

  safely(renderUser, data.user);
  setBadge('ayarlar', data.update ? 'info' : null, data.update ? '1' : null);
  safely(renderHost, s.system, s.system?.cpu?.count);
  if (s.system) {
    safely(renderSystemKpis, s.system, s.sensors);
    safely(renderLoad, s.system, history, capacity);
    safely(renderDisks, s.system);
  }
  if (s.network) {
    safely(renderNetKpi, s.network, history, capacity);
    safely(renderNetwork, s.network, history, capacity);
    safely(renderPorts, s.network);
  }
  if (s.gpu) safely(renderGpu, s.gpu, history, capacity);
  if (s.processes) safely(renderProcesses, s.processes);
  if (s.services) safely(renderServices, s.services);
  if (s.docker) safely(renderDocker, s.docker);
  safely(renderGpuKpi, s.gpu);
  if (s.storage) safely(renderStorage, s.storage, history, capacity);
  if (s.sensors) safely(renderSensors, s.sensors, history, capacity, s.storage);
  safely(renderAlerts, s);
  safely(renderBadges, s);

  const minutes = Math.round((capacity * data.intervalSeconds) / 60);
  $('foot-text').textContent = t('foot.text', { s: data.intervalSeconds, m: minutes });
  for (const el of document.querySelectorAll('[data-x-start]')) el.textContent = t('chart.ago', { m: minutes });
}

// ---------- Ayarlar ----------

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const INTERVAL_CHOICES = [1, 2, 3, 5, 10, 15, 30, 60];
const HISTORY_CHOICES = [5, 10, 15, 30, 60, 120];
const dateTimeFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });

let settingsState = null; // { user, panel, system }
let settingsBuilt = false;
let settingsTimer = null;
// Root yardımcısına giden ve sonucu beklenen istekler
let pendingRequests = [];
const settingsCards = {};

async function api(pathname, body) {
  const init = body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(new URL(pathname, window.location.origin), init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.code === 'no_session') window.location.replace(`/login${window.location.hash}`);
  return { ok: res.ok, status: res.status, data };
}

// --- Form yardımcıları ---

function formRow(label, control, hint) {
  return h('div', { class: 'form-row' }, h('div', { class: 'form-label' }, label, hint ? h('small', null, hint) : null), h('div', { class: 'form-control' }, control));
}

function selectEl(options, value) {
  const el = h('select', { class: 'select' }, options.map(([v, label]) => h('option', { value: String(v) }, label)));
  el.value = String(value);
  return el;
}

// Etiket verilmezse anahtarın yanında durumu (Açık / Kapalı) yazar.
function switchEl(checked, label, ariaLabel) {
  const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': ariaLabel ?? label });
  input.checked = Boolean(checked);
  const text = h('span', null, label ?? '');
  const listeners = [];
  const refresh = () => {
    if (label == null) text.textContent = t(input.checked ? 'set.on' : 'set.off');
    for (const fn of listeners) fn(input.checked);
  };
  input.addEventListener('change', refresh);
  refresh();
  return {
    input,
    el: h('label', { class: 'switch' }, input, h('span', { class: 'track', 'aria-hidden': 'true' }), text),
    set(value) {
      input.checked = Boolean(value);
      refresh();
    },
    onChange(fn) {
      listeners.push(fn);
      fn(input.checked);
    },
  };
}

// Anlık ve geri alınamaz işlemler kaydet düğmesinden ayrı, açıklamalı bir kutuda durur.
function actionBlock(title, desc, actionButton, status) {
  return h('div', { class: 'action-block' }, h('div', null, h('strong', null, title), h('p', null, desc), status.el), actionButton);
}

function inputEl(type, value, attrs = {}) {
  const el = h('input', { type, class: `input ${attrs.class ?? ''}`, ...attrs });
  if (value != null) el.value = String(value);
  return el;
}

function button(label, kind, onClick) {
  const el = h('button', { type: 'button', class: `btn${kind ? ` btn-${kind}` : ''}` }, label);
  el.addEventListener('click', onClick);
  return el;
}

function segEl(options, value, onChange) {
  let current = value;
  const buttons = options.map(([v, label]) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(v === value) }, label);
    b.addEventListener('click', () => {
      current = v;
      for (const x of buttons) x.setAttribute('aria-pressed', String(x === b));
      onChange?.(v);
    });
    return b;
  });
  const el = h('div', { class: 'seg', role: 'group' }, buttons);
  return {
    el,
    get value() {
      return current;
    },
    set(v) {
      current = v;
      buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === v)));
    },
    disable(flag) {
      for (const b of buttons) b.disabled = flag;
    },
  };
}

function saveStatus() {
  const el = h('span', { class: 'save-status', role: 'status' });
  return {
    el,
    set(kind, text) {
      el.className = `save-status ${kind ?? ''}`;
      el.textContent = text ?? '';
    },
  };
}

function settingsCard(titleKey, iconName, desc, ...content) {
  return h('article', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon(iconName), t(titleKey))), desc ? h('p', { class: 'card-desc' }, desc) : null, content);
}

function confirmDialog(title, text, okLabel) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = okLabel;
  $('confirm-cancel').textContent = t('set.cancel');
  dialog.returnValue = '';
  dialog.showModal();
  $('confirm-cancel').focus();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}

// --- Root yardımcısına istek ve sonucunu bekleme ---

const systemBaseline = () => settingsState?.system?.updated ?? 0;

async function sendSystem(pathname, body, status, kind, pendingText) {
  status.set('', pendingText);
  const res = await api(pathname, body);
  if (!res.ok) return status.set('err', t('set.saveFailed'));
  pendingRequests.push({ baseline: systemBaseline(), sentAt: Date.now(), status, kind });
  scheduleSettingsPoll(1500);
}

const saveSystem = (body, status, card) => sendSystem('/api/system', body, status, { type: 'settings', card }, t('set.applying'));
const runAction = (action, status, text) => sendSystem('/api/actions', { action }, status, { type: 'action', action }, text);

function historyMatches(entry, kind) {
  return kind.type === 'settings' ? entry.type === 'settings' || entry.type === 'rejected' : entry.type === 'action' && entry.action === kind.action;
}

const errorText = (code) => (code ? (I18N.DICT[I18N.lang][`hist.err.${code}`] ? t(`hist.err.${code}`) : code) : '');

function resolvePending(sys) {
  pendingRequests = pendingRequests.filter((p) => {
    if (p.kind.action === 'update' && sys.running?.action === 'update') {
      p.status.set('', t('set.updRunning', { ago: fmtAgo(sys.running.startedAt) }));
      return true;
    }
    if (p.kind.action === 'reboot') {
      p.status.set('', t('set.rebooting'));
      return true;
    }
    if ((sys.updated ?? 0) > p.baseline) {
      const entry = (sys.history ?? []).find((e) => e.time > p.baseline && historyMatches(e, p.kind));
      if (entry?.ok === false) p.status.set('err', t('set.applyFailed', { reason: errorText(entry.message) }));
      else p.status.set('ok', p.kind.action === 'refresh' ? t('set.checked') : t('set.applied'));
      if (p.kind.card) settingsCards[p.kind.card]?.sync(sys);
      return false;
    }
    // Yardımcı iki dakika içinde işlemediyse (path birimi kurulu değil ya da durmuş) haber ver.
    if (Date.now() - p.sentAt > 120_000) {
      p.status.set('err', t('set.helperNoResponse'));
      return false;
    }
    return true;
  });
}

// --- Kartlar ---

function buildGeneralCard() {
  const status = saveStatus();
  const lang = segEl(
    [
      ['tr', 'Türkçe'],
      ['en', 'English'],
    ],
    settingsState.panel.language,
    async (v) => {
      status.set('', t('set.saving'));
      const res = await api('/api/settings', { language: v });
      if (res.ok) window.location.reload();
      else status.set('err', t('set.saveFailed'));
    },
  );
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    /* depolama kapalı */
  }
  const theme = segEl(
    [
      ['system', t('set.themeSystem')],
      ['light', t('set.themeLight')],
      ['dark', t('set.themeDark')],
    ],
    stored ?? 'system',
    (v) => {
      applyTheme(v === 'system' ? null : v);
      try {
        if (v === 'system') localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, v);
      } catch {
        /* tercih bu oturumla sınırlı kalır */
      }
      redrawCharts();
    },
  );
  return settingsCard('set.general', 'gear', null, h('div', { class: 'form-rows' }, formRow(t('set.language'), [lang.el, status.el], t('set.languageHint')), formRow(t('set.theme'), theme.el, t('set.themeHint'))));
}

function buildPanelCard() {
  const p = settingsState.panel;
  const interval = selectEl(INTERVAL_CHOICES.map((v) => [v, t('set.seconds', { n: v })]), p.intervalSeconds);
  const history = selectEl(HISTORY_CHOICES.map((v) => [v, t('set.minutes', { n: v })]), p.historyMinutes);
  const inputs = {};
  const thresholdRow = (key, label, unit, max) => {
    const [warn, crit] = p.thresholds[key];
    inputs[key] = [inputEl('number', warn, { class: 'num', min: 1, max }), inputEl('number', crit, { class: 'num', min: 1, max })];
    return formRow(label, [h('span', { class: 'pair' }, t('set.warnAt'), inputs[key][0], unit), h('span', { class: 'pair' }, t('set.critAt'), inputs[key][1], unit)]);
  };
  const textarea = (lines) => {
    const el = h('textarea', { class: 'textarea', rows: '3', spellcheck: 'false' });
    el.value = lines.join('\n');
    return el;
  };
  const hideDisks = textarea(p.hideDisks);
  const hideIfaces = textarea(p.hideInterfaces);
  const status = saveStatus();
  const lines = (el) => el.value.split('\n').map((x) => x.trim()).filter(Boolean);
  const save = button(t('set.save'), 'accent', async () => {
    const thresholds = Object.fromEntries(Object.entries(inputs).map(([k, [w, c]]) => [k, [Number(w.value), Number(c.value)]]));
    if (Object.values(thresholds).some(([w, c]) => !(Number.isInteger(w) && Number.isInteger(c) && w >= 1 && w < c))) return status.set('err', t('set.thresholdOrder'));
    status.set('', t('set.saving'));
    const res = await api('/api/settings', {
      intervalSeconds: Number(interval.value),
      historyMinutes: Number(history.value),
      thresholds,
      hideDisks: lines(hideDisks),
      hideInterfaces: lines(hideIfaces),
    });
    status.set(res.ok ? 'ok' : 'err', res.ok ? t('set.saved') : t('set.saveFailed'));
    if (res.ok) settingsState.panel = res.data.panel;
  });
  return settingsCard(
    'set.panel',
    'sliders',
    t('set.panelDesc'),
    h(
      'div',
      { class: 'form-rows' },
      formRow(t('set.interval'), interval),
      formRow(t('set.history'), history, t('set.historyHint')),
      thresholdRow('cpu', t('set.thCpu'), '%', 100),
      thresholdRow('memory', t('set.thMemory'), '%', 100),
      thresholdRow('disk', t('set.thDisk'), '%', 100),
      thresholdRow('temperature', t('set.thTemp'), '°C', 150),
      formRow(t('set.hideDisks'), hideDisks, t('set.patternHint')),
      formRow(t('set.hideIfaces'), hideIfaces, t('set.patternHint')),
    ),
    h('div', { class: 'form-actions' }, save, status.el),
  );
}

function buildServicesCard() {
  const selected = new Set(settingsState.panel.services);
  const search = inputEl('search', null, { class: 'wide', placeholder: t('set.svcSearch'), 'aria-label': t('set.svcSearch') });
  const list = h('div', { class: 'svc-options' }, placeholder(t('common.loading')));
  const count = h('span', { class: 'muted small' });
  const status = saveStatus();
  let units = [];
  const renderList = () => {
    const q = search.value.trim().toLowerCase();
    // Seçili servisler listenin başında durur.
    const shown = units
      .filter((u) => !q || u.name.toLowerCase().includes(q))
      .sort((a, b) => Number(selected.has(b.name)) - Number(selected.has(a.name)) || a.name.localeCompare(b.name));
    fill(
      list,
      shown.length
        ? shown.map((u) => {
            const box = h('input', { type: 'checkbox' });
            box.checked = selected.has(u.name);
            box.addEventListener('change', () => {
              if (box.checked) selected.add(u.name);
              else selected.delete(u.name);
              count.textContent = t('set.svcSelected', { n: selected.size });
            });
            return h('label', { class: 'svc-option' }, box, h('span', { title: u.name }, u.name), h('small', null, u.state));
          })
        : placeholder(t('set.svcNone')),
    );
    count.textContent = t('set.svcSelected', { n: selected.size });
  };
  search.addEventListener('input', renderList);
  api('/api/services/available').then((res) => {
    if (!res.ok) return fill(list, errorBox(t('set.svcLoadFailed')));
    units = res.data.units;
    for (const name of selected) if (!units.some((u) => u.name === name)) units.push({ name, state: '—' });
    renderList();
  });
  const save = button(t('set.save'), 'accent', async () => {
    status.set('', t('set.saving'));
    const res = await api('/api/settings', { services: [...selected] });
    status.set(res.ok ? 'ok' : 'err', res.ok ? t('set.saved') : t('set.saveFailed'));
  });
  const card = settingsCard('set.services', 'server', t('set.servicesDesc'), h('div', { class: 'svc-picker' }, search, list, count), h('div', { class: 'form-actions' }, save, status.el));
  return card;
}

function helperNotice(sys) {
  if (!sys.available) return h('p', { class: 'notice' }, icon('error'), h('span', null, t('set.helperMissing')));
  return null;
}

function buildUpdatesCard() {
  const box = h('div', { class: 'status-box' });
  const mode = segEl(
    [
      ['off', t('set.updOff')],
      ['security', t('set.updSecurity')],
      ['all', t('set.updAll')],
    ],
    'security',
  );
  const reboot = switchEl(false, t('set.rebootIfNeeded'));
  const rebootTime = inputEl('time', '04:00', { step: 60 });
  const status = saveStatus();
  const log = h('pre', { class: 'log', hidden: true });
  const save = button(t('set.save'), 'accent', () => saveSystem({ updates: mode.value, rebootAfterUpdate: reboot.input.checked, rebootTime: rebootTime.value }, status, 'updates'));
  const check = button(t('set.checkUpdates'), null, () => runAction('refresh', status, t('set.checking')));
  const actionStatus = saveStatus();
  const updateNow = button(t('set.updateNow'), 'danger', async () => {
    if (await confirmDialog(t('set.updateConfirmTitle'), t('set.updateConfirmText'), t('set.updateNow'))) runAction('update', actionStatus, t('set.updateStarted'));
  });
  let autoSupported = false;
  reboot.onChange((on) => {
    rebootTime.disabled = !autoSupported || !on;
  });
  settingsCards.updates = {
    sync(sys) {
      const s = sys.settings ?? {};
      if (s.updates) mode.set(s.updates);
      if (s.rebootTime) rebootTime.value = s.rebootTime;
      reboot.set(s.rebootAfterUpdate);
    },
    update(sys) {
      const pm = sys.platform?.packageManager;
      const auto = sys.available && sys.platform?.autoUpdates;
      autoSupported = Boolean(auto);
      mode.disable(!auto);
      reboot.input.disabled = save.disabled = !auto;
      rebootTime.disabled = !auto || !reboot.input.checked;
      const running = sys.running?.action === 'update';
      check.disabled = updateNow.disabled = !(sys.available && sys.platform?.updateNow) || running;
      const u = sys.updates;
      fill(
        box,
        helperNotice(sys),
        sys.available && !pm ? h('div', { class: 'row' }, t('set.pmUnsupported')) : null,
        sys.available && pm && !auto ? h('div', { class: 'row muted' }, t('set.autoUnsupported', { pm })) : null,
        sys.available && pm
          ? h(
              'div',
              { class: 'row' },
              u?.pending == null ? t('set.updUnknown') : u.pending === 0 ? [tag('ok', 'ok', t('set.updNone'))] : [tag('warn', 'warn', t('set.updPending', { n: u.pending })), u.security ? h('span', null, t('set.updSecurityCount', { n: u.security })) : null],
              u?.rebootRequired ? tag('warn', 'warn', t('set.rebootRequired')) : null,
            )
          : null,
        u?.rebootRequired && u.rebootPackages?.length ? h('div', { class: 'row muted small' }, t('set.rebootPackages', { list: u.rebootPackages.slice(0, 6).join(', ') })) : null,
        u?.lastAutoRun ? h('div', { class: 'row muted small' }, t('set.lastAutoRun', { ago: fmtAgo(u.lastAutoRun) })) : null,
        running ? h('div', { class: 'row' }, tag('info', 'clock', t('set.updRunning', { ago: fmtAgo(sys.running.startedAt) }))) : null,
      );
      const lastUpdate = (sys.history ?? []).find((e) => e.type === 'action' && e.action === 'update');
      log.hidden = !(running || (lastUpdate && Date.now() - lastUpdate.time < 3600_000)) || !sys.updateLog;
      log.textContent = sys.updateLog ?? '';
      if (running) log.scrollTop = log.scrollHeight;
    },
  };
  return settingsCard(
    'set.updates',
    'download',
    null,
    box,
    h('div', { class: 'form-rows' }, formRow(t('set.autoUpdates'), mode.el, t('set.autoUpdatesHint')), formRow(t('set.rebootAfter'), [reboot.el, rebootTime], t('set.rebootAfterHint'))),
    h('div', { class: 'form-actions' }, save, check, status.el),
    actionBlock(t('set.updateNow'), t('set.updateNowDesc'), updateNow, actionStatus),
    log,
  );
}

function buildRebootCard() {
  const box = h('div', { class: 'status-box' });
  const enabled = switchEl(false, null, t('set.scheduledRebootLabel'));
  const day = selectEl([['daily', t('day.daily')], ...WEEKDAYS.map((d) => [d, t(`day.${d}`)])], 'sun');
  const time = inputEl('time', '04:00', { step: 60 });
  const status = saveStatus();
  const actionStatus = saveStatus();
  let available = false;
  enabled.onChange((on) => {
    day.disabled = time.disabled = !available || !on;
  });
  const save = button(t('set.save'), 'accent', () => saveSystem({ scheduledReboot: { enabled: enabled.input.checked, day: day.value, time: time.value } }, status, 'reboot'));
  const rebootNow = button(t('set.rebootNow'), 'danger', async () => {
    if (await confirmDialog(t('set.rebootConfirmTitle', { host: hostName ?? '' }), t('set.rebootConfirmText'), t('set.rebootNow'))) runAction('reboot', actionStatus, t('set.rebootRequested'));
  });
  settingsCards.reboot = {
    sync(sys) {
      const r = sys.settings?.scheduledReboot;
      if (!r) return;
      day.value = r.day;
      time.value = r.time;
      enabled.set(r.enabled);
    },
    update(sys) {
      available = Boolean(sys.available);
      enabled.input.disabled = save.disabled = rebootNow.disabled = !available;
      day.disabled = time.disabled = !available || !enabled.input.checked;
      const r = sys.settings?.scheduledReboot;
      fill(
        box,
        helperNotice(sys),
        sys.available && r ? h('div', { class: 'row' }, r.enabled ? tag('info', 'clock', t('set.rebootScheduled', { day: t(`day.${r.day}`), time: r.time })) : t('set.rebootOff')) : null,
        sys.updates?.rebootRequired ? h('div', { class: 'row' }, tag('warn', 'warn', t('set.rebootRequired'))) : null,
      );
    },
  };
  return settingsCard(
    'set.reboot',
    'power',
    null,
    box,
    h('div', { class: 'form-rows' }, formRow(t('set.scheduledRebootLabel'), enabled.el), formRow(t('set.when'), [day, time], t('set.rebootHint'))),
    h('div', { class: 'form-actions' }, save, status.el),
    actionBlock(t('set.rebootNow'), t('set.rebootNowDesc'), rebootNow, actionStatus),
  );
}

function buildSmartTestsCard() {
  const box = h('div', { class: 'status-box' });
  const enabled = switchEl(false, null, t('set.smartEnabled'));
  const shortDay = selectEl(WEEKDAYS.map((d) => [d, t(`day.${d}`)]), 'sun');
  const longDay = selectEl(Array.from({ length: 28 }, (_, i) => [i + 1, t('set.dayOfMonth', { n: i + 1 })]), 1);
  const time = inputEl('time', '03:00', { step: 60 });
  const status = saveStatus();
  const save = button(t('set.save'), 'accent', () =>
    saveSystem({ smartTests: { enabled: enabled.input.checked, shortDay: shortDay.value, longDay: Number(longDay.value), time: time.value } }, status, 'smart'),
  );
  let supported = false;
  enabled.onChange((on) => {
    shortDay.disabled = longDay.disabled = time.disabled = !supported || !on;
  });
  settingsCards.smart = {
    sync(sys) {
      const s = sys.settings?.smartTests;
      if (!s) return;
      shortDay.value = s.shortDay;
      longDay.value = String(s.longDay);
      time.value = s.time;
      enabled.set(s.enabled);
    },
    update(sys) {
      const ok = sys.available && sys.platform?.smartTests;
      supported = Boolean(ok);
      enabled.input.disabled = save.disabled = !ok;
      shortDay.disabled = longDay.disabled = time.disabled = !ok || !enabled.input.checked;
      fill(box, helperNotice(sys), sys.available && !sys.platform?.smartTests ? h('div', { class: 'row' }, t('set.smartctlMissing')) : null, h('div', { class: 'row muted small' }, t('set.smartHint')));
    },
  };
  return settingsCard(
    'set.smartTitle',
    'disk',
    null,
    box,
    h('div', { class: 'form-rows' }, formRow(t('set.smartEnabled'), enabled.el), formRow(t('set.shortTest'), shortDay, t('set.shortHint')), formRow(t('set.longTest'), longDay, t('set.longHint')), formRow(t('set.testTime'), time)),
    h('div', { class: 'form-actions' }, save, status.el),
  );
}

function buildReportCard() {
  const box = h('div', { class: 'status-box' });
  const enabled = switchEl(false, null, t('rep.enabled'));
  const time = inputEl('time', '07:00', { step: 60 });
  const model = h('select', { class: 'select' });
  const status = saveStatus();
  let current = '';
  let ollama = null;
  const save = button(t('set.save'), 'accent', () => {
    if (enabled.input.checked && !model.value) return status.set('err', t('rep.pickModel'));
    saveSystem({ report: { enabled: enabled.input.checked, time: time.value, model: model.value } }, status, 'report');
  });
  const fillModels = () => {
    const names = (ollama?.models ?? []).map((m) => m.name);
    if (current && !names.includes(current)) names.unshift(current);
    fill(
      model,
      names.length ? names.map((n) => h('option', { value: n }, n)) : h('option', { value: '' }, t('rep.noModels')),
    );
    model.value = current || names.find((n) => /(^|[:/-])\d?\.?\d*b\b/i.test(n) && /(\b|:)[1-8](\.\d)?b/i.test(n)) || names[0] || '';
  };
  const renderBox = () =>
    fill(
      box,
      ollama && !ollama.available ? h('div', { class: 'row' }, icon('warn'), h('span', null, t('rep.ollamaMissing'))) : null,
      h('div', { class: 'row muted small' }, t('rep.hint')),
    );
  enabled.onChange((on) => {
    time.disabled = model.disabled = !on;
  });
  api('/api/ollama/models').then((res) => {
    ollama = res.ok ? res.data : { available: false, models: [] };
    fillModels();
    renderBox();
  });
  settingsCards.report = {
    sync(sys) {
      const r = sys.settings?.report;
      if (!r) return;
      current = r.model ?? '';
      time.value = r.time;
      fillModels();
      enabled.set(r.enabled);
    },
    update(sys) {
      enabled.input.disabled = save.disabled = !sys.available;
      time.disabled = model.disabled = !sys.available || !enabled.input.checked;
      renderBox();
    },
  };
  // Ayarlardan da anlık rapor istenebilir; rapor hazır olunca Raporlar sayfasında görünür.
  const genStatus = saveStatus();
  const generate = button(t('rep.generate'), null, async () => {
    generate.disabled = true;
    const res = await api('/api/actions', { action: 'report' });
    generate.disabled = false;
    if (!res.ok) return genStatus.set('err', t('set.saveFailed'));
    reportsState.waitingSince = Date.now();
    genStatus.set('ok', t('rep.generateStarted'));
  });
  return settingsCard(
    'rep.title',
    'list',
    t('rep.desc'),
    box,
    h(
      'div',
      { class: 'form-rows' },
      formRow(t('rep.enabled'), enabled.el),
      formRow(t('rep.time'), time, t('rep.timeHint')),
      formRow(t('rep.model'), model, t('rep.modelHint')),
      formRow(t('rep.generateNow'), [generate, genStatus.el], t('rep.generateDesc')),
    ),
    h('div', { class: 'form-actions' }, save, status.el),
  );
}

function buildPasswordCard() {
  const current = inputEl('password', '', { class: 'wide', autocomplete: 'current-password' });
  const next = inputEl('password', '', { class: 'wide', autocomplete: 'new-password', minlength: 8 });
  const repeat = inputEl('password', '', { class: 'wide', autocomplete: 'new-password', minlength: 8 });
  const status = saveStatus();
  const change = button(t('set.pwChange'), 'accent', async () => {
    if (next.value.length < 8) return status.set('err', t('set.pwWeak'));
    if (next.value !== repeat.value) return status.set('err', t('set.pwMismatch'));
    status.set('', t('set.saving'));
    const res = await api('/api/password', { current: current.value, next: next.value });
    current.value = next.value = repeat.value = '';
    if (res.ok) return status.set('ok', t('set.pwChanged'));
    if (res.status === 429) return status.set('err', t('set.pwLocked'));
    if (res.data.code === 'bad_password') return status.set('err', t('set.pwWrong'));
    return status.set('err', res.data.code === 'weak_password' ? t('set.pwWeak') : t('set.saveFailed'));
  });
  return settingsCard(
    'set.security',
    'key',
    t('set.securityDesc'),
    h('div', { class: 'form-rows' }, formRow(t('set.pwCurrent'), current), formRow(t('set.pwNew'), next, t('set.pwHint')), formRow(t('set.pwRepeat'), repeat)),
    h('div', { class: 'form-actions' }, change, status.el),
  );
}

function historyText(e) {
  const reason = errorText(e.message);
  if (e.type === 'settings') {
    return e.ok ? t('hist.settingsOk', { what: (e.changes ?? []).map((c) => t(`hist.change.${c}`)).join(', ') }) : t('hist.settingsFail', { reason });
  }
  if (e.type === 'rejected') return t('hist.rejected');
  if (e.type === 'smart-test') return t('hist.smartTest', { kind: t(`hist.test.${e.action}`), n: e.devices?.length ?? 0 });
  if (e.action === 'update') return e.ok ? t('hist.updateOk') : t('hist.updateFail', { reason });
  if (e.action === 'refresh') return t('hist.refresh');
  if (e.action === 'reboot') return t('hist.reboot');
  if (e.action === 'report') return e.ok ? t('hist.report') : t('hist.reportFail', { reason });
  if (e.action === 'self-update') {
    if (!e.ok) return t('hist.selfUpdateFail', { reason });
    return e.upToDate ? t('hist.selfUpdateCurrent', { version: e.version }) : t('hist.selfUpdate', { version: e.version });
  }
  return e.type;
}

function buildHistoryCard() {
  const list = h('ul', { class: 'history' });
  settingsCards.history = {
    sync() {},
    update(sys) {
      const items = sys.history ?? [];
      fill(
        list,
        items.length
          ? items.map((e) => h('li', { class: e.ok === false ? 'fail' : 'ok' }, icon(e.ok === false ? 'crit' : 'ok'), h('span', null, historyText(e)), h('time', null, dateTimeFormat.format(new Date(e.time)))))
          : h('li', { class: 'muted' }, t('set.historyEmpty')),
      );
    },
  };
  const card = settingsCard('set.historyTitle', 'list', t('set.historyDesc'), list);
  return card;
}

// Yalnızca https bağlantıları tıklanabilir yapılır; yeni sekme açılan sayfaya erişemez.
function externalLink(url, label) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return h('span', null, label ?? '—');
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label ?? url.replace(/^https:\/\//, ''));
}

// Hakkında bölümündeki sürüm denetimi satırı.
function updateStatus(u) {
  if (!u?.enabled) return h('span', { class: 'muted' }, t('set.aboutCheckOff'));
  const time = u.checkedAt ? dateTimeFormat.format(new Date(u.checkedAt)) : null;
  if (u.available) return externalLink(u.url, t('set.aboutNewVersion', { version: u.latest }));
  if (!time) return h('span', { class: 'muted' }, t('set.aboutNeverChecked'));
  if (u.error) return h('span', { class: 'muted' }, t('set.aboutCheckFailed', { time }));
  return h('span', null, t('set.aboutUpToDate', { time }));
}

// Kurulum paneli yeniden başlatır: /healthz önce yanıt vermez olur, sonra döner. Döndüğünde sayfa
// yenilenir (oturumlar bellekte tutulduğu için giriş ekranı açılır). Panel hiç kapanmazsa kurulum
// başlamamıştır; ayrıntı işlem geçmişindedir.
function waitForRestart(status, onGiveUp) {
  const started = Date.now();
  let wentDown = false;
  const tick = async () => {
    let up = false;
    try {
      up = (await fetch(new URL('/healthz', window.location.origin), { cache: 'no-store', signal: AbortSignal.timeout(3000) })).ok;
    } catch {
      up = false;
    }
    if (!up) wentDown = true;
    if (up && wentDown) return window.location.reload();
    if (!wentDown && Date.now() - started > 3 * 60_000) {
      status.set('err', t('set.aboutInstallStuck'));
      return onGiveUp();
    }
    if (Date.now() - started > 15 * 60_000) return window.location.reload();
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 2000);
}

function buildAboutCard() {
  const about = settingsState.about ?? {};
  const author = about.author ?? {};
  const updateLine = h('span');
  const updateHint = h('small');
  const checkStatus = saveStatus();
  const render = () => {
    const u = settingsState.about?.update;
    fill(updateLine, updateStatus(u));
    updateHint.textContent = u?.available ? t('set.aboutInstallHint') : t('set.aboutUpdatesHint');
    checkBtn.hidden = !u?.enabled || u?.available;
    installBtn.hidden = !u?.available || !settingsState.system?.available;
    setSettingsBadge('hakkinda', 'info', u?.available ? '1' : null);
  };
  const checkBtn = button(t('set.aboutCheckNow'), null, async () => {
    checkBtn.disabled = true;
    checkStatus.set('', t('set.aboutChecking'));
    const res = await api('/api/update-check', {});
    checkBtn.disabled = false;
    if (!res.ok) return checkStatus.set('err', t('set.saveFailed'));
    settingsState.about.update = res.data;
    checkStatus.set('', '');
    render();
  });
  // Panelden güncelleme: root yardımcısı yeni sürümü GitHub'dan indirip kurar, panel yeniden başlar.
  const installBtn = button(t('set.aboutInstall'), 'accent', async () => {
    const version = settingsState.about.update.latest;
    if (!(await confirmDialog(t('set.aboutInstallTitle', { version }), t('set.aboutInstallText'), t('set.aboutInstall')))) return;
    installBtn.disabled = true;
    checkStatus.set('', t('set.aboutInstalling'));
    const res = await api('/api/actions', { action: 'self-update' });
    if (!res.ok) {
      installBtn.disabled = false;
      return checkStatus.set('err', t('set.saveFailed'));
    }
    waitForRestart(checkStatus, () => (installBtn.disabled = false));
  });
  settingsCards.about = { sync() {}, update: render };
  const updatesRow = h('div', { class: 'form-row' }, h('div', { class: 'form-label' }, t('set.aboutUpdates'), updateHint), h('div', { class: 'form-control' }, updateLine, checkBtn, installBtn, checkStatus.el));
  render();
  return settingsCard(
    'set.about',
    'info',
    t('set.aboutDesc'),
    h(
      'div',
      { class: 'form-rows' },
      formRow(t('set.aboutVersion'), h('span', null, about.version ? `v${about.version}` : '—')),
      updatesRow,
      formRow(t('set.aboutDeveloper'), h('span', null, author.name ?? '—')),
      formRow('GitHub', externalLink(author.url)),
      formRow(t('set.aboutSource'), externalLink(about.homepage)),
      formRow(t('set.aboutLicense'), h('span', null, about.license ? about.license.replaceAll('-', ' ') : '—'), t('set.aboutLicenseHint')),
    ),
  );
}

// Ayarlar bölümleri: [adres, başlık, simge, kartı kuran fonksiyon]
const SETTINGS_SECTIONS = [
  ['genel', 'set.general', 'gear', buildGeneralCard],
  ['panel', 'set.panel', 'sliders', buildPanelCard],
  ['servisler', 'set.services', 'server', buildServicesCard],
  ['guncellemeler', 'set.updates', 'download', buildUpdatesCard],
  ['yeniden-baslatma', 'set.reboot', 'power', buildRebootCard],
  ['disk-testleri', 'set.smartTitle', 'disk', buildSmartTestsCard],
  ['rapor', 'rep.title', 'list', buildReportCard],
  ['guvenlik', 'set.security', 'key', buildPasswordCard],
  ['gecmis', 'set.historyTitle', 'list', buildHistoryCard],
  ['hakkinda', 'set.about', 'info', buildAboutCard],
];

function currentSettingsSection() {
  const sub = window.location.hash.replace(/^#\/?/, '').split('/')[1];
  return SETTINGS_SECTIONS.some(([id]) => id === sub) ? sub : 'genel';
}

function showSettingsSection() {
  if (!settingsBuilt) return;
  const active = currentSettingsSection();
  for (const el of $('settings-root').querySelectorAll('[data-section]')) {
    if (el.tagName === 'BUTTON') el.setAttribute('aria-current', String(el.dataset.section === active));
    else el.hidden = el.dataset.section !== active;
  }
  // Telefonda menü yatay kayar; seçili bölüm görünür kalsın.
  const nav = $('settings-root').querySelector('.settings-nav');
  const button = nav?.querySelector('[aria-current="true"]');
  if (button && nav.scrollWidth > nav.clientWidth) {
    const offset = button.getBoundingClientRect().left - nav.getBoundingClientRect().left;
    nav.scrollTo({ left: nav.scrollLeft + offset - (nav.clientWidth - button.offsetWidth) / 2 });
  }
}

function setSettingsBadge(section, kind, text) {
  const badge = document.querySelector(`[data-settings-badge="${section}"]`);
  if (!badge) return;
  badge.hidden = !text;
  badge.className = `nav-badge ${kind ?? ''}`;
  badge.textContent = text ?? '';
}

function buildSettings() {
  const nav = h('nav', { class: 'settings-nav', 'aria-label': t('nav.settings') });
  const content = h('div', { class: 'settings-content' });
  for (const [id, titleKey, iconName, build] of SETTINGS_SECTIONS) {
    const card = build();
    card.dataset.section = id;
    content.append(card);
    const link = h('button', { type: 'button', 'data-section': id }, icon(iconName), h('span', null, t(titleKey)), h('span', { class: 'nav-badge', 'data-settings-badge': id, hidden: true }));
    link.addEventListener('click', () => {
      window.location.hash = `#/ayarlar/${id}`;
    });
    nav.append(link);
  }
  fill($('settings-root'), nav, content);
  for (const card of Object.values(settingsCards)) card.sync(settingsState.system);
  settingsBuilt = true;
  showSettingsSection();
}

async function loadSettings() {
  try {
    const res = await api('/api/settings');
    if (!res.ok) return;
    settingsState = res.data;
    if (!settingsBuilt) buildSettings();
    resolvePending(settingsState.system);
    for (const card of Object.values(settingsCards)) card.update(settingsState.system);
    const sys = settingsState.system;
    const pending = sys.updates?.pending;
    setSettingsBadge('guncellemeler', sys.available ? 'warn' : 'crit', !sys.available ? '!' : pending ? String(pending) : null);
    setSettingsBadge('yeniden-baslatma', 'warn', sys.updates?.rebootRequired ? '!' : null);
  } catch {
    /* bağlantı sorunu; ana durum göstergesi zaten bildiriyor */
  } finally {
    scheduleSettingsPoll(pendingRequests.length || settingsState?.system?.running ? 2000 : 10_000);
  }
}

function scheduleSettingsPoll(delay) {
  clearTimeout(settingsTimer);
  if (currentRoute() === 'ayarlar' && !document.hidden) settingsTimer = setTimeout(loadSettings, delay);
}

function enterSettings() {
  showSettingsSection();
  loadSettings();
}

function leaveSettings() {
  clearTimeout(settingsTimer);
}

// ---------- Güncelleme döngüsü ----------

// Sayfa http://kullanici:sifre@sunucu/ biçiminde açıldıysa göreli adresler kimlik bilgisini taşır
// ve fetch bunları reddeder; origin kimlik bilgisi içermez.
const STATS_URL = new URL('/api/stats', window.location.origin);

let intervalMs = 3000;
let lastOk = 0;
let pollTimer = null;
let polling = false;

function setStatus(state, text) {
  $('status').className = `live ${state}`;
  $('status-text').textContent = text;
  $('side-pulse').className = `pulse ${state}`;
}

async function poll() {
  if (polling) return;
  polling = true;
  clearTimeout(pollTimer);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 10_000);
  try {
    const res = await fetch(STATS_URL, { cache: 'no-store', signal: abort.signal });
    if (res.status === 401) {
      window.location.replace(`/login${window.location.hash}`); // oturum süresi doldu ya da servis yeniden başladı
      return;
    }
    if (!res.ok) throw new Error(res.status === 429 ? t('status.tooMany') : `HTTP ${res.status}`);
    const data = await res.json();
    intervalMs = Math.max(1, data.intervalSeconds || 3) * 1000;
    lastOk = Date.now();
    render(data);
    setStatus('ok', t('status.live', { time: timeFormat.format(new Date(data.snapshot?.time ?? Date.now())) }));
  } catch (err) {
    const message = err.name === 'AbortError' ? t('status.noResponse') : t('status.connError');
    setStatus(Date.now() - lastOk > intervalMs * 3 ? 'error' : 'warn', message);
  } finally {
    clearTimeout(timeout);
    polling = false;
  }
  if (!document.hidden) pollTimer = setTimeout(poll, intervalMs);
}

// Sekme arka plandayken sunucuya istek atılmaz.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(pollTimer);
    leaveSettings();
  } else {
    poll();
    if (currentRoute() === 'ayarlar') enterSettings();
  }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redrawCharts, 100);
});

for (const button of document.querySelectorAll('#proc-sort button')) {
  button.addEventListener('click', () => {
    procSort = button.dataset.sort;
    for (const b of document.querySelectorAll('#proc-sort button')) b.setAttribute('aria-pressed', String(b === button));
    if (lastData?.snapshot?.processes) safely(renderProcesses, lastData.snapshot.processes);
  });
}

// ---------- Ollama (Ekran kartı sayfası) ----------

let ollamaTimer = null;

async function loadOllama() {
  clearTimeout(ollamaTimer);
  const res = await api('/api/ollama');
  renderOllama(res.ok ? res.data : null);
  if (currentRoute() === 'ekran-karti') ollamaTimer = setTimeout(loadOllama, 5000);
}

function renderOllama(d) {
  const card = $('ollama-card');
  card.hidden = !d?.available;
  if (!d?.available) return;
  $('ollama-meta').textContent = d.version ? `v${d.version}` : '';
  const loadedNames = new Set(d.loaded.map((m) => m.name));
  const loaded = d.loaded.length
    ? h(
        'ul',
        { class: 'oll-loaded' },
        d.loaded.map((m) => {
          const pct = m.size ? Math.round((m.vram / m.size) * 100) : 0;
          const where = pct >= 99 ? t('oll.onGpu') : pct <= 0 ? t('oll.onCpu') : t('oll.split', { pct });
          const left = m.expiresAt ? Math.round((Date.parse(m.expiresAt) - Date.now()) / 1000) : null;
          const unload = button(t('oll.unload'), null, async () => {
            unload.disabled = true;
            await api('/api/ollama/unload', { model: m.name });
            loadOllama();
          });
          const details = [fmtBytes(m.size), where, m.context ? t('oll.context', { n: num0.format(m.context) }) : null, left > 0 && left < 30 * 86400 ? t('oll.expires', { time: fmtDuration(left) }) : null];
          return h('li', null, h('div', null, h('strong', null, m.name), h('span', { class: 'muted small' }, details.filter(Boolean).join(' · '))), unload);
        }),
      )
    : h('p', { class: 'muted' }, t('oll.noneLoaded'));
  const head = [t('oll.cModel'), t('oll.cParams'), t('oll.cQuant'), t('oll.cSize'), t('oll.cModified')];
  const installed = d.installed.length
    ? h(
        'table',
        { class: 'report-table' },
        h('thead', null, h('tr', null, head.map((x) => h('th', null, x)))),
        h(
          'tbody',
          null,
          d.installed.map((m) =>
            h(
              'tr',
              null,
              h('td', null, m.name, loadedNames.has(m.name) ? [' ', tag('ok', 'ok', t('oll.inMemory'))] : null),
              h('td', null, m.parameters ?? '—'),
              h('td', null, m.quantization ?? '—'),
              h('td', { class: 'num' }, m.size ? fmtBytes(m.size) : '—'),
              h('td', null, m.modified ? dateTimeFormat.format(new Date(m.modified)) : '—'),
            ),
          ),
        ),
      )
    : h('p', { class: 'muted' }, t('oll.noneInstalled'));
  fill($('ollama-body'), h('h3', { class: 'oll-sub' }, t('oll.loaded')), loaded, h('h3', { class: 'oll-sub' }, t('oll.installed', { n: d.installed.length })), installed);
}

// ---------- Günlük raporlar ----------

const REPORT_STATUS = { good: ['ok', 'rep.good'], attention: ['warn', 'rep.attention'], critical: ['crit', 'rep.critical'] };
const SEVERITY = { info: ['info', 'ok', 'rep.sevInfo'], warning: ['warn', 'warn', 'rep.sevWarning'], critical: ['crit', 'crit', 'rep.sevCritical'] };
const dayFormat = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });
const shortDayFormat = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', weekday: 'short' });
const reportsState = { list: null, selected: null, waitingSince: null };
let reportsTimer = null;
let reportsBuilt = false;

const reportDate = (date) => new Date(`${date}T12:00:00`);

function factTable(title, head, rows) {
  if (!rows?.length) return null;
  return h(
    'div',
    { class: 'report-section' },
    h('h3', null, title),
    h('table', { class: 'report-table' }, h('thead', null, h('tr', null, head.map(([label]) => h('th', null, label)))), h('tbody', null, rows.map((r) => h('tr', null, head.map(([, key, cls]) => h('td', cls ? { class: cls } : null, r[key] ?? '—')))))),
  );
}

function renderReport(r) {
  const detail = $('report-detail');
  const generate = button(t('rep.generate'), r ? null : 'accent', generateReport);
  generate.disabled = Boolean(reportsState.waitingSince);
  const genStatus = h('span', { class: 'save-status', id: 'report-gen-status' }, reportsState.waitingSince ? t('rep.generating') : '');
  // Henüz rapor yokken de "Şimdi oluştur" görünür.
  if (!r) return fill(detail, h('article', { class: 'card' }, h('div', { class: 'report-head' }, h('h2', null, t('nav.reports')), h('div', { class: 'actions' }, genStatus, generate)), placeholder(t('rep.empty'))));
  const f = r.facts ?? {};
  const st = REPORT_STATUS[r.ai?.status];
  const ai = r.ai
    ? [
        h('p', { class: 'report-summary' }, r.ai.summary),
        r.ai.findings.length
          ? h(
              'ul',
              { class: 'findings' },
              r.ai.findings.map((x) => {
                const [kind, ic, label] = SEVERITY[x.severity] ?? SEVERITY.info;
                return h('li', null, tag(kind, ic, t(label)), h('strong', null, x.title), x.evidence ? h('p', null, x.evidence) : null, x.recommendation ? h('p', null, `${t('rep.recommendation')}: ${x.recommendation}`) : null);
              }),
            )
          : null,
      ]
    : h('div', { class: 'status-box' }, h('div', { class: 'row' }, icon('warn'), h('span', null, Object.hasOwn(window.I18N.DICT[window.I18N.lang] ?? {}, `rep.aiError.${r.aiError}`) ? t(`rep.aiError.${r.aiError}`) : t('rep.aiError.other'))));
  const tiles = [
    [f.totals?.lines, 'rep.fLines'],
    [f.totals?.warnings, 'rep.fWarnings'],
    [f.totals?.errors, 'rep.fErrors'],
    [f.ssh?.failures, 'rep.fSsh'],
    [f.sudoFailures, 'rep.fSudo'],
    [f.boots, 'rep.fBoots'],
    [f.updates?.pending, 'rep.fUpdates'],
  ].filter(([v]) => v != null);
  fill(
    detail,
    h(
      'article',
      { class: 'card' },
      h('div', { class: 'report-head' }, h('h2', null, dayFormat.format(reportDate(r.date))), st ? tag(st[0], st[0], t(st[1])) : null, h('div', { class: 'actions' }, genStatus, generate)),
      h('p', { class: 'muted small' }, t('rep.meta', { model: r.model ?? '—', time: dateTimeFormat.format(new Date(r.createdAt)), seconds: Math.max(1, Math.round((r.durationMs ?? 0) / 1000)) })),
      ai,
      h('div', { class: 'report-section' }, h('h3', null, t('rep.facts')), h('div', { class: 'fact-tiles' }, tiles.map(([v, k]) => h('div', null, h('b', null, num0.format(v)), h('span', null, t(k)))))),
      factTable(t('rep.tFailedUnits'), [[t('rep.cUnit'), 'unit']], (f.failedUnits ?? []).map((unit) => ({ unit }))),
      factTable(t('rep.tServiceFailures'), [[t('rep.cUnit'), 'unit'], [t('rep.cCount'), 'count', 'num']], f.serviceFailures),
      factTable(t('rep.tSshSources'), [[t('rep.cAddress'), 'address'], [t('rep.cCount'), 'count', 'num']], f.ssh?.topSources),
      factTable(t('rep.tSshUsers'), [[t('rep.cUser'), 'user'], [t('rep.cCount'), 'count', 'num']], f.ssh?.topUsers),
      factTable(t('rep.tSshAccepted'), [[t('rep.cLogin'), 'login'], [t('rep.cCount'), 'count', 'num']], f.ssh?.accepted),
      factTable(t('rep.tOom'), [[t('rep.cProcess'), 'process'], [t('rep.cCount'), 'count', 'num']], f.oomKills),
      factTable(t('rep.tDisk'), [[t('rep.cMessage'), 'message', 'sample'], [t('rep.cCount'), 'count', 'num']], f.diskErrors),
      factTable(t('rep.tSmart'), [[t('rep.cDisk'), 'disk']], (f.smartFailing ?? []).map((disk) => ({ disk }))),
      factTable(
        t('rep.tGroups', { n: f.groupCount ?? 0 }),
        [[t('rep.cUnit'), 'unit'], [t('rep.cCount'), 'count', 'num'], [t('rep.cMessage'), 'sample', 'sample']],
        f.groups,
      ),
    ),
  );
}

function renderReportDays() {
  const list = reportsState.list ?? [];
  fill(
    $('report-days'),
    list.length
      ? list.map((x) => {
          const b = h('button', { type: 'button', 'aria-current': String(x.date === reportsState.selected) }, h('span', { class: `dot ${REPORT_STATUS[x.status]?.[0] ?? ''}` }), shortDayFormat.format(reportDate(x.date)));
          b.addEventListener('click', () => showReport(x.date));
          return b;
        })
      : h('p', { class: 'muted small' }, t('rep.noReports')),
  );
}

async function showReport(date) {
  reportsState.selected = date;
  renderReportDays();
  const res = await api(`/api/reports/${date}`);
  renderReport(res.ok ? res.data : null);
}

async function loadReports(prefer) {
  if (!reportsBuilt) {
    fill($('reports-root'), h('nav', { class: 'report-days', id: 'report-days', 'aria-label': t('nav.reports') }), h('div', { id: 'report-detail' }));
    reportsBuilt = true;
  }
  const res = await api('/api/reports');
  if (!res.ok) return;
  reportsState.list = res.data.reports;
  const date = prefer ?? (reportsState.list.some((x) => x.date === reportsState.selected) ? reportsState.selected : reportsState.list[0]?.date);
  if (date) await showReport(date);
  else {
    renderReportDays();
    renderReport(null);
  }
}

// "Şimdi oluştur": root yardımcısı rapor servisini başlatır; yeni rapor gelene kadar liste yoklanır.
async function generateReport() {
  reportsState.waitingSince = Date.now();
  const res = await api('/api/actions', { action: 'report' });
  if (!res.ok) {
    reportsState.waitingSince = null;
    const s = $('report-gen-status');
    if (s) s.textContent = t('set.saveFailed');
    return;
  }
  if (reportsState.list?.length) await showReport(reportsState.selected);
  else renderReport(null);
  pollReports();
}

function pollReports() {
  clearTimeout(reportsTimer);
  if (!reportsState.waitingSince || currentRoute() !== 'raporlar') return;
  reportsTimer = setTimeout(async () => {
    const res = await api('/api/reports');
    const fresh = res.ok && res.data.reports.find((x) => x.createdAt > reportsState.waitingSince);
    if (fresh || Date.now() - reportsState.waitingSince > 15 * 60_000) {
      reportsState.waitingSince = null;
      return loadReports(fresh?.date);
    }
    pollReports();
  }, 5000);
}

function enterReports() {
  loadReports();
  pollReports();
}

function leaveReports() {
  clearTimeout(reportsTimer);
}

// ---------- Uzun süreli geçmiş ----------

const HISTORY_RANGES = [
  ['1d', 'histr.range1d'],
  ['7d', 'histr.range7d'],
  ['30d', 'histr.range30d'],
];
const historyTimeLabel = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const historyState = { range: '1d', data: null, iface: null, gpu: null };
const historyCharts = {};
let historyTimer = null;
let historyBuilt = false;

const avg = (values) => {
  const v = values.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const peak = (values) => {
  const v = values.filter((x) => x != null);
  return v.length ? Math.max(...v) : null;
};

function historyCard(id, titleKey, iconName, legend, options) {
  const canvas = h('canvas', { class: 'chart', tabindex: '0', 'aria-label': t(titleKey) });
  const chart = new LineChart(canvas, { ...options, timeLabel: historyTimeLabel });
  historyCharts[id] = chart;
  allCharts.push(chart);
  const meta = h('span', { class: 'card-meta' });
  const tools = h('div', { class: 'card-tools' });
  let start;
  const card = h(
    'article',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon(iconName), h('span', null, t(titleKey))), meta),
    h('div', { class: 'hist-legend' }, h('div', { class: 'legend' }, legend.map(([key, label]) => h('span', null, h('i', { class: `key ${key}` }), label))), tools),
    h('div', { class: 'chart-wrap' }, canvas),
    h('div', { class: 'chart-x' }, (start = h('span', null, '—')), h('span', null, t('common.now'))),
  );
  return { card, chart, meta, tools, start };
}

function buildHistory() {
  const seg = segEl(
    HISTORY_RANGES.map(([v, k]) => [v, t(k)]),
    historyState.range,
    (v) => {
      historyState.range = v;
      loadHistory();
    },
  );
  const cards = [
    historyCard('load', 'histr.load', 'chip', [['s1', t('histr.cpu')], ['s2', t('histr.mem')]], { max: 100, format: pctAxis }),
    historyCard('temp', 'histr.temp', 'target', [['s1', t('histr.cpuTemp')], ['s2', t('histr.diskTemp')]], { format: (v) => `${num0.format(v)} °C` }),
    historyCard('net', 'histr.net', 'globe', [['s1', t('histr.rx')], ['s2', t('histr.tx')]], { format: fmtRate }),
    historyCard('io', 'histr.io', 'disk', [['s1', t('histr.read')], ['s2', t('histr.write')]], { format: fmtRate }),
    historyCard('gpu', 'histr.gpu', 'chip', [['s1', t('histr.gpuUtil')], ['s2', t('histr.gpuMem')]], { max: 100, format: pctAxis }),
  ];
  historyState.cards = Object.fromEntries(cards.map((c, i) => [['load', 'temp', 'net', 'io', 'gpu'][i], c]));
  fill(
    $('history-root'),
    h('div', { class: 'hist-toolbar' }, seg.el, h('span', { class: 'muted small', id: 'hist-note' })),
    h('div', { class: 'hist-grid' }, cards.map((c) => c.card)),
  );
  historyBuilt = true;
}

async function loadHistory() {
  clearTimeout(historyTimer);
  const res = await api(`/api/history?range=${historyState.range}`);
  if (res.ok) {
    historyState.data = res.data;
    renderHistory();
  } else {
    $('hist-note').textContent = t('histr.error');
  }
  if (currentRoute() === 'gecmis') historyTimer = setTimeout(loadHistory, 60_000);
}

// Ağ ve ekran kartı için seçim kutusu: en çok verisi olan seçenek varsayılandır.
function pickSelect(tools, options, current, onChange) {
  if (options.length < 2) return fill(tools);
  const sel = selectEl(options, current);
  sel.addEventListener('change', () => onChange(sel.value));
  fill(tools, sel);
}

function renderHistory() {
  const { points } = historyState.data;
  const times = points.map((p) => p.t);
  const capacity = points.length;
  const cards = historyState.cards;
  const has = points.some((p) => p.cpu != null);
  $('hist-note').textContent = has ? t('histr.note') : t('histr.empty');
  const set = (id, series) => cards[id].chart.set({ times, capacity, series });
  const startLabel = times.length ? historyTimeLabel.format(new Date(times[0])) : '—';
  for (const c of Object.values(cards)) c.start.textContent = startLabel;
  const summary = (values, format) => (peak(values) == null ? '' : t('histr.summary', { avg: format(avg(values)), max: format(peak(values)) }));

  const cpu = points.map((p) => p.cpu ?? null);
  set('load', [
    { name: t('histr.cpu'), key: 's1', color: '--series-1', fill: true, values: cpu },
    { name: t('histr.mem'), key: 's2', color: '--series-2', values: points.map((p) => p.mem ?? null) },
  ]);
  cards.load.meta.textContent = summary(cpu, fmtPct);

  const cpuTemp = points.map((p) => p.cpuTemp ?? null);
  set('temp', [
    { name: t('histr.cpuTemp'), key: 's1', color: '--series-1', values: cpuTemp },
    { name: t('histr.diskTemp'), key: 's2', color: '--series-2', values: points.map((p) => p.diskTemp ?? null) },
  ]);
  cards.temp.meta.textContent = summary(cpuTemp, (v) => `${num0.format(v)} °C`);

  const traffic = (name) => points.reduce((s, p) => s + (p.net?.[name]?.[0] ?? 0) + (p.net?.[name]?.[1] ?? 0), 0);
  const ifaces = [...new Set(points.flatMap((p) => Object.keys(p.net ?? {})))].sort((a, b) => traffic(b) - traffic(a));
  if (!ifaces.includes(historyState.iface)) historyState.iface = ifaces[0] ?? null;
  pickSelect(cards.net.tools, ifaces.map((n) => [n, n]), historyState.iface, (v) => {
    historyState.iface = v;
    renderHistory();
  });
  const rx = points.map((p) => p.net?.[historyState.iface]?.[0] ?? null);
  set('net', [
    { name: t('histr.rx'), key: 's1', color: '--series-1', fill: true, values: rx },
    { name: t('histr.tx'), key: 's2', color: '--series-2', values: points.map((p) => p.net?.[historyState.iface]?.[1] ?? null) },
  ]);
  cards.net.meta.textContent = summary(rx, fmtRate);

  const total = (p, i) => {
    const values = Object.values(p.io ?? {}).map((v) => v[i]).filter((v) => v != null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const read = points.map((p) => total(p, 0));
  set('io', [
    { name: t('histr.read'), key: 's1', color: '--series-1', fill: true, values: read },
    { name: t('histr.write'), key: 's2', color: '--series-2', values: points.map((p) => total(p, 1)) },
  ]);
  cards.io.meta.textContent = t('histr.allDisks');

  const gpuNames = Object.fromEntries((lastData?.snapshot?.gpu?.gpus ?? []).map((g) => [g.id, g.name]));
  const gpus = [...new Set(points.flatMap((p) => Object.keys(p.gpu ?? {})))];
  const util = (id) => points.filter((p) => p.gpu?.[id]?.[0] != null).length;
  gpus.sort((a, b) => util(b) - util(a));
  cards.gpu.card.hidden = !gpus.length;
  if (!gpus.includes(historyState.gpu)) historyState.gpu = gpus[0] ?? null;
  pickSelect(cards.gpu.tools, gpus.map((id) => [id, gpuNames[id] ?? id]), historyState.gpu, (v) => {
    historyState.gpu = v;
    renderHistory();
  });
  const gpuUtil = points.map((p) => p.gpu?.[historyState.gpu]?.[0] ?? null);
  set('gpu', [
    { name: t('histr.gpuUtil'), key: 's1', color: '--series-1', fill: true, values: gpuUtil },
    { name: t('histr.gpuMem'), key: 's2', color: '--series-2', values: points.map((p) => p.gpu?.[historyState.gpu]?.[1] ?? null) },
  ]);
  const gpuTemp = points.map((p) => p.gpu?.[historyState.gpu]?.[2] ?? null);
  cards.gpu.meta.textContent = peak(gpuTemp) == null ? summary(gpuUtil, fmtPct) : t('histr.gpuTempMax', { max: num0.format(peak(gpuTemp)) });
}

function enterHistory() {
  if (!historyBuilt) buildHistory();
  loadHistory();
}

function leaveHistory() {
  clearTimeout(historyTimer);
}

// ---------- Yapay zekâ: Ollama sohbeti ve modeller ----------

const CHAT_KEY = 'nodestats-chat';
// Bir mesaj için en fazla bu kadar komut turu yapılır; model döngüye girerse durur.
const MAX_TOOL_ROUNDS = 6;
// Modele geri verilen komut çıktısı bu uzunlukta kesilir (bağlam penceresi dolmasın).
const MAX_TOOL_OUTPUT = 6000;
const FINISHED = ['done', 'rejected', 'error'];
const aiState = { info: null, model: null, think: false, exec: false, execAvailable: false, execUser: null, messages: [], streaming: null, bench: {} };
let aiTimer = null;
let aiBuilt = false;
const ai = {};

function loadChat() {
  try {
    const saved = JSON.parse(localStorage.getItem(CHAT_KEY) ?? 'null');
    if (saved && Array.isArray(saved.messages)) {
      aiState.messages = saved.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
      // Sayfa kapanırken onay bekleyen ya da çalışan komutlar yarım kalmıştır.
      for (const m of aiState.messages) for (const c of m.calls ?? []) if (!FINISHED.includes(c.state)) c.state = 'rejected';
      aiState.model = typeof saved.model === 'string' ? saved.model : null;
      aiState.think = saved.think === true;
      aiState.exec = saved.exec === true;
    }
  } catch {
    /* kayıt yoksa boş sohbetle başlanır */
  }
}

function saveChat() {
  try {
    localStorage.setItem(CHAT_KEY, JSON.stringify({ model: aiState.model, think: aiState.think, exec: aiState.exec, messages: aiState.messages.slice(-100) }));
  } catch {
    /* depolama kapalıysa sohbet bu sekmeyle sınırlı kalır */
  }
}

function chatStats(stats) {
  if (!stats?.generateRate) return null;
  return t('ai.stats', { n: num0.format(stats.generated ?? 0), rate: num1.format(stats.generateRate) });
}

// Modelin gördüğü komut sonucu.
function toolText(c) {
  if (c.state === 'rejected') return t('ai.toolRejected');
  if (c.state === 'error' || !c.result) return t('ai.toolFailed');
  const { code, output, truncated, timedOut } = c.result;
  const notes = [timedOut ? t('ai.timedOut') : null, truncated || output.length > MAX_TOOL_OUTPUT ? t('ai.truncated') : null].filter(Boolean);
  return `exit code ${code}${notes.length ? ` (${notes.join(', ')})` : ''}\n${output.slice(0, MAX_TOOL_OUTPUT)}`;
}

// Ekrandaki sohbetten Ollama'ya giden geçmiş: komut çağrıları ve sonuçları dahil, hatalı yanıtlar hariç.
function apiMessages() {
  const out = [];
  for (const m of aiState.messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }
    const done = (m.calls ?? []).filter((c) => FINISHED.includes(c.state));
    if (!m.content && !done.length) continue;
    out.push({ role: 'assistant', content: m.content, ...(done.length && { tool_calls: done.map((c) => ({ function: { name: 'run_command', arguments: { command: c.command } } })) }) });
    for (const c of done) out.push({ role: 'tool', content: toolText(c) });
  }
  return out;
}

const CALL_STATE = {
  auto: ['info', 'list', 'ai.autoRun'],
  approval: ['warn', 'warn', 'ai.needsApproval'],
  running: ['info', 'clock', 'ai.running'],
  rejected: ['', 'off', 'ai.rejected'],
  error: ['crit', 'crit', 'ai.execFailed'],
};

// Şifre istenen sudo komutu: tek parça "sudo komut ..." (panel de aynı kuralı uygular).
const isSudoCommand = (command) => /^sudo\s+[^-\s]/.test(command) && !/[;&><`$(){}\\!*?[\]~|\n\r]/.test(command);

function approvalEl(c) {
  const run = button(t('ai.run'), 'accent', () => c.resolve?.({ approved: true, password: pass?.value ?? null }));
  const reject = button(t('ai.reject'), null, () => c.resolve?.({ approved: false }));
  let pass = null;
  if (/^sudo\s/.test(c.command)) {
    if (!isSudoCommand(c.command)) return h('div', null, errorBox(t('ai.sudoForm')), h('div', { class: 'chat-cmd-actions' }, reject));
    // Yeniden çizimde yazılan şifre kaybolmasın diye alan komutla birlikte bellekte tutulur (kaydedilmez);
    // düğmesi her çizimde yenilendiği için olaylar o anki "Çalıştır" düğmesine bağlanır.
    c.passEl ??= h('input', { type: 'password', class: 'input', autocomplete: 'off', placeholder: t('ai.sudoPassword'), 'aria-label': t('ai.sudoPassword') });
    pass = c.passEl;
    pass.oninput = () => (run.disabled = !pass.value);
    pass.onkeydown = (e) => {
      if (e.key === 'Enter' && pass.value) run.click();
    };
    run.disabled = !pass.value;
  }
  return h(
    'div',
    { class: 'chat-cmd-approve' },
    pass ? h('div', { class: 'muted small' }, t('ai.sudoHint')) : null,
    pass && plainConnection() ? h('p', { class: 'card-error' }, icon('warn'), h('span', null, t('ai.sudoPlain'))) : null,
    h('div', { class: 'chat-cmd-actions' }, pass, run, reject),
  );
}

function callEl(c) {
  let state = CALL_STATE[c.state === 'pending' ? 'auto' : c.state];
  if (c.state === 'done') state = c.result.code === 0 ? ['ok', 'ok', 'ai.done'] : ['crit', 'crit', 'ai.failedCode'];
  const out = c.result
    ? h('details', { class: 'chat-cmd-out', open: c.open === true }, h('summary', null, t('ai.output', { code: c.result.code })), h('pre', null, c.result.output || t('ai.noOutput')))
    : null;
  out?.addEventListener('toggle', () => (c.open = out.open));
  return h(
    'div',
    { class: 'chat-cmd' },
    h('div', { class: 'chat-cmd-head' }, h('code', null, c.command), state ? tag(state[0], state[1], t(state[2], { code: c.result?.code })) : null),
    c.reason ? h('div', { class: 'muted small' }, c.reason) : null,
    c.state === 'approval' ? approvalEl(c) : null,
    c.state === 'error' && c.error ? errorBox(t(EXEC_ERRORS[c.error] ?? 'ai.execFailed')) : null,
    out,
  );
}

function messageEl(m) {
  const body = m.content ? h('div', { class: 'chat-text' }, m.content) : null;
  const thinking = m.thinking ? h('details', { class: 'chat-think' }, h('summary', null, t('ai.thinking')), h('div', { class: 'chat-text' }, m.thinking)) : null;
  const calls = m.calls?.length ? h('div', { class: 'chat-cmds' }, m.calls.map(callEl)) : null;
  const stats = m.stats ? h('div', { class: 'muted small' }, chatStats(m.stats)) : null;
  const error = m.error ? errorBox(t(m.error)) : null;
  return h('div', { class: `chat-msg ${m.role}` }, h('div', { class: 'chat-role' }, m.role === 'user' ? t('ai.you') : m.model ?? t('ai.assistant')), thinking, body, calls, stats, error);
}

function renderChat() {
  const log = ai.log;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  fill(log, aiState.messages.length ? aiState.messages.map(messageEl) : h('p', { class: 'placeholder' }, t('ai.empty')));
  if (nearBottom || aiState.streaming) log.scrollTop = log.scrollHeight;
  ai.send.textContent = t(aiState.streaming ? 'ai.stop' : 'ai.send');
  ai.send.className = `btn ${aiState.streaming ? 'btn-danger' : 'btn-accent'}`;
  ai.input.disabled = Boolean(aiState.streaming);
  ai.clear.disabled = Boolean(aiState.streaming) || !aiState.messages.length;
}

const EXEC_ERRORS = { sudo_form: 'ai.sudoForm', exec_unavailable: 'ai.errExecUnavailable' };
const CHAT_ERRORS = { not_found: 'ai.errNotFound', no_tools: 'ai.errNoTools', exec_unavailable: 'ai.errExecUnavailable' };

// Bir model yanıtını akış olarak okur. Hata ya da durdurma olursa false döner.
async function streamReply(reply, signal) {
  try {
    const res = await fetch(new URL('/api/ollama/chat', window.location.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: reply.model, messages: apiMessages(), think: aiState.think, tools: aiState.exec && aiState.execAvailable }),
      signal,
    });
    if (res.status === 401) return window.location.replace(`/login${window.location.hash}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      reply.error = CHAT_ERRORS[data.code] ?? 'ai.errFailed';
      return false;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.t) reply.content += msg.t;
        if (msg.th) reply.thinking += msg.th;
        if (msg.calls) reply.calls = msg.calls.map((c) => ({ command: c.command, reason: c.reason, auto: c.auto === true, state: 'pending' }));
        if (msg.done) reply.stats = msg.stats;
        if (msg.error) reply.error = 'ai.errFailed';
      }
      renderChat();
    }
  } catch {
    if (signal.aborted) reply.stopped = true;
    else reply.error = 'ai.errFailed';
  }
  if (reply.stopped && reply.content) reply.content += ` ${t('ai.stoppedMark')}`;
  if (!reply.content && !reply.calls && !reply.error) reply.error = reply.stopped ? 'ai.stopped' : 'ai.errFailed';
  return !reply.error && !reply.stopped;
}

// Okuma komutları hemen çalışır; diğerleri "Çalıştır" ya da "Reddet" düğmesini bekler.
async function runCall(c, signal) {
  let password = null;
  if (!c.auto) {
    c.state = 'approval';
    renderChat();
    const decision = await new Promise((resolve) => {
      c.resolve = resolve;
      signal.addEventListener('abort', () => resolve({ approved: false }), { once: true });
    });
    delete c.resolve;
    delete c.passEl;
    if (!decision.approved) {
      c.state = 'rejected';
      return;
    }
    password = decision.password || null;
  }
  c.state = 'running';
  renderChat();
  // Şifre yalnızca bu isteğe eklenir; sohbet kaydına, modele ya da tarayıcı depolamasına girmez.
  const res = await api('/api/ai/exec', { command: c.command, approved: !c.auto, ...(password && { sudoPassword: password }) });
  password = null;
  if (res.ok) {
    c.state = 'done';
    c.result = res.data;
  } else {
    c.state = 'error';
    c.error = res.data.code;
  }
}

async function sendChat() {
  if (aiState.streaming) return aiState.streaming.abort();
  const text = ai.input.value.trim();
  if (!text || !aiState.model) return;
  ai.input.value = '';
  aiState.messages.push({ role: 'user', content: text });
  const controller = new AbortController();
  aiState.streaming = controller;
  renderChat();
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const reply = { role: 'assistant', content: '', thinking: '', model: aiState.model };
      aiState.messages.push(reply);
      if (!(await streamReply(reply, controller.signal)) || !reply.calls?.length) break;
      for (const c of reply.calls) {
        if (controller.signal.aborted) c.state = 'rejected';
        else await runCall(c, controller.signal);
        renderChat();
      }
      if (controller.signal.aborted) break;
    }
  } finally {
    aiState.streaming = null;
    saveChat();
    renderChat();
    ai.input.focus();
  }
}

function updateExecSwitch() {
  if (!ai.exec) return;
  ai.exec.input.disabled = !aiState.execAvailable;
  ai.exec.set(aiState.exec && aiState.execAvailable);
  ai.exec.el.title = aiState.execAvailable ? t('ai.execHint', { user: aiState.execUser ?? '?' }) : t('ai.execUnavailable');
}

function buildAi() {
  loadChat();
  ai.model = h('select', { class: 'select', 'aria-label': t('ai.model') });
  ai.model.addEventListener('change', () => {
    aiState.model = ai.model.value;
    saveChat();
  });
  const think = switchEl(aiState.think, t('ai.think'));
  think.input.addEventListener('change', () => {
    aiState.think = think.input.checked;
    saveChat();
  });
  ai.exec = switchEl(aiState.exec, t('ai.exec'));
  ai.exec.input.addEventListener('change', () => {
    aiState.exec = ai.exec.input.checked;
    saveChat();
  });
  updateExecSwitch();
  ai.clear = button(t('ai.newChat'), null, () => {
    aiState.messages = [];
    saveChat();
    renderChat();
  });
  ai.log = h('div', { class: 'chat-log', 'aria-live': 'polite' });
  ai.input = h('textarea', { class: 'input chat-input', rows: '3', placeholder: t('ai.placeholder'), 'aria-label': t('ai.placeholder') });
  ai.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChat();
    }
  });
  ai.send = button(t('ai.send'), 'accent', sendChat);
  const chatCard = h(
    'article',
    { class: 'card chat-card' },
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('chip'), h('span', null, t('ai.chat'))), h('div', { class: 'chat-tools' }, ai.model, ai.exec.el, think.el, ai.clear)),
    ai.log,
    h('div', { class: 'chat-compose' }, ai.input, ai.send),
  );

  ai.pullInput = inputEl('text', '', { placeholder: t('ai.pullPlaceholder'), 'aria-label': t('ai.pullPlaceholder'), spellcheck: 'false', autocomplete: 'off' });
  ai.pullButton = button(t('ai.pull'), 'accent', startPull);
  ai.pullInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startPull();
  });
  ai.pullStatus = h('div', { class: 'pull-status' });
  ai.models = h('div');
  const modelsCard = h(
    'article',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('download'), h('span', null, t('ai.models'))), (ai.meta = h('span', { class: 'card-meta' }))),
    h('div', { class: 'pull-row' }, ai.pullInput, ai.pullButton),
    h('p', { class: 'muted small' }, t('ai.pullHint')),
    ai.pullStatus,
    ai.models,
  );
  fill($('ai-root'), h('div', { class: 'ai-grid' }, chatCard, modelsCard));
  aiBuilt = true;
  renderChat();
}

async function startPull() {
  const model = ai.pullInput.value.trim();
  if (!model) return;
  ai.pullButton.disabled = true;
  const res = await api('/api/ollama/pull', { model });
  ai.pullButton.disabled = false;
  if (res.ok) ai.pullInput.value = '';
  else fill(ai.pullStatus, errorBox(t(res.data.code === 'busy' ? 'ai.pullBusy' : 'ai.pullInvalid')));
  loadAi();
}

function renderPull(p) {
  if (!p) return fill(ai.pullStatus);
  const recent = p.done && Date.now() - p.finishedAt > 10 * 60_000;
  if (recent) return fill(ai.pullStatus);
  const pct = p.total ? Math.round((p.completed / p.total) * 100) : null;
  const head = h('div', { class: 'pull-head' }, h('strong', null, p.model), h('span', { class: 'muted small' }, p.done ? '' : pct != null ? `${pct}% · ${fmtBytes(p.completed)} / ${fmtBytes(p.total)}` : p.status));
  if (p.done) {
    const ok = !p.error;
    return fill(ai.pullStatus, head, ok ? tag('ok', 'ok', t('ai.pullDone')) : errorBox(t(`ai.pullErr.${['not_found', 'cancelled', 'stalled'].includes(p.error) ? p.error : 'other'}`)));
  }
  const cancel = button(t('ai.cancel'), null, async () => {
    cancel.disabled = true;
    await api('/api/ollama/pull/cancel', {});
    loadAi();
  });
  fill(ai.pullStatus, head, meter(pct ?? 0, 101, 101), h('div', { class: 'pull-actions' }, cancel));
}

function renderModels(d) {
  ai.meta.textContent = d.version ? `Ollama v${d.version}` : 'Ollama';
  const names = d.installed.map((m) => m.name);
  const current = aiState.model && names.includes(aiState.model) ? aiState.model : (d.loaded[0]?.name ?? names[0] ?? null);
  if (current !== aiState.model || ai.model.options.length !== names.length) {
    aiState.model = current;
    fill(ai.model, names.length ? names.map((n) => h('option', { value: n }, n)) : h('option', { value: '' }, t('ai.noModels')));
    ai.model.value = current ?? '';
  }
  ai.send.disabled = !current && !aiState.streaming;
  const loaded = new Set(d.loaded.map((m) => m.name));
  if (!d.installed.length) return fill(ai.models, h('p', { class: 'muted' }, t('oll.noneInstalled')));
  fill(
    ai.models,
    h(
      'ul',
      { class: 'model-list' },
      d.installed.map((m) => {
        const bench = aiState.bench[m.name];
        const benchBtn = button(t('ai.bench'), null, async () => {
          aiState.bench[m.name] = { running: true };
          renderModels(d);
          const res = await api('/api/ollama/bench', { model: m.name });
          aiState.bench[m.name] = res.ok ? res.data : { error: true };
          renderModels(aiState.info);
        });
        benchBtn.disabled = Boolean(bench?.running);
        const del = button(t('ai.delete'), 'danger', async () => {
          if (!(await confirmDialog(t('ai.deleteTitle', { model: m.name }), t('ai.deleteText'), t('ai.delete')))) return;
          del.disabled = true;
          await api('/api/ollama/delete', { model: m.name });
          loadAi();
        });
        const info = [m.parameters, m.quantization, m.size ? fmtBytes(m.size) : null].filter(Boolean).join(' · ');
        let benchText = null;
        if (bench?.running) benchText = h('div', { class: 'muted small' }, t('ai.benchRunning'));
        else if (bench?.error) benchText = errorBox(t('ai.benchFailed'));
        else if (bench) {
          benchText = h(
            'div',
            { class: 'bench' },
            h('span', null, h('strong', null, num1.format(bench.generateRate ?? 0)), ` ${t('ai.tokPerSec')}`),
            h('span', { class: 'muted small' }, t('ai.benchDetail', { prompt: num0.format(bench.promptRate ?? 0), load: num1.format((bench.loadMs ?? 0) / 1000) })),
          );
        }
        return h(
          'li',
          null,
          h('div', { class: 'model-main' }, h('div', null, h('strong', null, m.name), loaded.has(m.name) ? [' ', tag('ok', 'ok', t('oll.inMemory'))] : null, h('div', { class: 'muted small' }, info)), h('div', { class: 'model-actions' }, benchBtn, del)),
          benchText,
        );
      }),
    ),
  );
}

async function loadAi() {
  clearTimeout(aiTimer);
  const [res, term] = await Promise.all([api('/api/ollama'), api('/api/terminal')]);
  const d = res.ok ? res.data : null;
  aiState.execAvailable = term.ok && term.data.execAvailable === true;
  aiState.execUser = term.ok ? term.data.user : null;
  updateExecSwitch();
  if (!d?.available) {
    fill($('ai-root'), h('article', { class: 'card' }, errorBox(t('ai.unavailable'))));
    aiBuilt = false;
  } else {
    if (!aiBuilt) buildAi();
    aiState.info = d;
    renderModels(d);
    renderPull(d.pull);
  }
  const pulling = d?.pull && !d.pull.done;
  if (currentRoute() === 'yapay-zeka') aiTimer = setTimeout(loadAi, pulling ? 1500 : 10_000);
}

function enterAi() {
  loadAi();
}

function leaveAi() {
  clearTimeout(aiTimer);
}

// ---------- Terminal ----------

let terminalTimer = null;
let terminalFrame = null;

// Şifrelenmemiş bağlantı uyarısı: Tailscale (100.64.0.0/10) ve bu makine kendi içinde güvenli sayılır.
function plainConnection() {
  if (window.location.protocol === 'https:') return false;
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return false;
  const m = /^100\.(\d+)\./.exec(host);
  return !(m && Number(m[1]) >= 64 && Number(m[1]) <= 127);
}

async function loadTerminal() {
  clearTimeout(terminalTimer);
  const [term, settings] = await Promise.all([api('/api/terminal'), api('/api/settings')]);
  const system = settings.ok ? settings.data.system : null;
  const configured = system?.settings?.terminal ?? { enabled: false, user: '' };
  const root = $('terminal-root');
  if (term.data.available) {
    if (!terminalFrame) {
      terminalFrame = h('iframe', { class: 'term-frame', src: '/terminal', title: t('term.title') });
    }
    const disable = button(t('term.disable'), 'danger', async () => {
      if (!(await confirmDialog(t('term.disableTitle'), t('term.disableText'), t('term.disable')))) return;
      disable.disabled = true;
      await api('/api/system', { terminal: { enabled: false, user: configured.user } });
      terminalFrame?.remove();
      terminalFrame = null;
      terminalTimer = setTimeout(loadTerminal, 3000);
    });
    if (!root.contains(terminalFrame)) {
      fill(
        root,
        h(
          'article',
          { class: 'card term-card' },
          h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('kernel'), h('span', null, t('term.title'))), h('span', { class: 'card-meta' }, configured.user ? t('term.user', { user: configured.user }) : '')),
          plainConnection() ? h('p', { class: 'card-error' }, icon('warn'), h('span', null, t('term.plainWarning'))) : null,
          terminalFrame,
          h('div', { class: 'term-foot' }, h('span', { class: 'muted small' }, t('term.idleHint', { m: term.data.idleMinutes })), disable),
        ),
      );
    }
    return;
  }
  terminalFrame = null;
  const users = system?.platform?.terminalUsers ?? [];
  const supported = system?.platform?.terminal === true;
  const waiting = configured.enabled;
  const userSel = selectEl(users.map((u) => [u, u]), users.includes(configured.user) ? configured.user : users[0] ?? '');
  const status = h('p', { class: 'muted small' });
  const enable = button(t('term.enable'), 'accent', async () => {
    enable.disabled = true;
    status.textContent = t('term.enabling');
    const res = await api('/api/system', { terminal: { enabled: true, user: userSel.value } });
    if (!res.ok) {
      enable.disabled = false;
      status.textContent = t('term.enableFailed');
      return;
    }
    terminalTimer = setTimeout(loadTerminal, 2000);
  });
  enable.disabled = !supported || !users.length;
  fill(
    root,
    h(
      'article',
      { class: 'card term-setup' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('kernel'), h('span', null, t('term.title')))),
      h('p', null, t('term.intro')),
      !system ? errorBox(t('term.noHelper')) : !supported ? errorBox(t('term.unsupported')) : null,
      h('div', { class: 'form-rows' }, formRow(t('term.userLabel'), userSel, t('term.userHint'))),
      h('div', { class: 'form-actions' }, enable),
      waiting ? h('p', { class: 'muted small' }, t('term.enabling')) : status,
    ),
  );
  if (waiting && currentRoute() === 'terminal') terminalTimer = setTimeout(loadTerminal, 2000);
}

function enterTerminal() {
  loadTerminal();
}

function leaveTerminal() {
  clearTimeout(terminalTimer);
}

// ---------- Bölümler ve sol menü ----------

const ROUTES = {
  genel: t('nav.overview'),
  gecmis: t('nav.history'),
  'ekran-karti': t('nav.gpu'),
  depolama: t('nav.storage'),
  ag: t('nav.network'),
  donanim: t('nav.hardware'),
  surecler: t('nav.processes'),
  servisler: t('nav.services'),
  terminal: t('nav.terminal'),
  'yapay-zeka': t('nav.ai'),
  raporlar: t('nav.reports'),
  ayarlar: t('nav.settings'),
};
let hostName = null;

function currentRoute() {
  const route = window.location.hash.replace(/^#\/?/, '').split('/')[0];
  return Object.hasOwn(ROUTES, route) ? route : 'genel';
}

function updateTitle() {
  const page = ROUTES[currentRoute()];
  document.title = hostName ? `${page} · ${hostName}` : `${page} · ${t('app.name')}`;
}

const sidebar = $('sidebar');
const backdrop = $('sidebar-backdrop');
const menuToggle = $('menu-toggle');

function setSidebar(open) {
  sidebar.classList.toggle('open', open);
  backdrop.hidden = !open;
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', t(open ? 'menu.close' : 'menu.open'));
}

function applyRoute() {
  const route = currentRoute();
  document.body.dataset.route = route;
  $('page-title').textContent = ROUTES[route];
  for (const link of document.querySelectorAll('.nav-item')) {
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  updateTitle();
  setSidebar(false);
  if (route === 'ayarlar') enterSettings();
  else leaveSettings();
  if (route === 'raporlar') enterReports();
  else leaveReports();
  if (route === 'ekran-karti') loadOllama();
  else clearTimeout(ollamaTimer);
  if (route === 'gecmis') enterHistory();
  else leaveHistory();
  if (route === 'yapay-zeka') enterAi();
  else leaveAi();
  if (route === 'terminal') enterTerminal();
  else leaveTerminal();
  window.scrollTo(0, 0);
  // Gizliyken genişliği sıfır olan grafikler görünür olunca yeniden çizilir.
  requestAnimationFrame(redrawCharts);
}

window.addEventListener('hashchange', applyRoute);
menuToggle.addEventListener('click', () => setSidebar(!sidebar.classList.contains('open')));
backdrop.addEventListener('click', () => setSidebar(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && sidebar.classList.contains('open')) {
    setSidebar(false);
    menuToggle.focus();
  }
});
applyRoute();

// ---------- Kullanıcı menüsü ----------

const userButton = $('user-button');
const dropdown = $('user-dropdown');

function toggleMenu(open) {
  dropdown.hidden = !open;
  userButton.setAttribute('aria-expanded', String(open));
  if (open) $('logout').focus();
}

userButton.addEventListener('click', () => toggleMenu(dropdown.hidden));
document.addEventListener('click', (event) => {
  if (!dropdown.hidden && !event.target.closest('.user-menu')) toggleMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !dropdown.hidden) {
    toggleMenu(false);
    userButton.focus();
  }
});

$('logout').addEventListener('click', async () => {
  try {
    await fetch(new URL('/logout', window.location.origin), { method: 'POST' });
  } catch {
    /* sunucuya ulaşılamasa da giriş ekranına dönülür */
  }
  window.location.replace('/login');
});

// ---------- Tema ----------

const THEME_KEY = 'serverhealth-theme';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

try {
  applyTheme(localStorage.getItem(THEME_KEY));
} catch {
  /* depolama kapalıysa sistem teması kullanılır */
}

$('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme ?? (darkQuery.matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* tercih bu oturumla sınırlı kalır */
  }
  redrawCharts();
});
darkQuery.addEventListener('change', redrawCharts);

poll();
