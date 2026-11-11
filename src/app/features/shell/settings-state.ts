import { Injectable, signal } from '@angular/core';

/** Whether the settings modal is open, so the sidebar can open it and the shell can host it. */
@Injectable({ providedIn: 'root' })
export class SettingsState {
  private readonly _open = signal(false);
  readonly open = this._open.asReadonly();

  show(): void {
    this._open.set(true);
  }

  set(open: boolean): void {
    this._open.set(open);
  }
}
