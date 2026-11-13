import type { Locale } from './locale';

export interface MenuCopy {
  readonly settings: string;
}

const EN: MenuCopy = {
  settings: 'Settings…',
};

const ES: MenuCopy = {
  settings: 'Configuración…',
};

/** Localized macOS application menu strings. */
export const menuCopy = (locale: Locale): MenuCopy => (locale === 'es' ? ES : EN);
