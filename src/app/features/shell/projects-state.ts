import { Injectable, LOCALE_ID, computed, inject, signal } from '@angular/core';
import { toast } from '@ui/toast';
import { Effect } from 'effect';
import type { Project, ProjectId } from '../../../shared/projects/projects.rpc';
import type { ProjectOrder } from '../../../shared/settings/settings.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';

export type ProjectsLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'loaded'; readonly projects: ReadonlyArray<Project> };

type AddResult =
  | { readonly kind: 'added'; readonly project: Project }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'alreadyAdded'; readonly name: string };

const listProjects = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return yield* api['Projects.list']();
});

const getProjectOrder = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return (yield* api['Settings.get']()).projectOrder;
});

/** The Project order Setting's default, used until Settings has loaded. */
const LAST_USED_FIRST: ProjectOrder = { by: 'lastUsed', direction: 'desc' };

const addProject = Effect.gen(function* () {
  const api = yield* DesktopApi;
  const project = yield* api['Projects.add']();
  return project === null
    ? ({ kind: 'cancelled' } as const)
    : ({ kind: 'added', project } as const);
}).pipe(
  Effect.catchTag('ProjectsError', (error): Effect.Effect<AddResult> =>
    error.reason === 'AlreadyAdded'
      ? Effect.succeed({ kind: 'alreadyAdded', name: error.detail })
      : Effect.die(error),
  ),
);

const renameProject = Effect.fnUntraced(function* (id: ProjectId, name: string) {
  const api = yield* DesktopApi;
  return yield* api['Projects.rename']({ id, name });
});

const locateProject = Effect.fnUntraced(function* (id: ProjectId) {
  const api = yield* DesktopApi;
  return yield* api['Projects.locate']({ id });
});

const removeProjectRpc = Effect.fnUntraced(function* (id: ProjectId) {
  const api = yield* DesktopApi;
  yield* api['Projects.remove']({ id });
});

/** The active Projects, loaded once at startup (each folder checked then), and adding one. */
@Injectable({ providedIn: 'root' })
export class ProjectsState {
  private readonly runtime = inject(EffectRuntime);
  private readonly _state = signal<ProjectsLoad>({ status: 'loading' });
  private readonly order = signal<ProjectOrder>(LAST_USED_FIRST);
  /** Names sort in the UI locale's collation, case-insensitive and numeric (spec 7.1). */
  private readonly collator = new Intl.Collator(inject(LOCALE_ID), {
    sensitivity: 'base',
    numeric: true,
  });

  readonly state = this._state.asReadonly();
  readonly projectOrder = this.order.asReadonly();
  /** The loaded Projects in Project order (the Setting). */
  readonly ordered = computed((): ReadonlyArray<Project> => {
    const state = this._state();
    if (state.status !== 'loaded') return [];
    const { by, direction } = this.order();
    const sign = direction === 'asc' ? 1 : -1;
    return [...state.projects].sort((a, b) => {
      const primary =
        by === 'name'
          ? sign * this.collator.compare(a.name, b.name)
          : sign * (a.lastUsedAt - b.lastUsedAt);
      if (primary !== 0) return primary;
      return by === 'name' ? b.lastUsedAt - a.lastUsedAt : this.collator.compare(a.name, b.name);
    });
  });
  /** The Project used last, whatever the Project order. */
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
  }

  /** The Settings dialog changed the Project order. */
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
    const exit = await this.runtime.run(listProjects);
    this._state.set(
      exit._tag === 'Success' ? { status: 'loaded', projects: exit.value } : { status: 'failed' },
    );
  }

  /** Replaces a Project with the one main returned after a change (e.g. `Projects.setSettings`). */
  changed(project: Project): void {
    this._state.update((state) =>
      state.status === 'loaded'
        ? {
            status: 'loaded',
            projects: state.projects.map((p) => (p.id === project.id ? project : p)),
          }
        : state,
    );
  }

  /**
   * Opens the folder picker and adds the folder, returning the new Project; a folder that is already a Project shows
   * a toast.
   */
  async add(): Promise<Project | null> {
    const exit = await this.runtime.run(addProject);
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not add the folder.`);
      return null;
    }
    const result = exit.value;
    switch (result.kind) {
      case 'added':
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
    const exit = await this.runtime.run(renameProject(id, name));
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not rename the Project.`);
      return false;
    }
    this.changed(exit.value);
    return true;
  }

  async locate(id: ProjectId): Promise<Project | null> {
    const exit = await this.runtime.run(locateProject(id));
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not locate the folder.`);
      return null;
    }
    if (exit.value !== null) this.changed(exit.value);
    return exit.value;
  }

  async remove(id: ProjectId): Promise<boolean> {
    const exit = await this.runtime.run(removeProjectRpc(id));
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not remove the Project.`);
      return false;
    }
    this._state.update((state) =>
      state.status === 'loaded'
        ? { status: 'loaded', projects: state.projects.filter((p) => p.id !== id) }
        : state,
    );
    return true;
  }
}
