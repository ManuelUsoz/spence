import type { Locale } from './locale';

/** The native confirm shown when quitting would stop Sessions that are still working. */
export interface QuitConfirm {
  readonly message: string;
  /** `[quit, cancel]`: the quit button is the first (index 0). */
  readonly buttons: readonly [string, string];
}

/**
 * The quit confirm's text in `locale`, for `working` Sessions with a running Turn. Main has no `$localize`, so its few
 * native strings are written here per Locale.
 */
export const quitConfirm = (locale: Locale, working: number): QuitConfirm => {
  switch (locale) {
    case 'en':
      return {
        message:
          working === 1
            ? '1 Session is still working. Quit anyway?'
            : `${working} Sessions are still working. Quit anyway?`,
        buttons: ['Quit', 'Cancel'],
      };
    case 'es':
      return {
        message:
          working === 1
            ? '1 sesión sigue trabajando. ¿Salir de todos modos?'
            : `${working} sesiones siguen trabajando. ¿Salir de todos modos?`,
        buttons: ['Salir', 'Cancelar'],
      };
  }
};
