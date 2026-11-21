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
import type { PaneId, PanelId, WorkspacePanel } from '../../../shared/tabs/tabs.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { Tabs } from '../../core/tabs';
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
  readonly sessionId: SessionId | undefined;
};

const panelSessionId = (panel: WorkspacePanel): SessionId | undefined =>
  panel.spec._tag === 'Session' ? panel.spec.sessionId : undefined;

const matchesPanel = (state: PanelState, panel: WorkspacePanel): boolean => {
  if (state.panelId !== panel.id) return false;
  const nextSessionId = panelSessionId(panel);
  if (state.sessionId === nextSessionId) return true;
  // Attaching or promoting a draft moves panel.spec.sessionId to state.id; keep SessionView mounted.
  return state.status === 'ready' && nextSessionId === state.id;
};

/** The Session main started for each draft Panel: one per Panel, created the first time the Panel is shown. */
@Injectable({ providedIn: 'root' })
export class DraftSessions {
  private readonly runtime = inject(EffectRuntime);
  private readonly created = new Map<PanelId, Promise<SessionId | null>>();

  /**
   * What the Panel shows. A draft's Session is created now (keyed by `PanelId`). A kept Session (restored or opened
   * from the sidebar) is already known to main; following it connects it if it has no ACP session yet.
   */
  async stateOf(panel: WorkspacePanel, projectId: ProjectId): Promise<State> {
    if (panel.spec._tag !== 'Session') return { status: 'failed' };
    if (panel.spec.sessionId !== undefined) return { status: 'ready', id: panel.spec.sessionId };
    const id = await this.sessionOf(panel.id, projectId);
    return id === null ? { status: 'failed' } : { status: 'ready', id };
  }

  private sessionOf(panelId: PanelId, projectId: ProjectId): Promise<SessionId | null> {
    const known = this.created.get(panelId);
    if (known !== undefined) return known;
    const creating = this.runtime
      .run(createSession(projectId))
      .then((exit) => (Exit.isSuccess(exit) ? exit.value : null));
    this.created.set(panelId, creating);
    void creating.then((id) => {
      // A failed start is tried again the next time the Panel is shown.
      if (id === null) this.created.delete(panelId);
    });
    return creating;
  }
}

/** One `Session` Panel's view (local, Worker, or Remote); for a draft, starts its Session on first display. */
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
        [paneId]="paneId()"
        [projectId]="projectId()"
        [projectName]="projectName()"
        [focused]="focused()"
        (messageSent)="keep($event)"
      />
    }
  `,
})
export class SessionTab {
  private readonly drafts = inject(DraftSessions);
  private readonly tabs = inject(Tabs);

  readonly panel = input.required<WorkspacePanel>();
  readonly paneId = input<PaneId | null>(null);
  readonly projectId = input.required<ProjectId>();
  readonly projectName = input('');
  readonly focused = input(true);

  protected readonly state = signal<PanelState>({
    panelId: '',
    sessionId: undefined,
    status: 'starting',
  });

  /** Which Session to show: changes only with the Panel, Project, or bound SessionId. */
  private readonly shown = computed(() => ({ panel: this.panel(), projectId: this.projectId() }), {
    equal: (a, b) =>
      a.panel.id === b.panel.id &&
      a.projectId === b.projectId &&
      panelSessionId(a.panel) === panelSessionId(b.panel),
  });

  protected readonly viewState = computed((): State => {
    const { panel } = this.shown();
    const current = this.state();
    return matchesPanel(current, panel) ? current : { status: 'starting' };
  });

  constructor() {
    effect(() => {
      const target = this.shown();
      untracked(() => void this.show(target));
    });
  }

  /** The view is rebuilt when the Session changes, so one Session's thread never shows in another's Panel. */
  protected ids(): ReadonlyArray<SessionId> {
    const state = this.viewState();
    return state.status === 'ready' ? [state.id] : [];
  }

  protected keep(id: SessionId): void {
    this.tabs.keep(this.panel().id, id);
  }

  private async show(target: {
    readonly panel: WorkspacePanel;
    readonly projectId: ProjectId;
  }): Promise<void> {
    const { panel, projectId } = target;
    const current = untracked(() => this.state());
    if (current.status === 'ready' && matchesPanel(current, panel)) return;
    const initialSessionId = panelSessionId(panel);
    this.state.set({ panelId: panel.id, sessionId: initialSessionId, status: 'starting' });
    const state = await this.drafts.stateOf(panel, projectId);
    if (this.shown() !== target) return;
    if (state.status === 'ready' && initialSessionId === undefined) {
      this.tabs.attachDraft(panel.id, state.id);
    }
    this.state.set({
      panelId: panel.id,
      sessionId: initialSessionId,
      ...state,
    });
  }
}
