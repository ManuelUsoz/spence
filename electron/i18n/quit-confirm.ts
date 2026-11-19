import type { Locale } from './locale';

/** The native confirm shown when quitting would stop running Turns; a host also says whom it would drop. */
export interface QuitConfirm {
  readonly message: string;
  /** `[quit, cancel]`: the quit button is the first (index 0). */
  readonly buttons: readonly [string, string];
}

/** What quitting would stop: every running Turn on this Device (Remote-started ones too) and the connected viewers. */
export interface QuitStakes {
  /** Sessions with a running Turn on this Device. */
  readonly working: number;
  /** Remote devices connected to this Device now (0 when it does not host). */
  readonly viewers: number;
}

const english = ({ working, viewers }: QuitStakes): string => {
  const sessions =
    working === 1 ? '1 Session is still working' : `${working} Sessions are still working`;
  const devices =
    viewers === 1
      ? '1 Remote device is connected to this Device'
      : `${viewers} Remote devices are connected to this Device`;
  return `${sessions}${viewers > 0 ? ` and ${devices}` : ''}. Quit anyway?`;
};

const spanish = ({ working, viewers }: QuitStakes): string => {
  const sessions =
    working === 1 ? '1 sesión sigue trabajando' : `${working} sesiones siguen trabajando`;
  const devices =
    viewers === 1
      ? '1 Dispositivo remoto está conectado a este Dispositivo'
      : `${viewers} Dispositivos remotos están conectados a este Dispositivo`;
  return `${sessions}${viewers > 0 ? ` y ${devices}` : ''}. ¿Salir de todos modos?`;
};

/**
 * The quit confirm's text in `locale`, or `null` when no Turn runs: quitting then asks nothing, even with Remote
 * devices connected (they lose no work; a Turn they started is counted in `working`). Main has no `$localize`, so its
 * few native strings are written here per Locale.
 */
export const quitConfirm = (locale: Locale, stakes: QuitStakes): QuitConfirm | null => {
  if (stakes.working === 0) return null;
  switch (locale) {
    case 'en':
      return { message: english(stakes), buttons: ['Quit', 'Cancel'] };
    case 'es':
      return { message: spanish(stakes), buttons: ['Salir', 'Cancelar'] };
  }
};
