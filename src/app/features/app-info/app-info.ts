import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Effect } from 'effect';
import { HlmButtonImports } from '@ui/button';
import type { AppInfo } from '../../../shared/app-info/app-info.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';

type LoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly detail: string }
  | { readonly status: 'loaded'; readonly info: AppInfo };

const getAppInfo = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return yield* api['AppInfo.get']();
});

/** Reference feature: reads `AppInfo` through `DesktopApi`. Copy this shape for new features. */
@Component({
  selector: 'app-app-info',
  imports: [HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button hlmBtn data-testid="load-info" (click)="load()">Load app info</button>
    @switch (state().status) {
      @case ('failed') {
        <p class="text-destructive" data-testid="info-error">Could not load app info.</p>
      }
      @case ('loading') {
        <p class="text-muted-foreground">Loading…</p>
      }
    }
    @if (loaded(); as info) {
      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="info">
        <dt class="text-muted-foreground">Name</dt>
        <dd>{{ info.name }} {{ info.version }}</dd>
        <dt class="text-muted-foreground">Electron</dt>
        <dd>{{ info.electron }}</dd>
        <dt class="text-muted-foreground">Platform</dt>
        <dd>{{ info.platform }}</dd>
      </dl>
    }
  `,
})
export class AppInfoView {
  private readonly runtime = inject(EffectRuntime);
  protected readonly state = signal<LoadState>({ status: 'idle' });

  protected loaded(): AppInfo | null {
    const s = this.state();
    return s.status === 'loaded' ? s.info : null;
  }

  protected async load(): Promise<void> {
    this.state.set({ status: 'loading' });
    const exit = await this.runtime.run(getAppInfo);
    this.state.set(
      exit._tag === 'Success'
        ? { status: 'loaded', info: exit.value }
        : { status: 'failed', detail: String(exit.cause) },
    );
  }
}
