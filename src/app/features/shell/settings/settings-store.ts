import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { Effect } from 'effect';
import type { Agent, AgentId } from '../../../../shared/agents/agents.rpc';
import type { DeviceId } from '../../../../shared/devices/devices.rpc';
import type {
  ExecutionSettings,
  ExecutionSettingsPatch,
  Settings,
  SettingsPatch,
} from '../../../../shared/settings/settings.rpc';
import { DesktopApi } from '../../../core/desktop-api';
import { AgentInstallTracker } from '../../../core/agent-install-tracker';
import { ChatBackgrounds } from '../../../core/chat-backgrounds';
import { FontPresets } from '../../../core/font-presets';
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

const rescanAgents = (device: DeviceId | undefined) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    return yield* api['Agents.rescan']();
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
  private readonly fonts = inject(FontPresets);
  private readonly installTracker = inject(AgentInstallTracker);
  private readonly _device = signal<DeviceId | undefined>(undefined);
  private readonly remote = signal<ExecutionView>({ status: 'loading' });
  private activeRescan: Promise<void> | null = null;
  private rescanQueued = false;

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
      this.installTracker.reconcile(undefined, exit.value.agents);
      this.projects.orderChanged(exit.value.settings.projectOrder);
      this.chatBackgrounds.applySettings(exit.value.settings);
      this.fonts.apply(exit.value.settings.fontPreset);
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
    if (exit._tag === 'Success') {
      this.remote.set({ status: 'loaded', ...exit.value });
      this.installTracker.reconcile(device, exit.value.agents);
    } else {
      this.remote.set({ status: 'failed' });
    }
  }

  async change(patch: SettingsPatch): Promise<boolean> {
    const exit = await this.runtime.run(update(patch));
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not change the setting.`);
      await this.load();
      return false;
    }
    const settings = exit.value;
    this.view.update((view) => (view.status === 'loaded' ? { ...view, settings } : view));
    if (patch.projectOrder !== undefined) this.projects.orderChanged(settings.projectOrder);
    this.chatBackgrounds.applySettings(settings);
    this.fonts.apply(settings.fontPreset);
    return true;
  }

  /** Changes an execution Setting of the Device the sections are about. */
  async changeExecution(patch: ExecutionSettingsPatch): Promise<boolean> {
    const device = this._device();
    if (device === undefined) return this.change(patch);
    const exit = await this.runtime.run(updateExecution(patch, device));
    if (this._device() !== device) return false;
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not change the setting.`);
      await this.loadRemote(device);
      return false;
    }
    const settings = exit.value;
    this.remote.update((view) => (view.status === 'loaded' ? { ...view, settings } : view));
    return true;
  }

  /** Sets or clears a native Agent's explicit binary path override and re-inspects Agents on the active Device. */
  async setAgentBinaryPath(agentId: AgentId, binaryPath: string | null): Promise<boolean> {
    const device = this._device();
    const ok = await this.changeExecution({ agents: { [agentId]: { binaryPath } } });
    if (!ok || this._device() !== device) return false;
    const exit = await this.runtime.run(listAgents(device));
    if (exit._tag === 'Success' && this._device() === device) {
      this.applyAgents(device, exit.value);
    }
    return true;
  }

  async rescanAgents(): Promise<void> {
    if (this.activeRescan !== null) {
      this.rescanQueued = true;
      return this.activeRescan;
    }
    this.activeRescan = this.runRescanLoop();
    return this.activeRescan;
  }

  private async runRescanLoop(): Promise<void> {
    this.rescanning.set(true);
    try {
      do {
        this.rescanQueued = false;
        const device = this._device();
        const exit = await this.runtime.run(rescanAgents(device));
        if (exit._tag === 'Success' && this._device() === device) {
          this.applyAgents(device, exit.value);
        }
      } while (this.rescanQueued);
    } finally {
      this.rescanning.set(false);
      this.activeRescan = null;
    }
  }

  private applyAgents(device: DeviceId | undefined, agents: ReadonlyArray<Agent>): void {
    this.installTracker.reconcile(device, agents);
    if (device === undefined) {
      this.view.update((view) => (view.status === 'loaded' ? { ...view, agents } : view));
    } else {
      this.remote.update((view) => (view.status === 'loaded' ? { ...view, agents } : view));
    }
  }
}
