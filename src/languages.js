export const LANGUAGE_NAMES_EN = { tr: 'Turkish', en: 'English', de: 'German', es: 'Spanish', fr: 'French', ru: 'Russian' };
export const LOCALES = { tr: 'tr-TR', en: 'en-US', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', ru: 'ru-RU' };

export function promptFor(prompts, language) {
  if (prompts[language]) return prompts[language];
  const name = LANGUAGE_NAMES_EN[language];
  return name ? [...prompts.en, `- Write every text value of your answer in ${name}.`] : prompts.tr;
}
