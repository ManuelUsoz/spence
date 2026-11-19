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
import type { PanelId } from '../../../shared/tabs/tabs.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { Tabs, type Tab } from '../../core/tabs';
import { SessionView } from './session-view';

const createSession = Effect.fnUntraced(function* (projectId: ProjectId) {
  const api = yield* DesktopApi;
  return yield* api['Session.create']({ projectId });
});

/** What a Panel shows: its Session starting, failed to start, or ready to follow. */
type State =
  | { readonly status: 'starting' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly id: SessionId };

type PanelState = State & {
  readonly panelId: PanelId | '';
  readonly session: SessionId | null;
};

const matchesPanel = (state: PanelState, tab: Tab): boolean => {
  if (state.panelId !== tab.panelId) return false;
  if (state.session === tab.session) return true;
  // Keeping a draft promotes tab.session to the existing ready session id; keep SessionView mounted.
  return state.status === 'ready' && tab.session === state.id;
};

/** The Session main started for each draft Panel: one per Panel, created the first time the Panel is shown. */
@Injectable({ providedIn: 'root' })
export class DraftSessions {
  private readonly runtime = inject(EffectRuntime);
  private readonly created = new Map<PanelId, Promise<SessionId | null>>();
  /** The Sessions started here: main has them open, so they can be followed and prompted. */
  private readonly started = new Set<SessionId>();

  /**
   * What the Panel shows. A draft's Session is created now (keyed by `PanelId`). A kept Session (restored or opened
   * from the sidebar) is already known to main; following it connects it if it has no ACP session yet.
   */
  async stateOf(tab: Tab): Promise<State> {
    if (tab.session !== null) return { status: 'ready', id: tab.session };
    if (tab.draftSession !== undefined) return { status: 'ready', id: tab.draftSession };
    const id = await this.sessionOf(tab);
    return id === null ? { status: 'failed' } : { status: 'ready', id };
  }

  private sessionOf(tab: Tab): Promise<SessionId | null> {
    const known = this.created.get(tab.panelId);
    if (known !== undefined) return known;
    const creating = this.runtime
      .run(createSession(tab.projectId))
      .then((exit) => (Exit.isSuccess(exit) ? exit.value : null));
    this.created.set(tab.panelId, creating);
    void creating.then((id) => {
      // A failed start is tried again the next time the Panel is shown.
      if (id === null) this.created.delete(tab.panelId);
      else this.started.add(id);
    });
    return creating;
  }
}

/** The active Panel's Session view; for a draft, the Session main starts for it. */
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
        [projectName]="projectName()"
        (messageSent)="keep($event)"
      />
    }
  `,
})
export class SessionTab {
  private readonly drafts = inject(DraftSessions);
  private readonly tabs = inject(Tabs);

  readonly tab = input.required<Tab>();
  readonly projectName = input('');

  protected readonly state = signal<PanelState>({ panelId: '', session: null, status: 'starting' });

  /** Which Session to show: changes only with the Panel or its Session, not when its title does. */
  private readonly shown = computed(() => this.tab(), {
    equal: (a, b) => a.panelId === b.panelId && a.session === b.session,
  });

  protected readonly viewState = computed((): State => {
    const tab = this.shown();
    const current = this.state();
    return matchesPanel(current, tab) ? current : { status: 'starting' };
  });

  constructor() {
    effect(() => {
      const tab = this.shown();
      untracked(() => void this.show(tab));
    });
  }

  /** The view is rebuilt when the Session changes, so one Session's thread never shows in another's Panel. */
  protected ids(): ReadonlyArray<SessionId> {
    const state = this.viewState();
    return state.status === 'ready' ? [state.id] : [];
  }

  protected keep(id: SessionId): void {
    this.tabs.keep(this.tab().panelId, id);
  }

  private async show(tab: Tab): Promise<void> {
    const current = untracked(() => this.state());
    if (current.status === 'ready' && matchesPanel(current, tab)) return;
    this.state.set({ panelId: tab.panelId, session: tab.session, status: 'starting' });
    const state = await this.drafts.stateOf(tab);
    if (this.shown() !== tab) return;
    if (state.status === 'ready' && tab.session === null && tab.draftSession === undefined) {
      this.tabs.attachDraft(tab.panelId, state.id);
    }
    this.state.set({ panelId: tab.panelId, session: tab.session, ...state });
  }
}
