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
import type { DeviceId } from '../../../shared/devices/devices.rpc';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { PaneId, PanelId, WorkspacePanel } from '../../../shared/tabs/tabs.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { onDevice } from '../../core/device-scope';
import { EffectRuntime } from '../../core/effect-runtime';
import { Tabs } from '../../core/tabs';
import { SessionView } from './session-view';

const createSession = (projectId: ProjectId, device: DeviceId | undefined) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    return yield* api['Session.create']({ projectId });
  }).pipe(onDevice(device));

const CREATE_TIMEOUT = '30 seconds';

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
  async stateOf(panel: WorkspacePanel, projectId: ProjectId, device?: DeviceId): Promise<State> {
    if (panel.spec._tag !== 'Session') return { status: 'failed' };
    if (panel.spec.sessionId !== undefined) return { status: 'ready', id: panel.spec.sessionId };
    const id = await this.sessionOf(panel.id, projectId, device);
    return id === null ? { status: 'failed' } : { status: 'ready', id };
  }

  private sessionOf(
    panelId: PanelId,
    projectId: ProjectId,
    device: DeviceId | undefined,
  ): Promise<SessionId | null> {
    const known = this.created.get(panelId);
    if (known !== undefined) return known;
    // A reply that never arrives must end as a failed start (with Retry on next show), not "Starting…" forever.
    const creating = this.runtime
      .run(createSession(projectId, device).pipe(Effect.timeout(CREATE_TIMEOUT)))
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
        <p class="text-muted-foreground mx-6 mt-4 text-sm" data-testid="session-starting" i18n>
          Starting the Session…
        </p>
      }
      @case ('failed') {
        <p class="text-destructive mx-6 mt-4 text-sm" data-testid="session-failed" i18n>
          Could not start a Session.
        </p>
      }
    }
    @for (id of ids(); track id) {
      <app-session-view
        [sessionId]="id"
        [paneId]="paneId()"
        [projectId]="projectId()"
        [projectName]="projectName()"
        [focused]="focused()"
        (messageSent)="keep($event)"
        (gone)="startOver()"
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
  readonly device = input<DeviceId | undefined>(undefined);

  protected readonly state = signal<PanelState>({
    panelId: '',
    sessionId: undefined,
    status: 'starting',
  });
  private readonly clearedGone = signal<{
    readonly panelId: PanelId;
    readonly sessionId: SessionId;
  } | null>(null);

  private readonly effectivePanel = computed((): WorkspacePanel => {
    const panel = this.panel();
    const cleared = this.clearedGone();
    if (
      cleared !== null &&
      panel.id === cleared.panelId &&
      panel.spec._tag === 'Session' &&
      panel.spec.sessionId === cleared.sessionId
    ) {
      return { ...panel, spec: { _tag: 'Session', draft: true } };
    }
    return panel;
  });

  /** Which Session to show: changes only with the Panel, Project, Device, or bound SessionId. */
  private readonly shown = computed(
    () => ({
      panel: this.effectivePanel(),
      projectId: this.projectId(),
      device: this.device(),
    }),
    {
      equal: (a, b) =>
        a.panel.id === b.panel.id &&
        a.projectId === b.projectId &&
        a.device === b.device &&
        panelSessionId(a.panel) === panelSessionId(b.panel),
    },
  );

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

  /** A draft whose Session vanished (a Remote draft gone from its Device) starts over as a fresh draft. */
  protected startOver(): void {
    const panel = this.panel();
    if (
      panel.spec._tag !== 'Session' ||
      panel.spec.draft !== true ||
      panel.spec.sessionId === undefined
    ) {
      return;
    }
    this.clearedGone.set({ panelId: panel.id, sessionId: panel.spec.sessionId });
    this.tabs.resetDraft(panel.id);
  }

  private async show(target: {
    readonly panel: WorkspacePanel;
    readonly projectId: ProjectId;
    readonly device: DeviceId | undefined;
  }): Promise<void> {
    const { panel, projectId, device } = target;
    const current = untracked(() => this.state());
    if (current.status === 'ready' && matchesPanel(current, panel)) return;
    const initialSessionId = panelSessionId(panel);
    this.state.set({ panelId: panel.id, sessionId: initialSessionId, status: 'starting' });
    const state = await this.drafts
      .stateOf(panel, projectId, device)
      .catch(() => ({ status: 'failed' }) as const);
    const shown = this.shown();
    if (
      shown.panel.id !== panel.id ||
      shown.projectId !== projectId ||
      panelSessionId(shown.panel) !== initialSessionId
    ) {
      return;
    }
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
