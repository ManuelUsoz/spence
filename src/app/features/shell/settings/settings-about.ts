import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Cause, Effect } from 'effect';
import { HlmButtonImports } from '@ui/button';
import { HlmAlertDialogImports } from '@ui/alert-dialog';
import { Keymap } from '../../../core/keymap';
import { toast } from '@ui/toast';
import type { AppInfo } from '../../../../shared/app-info/app-info.rpc';
import { DesktopApi } from '../../../core/desktop-api';
import { EffectRuntime } from '../../../core/effect-runtime';
import { SettingsRow } from './settings-row';

type AboutState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'loaded'; readonly info: AppInfo };

const getAppInfo = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return yield* api['AppInfo.get']();
});

/** About: which Spence this is. Read-only. */
@Component({
  selector: 'app-settings-about',
  imports: [SettingsRow, HlmButtonImports, HlmAlertDialogImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-alert-dialog
      [state]="confirming() ? 'open' : 'closed'"
      (stateChanged)="onDialogState($event)"
    >
      <hlm-alert-dialog-content *hlmAlertDialogPortal="let ctx">
        <hlm-alert-dialog-header>
          <h2 hlmAlertDialogTitle i18n>Restart and update Spence?</h2>
          <p hlmAlertDialogDescription i18n>Spence will close and install the downloaded update.</p>
        </hlm-alert-dialog-header>
        <hlm-alert-dialog-footer>
          <button hlmAlertDialogCancel (click)="confirming.set(false)" i18n>Cancel</button>
          <button hlmAlertDialogAction data-testid="update-confirm" (click)="install()" i18n>
            Restart and update
          </button>
        </hlm-alert-dialog-footer>
      </hlm-alert-dialog-content>
    </hlm-alert-dialog>
    @if (errorDetail(); as detail) {
      <section class="border-border/60 border-t py-3">
        <button hlmBtn variant="outline" size="sm" (click)="errorDetail.set(null)" i18n>
          Close details
        </button>
        <pre class="max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap">{{ detail }}</pre>
      </section>
    }
    <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>About</h2>
    @if (info(); as about) {
      <div data-testid="settings-about">
        <app-settings-row label="Version" i18n-label>
          <span class="font-mono text-xs">{{ about.name }} {{ about.version }}</span>
          @if (update() === 'available') {
            <button
              hlmBtn
              variant="outline"
              size="sm"
              data-testid="update-restart"
              (click)="confirming.set(true)"
              i18n
            >
              Restart and update
            </button>
          } @else {
            <button
              hlmBtn
              variant="outline"
              size="sm"
              data-testid="update-check"
              [disabled]="update() === 'checking'"
              (click)="check()"
              i18n
            >
              Check for updates
            </button>
          }
        </app-settings-row>
        @if (update() === 'checking') {
          <p class="text-muted-foreground py-2 text-xs" i18n>
            Checking for updates and downloading any available update…
          </p>
        }
        @if (update() === 'current') {
          <p class="text-muted-foreground py-2 text-xs" i18n>Spence is up to date.</p>
        }
        @if (update() === 'unsupported') {
          <p class="text-muted-foreground py-2 text-xs" i18n>
            Updates are available for installed Windows and Ubuntu builds.
          </p>
        }
        @if (update() === 'available') {
          <p class="text-muted-foreground py-2 text-xs" i18n>
            Version {{ updateVersion() }} is ready to install.
          </p>
        }
        <app-settings-row label="Electron" i18n-label>
          <span class="font-mono text-xs">{{ about.electron }}</span>
        </app-settings-row>
        <app-settings-row label="Platform" i18n-label>
          <span class="font-mono text-xs">{{ about.platform }}</span>
        </app-settings-row>
      </div>
    } @else if (state().status === 'failed') {
      <p class="text-muted-foreground border-border/60 border-t py-3 text-xs" i18n>
        Could not load app info.
      </p>
    }
  `,
})
export class SettingsAbout {
  private readonly runtime = inject(EffectRuntime);
  private readonly keymap = inject(Keymap);
  protected readonly confirming = signal(false);
  protected readonly updateVersion = signal('');
  protected readonly errorDetail = signal<string | null>(null);
  protected onDialogState(state: string): void {
    if (state === 'closed') this.confirming.set(false);
  }
  protected readonly update = signal<'idle' | 'checking' | 'available' | 'current' | 'unsupported'>(
    'idle',
  );

  protected async check(): Promise<void> {
    this.update.set('checking');
    const exit = await this.runtime.run(
      Effect.gen(function* () {
        const api = yield* DesktopApi;
        return yield* api['Update.check']();
      }),
    );
    if (exit._tag === 'Failure' || exit.value.status === 'failed') {
      this.update.set('idle');
      const detail = exit._tag === 'Failure' ? Cause.pretty(exit.cause) : exit.value.detail;
      toast.error($localize`Could not check for updates. Try again.`, {
        duration: 15000,
        action: { label: $localize`Retry`, onClick: () => void this.check() },
        cancel: { label: $localize`View details`, onClick: () => this.errorDetail.set(detail) },
      });
      return;
    }
    if (exit.value.status === 'available') this.updateVersion.set(exit.value.detail);
    this.update.set(exit.value.status);
  }

  protected async install(): Promise<void> {
    this.confirming.set(false);
    const exit = await this.runtime.run(
      Effect.gen(function* () {
        const api = yield* DesktopApi;
        return yield* api['Update.install']();
      }),
    );
    if (exit._tag === 'Failure') {
      const detail = Cause.pretty(exit.cause);
      toast.error($localize`Could not install the update. Try again.`, {
        duration: 15000,
        action: { label: $localize`Retry`, onClick: () => this.confirming.set(true) },
        cancel: { label: $localize`View details`, onClick: () => this.errorDetail.set(detail) },
      });
    }
  }
  protected readonly state = signal<AboutState>({ status: 'loading' });
  protected readonly info = computed(() => {
    const state = this.state();
    return state.status === 'loaded' ? state.info : null;
  });

  constructor() {
    effect((onCleanup) => {
      if (!this.confirming()) return;
      onCleanup(this.keymap.pushModal({ onEscape: () => this.confirming.set(false) }));
    });
    void this.load();
  }

  private async load(): Promise<void> {
    const exit = await this.runtime.run(getAppInfo);
    this.state.set(
      exit._tag === 'Success' ? { status: 'loaded', info: exit.value } : { status: 'failed' },
    );
  }
}
