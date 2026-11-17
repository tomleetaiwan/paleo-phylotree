import { en } from "./locales/en.ts";

export type MessageKey = keyof typeof en;
export type Messages = { [Key in MessageKey]: string };

// Source-language keys are also the Traditional Chinese translations.
const zhHant = Object.fromEntries(Object.keys(en).map(key => [key, key])) as Messages;
export const locales = {
  "zh-Hant": { messages: zhHant, matches: (tag: string) => /^zh(?:-|$)/i.test(tag) },
  en: { messages: en, matches: (tag: string) => /^en(?:-|$)/i.test(tag) }
} satisfies Record<string, { messages: Messages; matches: (tag: string) => boolean }>;
export type Locale = keyof typeof locales;

export function resolveLocale(languages: readonly string[], language = ""): Locale {
  const primary = (languages.find(tag => tag.trim()) ?? language).trim().replaceAll("_", "-");
  for (const locale of Object.keys(locales) as Locale[]) {
    if (locales[locale].matches(primary)) return locale;
  }
  return "en";
}

export function createTranslator(locale: Locale) {
  return (key: MessageKey, ...values: (string | number)[]): string => {
    const message = locales[locale].messages[key];
    return message.replace(/\{(\d+)\}/g, (_, index: string) => {
      if (Number(index) >= values.length) throw new Error(`Missing translation argument ${index}: ${key}`);
      return String(values[Number(index)]);
    });
  };
}

let translate = createTranslator("en");
export function setLocale(locale: Locale): void {
  translate = createTranslator(locale);
}
export function t(key: MessageKey, ...values: (string | number)[]): string {
  return translate(key, ...values);
}

export function localizeDocument(doc: Document, locale: Locale): void {
  setLocale(locale);
  doc.documentElement.lang = locale;
  const attributes = ["aria-label", "placeholder", "title"] as const;
  const message = (key: string) => {
    if (!Object.hasOwn(en, key)) throw new Error(`Unknown interface translation key: ${key}`);
    return t(key as MessageKey);
  };
  for (const el of doc.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = message(el.dataset.i18n!);
  }
  for (const attribute of attributes) {
    for (const el of doc.querySelectorAll(`[data-i18n-${attribute}]`)) {
      el.setAttribute(attribute, message(el.getAttribute(`data-i18n-${attribute}`)!));
    }
  }
}
