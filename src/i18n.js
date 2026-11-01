// Sunucunun ürettiği ve arayüzde görünen metinler (SMART gerekçeleri, sensör adları, hata iletileri).
// Dil, panel ayarlarından gelir; varsayılan Türkçe.
import { MESSAGES } from './messages.js';

let language = 'tr';

export function setLanguage(lang) {
  language = MESSAGES[lang] ? lang : 'tr';
}

export const getLanguage = () => language;

// t('smart.pending', { n: 2 }) -> "2 bekleyen (okunamayan) sektör"
export function t(key, params = {}) {
  const template = MESSAGES[language][key] ?? MESSAGES.tr[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    const v = params[name];
    return typeof v === 'number' ? v.toLocaleString(language === 'tr' ? 'tr-TR' : 'en-US') : String(v ?? '');
  });
}
