// Languages the user can talk in, and the text-to-speech voices for each.
import { config, LANGUAGES } from './config.mjs';

export { LANGUAGES };
export const LANGUAGE_NAMES = { en: 'English', tr: 'Turkish' };
export const LOCALES = { en: 'en-US', tr: 'tr-TR' };
// Neural (edge-tts) voices per language; the first one is the default.
export const VOICES = { en: ['en-US-AvaNeural', 'en-US-AndrewNeural'], tr: ['tr-TR-EmelNeural', 'tr-TR-AhmetNeural'] };

// A supported language code, or the configured default.
export const pickLang = (lang, fallback = config.defaultLanguage) => (LANGUAGES.includes(lang) ? lang : fallback);

// 'local' (macOS `say`), a neural voice of this language, or this language's default voice.
export function pickVoice(lang, voice) {
  lang = pickLang(lang);
  if (voice === 'local') return 'local';
  return VOICES[lang].includes(voice) ? voice : VOICES[lang][0];
}
