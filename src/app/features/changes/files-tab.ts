import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Effect, Exit } from 'effect';
import { MarkdownView } from '@ui/markdown';
import { isAllowedExternalUrl } from '../../../shared/links/link-policy';
import { ChangesFrame } from './changes-frame';
import { Icon } from './icon';
import { splitPath } from './file-status';
import { MarkdownPreviewChoice } from './markdown-preview-choice';
import { FileIcon } from '@ui/file-icon';
import { fileIcon } from './file-icon-map';
import { fileLanguage } from './file-language';
import type { HighlightToken } from './file-highlight';
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
  imports: [ChangesFrame, MarkdownView, FileIcon, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 flex-1 flex-col', 'data-testid': 'files-tab' },
  template: `
    <app-changes-frame [view]="narrow()" (back)="narrow.set('list')">
      <div list class="contents">
        <div class="flex h-10 shrink-0 items-center px-5 text-xs">
          <label class="text-muted-foreground flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="files-show-ignored"
              [checked]="showIgnored()"
              (change)="setShowIgnored($any($event.target).checked)"
            />
            <span i18n>Show ignored files</span>
          </label>
        </div>
        <label
          class="border-border mx-3 mb-2 flex items-center gap-2 rounded-lg border px-2 text-muted-foreground"
        >
          <app-icon name="search" />
          <input
            class="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
            type="search"
            placeholder="Find a file"
            i18n-placeholder
            aria-label="Find a file"
            i18n-aria-label
            [value]="fileQuery()"
            (input)="searchFiles($any($event.target).value)"
          />
        </label>
        @if (fileQuery()) {
          <div class="min-h-0 flex-1 overflow-auto px-2" data-testid="file-search-results">
            @for (path of searchResults(); track path) {
              <button
                type="button"
                class="hover:bg-accent flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs"
                (click)="openPath(path)"
              >
                <ui-file-icon [icon]="fileIcon(nameOf(path), 'File', false)" /><span
                  class="min-w-0 truncate font-mono"
                  >{{ path }}</span
                >
              </button>
            }
            @if (searching()) {
              <p class="text-muted-foreground p-2 text-xs" i18n>Searching files…</p>
            } @else if (searchIncomplete()) {
              <p class="text-muted-foreground p-2 text-xs" i18n>
                Some folders could not be searched or the search limit was reached.
              </p>
            } @else if (searchResults().length === 0) {
              <p class="text-muted-foreground p-2 text-xs" i18n>No matching files.</p>
            }
          </div>
        } @else if (rootProblem(); as problem) {
          <p class="text-muted-foreground p-4 text-sm" data-testid="files-problem">
            {{ problem }}
          </p>
        } @else {
          <div
            class="flex min-h-0 flex-1 flex-col overflow-auto px-2 pb-2"
            id="files-tree"
            role="tree"
            data-testid="files-tree"
          >
            @for (row of rows(); track $index) {
              @if (row._tag === 'Entry') {
                <button
                  type="button"
                  role="treeitem"
                  data-testid="file-row"
                  class="hover:bg-accent flex h-7 shrink-0 items-center gap-1.5 rounded-lg pr-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  [class.bg-accent]="selected() === row.path"
                  [class.text-muted-foreground]="row.ignored"
                  [style.padding-left.rem]="0.5 + row.depth * 1"
                  [attr.aria-expanded]="row.kind === 'Dir' ? row.open : null"
                  (click)="activate(row)"
                >
                  <ui-file-icon [icon]="fileIcon(row.name, row.kind, row.open)" />
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
        }
      </div>
      <div viewer class="contents">
        @if (!rootProblem()) {
          <div
            class="border-border/60 m-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border"
            data-testid="file-preview"
          >
            @if (selected(); as path) {
              <div
                class="border-border/60 flex min-h-12 shrink-0 items-center gap-2.5 border-b py-1.5 pr-3 pl-4"
              >
                <span class="min-w-0 truncate font-mono text-[12.5px]" data-testid="file-path">
                  <span class="text-muted-foreground">{{ dirOf(path) }}</span
                  ><span class="font-semibold">{{ nameOf(path) }}</span>
                </span>
                @if (loadedFile()?._tag === 'Text') {
                  <span
                    class="text-muted-foreground text-xs tabular-nums"
                    data-testid="file-lines"
                    >{{ linesLabel() }}</span
                  >
                }
                <span class="flex-1"></span>
                @if (loadedFile()?._tag === 'Text') {
                  <label
                    class="border-border flex items-center gap-1 rounded-md border px-2 text-muted-foreground"
                  >
                    <app-icon name="search" /><input
                      class="h-7 w-28 bg-transparent text-xs text-foreground outline-none"
                      type="search"
                      placeholder="Find in file"
                      i18n-placeholder
                      aria-label="Find in file"
                      i18n-aria-label
                      [value]="contentQuery()"
                      (input)="setContentQuery($any($event.target).value)"
                      (keydown.enter)="nextMatch($any($event).shiftKey ? -1 : 1)"
                    />
                  </label>
                  @if (contentQuery()) {
                    <span
                      class="text-muted-foreground text-xs tabular-nums"
                      data-testid="file-match-count"
                      >{{ matches().length ? matchIndex() + 1 : 0 }}/{{ matches().length }}</span
                    >
                    <button
                      type="button"
                      class="rounded p-1 hover:bg-accent"
                      aria-label="Previous match"
                      i18n-aria-label
                      (click)="nextMatch(-1)"
                    >
                      <app-icon name="chevron-up" />
                    </button>
                    <button
                      type="button"
                      class="rounded p-1 hover:bg-accent"
                      aria-label="Next match"
                      i18n-aria-label
                      (click)="nextMatch(1)"
                    >
                      <app-icon name="chevron-down" />
                    </button>
                  }
                }
                @if (isMarkdown(path) && loadedFile()?._tag === 'Text') {
                  <div
                    role="group"
                    aria-label="Markdown view"
                    i18n-aria-label
                    class="bg-accent flex shrink-0 gap-0.5 rounded-[9px] p-0.5"
                  >
                    <button
                      type="button"
                      class="h-6 rounded-[7px] px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      [class]="choiceClass(false)"
                      [attr.aria-pressed]="!choice.source()"
                      (click)="choice.source.set(false)"
                      i18n
                    >
                      Rendered
                    </button>
                    <button
                      type="button"
                      class="h-6 rounded-[7px] px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      [class]="choiceClass(true)"
                      data-testid="markdown-source"
                      [attr.aria-pressed]="choice.source()"
                      (click)="choice.source.set(true)"
                      i18n
                    >
                      Source
                    </button>
                  </div>
                }
                <button
                  type="button"
                  class="hover:bg-accent text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="file-copy-path"
                  aria-label="Copy path"
                  i18n-aria-label
                  title="Copy path"
                  i18n-title
                  (click)="copyPath(path)"
                >
                  <svg
                    aria-hidden="true"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <rect width="14" height="14" x="8" y="8" rx="2" />
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                  </svg>
                </button>
              </div>
              @switch (file().status) {
                @case ('loading') {
                  <p class="text-muted-foreground p-4 text-xs" i18n>Loading…</p>
                }
                @case ('failed') {
                  <p class="text-destructive p-4 text-xs" i18n>Could not load this file.</p>
                }
              }
              @if (loadedFile(); as text) {
                @if (text._tag === 'Text') {
                  @if (isMarkdown(path) && !choice.source() && !contentQuery()) {
                    <div
                      class="min-h-0 flex-1 overflow-auto p-5 text-sm"
                      data-testid="file-content"
                    >
                      <app-markdown-view
                        [text]="text.content"
                        [isAllowedLink]="isAllowedExternalUrl"
                        (openLink)="openLink($event)"
                      />
                    </div>
                  } @else {
                    <div
                      class="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-5"
                      data-testid="file-content"
                    >
                      <div class="flex w-max min-w-full">
                        <pre
                          data-testid="line-numbers"
                          aria-hidden="true"
                          class="text-muted-foreground mr-4 select-none text-right"
                        >@for (line of rawLines(); track $index) {<span>{{ $index + 1 }}
</span>}</pre>
                        <pre
                          data-testid="file-source"
                        >@if (contentQuery()) {@for (line of rawLines(); track $index) {<span [attr.id]="'file-line-' + $index" [class.bg-accent]="matches().includes($index)">{{ line }}</span>@if (!$last) {<span>
</span>}}} @else if (highlighted(); as lines) {@for (line of lines; track $index) {@for (token of line; track $index) {<span class="file-token" [style.--token-light]="token.light" [style.--token-dark]="token.dark">{{ token.content }}</span>}@if (!$last) {<span>
</span>}}} @else {{{ text.content }}}</pre>
                      </div>
                    </div>
                  }
                } @else if (text._tag === 'NoPreview') {
                  <p class="text-muted-foreground p-4 text-xs" data-testid="file-nopreview">
                    {{ noPreviewText(text.reason) }}
                  </p>
                } @else {
                  <p class="text-muted-foreground p-4 text-xs" i18n>This path cannot be shown.</p>
                }
              }
            } @else {
              <p class="text-muted-foreground p-6 text-sm" i18n>Choose a file to read it.</p>
            }
          </div>
        }
      </div>
    </app-changes-frame>
  `,
})
export class FilesTab {
  readonly sessionId = input.required<SessionId>();
  /** Changes whenever the page asks for a fresh read (Refresh, a Turn ending, a Worktree switch). */
  readonly reload = input<number>(0);

  private readonly runtime = inject(EffectRuntime);
  protected readonly choice = inject(MarkdownPreviewChoice);
  protected readonly isAllowedExternalUrl = isAllowedExternalUrl;
  protected isMarkdown(path: string): boolean {
    return /\.(md|markdown)$/i.test(path);
  }
  protected openLink(url: string): void {
    void this.runtime.run(DesktopApi.use((api) => api['Links.openExternal']({ url })));
  }
  /** Counts reads of the folder; an answer from an older read is dropped. */
  private seq = 0;

  /** On a narrow window the frame shows the tree or the preview, one at a time. */
  protected readonly narrow = signal<'list' | 'viewer'>('list');
  protected readonly showIgnored = signal(false);
  private readonly listings = signal<ReadonlyMap<string, Load<FolderListing>>>(new Map());
  private readonly opened = signal<ReadonlySet<string>>(new Set());
  protected readonly selected = signal<string | null>(null);
  protected readonly file = signal<Load<TextFile>>({ status: 'loading' });

  protected readonly highlighted = signal<HighlightToken[][] | null>(null);
  protected readonly rawLines = computed(() => {
    const file = this.loadedFile();
    return file?._tag === 'Text' ? file.content.split('\n') : [];
  });
  protected readonly fileQuery = signal('');
  protected readonly searchResults = signal<readonly string[]>([]);
  protected readonly searching = signal(false);
  protected readonly searchIncomplete = signal(false);
  private searchSeq = 0;
  protected readonly contentQuery = signal('');
  protected readonly matchIndex = signal(0);
  protected readonly matches = computed(() => {
    const query = this.contentQuery().toLowerCase();
    return query
      ? this.rawLines().flatMap((line, index) =>
          line.toLowerCase().includes(query) ? [index] : [],
        )
      : [];
  });
  private worker: Worker | null = null;
  private highlightSeq = 0;

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
    inject(DestroyRef).onDestroy(() => {
      ++this.searchSeq;
      this.worker?.terminate();
    });
    effect(() => {
      this.sessionId();
      untracked(() => {
        ++this.searchSeq;
        this.fileQuery.set('');
        this.contentQuery.set('');
        this.listings.set(new Map());
        this.opened.set(new Set());
        this.selected.set(null);
        this.narrow.set('list');
        this.file.set({ status: 'loading' });
        this.refresh();
      });
    });
    effect(() => {
      const path = this.selected();
      const file = this.loadedFile();
      const id = ++this.highlightSeq;
      this.highlighted.set(null);
      if (path === null || file?._tag !== 'Text' || file.content.split('\n').length > 2000) return;
      const lang = fileLanguage(path);
      if (lang === undefined || typeof Worker === 'undefined') return;
      this.worker ??= new Worker(new URL('./file-highlight.worker', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (
        event: MessageEvent<{ id: number; lines: HighlightToken[][] | null }>,
      ) => {
        if (event.data.id === this.highlightSeq) this.highlighted.set(event.data.lines);
      };
      this.worker.postMessage({ id, content: file.content, lang });
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

  protected setShowIgnored(show: boolean): void {
    this.showIgnored.set(show);
    if (this.fileQuery()) void this.searchFiles(this.fileQuery());
  }

  protected async searchFiles(query: string): Promise<void> {
    this.fileQuery.set(query);
    const seq = ++this.searchSeq;
    this.searchResults.set([]);
    this.searchIncomplete.set(false);
    if (!query.trim()) {
      this.searching.set(false);
      return;
    }
    this.searching.set(true);
    const session = this.sessionId();
    const includeIgnored = this.showIgnored();
    const needle = query.toLowerCase().trim();
    const queue = [''];
    const results: string[] = [];
    let visited = 0;
    let incomplete = false;
    while (queue.length && visited < 500 && results.length < 200) {
      const dir = queue.shift() ?? '';
      visited += 1;
      const exit = await this.runtime.run(loadListing(session, dir));
      if (seq !== this.searchSeq) return;
      if (!Exit.isSuccess(exit) || exit.value._tag !== 'Listing') {
        incomplete = true;
        continue;
      }
      if (exit.value.truncated) incomplete = true;
      for (const entry of exit.value.entries) {
        if (entry.ignored && !includeIgnored) continue;
        const path = join(dir, entry.name);
        if (entry.kind === 'Dir') queue.push(path);
        else if (this.fuzzyMatch(path.toLowerCase(), needle)) results.push(path);
      }
      this.searchResults.set(results.slice(0, 200));
    }
    this.searchIncomplete.set(incomplete || queue.length > 0 || results.length >= 200);
    this.searching.set(false);
  }

  private fuzzyMatch(path: string, query: string): boolean {
    let index = 0;
    for (const char of path) if (char === query[index]) index += 1;
    return index === query.length;
  }

  protected openPath(path: string): void {
    this.selected.set(path);
    this.contentQuery.set('');
    this.narrow.set('viewer');
    this.file.set({ status: 'loading' });
    this.fetchFile(path);
  }

  protected setContentQuery(query: string): void {
    this.contentQuery.set(query);
    this.matchIndex.set(0);
    if (query) setTimeout(() => this.scrollToMatch(), 0);
  }

  protected nextMatch(direction: number): void {
    const count = this.matches().length;
    if (!count) return;
    this.matchIndex.update((index) => (index + direction + count) % count);
    this.scrollToMatch();
  }

  private scrollToMatch(): void {
    const line = this.matches()[this.matchIndex()];
    if (line !== undefined)
      document.getElementById('file-line-' + line)?.scrollIntoView?.({ block: 'center' });
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
    this.openPath(row.path);
  }

  protected dirOf(path: string): string {
    const { dir } = splitPath(path);
    return dir === '' ? '' : `${dir}/`;
  }

  protected nameOf(path: string): string {
    return splitPath(path).name;
  }

  protected readonly linesLabel = computed(() => {
    const count = this.rawLines().length;
    return count === 1 ? $localize`1 line` : $localize`${count} lines`;
  });

  protected choiceClass(source: boolean): string {
    return this.choice.source() === source
      ? 'bg-background font-medium shadow-xs'
      : 'text-muted-foreground hover:text-foreground';
  }

  protected copyPath(path: string): void {
    void navigator.clipboard.writeText(path);
  }

  protected readonly fileIcon = fileIcon;

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
