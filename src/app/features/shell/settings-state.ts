import { Injectable, signal } from '@angular/core';

/** Shared shell state for Settings: whether the Settings page is open. */
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
