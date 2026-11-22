import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { AgentTile } from '@ui/agent-tile';
import { HlmBadgeImports } from '@ui/badge';
import { Cause, Effect, Option, Schedule, Stream } from 'effect';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type {
  LiveState,
  SessionId,
  SessionStreamItem,
  WorkerInfo,
} from '../../../shared/sessions/sessions.rpc';
import type { PaneId, WorkspacePanel } from '../../../shared/tabs/tabs.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { SessionToolbar } from '../../core/session-toolbar';
import { Tabs } from '../../core/tabs';
import { formatElapsed, stepKindLabel } from './thread';

/** How often the elapsed times in the panel update. */
const TICK_MS = 1000;
const RESUBSCRIBE_AFTER = '500 millis';

const sessionGone = (cause: Cause.Cause<{ readonly _tag: string }>): boolean =>
  Option.exists(Cause.findErrorOption(cause), (error) => error._tag === 'SessionError');

const followWorkers = (sessionId: SessionId, onItem: (item: SessionStreamItem) => void) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    yield* api['Session.events']({ sessionId, afterSeq: Number.MAX_SAFE_INTEGER }).pipe(
      Stream.runForEach((item) => Effect.sync(() => onItem(item))),
    );
  }).pipe(
    Effect.sandbox,
    Effect.retry({
      schedule: Schedule.spaced(RESUBSCRIBE_AFTER),
      while: (cause) => !Cause.hasDies(cause) && !sessionGone(cause),
    }),
    Effect.ignore,
  );

/**
 * Inline Panel body for a Session's running Workers: one row each with the Agent, title, Model, time since
 * the run began, one status line and a spinner or attention dot. `PanelHeader` owns the Panel header & close
 * button; clicking a row opens the Worker's Session.
 */
@Component({
  selector: 'app-workers-panel',
  imports: [HlmBadgeImports, AgentTile],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'mx-auto flex w-full max-w-3xl flex-col gap-3',
    'data-testid': 'workers-panel',
  },
  template: `
    <div class="flex items-center justify-between gap-2">
      <span hlmBadge variant="secondary" class="tabular-nums" data-testid="workers-running" i18n
        >{{ runningCount() }} running</span
      >
    </div>
    <div class="flex flex-col gap-2">
      @for (worker of workers(); track worker.sessionId) {
        <button
          type="button"
          class="bg-card hover:bg-accent focus-visible:ring-ring border-border flex w-full flex-col gap-2 rounded-[14px] border px-3 py-2.5 text-start text-sm outline-none focus-visible:ring-2"
          data-testid="worker-row"
          [attr.aria-label]="rowLabel(worker)"
          (click)="open.emit(worker)"
        >
          <span class="flex items-center gap-2.5">
            <app-agent-tile [agentId]="worker.agentId ?? ''" [name]="agentName(worker)" />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate font-medium" data-testid="worker-title">{{
                worker.title
              }}</span>
              <span
                class="text-muted-foreground truncate text-xs tabular-nums"
                data-testid="worker-meta"
                >{{ meta(worker) }}</span
              >
            </span>
            @if (worker.state === 'requiresAction') {
              <span
                aria-hidden="true"
                class="size-1.5 shrink-0 rounded-full bg-[var(--attention)]"
                data-testid="worker-attention"
              ></span>
            } @else if (worker.state === 'running') {
              <span
                aria-hidden="true"
                class="size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
                data-testid="worker-spinner"
              ></span>
            }
          </span>
          <span class="truncate text-xs" data-testid="worker-status">
            @switch (worker.state) {
              @case ('requiresAction') {
                <span class="text-[var(--attention)]" i18n>Needs permission</span>
              }
              @case ('unknown') {
                <span class="text-muted-foreground" i18n>Reconnecting</span>
              }
              @default {
                @if (worker.action; as action) {
                  <span class="text-muted-foreground"
                    >{{ kindLabel(action.kind) }}
                    <span class="font-mono">{{ action.target }}</span></span
                  >
                } @else {
                  <span class="text-muted-foreground" i18n>Working</span>
                }
              }
            }
          </span>
          <span
            class="border-border bg-card inline-flex h-[26px] w-fit items-center gap-1.5 rounded-full border px-2.5 text-xs"
            data-testid="worker-see-session"
            aria-hidden="true"
          >
            <span i18n>See session</span>
            <svg
              class="size-3"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M5 12h14" />
              <path d="m13 6 6 6-6 6" />
            </svg>
          </span>
        </button>
      } @empty {
        <p class="text-muted-foreground py-3 text-sm" data-testid="workers-empty" i18n>
          No workers running
        </p>
      }
    </div>
  `,
})
export class WorkersPanel {
  /** The Workers to list: running, waiting for Permission, or reconnecting. Finished ones are not passed in. */
  readonly workers = input.required<ReadonlyArray<WorkerInfo>>();
  /** Opens the Worker's Session. */
  readonly open = output<WorkerInfo>();

  private readonly now = signal(Date.now());

  /** Workers confirmed working, including those waiting for Permission; reconnecting ones are not counted. */
  protected readonly runningCount = computed(
    () =>
      this.workers().filter(
        (worker) => worker.state === 'running' || worker.state === 'requiresAction',
      ).length,
  );

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), TICK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected agentName(worker: WorkerInfo): string {
    return worker.agentName ?? worker.title;
  }

  protected kindLabel = stepKindLabel;

  /** Model and time since the run began, e.g. "Haiku 5.5 · 01:10". */
  protected meta(worker: WorkerInfo): string {
    const parts: string[] = [];
    const model = worker.modelName ?? worker.agentName;
    if (model !== undefined) parts.push(model);
    if (worker.startedAt !== undefined && worker.state !== 'unknown') {
      parts.push(formatElapsed(this.now() - worker.startedAt));
    }
    return parts.join(' · ');
  }

  protected rowLabel(worker: WorkerInfo): string {
    switch (worker.state) {
      case 'requiresAction':
        return $localize`${worker.title}, needs permission. See session`;
      case 'unknown':
        return $localize`${worker.title}, reconnecting. See session`;
      case 'running':
      case 'idle':
        return $localize`${worker.title}, working. See session`;
    }
  }
}

/**
 * PanelRegistry host for `Workers` Panels: reads live Workers for `panel.spec.sessionId`, subscribes to
 * `Session.events` if the parent `Session` Panel isn't currently mounted, and opens clicked Workers in the Tab.
 */
@Component({
  selector: 'app-workers-panel-host',
  imports: [WorkersPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0' },
  template: `
    <app-workers-panel
      aria-label="Workers"
      i18n-aria-label
      [workers]="visibleWorkers()"
      (open)="openWorker($event)"
    />
  `,
})
export class WorkersPanelHost {
  readonly panel = input.required<WorkspacePanel>();
  readonly projectId = input.required<ProjectId>();
  readonly paneId = input<PaneId | null>(null);

  private readonly tabs = inject(Tabs);
  private readonly toolbar = inject(SessionToolbar);
  private readonly runtime = inject(EffectRuntime);
  private readonly streamedLive = signal<{
    readonly sessionId: SessionId;
    readonly state: LiveState;
  } | null>(null);
  private aborts: AbortController | null = null;

  private readonly sessionId = computed((): SessionId | null => {
    const spec = this.panel().spec;
    return spec._tag === 'Workers' ? spec.sessionId : null;
  });

  private readonly parentMounted = computed((): boolean => {
    const sid = this.sessionId();
    return sid !== null && this.toolbar.entryFor(sid) !== null;
  });

  protected readonly visibleWorkers = computed((): ReadonlyArray<WorkerInfo> => {
    const sid = this.sessionId();
    if (sid === null) return [];
    const streamed = this.streamedLive();
    const live =
      (streamed !== null && streamed.sessionId === sid ? streamed.state : undefined) ??
      this.tabs.liveState(sid);
    return (live?.workers ?? []).filter((worker) => worker.state !== 'idle');
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.aborts?.abort());
    effect(() => {
      const sid = this.sessionId();
      const mounted = this.parentMounted();
      untracked(() => {
        this.aborts?.abort();
        this.aborts = null;
        if (sid === null || mounted) return;
        const aborts = new AbortController();
        this.aborts = aborts;
        void this.runtime.run(
          followWorkers(sid, (item) => {
            if (aborts.signal.aborted || item._tag !== 'Live') return;
            this.streamedLive.set({ sessionId: sid, state: item.state });
            this.tabs.applyLive(sid, item.state);
          }),
          { signal: aborts.signal },
        );
      });
    });
  }

  protected openWorker(worker: WorkerInfo): void {
    this.tabs.openWorkerFromPanel(
      {
        id: worker.sessionId,
        projectId: this.projectId(),
        title: worker.title,
      },
      this.paneId() ?? undefined,
    );
  }
}
