import { Injectable, InjectionToken, signal, type Type } from '@angular/core';
import type { SessionId } from '../../shared/sessions/sessions.rpc';
import type { Tab } from './tabs';

/**
 * Whether the open Session's Changes view replaces its thread. Shared by the shell (Panel header button, back header,
 * what the main area shows) and the Changes feature.
 */
@Injectable({ providedIn: 'root' })
export class ChangesState {
  private readonly _open = signal(false);

  readonly open = this._open.asReadonly();

  show(): void {
    this._open.set(true);
  }

  set(open: boolean): void {
    this._open.set(open);
  }
}

/**
 * The component that shows a Session's Changes, taking the Session's id as its `sessionId` input. Features never
 * import each other, so the shell renders whatever `app.config.ts` provides here.
 */
export const CHANGES_VIEW = new InjectionToken<Type<unknown> | null>('CHANGES_VIEW', {
  providedIn: 'root',
  factory: () => null,
});

/** The Session whose Changes a Tab can show; a draft that main has not started yet has none. */
export const changesSessionOf = (tab: Tab): SessionId | null =>
  tab.session ?? tab.draftSession ?? null;
