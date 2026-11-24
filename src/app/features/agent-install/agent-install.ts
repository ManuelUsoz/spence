import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmProgressImports } from '@ui/progress';
import { Effect } from 'effect';
import type { Agent, InstallFailure, InstallPhase } from '../../../shared/agents/agents.rpc';
import type { DeviceId } from '../../../shared/devices/devices.rpc';
import { AgentInstallTracker, isAgentUpdate } from '../../core/agent-install-tracker';
import { DesktopApi } from '../../core/desktop-api';
import { DeviceScope, onDevice } from '../../core/device-scope';
import { EffectRuntime } from '../../core/effect-runtime';

/** The elapsed time appears once setup has run this long. */
const SHOW_ELAPSED_AFTER_S = 10;

type View =
  | { readonly status: 'offer' }
  | { readonly status: 'native' }
  | {
      readonly status: 'installing';
      readonly phase: InstallPhase;
      readonly startedAt: number;
      readonly cancelling: boolean;
    }
  | { readonly status: 'installed' }
  | {
      readonly status: 'failed';
      readonly reason: InstallFailure | 'Unreachable';
      readonly detail: string;
      readonly hasLog: boolean;
    };

const listAgents = (device: DeviceId | undefined) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    return yield* api['Agents.list']();
  }).pipe(onDevice(device));

/**
 * Quiet inline setup offer for a Catalog Agent: one-click Set up for packaged (`npm`) Agents via Spence's managed
 * Node runtime, or official instructions + Re-scan for native Agents. Emits `installed` once ready.
 */
@Component({
  selector: 'app-agent-install',
  imports: [HlmButtonImports, HlmProgressImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="flex flex-col gap-2 text-sm" data-testid="agent-install">
      @switch (view().status) {
        @case ('offer') {
          @if (isUpdate()) {
            <div class="flex flex-wrap items-center gap-2">
              <button
                hlmBtn
                type="button"
                size="sm"
                data-testid="update-agent"
                (click)="install()"
                i18n
              >
                Update
              </button>
            </div>
          } @else {
            <div class="flex flex-wrap items-center gap-2">
              <span i18n>{{ agent().name }} isn't installed.</span>
              <button hlmBtn size="sm" data-testid="install" (click)="install()" i18n>
                Set up
              </button>
            </div>
          }
        }
        @case ('native') {
          <p i18n>{{ agent().name }} isn't installed.</p>
          @if (nativeInstructions(); as instructions) {
            <p class="text-muted-foreground" data-testid="native-install-instructions">
              {{ instructions }}
            </p>
          }
          <div class="flex items-center gap-2">
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              data-testid="rescan-agents"
              [disabled]="rescanning()"
              (click)="rescan()"
              i18n
            >
              Re-scan
            </button>
            @if (rescanNotFound()) {
              <span class="text-muted-foreground text-xs" data-testid="rescan-not-found" i18n>
                Still not found on PATH.
              </span>
            }
          </div>
        }
        @case ('installing') {
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p data-testid="install-phase">
              @switch (installPhase()) {
                @case ('downloadingRuntime') {
                  <ng-container i18n>Downloading runtime…</ng-container>
                }
                @case ('installingAdapter') {
                  @if (isUpdate()) {
                    <ng-container i18n>Updating {{ agent().name }}…</ng-container>
                  } @else {
                    <ng-container i18n>Installing {{ agent().name }}…</ng-container>
                  }
                }
                @default {
                  @if (isUpdate()) {
                    <ng-container i18n>Updating {{ agent().name }}…</ng-container>
                  } @else {
                    <ng-container i18n>Setting up {{ agent().name }}…</ng-container>
                  }
                }
              }
            </p>
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              data-testid="cancel-install"
              [disabled]="cancelling()"
              (click)="cancel()"
              i18n
            >
              Cancel
            </button>
          </div>
          <hlm-progress data-testid="install-progress" aria-label="Setting up" i18n-aria-label>
            <hlm-progress-indicator />
          </hlm-progress>
          @if (elapsedSeconds(); as seconds) {
            <p class="text-muted-foreground tabular-nums" data-testid="install-elapsed" i18n>
              {{ seconds }} s
            </p>
          }
        }
        @case ('installed') {
          @if (isUpdate()) {
            <p i18n>{{ agent().name }} is updated.</p>
          } @else {
            <p i18n>{{ agent().name }} is installed.</p>
          }
        }
        @case ('failed') {
          @if (failure(); as failed) {
            <p class="text-destructive" data-testid="install-failure">
              @switch (failed.reason) {
                @case ('RuntimeDownloadFailed') {
                  <ng-container i18n
                    >Couldn't download the Node runtime for {{ agent().name }}.</ng-container
                  >
                }
                @case ('ChecksumMismatch') {
                  <ng-container i18n>The downloaded Node runtime failed verification.</ng-container>
                }
                @case ('PermissionDenied') {
                  <ng-container i18n
                    >Spence isn't allowed to write to its agent folder.</ng-container
                  >
                }
                @case ('NpmFailed') {
                  @if (isUpdate()) {
                    <ng-container i18n>Couldn't update {{ agent().name }}.</ng-container>
                  } @else {
                    <ng-container i18n>Couldn't install {{ agent().name }}.</ng-container>
                  }
                }
                @case ('NotOnPath') {
                  <ng-container i18n>{{ agent().name }} wasn't found on PATH.</ng-container>
                }
                @case ('Unreachable') {
                  @if (isUpdate()) {
                    <ng-container i18n>The update couldn't be started.</ng-container>
                  } @else {
                    <ng-container i18n>The setup couldn't be started.</ng-container>
                  }
                }
              }
            </p>
            @if (failed.detail !== '') {
              <p class="text-muted-foreground font-mono text-xs break-all">{{ failed.detail }}</p>
            }
            <div class="flex flex-wrap items-center gap-2">
              <button
                hlmBtn
                type="button"
                variant="outline"
                size="sm"
                data-testid="retry-install"
                (click)="install()"
                i18n
              >
                Try again
              </button>
              <!-- The log is on the Device that ran the install; a Remote one's opens there, not here. -->
              @if (failed.hasLog && !onRemote()) {
                <button
                  hlmBtn
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="open-log"
                  (click)="openLog()"
                  i18n
                >
                  Open log
                </button>
              }
            </div>
          }
        }
      }
    </section>
  `,
})
export class AgentInstallOffer {
  private readonly runtime = inject(EffectRuntime);
  private readonly tracker = inject(AgentInstallTracker);
  private readonly scope = inject(DeviceScope, { optional: true });
  private readonly aborts = new AbortController();
  private readonly now = signal(Date.now());
  private readonly rescanInstalled = signal(false);
  private ticker: ReturnType<typeof setInterval> | undefined;

  readonly agent = input.required<Agent>();
  /** The adapter is now installed and ready. */
  readonly installed = output();

  /** Installing on a Remote device (inside its `DeviceScope`). */
  protected readonly onRemote = computed(() => this.scope?.device() !== undefined);
  /** Updating an already-installed outdated (`unverified`) managed `npm` Agent. */
  protected readonly isUpdate = computed(() => isAgentUpdate(this.agent()));
  protected readonly rescanning = signal(false);
  protected readonly rescanNotFound = signal(false);
  protected readonly nativeInstructions = computed(() => this.agent().installInstructions ?? '');

  protected readonly view = computed<View>(() => {
    if (this.rescanInstalled()) return { status: 'installed' };
    const agent = this.agent();
    const tracked = this.tracker.stateFor(this.scope?.device(), agent.id);
    if (tracked !== undefined) {
      switch (tracked.status) {
        case 'installing':
          return {
            status: 'installing',
            phase: tracked.phase,
            startedAt: tracked.startedAt,
            cancelling: tracked.cancelling,
          };
        case 'installed':
          return { status: 'installed' };
        case 'failed':
          return {
            status: 'failed',
            reason: tracked.reason,
            detail: tracked.detail,
            hasLog: tracked.hasLog,
          };
      }
    }
    return { status: agent.installKind === 'native' ? 'native' : 'offer' };
  });

  protected readonly installPhase = computed<InstallPhase>(() => {
    const view = this.view();
    return view.status === 'installing' ? view.phase : 'preparing';
  });

  protected readonly cancelling = computed(() => {
    const view = this.view();
    return view.status === 'installing' && view.cancelling;
  });

  protected readonly failure = computed(() => {
    const view = this.view();
    return view.status === 'failed' ? view : null;
  });

  /** Whole seconds since setup started, once past the threshold; `null` before. */
  protected readonly elapsedSeconds = computed(() => {
    const view = this.view();
    if (view.status !== 'installing') return null;
    const seconds = Math.floor((this.now() - view.startedAt) / 1000);
    return seconds >= SHOW_ELAPSED_AFTER_S ? seconds : null;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.aborts.abort();
      this.stopTicker();
    });

    effect((onCleanup) => {
      const agent = this.agent();
      const device = this.scope?.device();
      const unmount = untracked(() => this.tracker.mountView(agent, device));
      onCleanup(unmount);
    });

    effect(() => {
      const current = this.view();
      if (current.status === 'installing') {
        untracked(() => this.ensureTicker());
      } else {
        untracked(() => this.stopTicker());
      }
      if (current.status === 'installed') {
        const agent = this.agent();
        const device = this.scope?.device();
        const tracked = this.tracker.stateFor(device, agent.id);
        if (tracked?.status === 'installed' && !tracked.consumed) {
          untracked(() => {
            this.tracker.markInstalledEmitted(device, agent.id);
            this.installed.emit();
          });
        }
      }
    });
  }

  protected async rescan(): Promise<void> {
    if (this.rescanning()) return;
    this.rescanning.set(true);
    this.rescanNotFound.set(false);
    const exit = await this.runtime.run(listAgents(this.scope?.device()), {
      signal: this.aborts.signal,
    });
    this.rescanning.set(false);
    if (exit._tag === 'Success') {
      const updated = exit.value.find((candidate) => candidate.id === this.agent().id);
      if (updated?.installed) {
        this.rescanInstalled.set(true);
        this.installed.emit();
        return;
      }
    }
    this.rescanNotFound.set(true);
  }

  protected install(): void {
    this.tracker.start(this.agent(), this.scope?.device());
  }

  protected async cancel(): Promise<void> {
    await this.tracker.cancel(this.agent().id, this.scope?.device());
  }

  protected async openLog(): Promise<void> {
    await this.tracker.openLog();
  }

  private ensureTicker(): void {
    this.now.set(Date.now());
    if (this.ticker === undefined) {
      this.ticker = setInterval(() => this.now.set(Date.now()), 1000);
    }
  }

  private stopTicker(): void {
    if (this.ticker !== undefined) clearInterval(this.ticker);
    this.ticker = undefined;
  }
}
