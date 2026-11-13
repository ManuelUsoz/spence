import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ActivityMark } from '@ui/activity-mark';
import { HlmContextMenuImports } from '@ui/context-menu';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmInputImports } from '@ui/input';
import type { Project, ProjectId } from '../../../shared/projects/projects.rpc';
import type { Attention, SessionId } from '../../../shared/sessions/sessions.rpc';
import type { RowClickEvent } from './session-list';

/** One compact single-line Session row in All Projects layout: title and short age (or status mark). */
export interface AllProjectsRow {
  readonly id: SessionId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly age: string;
  readonly active: boolean;
  readonly untitled?: boolean;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly attention?: Attention;
  readonly running?: boolean;
}

/** One Project section in All Projects layout. */
export interface AllProjectsSection {
  readonly project: Project;
  readonly status: 'loading' | 'failed' | 'loaded';
  readonly draft: boolean;
  readonly draftActive: boolean;
  readonly rows: ReadonlyArray<AllProjectsRow>;
  readonly hiddenCount: number;
  readonly expanded: boolean;
  /** Archived Session count for the collapsed Archived (n) fold (#44). */
  readonly archivedCount: number;
  readonly archivedRows: ReadonlyArray<AllProjectsRow>;
  readonly archivedOpen: boolean;
  readonly unarchivedCount: number;
  readonly totalCount: number;
  readonly attention?: Attention;
  readonly running?: boolean;
}

/**
 * The All Projects sidebar list: each Project as a heading with its folder-missing mark, context menu, and `+` New
 * Session button, optional draft placeholder, capped recent Sessions with context menu and multi-select, a "Show N
 * more" / "Show less" toggle, and a collapsed-by-default Archived fold per Project.
 */
@Component({
  selector: 'app-all-projects-list',
  imports: [HlmContextMenuImports, HlmDropdownMenuImports, HlmInputImports, ActivityMark],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex flex-col gap-3',
    '(keydown.escape)': 'clearSelection.emit()',
  },
  template: `
    @for (section of sections(); track section.project.id) {
      <section class="flex flex-col">
        @if (renamingProject() === section.project.id) {
          <div class="px-2 pt-2 pb-1">
            <input
              #projectRenameInput
              hlmInput
              data-testid="project-rename-input"
              class="h-7 w-full px-2 text-xs font-medium"
              aria-label="Project name"
              i18n-aria-label
              [value]="renameDraft()"
              (input)="projectRenameDraft.emit($any($event.target).value)"
              (keydown.enter)="commitProjectRename.emit(section.project)"
              (keydown.escape)="$event.stopPropagation(); cancelProjectRename.emit()"
              (blur)="commitProjectRename.emit(section.project)"
            />
          </div>
        } @else {
          <div
            class="flex items-center gap-1 px-2 pt-2 pb-1"
            data-testid="project-heading"
            [hlmContextMenuTrigger]="projectMenu"
            [hlmContextMenuTriggerData]="{ $implicit: section.project.id }"
          >
            <span class="text-muted-foreground min-w-0 flex-1 truncate text-xs font-medium">
              {{ section.project.name }}
            </span>
            @if (section.attention; as attention) {
              <span data-testid="project-attention" class="inline-flex shrink-0">
                <app-activity-mark [kind]="attention" />
              </span>
            } @else if (section.running) {
              <span data-testid="project-running" class="inline-flex shrink-0">
                <app-activity-mark kind="running" />
              </span>
            }
            @if (section.project.folderMissing) {
              <svg
                class="text-destructive size-3.5 shrink-0"
                data-testid="folder-missing"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                role="img"
                aria-label="Folder missing"
                i18n-aria-label
                title="Folder missing"
                i18n-title
              >
                <path
                  d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2zM9.5 10.5l5 5M14.5 10.5l-5 5"
                />
              </svg>
            }
            <button
              type="button"
              data-testid="project-new-session"
              class="hover:bg-sidebar-accent text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-md"
              [attr.aria-label]="newSessionLabel(section.project.name)"
              title="New Session"
              i18n-title
              (click)="newSession.emit(section.project.id)"
            >
              <svg
                class="size-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        }

        @switch (section.status) {
          @case ('loading') {
            <p class="text-muted-foreground px-2 py-1 text-xs" i18n>Loading…</p>
          }
          @case ('failed') {
            <p class="text-destructive px-2 py-1 text-xs" data-testid="sessions-failed" i18n>
              Could not load Sessions.
            </p>
          }
          @case ('loaded') {
            @if (section.draft) {
              <button
                type="button"
                data-testid="draft-row"
                class="text-muted-foreground flex h-8 shrink-0 items-center rounded-md px-2 text-left text-sm italic"
                [class.bg-sidebar-accent]="section.draftActive"
                [class.hover:bg-sidebar-accent]="!section.draftActive"
                [attr.aria-current]="section.draftActive ? 'page' : null"
                (click)="openDraft.emit(section.project.id)"
                i18n
              >
                New Session
              </button>
            }
            @for (row of section.rows; track row.id) {
              @if (editing() === row.id) {
                <input
                  #editor
                  data-testid="session-rename"
                  class="bg-background h-8 w-full rounded-md px-2 text-sm"
                  [value]="row.untitled ? '' : row.title"
                  aria-label="Session title"
                  i18n-aria-label
                  (keydown.enter)="$event.preventDefault(); saveRename(row, editor.value)"
                  (keydown.escape)="$event.stopPropagation(); cancelRename()"
                  (blur)="saveRename(row, editor.value)"
                />
              } @else {
                <button
                  type="button"
                  data-testid="session-row"
                  [attr.data-session-id]="row.id"
                  [attr.aria-current]="row.active ? 'page' : null"
                  [attr.aria-selected]="row.selected"
                  [attr.data-selected]="row.selected ? 'true' : null"
                  [class]="rowClasses(row)"
                  [hlmContextMenuTrigger]="sessionMenu"
                  [hlmContextMenuTriggerData]="{ $implicit: row.id }"
                  (click)="onRowClick(section.project.id, row.id, $event)"
                  (dblclick)="startRename(row.id)"
                  (keydown.f2)="startRename(row.id); $event.preventDefault()"
                >
                  <span
                    class="min-w-0 flex-1 truncate"
                    [class.text-muted-foreground]="row.untitled"
                    data-testid="session-title"
                    >{{ row.title }}</span
                  >
                  @if (row.attention; as attention) {
                    <app-activity-mark [kind]="attention" />
                  } @else if (row.running) {
                    <app-activity-mark kind="running" />
                  } @else {
                    <span
                      class="text-muted-foreground shrink-0 text-xs font-normal tabular-nums"
                      data-testid="session-age"
                      >{{ row.age }}</span
                    >
                  }
                </button>
              }
            }
            @if (section.hiddenCount > 0) {
              <button
                type="button"
                data-testid="show-more-sessions"
                class="text-muted-foreground hover:text-foreground px-2 py-1 text-left text-xs"
                (click)="toggleExpand.emit(section.project.id)"
              >
                @if (section.expanded) {
                  <ng-container i18n>Show less</ng-container>
                } @else {
                  <ng-container i18n>Show {{ section.hiddenCount }} more</ng-container>
                }
              </button>
            }
            @if (section.archivedRows.length > 0) {
              <div class="mt-1">
                <button
                  type="button"
                  data-testid="archived-fold"
                  class="text-muted-foreground hover:bg-sidebar-accent flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-medium"
                  [attr.aria-expanded]="section.archivedOpen"
                  [hlmContextMenuTrigger]="archivedFoldMenu"
                  [hlmContextMenuTriggerData]="{ $implicit: section.project.id }"
                  (click)="toggleArchived.emit(section.project.id)"
                >
                  <svg
                    class="size-3.5 shrink-0 transition-transform"
                    [class.rotate-90]="section.archivedOpen"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    aria-hidden="true"
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                  <span i18n
                    >Archived (<span class="tabular-nums">{{ section.archivedRows.length }}</span
                    >)</span
                  >
                </button>
                @if (section.archivedOpen) {
                  <div class="mt-0.5 flex flex-col" data-testid="archived-list">
                    @for (row of section.archivedRows; track row.id) {
                      @if (editing() === row.id) {
                        <input
                          #editor
                          data-testid="session-rename"
                          class="bg-background h-8 w-full rounded-md px-2 text-sm"
                          [value]="row.untitled ? '' : row.title"
                          aria-label="Session title"
                          i18n-aria-label
                          (keydown.enter)="$event.preventDefault(); saveRename(row, editor.value)"
                          (keydown.escape)="$event.stopPropagation(); cancelRename()"
                          (blur)="saveRename(row, editor.value)"
                        />
                      } @else {
                        <button
                          type="button"
                          data-testid="session-row"
                          data-archived="true"
                          [attr.data-session-id]="row.id"
                          [attr.aria-current]="row.active ? 'page' : null"
                          [attr.aria-selected]="row.selected"
                          [attr.data-selected]="row.selected ? 'true' : null"
                          [class]="rowClasses(row)"
                          [hlmContextMenuTrigger]="sessionMenu"
                          [hlmContextMenuTriggerData]="{ $implicit: row.id }"
                          (click)="onRowClick(section.project.id, row.id, $event)"
                          (dblclick)="startRename(row.id)"
                          (keydown.f2)="startRename(row.id); $event.preventDefault()"
                        >
                          <span
                            class="text-muted-foreground min-w-0 flex-1 truncate"
                            data-testid="session-title"
                            >{{ row.title }}</span
                          >
                          <span
                            class="text-muted-foreground/80 shrink-0 text-xs font-normal tabular-nums"
                            data-testid="session-age"
                            >{{ row.age }}</span
                          >
                        </button>
                      }
                    }
                  </div>
                }
              </div>
            }
          }
        }
      </section>
    }
    @if (emptyMessage(); as message) {
      <p class="text-muted-foreground px-2 py-6 text-center text-sm" data-testid="sessions-empty">
        {{ message }}
      </p>
    }

    <ng-template #sessionMenu let-rowId>
      @if (rowById(rowId); as row) {
        <hlm-dropdown-menu class="w-48" data-testid="session-context-menu">
          @if (selectedCount() > 1 && row.selected) {
            @if (selectedAllArchived()) {
              <button
                type="button"
                hlmDropdownMenuItem
                data-testid="menu-unarchive-bulk"
                (triggered)="menuUnarchive.emit(row)"
                i18n
              >
                Unarchive <span class="tabular-nums">{{ selectedCount() }}</span>
              </button>
            } @else {
              <button
                type="button"
                hlmDropdownMenuItem
                data-testid="menu-archive-bulk"
                (triggered)="menuArchive.emit(row)"
                i18n
              >
                Archive <span class="tabular-nums">{{ selectedCount() }}</span>
              </button>
            }
            <button
              type="button"
              hlmDropdownMenuItem
              variant="destructive"
              data-testid="menu-delete-bulk"
              (triggered)="menuDelete.emit(row)"
              i18n
            >
              Delete <span class="tabular-nums">{{ selectedCount() }}</span
              >…
            </button>
          } @else {
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="menu-open"
              (triggered)="menuOpen.emit(row)"
              i18n
            >
              Open
            </button>
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="menu-rename"
              (triggered)="startRename(row.id)"
              i18n
            >
              Rename
            </button>
            <hlm-dropdown-menu-separator />
            @if (row.archived) {
              <button
                type="button"
                hlmDropdownMenuItem
                data-testid="menu-unarchive"
                (triggered)="menuUnarchive.emit(row)"
                i18n
              >
                Unarchive
              </button>
            } @else {
              <button
                type="button"
                hlmDropdownMenuItem
                data-testid="menu-archive"
                (triggered)="menuArchive.emit(row)"
                i18n
              >
                Archive
              </button>
            }
            <button
              type="button"
              hlmDropdownMenuItem
              variant="destructive"
              data-testid="menu-delete"
              (triggered)="menuDelete.emit(row)"
              i18n
            >
              Delete…
            </button>
          }
        </hlm-dropdown-menu>
      }
    </ng-template>

    <ng-template #archivedFoldMenu let-projectId>
      @if (sectionById(projectId); as section) {
        <hlm-dropdown-menu class="w-48" data-testid="archived-fold-menu">
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="archived-menu-unarchive-all"
            (triggered)="unarchiveAll.emit(section.project.id)"
            i18n
          >
            Unarchive all (<span class="tabular-nums">{{ section.archivedRows.length }}</span
            >)
          </button>
          <button
            type="button"
            hlmDropdownMenuItem
            variant="destructive"
            data-testid="archived-menu-delete-all"
            (triggered)="deleteAllArchived.emit(section.project.id)"
            i18n
          >
            Delete all (<span class="tabular-nums">{{ section.archivedRows.length }}</span
            >)…
          </button>
        </hlm-dropdown-menu>
      }
    </ng-template>

    <ng-template #projectMenu let-projectId>
      @if (sectionById(projectId); as section) {
        <hlm-dropdown-menu class="w-52" data-testid="project-context-menu">
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="project-menu-new-session"
            (triggered)="newSession.emit(section.project.id)"
            i18n
          >
            New Session
          </button>
          @if (section.project.folderMissing) {
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="project-menu-locate"
              (triggered)="locateProject.emit(section.project.id)"
              i18n
            >
              Locate folder…
            </button>
          }
          <hlm-dropdown-menu-separator />
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="project-menu-rename"
            (triggered)="startProjectRename.emit(section.project)"
            i18n
          >
            Rename
          </button>
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="project-menu-settings"
            (triggered)="openProjectSettings.emit(section.project)"
            i18n
          >
            Project settings
          </button>
          <hlm-dropdown-menu-separator />
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="project-menu-archive-all"
            [disabled]="section.unarchivedCount === 0"
            (triggered)="archiveAllProject.emit(section.project.id)"
            i18n
          >
            Archive all (<span class="tabular-nums">{{ section.unarchivedCount }}</span
            >)
          </button>
          <button
            type="button"
            hlmDropdownMenuItem
            variant="destructive"
            data-testid="project-menu-delete-all"
            [disabled]="section.totalCount === 0"
            (triggered)="deleteAllProject.emit(section.project.id)"
            i18n
          >
            Delete all (<span class="tabular-nums">{{ section.totalCount }}</span
            >)…
          </button>
          <button
            type="button"
            hlmDropdownMenuItem
            variant="destructive"
            data-testid="project-menu-remove"
            (triggered)="removeProject.emit(section.project)"
            i18n
          >
            Remove Project
          </button>
        </hlm-dropdown-menu>
      }
    </ng-template>
  `,
})
export class AllProjectsList {
  readonly sections = input.required<ReadonlyArray<AllProjectsSection>>();
  readonly emptyMessage = input<string | null>(null);
  readonly selectedCount = input(0);
  readonly selectedAllArchived = input(false);
  readonly renamingProject = input<ProjectId | null>(null);
  readonly renameDraft = input('');

  readonly newSession = output<ProjectId>();
  readonly rowClick = output<{ readonly projectId: ProjectId; readonly event: RowClickEvent }>();
  readonly rename = output<{ readonly id: SessionId; readonly title: string }>();
  readonly openDraft = output<ProjectId>();
  readonly toggleExpand = output<ProjectId>();
  readonly toggleArchived = output<ProjectId>();
  readonly clearSelection = output();
  readonly menuOpen = output<AllProjectsRow>();
  readonly menuArchive = output<AllProjectsRow>();
  readonly menuUnarchive = output<AllProjectsRow>();
  readonly menuDelete = output<AllProjectsRow>();
  readonly unarchiveAll = output<ProjectId>();
  readonly deleteAllArchived = output<ProjectId>();
  readonly locateProject = output<ProjectId>();
  readonly startProjectRename = output<Project>();
  readonly projectRenameDraft = output<string>();
  readonly commitProjectRename = output<Project>();
  readonly cancelProjectRename = output();
  readonly openProjectSettings = output<Project>();
  readonly archiveAllProject = output<ProjectId>();
  readonly deleteAllProject = output<ProjectId>();
  readonly removeProject = output<Project>();

  protected readonly editing = signal<SessionId | null>(null);
  private readonly editor = viewChild<ElementRef<HTMLInputElement>>('editor');
  private readonly projectRenameInput =
    viewChild<ElementRef<HTMLInputElement>>('projectRenameInput');

  constructor() {
    effect(() => {
      const input = this.editor()?.nativeElement;
      if (input !== undefined) {
        input.focus();
        input.select();
      }
    });
    effect(() => {
      const input = this.projectRenameInput()?.nativeElement;
      if (input !== undefined) {
        input.focus();
        input.select();
      }
    });
  }

  protected newSessionLabel(name: string): string {
    return $localize`New Session in ${name}:projectName:`;
  }

  protected startRename(id: SessionId): void {
    this.editing.set(id);
  }

  protected saveRename(row: AllProjectsRow, title: string): void {
    if (this.editing() !== row.id) return;
    this.editing.set(null);
    const trimmed = title.trim();
    const initial = row.untitled ? '' : row.title;
    if (trimmed !== initial) this.rename.emit({ id: row.id, title });
  }

  protected cancelRename(): void {
    this.editing.set(null);
  }

  protected sectionById(projectId: ProjectId): AllProjectsSection | undefined {
    return this.sections().find((section) => section.project.id === projectId);
  }

  protected rowById(id: SessionId): AllProjectsRow | undefined {
    for (const section of this.sections()) {
      const activeMatch = section.rows.find((row) => row.id === id);
      if (activeMatch !== undefined) return activeMatch;
      const archivedMatch = section.archivedRows.find((row) => row.id === id);
      if (archivedMatch !== undefined) return archivedMatch;
    }
    return undefined;
  }

  protected onRowClick(projectId: ProjectId, id: SessionId, event: MouseEvent): void {
    this.rowClick.emit({
      projectId,
      event: {
        id,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      },
    });
  }

  protected rowClasses(row: AllProjectsRow): string {
    const base =
      'flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm select-none';
    if (row.selected) {
      return row.active
        ? `${base} bg-primary/15 text-sidebar-accent-foreground ring-1 ring-inset ring-primary/50 font-medium`
        : `${base} bg-primary/15 ring-1 ring-inset ring-primary/40`;
    }
    if (row.active) return `${base} bg-sidebar-accent text-sidebar-accent-foreground font-medium`;
    return `${base} hover:bg-sidebar-accent`;
  }
}
