import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  type OnInit,
  output,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Effect, Stream } from 'effect';
import { HlmButtonImports } from '@ui/button';
import { HlmProgressImports } from '@ui/progress';
import type {
  Agent,
  InstallCommand,
  InstallEvent,
  InstallFailure,
} from '../../../shared/agents/agents.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { DeviceScope } from '../../core/device-scope';
import { EffectRuntime } from '../../core/effect-runtime';

/** The elapsed time appears once an install has run this long. */
const SHOW_ELAPSED_AFTER_S = 10;

type View =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  /** npm is there: offer Install; `confirming` once Install was pressed and the command is shown. */
  | { readonly status: 'offer'; readonly confirming: boolean }
  | { readonly status: 'noNpm' }
  | { readonly status: 'native' }
  | { readonly status: 'installing'; readonly startedAt: number }
  | { readonly status: 'installed' }
  | {
      readonly status: 'failed';
      readonly reason: InstallFailure | 'Unreachable';
      readonly detail: string;
      readonly hasLog: boolean;
    };

const listAgents = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return yield* api['Agents.list']();
});

const getCommand = Effect.fnUntraced(function* (agent: Agent) {
  const api = yield* DesktopApi;
  return yield* api['Agents.installCommand']({ agentId: agent.id });
});

/** Runs the install and hands each event to `onEvent` as it arrives. */
const runInstall = Effect.fnUntraced(function* (
  agent: Agent,
  onEvent: (event: InstallEvent) => void,
) {
  const api = yield* DesktopApi;
  yield* api['Agents.install']({ agentId: agent.id }).pipe(
    Stream.runForEach((event) => Effect.sync(() => onEvent(event))),
  );
});

const openLog = Effect.gen(function* () {
  const api = yield* DesktopApi;
  yield* api['Agents.openInstallLog']();
});

/**
 * The offer to install a Catalog Agent's adapter: "Claude isn't installed. Install it?". Install shows the exact
 * command before it runs; without npm only the command is shown. Emits `installed` once the adapter resolves.
 * Where it is placed (new Session, Settings, Agent bar) is up to the embedding view.
 */
@Component({
  selector: 'app-agent-install',
  imports: [NgTemplateOutlet, HlmButtonImports, HlmProgressImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="flex flex-col gap-3 text-sm" data-testid="agent-install">
      @switch (view().status) {
        @case ('loading') {
          <p class="text-muted-foreground" i18n>Checking how to install {{ agent().name }}…</p>
        }
        @case ('unavailable') {
          <p class="text-destructive" i18n>Could not check how to install {{ agent().name }}.</p>
        }
        @case ('offer') {
          <p i18n>{{ agent().name }} isn't installed. Install it?</p>
          @if (confirming()) {
            <p class="text-muted-foreground" i18n>Spence will run:</p>
            <ng-container [ngTemplateOutlet]="commandBlock" />
            <div class="flex gap-2">
              <button hlmBtn data-testid="confirm-install" (click)="install()" i18n>Install</button>
              <button hlmBtn variant="ghost" (click)="cancel()" i18n>Cancel</button>
            </div>
          } @else {
            <div class="flex gap-2">
              <button hlmBtn data-testid="install" (click)="confirm()" i18n>Install</button>
              <button
                hlmBtn
                variant="outline"
                data-testid="show-command"
                (click)="commandShown.set(true)"
                i18n
              >
                Show command
              </button>
            </div>
            @if (commandShown()) {
              <ng-container [ngTemplateOutlet]="commandBlock" />
            }
          }
        }
        @case ('noNpm') {
          <p i18n>{{ agent().name }} isn't installed.</p>
          <p class="text-muted-foreground" data-testid="needs-node" i18n>
            Installing it needs Node.js. Install Node.js, then run this command in a terminal:
          </p>
          <ng-container [ngTemplateOutlet]="commandBlock" />
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
          <p i18n>Installing {{ agent().name }}…</p>
          <hlm-progress data-testid="install-progress" aria-label="Installing" i18n-aria-label>
            <hlm-progress-indicator />
          </hlm-progress>
          @if (elapsedSeconds(); as seconds) {
            <p class="text-muted-foreground tabular-nums" data-testid="install-elapsed" i18n>
              {{ seconds }} s
            </p>
          }
        }
        @case ('installed') {
          <p i18n>{{ agent().name }} is installed.</p>
        }
        @case ('failed') {
          @if (failure(); as failed) {
            <p class="text-destructive" data-testid="install-failure">
              @switch (failed.reason) {
                @case ('NoNpm') {
                  <ng-container i18n>npm isn't available. Install Node.js first.</ng-container>
                }
                @case ('PermissionDenied') {
                  <ng-container i18n>npm isn't allowed to write to its global folder.</ng-container>
                }
                @case ('NpmFailed') {
                  <ng-container i18n>npm couldn't install {{ agent().name }}.</ng-container>
                }
                @case ('NotOnPath') {
                  <ng-container i18n
                    >{{ agent().name }} was installed, but Spence can't find it on
                    PATH.</ng-container
                  >
                }
                @case ('Unreachable') {
                  <ng-container i18n>The install couldn't be started.</ng-container>
                }
              }
            </p>
            @if (failed.detail !== '') {
              <p class="text-muted-foreground font-mono text-xs break-all">{{ failed.detail }}</p>
            }
            <p class="text-muted-foreground" i18n>You can run the command yourself:</p>
            <ng-container [ngTemplateOutlet]="commandBlock" />
            <!-- The log is on the Device that ran the install; a Remote one's opens there, not here. -->
            @if (failed.hasLog && !onRemote()) {
              <div>
                <button hlmBtn variant="link" data-testid="open-log" (click)="openLog()" i18n>
                  Open log
                </button>
              </div>
            }
          }
        }
      }
    </section>

    <ng-template #commandBlock>
      <div class="bg-muted flex items-center gap-2 rounded-md px-3 py-2">
        <code class="flex-1 font-mono text-xs break-all select-all" data-testid="install-command">{{
          command()?.command
        }}</code>
        <button hlmBtn variant="ghost" size="sm" data-testid="copy-command" (click)="copy()">
          @if (copied()) {
            <ng-container i18n>Copied</ng-container>
          } @else {
            <ng-container i18n>Copy</ng-container>
          }
        </button>
      </div>
    </ng-template>
  `,
})
export class AgentInstallOffer implements OnInit {
  private readonly runtime = inject(EffectRuntime);
  private readonly scope = inject(DeviceScope, { optional: true });
  private readonly aborts = new AbortController();
  private readonly now = signal(Date.now());
  private ticker: ReturnType<typeof setInterval> | undefined;

  readonly agent = input.required<Agent>();
  /** The adapter now resolves on the merged PATH. */
  readonly installed = output();

  /** Installing on a Remote device (inside its `DeviceScope`). */
  protected readonly onRemote = computed(() => this.scope?.device() !== undefined);
  protected readonly view = signal<View>({ status: 'loading' });
  protected readonly command = signal<InstallCommand | null>(null);
  protected readonly commandShown = signal(false);
  protected readonly copied = signal(false);
  protected readonly rescanning = signal(false);
  protected readonly rescanNotFound = signal(false);
  protected readonly nativeInstructions = computed(
    () => this.agent().installInstructions ?? this.command()?.command ?? '',
  );

  protected readonly confirming = computed(() => {
    const view = this.view();
    return view.status === 'offer' && view.confirming;
  });

  protected readonly failure = computed(() => {
    const view = this.view();
    return view.status === 'failed' ? view : null;
  });

  /** Whole seconds since the install started, once past the threshold; `null` before. */
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
  }

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    const agent = this.agent();
    const exit = await this.runtime.run(getCommand(agent), { signal: this.aborts.signal });
    if (exit._tag === 'Failure') {
      if (agent.installKind === 'native') {
        this.view.set({ status: 'native' });
        return;
      }
      this.view.set({ status: 'unavailable' });
      return;
    }
    this.command.set(exit.value);
    if (agent.installKind === 'native') {
      this.view.set({ status: 'native' });
      return;
    }
    this.view.set(
      exit.value.npmFound ? { status: 'offer', confirming: false } : { status: 'noNpm' },
    );
  }

  protected async rescan(): Promise<void> {
    if (this.rescanning()) return;
    this.rescanning.set(true);
    this.rescanNotFound.set(false);
    const exit = await this.runtime.run(listAgents, { signal: this.aborts.signal });
    this.rescanning.set(false);
    if (exit._tag === 'Success') {
      const updated = exit.value.find((candidate) => candidate.id === this.agent().id);
      if (updated?.installed) {
        this.view.set({ status: 'installed' });
        this.installed.emit();
        return;
      }
    }
    this.rescanNotFound.set(true);
  }

  protected confirm(): void {
    this.view.set({ status: 'offer', confirming: true });
  }

  protected cancel(): void {
    this.view.set({ status: 'offer', confirming: false });
  }

  protected async install(): Promise<void> {
    this.startTicker();
    this.view.set({ status: 'installing', startedAt: Date.now() });
    const exit = await this.runtime.run(
      runInstall(this.agent(), (event) => this.onEvent(event)),
      { signal: this.aborts.signal },
    );
    this.stopTicker();
    if (exit._tag === 'Failure' && !this.aborts.signal.aborted) {
      this.view.set({ status: 'failed', reason: 'Unreachable', detail: '', hasLog: false });
    }
  }

  protected async openLog(): Promise<void> {
    await this.runtime.run(openLog, { signal: this.aborts.signal });
  }

  protected async copy(): Promise<void> {
    const command = this.command()?.command;
    if (command === undefined) return;
    try {
      await navigator.clipboard.writeText(command);
      this.copied.set(true);
    } catch {
      // No clipboard access: the command stays selectable.
    }
  }

  private onEvent(event: InstallEvent): void {
    switch (event._tag) {
      case 'started':
        return;
      case 'succeeded':
        this.view.set({ status: 'installed' });
        this.installed.emit();
        return;
      case 'failed':
        this.view.set({
          status: 'failed',
          reason: event.reason,
          detail: event.detail,
          hasLog: true,
        });
        return;
    }
  }

  private startTicker(): void {
    this.now.set(Date.now());
    this.ticker = setInterval(() => this.now.set(Date.now()), 1000);
  }

  private stopTicker(): void {
    if (this.ticker !== undefined) clearInterval(this.ticker);
    this.ticker = undefined;
  }
}
