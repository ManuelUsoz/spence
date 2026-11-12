import { Injectable, inject, signal } from '@angular/core';
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

  /** Opens the folder picker and adds the folder; a folder that is already a Project shows a toast. */
  async add(): Promise<void> {
    const exit = await this.runtime.run(addProject);
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not add the folder.`);
      return;
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
        return;
      case 'alreadyAdded':
        toast($localize`This folder is already in Spence as ${result.name}:name:.`);
        return;
      case 'cancelled':
        return;
    }
  }
}
