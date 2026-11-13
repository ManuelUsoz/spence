import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { Project, ProjectId } from '../../../shared/projects/projects.rpc';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';

/** One compact single-line Session row in All Projects layout: title and short age (or status mark). */
export interface AllProjectsRow {
  readonly id: SessionId;
  readonly title: string;
  readonly age: string;
  readonly active: boolean;
  /** Optional hook for Attention marks (#41). */
  readonly attention?: unknown;
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
}

/**
 * The All Projects sidebar list: each Project as a heading with its folder-missing mark and `+` New Session
 * button, optional draft placeholder, capped recent Sessions, and a "Show N more" / "Show less" toggle.
 */
@Component({
  selector: 'app-all-projects-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-3' },
  template: `
    @for (section of sections(); track section.project.id) {
      <section class="flex flex-col">
        <div class="flex items-center gap-1 px-2 pt-2 pb-1" data-testid="project-heading">
          <span class="text-muted-foreground min-w-0 flex-1 truncate text-xs font-medium">
            {{ section.project.name }}
          </span>
          <!-- Slot: Project Attention dot (#41). -->
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
              <button
                type="button"
                data-testid="session-row"
                class="flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm"
                [class]="
                  row.active
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                    : 'hover:bg-sidebar-accent'
                "
                [attr.aria-current]="row.active ? 'page' : null"
                (click)="openSession.emit({ projectId: section.project.id, sessionId: row.id })"
              >
                <span class="min-w-0 flex-1 truncate" data-testid="session-title">{{
                  row.title
                }}</span>
                <!-- Slot: running / Attention marks replace short age (#41). -->
                <span
                  class="text-muted-foreground shrink-0 text-xs font-normal tabular-nums"
                  data-testid="session-age"
                  >{{ row.age }}</span
                >
              </button>
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
            <!-- Slot: Archived (section.archivedCount) fold (#44). -->
          }
        }
      </section>
    }
    @if (emptyMessage(); as message) {
      <p class="text-muted-foreground px-2 py-6 text-center text-sm" data-testid="sessions-empty">
        {{ message }}
      </p>
    }
  `,
})
export class AllProjectsList {
  readonly sections = input.required<ReadonlyArray<AllProjectsSection>>();
  readonly emptyMessage = input<string | null>(null);

  readonly newSession = output<ProjectId>();
  readonly openSession = output<{ readonly projectId: ProjectId; readonly sessionId: SessionId }>();
  readonly openDraft = output<ProjectId>();
  readonly toggleExpand = output<ProjectId>();

  protected newSessionLabel(name: string): string {
    return $localize`New Session in ${name}:projectName:`;
  }
}
