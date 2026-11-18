import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { AgentTile } from '@ui/agent-tile';
import type { WorkerInfo } from '../../../shared/sessions/sessions.rpc';
import { formatElapsed, stepKindLabel } from './thread';

/** How often the elapsed times in the panel update. */
const TICK_MS = 1000;

/**
 * The right panel of a Session's running Workers: one row each with the Agent, title, Model, time since the run began,
 * one status line and a spinner or attention dot. The whole row opens the Worker's Session. Presentational: the
 * Session view owns which Workers are listed and what opening does.
 */
@Component({
  selector: 'app-workers-panel',
  imports: [HlmButtonImports, AgentTile],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'border-border bg-sidebar fixed top-12 right-0 bottom-0 z-10 flex w-80 max-w-full flex-col overflow-y-auto border-l',
    'data-testid': 'workers-sidebar',
  },
  template: `
    <header class="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b ps-4 pe-2">
      <h2 class="flex-1 text-sm font-medium" i18n>Workers</h2>
      <span class="text-muted-foreground text-xs tabular-nums" data-testid="workers-running" i18n
        >{{ runningCount() }} running</span
      >
      <button
        hlmBtn
        type="button"
        variant="ghost"
        size="icon"
        class="size-7 rounded-lg"
        data-testid="workers-close"
        aria-label="Close Workers panel"
        i18n-aria-label
        (click)="closed.emit()"
      >
        <svg
          aria-hidden="true"
          class="size-[15px]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </header>
    <div class="flex flex-col gap-2 p-3">
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
  readonly closed = output<void>();

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
