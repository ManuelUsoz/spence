import { describe, expect, it } from 'vitest';
import { e2eLocale, pickLocale } from './locale';

describe('pickLocale', () => {
  it('uses English when nothing is known', () => {
    expect(pickLocale({ override: undefined, systemLanguages: [] })).toBe('en');
  });

  it.each(['es', 'es-ES', 'es-AR', 'es-419', 'ES-mx'])(
    'uses Spanish for the system language %s',
    (lang) => {
      expect(pickLocale({ override: undefined, systemLanguages: [lang] })).toBe('es');
    },
  );

  it('follows the most preferred language that has a build', () => {
    expect(pickLocale({ override: undefined, systemLanguages: ['en-US', 'es-ES'] })).toBe('en');
    expect(pickLocale({ override: undefined, systemLanguages: ['fr-FR', 'es-ES', 'en'] })).toBe(
      'es',
    );
    expect(pickLocale({ override: undefined, systemLanguages: ['fr-FR', 'de'] })).toBe('en');
  });

  it('prefers the stored override over the system languages', () => {
    expect(pickLocale({ override: 'en', systemLanguages: ['es-ES'] })).toBe('en');
    expect(pickLocale({ override: 'es', systemLanguages: ['en-US'] })).toBe('es');
  });
});

describe('e2eLocale', () => {
  it('pins the locale from SPENCE_LOCALE in an e2e run', () => {
    expect(e2eLocale({ SPENCE_E2E: '1', SPENCE_LOCALE: 'es' })).toBe('es');
    expect(e2eLocale({ SPENCE_E2E: '1', SPENCE_LOCALE: 'en' })).toBe('en');
  });

  it('ignores SPENCE_LOCALE outside e2e runs', () => {
    expect(e2eLocale({ SPENCE_LOCALE: 'es' })).toBeUndefined();
  });

  it('ignores locales that have no build', () => {
    expect(e2eLocale({ SPENCE_E2E: '1', SPENCE_LOCALE: 'fr' })).toBeUndefined();
    expect(e2eLocale({ SPENCE_E2E: '1' })).toBeUndefined();
  });
});
