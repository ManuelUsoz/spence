import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import type { CrossProjectAccess } from '../../../../shared/settings/settings.rpc';
import { ProjectsState } from '../projects-state';
import { SettingsStore } from './settings-store';

interface Entry {
  readonly index: number;
  readonly from: string;
  readonly to: string;
  readonly addedAt: CrossProjectAccess['addedAt'];
}

/** Permissions: the Project pairs the user allowed to message each other ("Always allow"), each removable. */
@Component({
  selector: 'app-settings-permissions',
  imports: [DatePipe, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.loaded(); as current) {
      <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>Permissions</h2>

      @if (current.settings.crossProjectAccess.length === 0) {
        <p class="border-border/60 text-muted-foreground border-t py-3 text-xs" i18n>
          Cross-Project messaging is off. A Session asks you before it first messages another
          Project.
        </p>
      }
      @for (entry of entries(); track entry.index) {
        <div class="border-border/60 flex items-center gap-6 border-t py-3">
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="text-sm" [attr.data-testid]="'cross-project-pair-' + entry.index">
              {{ entry.from }} → {{ entry.to }}
            </span>
            <span class="text-muted-foreground text-xs" i18n>
              Always allowed to message · added {{ entry.addedAt | date: 'mediumDate' }}
            </span>
          </div>
          <button
            hlmBtn
            type="button"
            variant="ghost"
            size="sm"
            class="text-muted-foreground"
            [attr.data-testid]="'cross-project-remove-' + entry.index"
            (click)="remove(entry.index)"
            i18n
          >
            Remove
          </button>
        </div>
      }
    }
  `,
})
export class SettingsPermissions {
  protected readonly store = inject(SettingsStore);
  private readonly projects = inject(ProjectsState);

  /** Pairs whose two Projects both still exist, with their names. */
  protected readonly entries = computed((): ReadonlyArray<Entry> => {
    const current = this.store.loaded();
    if (current === null) return [];
    const names = new Map(this.projects.ordered().map((project) => [project.id, project.name]));
    return current.settings.crossProjectAccess.flatMap((entry, index) => {
      const from = names.get(entry.from);
      const to = names.get(entry.to);
      return from === undefined || to === undefined
        ? []
        : [{ index, from, to, addedAt: entry.addedAt }];
    });
  });

  protected remove(index: number): void {
    const current = this.store.loaded();
    if (current === null) return;
    void this.store.change({
      crossProjectAccess: current.settings.crossProjectAccess.filter((_, at) => at !== index),
    });
  }
}
