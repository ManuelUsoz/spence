import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { Effect } from 'effect';
import type { Agent } from '../../../../shared/agents/agents.rpc';
import type { DeviceId } from '../../../../shared/devices/devices.rpc';
import type {
  ExecutionSettings,
  ExecutionSettingsPatch,
  Settings,
  SettingsPatch,
} from '../../../../shared/settings/settings.rpc';
import { DesktopApi } from '../../../core/desktop-api';
import { ChatBackgrounds } from '../../../core/chat-backgrounds';
import { onDevice } from '../../../core/device-scope';
import { EffectRuntime } from '../../../core/effect-runtime';
import { RemoteDevices } from '../../../core/remote-devices';
import { toast } from '@ui/toast';
import { ProjectsState } from '../projects-state';

export type SettingsView =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | {
      readonly status: 'loaded';
      readonly settings: Settings;
      readonly agents: ReadonlyArray<Agent>;
    };

/** The execution Settings and Agents of the Device the Sessions and Agents sections are about. */
export type ExecutionView =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | {
      readonly status: 'loaded';
      readonly settings: ExecutionSettings;
      readonly agents: ReadonlyArray<Agent>;
    };

const load = Effect.gen(function* () {
  const api = yield* DesktopApi;
  const [settings, agents] = yield* Effect.all([api['Settings.get'](), api['Agents.list']()], {
    concurrency: 'unbounded',
  });
  return { settings, agents };
});

const loadExecution = (device: DeviceId) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    const [settings, agents] = yield* Effect.all(
      [api['ExecutionSettings.get'](), api['Agents.list']()],
      { concurrency: 'unbounded' },
    );
    return { settings, agents };
  }).pipe(onDevice(device));

const update = Effect.fnUntraced(function* (patch: SettingsPatch) {
  const api = yield* DesktopApi;
  return yield* api['Settings.update']({ patch });
});

const updateExecution = (patch: ExecutionSettingsPatch, device: DeviceId) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    return yield* api['ExecutionSettings.update']({ patch });
  }).pipe(onDevice(device));

const listAgents = (device: DeviceId | undefined) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    return yield* api['Agents.list']();
  }).pipe(onDevice(device));

/**
 * What the Settings page shows and changes. Provided by the page, so every visit loads afresh. Every change
 * applies at once through `Settings.update`; the page then shows what main resolved.
 *
 * The Sessions and Agents sections are about one Device (`device`, the Local one by default): a connected Remote
 * device's execution Settings and Agents are read and changed on it. Everything else stays the Local device's.
 */
@Injectable()
export class SettingsStore {
  private readonly runtime = inject(EffectRuntime);
  private readonly projects = inject(ProjectsState);
  private readonly devices = inject(RemoteDevices);
  private readonly chatBackgrounds = inject(ChatBackgrounds);
  private readonly _device = signal<DeviceId | undefined>(undefined);
  private readonly remote = signal<ExecutionView>({ status: 'loading' });

  readonly view = signal<SettingsView>({ status: 'loading' });
  readonly rescanning = signal(false);
  readonly loaded = computed(() => {
    const view = this.view();
    return view.status === 'loaded' ? view : null;
  });
  /** The Device the Sessions and Agents sections are about; `undefined` for the Local device. */
  readonly device = this._device.asReadonly();
  /** That Device's execution Settings and Agents. */
  readonly execution = computed((): ExecutionView => {
    if (this._device() !== undefined) return this.remote();
    const view = this.view();
    return view.status === 'loaded'
      ? { status: 'loaded', settings: view.settings, agents: view.agents }
      : view;
  });
  readonly executionLoaded = computed(() => {
    const view = this.execution();
    return view.status === 'loaded' ? view : null;
  });

  constructor() {
    void this.load();
    // A Remote device that goes away takes the sections back to the Local device.
    effect(() => {
      const device = this._device();
      if (device !== undefined && !this.devices.isOnline(device)) {
        untracked(() => this._device.set(undefined));
      }
    });
  }

  async load(): Promise<void> {
    this.view.set({ status: 'loading' });
    const exit = await this.runtime.run(load);
    if (exit._tag === 'Success') {
      this.view.set({ status: 'loaded', ...exit.value });
      this.projects.orderChanged(exit.value.settings.projectOrder);
      this.chatBackgrounds.applySettings(exit.value.settings);
    } else {
      this.view.set({ status: 'failed' });
    }
  }

  /** Shows the Sessions and Agents sections for `device` (`undefined`: the Local device). */
  async selectDevice(device: DeviceId | undefined): Promise<void> {
    this._device.set(device);
    if (device !== undefined) await this.loadRemote(device);
  }

  private async loadRemote(device: DeviceId): Promise<void> {
    this.remote.set({ status: 'loading' });
    const exit = await this.runtime.run(loadExecution(device));
    if (this._device() !== device) return;
    this.remote.set(
      exit._tag === 'Success' ? { status: 'loaded', ...exit.value } : { status: 'failed' },
    );
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
    this.chatBackgrounds.applySettings(settings);
  }

  /** Changes an execution Setting of the Device the sections are about. */
  async changeExecution(patch: ExecutionSettingsPatch): Promise<void> {
    const device = this._device();
    if (device === undefined) return this.change(patch);
    const exit = await this.runtime.run(updateExecution(patch, device));
    if (this._device() !== device) return;
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not change the setting.`);
      await this.loadRemote(device);
      return;
    }
    const settings = exit.value;
    this.remote.update((view) => (view.status === 'loaded' ? { ...view, settings } : view));
  }

  async rescanAgents(): Promise<void> {
    if (this.rescanning()) return;
    const device = this._device();
    this.rescanning.set(true);
    const exit = await this.runtime.run(listAgents(device));
    this.rescanning.set(false);
    if (exit._tag !== 'Success' || this._device() !== device) return;
    const agents = exit.value;
    if (device === undefined) {
      this.view.update((view) => (view.status === 'loaded' ? { ...view, agents } : view));
    } else {
      this.remote.update((view) => (view.status === 'loaded' ? { ...view, agents } : view));
    }
  }
}
