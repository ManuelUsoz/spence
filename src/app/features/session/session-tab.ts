import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  Injectable,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Effect, Exit } from 'effect';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import type { Tab } from '../../core/tabs';
import { SessionView } from './session-view';

const createSession = Effect.fnUntraced(function* (projectId: ProjectId) {
  const api = yield* DesktopApi;
  return yield* api['Session.create']({ projectId });
});

/** The Session main started for each draft Tab: one per Tab, created the first time the Tab is shown. */
@Injectable({ providedIn: 'root' })
export class DraftSessions {
  private readonly runtime = inject(EffectRuntime);
  private readonly created = new Map<string, Promise<SessionId | null>>();

  /** The Tab's Session; a draft's is created now (main starts its Agent at once). `null` when that failed. */
  sessionOf(tab: Tab): Promise<SessionId | null> {
    if (tab.session !== null) return Promise.resolve(tab.session);
    const known = this.created.get(tab.id);
    if (known !== undefined) return known;
    const creating = this.runtime
      .run(createSession(tab.projectId))
      .then((exit) => (Exit.isSuccess(exit) ? exit.value : null));
    this.created.set(tab.id, creating);
    // A failed start is tried again the next time the Tab is shown.
    void creating.then((id) => {
      if (id === null) this.created.delete(tab.id);
    });
    return creating;
  }
}

type State =
  | { readonly status: 'starting' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly id: SessionId };

/** The active Tab's Session view; for a draft, the Session main starts for it. */
@Component({
  selector: 'app-session-tab',
  imports: [SessionView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (state().status) {
      @case ('failed') {
        <p class="text-destructive mt-4 text-sm" data-testid="session-failed" i18n>
          Could not start a Session.
        </p>
      }
    }
    @for (id of ids(); track id) {
      <app-session-view class="mt-6" [sessionId]="id" />
    }
  `,
})
export class SessionTab {
  private readonly drafts = inject(DraftSessions);

  readonly tab = input.required<Tab>();

  protected readonly state = signal<State>({ status: 'starting' });

  /** Which Session to show: changes only with the Tab or its Session, not when the Tab's title does. */
  private readonly shown = computed(() => this.tab(), {
    equal: (a, b) => a.id === b.id && a.session === b.session,
  });

  constructor() {
    effect(() => {
      const tab = this.shown();
      untracked(() => void this.show(tab));
    });
  }

  /** The view is rebuilt when the Session changes, so one Session's thread never shows in another's Tab. */
  protected ids(): ReadonlyArray<SessionId> {
    const state = this.state();
    return state.status === 'ready' ? [state.id] : [];
  }

  private async show(tab: Tab): Promise<void> {
    this.state.set({ status: 'starting' });
    const id = await this.drafts.sessionOf(tab);
    if (this.shown() !== tab) return;
    this.state.set(id === null ? { status: 'failed' } : { status: 'ready', id });
  }
}
