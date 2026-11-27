import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmBadgeImports } from '@ui/badge';
import { HlmButtonImports } from '@ui/button';
import { HlmInputImports } from '@ui/input';
import { toast } from '@ui/toast';
import { Effect } from 'effect';
import type {
  DeviceFlowPrompt,
  GhCliStatus,
  HostAccount,
  HostAccountsState,
  HostAuthMethod,
  HostPersistMode,
} from '../../../../shared/pull-requests/pull-requests.rpc';
import { DesktopApi } from '../../../core/desktop-api';
import { EffectRuntime } from '../../../core/effect-runtime';
import { Keymap } from '../../../core/keymap';
import { SettingsRow } from './settings-row';

type GitHostsView =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'loaded'; readonly state: HostAccountsState };

const AUTH_METHOD_LABELS: Record<HostAuthMethod, string> = {
  'device-flow': $localize`OAuth Device Flow`,
  pat: $localize`Personal Access Token`,
  'gh-cli': $localize`GitHub CLI`,
};

const loadAccounts = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return yield* api['HostAuth.getAccounts']();
});

const checkGhCli = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return yield* api['HostAuth.checkGhCli']({ host: 'github' });
});

const startDeviceFlow = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return yield* api['HostAuth.startDeviceFlow']({ host: 'github' });
});

const pollDeviceFlow = (flowId: DeviceFlowPrompt['flowId'], persistMode: HostPersistMode) =>
  DesktopApi.use((api) => api['HostAuth.pollDeviceFlow']({ host: 'github', flowId, persistMode }));

const cancelDeviceFlow = (flowId: DeviceFlowPrompt['flowId']) =>
  DesktopApi.use((api) => api['HostAuth.cancelDeviceFlow']({ host: 'github', flowId }));

const connectPat = (token: string, persistMode: HostPersistMode) =>
  DesktopApi.use((api) => api['HostAuth.connectPat']({ host: 'github', token, persistMode }));

const importGhCli = (persistMode: HostPersistMode) =>
  DesktopApi.use((api) => api['HostAuth.importGhCli']({ host: 'github', persistMode }));

const verifyHost = DesktopApi.use((api) => api['HostAuth.verify']({ host: 'github' }));

const disconnectHost = DesktopApi.use((api) => api['HostAuth.disconnect']({ host: 'github' }));

const openExternalUrl = (url: string) =>
  DesktopApi.use((api) => api['Links.openExternal']({ url }));

/**
 * Git hosts: connect, verify, reconnect, and disconnect GitHub authentication in Settings.
 * Loads independently so a failure never hides other Settings sections.
 */
@Component({
  selector: 'app-settings-git-hosts',
  imports: [SettingsRow, HlmAlertDialogImports, HlmBadgeImports, HlmButtonImports, HlmInputImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-testid': 'settings-git-hosts' },
  template: `
    <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>Git hosts</h2>

    @switch (view().status) {
      @case ('loading') {
        <p class="text-muted-foreground border-border/60 border-t py-3 text-sm" i18n>Loading…</p>
      }
      @case ('failed') {
        <p
          class="text-destructive border-border/60 border-t py-3 text-sm"
          data-testid="git-hosts-failed"
          i18n
        >
          Could not load Git hosts.
        </p>
      }
    }

    @if (loaded(); as state) {
      @if (!state.secretStorageAvailable) {
        <div
          class="border-border/60 bg-muted/40 mb-3 rounded-lg border px-3 py-2.5 text-xs"
          data-testid="git-hosts-insecure-warning"
        >
          <p class="font-medium" i18n>OS secure storage is unavailable</p>
          <p class="text-muted-foreground mt-0.5" i18n>
            No OS keyring was detected (Linux basic_text fallback). Spence will not save tokens to
            disk. Connecting uses session-only in-memory storage until you quit Spence.
          </p>
        </div>
      }

      @if (githubAccount(); as account) {
        @if (!reconnecting()) {
          <div
            class="border-border/60 flex flex-wrap items-center justify-between gap-4 border-t py-3"
            data-testid="git-hosts-account"
          >
            <div class="flex min-w-0 items-center gap-3">
              @if (account.avatarUrl; as avatar) {
                <img
                  [src]="avatar"
                  [alt]="account.handle"
                  class="size-8 shrink-0 rounded-full object-cover"
                />
              } @else {
                <div
                  class="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium"
                >
                  {{ account.handle.slice(0, 1).toUpperCase() }}
                </div>
              }
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="truncate text-sm font-medium">
                    {{ account.displayName ?? account.handle }}
                  </span>
                  <span class="text-muted-foreground font-mono text-xs">
                    @{{ account.handle }}
                  </span>
                  <span hlmBadge variant="secondary">{{
                    authMethodLabel(account.authMethod)
                  }}</span>
                  @if (account.persistMode === 'session-only') {
                    <span hlmBadge variant="outline" i18n>Session-only</span>
                  }
                </div>
                <div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
                  @if (account.status === 'connected') {
                    <span class="text-muted-foreground" data-testid="git-hosts-status" i18n>
                      Connected
                    </span>
                  } @else {
                    <span class="text-destructive font-medium" data-testid="git-hosts-status" i18n>
                      Needs reconnect
                    </span>
                  }
                  @if (account.scopes.length > 0) {
                    <span class="text-muted-foreground font-mono text-xs">
                      {{ account.scopes.join(', ') }}
                    </span>
                  }
                </div>
                @if (account.status === 'needs-reconnect' && account.statusDetail) {
                  <p class="text-destructive mt-1 text-xs">{{ account.statusDetail }}</p>
                }
              </div>
            </div>

            <div class="flex shrink-0 items-center gap-2">
              <button
                hlmBtn
                type="button"
                variant="outline"
                size="sm"
                data-testid="git-hosts-verify"
                [disabled]="busy()"
                (click)="verify()"
                i18n
              >
                Verify
              </button>
              <button
                hlmBtn
                type="button"
                variant="outline"
                size="sm"
                data-testid="git-hosts-reconnect"
                [disabled]="busy()"
                (click)="beginReconnect()"
                i18n
              >
                Reconnect
              </button>
              <button
                hlmBtn
                type="button"
                variant="outline"
                size="sm"
                data-testid="git-hosts-disconnect"
                [disabled]="busy()"
                (click)="confirmDisconnect.set(true)"
                i18n
              >
                Disconnect
              </button>
            </div>
          </div>
        }
      }

      @if (githubAccount() === null || reconnecting()) {
        @if (reconnecting()) {
          <div class="border-border/60 flex items-center justify-between border-t py-2 text-xs">
            <span class="text-muted-foreground" i18n>Reconnect your GitHub account</span>
            <button hlmBtn type="button" variant="ghost" size="sm" (click)="cancelReconnect()" i18n>
              Cancel
            </button>
          </div>
        }

        @if (deviceFlow(); as flow) {
          <div
            class="border-border/60 bg-muted/30 my-2 flex flex-col gap-2.5 rounded-lg border p-3"
            data-testid="git-hosts-device-flow"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-medium" i18n>Enter this code on GitHub</span>
              <button
                hlmBtn
                type="button"
                variant="ghost"
                size="sm"
                data-testid="git-hosts-device-cancel"
                (click)="cancelDeviceSignIn()"
                i18n
              >
                Cancel
              </button>
            </div>
            <div class="flex items-center gap-3">
              <code
                class="bg-background rounded border px-2.5 py-1 font-mono text-sm tracking-wider"
                data-testid="git-hosts-device-code"
              >
                {{ flow.userCode }}
              </code>
              <button
                hlmBtn
                type="button"
                variant="outline"
                size="sm"
                (click)="copyUserCode(flow.userCode)"
                i18n
              >
                Copy code
              </button>
              <button
                hlmBtn
                type="button"
                size="sm"
                (click)="openVerificationUri(flow.verificationUri)"
                i18n
              >
                Open GitHub
              </button>
            </div>
            <p class="text-muted-foreground text-xs" i18n>Waiting for GitHub authorization…</p>
          </div>
        } @else {
          <app-settings-row
            label="GitHub OAuth"
            i18n-label
            hint="Sign in via your browser with repo and read:org access."
            i18n-hint
          >
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              data-testid="git-hosts-device-start"
              [disabled]="busy()"
              (click)="startDeviceSignIn()"
              i18n
            >
              Sign in with GitHub
            </button>
          </app-settings-row>

          <app-settings-row
            label="Personal access token"
            i18n-label
            hint="Classic PAT with repo and read:org scopes."
            i18n-hint
            controlId="git-hosts-pat-input"
          >
            <input
              hlmInput
              id="git-hosts-pat-input"
              type="password"
              class="h-8 w-52 font-mono text-xs"
              placeholder="ghp_…"
              data-testid="git-hosts-pat-input"
              [value]="patToken()"
              [disabled]="busy()"
              (input)="onPatInput($event)"
            />
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              data-testid="git-hosts-pat-submit"
              [disabled]="busy() || patToken().trim().length === 0"
              (click)="submitPat()"
              i18n
            >
              Connect
            </button>
          </app-settings-row>

          @if (ghCli(); as cli) {
            <app-settings-row label="GitHub CLI" i18n-label [hint]="ghCliHint(cli)">
              <button
                hlmBtn
                type="button"
                variant="outline"
                size="sm"
                data-testid="git-hosts-gh-import"
                [disabled]="busy() || !cli.available || !cli.authenticated"
                (click)="importFromGh()"
                i18n
              >
                Import from gh CLI
              </button>
            </app-settings-row>
          }
        }
      }
    }

    <hlm-alert-dialog
      [state]="confirmDisconnect() ? 'open' : 'closed'"
      (stateChanged)="onDisconnectDialogState($event)"
    >
      <hlm-alert-dialog-content
        *hlmAlertDialogPortal="let ctx"
        data-testid="git-hosts-disconnect-dialog"
      >
        @if (githubAccount(); as account) {
          <hlm-alert-dialog-header>
            <h2 hlmAlertDialogTitle class="text-lg font-medium" i18n>Disconnect GitHub account?</h2>
            <p hlmAlertDialogDescription i18n>
              This removes <span class="font-mono text-xs">@{{ account.handle }}</span> and clears
              cached Pull requests from this Device.
            </p>
          </hlm-alert-dialog-header>
          <hlm-alert-dialog-footer>
            <button
              hlmAlertDialogCancel
              data-testid="git-hosts-disconnect-cancel"
              (click)="confirmDisconnect.set(false)"
              i18n
            >
              Cancel
            </button>
            <button
              hlmAlertDialogAction
              variant="destructive"
              data-testid="git-hosts-disconnect-confirm"
              (click)="disconnect()"
              i18n
            >
              Disconnect
            </button>
          </hlm-alert-dialog-footer>
        }
      </hlm-alert-dialog-content>
    </hlm-alert-dialog>
  `,
})
export class SettingsGitHosts {
  private readonly runtime = inject(EffectRuntime);
  private readonly keymap = inject(Keymap);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly view = signal<GitHostsView>({ status: 'loading' });
  protected readonly ghCli = signal<GhCliStatus | null>(null);
  protected readonly busy = signal(false);
  protected readonly patToken = signal('');
  protected readonly reconnecting = signal(false);
  protected readonly deviceFlow = signal<DeviceFlowPrompt | null>(null);
  protected readonly confirmDisconnect = signal(false);

  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly loaded = computed<HostAccountsState | null>(() => {
    const current = this.view();
    return current.status === 'loaded' ? current.state : null;
  });

  protected readonly githubAccount = computed<HostAccount | null>(() => {
    const state = this.loaded();
    if (state === null) return null;
    return state.accounts.find((a) => a.host === 'github') ?? null;
  });

  private readonly persistMode = computed<HostPersistMode>(() => {
    const state = this.loaded();
    return state !== null && !state.secretStorageAvailable ? 'session-only' : 'secure';
  });

  constructor() {
    effect((onCleanup) => {
      if (!this.confirmDisconnect()) return;
      const release = this.keymap.pushModal({
        onEscape: () => this.confirmDisconnect.set(false),
      });
      onCleanup(release);
    });
    this.destroyRef.onDestroy(() => this.clearPollTimer());
    void this.load();
  }

  protected authMethodLabel(method: HostAuthMethod): string {
    return AUTH_METHOD_LABELS[method];
  }

  protected ghCliHint(cli: GhCliStatus): string {
    if (!cli.available) return $localize`gh CLI not found on Merged PATH.`;
    if (!cli.authenticated) return $localize`gh CLI found, but not signed in to github.com.`;
    return cli.handle !== null
      ? $localize`One-time import for @${cli.handle}:handle: via gh auth token.`
      : $localize`One-time import via gh auth token.`;
  }

  protected onPatInput(event: Event): void {
    this.patToken.set((event.target as HTMLInputElement).value);
  }

  protected beginReconnect(): void {
    this.reconnecting.set(true);
  }

  protected cancelReconnect(): void {
    this.reconnecting.set(false);
    this.clearPollTimer();
    this.deviceFlow.set(null);
  }

  protected onDisconnectDialogState(next: string): void {
    if (next === 'closed') this.confirmDisconnect.set(false);
  }

  private async load(): Promise<void> {
    const exit = await this.runtime.run(loadAccounts);
    if (exit._tag !== 'Success') {
      this.view.set({ status: 'failed' });
      return;
    }
    this.view.set({ status: 'loaded', state: exit.value });
    const cliExit = await this.runtime.run(checkGhCli);
    if (cliExit._tag === 'Success') {
      this.ghCli.set(cliExit.value);
    }
  }

  private setAccount(account: HostAccount): void {
    const state = this.loaded();
    if (state === null) return;
    const others = state.accounts.filter((a) => a.host !== account.host);
    this.view.set({
      status: 'loaded',
      state: { ...state, accounts: [...others, account] },
    });
    this.reconnecting.set(false);
  }

  protected async submitPat(): Promise<void> {
    const token = this.patToken().trim();
    if (token.length === 0) return;
    this.busy.set(true);
    const exit = await this.runtime.run(connectPat(token, this.persistMode()));
    this.busy.set(false);
    if (exit._tag === 'Success') {
      this.patToken.set('');
      this.setAccount(exit.value);
      toast.success($localize`Connected GitHub as @${exit.value.handle}:handle:.`);
      return;
    }
    toast.error(this.describeFailure(exit.cause));
  }

  protected async importFromGh(): Promise<void> {
    this.busy.set(true);
    const exit = await this.runtime.run(importGhCli(this.persistMode()));
    this.busy.set(false);
    if (exit._tag === 'Success') {
      this.setAccount(exit.value);
      toast.success($localize`Imported GitHub account @${exit.value.handle}:handle:.`);
      return;
    }
    toast.error(this.describeFailure(exit.cause));
  }

  protected async startDeviceSignIn(): Promise<void> {
    this.busy.set(true);
    const exit = await this.runtime.run(startDeviceFlow);
    this.busy.set(false);
    if (exit._tag !== 'Success') {
      toast.error(this.describeFailure(exit.cause));
      return;
    }
    const prompt = exit.value;
    this.deviceFlow.set(prompt);
    void this.openVerificationUri(prompt.verificationUri);
    this.schedulePoll(prompt.flowId, prompt.intervalSeconds);
  }

  protected async cancelDeviceSignIn(): Promise<void> {
    const flow = this.deviceFlow();
    this.clearPollTimer();
    this.deviceFlow.set(null);
    if (flow !== null) {
      await this.runtime.run(cancelDeviceFlow(flow.flowId));
    }
  }

  protected async copyUserCode(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      toast.success($localize`Copied code to clipboard.`);
    } catch {
      toast.error($localize`Could not copy code.`);
    }
  }

  protected async openVerificationUri(url: string): Promise<void> {
    await this.runtime.run(openExternalUrl(url));
  }

  private schedulePoll(flowId: DeviceFlowPrompt['flowId'], intervalSeconds: number): void {
    this.clearPollTimer();
    this.pollTimer = setTimeout(() => {
      void this.runPoll(flowId);
    }, intervalSeconds * 1_000);
  }

  private async runPoll(flowId: DeviceFlowPrompt['flowId']): Promise<void> {
    const active = this.deviceFlow();
    if (active === null || active.flowId !== flowId) return;
    const exit = await this.runtime.run(pollDeviceFlow(flowId, this.persistMode()));
    if (exit._tag !== 'Success') {
      this.deviceFlow.set(null);
      toast.error(this.describeFailure(exit.cause));
      return;
    }
    if (exit.value.status === 'complete') {
      this.deviceFlow.set(null);
      this.setAccount(exit.value.account);
      toast.success($localize`Connected GitHub as @${exit.value.account.handle}:handle:.`);
      return;
    }
    this.schedulePoll(flowId, exit.value.intervalSeconds);
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  protected async verify(): Promise<void> {
    this.busy.set(true);
    const exit = await this.runtime.run(verifyHost);
    this.busy.set(false);
    if (exit._tag === 'Success') {
      this.setAccount(exit.value);
      if (exit.value.status === 'connected') {
        toast.success($localize`GitHub connection verified.`);
      } else {
        toast.error(exit.value.statusDetail ?? $localize`GitHub account needs reconnect.`);
      }
      return;
    }
    toast.error(this.describeFailure(exit.cause));
  }

  protected async disconnect(): Promise<void> {
    this.confirmDisconnect.set(false);
    this.busy.set(true);
    const exit = await this.runtime.run(disconnectHost);
    this.busy.set(false);
    if (exit._tag === 'Success') {
      const state = this.loaded();
      if (state !== null) {
        this.view.set({
          status: 'loaded',
          state: { ...state, accounts: state.accounts.filter((a) => a.host !== 'github') },
        });
      }
      toast.success($localize`Disconnected GitHub account.`);
      return;
    }
    toast.error(this.describeFailure(exit.cause));
  }

  private describeFailure(cause: unknown): string {
    const text = String(cause);
    const match = /"detail":"([^"]+)"/.exec(text);
    return match?.[1] ?? $localize`GitHub authentication failed.`;
  }
}
