import { Injectable, signal } from '@angular/core';
import type { Project } from '../../../shared/projects/projects.rpc';

/**
 * Which Project's settings sheet is open, if any. The Project context menu calls `show(project)`; the shell hosts
 * the sheet.
 */
@Injectable({ providedIn: 'root' })
export class ProjectSettingsState {
  private readonly _project = signal<Project | null>(null);
  readonly project = this._project.asReadonly();

  show(project: Project): void {
    this._project.set(project);
  }

  close(): void {
    this._project.set(null);
  }

  /** Keeps the open sheet on the Project main returned after a change. */
  changed(project: Project): void {
    if (this._project()?.id === project.id) this._project.set(project);
  }
}
