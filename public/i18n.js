'use strict';

(() => {
  const DICT = window.I18N_DICT ?? {};
  const NAMES = { tr: 'Türkçe', en: 'English', de: 'Deutsch', es: 'Español', fr: 'Français', ru: 'Русский' };
  const LOCALES = { tr: 'tr-TR', en: 'en-US', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', ru: 'ru-RU' };
  const wanted = document.documentElement.lang;
  const lang = DICT[wanted] ? wanted : DICT.tr ? 'tr' : 'en';
  const locale = LOCALES[lang] ?? 'en-US';

  function t(key, vars = {}) {
    const template = DICT[lang]?.[key] ?? DICT.en?.[key] ?? DICT.tr?.[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_, name) => (vars[name] == null ? '' : String(vars[name])));
  }

  function apply(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const attr of ['title', 'aria-label', 'placeholder']) {
      for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
    }
  }

  window.I18N = { lang, locale, t, apply, DICT, NAMES, LANGUAGES: Object.keys(NAMES) };
  apply();
})();
