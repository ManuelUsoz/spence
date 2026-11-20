import { Injectable, signal } from '@angular/core';
import type { PermissionMode, ProjectId } from '../../../shared/projects/projects.rpc';

/** Settings navigation and the Project override save in progress. */
@Injectable({ providedIn: 'root' })
export class SettingsState {
  private readonly _open = signal(false);

  readonly savingProjectMode = signal<{ id: ProjectId; mode: PermissionMode | null } | null>(null);
  readonly projectId = signal<ProjectId | null>(null);
  readonly open = this._open.asReadonly();

  show(): void {
    this._open.set(true);
  }

  showProject(id: ProjectId): void {
    this.projectId.set(id);
    this.show();
  }

  set(open: boolean): void {
    this._open.set(open);
    if (!open) this.projectId.set(null);
  }
}
