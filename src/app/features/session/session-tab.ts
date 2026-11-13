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
import { Tabs, type Tab } from '../../core/tabs';
import { SessionView } from './session-view';

const createSession = Effect.fnUntraced(function* (projectId: ProjectId) {
  const api = yield* DesktopApi;
  return yield* api['Session.create']({ projectId });
});

/** What a Tab shows: its Session starting, failed to start, or ready to follow. */
type State =
  | { readonly status: 'starting' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly id: SessionId };

type TabState = State & {
  readonly tabId: string;
  readonly session: SessionId | null;
};

const matchesTab = (state: TabState, tab: Tab): boolean => {
  if (state.tabId !== tab.id) return false;
  if (state.session === tab.session) return true;
  // Keeping a draft promotes tab.session to the existing ready session id; keep SessionView mounted.
  return state.status === 'ready' && tab.session === state.id;
};

/** The Session main started for each draft Tab: one per Tab, created the first time the Tab is shown. */
@Injectable({ providedIn: 'root' })
export class DraftSessions {
  private readonly runtime = inject(EffectRuntime);
  private readonly created = new Map<string, Promise<SessionId | null>>();
  /** The Sessions started here: main has them open, so they can be followed and prompted. */
  private readonly started = new Set<SessionId>();

  /**
   * What the Tab shows. A draft's Session is created now. A kept Session (restored or opened from the sidebar) is
   * already known to main; following it connects it if it has no ACP session yet.
   */
  async stateOf(tab: Tab): Promise<State> {
    if (tab.session !== null) return { status: 'ready', id: tab.session };
    if (tab.draftSession !== undefined) return { status: 'ready', id: tab.draftSession };
    const id = await this.sessionOf(tab);
    return id === null ? { status: 'failed' } : { status: 'ready', id };
  }

  private sessionOf(tab: Tab): Promise<SessionId | null> {
    const known = this.created.get(tab.id);
    if (known !== undefined) return known;
    const creating = this.runtime
      .run(createSession(tab.projectId))
      .then((exit) => (Exit.isSuccess(exit) ? exit.value : null));
    this.created.set(tab.id, creating);
    void creating.then((id) => {
      // A failed start is tried again the next time the Tab is shown.
      if (id === null) this.created.delete(tab.id);
      else this.started.add(id);
    });
    return creating;
  }
}

/** The active Tab's Session view; for a draft, the Session main starts for it. */
@Component({
  selector: 'app-session-tab',
  imports: [SessionView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (viewState().status) {
      @case ('starting') {
        <p class="text-muted-foreground mt-4 text-sm" data-testid="session-starting" i18n>
          Starting the Session…
        </p>
      }
      @case ('failed') {
        <p class="text-destructive mt-4 text-sm" data-testid="session-failed" i18n>
          Could not start a Session.
        </p>
      }
    }
    @for (id of ids(); track id) {
      <app-session-view
        class="mt-6"
        [sessionId]="id"
        [projectId]="tab().projectId"
        (messageSent)="keep($event)"
      />
    }
  `,
})
export class SessionTab {
  private readonly drafts = inject(DraftSessions);
  private readonly tabs = inject(Tabs);

  readonly tab = input.required<Tab>();

  protected readonly state = signal<TabState>({ tabId: '', session: null, status: 'starting' });

  /** Which Session to show: changes only with the Tab or its Session, not when the Tab's title does. */
  private readonly shown = computed(() => this.tab(), {
    equal: (a, b) => a.id === b.id && a.session === b.session,
  });

  protected readonly viewState = computed((): State => {
    const tab = this.shown();
    const current = this.state();
    return matchesTab(current, tab) ? current : { status: 'starting' };
  });

  constructor() {
    effect(() => {
      const tab = this.shown();
      untracked(() => void this.show(tab));
    });
  }

  /** The view is rebuilt when the Session changes, so one Session's thread never shows in another's Tab. */
  protected ids(): ReadonlyArray<SessionId> {
    const state = this.viewState();
    return state.status === 'ready' ? [state.id] : [];
  }

  protected keep(id: SessionId): void {
    this.tabs.keep(this.tab().id, id);
  }

  private async show(tab: Tab): Promise<void> {
    const current = untracked(() => this.state());
    if (current.status === 'ready' && matchesTab(current, tab)) return;
    this.state.set({ tabId: tab.id, session: tab.session, status: 'starting' });
    const state = await this.drafts.stateOf(tab);
    if (this.shown() !== tab) return;
    if (state.status === 'ready' && tab.session === null && tab.draftSession === undefined) {
      this.tabs.attachDraft(tab.id, state.id);
    }
    this.state.set({ tabId: tab.id, session: tab.session, ...state });
  }
}
