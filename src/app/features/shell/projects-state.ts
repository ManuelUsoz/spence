import { Injectable, computed, inject, signal } from '@angular/core';
import { toast } from '@ui/toast';
import { Effect } from 'effect';
import type { Project } from '../../../shared/projects/projects.rpc';
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

/** The active Projects, loaded once at startup (each folder checked then), and adding one. */
@Injectable({ providedIn: 'root' })
export class ProjectsState {
  private readonly runtime = inject(EffectRuntime);
  private readonly _state = signal<ProjectsLoad>({ status: 'loading' });

  readonly state = this._state.asReadonly();
  /** The loaded Projects in Project order: last used first (the Project order Setting comes later). */
  readonly ordered = computed((): ReadonlyArray<Project> => {
    const state = this._state();
    return state.status === 'loaded'
      ? [...state.projects].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      : [];
  });

  constructor() {
    void this.load();
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
}
