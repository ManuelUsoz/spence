/**
 * Resident mode: with hosting on, Spence keeps running (and serving) after its last window closes, on every OS, with
 * a tray (menu-bar on macOS) item to open it again or quit. Hosting off keeps the usual behaviour. Closing a window
 * never asks; only an explicit Quit does.
 */
export interface ResidentInputs {
  readonly platform: NodeJS.Platform;
  /** Whether this Device serves other Devices now. */
  readonly hosting: boolean;
}

/** What closing the window does: just close it, or quit the app (which may ask first). */
export const onWindowClose = ({ platform, hosting }: ResidentInputs): 'close' | 'quit' =>
  platform === 'darwin' || hosting ? 'close' : 'quit';

/** What happens once no window is left: the process stays (resident, or macOS's dock) or quits. */
export const afterLastWindow = ({ platform, hosting }: ResidentInputs): 'stay' | 'quit' =>
  platform === 'darwin' || hosting ? 'stay' : 'quit';

/** The tray item exists only while hosting with no window open. */
export const showsTray = ({
  hosting,
  windows,
}: {
  readonly hosting: boolean;
  readonly windows: number;
}): boolean => hosting && windows === 0;
