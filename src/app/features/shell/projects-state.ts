import { Injectable, LOCALE_ID, computed, effect, inject, signal, untracked } from '@angular/core';
import { toast } from '@ui/toast';
import { Effect } from 'effect';
import type { DeviceId } from '../../../shared/devices/devices.rpc';
import type { Project, ProjectId, ProjectsError } from '../../../shared/projects/projects.rpc';
import type { ProjectOrder } from '../../../shared/settings/settings.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { onDevice } from '../../core/device-scope';
import { EffectRuntime } from '../../core/effect-runtime';
import { RemoteDevices } from '../../core/remote-devices';
import { FolderBrowserState } from './folder-browser-state';

const hasRunningTurns = (projectId: ProjectId, device: DeviceId | undefined) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    const sessions = yield* api['Session.list']({ projectId });
    return sessions.some(
      (session) =>
        session.archivedAt === undefined &&
        (session.status === 'working' || session.status === 'blocked'),
    );
  }).pipe(onDevice(device));

/** A Project with the Device it belongs to: absent for the Local device. Projects never merge across Devices. */
export type DeviceProject = Project & { readonly device?: DeviceId };

/** The Projects of one Device, for the selector: the Local device first, then each connected Remote device. */
export interface DeviceGroup {
  /** `undefined` for the Local device. */
  readonly device: DeviceId | undefined;
  /** The Remote device's name; `null` for the Local device. */
  readonly name: string | null;
  readonly status: ProjectsLoad['status'];
  readonly projects: ReadonlyArray<DeviceProject>;
}

export type ProjectsLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'loaded'; readonly projects: ReadonlyArray<Project> };

type AddResult =
  | { readonly kind: 'added'; readonly project: Project }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'alreadyAdded'; readonly name: string };

const listProjects = (device?: DeviceId) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    return yield* api['Projects.list']();
  }).pipe(onDevice(device));

const getProjectOrder = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return (yield* api['Settings.get']()).projectOrder;
});

/** The Project order Setting's default, used until Settings has loaded. */
const LAST_USED_FIRST: ProjectOrder = { by: 'lastUsed', direction: 'desc' };

const toAddResult = (project: Project | null): AddResult =>
  project === null ? { kind: 'cancelled' } : { kind: 'added', project };

/** A folder that is already a Project is a result to show; any other refusal is not something to act on. */
const alreadyAdded = (error: ProjectsError): Effect.Effect<AddResult> =>
  error.reason === 'AlreadyAdded'
    ? Effect.succeed({ kind: 'alreadyAdded', name: error.detail })
    : Effect.die(error);

const addProject = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return toAddResult(yield* api['Projects.add']());
}).pipe(Effect.catchTag('ProjectsError', alreadyAdded));

const addFolder = (path: string, device: DeviceId) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    return toAddResult(yield* api['Projects.addFolder']({ path }));
  }).pipe(Effect.catchTag('ProjectsError', alreadyAdded), onDevice(device));

const renameProject = (id: ProjectId, name: string, device: DeviceId | undefined) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    return yield* api['Projects.rename']({ id, name });
  }).pipe(onDevice(device));

const locateProject = Effect.fnUntraced(function* (id: ProjectId) {
  const api = yield* DesktopApi;
  return yield* api['Projects.locate']({ id });
});

const locateFolder = (id: ProjectId, path: string, device: DeviceId) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    return yield* api['Projects.locateFolder']({ id, path });
  }).pipe(onDevice(device));

const removeProjectRpc = (id: ProjectId, device: DeviceId | undefined) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    yield* api['Projects.remove']({ id });
  }).pipe(onDevice(device));

/**
 * The active Projects of the Local device, loaded once at startup (each folder checked then), and adding one; and the
 * Projects of every connected Remote device, loaded when it connects and dropped when it goes.
 */
@Injectable({ providedIn: 'root' })
export class ProjectsState {
  private readonly runtime = inject(EffectRuntime);
  private readonly devices = inject(RemoteDevices);
  private readonly folders = inject(FolderBrowserState);
  private readonly _state = signal<ProjectsLoad>({ status: 'loading' });
  private readonly _remote = signal<ReadonlyMap<DeviceId, ProjectsLoad>>(new Map());
  /** Last known Remote Projects by id so an open Workspace keeps its name/Device while Offline or Reconnecting. */
  private readonly seenRemote = new Map<ProjectId, DeviceProject>();
  private readonly order = signal<ProjectOrder>(LAST_USED_FIRST);
  /** Names sort in the UI locale's collation, case-insensitive and numeric (spec 7.1). */
  private readonly collator = new Intl.Collator(inject(LOCALE_ID), {
    sensitivity: 'base',
    numeric: true,
  });

  /** The Local device's Projects. */
  readonly state = this._state.asReadonly();
  readonly projectOrder = this.order.asReadonly();
  /** The selector's groups: the Local device first, then the connected Remote devices, each in Project order. */
  readonly groups = computed((): ReadonlyArray<DeviceGroup> => {
    const local = this._state();
    const remote = this._remote();
    return [
      {
        device: undefined,
        name: null,
        status: local.status,
        projects: local.status === 'loaded' ? this.sort(local.projects) : [],
      },
      ...this.devices.online().map((device): DeviceGroup => {
        const load = remote.get(device.id) ?? { status: 'loading' };
        return {
          device: device.id,
          name: device.name,
          status: load.status,
          projects:
            load.status === 'loaded'
              ? this.sort(load.projects.map((project) => ({ ...project, device: device.id })))
              : [],
        };
      }),
    ];
  });
  /** The loaded Projects of every Device, grouped by Device, each group in Project order (the Setting). */
  readonly ordered = computed((): ReadonlyArray<DeviceProject> =>
    this.groups().flatMap((group) => group.projects),
  );
  /** Whether any connected Remote device is shown, so the selector names the Devices. */
  readonly hasRemote = computed(() => this.devices.online().length > 0);

  private sort<P extends Project>(projects: ReadonlyArray<P>): ReadonlyArray<P> {
    const { by, direction } = this.order();
    const sign = direction === 'asc' ? 1 : -1;
    return [...projects].sort((a, b) => {
      const primary =
        by === 'name'
          ? sign * this.collator.compare(a.name, b.name)
          : sign * (a.lastUsedAt - b.lastUsedAt);
      if (primary !== 0) return primary;
      return by === 'name' ? b.lastUsedAt - a.lastUsedAt : this.collator.compare(a.name, b.name);
    });
  }

  /** The Device a listed or previously seen Project belongs to; `undefined` for the Local device (or an unknown Project). */
  deviceOf(id: ProjectId): DeviceId | undefined {
    return this.known(id)?.device;
  }

  /** Resolves a Project from active groups, or the last known Remote Project metadata while its Device is offline. */
  known(id: ProjectId): DeviceProject | undefined {
    return this.ordered().find((project) => project.id === id) ?? this.seenRemote.get(id);
  }

  /** The Local device's Project used last, whatever the Project order. */
  readonly lastUsed = computed((): Project | null => {
    const state = this._state();
    if (state.status !== 'loaded') return null;
    return state.projects.reduce<Project | null>(
      (last, project) => (last === null || project.lastUsedAt > last.lastUsedAt ? project : last),
      null,
    );
  });

  constructor() {
    void this.load();
    void this.loadOrder();
    effect(() => {
      const online = this.devices.online().map((device) => device.id);
      untracked(() => this.followRemote(online));
    });
  }

  /** Loads the Projects of Remote devices that just connected; forgets the ones of Devices gone. */
  private followRemote(online: ReadonlyArray<DeviceId>): void {
    const known = this._remote();
    const kept = new Map([...known].filter(([device]) => online.includes(device)));
    if (kept.size !== known.size) this._remote.set(kept);
    for (const device of online) {
      if (!known.has(device)) void this.loadRemote(device);
    }
  }

  private async loadRemote(device: DeviceId): Promise<void> {
    this._remote.update((current) => new Map(current).set(device, { status: 'loading' }));
    const exit = await this.runtime.run(listProjects(device));
    if (!this.devices.isOnline(device)) return;
    if (exit._tag === 'Success') {
      for (const project of exit.value) this.seenRemote.set(project.id, { ...project, device });
    }
    this._remote.update((current) =>
      new Map(current).set(
        device,
        exit._tag === 'Success' ? { status: 'loaded', projects: exit.value } : { status: 'failed' },
      ),
    );
  }

  /** Changes the loaded Projects of a connected Remote device. */
  private updateRemote(
    device: DeviceId,
    change: (projects: ReadonlyArray<Project>) => ReadonlyArray<Project>,
  ): void {
    this._remote.update((current) => {
      const load = current.get(device);
      if (load?.status !== 'loaded') return current;
      const updated = change(load.projects);
      for (const project of updated) this.seenRemote.set(project.id, { ...project, device });
      return new Map(current).set(device, { status: 'loaded', projects: updated });
    });
  }

  /** The Settings page changed the Project order. */
  orderChanged(order: ProjectOrder): void {
    this.order.set(order);
  }

  /** Keeps the default order when Settings cannot be read: the Project list matters more than its order. */
  private async loadOrder(): Promise<void> {
    const exit = await this.runtime.run(getProjectOrder);
    if (exit._tag === 'Success') this.order.set(exit.value);
  }

  async load(): Promise<void> {
    this._state.set({ status: 'loading' });
    const exit = await this.runtime.run(listProjects());
    this._state.set(
      exit._tag === 'Success' ? { status: 'loaded', projects: exit.value } : { status: 'failed' },
    );
  }

  /** Replaces a Project with the one main returned after a change (e.g. `Projects.setSettings`). */
  changed(project: Project): void {
    const replace = (state: ProjectsLoad): ProjectsLoad =>
      state.status === 'loaded'
        ? {
            status: 'loaded',
            projects: state.projects.map((p) => (p.id === project.id ? project : p)),
          }
        : state;
    const device = this.deviceOf(project.id);
    if (device === undefined) this._state.update(replace);
    else {
      this.seenRemote.set(project.id, { ...project, device });
      this._remote.update((current) => {
        const load = current.get(device);
        return load === undefined ? current : new Map(current).set(device, replace(load));
      });
    }
  }

  /**
   * Asks for a folder and adds it, returning the new Project; a folder that is already a Project shows a toast. The
   * Local device asks with the native folder picker, a Remote device with the in-app folder browser over its disk.
   */
  async add(device?: DeviceId): Promise<DeviceProject | null> {
    let run: Effect.Effect<AddResult, unknown, DesktopApi> = addProject;
    if (device !== undefined) {
      const folder = await this.folders.pick({
        device,
        title: $localize`Add a Project on ${this.devices.nameOf(device) ?? ''}:device:`,
        start: null,
      });
      if (folder === null) return null;
      run = addFolder(folder, device);
    }
    const exit = await this.runtime.run(run);
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not add the folder.`);
      return null;
    }
    const result = exit.value;
    switch (result.kind) {
      case 'added':
        if (device !== undefined) {
          this.updateRemote(device, (projects) => [...projects, result.project]);
          return { ...result.project, device };
        }
        this._state.update((state) =>
          state.status === 'loaded'
            ? { status: 'loaded', projects: [...state.projects, result.project] }
            : state,
        );
        if (this._state().status !== 'loaded') await this.load();
        return result.project;
      case 'alreadyAdded':
        toast($localize`This folder is already in Spence as ${result.name}:name:.`);
        return null;
      case 'cancelled':
        return null;
    }
  }

  async rename(id: ProjectId, name: string): Promise<boolean> {
    const exit = await this.runtime.run(renameProject(id, name, this.deviceOf(id)));
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not rename the Project.`);
      return false;
    }
    this.changed(exit.value);
    return true;
  }

  /**
   * Points a Project at its moved folder: the native folder picker for the Local device, the in-app folder browser
   * (from the folder above the old one) for a Remote device.
   */
  async locate(id: ProjectId): Promise<Project | null> {
    const device = this.deviceOf(id);
    let run: Effect.Effect<Project | null, unknown, DesktopApi> = locateProject(id);
    if (device !== undefined) {
      const project = this.ordered().find((p) => p.id === id);
      const folder = await this.folders.pick({
        device,
        title: $localize`Locate the folder of ${project?.name ?? ''}:project:`,
        start: null,
      });
      if (folder === null) return null;
      run = locateFolder(id, folder, device);
    }
    const exit = await this.runtime.run(run);
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not locate the folder.`);
      return null;
    }
    if (exit.value !== null) this.changed(exit.value);
    return exit.value;
  }

  /**
   * Forgets a Project, keeping its Sessions. When `confirmRunning` is provided and any Turn is currently running
   * in it, `confirmRunning` must return `true` before proceeding; main cancels those Turns and `Shell` closes
   * its open Tabs.
   */
  async remove(id: ProjectId, confirmRunning?: () => Promise<boolean> | boolean): Promise<boolean> {
    if (confirmRunning !== undefined) {
      const runningExit = await this.runtime.run(hasRunningTurns(id, this.deviceOf(id)));
      if (runningExit._tag === 'Failure') {
        toast.error($localize`Could not check running Sessions.`);
        return false;
      }
      if (runningExit.value && !(await confirmRunning())) return false;
    }

    const device = this.deviceOf(id);
    const removeExit = await this.runtime.run(removeProjectRpc(id, device));
    if (removeExit._tag === 'Failure') {
      toast.error($localize`Could not remove the Project.`);
      return false;
    }
    const without = (state: ProjectsLoad): ProjectsLoad =>
      state.status === 'loaded'
        ? { status: 'loaded', projects: state.projects.filter((p) => p.id !== id) }
        : state;
    if (device === undefined) this._state.update(without);
    else {
      this._remote.update((current) => {
        const load = current.get(device);
        return load === undefined ? current : new Map(current).set(device, without(load));
      });
    }
    return true;
  }
}
