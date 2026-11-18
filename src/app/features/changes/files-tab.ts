import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Effect, Exit } from 'effect';
import type {
  FolderEntry,
  FolderListing,
  NoPreviewReason,
  TextFile,
} from '../../../shared/files/files.rpc';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';

const loadListing = Effect.fnUntraced(function* (sessionId: SessionId, path: string) {
  const api = yield* DesktopApi;
  return yield* api['Files.list']({ sessionId, path });
});

const loadFile = Effect.fnUntraced(function* (sessionId: SessionId, path: string) {
  const api = yield* DesktopApi;
  return yield* api['Files.read']({ sessionId, path });
});

type Load<A> =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'loaded'; readonly value: A };

interface EntryRow {
  readonly _tag: 'Entry';
  readonly path: string;
  readonly name: string;
  readonly kind: FolderEntry['kind'];
  readonly depth: number;
  readonly ignored: boolean;
  readonly open: boolean;
}

interface NoteRow {
  readonly _tag: 'Note';
  readonly depth: number;
  readonly note: 'loading' | 'failed' | 'empty' | 'truncated';
}

type Row = EntryRow | NoteRow;

const join = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);

/** The files of a Session's folder as a tree that opens folder by folder, with a read-only preview of one file. */
@Component({
  selector: 'app-files-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', 'data-testid': 'files-tab' },
  template: `
    <div class="mb-2 flex items-center gap-2 text-xs">
      <label class="text-muted-foreground flex items-center gap-1.5">
        <input
          type="checkbox"
          data-testid="files-show-ignored"
          [checked]="showIgnored()"
          (change)="showIgnored.set($any($event.target).checked)"
        />
        <span i18n>Show ignored files</span>
      </label>
    </div>
    @if (rootProblem(); as problem) {
      <p class="text-muted-foreground text-sm" data-testid="files-problem">{{ problem }}</p>
    } @else {
      <div class="grid grid-cols-[minmax(12rem,18rem)_1fr] gap-3">
        <div
          class="flex max-h-[60vh] flex-col overflow-y-auto"
          role="tree"
          data-testid="files-tree"
        >
          @for (row of rows(); track $index) {
            @if (row._tag === 'Entry') {
              <button
                type="button"
                role="treeitem"
                data-testid="file-row"
                class="hover:bg-accent flex h-7 items-center gap-1.5 rounded-md pr-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                [class.bg-accent]="selected() === row.path"
                [class.text-muted-foreground]="row.ignored"
                [style.padding-left.rem]="0.5 + row.depth * 1"
                [attr.aria-expanded]="row.kind === 'Dir' ? row.open : null"
                (click)="activate(row)"
              >
                <span class="w-3 shrink-0 text-center" aria-hidden="true">{{ glyph(row) }}</span>
                <span class="min-w-0 flex-1 truncate font-mono">{{ row.name }}</span>
              </button>
            } @else {
              <p
                class="text-muted-foreground h-6 text-xs"
                data-testid="file-note"
                [style.padding-left.rem]="1.5 + row.depth * 1"
              >
                {{ noteText(row.note) }}
              </p>
            }
          }
        </div>
        <div class="min-w-0" data-testid="file-preview">
          @if (selected(); as path) {
            <div class="text-muted-foreground mb-1 truncate font-mono text-xs">{{ path }}</div>
            @switch (file().status) {
              @case ('loading') {
                <p class="text-muted-foreground text-xs" i18n>Loading…</p>
              }
              @case ('failed') {
                <p class="text-destructive text-xs" i18n>Could not load this file.</p>
              }
            }
            @if (loadedFile(); as text) {
              @if (text._tag === 'Text') {
                <pre
                  class="border-border/60 max-h-[60vh] overflow-auto rounded-xl border p-3 font-mono text-xs leading-5"
                  data-testid="file-content"
                  >{{ text.content }}</pre>
              } @else if (text._tag === 'NoPreview') {
                <p class="text-muted-foreground text-xs" data-testid="file-nopreview">
                  {{ noPreviewText(text.reason) }}
                </p>
              } @else {
                <p class="text-muted-foreground text-xs" i18n>This path cannot be shown.</p>
              }
            }
          } @else {
            <p class="text-muted-foreground text-xs" i18n>Choose a file to read it.</p>
          }
        </div>
      </div>
    }
  `,
})
export class FilesTab {
  readonly sessionId = input.required<SessionId>();
  /** Reads the folder again when a running Turn ends, since that is when its edits are done. */
  readonly running = input<boolean>(false);
  /** Changes whenever the page asks for a fresh read (Refresh, a Worktree switch). */
  readonly reload = input<number>(0);

  private readonly runtime = inject(EffectRuntime);
  /** Counts reads of the folder; an answer from an older read is dropped. */
  private seq = 0;

  protected readonly showIgnored = signal(false);
  private readonly listings = signal<ReadonlyMap<string, Load<FolderListing>>>(new Map());
  private readonly opened = signal<ReadonlySet<string>>(new Set());
  protected readonly selected = signal<string | null>(null);
  protected readonly file = signal<Load<TextFile>>({ status: 'loading' });

  protected readonly loadedFile = computed(() => {
    const state = this.file();
    return state.status === 'loaded' ? state.value : null;
  });

  /** Set when the top folder itself cannot be listed. */
  protected readonly rootProblem = computed((): string | null => {
    const root = this.listings().get('');
    if (root === undefined || root.status === 'loading') return null;
    if (root.status === 'failed') return $localize`Could not load the files.`;
    return root.value._tag === 'Listing' ? null : $localize`This Session's folder was not found.`;
  });

  protected readonly rows = computed((): ReadonlyArray<Row> => {
    const out: Row[] = [];
    const showIgnored = this.showIgnored();
    const opened = this.opened();
    const listings = this.listings();
    const walk = (dir: string, depth: number): void => {
      const state = listings.get(dir);
      if (state === undefined || state.status === 'loading') {
        if (dir !== '') out.push({ _tag: 'Note', depth, note: 'loading' });
        return;
      }
      if (state.status === 'failed' || state.value._tag !== 'Listing') {
        if (dir !== '') out.push({ _tag: 'Note', depth, note: 'failed' });
        return;
      }
      const entries = state.value.entries.filter((entry) => showIgnored || !entry.ignored);
      if (entries.length === 0 && dir !== '') out.push({ _tag: 'Note', depth, note: 'empty' });
      for (const entry of entries) {
        const path = join(dir, entry.name);
        const open = entry.kind === 'Dir' && opened.has(path);
        out.push({
          _tag: 'Entry',
          path,
          name: entry.name,
          kind: entry.kind,
          depth,
          ignored: entry.ignored,
          open,
        });
        if (open) walk(path, depth + 1);
      }
      if (state.value.truncated) out.push({ _tag: 'Note', depth, note: 'truncated' });
    };
    walk('', 0);
    return out;
  });

  constructor() {
    effect(() => {
      this.sessionId();
      untracked(() => {
        this.listings.set(new Map());
        this.opened.set(new Set());
        this.selected.set(null);
        this.file.set({ status: 'loading' });
        this.refresh();
      });
    });
    let firstReload = true;
    effect(() => {
      this.reload();
      if (firstReload) {
        firstReload = false;
        return;
      }
      untracked(() => this.refresh());
    });
    let wasRunning = false;
    effect(() => {
      const running = this.running();
      if (wasRunning && !running) untracked(() => this.refresh());
      wasRunning = running;
    });
  }

  /** Reads the top folder, every open folder and the selected file again. The newest read wins. */
  private refresh(): void {
    ++this.seq;
    this.fetchListing('');
    for (const dir of this.opened()) this.fetchListing(dir);
    const path = this.selected();
    if (path !== null) this.fetchFile(path);
  }

  private fetchListing(dir: string): void {
    const seq = this.seq;
    this.listings.update((map) =>
      map.has(dir) ? map : new Map(map).set(dir, { status: 'loading' }),
    );
    void this.runtime.run(loadListing(this.sessionId(), dir)).then((exit) => {
      if (seq !== this.seq) return;
      this.listings.update((map) =>
        new Map(map).set(
          dir,
          Exit.isSuccess(exit) ? { status: 'loaded', value: exit.value } : { status: 'failed' },
        ),
      );
    });
  }

  private fetchFile(path: string): void {
    const seq = this.seq;
    void this.runtime.run(loadFile(this.sessionId(), path)).then((exit) => {
      if (seq !== this.seq || this.selected() !== path) return;
      this.file.set(
        Exit.isSuccess(exit) ? { status: 'loaded', value: exit.value } : { status: 'failed' },
      );
    });
  }

  protected activate(row: EntryRow): void {
    if (row.kind === 'Dir') {
      const next = new Set(this.opened());
      if (next.has(row.path)) {
        next.delete(row.path);
      } else {
        next.add(row.path);
        this.fetchListing(row.path);
      }
      this.opened.set(next);
      return;
    }
    this.selected.set(row.path);
    this.file.set({ status: 'loading' });
    this.fetchFile(row.path);
  }

  protected glyph(row: EntryRow): string {
    if (row.kind === 'Dir') return row.open ? '▾' : '▸';
    return row.kind === 'Symlink' ? '↪' : '';
  }

  protected noteText(note: NoteRow['note']): string {
    switch (note) {
      case 'loading':
        return $localize`Loading…`;
      case 'failed':
        return $localize`Could not load this folder.`;
      case 'empty':
        return $localize`Empty folder.`;
      case 'truncated':
        return $localize`Only the first entries are shown.`;
    }
  }

  protected noPreviewText(reason: NoPreviewReason): string {
    switch (reason) {
      case 'Binary':
        return $localize`This file is binary, so there is no text to show.`;
      case 'TooLarge':
        return $localize`This file is too large to preview.`;
      case 'NotFile':
        return $localize`This is not a regular file.`;
      case 'Unreadable':
        return $localize`This file cannot be read.`;
      case 'Missing':
        return $localize`This file no longer exists.`;
    }
  }
}
