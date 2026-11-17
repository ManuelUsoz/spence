import { computed, inject, Injectable, signal } from '@angular/core';
import { Effect } from 'effect';
import type { Agent } from '../../../../shared/agents/agents.rpc';
import type { Settings, SettingsPatch } from '../../../../shared/settings/settings.rpc';
import { DesktopApi } from '../../../core/desktop-api';
import { EffectRuntime } from '../../../core/effect-runtime';
import { toast } from '@ui/toast';
import { ProjectsState } from '../projects-state';
import { SettingsState } from '../settings-state';

export type SettingsView =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | {
      readonly status: 'loaded';
      readonly settings: Settings;
      readonly agents: ReadonlyArray<Agent>;
    };

const load = Effect.gen(function* () {
  const api = yield* DesktopApi;
  const [settings, agents] = yield* Effect.all([api['Settings.get'](), api['Agents.list']()], {
    concurrency: 'unbounded',
  });
  return { settings, agents };
});

const update = Effect.fnUntraced(function* (patch: SettingsPatch) {
  const api = yield* DesktopApi;
  return yield* api['Settings.update']({ patch });
});

const listAgents = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return yield* api['Agents.list']();
});

/**
 * What the Settings page shows and changes. Provided by the page, so every visit loads afresh. Every change
 * applies at once through `Settings.update`; the page then shows what main resolved.
 */
@Injectable()
export class SettingsStore {
  private readonly runtime = inject(EffectRuntime);
  private readonly projects = inject(ProjectsState);
  private readonly state = inject(SettingsState);

  readonly view = signal<SettingsView>({ status: 'loading' });
  readonly rescanning = signal(false);
  readonly loaded = computed(() => {
    const view = this.view();
    return view.status === 'loaded' ? view : null;
  });

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.view.set({ status: 'loading' });
    const exit = await this.runtime.run(load);
    if (exit._tag === 'Success') {
      this.view.set({ status: 'loaded', ...exit.value });
      this.state.sidebarLayoutChanged(exit.value.settings.sidebarLayout);
      this.projects.orderChanged(exit.value.settings.projectOrder);
    } else {
      this.view.set({ status: 'failed' });
    }
  }

  async change(patch: SettingsPatch): Promise<void> {
    const exit = await this.runtime.run(update(patch));
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not change the setting.`);
      await this.load();
      return;
    }
    const settings = exit.value;
    this.view.update((view) => (view.status === 'loaded' ? { ...view, settings } : view));
    if (patch.projectOrder !== undefined) this.projects.orderChanged(settings.projectOrder);
    if (patch.sidebarLayout !== undefined) this.state.sidebarLayoutChanged(settings.sidebarLayout);
  }

  async rescanAgents(): Promise<void> {
    if (this.rescanning()) return;
    this.rescanning.set(true);
    const exit = await this.runtime.run(listAgents);
    this.rescanning.set(false);
    if (exit._tag === 'Success') {
      this.view.update((view) =>
        view.status === 'loaded' ? { ...view, agents: exit.value } : view,
      );
    }
  }
}
