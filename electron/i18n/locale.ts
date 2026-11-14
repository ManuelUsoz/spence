/** The renderer is built once per locale (`dist/renderer/<locale>/`); English is the source. */
export const LOCALES = ['en', 'es'] as const;
export type Locale = (typeof LOCALES)[number];

export interface LocaleInputs {
  /** The user's stored choice, if any (the Language Setting). */
  readonly override: Locale | undefined;
  /** `app.getPreferredSystemLanguages()`: BCP 47 tags, most preferred first. */
  readonly systemLanguages: readonly string[];
}

const isLocale = (value: string | undefined): value is Locale =>
  LOCALES.some((locale) => locale === value);

/** Maps a BCP 47 tag (`es-AR`, `en-US`, `es`) to a locale we ship, by its language subtag only. */
const fromLanguageTag = (tag: string): Locale | undefined => {
  const language = tag.split(/[-_]/)[0]?.toLowerCase();
  return isLocale(language) ? language : undefined;
};

/**
 * Decides which renderer build to load: the override, else the most preferred system language
 * that has a build (`es*` -> `es`, `en*` -> `en`), else English.
 */
export const pickLocale = ({ override, systemLanguages }: LocaleInputs): Locale => {
  if (override) return override;
  for (const tag of systemLanguages) {
    const locale = fromLanguageTag(tag);
    if (locale) return locale;
  }
  return 'en';
};

/**
 * The locale an e2e run pins with `SPENCE_LOCALE`, so screenshots do not depend on the OS language.
 * Read only when `SPENCE_E2E=1`; a normal launch never honours it.
 */
export const e2eLocale = (
  env: Readonly<Record<string, string | undefined>>,
): Locale | undefined => {
  if (env['SPENCE_E2E'] !== '1') return undefined;
  const locale = env['SPENCE_LOCALE'];
  return isLocale(locale) ? locale : undefined;
};

let cachedSystemLanguages: readonly string[] = [];

/** Records `app.getPreferredSystemLanguages()` once Electron is ready so domain services stay Electron-free. */
export const setSystemLanguages = (languages: readonly string[]): void => {
  cachedSystemLanguages = languages;
};

/**
 * Resolves the active locale for main-owned user-facing copy from `SPENCE_LOCALE` (in e2e),
 * the Language Setting (`'en' | 'es' | 'system'`), and the cached OS preferred languages.
 */
export const resolveLocale = (
  language: 'system' | Locale,
  env: Readonly<Record<string, string | undefined>> = process.env,
  systemLanguages: readonly string[] = cachedSystemLanguages,
): Locale =>
  e2eLocale(env) ??
  pickLocale({
    override: language === 'system' ? undefined : language,
    systemLanguages,
  });
