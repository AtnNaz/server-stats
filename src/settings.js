import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { UNIT_NAME } from './collectors/services.js';
import { parseHash } from './auth.js';

// Arayüzden değiştirilen panel ayarları. config.json'daki değerlerin üzerine yazılır ve
// servis kullanıcısının yazabildiği durum klasöründe (/var/lib/serverhealth-panel) saklanır.

export const LANGUAGES = ['tr', 'en'];
export const INTERVALS = [1, 2, 3, 5, 10, 15, 30, 60];
export const HISTORY_MINUTES = [5, 10, 15, 30, 60, 120];
export const DEFAULT_THRESHOLDS = { disk: [85, 95], memory: [85, 95], cpu: [80, 95], temperature: [80, 90] };

const isPair = (v, max) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 1 && n <= max) && v[0] < v[1];
const isPatternList = (v) => Array.isArray(v) && v.length <= 50 && v.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 200 && !/[\0\n]/.test(s));

// Yalnızca bilinen alanlar kabul edilir; bilinmeyen alan istek hatasıdır.
export function validatePanelSettings(input) {
  const errors = [];
  const value = {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { errors: ['invalid'], value };
  for (const [key, v] of Object.entries(input)) {
    switch (key) {
      case 'language':
        if (LANGUAGES.includes(v)) value.language = v;
        else errors.push('language');
        break;
      case 'intervalSeconds':
        if (INTERVALS.includes(v)) value.intervalSeconds = v;
        else errors.push('intervalSeconds');
        break;
      case 'historyMinutes':
        if (HISTORY_MINUTES.includes(v)) value.historyMinutes = v;
        else errors.push('historyMinutes');
        break;
      case 'thresholds': {
        const t = {};
        const limits = { disk: 100, memory: 100, cpu: 100, temperature: 150 };
        if (v === null || typeof v !== 'object') {
          errors.push('thresholds');
          break;
        }
        for (const [name, pair] of Object.entries(v)) {
          if (limits[name] && isPair(pair, limits[name])) t[name] = pair;
          else errors.push(`thresholds.${name}`);
        }
        value.thresholds = t;
        break;
      }
      case 'services':
        if (Array.isArray(v) && v.length <= 100 && v.every((s) => typeof s === 'string' && UNIT_NAME.test(s) && s.length <= 128)) value.services = [...new Set(v)];
        else errors.push('services');
        break;
      case 'hideDisks':
      case 'hideInterfaces':
        if (isPatternList(v)) value[key] = v;
        else errors.push(key);
        break;
      default:
        errors.push(key);
    }
  }
  return { errors, value };
}

export function createSettingsStore(stateDir) {
  const file = path.join(stateDir, 'settings.json');
  let data = {};
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* henüz ayar kaydedilmemiş */
  }

  async function save() {
    await mkdir(stateDir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  return {
    get: () => structuredClone(data),
    async update(patch) {
      data = { ...data, ...patch, thresholds: { ...data.thresholds, ...patch.thresholds } };
      if (!Object.keys(data.thresholds).length) delete data.thresholds;
      await save();
      return structuredClone(data);
    },
    async setPasswordHash(hash) {
      if (!parseHash(hash)) throw new Error('invalid hash');
      data = { ...data, passwordHash: hash };
      await save();
    },
  };
}

// config.json + arayüz ayarları = çalışan yapılandırma
export function effectiveConfig(config, settings) {
  return {
    ...config,
    language: settings.language ?? config.language ?? 'tr',
    intervalSeconds: settings.intervalSeconds ?? config.intervalSeconds,
    historyMinutes: settings.historyMinutes ?? config.historyMinutes,
    services: settings.services ?? config.services,
    thresholds: { ...DEFAULT_THRESHOLDS, ...settings.thresholds },
    auth: { ...config.auth, ...(settings.passwordHash && { passwordHash: settings.passwordHash }) },
    disks: { ...config.disks, ...(settings.hideDisks && { hide: settings.hideDisks }) },
    network: { ...config.network, ...(settings.hideInterfaces && { hideInterfaces: settings.hideInterfaces }) },
  };
}

// Panelin arayüze gönderdiği ayarlar (şifre hash'i asla gönderilmez).
export function publicSettings(effective) {
  return {
    language: effective.language,
    intervalSeconds: effective.intervalSeconds,
    historyMinutes: effective.historyMinutes,
    thresholds: effective.thresholds,
    services: effective.services,
    hideDisks: effective.disks.hide,
    hideInterfaces: effective.network.hideInterfaces,
  };
}
