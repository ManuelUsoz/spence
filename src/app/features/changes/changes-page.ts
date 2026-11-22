import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Effect, Exit } from 'effect';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type {
  ChangedFile,
  ChangesResult,
  CommitFile,
  HeadState,
} from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { unavailableText } from '../../core/git-text';
import { ChangesFrame, type FramePane } from './changes-frame';
import { ChangesList } from './changes-list';
import { ChangesToolbar, type AvailableChanges, type ChangesTab } from './changes-toolbar';
import { CommitPanel } from './commit-panel';
import { DiffStore } from './diff-store';
import type { DiffMode } from './diff-viewer';
import { DiscardPanel } from './discard-panel';
import { FileDiffPane } from './file-diff-pane';
import { FilesTab } from './files-tab';
import { HistoryTab } from './history-tab';
import { LOADING, fromExit, valueOf, type Load } from './load';

const loadChanges = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.changes']({ sessionId });
});

const loadDiff = Effect.fnUntraced(function* (
  sessionId: SessionId,
  path: string,
  previousPath: string | undefined,
) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.diff']({
    sessionId,
    path,
    scope: 'combined',
    ...(previousPath === undefined ? {} : { previousPath }),
  });
});

const asCommitFile = (file: ChangedFile): CommitFile => ({
  path: file.path,
  ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
});

const headName = (head: HeadState): string =>
  head._tag === 'Detached' ? head.commit.slice(0, 7) : head.branch;

/**
 * A Session's source control: what is different in its folder right now (staged, unstaged and untracked, from every
 * writer), the Git history of its branch, and its files. Every tab sits in the same frame: a list on the left and
 * what you picked on the right. This component owns the toolbar and the Changes tab (the folder read, the
 * selection and the diff that is open); History and Files read for themselves.
 */
@Component({
  selector: 'app-changes-page',
  imports: [
    ChangesFrame,
    ChangesList,
    ChangesToolbar,
    CommitPanel,
    DiscardPanel,
    FileDiffPane,
    FilesTab,
    HistoryTab,
  ],
  providers: [DiffStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex min-h-0 w-full flex-1 flex-col',
    'data-testid': 'changes-page',
  },
  template: `
    <app-changes-toolbar
      [sessionId]="sessionId()"
      [tab]="tab()"
      [reloads]="reloads()"
      [fileCount]="fileCount()"
      [headLabel]="headLabel()"
      [repo]="available()"
      [canPush]="canPush()"
      [remote]="remote()"
      (tabChange)="selectTab($event)"
      (refresh)="refresh()"
      (remoteChosen)="remoteChoice.set($event)"
      (changed)="refresh()"
    />

    @switch (tab()) {
      @case ('changes') {
        <app-changes-frame [view]="narrowView()" (back)="narrowView.set('list')">
          <!-- One element per slot: Angular projects a control-flow block only by its single root. -->
          <div list class="contents">
            @switch (changes().status) {
              @case ('loading') {
                <p class="text-muted-foreground p-4 text-sm" i18n>Loading…</p>
              }
              @case ('failed') {
                <p class="text-destructive p-4 text-sm" data-testid="changes-error" i18n>
                  Could not load changes.
                </p>
              }
            }
            @if (loadedChanges(); as result) {
              @if (result._tag === 'Unavailable') {
                <p class="text-muted-foreground p-4 text-sm" data-testid="changes-unavailable">
                  {{ unavailableText(result.reason) }}
                </p>
              } @else if (result.files.length === 0) {
                <p class="text-muted-foreground p-4 text-sm" data-testid="changes-empty" i18n>
                  No changes. Everything is committed.
                </p>
              } @else {
                <app-changes-list
                  [files]="result.files"
                  [selectedPath]="selectedPath()"
                  [deselected]="deselected()"
                  [running]="running()"
                  [excludedCount]="result.excludedCount"
                  (open)="openFile($event)"
                  (toggle)="toggleSelected($event)"
                  (toggleAll)="toggleAll($event)"
                  (discardSelected)="discard()?.start(commitFiles())"
                  (discardAll)="discard()?.start(discardableFiles())"
                />
                <app-discard-panel [sessionId]="sessionId()" (changed)="refresh()" />
                <app-commit-panel
                  [sessionId]="sessionId()"
                  [files]="commitFiles()"
                  [running]="running()"
                  [canPush]="canPush()"
                  [remote]="remote()"
                  (changed)="refresh()"
                />
              }
            }
          </div>
          <div viewer class="contents">
            @if (fileCount() > 0) {
              <app-file-diff-pane
                [file]="selectedFile()"
                [state]="selectedDiff()"
                [index]="selectedIndex()"
                [total]="fileCount()"
                [mode]="diffMode()"
                (modeChange)="diffMode.set($event)"
                (discard)="discardOpenFile()"
                (prev)="step(-1)"
                (next)="step(1)"
              />
            }
          </div>
        </app-changes-frame>
      }
      @case ('history') {
        <app-history-tab [sessionId]="sessionId()" [reload]="reloads()" (changed)="refresh()" />
      }
      @case ('files') {
        <app-files-tab [sessionId]="sessionId()" [reload]="reloads()" />
      }
    }
  `,
})
export class ChangesPage {
  readonly sessionId = input.required<SessionId>();
  /** Reloads when a running Turn ends, since that is when its edits are done. */
  readonly running = input<boolean>(false);

  private readonly runtime = inject(EffectRuntime);
  private readonly diffs = inject(DiffStore);
  protected readonly discard = viewChild(DiscardPanel);
  /** Counts reads of the folder; an answer from an older read is dropped. */
  private seq = 0;

  protected readonly tab = signal<ChangesTab>('changes');
  /** On a narrow window the frame shows the list or the viewer, one at a time. */
  protected readonly narrowView = signal<FramePane>('list');
  /** Counts refreshes, so History, Files and the Worktree label read again when Refresh is pressed. */
  protected readonly reloads = signal(0);
  protected readonly changes = signal<Load<ChangesResult>>(LOADING);
  /** The file whose diff is open. */
  protected readonly selectedPath = signal<string | null>(null);
  protected readonly diffMode = signal<DiffMode>('unified');
  /** Files the user unticked; every other changed file is committed, so new ones start ticked. */
  protected readonly deselected = signal<ReadonlySet<string>>(new Set());
  protected readonly remoteChoice = signal<string | undefined>(undefined);

  protected readonly loadedChanges = computed(() => valueOf(this.changes()));
  protected readonly available = computed((): AvailableChanges | null => {
    const result = this.loadedChanges();
    return result?._tag === 'Available' ? result : null;
  });
  private readonly files = computed(() => this.available()?.files ?? []);
  protected readonly fileCount = computed(() => this.files().length);
  protected readonly selectedIndex = computed(() =>
    this.files().findIndex((file) => file.path === this.selectedPath()),
  );
  protected readonly selectedFile = computed(() => this.files()[this.selectedIndex()] ?? null);
  protected readonly selectedDiff = computed(() => {
    const path = this.selectedPath();
    return path === null ? LOADING : this.diffs.state(path);
  });
  /** The remote Push goes to while the branch has no upstream: the one chosen, or the only one. Never a guess. */
  protected readonly remote = computed((): string | undefined => {
    const remotes = this.available()?.remotes ?? [];
    const chosen = this.remoteChoice();
    if (chosen !== undefined && remotes.includes(chosen)) return chosen;
    return remotes.length === 1 ? remotes[0] : undefined;
  });
  protected readonly canPush = computed(() => {
    const repo = this.available();
    return repo !== null && (repo.upstream !== undefined || this.remote() !== undefined);
  });
  /** The files to commit: ticked, and not in conflict. */
  protected readonly commitFiles = computed((): ReadonlyArray<CommitFile> => {
    const unticked = this.deselected();
    return this.files()
      .filter((file) => file.status !== 'Conflicted' && !unticked.has(file.path))
      .map(asCommitFile);
  });
  /** Every changed file that can be discarded (a conflicted one has to be resolved first). */
  protected readonly discardableFiles = computed((): ReadonlyArray<CommitFile> =>
    this.files()
      .filter((file) => file.status !== 'Conflicted')
      .map(asCommitFile),
  );
  protected readonly headLabel = computed(() => {
    const repo = this.available();
    return repo === null ? null : headName(repo.head);
  });

  constructor() {
    effect(() => {
      this.sessionId();
      untracked(() => {
        this.reset();
        this.refresh();
      });
    });
    let wasRunning = false;
    effect(() => {
      const running = this.running();
      if (wasRunning && !running) untracked(() => this.refresh());
      wasRunning = running;
    });
  }

  /** Forgets what the last Session showed, so it never appears under another Session's name. */
  private reset(): void {
    this.changes.set(LOADING);
    this.selectedPath.set(null);
    this.deselected.set(new Set());
    this.remoteChoice.set(undefined);
    this.narrowView.set('list');
    this.diffs.reset();
  }

  protected selectTab(tab: ChangesTab): void {
    this.tab.set(tab);
    this.narrowView.set('list');
  }

  /** Reads the folder again, and the open diff with it; History and Files follow `reloads`. The newest read wins. */
  protected refresh(): void {
    const seq = ++this.seq;
    this.reloads.update((count) => count + 1);
    void this.runtime.run(loadChanges(this.sessionId())).then((exit) => {
      if (seq !== this.seq) return;
      this.changes.set(fromExit(exit));
      if (Exit.isSuccess(exit)) this.syncSelection(exit.value);
    });
  }

  /** Keeps the open file if it is still changed, otherwise opens the first one; reads its diff again. */
  private syncSelection(result: ChangesResult): void {
    const files = result._tag === 'Available' ? result.files : [];
    const paths = new Set(files.map((file) => file.path));
    // A file that left the list is forgotten, so it comes back ticked if it changes again.
    this.deselected.update((set) => new Set([...set].filter((path) => paths.has(path))));
    const current = this.selectedPath();
    const next = current !== null && paths.has(current) ? current : (files[0]?.path ?? null);
    this.selectedPath.set(next);
    const file = files.find((candidate) => candidate.path === next);
    if (file !== undefined) this.fetchDiff(file);
  }

  private fetchDiff(file: ChangedFile): void {
    this.diffs.load(file.path, loadDiff(this.sessionId(), file.path, file.previousPath), {
      force: true,
    });
  }

  protected openFile(file: ChangedFile): void {
    this.selectedPath.set(file.path);
    this.narrowView.set('viewer');
    this.fetchDiff(file);
  }

  /** Opens the previous (-1) or next (+1) changed file. */
  protected step(delta: -1 | 1): void {
    const file = this.files()[this.selectedIndex() + delta];
    if (file !== undefined) this.openFile(file);
  }

  protected toggleSelected(file: ChangedFile): void {
    const next = new Set(this.deselected());
    if (next.has(file.path)) next.delete(file.path);
    else next.add(file.path);
    this.deselected.set(next);
  }

  /** Ticks every file, or unticks every file. */
  protected toggleAll(ticked: boolean): void {
    this.deselected.set(ticked ? new Set() : new Set(this.files().map((file) => file.path)));
  }

  protected discardOpenFile(): void {
    const file = this.selectedFile();
    if (file !== null) void this.discard()?.start([asCommitFile(file)]);
  }

  protected readonly unavailableText = unavailableText;
}
