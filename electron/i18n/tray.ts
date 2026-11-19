import type { Locale } from './locale';

/** The tray (menu-bar on macOS) item a hosting Device shows while no window is open. */
export interface TrayCopy {
  readonly open: string;
  /** One line: how many Remote devices are connected to this Device now. */
  readonly status: string;
  readonly quit: string;
}

/** The tray menu's text in `locale` while `serving` Remote devices are connected. Hand-written: main has no `$localize`. */
export const trayCopy = (locale: Locale, serving: number): TrayCopy => {
  switch (locale) {
    case 'en':
      return {
        open: 'Open Spence',
        status: serving === 1 ? 'Serving 1 Remote device' : `Serving ${serving} Remote devices`,
        quit: 'Quit',
      };
    case 'es':
      return {
        open: 'Abrir Spence',
        status:
          serving === 1
            ? 'Sirviendo a 1 Dispositivo remoto'
            : `Sirviendo a ${serving} Dispositivos remotos`,
        quit: 'Salir',
      };
  }
};
