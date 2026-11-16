import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChildren,
  type ElementRef,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
  lucideChevronLeft,
  lucideChevronRight,
  lucideEllipsis,
  lucideExternalLink,
  lucideFile,
  lucideFilePlus,
  lucideFileText,
  lucideFileWarning,
  lucideFolder,
  lucideFolderGit2,
  lucideFolderPlus,
  lucideLink2,
  lucidePencil,
  lucideRefreshCw,
  lucideTrash2,
} from '@ng-icons/lucide';
import { Cause, Effect, Exit, Option, Stream } from 'effect';
import {
  DEFAULT_FILES_DIR_PAGE_LIMIT,
  type FilesDirectoryPage,
  type FilesEntry,
  type FilesEntryKind,
  type FilesErrorReason,
  type FilesPreview,
  type FilesRootTarget,
  type FilesUnavailableReason,
  type FilesWatchEvent,
} from '../../../shared/files/files.rpc';
import type {
  FileOperationCreateKind,
  FileOperationReview,
} from '../../../shared/files/file-operations.rpc';
import {
  OperationId,
  type OperationSnapshot,
} from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButtonImports } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmInputImports } from '@ui/input';
import { HlmLabelImports } from '@ui/label';
import { HlmProgressImports } from '@ui/progress';
import { HlmSkeletonImports } from '@ui/skeleton';
import { HlmTooltipImports } from '@ui/tooltip';
import {
  executeFileOperation,
  fileOperationTitle,
  formatFileOperationBlocker,
  formatPathResultStatus,
  reviewCreateFile,
  reviewDeleteFiles,
  reviewRenameFile,
} from './file-operations';

interface DirectoryState {
  readonly status: 'loading' | 'loaded' | 'error';
  readonly entries: ReadonlyArray<FilesEntry>;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly errorDetail?: string;
}

type PreviewState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly path: string }
  | { readonly status: 'loaded'; readonly preview: FilesPreview }
  | {
      readonly status: 'error';
      readonly path: string;
      readonly reason?: FilesErrorReason;
      readonly detail: string;
    };

type FileOperationDialog =
  | { readonly _tag: 'closed' }
  | {
      readonly _tag: 'create';
      readonly dirPath: string;
      readonly kind: FileOperationCreateKind;
    }
  | {
      readonly _tag: 'rename';
      readonly relativePath: string;
      readonly currentName: string;
    }
  | {
      readonly _tag: 'delete';
      readonly relativePaths: ReadonlyArray<string>;
    }
  | {
      readonly _tag: 'permanentDelete';
      readonly relativePaths: ReadonlyArray<string>;
      readonly review: FileOperationReview;
    }
  | {
      readonly _tag: 'progress';
      readonly kind: FileOperationReview['kind'];
      readonly title: string;
      readonly snapshot: OperationSnapshot;
    }
  | {
      readonly _tag: 'partialResult';
      readonly snapshot: OperationSnapshot;
    };

type VisibleTreeRow =
  | {
      readonly key: string;
      readonly kind: 'entry';
      readonly depth: number;
      readonly entry: FilesEntry;
    }
  | {
      readonly key: string;
      readonly kind: 'loading';
      readonly depth: number;
      readonly dirPath: string;
    }
  | {
      readonly key: string;
      readonly kind: 'empty';
      readonly depth: number;
      readonly dirPath: string;
    }
  | {
      readonly key: string;
      readonly kind: 'error';
      readonly depth: number;
      readonly dirPath: string;
      readonly detail: string;
    }
  | {
      readonly key: string;
      readonly kind: 'loadMore';
      readonly depth: number;
      readonly dirPath: string;
      readonly cursor: string;
    };

const parentDirOf = (relativePath: string): string => {
  const idx = relativePath.lastIndexOf('/');
  return idx <= 0 ? '' : relativePath.slice(0, idx);
};

const basenameOf = (relativePath: string): string => {
  const idx = relativePath.lastIndexOf('/');
  return idx === -1 ? relativePath : relativePath.slice(idx + 1);
};

const entryIconName = (kind: FilesEntryKind): string => {
  switch (kind) {
    case 'directory':
      return 'lucideFolder';
    case 'nestedRepo':
      return 'lucideFolderGit2';
    case 'symlink':
      return 'lucideLink2';
    case 'special':
      return 'lucideFileWarning';
    case 'file':
      return 'lucideFileText';
  }
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};

const formatTargetKey = (target: FilesRootTarget | null): string =>
  target === null ? '' : `${target.projectId}:${target.worktreeId ?? ''}`;

const isSameDirectoryTarget = (watchedPath: string, expandedDir: string): boolean =>
  watchedPath === '' || watchedPath === expandedDir || parentDirOf(watchedPath) === expandedDir;

const doesChangeTouchFile = (watchedPaths: ReadonlyArray<string>, targetFile: string): boolean =>
  watchedPaths.some(
    (changed) =>
      changed === '' ||
      changed === targetFile ||
      targetFile.startsWith(`${changed}/`) ||
      changed.startsWith(`${targetFile}/`),
  );

const listDirEffect = Effect.fnUntraced(function* (params: {
  readonly target: FilesRootTarget;
  readonly dirPath: string;
  readonly cursor?: string;
}) {
  const api = yield* DesktopApi;
  return yield* api['Files.listDir']({
    target: params.target,
    dirPath: params.dirPath,
    limit: DEFAULT_FILES_DIR_PAGE_LIMIT,
    ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
  });
});

const readPreviewEffect = Effect.fnUntraced(function* (params: {
  readonly target: FilesRootTarget;
  readonly relativePath: string;
}) {
  const api = yield* DesktopApi;
  return yield* api['Files.readPreview']({
    target: params.target,
    relativePath: params.relativePath,
  });
});

const openExternalEffect = Effect.fnUntraced(function* (params: {
  readonly target: FilesRootTarget;
  readonly relativePath: string;
}) {
  const api = yield* DesktopApi;
  yield* api['Files.openExternal']({
    target: params.target,
    relativePath: params.relativePath,
  });
});

const setShowIgnoredEffect = Effect.fnUntraced(function* (
  target: FilesRootTarget,
  showIgnoredFiles: boolean,
) {
  const api = yield* DesktopApi;
  return yield* api['Projects.setSettings']({
    id: target.projectId,
    patch: { showIgnoredFiles },
  });
});

/**
 * Live workspace file tree and plain read-only saved-file preview for the active Project or Worktree.
 */
@Component({
  selector: 'app-files-browser',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgIcon,
    HlmAlertDialogImports,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmInputImports,
    HlmLabelImports,
    HlmProgressImports,
    HlmSkeletonImports,
    HlmTooltipImports,
  ],
  providers: [
    provideIcons({
      lucideChevronDown,
      lucideChevronLeft,
      lucideChevronRight,
      lucideEllipsis,
      lucideExternalLink,
      lucideFile,
      lucideFilePlus,
      lucideFileText,
      lucideFileWarning,
      lucideFolder,
      lucideFolderGit2,
      lucideFolderPlus,
      lucideLink2,
      lucidePencil,
      lucideRefreshCw,
      lucideTrash2,
    }),
  ],
  host: {
    class: 'flex min-h-0 flex-1 flex-col',
  },
  template: `
    @if (activePreviewPath(); as previewPath) {
      <div
        class="flex min-h-0 flex-1 flex-col"
        data-testid="files-preview-view"
        tabindex="-1"
        (keydown.escape)="onPreviewEscape($event)"
      >
        <div class="flex items-center justify-between gap-2 border-b px-3 py-2">
          <button
            type="button"
            hlmBtn
            variant="ghost"
            size="xs"
            data-testid="files-preview-back"
            class="text-muted-foreground hover:text-foreground h-7 gap-1 px-1.5 text-xs font-normal"
            (click)="closePreview()"
          >
            <ng-icon name="lucideChevronLeft" class="size-3.5" aria-hidden="true" />
            <span i18n>Files</span>
          </button>

          <button
            type="button"
            hlmBtn
            variant="outline"
            size="xs"
            data-testid="files-preview-open-external"
            class="h-7 gap-1.5 px-2 text-xs font-normal"
            [disabled]="!canOpenPreviewExternally()"
            (click)="onOpenExternal(previewPath)"
          >
            <ng-icon name="lucideExternalLink" class="size-3.5" aria-hidden="true" />
            <span i18n>Open externally</span>
          </button>
        </div>

        <div class="bg-muted/30 flex items-center justify-between gap-2 border-b px-3 py-1.5">
          <span
            class="text-foreground min-w-0 flex-1 truncate font-mono text-xs font-normal"
            data-testid="files-preview-path"
            [title]="previewPath"
          >
            {{ previewPath }}
          </span>
        </div>

        @if (actionError(); as err) {
          <div
            class="bg-destructive/10 text-destructive border-destructive/20 border-b px-3 py-2 text-xs"
            role="status"
            data-testid="files-action-error"
          >
            {{ err }}
          </div>
        }

        <div class="min-h-0 flex-1 overflow-y-auto p-3">
          @switch (previewState().status) {
            @case ('loading') {
              <div class="flex flex-col gap-2" data-testid="files-preview-loading">
                <hlm-skeleton class="h-3.5 w-3/4" />
                <hlm-skeleton class="h-3.5 w-full" />
                <hlm-skeleton class="h-3.5 w-5/6" />
              </div>
            }
            @case ('error') {
              @let errState = previewErrorState();
              @if (errState) {
                <div
                  class="flex flex-col items-start gap-3 rounded-md border p-3 text-xs"
                  data-testid="files-preview-error"
                >
                  <p class="text-foreground font-medium" i18n>Cannot load file preview</p>
                  <p class="text-muted-foreground">{{ errState.detail }}</p>
                  <button
                    type="button"
                    hlmBtn
                    variant="outline"
                    size="xs"
                    (click)="reloadPreview(previewPath)"
                    i18n
                  >
                    Retry
                  </button>
                </div>
              }
            }
            @case ('loaded') {
              @let loaded = loadedPreview();
              @if (loaded) {
                @switch (loaded._tag) {
                  @case ('Text') {
                    <div class="flex flex-col gap-2">
                      @if (loaded.truncated) {
                        <div
                          class="bg-muted/60 flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-xs"
                          data-testid="files-preview-truncated"
                        >
                          <span class="text-muted-foreground">
                            <span i18n>Preview truncated at</span>
                            <span class="tabular-nums">
                              {{ ' ' }}{{ formatSize(loaded.previewLimitBytes) }}
                            </span>
                            <span i18n>of</span>
                            <span class="tabular-nums">
                              {{ ' ' }}{{ formatSize(loaded.totalBytes) }}</span
                            >
                          </span>
                          <button
                            type="button"
                            hlmBtn
                            variant="ghost"
                            size="xs"
                            class="h-6 px-2 text-xs font-normal"
                            (click)="onOpenExternal(loaded.path)"
                            i18n
                          >
                            Open externally
                          </button>
                        </div>
                      }
                      <pre
                        class="text-foreground font-mono text-xs leading-relaxed font-normal whitespace-pre-wrap break-words select-text"
                        data-testid="files-preview-content"
                        >{{ loaded.content }}</pre>
                    </div>
                  }
                  @case ('Binary') {
                    <div
                      class="flex flex-col items-start gap-2 rounded-md border p-3 text-xs"
                      data-testid="files-preview-binary"
                    >
                      <p class="text-foreground font-medium">
                        <span i18n>Binary file</span>
                        <span class="text-muted-foreground font-normal tabular-nums">
                          ({{ formatSize(loaded.totalBytes) }})
                        </span>
                      </p>
                      <p class="text-muted-foreground" i18n>
                        Binary files are not previewed as text.
                      </p>
                      <button
                        type="button"
                        hlmBtn
                        variant="outline"
                        size="xs"
                        class="mt-1"
                        (click)="onOpenExternal(loaded.path)"
                        i18n
                      >
                        Open externally
                      </button>
                    </div>
                  }
                  @case ('Unavailable') {
                    <div
                      class="flex flex-col items-start gap-2 rounded-md border p-3 text-xs"
                      data-testid="files-preview-unavailable"
                      [attr.data-reason]="loaded.reason"
                    >
                      <p class="text-foreground font-medium" i18n>Preview unavailable</p>
                      <p class="text-muted-foreground">{{ unavailableMessage(loaded.reason) }}</p>
                    </div>
                  }
                }
              }
            }
          }
        </div>

        @if (isTextPreview()) {
          <div
            class="text-muted-foreground border-t px-3 py-1.5 text-[11px]"
            data-testid="files-preview-caption"
            i18n
          >
            Read-only · saved file
          </div>
        }
      </div>
    } @else {
      <div class="flex min-h-0 flex-1 flex-col">
        <div class="flex items-center justify-between gap-2 border-b px-3 py-1.5">
          <div
            class="text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 text-xs"
            data-testid="files-root-context"
          >
            <span class="truncate">{{ rootContextLabel() }}</span>
            @if (rootFolderName()) {
              <span aria-hidden="true">·</span>
              <span class="truncate font-mono text-xs font-normal">{{ rootFolderName() }}</span>
            }
          </div>

          <div class="flex items-center gap-0.5">
            <button
              type="button"
              hlmBtn
              variant="ghost"
              size="icon-xs"
              data-testid="files-refresh-btn"
              aria-label="Refresh files"
              i18n-aria-label
              hlmTooltip="Refresh files"
              i18n-hlmTooltip
              [disabled]="!hasValidRoot()"
              (click)="refreshAll()"
            >
              <ng-icon name="lucideRefreshCw" class="size-3.5" aria-hidden="true" />
            </button>

            <button
              type="button"
              hlmBtn
              variant="ghost"
              size="icon-xs"
              data-testid="files-options-trigger"
              aria-label="Files options"
              i18n-aria-label
              [hlmDropdownMenuTrigger]="optionsMenu"
              [disabled]="!hasValidRoot()"
            >
              <ng-icon name="lucideEllipsis" class="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        @if (actionError(); as err) {
          <div
            class="bg-destructive/10 text-destructive border-destructive/20 border-b px-3 py-2 text-xs"
            role="status"
            data-testid="files-action-error"
          >
            {{ err }}
          </div>
        }

        @if (watchWarning(); as warning) {
          <div
            class="bg-muted/60 flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs"
            data-testid="files-watch-warning"
          >
            <span class="text-muted-foreground truncate">{{ warning.detail }}</span>
            <button
              type="button"
              hlmBtn
              variant="ghost"
              size="xs"
              class="h-6 px-1.5 text-xs font-normal"
              (click)="refreshAll()"
              i18n
            >
              Refresh
            </button>
          </div>
        }

        <div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
          @if (worktreeMissing() || target() === null) {
            <div class="p-3 text-xs" data-testid="files-root-missing">
              <p class="text-foreground font-medium" i18n>Workspace folder unavailable</p>
              <p class="text-muted-foreground mt-1" i18n>
                The selected Project or Worktree folder is missing on disk.
              </p>
            </div>
          } @else {
            @let root = rootDirState();
            @if (root?.status === 'loading' && visibleRows().length === 0) {
              <div class="flex flex-col gap-1.5 p-2" data-testid="files-tree-loading">
                <hlm-skeleton class="h-5 w-4/5" />
                <hlm-skeleton class="h-5 w-3/5" />
                <hlm-skeleton class="h-5 w-2/3" />
              </div>
            } @else if (root?.status === 'error') {
              <div
                class="flex flex-col items-start gap-2 p-3 text-xs"
                data-testid="files-tree-error"
              >
                <p class="text-foreground font-medium" i18n>Could not list files</p>
                <p class="text-muted-foreground">{{ root?.errorDetail }}</p>
                <button
                  type="button"
                  hlmBtn
                  variant="outline"
                  size="xs"
                  (click)="refreshAll()"
                  i18n
                >
                  Retry
                </button>
              </div>
            } @else if (visibleRows().length === 0) {
              <p class="text-muted-foreground p-3 text-xs" data-testid="files-tree-empty" i18n>
                No files to show in this folder.
              </p>
            } @else {
              <div
                role="tree"
                aria-label="Project files"
                i18n-aria-label
                data-testid="files-tree"
                class="flex flex-col gap-0.5"
                (keydown)="onTreeKeydown($event)"
              >
                @for (row of visibleRows(); track row.key) {
                  @switch (row.kind) {
                    @case ('entry') {
                      <div class="group flex items-center gap-0.5 rounded-md">
                        <button
                          #treeItemBtn
                          type="button"
                          role="treeitem"
                          data-testid="files-tree-item"
                          [attr.data-path]="row.entry.path"
                          [attr.data-kind]="row.entry.kind"
                          [attr.data-ignored]="row.entry.ignored ? 'true' : null"
                          [attr.aria-level]="row.depth + 1"
                          [attr.aria-expanded]="
                            row.entry.kind === 'directory' ? isExpanded(row.entry.path) : null
                          "
                          [attr.aria-selected]="isFocusedEntry(row.entry.path)"
                          [attr.tabindex]="isFocusedEntry(row.entry.path) ? 0 : -1"
                          class="hover:bg-accent focus-visible:bg-accent focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-1"
                          [class.opacity-60]="row.entry.ignored"
                          [style.padding-left.rem]="row.depth * 0.75 + 0.375"
                          (click)="onEntryClick(row.entry)"
                          (focus)="focusedTreePath.set(row.entry.path)"
                        >
                          @if (row.entry.kind === 'directory') {
                            <ng-icon
                              [name]="
                                isExpanded(row.entry.path)
                                  ? 'lucideChevronDown'
                                  : 'lucideChevronRight'
                              "
                              class="text-muted-foreground size-3 shrink-0"
                              aria-hidden="true"
                            />
                          } @else {
                            <span class="size-3 shrink-0" aria-hidden="true"></span>
                          }
                          <ng-icon
                            [name]="iconFor(row.entry.kind)"
                            class="text-muted-foreground size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                          <span
                            class="text-foreground min-w-0 flex-1 truncate font-mono text-xs font-normal"
                          >
                            {{ row.entry.name }}
                          </span>
                          @if (row.entry.kind === 'nestedRepo') {
                            <span
                              class="text-muted-foreground bg-muted rounded px-1 py-0.5 text-[10px]"
                              i18n
                            >
                              repo
                            </span>
                          } @else if (row.entry.kind === 'symlink') {
                            <span
                              class="text-muted-foreground bg-muted rounded px-1 py-0.5 text-[10px]"
                              i18n
                            >
                              link
                            </span>
                          } @else if (row.entry.kind === 'special') {
                            <span
                              class="text-muted-foreground bg-muted rounded px-1 py-0.5 text-[10px]"
                              i18n
                            >
                              special
                            </span>
                          } @else if (row.entry.ignored) {
                            <span
                              class="text-muted-foreground bg-muted rounded px-1 py-0.5 text-[10px]"
                              i18n
                            >
                              ignored
                            </span>
                          }
                        </button>

                        @if (row.entry.kind === 'file') {
                          <button
                            type="button"
                            hlmBtn
                            variant="ghost"
                            size="icon-xs"
                            data-testid="files-row-open-external"
                            class="text-muted-foreground hover:text-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
                            aria-label="Open externally"
                            i18n-aria-label
                            hlmTooltip="Open externally"
                            i18n-hlmTooltip
                            (click)="onOpenExternal(row.entry.path)"
                          >
                            <ng-icon name="lucideExternalLink" class="size-3" aria-hidden="true" />
                          </button>
                        }

                        <button
                          type="button"
                          hlmBtn
                          variant="ghost"
                          size="icon-xs"
                          data-testid="files-row-rename"
                          [attr.data-path]="row.entry.path"
                          class="text-muted-foreground hover:text-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
                          aria-label="Rename"
                          i18n-aria-label
                          hlmTooltip="Rename"
                          i18n-hlmTooltip
                          (click)="openRenameDialog(row.entry)"
                        >
                          <ng-icon name="lucidePencil" class="size-3" aria-hidden="true" />
                        </button>

                        <button
                          type="button"
                          hlmBtn
                          variant="ghost"
                          size="icon-xs"
                          data-testid="files-row-delete"
                          [attr.data-path]="row.entry.path"
                          class="text-destructive/70 hover:text-destructive opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
                          aria-label="Delete"
                          i18n-aria-label
                          hlmTooltip="Delete"
                          i18n-hlmTooltip
                          (click)="openDeleteDialog([row.entry])"
                        >
                          <ng-icon name="lucideTrash2" class="size-3" aria-hidden="true" />
                        </button>
                      </div>
                    }
                    @case ('loading') {
                      <div
                        class="text-muted-foreground py-1 text-xs"
                        [style.padding-left.rem]="row.depth * 0.75 + 1.5"
                        i18n
                      >
                        Loading…
                      </div>
                    }
                    @case ('empty') {
                      <div
                        class="text-muted-foreground py-1 text-xs"
                        [style.padding-left.rem]="row.depth * 0.75 + 1.5"
                        i18n
                      >
                        Empty folder
                      </div>
                    }
                    @case ('error') {
                      <div
                        class="text-destructive py-1 text-xs"
                        [style.padding-left.rem]="row.depth * 0.75 + 1.5"
                      >
                        {{ row.detail }}
                      </div>
                    }
                    @case ('loadMore') {
                      <button
                        type="button"
                        hlmBtn
                        variant="ghost"
                        size="xs"
                        [attr.data-testid]="
                          row.dirPath === '' ? 'files-load-more-root' : 'files-load-more-dir'
                        "
                        class="text-muted-foreground hover:text-foreground h-6 w-full justify-start text-xs font-normal"
                        [style.padding-left.rem]="row.depth * 0.75 + 1.5"
                        (click)="loadMore(row.dirPath, row.cursor)"
                        i18n
                      >
                        Load more files…
                      </button>
                    }
                  }
                }
              </div>
            }
          }
        </div>
      </div>
    }

    <ng-template #optionsMenu>
      <hlm-dropdown-menu class="w-56">
        <button
          type="button"
          hlmDropdownMenuCheckbox
          data-testid="files-toggle-ignored"
          [checked]="showIgnoredFiles()"
          [disabled]="!hasValidRoot() || togglingIgnored()"
          (triggered)="toggleShowIgnoredFiles()"
        >
          <span class="min-w-0 flex-1" i18n>Show Git-ignored files</span>
          <hlm-dropdown-menu-checkbox-indicator />
        </button>
        <hlm-dropdown-menu-separator />
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="files-menu-create-file"
          [disabled]="!hasValidRoot() || fileOperationBusy()"
          (triggered)="openCreateDialog('file')"
        >
          <ng-icon name="lucideFilePlus" class="mr-2 size-3.5" aria-hidden="true" />
          <span i18n>New file</span>
        </button>
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="files-menu-create-folder"
          [disabled]="!hasValidRoot() || fileOperationBusy()"
          (triggered)="openCreateDialog('folder')"
        >
          <ng-icon name="lucideFolderPlus" class="mr-2 size-3.5" aria-hidden="true" />
          <span i18n>New folder</span>
        </button>
        <hlm-dropdown-menu-separator />
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="files-menu-refresh"
          [disabled]="!hasValidRoot()"
          (triggered)="refreshAll()"
        >
          <span i18n>Refresh</span>
        </button>
      </hlm-dropdown-menu>
    </ng-template>

    <hlm-alert-dialog
      [state]="fileOperationDialogOpen() ? 'open' : 'closed'"
      (stateChanged)="onFileOperationDialogStateChange($event)"
    >
      <hlm-alert-dialog-content
        *hlmAlertDialogPortal="let ctx"
        class="sm:max-w-md"
        data-testid="files-operation-dialog"
        closeLabel="Close"
        i18n-closeLabel
      >
        @if (fileOperationDialog(); as dialog) {
          <hlm-alert-dialog-header>
            <h2
              hlmAlertDialogTitle
              class="font-display text-xl font-normal"
              data-testid="files-operation-dialog-title"
            >
              {{ fileOperationDialogTitle() }}
            </h2>
            <p hlmAlertDialogDescription data-testid="files-operation-dialog-description">
              {{ fileOperationDialogDescription() }}
            </p>
          </hlm-alert-dialog-header>

          @if (dialog._tag === 'create' || dialog._tag === 'rename') {
            <div class="flex flex-col gap-2 py-2">
              <label hlmLabel class="text-xs" i18n>Name</label>
              <input
                hlmInput
                type="text"
                data-testid="files-operation-name-input"
                class="h-8 text-xs"
                [value]="fileOperationName()"
                (input)="fileOperationName.set($any($event.target).value)"
                (keydown.enter)="confirmFileOperation()"
                [disabled]="fileOperationBusy()"
                i18n-placeholder
                placeholder="Name"
              />
            </div>
          }

          @if (dialog._tag === 'delete' || dialog._tag === 'permanentDelete') {
            <div class="py-2">
              <ul class="text-muted-foreground list-disc pl-4 text-xs">
                @for (path of dialog.relativePaths; track path) {
                  <li class="font-mono">{{ path }}</li>
                }
              </ul>
              @if (dialog._tag === 'permanentDelete') {
                <p class="text-destructive mt-2 text-xs" i18n>
                  Trash is unavailable. The selected items will be permanently deleted.
                </p>
              }
            </div>
          }

          @if (dialog._tag === 'progress') {
            <div class="py-2" aria-live="polite" aria-atomic="true">
              <div class="text-muted-foreground mb-1 text-xs">
                {{ fileOperationProgressLabel() }}
              </div>
              <hlm-progress [value]="fileOperationProgressPercent()">
                <hlm-progress-indicator />
              </hlm-progress>
            </div>
          }

          @if (dialog._tag === 'partialResult') {
            <div class="py-2">
              <ul class="text-muted-foreground list-disc pl-4 text-xs">
                @for (result of dialog.snapshot.pathResults ?? []; track result.path) {
                  <li>
                    <span class="font-mono">{{ result.path }}</span>
                    <span
                      [class.text-destructive]="result.status === 'Failed'"
                      [class.text-muted-foreground]="result.status !== 'Failed'"
                    >
                      — {{ formatPathResultStatus(result.status) }}
                    </span>
                    @if (result.detail) {
                      <span class="text-muted-foreground block">{{ result.detail }}</span>
                    }
                  </li>
                }
              </ul>
            </div>
          }

          <hlm-alert-dialog-footer>
            @if (dialog._tag !== 'progress') {
              <button
                hlmAlertDialogCancel
                type="button"
                data-testid="files-operation-cancel"
                [disabled]="fileOperationBusy()"
                (click)="closeFileOperationDialog()"
                i18n
              >
                Cancel
              </button>
            }
            @switch (dialog._tag) {
              @case ('create') {
                <button
                  hlmAlertDialogAction
                  type="button"
                  data-testid="files-operation-confirm"
                  [disabled]="fileOperationName().trim().length === 0 || fileOperationBusy()"
                  (click)="confirmFileOperation()"
                  i18n
                >
                  Create
                </button>
              }
              @case ('rename') {
                <button
                  hlmAlertDialogAction
                  type="button"
                  data-testid="files-operation-confirm"
                  [disabled]="fileOperationName().trim().length === 0 || fileOperationBusy()"
                  (click)="confirmFileOperation()"
                  i18n
                >
                  Rename
                </button>
              }
              @case ('delete') {
                <button
                  hlmAlertDialogAction
                  type="button"
                  variant="destructive"
                  data-testid="files-operation-confirm"
                  [disabled]="fileOperationBusy()"
                  (click)="confirmFileOperation()"
                  i18n
                >
                  Delete
                </button>
              }
              @case ('permanentDelete') {
                <button
                  hlmAlertDialogAction
                  type="button"
                  variant="destructive"
                  data-testid="files-operation-confirm"
                  [disabled]="fileOperationBusy()"
                  (click)="confirmFileOperation()"
                  i18n
                >
                  Delete permanently
                </button>
              }
              @case ('partialResult') {
                <button
                  hlmAlertDialogAction
                  type="button"
                  data-testid="files-operation-confirm"
                  (click)="closeFileOperationDialog()"
                  i18n
                >
                  Done
                </button>
              }
            }
          </hlm-alert-dialog-footer>
        }
      </hlm-alert-dialog-content>
    </hlm-alert-dialog>
  `,
})
export class FilesBrowser {
  private readonly runtime = inject(EffectRuntime);
  private readonly destroyRef = inject(DestroyRef);

  readonly target = input.required<FilesRootTarget | null>();
  readonly rootContextLabel = input<string>('');
  readonly rootFolderName = input<string>('');
  readonly worktreeMissing = input<boolean>(false);
  readonly liveRefreshTick = input<number>(0);

  private readonly treeItemBtns = viewChildren<ElementRef<HTMLButtonElement>>('treeItemBtn');

  protected readonly directories = signal<ReadonlyMap<string, DirectoryState>>(new Map());
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  protected readonly showIgnoredFiles = signal(false);
  protected readonly isGitRepo = signal(false);
  protected readonly togglingIgnored = signal(false);
  protected readonly activePreviewPath = signal<string | null>(null);
  protected readonly previewState = signal<PreviewState>({ status: 'idle' });
  protected readonly focusedTreePath = signal<string | null>(null);
  private readonly lastOpenedTreePath = signal<string | null>(null);
  private readonly pendingFocusPath = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly watchWarning = signal<Extract<
    FilesWatchEvent,
    { readonly _tag: 'Unavailable' }
  > | null>(null);
  protected readonly fileOperationDialog = signal<FileOperationDialog>({ _tag: 'closed' });
  protected readonly fileOperationName = signal('');
  protected readonly fileOperationBusy = signal(false);
  protected readonly fileOperationFocusRestore = signal<string | null>(null);
  protected readonly formatPathResultStatus = formatPathResultStatus;

  private targetGeneration = 0;
  private listController: AbortController | null = null;
  private previewController: AbortController | null = null;
  private watchController: AbortController | null = null;
  private lastSeenTargetKey = '';
  private lastSeenRefreshTick = 0;

  protected readonly hasValidRoot = computed(
    () => !this.worktreeMissing() && this.target() !== null,
  );
  protected readonly rootDirState = computed(() => this.directories().get(''));

  protected readonly loadedPreview = computed(() => {
    const state = this.previewState();
    return state.status === 'loaded' ? state.preview : null;
  });

  protected readonly previewErrorState = computed(() => {
    const state = this.previewState();
    return state.status === 'error' ? state : null;
  });

  protected readonly isTextPreview = computed(() => {
    const loaded = this.loadedPreview();
    return loaded?._tag === 'Text';
  });

  protected readonly canOpenPreviewExternally = computed(() => {
    const loaded = this.loadedPreview();
    if (!loaded) return false;
    return loaded._tag === 'Text' || loaded._tag === 'Binary';
  });

  protected readonly fileOperationDialogOpen = computed(
    () => this.fileOperationDialog()._tag !== 'closed',
  );

  protected readonly fileOperationDialogTitle = computed(() => {
    const dialog = this.fileOperationDialog();
    switch (dialog._tag) {
      case 'create':
        return dialog.kind === 'folder' ? $localize`New folder` : $localize`New file`;
      case 'rename':
        return $localize`Rename ${dialog.currentName}`;
      case 'delete':
        return dialog.relativePaths.length === 1
          ? $localize`Delete ${basenameOf(dialog.relativePaths[0] ?? '')}`
          : $localize`Delete ${String(dialog.relativePaths.length)} items`;
      case 'permanentDelete':
        return dialog.relativePaths.length === 1
          ? $localize`Permanently delete ${basenameOf(dialog.relativePaths[0] ?? '')}`
          : $localize`Permanently delete ${String(dialog.relativePaths.length)} items`;
      case 'progress':
        return dialog.title;
      case 'partialResult':
        return $localize`Some paths could not be changed`;
      case 'closed':
        return '';
    }
  });

  protected readonly fileOperationDialogDescription = computed(() => {
    const dialog = this.fileOperationDialog();
    switch (dialog._tag) {
      case 'create':
        return dialog.dirPath === ''
          ? $localize`Create a new ${dialog.kind === 'folder' ? 'folder' : 'file'} in the workspace root.`
          : $localize`Create a new ${dialog.kind === 'folder' ? 'folder' : 'file'} in ${dialog.dirPath}.`;
      case 'rename':
        return $localize`Enter a new name for this item.`;
      case 'delete':
        return dialog.relativePaths.length === 1
          ? $localize`This item will be moved to trash.`
          : $localize`These items will be moved to trash.`;
      case 'permanentDelete':
        return dialog.relativePaths.length === 1
          ? $localize`This item cannot be moved to trash and will be permanently deleted.`
          : $localize`These items cannot be moved to trash and will be permanently deleted.`;
      case 'progress':
        return $localize`Working…`;
      case 'partialResult':
        return $localize`Some paths were changed and others failed.`;
      case 'closed':
        return '';
    }
  });

  protected readonly fileOperationProgressLabel = computed(() => {
    const dialog = this.fileOperationDialog();
    if (dialog._tag !== 'progress') return '';
    const step = dialog.snapshot.progress?.step;
    if (step === undefined) return $localize`Working…`;
    switch (step) {
      case 'Validating':
        return $localize`Validating…`;
      case 'Reserving':
        return $localize`Reserving…`;
      case 'Preparing':
        return $localize`Preparing…`;
      case 'ExecutingGit':
        return $localize`Applying changes…`;
      case 'VerifyingPostconditions':
        return $localize`Verifying…`;
      case 'Reconciling':
        return $localize`Reconciling…`;
      case 'Done':
        return $localize`Finished`;
      case 'RefreshingInventory':
        return $localize`Refreshing inventory…`;
      default:
        return $localize`Working…`;
    }
  });

  protected readonly fileOperationProgressPercent = computed(() => {
    const dialog = this.fileOperationDialog();
    if (dialog._tag !== 'progress') return 0;
    const step = dialog.snapshot.progress?.step;
    if (step === undefined) return 30;
    switch (step) {
      case 'Validating':
        return 15;
      case 'Reserving':
        return 30;
      case 'Preparing':
        return 45;
      case 'ExecutingGit':
        return 65;
      case 'VerifyingPostconditions':
        return 85;
      case 'Reconciling':
        return 70;
      case 'Done':
        return 100;
      case 'RefreshingInventory':
        return 95;
      default:
        return 30;
    }
  });

  protected readonly visibleRows = computed<ReadonlyArray<VisibleTreeRow>>(() => {
    const dirs = this.directories();
    const openDirs = this.expanded();
    const out: VisibleTreeRow[] = [];

    const appendDir = (dirPath: string, depth: number): void => {
      const state = dirs.get(dirPath);
      if (!state) return;
      if (state.status === 'loading' && state.entries.length === 0) {
        if (dirPath !== '') {
          out.push({ key: `loading:${dirPath}`, kind: 'loading', depth, dirPath });
        }
        return;
      }
      if (state.status === 'error') {
        if (dirPath !== '') {
          out.push({
            key: `error:${dirPath}`,
            kind: 'error',
            depth,
            dirPath,
            detail: state.errorDetail ?? '',
          });
        }
        return;
      }
      if (dirPath !== '' && state.entries.length === 0) {
        out.push({ key: `empty:${dirPath}`, kind: 'empty', depth, dirPath });
        return;
      }
      for (const entry of state.entries) {
        out.push({ key: `entry:${entry.path}`, kind: 'entry', depth, entry });
        if (entry.kind === 'directory' && openDirs.has(entry.path)) {
          appendDir(entry.path, depth + 1);
        }
      }
      if (state.hasMore && state.nextCursor !== undefined) {
        out.push({
          key: `more:${dirPath}`,
          kind: 'loadMore',
          depth,
          dirPath,
          cursor: state.nextCursor,
        });
      }
    };

    appendDir('', 0);
    return out;
  });

  protected readonly effectiveFocusedEntryPath = computed<string | null>(() => {
    const rows = this.visibleRows();
    const focused = this.focusedTreePath();
    if (
      focused !== null &&
      rows.some((row) => row.kind === 'entry' && row.entry.path === focused)
    ) {
      return focused;
    }
    const firstEntry = rows.find((row) => row.kind === 'entry');
    return firstEntry?.kind === 'entry' ? firstEntry.entry.path : null;
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.abortActiveWork();
    });

    // Reload root & restart live watcher whenever Project/Worktree root identity changes.
    effect(() => {
      const target = this.target();
      const missing = this.worktreeMissing();
      const key = missing ? '' : formatTargetKey(target);
      untracked(() => {
        if (key === this.lastSeenTargetKey) return;
        this.lastSeenTargetKey = key;
        this.resetForTargetChange();
        if (!missing && target !== null) {
          this.loadDirectory(target, '', { resetOnStart: true });
          this.startWatching(target);
        }
      });
    });

    // React to external Step / Turn-end refresh signals from SessionView.
    effect(() => {
      const tick = this.liveRefreshTick();
      untracked(() => {
        if (tick === this.lastSeenRefreshTick) return;
        this.lastSeenRefreshTick = tick;
        if (tick > 0 && this.hasValidRoot()) {
          this.refreshAll();
        }
      });
    });

    // Restore DOM focus back to the exact treeitem after returning from preview.
    effect(() => {
      const targetPath = this.pendingFocusPath();
      const previewOpen = this.activePreviewPath() !== null;
      const buttons = this.treeItemBtns();
      if (targetPath === null || previewOpen) return;
      const match = buttons.find((el) => el.nativeElement.dataset['path'] === targetPath);
      if (match) {
        match.nativeElement.focus();
        untracked(() => {
          this.pendingFocusPath.set(null);
        });
      }
    });
  }

  protected isExpanded(dirPath: string): boolean {
    return this.expanded().has(dirPath);
  }

  protected isFocusedEntry(entryPath: string): boolean {
    return this.effectiveFocusedEntryPath() === entryPath;
  }

  protected iconFor(kind: FilesEntryKind): string {
    return entryIconName(kind);
  }

  protected formatSize(bytes: number): string {
    return formatBytes(bytes);
  }

  protected unavailableMessage(reason: FilesUnavailableReason): string {
    switch (reason) {
      case 'Missing':
        return $localize`File is no longer available on disk.`;
      case 'Symlink':
        return $localize`Symbolic links are not followed for preview.`;
      case 'SpecialFile':
        return $localize`Special files cannot be previewed.`;
      case 'NestedRepo':
        return $localize`Nested Git repositories cannot be traversed here.`;
      case 'Directory':
        return $localize`Choose a file inside the folder to preview it.`;
      case 'Unreadable':
        return $localize`You do not have permission to read this file.`;
    }
  }

  protected onEntryClick(entry: FilesEntry): void {
    this.focusedTreePath.set(entry.path);
    if (entry.kind === 'directory') {
      this.toggleFolder(entry.path);
      return;
    }
    this.openEntryPreview(entry);
  }

  protected loadMore(dirPath: string, cursor: string): void {
    const target = this.target();
    if (!target || this.worktreeMissing()) return;
    this.loadDirectory(target, dirPath, { cursor });
  }

  protected refreshAll(): void {
    const target = this.target();
    if (!target || this.worktreeMissing()) return;
    this.actionError.set(null);
    this.watchWarning.set(null);
    this.loadDirectory(target, '', { resetOnStart: false });
    for (const openDir of this.expanded()) {
      this.loadDirectory(target, openDir, { resetOnStart: false });
    }
    const previewPath = this.activePreviewPath();
    if (previewPath !== null) {
      this.reloadPreview(previewPath, { silent: true });
    }
  }

  protected closePreview(): void {
    const restore = this.lastOpenedTreePath() ?? this.activePreviewPath();
    this.previewController?.abort();
    this.previewController = null;
    this.activePreviewPath.set(null);
    this.previewState.set({ status: 'idle' });
    this.actionError.set(null);
    if (restore !== null) {
      this.focusedTreePath.set(restore);
      this.pendingFocusPath.set(restore);
    }
  }

  protected openCreateDialog(kind: FileOperationCreateKind): void {
    const target = this.target();
    if (!target || this.worktreeMissing()) return;
    const focused = this.focusedTreePath();
    const dirPath =
      focused !== null
        ? this.directoryContaining(focused)
        : (this.effectiveFocusedEntryPath() ?? '');
    this.fileOperationFocusRestore.set(focused);
    this.fileOperationName.set('');
    this.fileOperationDialog.set({ _tag: 'create', dirPath, kind });
  }

  protected openRenameDialog(entry: FilesEntry): void {
    this.fileOperationFocusRestore.set(entry.path);
    this.fileOperationName.set(entry.name);
    this.fileOperationDialog.set({
      _tag: 'rename',
      relativePath: entry.path,
      currentName: entry.name,
    });
  }

  protected openDeleteDialog(entries: ReadonlyArray<FilesEntry>): void {
    const paths = entries.map((e) => e.path);
    this.fileOperationFocusRestore.set(paths[0] ?? null);
    this.fileOperationDialog.set({ _tag: 'delete', relativePaths: paths });
  }

  protected closeFileOperationDialog(): void {
    this.fileOperationDialog.set({ _tag: 'closed' });
    this.fileOperationName.set('');
    this.fileOperationBusy.set(false);
    this.restoreFileOperationFocus();
  }

  protected onFileOperationDialogStateChange(next: string): void {
    if (next === 'closed') this.closeFileOperationDialog();
  }

  protected confirmFileOperation(): void {
    const dialog = this.fileOperationDialog();
    if (dialog._tag === 'closed' || dialog._tag === 'progress' || dialog._tag === 'partialResult') {
      return;
    }
    if (dialog._tag === 'create' || dialog._tag === 'rename') {
      const name = this.fileOperationName().trim();
      if (name.length === 0) return;
      this.runFileOperationReview(dialog);
      return;
    }
    if (dialog._tag === 'delete') {
      this.runFileOperationReview(dialog);
      return;
    }
    if (dialog._tag === 'permanentDelete') {
      this.executeReviewedOperation(dialog.review, true);
    }
  }

  private directoryContaining(relativePath: string): string {
    const row = this.allVisibleEntries().find((e) => e.entry.path === relativePath);
    if (row !== undefined && row.entry.kind === 'directory') return relativePath;
    const parent = parentDirOf(relativePath);
    return parent;
  }

  private readonly allVisibleEntries = computed(() =>
    this.visibleRows().filter(
      (row): row is Extract<VisibleTreeRow, { readonly kind: 'entry' }> => row.kind === 'entry',
    ),
  );

  private runFileOperationReview(
    dialog: Extract<
      FileOperationDialog,
      { _tag: 'create' } | { _tag: 'rename' } | { _tag: 'delete' }
    >,
  ): void {
    const target = this.target();
    if (!target || this.worktreeMissing()) return;
    this.fileOperationBusy.set(true);
    this.actionError.set(null);

    const reviewEffect =
      dialog._tag === 'create'
        ? reviewCreateFile({
            target,
            dirPath: dialog.dirPath,
            name: this.fileOperationName().trim(),
            kind: dialog.kind,
          })
        : dialog._tag === 'rename'
          ? reviewRenameFile({
              target,
              relativePath: dialog.relativePath,
              newName: this.fileOperationName().trim(),
            })
          : reviewDeleteFiles({ target, relativePaths: dialog.relativePaths });

    void this.runtime.run(reviewEffect).then((exit) => {
      if (Exit.isFailure(exit)) {
        this.fileOperationBusy.set(false);
        this.actionError.set(extractExitErrorDetail(exit));
        return;
      }
      const review = exit.value;
      const firstBlocker = review.blockers[0];
      if (firstBlocker !== undefined) {
        this.fileOperationBusy.set(false);
        this.actionError.set(formatFileOperationBlocker(firstBlocker.code, firstBlocker.detail));
        return;
      }
      if (dialog._tag === 'delete' && review.requiresPermanentConfirmation) {
        this.fileOperationBusy.set(false);
        this.fileOperationDialog.set({
          _tag: 'permanentDelete',
          relativePaths: dialog.relativePaths,
          review,
        });
        return;
      }
      this.executeReviewedOperation(review);
    });
  }

  private executeReviewedOperation(
    review: FileOperationReview,
    allowPermanentDelete?: boolean,
  ): void {
    this.fileOperationBusy.set(true);
    this.fileOperationDialog.set({
      _tag: 'progress',
      kind: review.kind,
      title: fileOperationTitle(review.kind),
      snapshot: {
        id: OperationId.make(`pending-${review.reviewId}`),
        kind: review.kind,
        title: fileOperationTitle(review.kind),
        phase: 'Applying',
        progress: { step: 'ExecutingGit' },
        warnings: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    void this.runtime.run(executeFileOperation({ review, allowPermanentDelete })).then((exit) => {
      this.fileOperationBusy.set(false);
      if (Exit.isFailure(exit)) {
        const errOption = Cause.findErrorOption(exit.cause);
        const typed =
          Option.isSome(errOption) &&
          errOption.value instanceof Error &&
          'reason' in errOption.value
            ? (errOption.value as { reason?: string; detail?: string })
            : null;
        if (typed?.reason === 'TrashUnavailable') {
          // The trash-mode review was consumed by the failed attempt. Issue a fresh
          // permanent-mode review so the new confirmation and operation id are explicit.
          this.offerPermanentDelete(review.targets.map((t) => t.path));
          return;
        }
        this.fileOperationDialog.set({ _tag: 'closed' });
        this.actionError.set(typed?.detail ?? extractExitErrorDetail(exit));
        this.restoreFileOperationFocus();
        return;
      }
      const snapshot = exit.value;
      if (snapshot.outcome === 'Partial') {
        this.fileOperationDialog.set({ _tag: 'partialResult', snapshot });
        this.refreshAll();
        return;
      }
      this.fileOperationDialog.set({ _tag: 'closed' });
      this.refreshAll();
      this.restoreFileOperationFocus();
    });
  }

  private offerPermanentDelete(relativePaths: ReadonlyArray<string>): void {
    const target = this.target();
    if (!target || this.worktreeMissing()) return;
    this.fileOperationBusy.set(true);
    this.actionError.set(null);
    void this.runtime
      .run(reviewDeleteFiles({ target, relativePaths, permanent: true }))
      .then((exit) => {
        this.fileOperationBusy.set(false);
        if (Exit.isFailure(exit)) {
          this.actionError.set(extractExitErrorDetail(exit));
          this.restoreFileOperationFocus();
          return;
        }
        const review = exit.value;
        const firstBlocker = review.blockers[0];
        if (firstBlocker !== undefined) {
          this.actionError.set(formatFileOperationBlocker(firstBlocker.code, firstBlocker.detail));
          return;
        }
        if (!review.requiresPermanentConfirmation) {
          this.actionError.set($localize`Permanent deletion needs a fresh review. Try again.`);
          return;
        }
        this.fileOperationDialog.set({ _tag: 'permanentDelete', relativePaths, review });
      });
  }

  private restoreFileOperationFocus(): void {
    const restore = this.fileOperationFocusRestore();
    this.fileOperationFocusRestore.set(null);
    if (restore !== null) {
      this.focusedTreePath.set(restore);
      this.pendingFocusPath.set(restore);
    }
  }

  protected onPreviewEscape(event: Event): void {
    event.stopPropagation();
    event.preventDefault();
    this.closePreview();
  }

  protected reloadPreview(relativePath: string, options: { readonly silent?: boolean } = {}): void {
    const target = this.target();
    if (!target || this.worktreeMissing()) return;
    this.previewController?.abort();
    const controller = new AbortController();
    this.previewController = controller;
    const generation = this.targetGeneration;
    if (!options.silent) {
      this.previewState.set({ status: 'loading', path: relativePath });
    }

    void this.runtime
      .run(readPreviewEffect({ target, relativePath }), { signal: controller.signal })
      .then((exit) => {
        if (controller.signal.aborted || generation !== this.targetGeneration) return;
        if (this.activePreviewPath() !== relativePath) return;
        if (Exit.isSuccess(exit)) {
          this.previewState.set({ status: 'loaded', preview: exit.value });
          return;
        }
        const detail = extractExitErrorDetail(exit);
        this.previewState.set({
          status: 'error',
          path: relativePath,
          detail,
        });
      });
  }

  protected onOpenExternal(relativePath: string): void {
    const target = this.target();
    if (!target || this.worktreeMissing()) return;
    this.actionError.set(null);
    void this.runtime.run(openExternalEffect({ target, relativePath })).then((exit) => {
      if (Exit.isFailure(exit)) {
        this.actionError.set(
          $localize`Could not open ${basenameOf(relativePath)} externally: ${extractExitErrorDetail(exit)}`,
        );
      }
    });
  }

  protected toggleShowIgnoredFiles(): void {
    const target = this.target();
    if (!target || this.worktreeMissing() || this.togglingIgnored()) return;
    const next = !this.showIgnoredFiles();
    this.togglingIgnored.set(true);
    this.actionError.set(null);
    const generation = this.targetGeneration;

    void this.runtime.run(setShowIgnoredEffect(target, next)).then((exit) => {
      if (generation !== this.targetGeneration) return;
      this.togglingIgnored.set(false);
      if (Exit.isFailure(exit)) {
        this.actionError.set(extractExitErrorDetail(exit));
        return;
      }
      const updated = exit.value.settings.showIgnoredFiles ?? next;
      this.showIgnoredFiles.set(updated);
      this.refreshAll();
    });
  }

  protected onTreeKeydown(event: KeyboardEvent): void {
    const entries = this.visibleRows().filter(
      (row): row is Extract<VisibleTreeRow, { readonly kind: 'entry' }> => row.kind === 'entry',
    );
    if (entries.length === 0) return;

    const currentPath = this.effectiveFocusedEntryPath();
    const currentIndex = entries.findIndex((row) => row.entry.path === currentPath);
    const activeIndex = currentIndex === -1 ? 0 : currentIndex;
    const current = entries[activeIndex];
    if (!current) return;

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = entries[Math.min(entries.length - 1, activeIndex + 1)];
        if (next) this.focusEntryRow(next.entry.path);
        return;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prev = entries[Math.max(0, activeIndex - 1)];
        if (prev) this.focusEntryRow(prev.entry.path);
        return;
      }
      case 'Home': {
        event.preventDefault();
        const first = entries[0];
        if (first) this.focusEntryRow(first.entry.path);
        return;
      }
      case 'End': {
        event.preventDefault();
        const last = entries[entries.length - 1];
        if (last) this.focusEntryRow(last.entry.path);
        return;
      }
      case 'ArrowRight': {
        if (current.entry.kind !== 'directory') return;
        event.preventDefault();
        if (!this.expanded().has(current.entry.path)) {
          this.toggleFolder(current.entry.path);
          return;
        }
        const child = entries[activeIndex + 1];
        if (child && child.depth > current.depth) {
          this.focusEntryRow(child.entry.path);
        }
        return;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (current.entry.kind === 'directory' && this.expanded().has(current.entry.path)) {
          this.toggleFolder(current.entry.path);
          return;
        }
        if (current.depth > 0) {
          const parentPath = parentDirOf(current.entry.path);
          this.focusEntryRow(parentPath);
        }
        return;
      }
    }
  }

  private focusEntryRow(entryPath: string): void {
    this.focusedTreePath.set(entryPath);
    const btn = this.treeItemBtns().find((el) => el.nativeElement.dataset['path'] === entryPath);
    btn?.nativeElement.focus();
  }

  private toggleFolder(dirPath: string): void {
    const target = this.target();
    if (!target || this.worktreeMissing()) return;
    const nextExpanded = new Set(this.expanded());
    if (nextExpanded.has(dirPath)) {
      nextExpanded.delete(dirPath);
      this.expanded.set(nextExpanded);
      return;
    }
    nextExpanded.add(dirPath);
    this.expanded.set(nextExpanded);
    if (!this.directories().has(dirPath)) {
      this.loadDirectory(target, dirPath, { resetOnStart: true });
    }
  }

  private openEntryPreview(entry: FilesEntry): void {
    this.lastOpenedTreePath.set(entry.path);
    this.actionError.set(null);
    this.activePreviewPath.set(entry.path);

    if (entry.kind === 'nestedRepo') {
      this.previewState.set({
        status: 'loaded',
        preview: {
          _tag: 'Unavailable',
          path: entry.path,
          reason: 'NestedRepo',
          detail: 'Nested repositories are not traversed.',
        },
      });
      return;
    }
    if (entry.kind === 'special') {
      this.previewState.set({
        status: 'loaded',
        preview: {
          _tag: 'Unavailable',
          path: entry.path,
          reason: 'SpecialFile',
          detail: 'Special files are unsupported.',
        },
      });
      return;
    }

    this.reloadPreview(entry.path);
  }

  private loadDirectory(
    target: FilesRootTarget,
    dirPath: string,
    options: { readonly resetOnStart?: boolean; readonly cursor?: string },
  ): void {
    const generation = this.targetGeneration;
    if (options.resetOnStart && options.cursor === undefined) {
      const next = new Map(this.directories());
      next.set(dirPath, { status: 'loading', entries: [], hasMore: false });
      this.directories.set(next);
    }

    const controller = new AbortController();
    if (dirPath === '' && options.cursor === undefined) {
      this.listController?.abort();
      this.listController = controller;
    }

    void this.runtime
      .run(
        listDirEffect({
          target,
          dirPath,
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        }),
        { signal: controller.signal },
      )
      .then((exit) => {
        if (controller.signal.aborted || generation !== this.targetGeneration) return;
        if (Exit.isSuccess(exit)) {
          this.applyDirectoryPage(dirPath, exit.value, options.cursor !== undefined);
          return;
        }
        const detail = extractExitErrorDetail(exit);
        const next = new Map(this.directories());
        next.set(dirPath, {
          status: 'error',
          entries: [],
          hasMore: false,
          errorDetail: detail,
        });
        this.directories.set(next);
      });
  }

  private applyDirectoryPage(dirPath: string, page: FilesDirectoryPage, append: boolean): void {
    this.isGitRepo.set(page.isGitRepo);
    this.showIgnoredFiles.set(page.showIgnoredFiles);

    const next = new Map(this.directories());
    const previous = next.get(dirPath);
    let entries: ReadonlyArray<FilesEntry> = page.entries;
    if (append && previous) {
      const seen = new Set(previous.entries.map((item) => item.path));
      entries = [...previous.entries, ...page.entries.filter((item) => !seen.has(item.path))];
    }
    next.set(dirPath, {
      status: 'loaded',
      entries,
      hasMore: page.hasMore,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });

    // Prune expanded child folders that disappeared on refresh.
    if (!append) {
      const childDirs = new Set(
        entries.filter((item) => item.kind === 'directory').map((item) => item.path),
      );
      const prefix = dirPath === '' ? '' : `${dirPath}/`;
      const nextExpanded = new Set(this.expanded());
      let expandedChanged = false;
      for (const openPath of nextExpanded) {
        if (
          parentDirOf(openPath) === dirPath &&
          openPath.startsWith(prefix) &&
          !childDirs.has(openPath)
        ) {
          nextExpanded.delete(openPath);
          next.delete(openPath);
          expandedChanged = true;
        }
      }
      if (expandedChanged) {
        this.expanded.set(nextExpanded);
      }
    }

    this.directories.set(next);
  }

  private startWatching(target: FilesRootTarget): void {
    this.watchController?.abort();
    const controller = new AbortController();
    this.watchController = controller;
    const generation = this.targetGeneration;

    const program = Effect.gen(function* () {
      const api = yield* DesktopApi;
      return api['Files.watch']({ target });
    }).pipe(
      Stream.unwrap,
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (!controller.signal.aborted && generation === this.targetGeneration) {
            this.handleWatchEvent(event);
          }
        }),
      ),
    );

    void this.runtime.run(program, { signal: controller.signal }).then((exit) => {
      if (controller.signal.aborted || generation !== this.targetGeneration) return;
      if (Exit.isFailure(exit)) {
        this.watchWarning.set({
          _tag: 'Unavailable',
          reason: 'WatchFailed',
          detail: extractExitErrorDetail(exit),
        });
      }
    });
  }

  private handleWatchEvent(event: FilesWatchEvent): void {
    if (event._tag === 'Unavailable') {
      this.watchWarning.set(event);
      return;
    }
    this.watchWarning.set(null);

    const target = this.target();
    if (!target || this.worktreeMissing()) return;

    if (event.overflow) {
      this.refreshAll();
      return;
    }

    if (isSameDirectoryTargetList(event.paths, '')) {
      this.loadDirectory(target, '', { resetOnStart: false });
    }
    for (const openDir of this.expanded()) {
      if (isSameDirectoryTargetList(event.paths, openDir)) {
        this.loadDirectory(target, openDir, { resetOnStart: false });
      }
    }

    const previewPath = this.activePreviewPath();
    if (previewPath !== null && doesChangeTouchFile(event.paths, previewPath)) {
      this.reloadPreview(previewPath, { silent: true });
    }
  }

  private resetForTargetChange(): void {
    this.abortActiveWork();
    this.targetGeneration += 1;
    this.directories.set(new Map());
    this.expanded.set(new Set());
    this.activePreviewPath.set(null);
    this.previewState.set({ status: 'idle' });
    this.focusedTreePath.set(null);
    this.lastOpenedTreePath.set(null);
    this.pendingFocusPath.set(null);
    this.actionError.set(null);
    this.watchWarning.set(null);
  }

  private abortActiveWork(): void {
    this.listController?.abort();
    this.listController = null;
    this.previewController?.abort();
    this.previewController = null;
    this.watchController?.abort();
    this.watchController = null;
  }
}

const isSameDirectoryTargetList = (watchedPaths: ReadonlyArray<string>, dirPath: string): boolean =>
  watchedPaths.some((path) => isSameDirectoryTarget(path, dirPath));

const extractExitErrorDetail = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return '';
  const failureText = String(exit.cause);
  return failureText.includes('detail') ? failureText : $localize`Unable to complete request.`;
};
