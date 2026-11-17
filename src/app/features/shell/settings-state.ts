import { inject, Injectable, signal } from '@angular/core';
import { Effect } from 'effect';
import type { SidebarLayout } from '../../../shared/settings/settings.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';

const getSidebarLayout = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return (yield* api['Settings.get']()).sidebarLayout;
});

/** Shared shell state for Settings: whether the Settings page is open and the active Sidebar layout. */
@Injectable({ providedIn: 'root' })
export class SettingsState {
  private readonly runtime = inject(EffectRuntime);
  private readonly _open = signal(false);
  private readonly _sidebarLayout = signal<SidebarLayout>('oneProject');

  readonly open = this._open.asReadonly();
  readonly sidebarLayout = this._sidebarLayout.asReadonly();

  constructor() {
    void this.loadLayout();
  }

  show(): void {
    this._open.set(true);
  }

  set(open: boolean): void {
    this._open.set(open);
  }

  sidebarLayoutChanged(layout: SidebarLayout): void {
    this._sidebarLayout.set(layout);
  }

  /** Keeps the default layout when Settings cannot be read. */
  private async loadLayout(): Promise<void> {
    const exit = await this.runtime.run(getSidebarLayout);
    if (exit._tag === 'Success') this._sidebarLayout.set(exit.value);
  }
}
