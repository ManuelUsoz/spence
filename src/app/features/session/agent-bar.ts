import { NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { Effect, Exit } from 'effect';
import { AgentId, type Agent, type AgentCapabilities } from '../../../shared/agents/agents.rpc';

const FALLBACK_CAPABILITIES: AgentCapabilities = {
  models: true,
  effort: true,
  images: true,
  askMode: true,
  resume: true,
  contextUsage: true,
  supportsCompaction: false,
  supportsIsolatedSummary: false,
  modelChangePreservesContext: true,
  crossDeviceTools: true,
};
import type { LiveState } from '../../../shared/sessions/sessions.rpc';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
import { EffectRuntime } from '../../core/effect-runtime';

const copyToClipboard = (text: string) =>
  Effect.tryPromise(() => navigator.clipboard.writeText(text));

interface InstallOfferInstance {
  readonly installed?: {
    subscribe: (next: () => void) => { unsubscribe: () => void };
  };
}

/**
 * Notice docked on top of the Composer for problems stopping the Session from sending: missing Project folder,
 * uninstalled Agent, Agent startup/protocol incompatibility, or expired authentication.
 */
@Component({
  selector: 'app-agent-bar',
  imports: [NgComponentOutlet, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.hidden]': '!visible()' },
  template: `
    @if (visible()) {
      <div class="bg-muted flex flex-col gap-2 rounded-md p-2 text-sm" data-testid="agent-bar">
        @if (folderMissing()) {
          <div class="flex flex-wrap items-center gap-2">
            <span i18n>Folder not found</span>
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              data-testid="locate-folder"
              (click)="locate.emit()"
              i18n
            >
              Locate…
            </button>
          </div>
        }

        @if (unconfirmedExit(); as unconfirmed) {
          <div class="flex flex-wrap items-center gap-2" data-testid="agent-exit-unconfirmed">
            @if (unconfirmed.pid !== undefined) {
              <span i18n>
                {{ agentName() }} process (<code class="font-mono text-xs">{{
                  unconfirmed.pid
                }}</code
                >) exit is still unconfirmed (<code class="font-mono text-xs">{{
                  unconfirmed.state
                }}</code
                >). Waiting for the OS to confirm exit before continuing.
              </span>
            } @else {
              <span i18n>
                {{ agentName() }} process exit is still unconfirmed (<code
                  class="font-mono text-xs"
                  >{{ unconfirmed.state }}</code
                >). Waiting for the OS to confirm exit before continuing.
              </span>
            }
          </div>
        }

        @switch (status()) {
          @case ('notInstalled') {
            @if (installOffer && installAgent(); as agent) {
              <ng-container
                [ngComponentOutlet]="installOffer"
                [ngComponentOutletInputs]="{ agent }"
              />
            } @else {
              <span i18n>{{ agentName() }} isn't installed.</span>
            }
          }
          @case ('cantStart') {
            @if (cantStartReason() === 'protocolVersion') {
              <div class="flex flex-wrap items-center gap-2">
                <span i18n>{{ agentName() }}'s adapter isn't compatible with this Spence</span>
                @if (updateCommand(); as cmd) {
                  <code class="bg-background rounded px-1.5 py-0.5 font-mono text-xs select-all">{{
                    cmd
                  }}</code>
                  <button
                    hlmBtn
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="copy-update-command"
                    (click)="copy(cmd)"
                  >
                    @if (copied() === cmd) {
                      <ng-container i18n>Copied</ng-container>
                    } @else {
                      <ng-container i18n>Copy</ng-container>
                    }
                  </button>
                }
              </div>
            } @else if (cantStartReason() === 'unsupported') {
              <div class="flex flex-wrap items-center gap-2" data-testid="agent-unsupported">
                <span>{{ unsupportedDetail() }}</span>
                <button
                  hlmBtn
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="open-agent-log"
                  (click)="openLog.emit()"
                  i18n
                >
                  Open log
                </button>
              </div>
            } @else {
              <div class="flex flex-wrap items-center gap-2">
                <span i18n>{{ agentName() }} couldn't start</span>
                <button
                  hlmBtn
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="agent-retry"
                  (click)="retry.emit()"
                  i18n
                >
                  Try again
                </button>
                <button
                  hlmBtn
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="open-agent-log"
                  (click)="openLog.emit()"
                  i18n
                >
                  Open log
                </button>
              </div>
            }
          }
          @case ('needsLogin') {
            @if (loggingIn()) {
              <div class="flex flex-wrap items-center gap-2">
                <span i18n>Finish logging in in your browser…</span>
                <button
                  hlmBtn
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="agent-login-cancel"
                  (click)="cancelLogin.emit()"
                  i18n
                >
                  Cancel
                </button>
              </div>
              @if (otherWays().length > 0) {
                <div class="flex flex-wrap items-center gap-2 text-xs">
                  <span class="text-muted-foreground" i18n>Other ways</span>
                  @for (method of otherWays(); track method.id) {
                    <span>{{ method.name }}</span>
                    @if (method.command; as cmd) {
                      <code
                        class="bg-background rounded px-1.5 py-0.5 font-mono text-xs select-all"
                        >{{ cmd }}</code
                      >
                      <button hlmBtn type="button" variant="ghost" size="sm" (click)="copy(cmd)">
                        @if (copied() === cmd) {
                          <ng-container i18n>Copied</ng-container>
                        } @else {
                          <ng-container i18n>Copy</ng-container>
                        }
                      </button>
                    }
                  }
                </div>
              }
            } @else {
              <div class="flex flex-wrap items-center gap-2">
                <span i18n>{{ agentName() }} needs to log in</span>
                @if (hasAuthMethods()) {
                  <button
                    hlmBtn
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="agent-login"
                    (click)="login.emit()"
                    i18n
                  >
                    Log in
                  </button>
                } @else {
                  <button
                    hlmBtn
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="agent-retry"
                    (click)="retry.emit()"
                    i18n
                  >
                    Try again
                  </button>
                }
              </div>
              @if (loginInstructions(); as instructions) {
                <p class="text-muted-foreground text-xs" data-testid="agent-login-instructions">
                  {{ instructions }}
                </p>
              }
            }
          }
        }
        @if (unverified()) {
          <div class="flex flex-wrap items-center gap-2 text-xs" data-testid="agent-unverified">
            <span i18n>Unverified version</span>
            @if (installedVersion() !== '') {
              <code class="bg-background rounded px-1.5 py-0.5 font-mono text-xs">{{
                installedVersion()
              }}</code>
            }
            @if (upgradeCommand(); as cmd) {
              <span class="text-muted-foreground" i18n>Qualified version:</span>
              <code class="bg-background rounded px-1.5 py-0.5 font-mono text-xs select-all">{{
                cmd
              }}</code>
              <button
                hlmBtn
                type="button"
                variant="outline"
                size="sm"
                data-testid="copy-upgrade-command"
                (click)="copy(cmd)"
              >
                @if (copied() === cmd) {
                  <ng-container i18n>Copied</ng-container>
                } @else {
                  <ng-container i18n>Copy</ng-container>
                }
              </button>
            }
          </div>
        }
      </div>
    }
  `,
})
export class AgentBar {
  protected readonly installOffer = inject(AGENT_INSTALL_OFFER, { optional: true });
  private readonly installOutlet = viewChild(NgComponentOutlet);

  readonly live = input.required<LiveState | null>();
  readonly folderMissing = input<boolean>(false);
  readonly loggingIn = input<boolean>(false);

  readonly retry = output<void>();
  readonly openLog = output<void>();
  readonly login = output<void>();
  readonly cancelLogin = output<void>();
  readonly installed = output<void>();
  readonly locate = output<void>();

  protected readonly copied = signal<string | null>(null);

  protected readonly status = computed(() => this.live()?.agentStatus);
  protected readonly cantStartReason = computed(() => this.live()?.cantStartReason);
  protected readonly unconfirmedExit = computed(() => this.live()?.unconfirmedExit);
  protected readonly agentName = computed(() => this.live()?.agentName ?? $localize`Agent`);
  protected readonly unsupportedDetail = computed(
    () => this.live()?.cantStartDetail ?? $localize`${this.agentName()} isn't supported`,
  );
  protected readonly unverified = computed(
    () => this.status() === 'ready' && this.live()?.versionQualification === 'unverified',
  );
  protected readonly installedVersion = computed(() => this.live()?.installedVersion ?? '');
  protected readonly loginInstructions = computed(() => {
    const text = this.live()?.loginInstructions;
    return text !== undefined && text !== '' ? text : null;
  });
  protected readonly hasAuthMethods = computed(() => (this.live()?.authMethods?.length ?? 0) > 0);
  protected readonly upgradeCommand = computed(() => {
    const cmd = this.live()?.upgradeCommand;
    return cmd !== undefined && cmd !== '' ? cmd : null;
  });
  protected readonly visible = computed(() => {
    if (this.folderMissing() || this.unverified() || this.unconfirmedExit() !== undefined) {
      return true;
    }
    const status = this.status();
    return status === 'notInstalled' || status === 'cantStart' || status === 'needsLogin';
  });

  protected readonly installAgent = computed((): Agent | null => {
    const live = this.live();
    if (live === null) return null;
    return {
      id: live.agentId ?? AgentId.make('claude'),
      name: live.agentName ?? $localize`Agent`,
      installKind: live.installKind ?? 'npm',
      package: live.agentPackage ?? '',
      installed: false,
      qualifiedVersion: '',
      imageLimits: live.imageLimits,
      capabilities: live.capabilities ?? FALLBACK_CAPABILITIES,
      ...(live.installInstructions === undefined
        ? {}
        : { installInstructions: live.installInstructions }),
      ...(live.upgradeCommand === undefined ? {} : { upgradeCommand: live.upgradeCommand }),
    };
  });

  protected readonly updateCommand = computed(() => {
    if (this.live()?.installKind === 'native') return this.upgradeCommand();
    const pkg = this.live()?.agentPackage;
    return pkg !== undefined && pkg !== '' ? `npm install -g ${pkg}@latest` : this.upgradeCommand();
  });

  protected readonly otherWays = computed(() => {
    const methods = this.live()?.authMethods ?? [];
    const rest = methods.slice(1);
    if (rest.length > 0) return rest;
    return methods.filter((method) => method.command !== undefined);
  });

  private readonly runtime = inject(EffectRuntime);

  constructor() {
    effect((onCleanup) => {
      const outlet = this.installOutlet();
      const instance = outlet?.componentInstance as InstallOfferInstance | null | undefined;
      if (!instance?.installed) return;
      const sub = instance.installed.subscribe(() => this.installed.emit());
      onCleanup(() => sub.unsubscribe());
    });
  }

  protected async copy(command: string): Promise<void> {
    const exit = await this.runtime.run(copyToClipboard(command));
    if (Exit.isSuccess(exit)) this.copied.set(command);
  }
}
