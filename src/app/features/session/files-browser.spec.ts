import '@angular/compiler';
import { provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
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
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, Queue, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileOperationRpcs,
  FileOperationsError,
  type FileOperationBlockerCode,
  type FileOperationReview,
} from '../../../shared/files/file-operations.rpc';
import {
  FilesRpcs,
  type FilesDirectoryPage,
  type FilesError,
  type FilesPreview,
  type FilesRootTarget,
  type FilesWatchEvent,
} from '../../../shared/files/files.rpc';
import {
  ProjectId,
  ProjectsRpcs,
  type Project,
  type ProjectSettingsPatch,
} from '../../../shared/projects/projects.rpc';
import { OperationId, ReviewId } from '../../../shared/source-control/source-control.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { FilesBrowser } from './files-browser';

const projectId = ProjectId.make('proj-ui');

const makeProject = (showIgnoredFiles?: boolean): Project => ({
  id: projectId,
  name: 'spence',
  path: '/work/spence',
  addedAt: 1,
  lastUsedAt: 1,
  settings: showIgnoredFiles === undefined ? {} : { showIgnoredFiles },
  folderMissing: false,
});

interface FilesTestHarness {
  showIgnoredFiles: boolean;
  isGitRepo: boolean;
  readonly dirs: Map<string, FilesDirectoryPage>;
  readonly previews: Map<string, FilesPreview>;
  readonly listCalls: Array<{ readonly dirPath: string; readonly cursor?: string }>;
  readonly openedExternal: Array<string>;
  readonly patches: Array<ProjectSettingsPatch>;
  readonly reviewCalls: Array<{
    readonly kind: 'create' | 'rename' | 'delete';
    readonly params: unknown;
  }>;
  readonly executeCalls: Array<{
    readonly reviewId: string;
    readonly allowPermanentDelete?: boolean;
  }>;
  reviewBlockers: Array<{ readonly code: FileOperationBlockerCode; readonly detail: string }>;
  trashUnavailable: boolean;
  watchQueue: Queue.Queue<FilesWatchEvent>;
  openExternalError?: FilesError;
}

const makeHarness = (): FilesTestHarness => {
  const dirs = new Map<string, FilesDirectoryPage>([
    [
      '',
      {
        dirPath: '',
        isGitRepo: true,
        showIgnoredFiles: false,
        entries: [
          { path: 'src', name: 'src', kind: 'directory', ignored: false },
          { path: 'vendor/sub', name: 'sub', kind: 'nestedRepo', ignored: false },
          { path: 'link-out', name: 'link-out', kind: 'symlink', ignored: false },
          { path: 'README.md', name: 'README.md', kind: 'file', ignored: false, size: 120 },
          { path: 'huge.log', name: 'huge.log', kind: 'file', ignored: false, size: 3_000_000 },
          { path: 'logo.png', name: 'logo.png', kind: 'file', ignored: false, size: 2048 },
        ],
        hasMore: true,
        nextCursor: '1:logo.png',
      },
    ],
    [
      '__page2__',
      {
        dirPath: '',
        isGitRepo: true,
        showIgnoredFiles: false,
        entries: [{ path: 'zeta.txt', name: 'zeta.txt', kind: 'file', ignored: false, size: 15 }],
        hasMore: false,
      },
    ],
    [
      'src',
      {
        dirPath: 'src',
        isGitRepo: true,
        showIgnoredFiles: false,
        entries: [{ path: 'src/main.ts', name: 'main.ts', kind: 'file', ignored: false, size: 32 }],
        hasMore: false,
      },
    ],
  ]);

  const previews = new Map<string, FilesPreview>([
    [
      'README.md',
      {
        _tag: 'Text',
        path: 'README.md',
        content: '# Spence\nCalm file preview.',
        byteLength: 27,
        totalBytes: 27,
        truncated: false,
        previewLimitBytes: 2 * 1024 * 1024,
        mtimeMs: 1,
      },
    ],
    [
      'src/main.ts',
      {
        _tag: 'Text',
        path: 'src/main.ts',
        content: 'export const ok = true;\n',
        byteLength: 24,
        totalBytes: 24,
        truncated: false,
        previewLimitBytes: 2 * 1024 * 1024,
        mtimeMs: 1,
      },
    ],
    [
      'huge.log',
      {
        _tag: 'Text',
        path: 'huge.log',
        content: 'truncated-head\n',
        byteLength: 2 * 1024 * 1024,
        totalBytes: 3_000_000,
        truncated: true,
        previewLimitBytes: 2 * 1024 * 1024,
        mtimeMs: 1,
      },
    ],
    [
      'logo.png',
      {
        _tag: 'Binary',
        path: 'logo.png',
        totalBytes: 2048,
        mtimeMs: 1,
      },
    ],
    [
      'zeta.txt',
      {
        _tag: 'Unavailable',
        path: 'zeta.txt',
        reason: 'Missing',
        detail: 'File missing',
      },
    ],
  ]);

  return {
    showIgnoredFiles: false,
    isGitRepo: true,
    dirs,
    previews,
    listCalls: [],
    openedExternal: [],
    patches: [],
    reviewCalls: [],
    executeCalls: [],
    reviewBlockers: [],
    trashUnavailable: false,
    watchQueue: Effect.runSync(Queue.unbounded<FilesWatchEvent>()),
  };
};

const mount = (
  harness: FilesTestHarness,
  target: FilesRootTarget = { projectId },
  rootContextLabel = 'main',
): ComponentFixture<FilesBrowser> => {
  const layer = makeDesktopTestLayer(
    Layer.mergeAll(
      FilesRpcs.toLayer({
        'Files.listDir': ({ dirPath, cursor }) =>
          Effect.sync(() => {
            harness.listCalls.push({
              dirPath,
              ...(cursor === undefined ? {} : { cursor }),
            });
            const key = dirPath === '' && cursor !== undefined ? '__page2__' : dirPath;
            const base = harness.dirs.get(key) ?? {
              dirPath,
              isGitRepo: harness.isGitRepo,
              showIgnoredFiles: harness.showIgnoredFiles,
              entries: [],
              hasMore: false,
            };
            const extraIgnored =
              dirPath === '' && cursor === undefined && harness.showIgnoredFiles
                ? [
                    {
                      path: 'debug.log',
                      name: 'debug.log',
                      kind: 'file' as const,
                      ignored: true,
                      size: 10,
                    },
                  ]
                : [];
            return {
              ...base,
              isGitRepo: harness.isGitRepo,
              showIgnoredFiles: harness.showIgnoredFiles,
              entries: [...base.entries, ...extraIgnored],
            };
          }),
        'Files.readPreview': ({ relativePath }) =>
          Effect.sync(
            () =>
              harness.previews.get(relativePath) ?? {
                _tag: 'Unavailable',
                path: relativePath,
                reason: 'Missing',
                detail: 'Not found',
              },
          ),
        'Files.openExternal': ({ relativePath }) =>
          harness.openExternalError
            ? Effect.fail(harness.openExternalError)
            : Effect.sync(() => {
                harness.openedExternal.push(relativePath);
              }),
        'Files.watch': () => Stream.fromQueue(harness.watchQueue),
      }),
      ProjectsRpcs.toLayer({
        'Projects.list': () => Effect.succeed([makeProject(harness.showIgnoredFiles)]),
        'Projects.add': () => Effect.die('unused'),
        'Projects.rename': () => Effect.die('unused'),
        'Projects.remove': () => Effect.die('unused'),
        'Projects.locate': () => Effect.die('unused'),
        'Projects.check': () => Effect.succeed(makeProject(harness.showIgnoredFiles)),
        'Projects.setSettings': ({ patch }) =>
          Effect.sync(() => {
            harness.patches.push(patch);
            if (typeof patch.showIgnoredFiles === 'boolean') {
              harness.showIgnoredFiles = patch.showIgnoredFiles;
            }
            return makeProject(harness.showIgnoredFiles);
          }),
      }),
      FileOperationRpcs.toLayer({
        'FileOperations.reviewCreate': ({ dirPath, name, kind }) =>
          Effect.sync(() => {
            harness.reviewCalls.push({ kind: 'create', params: { dirPath, name, kind } });
            const review: FileOperationReview = {
              reviewId: ReviewId.make('rev-create-1'),
              issuedAt: 1,
              expiresAt: 2,
              kind: 'Files.create',
              targets: [
                {
                  path: dirPath === '' ? name : `${dirPath}/${name}`,
                  kind: 'missing',
                  exists: false,
                  willBeTrashed: false,
                  willBePermanentlyRemoved: false,
                },
              ],
              warnings: [],
              blockers: harness.reviewBlockers,
              requiresPermanentConfirmation: false,
            };
            return review;
          }),
        'FileOperations.reviewRename': ({ relativePath, newName }) =>
          Effect.sync(() => {
            harness.reviewCalls.push({ kind: 'rename', params: { relativePath, newName } });
            const review: FileOperationReview = {
              reviewId: ReviewId.make('rev-rename-1'),
              issuedAt: 1,
              expiresAt: 2,
              kind: 'Files.rename',
              targets: [
                {
                  path: relativePath,
                  kind: 'file',
                  exists: true,
                  willBeTrashed: false,
                  willBePermanentlyRemoved: false,
                  destinationPath: newName,
                },
              ],
              warnings: [],
              blockers: harness.reviewBlockers,
              requiresPermanentConfirmation: false,
            };
            return review;
          }),
        'FileOperations.reviewDelete': ({ relativePaths, permanent }) =>
          Effect.sync(() => {
            harness.reviewCalls.push({ kind: 'delete', params: { relativePaths, permanent } });
            const isPermanent = permanent === true;
            const review: FileOperationReview = {
              reviewId: ReviewId.make(isPermanent ? 'rev-delete-permanent' : 'rev-delete-1'),
              issuedAt: 1,
              expiresAt: 2,
              kind: 'Files.delete',
              targets: relativePaths.map((p) => ({
                path: p,
                kind: 'file',
                exists: true,
                willBeTrashed: !isPermanent,
                willBePermanentlyRemoved: isPermanent,
              })),
              warnings: [],
              blockers: harness.reviewBlockers,
              requiresPermanentConfirmation: isPermanent,
            };
            return review;
          }),
        'FileOperations.execute': ({ reviewId, allowPermanentDelete }) =>
          Effect.sync(() => {
            harness.executeCalls.push({ reviewId, allowPermanentDelete });
            if (!allowPermanentDelete && harness.trashUnavailable) {
              return Effect.fail(
                new FileOperationsError({
                  reason: 'TrashUnavailable',
                  detail: 'Trash is unavailable.',
                }),
              );
            }
            const kind: 'Files.create' | 'Files.rename' | 'Files.delete' = reviewId.startsWith(
              'rev-create',
            )
              ? 'Files.create'
              : reviewId.startsWith('rev-rename')
                ? 'Files.rename'
                : 'Files.delete';
            return Effect.succeed({
              id: OperationId.make('op-1'),
              kind,
              title: 'Operation',
              phase: 'Completed' as const,
              outcome: 'Succeeded' as const,
              warnings: [],
              createdAt: 1,
              updatedAt: 1,
            });
          }).pipe(Effect.flatten),
      }),
    ),
  );

  TestBed.configureTestingModule({
    providers: [
      { provide: DESKTOP_LAYER, useValue: layer },
      provideIcons({
        lucideChevronDown,
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
  });

  const fixture = TestBed.createComponent(FilesBrowser);
  fixture.componentRef.setInput('target', target);
  fixture.componentRef.setInput('rootContextLabel', rootContextLabel);
  fixture.componentRef.setInput('rootFolderName', 'spence');
  fixture.detectChanges();
  return fixture;
};

const byTestId = (fixture: ComponentFixture<FilesBrowser>, id: string): HTMLElement | null => {
  fixture.detectChanges();
  return (
    (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${id}"]`) ??
    document.body.querySelector(`[data-testid="${id}"]`)
  );
};

const treeButton = (
  fixture: ComponentFixture<FilesBrowser>,
  relPath: string,
): HTMLButtonElement | null => {
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).querySelector(
    `button[data-testid="files-tree-item"][data-path="${relPath}"]`,
  );
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('FilesBrowser', () => {
  it('loads root tree, expands folders lazily, paginates, opens preview, and restores focus on back/Esc', async () => {
    const harness = makeHarness();
    const fixture = mount(harness);

    await vi.waitFor(() => {
      expect(treeButton(fixture, 'README.md')).not.toBeNull();
      expect(treeButton(fixture, 'src')).not.toBeNull();
    });

    // Context subtitle shows branch + folder name
    expect(byTestId(fixture, 'files-root-context')?.textContent).toContain('main');
    expect(byTestId(fixture, 'files-root-context')?.textContent).toContain('spence');

    // Pagination "Load more" loads next bounded chunk
    const loadMore = byTestId(fixture, 'files-load-more-root') as HTMLButtonElement | null;
    expect(loadMore).not.toBeNull();
    loadMore?.click();
    await vi.waitFor(() => {
      expect(treeButton(fixture, 'zeta.txt')).not.toBeNull();
    });

    // Expanding folder fetches src children lazily
    const srcBtn = treeButton(fixture, 'src');
    srcBtn?.click();
    await vi.waitFor(() => {
      expect(treeButton(fixture, 'src/main.ts')).not.toBeNull();
    });

    // Open saved-file preview and verify content + read-only caption
    const mainBtn = treeButton(fixture, 'src/main.ts');
    mainBtn?.focus();
    mainBtn?.click();

    await vi.waitFor(() => {
      expect(byTestId(fixture, 'files-preview-content')?.textContent).toContain(
        'export const ok = true;',
      );
      expect(byTestId(fixture, 'files-preview-path')?.textContent).toContain('src/main.ts');
      expect(byTestId(fixture, 'files-preview-caption')?.textContent).toContain('Read-only');
    });

    // Esc inside preview returns to tree and restores focus to src/main.ts item
    const previewContainer = byTestId(fixture, 'files-preview-view');
    previewContainer?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(byTestId(fixture, 'files-preview-view')).toBeNull();
      const restored = treeButton(fixture, 'src/main.ts');
      expect(document.activeElement).toBe(restored);
    });
  });

  it('distinguishes large truncated text, binary, unavailable missing files, and external opening', async () => {
    const harness = makeHarness();
    const fixture = mount(harness);

    await vi.waitFor(() => {
      expect(treeButton(fixture, 'huge.log')).not.toBeNull();
    });

    // Truncated large file shows explicit truncation banner + allows Open externally
    treeButton(fixture, 'huge.log')?.click();
    await vi.waitFor(() => {
      expect(byTestId(fixture, 'files-preview-truncated')).not.toBeNull();
      expect(byTestId(fixture, 'files-preview-content')?.textContent).toContain('truncated-head');
    });
    byTestId(fixture, 'files-preview-open-external')?.click();
    await vi.waitFor(() => {
      expect(harness.openedExternal).toEqual(['huge.log']);
    });

    // Back button returns to tree
    byTestId(fixture, 'files-preview-back')?.click();
    await vi.waitFor(() => {
      expect(treeButton(fixture, 'logo.png')).not.toBeNull();
    });

    // Binary file renders binary notice and offers Open externally
    treeButton(fixture, 'logo.png')?.click();
    await vi.waitFor(() => {
      expect(byTestId(fixture, 'files-preview-binary')).not.toBeNull();
      expect(byTestId(fixture, 'files-preview-open-external')?.hasAttribute('disabled')).toBe(
        false,
      );
    });
    byTestId(fixture, 'files-preview-back')?.click();

    // Load page 2 and open missing file
    await vi.waitFor(() => expect(byTestId(fixture, 'files-load-more-root')).not.toBeNull());
    byTestId(fixture, 'files-load-more-root')?.click();
    await vi.waitFor(() => expect(treeButton(fixture, 'zeta.txt')).not.toBeNull());
    treeButton(fixture, 'zeta.txt')?.click();
    await vi.waitFor(() => {
      expect(byTestId(fixture, 'files-preview-unavailable')?.dataset['reason']).toBe('Missing');
      expect(byTestId(fixture, 'files-preview-open-external')?.hasAttribute('disabled')).toBe(true);
    });
  });

  it('toggles Project showIgnoredFiles setting, navigates with keyboard, and reacts to live watch updates', async () => {
    const harness = makeHarness();
    const fixture = mount(harness);

    await vi.waitFor(() => {
      expect(treeButton(fixture, 'README.md')).not.toBeNull();
    });
    expect(treeButton(fixture, 'debug.log')).toBeNull();

    // Open menu and enable ignored files
    byTestId(fixture, 'files-options-trigger')?.click();
    fixture.detectChanges();
    const toggle = document.querySelector<HTMLElement>('[data-testid="files-toggle-ignored"]');
    expect(toggle).not.toBeNull();
    toggle?.click();

    await vi.waitFor(() => {
      expect(harness.patches).toEqual([{ showIgnoredFiles: true }]);
      expect(treeButton(fixture, 'debug.log')).not.toBeNull();
    });

    // Live watch event updates visible files AND refreshes an open preview
    treeButton(fixture, 'README.md')?.click();
    await vi.waitFor(() => {
      expect(byTestId(fixture, 'files-preview-content')?.textContent).toContain(
        'Calm file preview.',
      );
    });

    harness.previews.set('README.md', {
      _tag: 'Text',
      path: 'README.md',
      content: '# Spence\nUpdated live!',
      byteLength: 23,
      totalBytes: 23,
      truncated: false,
      previewLimitBytes: 2 * 1024 * 1024,
      mtimeMs: 2,
    });
    Queue.offerUnsafe(harness.watchQueue, {
      _tag: 'Changed',
      paths: ['README.md'],
      overflow: false,
    });
    await vi.waitFor(() => {
      expect(byTestId(fixture, 'files-preview-content')?.textContent).toContain('Updated live!');
    });

    // Keyboard navigation on tree
    byTestId(fixture, 'files-preview-back')?.click();
    await vi.waitFor(() => expect(byTestId(fixture, 'files-tree')).not.toBeNull());

    const srcBtn = treeButton(fixture, 'src');
    srcBtn?.focus();
    srcBtn?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await vi.waitFor(() => expect(treeButton(fixture, 'src/main.ts')).not.toBeNull());

    srcBtn?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    expect(document.activeElement).toBe(treeButton(fixture, 'src/main.ts'));

    treeButton(fixture, 'src/main.ts')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    fixture.detectChanges();
    expect(document.activeElement).toBe(treeButton(fixture, 'src'));
  });

  it('creates a file from the options menu and refreshes the tree', async () => {
    const harness = makeHarness();
    const fixture = mount(harness);

    await vi.waitFor(() => {
      expect(treeButton(fixture, 'README.md')).not.toBeNull();
    });

    byTestId(fixture, 'files-options-trigger')?.click();
    fixture.detectChanges();
    byTestId(fixture, 'files-menu-create-file')?.click();

    await vi.waitFor(() => {
      expect(byTestId(fixture, 'files-operation-dialog')).not.toBeNull();
    });

    const input = await vi.waitFor(() => {
      const el = document.body.querySelector('[data-testid="files-operation-name-input"]');
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });
    input.value = 'created.ts';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    byTestId(fixture, 'files-operation-confirm')?.click();

    await vi.waitFor(() => {
      expect(harness.reviewCalls).toContainEqual({
        kind: 'create',
        params: { dirPath: 'src', name: 'created.ts', kind: 'file' },
      });
      expect(harness.executeCalls.length).toBe(1);
    });
  });

  it('renames a file from the row action', async () => {
    const harness = makeHarness();
    const fixture = mount(harness);

    await vi.waitFor(() => {
      expect(treeButton(fixture, 'README.md')).not.toBeNull();
    });

    const renameBtn = document.body.querySelector(
      '[data-testid="files-row-rename"][data-path="README.md"]',
    );
    expect(renameBtn).not.toBeNull();
    renameBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    await vi.waitFor(() => {
      expect(byTestId(fixture, 'files-operation-dialog')).not.toBeNull();
    });

    const input = await vi.waitFor(() => {
      const el = document.body.querySelector('[data-testid="files-operation-name-input"]');
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });
    input.value = 'RENAMED.md';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    byTestId(fixture, 'files-operation-confirm')?.click();

    await vi.waitFor(() => {
      expect(harness.reviewCalls).toContainEqual({
        kind: 'rename',
        params: { relativePath: 'README.md', newName: 'RENAMED.md' },
      });
      expect(harness.executeCalls.length).toBe(1);
    });
  });

  it('deletes a file from the row action and offers permanent delete when trash is unavailable', async () => {
    const harness = makeHarness();
    harness.trashUnavailable = true;
    const fixture = mount(harness);

    await vi.waitFor(() => {
      expect(treeButton(fixture, 'README.md')).not.toBeNull();
    });

    treeButton(fixture, 'README.md')?.focus();
    fixture.detectChanges();

    const deleteBtn = document.body.querySelector(
      '[data-testid="files-row-delete"][data-path="README.md"]',
    );
    expect(deleteBtn).not.toBeNull();
    deleteBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    await vi.waitFor(() => {
      expect(byTestId(fixture, 'files-operation-dialog')).not.toBeNull();
      expect(byTestId(fixture, 'files-operation-dialog-title')?.textContent).toContain('Delete');
    });

    byTestId(fixture, 'files-operation-confirm')?.click();

    await vi.waitFor(() => {
      expect(harness.executeCalls.length).toBe(1);
      expect(harness.executeCalls[0]?.allowPermanentDelete).toBeUndefined();
    });

    await vi.waitFor(() => {
      expect(byTestId(fixture, 'files-operation-dialog-title')?.textContent ?? '').toContain(
        'Permanently delete',
      );
    });

    expect(
      harness.reviewCalls.some(
        (call) => (call.params as { readonly permanent?: boolean }).permanent === true,
      ),
    ).toBe(true);

    byTestId(fixture, 'files-operation-confirm')?.click();

    await vi.waitFor(() => {
      expect(harness.executeCalls.length).toBe(2);
      expect(harness.executeCalls[1]?.allowPermanentDelete).toBe(true);
      expect(harness.executeCalls[1]?.reviewId).toBe('rev-delete-permanent');
    });
  });
});
