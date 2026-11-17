import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Effect } from 'effect';
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
  imports: [SettingsRow],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>About</h2>
    @if (info(); as about) {
      <div data-testid="settings-about">
        <app-settings-row label="Version" i18n-label>
          <span class="font-mono text-xs">{{ about.name }} {{ about.version }}</span>
        </app-settings-row>
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
  protected readonly state = signal<AboutState>({ status: 'loading' });
  protected readonly info = computed(() => {
    const state = this.state();
    return state.status === 'loaded' ? state.info : null;
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    const exit = await this.runtime.run(getAppInfo);
    this.state.set(
      exit._tag === 'Success' ? { status: 'loaded', info: exit.value } : { status: 'failed' },
    );
  }
}
