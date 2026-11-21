import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Effect, Exit } from 'effect';
import { HlmAutocompleteImports } from '@ui/autocomplete';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmInputImports } from '@ui/input';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { ChangesResult } from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { prepareRejectionText, unavailableText } from '../../core/git-text';

const loadChanges = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.changes']({ sessionId });
});

const loadWorktrees = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Worktrees.list']({ sessionId });
});

const loadBranches = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.branches']({ sessionId });
});

const prepareDraft = Effect.fnUntraced(function* (
  sessionId: SessionId,
  branch: string,
  base: string | undefined,
) {
  const api = yield* DesktopApi;
  return yield* api['Worktrees.prepareDraft']({
    sessionId,
    branch,
    ...(base === undefined ? {} : { base }),
  });
});

/** `Fix the flaky e2e` -> `wt/fix-the-flaky-e2e`: a branch name after the first line of a text, at most 48 characters. */
export const branchNameFor = (text: string | null): string => {
  const firstLine = (text ?? '').split(/\r?\n/)[0] ?? '';
  const slug = firstLine
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 44)
    .replace(/-+$/g, '');
  return `wt/${slug.length > 0 ? slug : 'new-work'}`;
};

type Mode = 'current' | 'new';

/**
 * The quiet line under the composer. It names the checkout the Session works in. Before the first message it
 * offers a choice: keep working in the current checkout, or start in a new worktree (from a branch you pick, on a
 * branch you can name). Nothing is created until the message is sent. It also shows the lines added and removed,
 * which opens the Changes view. It shows nothing for a folder that is not a Git repository.
 */
@Component({
  selector: 'app-composer-status',
  imports: [HlmAutocompleteImports, HlmDropdownMenuImports, HlmInputImports, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (repo(); as info) {
      <div
        class="text-muted-foreground flex h-9 items-center gap-1 ps-3.5 pe-2 text-xs"
        data-testid="composer-status"
      >
        @if (canSelect()) {
          <button
            type="button"
            class="hover:bg-accent hover:text-foreground focus-visible:ring-ring -ms-1.5 flex h-6.5 min-w-0 items-center gap-1.5 rounded-lg px-1.5 outline-none focus-visible:ring-2"
            data-testid="composer-status-branch"
            aria-haspopup="menu"
            [attr.aria-label]="chipLabel()"
            title="Where this Session works"
            i18n-title
            [hlmDropdownMenuTrigger]="modeMenu"
          >
            <ng-container *ngTemplateOutlet="branchIcon" />
            @if (mode() === 'new') {
              <span class="truncate" i18n>New worktree</span>
            } @else {
              <span class="truncate font-mono text-[11.5px]">{{ branch() }}</span>
            }
            <svg
              class="size-2.5 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        } @else {
          <span
            class="-ms-1.5 flex h-6.5 min-w-0 items-center gap-1.5 px-1.5"
            data-testid="composer-status-branch"
            [attr.aria-label]="chipLabel()"
          >
            <ng-container *ngTemplateOutlet="branchIcon" />
            <span class="truncate font-mono text-[11.5px]">{{ branch() }}</span>
          </span>
        }
        <span class="flex-1"></span>
        <button
          type="button"
          class="hover:bg-accent focus-visible:ring-ring flex h-6.5 items-center gap-1.5 rounded-lg px-2 text-xs tabular-nums outline-none focus-visible:ring-2"
          data-testid="composer-status-changes"
          [attr.aria-label]="changesLabel()"
          (click)="openChanges.emit()"
        >
          @if (info.files.length === 0) {
            <span i18n>No changes</span>
          } @else {
            <span class="text-diff-add" data-testid="composer-status-added">+{{ added() }}</span>
            <span class="text-diff-del" data-testid="composer-status-removed"
              >−{{ removed() }}</span
            >
          }
        </button>
      </div>
      @if (canSelect() && mode() === 'new') {
        <div
          class="text-muted-foreground flex items-center gap-2 px-3.5 pb-2 text-xs"
          data-testid="composer-status-new-worktree"
        >
          <span i18n>From</span>
          <hlm-autocomplete
            class="w-48"
            data-testid="composer-status-from"
            [(value)]="base"
            [(search)]="baseSearch"
          >
            <hlm-autocomplete-input placeholder="Search branches" i18n-placeholder />
            <ng-template hlmAutocompletePortal>
              <hlm-autocomplete-content>
                <hlm-autocomplete-empty i18n>No branches</hlm-autocomplete-empty>
                <div hlmAutocompleteList class="max-h-56">
                  @for (name of matchingBranches(); track name) {
                    <hlm-autocomplete-item [value]="name" data-testid="composer-status-from-item">{{
                      name
                    }}</hlm-autocomplete-item>
                  }
                </div>
              </hlm-autocomplete-content>
            </ng-template>
          </hlm-autocomplete>
          <input
            hlmInput
            class="h-8 min-w-0 flex-1 font-mono text-xs"
            data-testid="composer-status-worktree-name"
            aria-label="New branch name"
            i18n-aria-label
            [placeholder]="autoName()"
            [value]="nameInput()"
            (input)="nameInput.set($any($event.target).value)"
          />
        </div>
        <p class="text-muted-foreground px-3.5 pb-2 text-xs" i18n>
          Created when you send the first message. Uncommitted changes stay in the current checkout.
        </p>
      }
      @if (preparing()) {
        <p
          class="text-muted-foreground px-3.5 pb-2 text-xs"
          data-testid="composer-status-preparing"
          i18n
        >
          Preparing the worktree…
        </p>
      }
      @if (message(); as text) {
        <p class="text-destructive px-3.5 pb-2.5 text-xs" data-testid="composer-status-message">
          {{ text }}
        </p>
      }
    }

    <ng-template #branchIcon>
      <svg
        class="size-3.5 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <line x1="6" x2="6" y1="3" y2="15" />
        <circle cx="18" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="M18 9a9 9 0 0 1-9 9" />
      </svg>
    </ng-template>

    <ng-template #modeMenu>
      <hlm-dropdown-menu class="w-64 rounded-xl" data-testid="mode-menu">
        <button
          type="button"
          hlmDropdownMenuItem
          class="h-auto items-start justify-start gap-2 py-2 text-start"
          data-testid="mode-current"
          (triggered)="choose('current')"
        >
          <span class="w-3 shrink-0 text-center" aria-hidden="true">{{
            mode() === 'current' ? '✓' : ''
          }}</span>
          <span class="flex min-w-0 flex-1 flex-col items-start text-start">
            <span i18n>Current checkout</span>
            <span class="text-muted-foreground truncate font-mono text-xs">{{ branch() }}</span>
          </span>
        </button>
        <button
          type="button"
          hlmDropdownMenuItem
          class="h-auto items-start justify-start gap-2 py-2 text-start"
          data-testid="mode-new"
          (triggered)="choose('new')"
        >
          <span class="w-3 shrink-0 text-center" aria-hidden="true">{{
            mode() === 'new' ? '✓' : ''
          }}</span>
          <span class="flex min-w-0 flex-1 flex-col items-start text-start">
            <span i18n>New worktree</span>
            <span class="text-muted-foreground text-xs" i18n>Its own branch and files</span>
          </span>
        </button>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class ComposerStatus {
  readonly sessionId = input.required<SessionId>();
  /** Reads the folder again when a running Turn ends, since that is when its edits are done. */
  readonly running = input<boolean>(false);
  readonly openChanges = output<void>();

  private readonly runtime = inject(EffectRuntime);
  /** Counts reads; an answer for another Session or an older read is dropped. */
  private seq = 0;
  private readonly result = signal<ChangesResult | null>(null);

  /** The Session has not run a Turn yet, so it can still start in a new worktree. */
  protected readonly canSelect = signal(false);
  protected readonly mode = signal<Mode>('current');
  private readonly branches = signal<ReadonlyArray<string>>([]);
  /** The branch the new worktree starts from. */
  protected readonly base = signal<string | null>(null);
  protected readonly baseSearch = signal('');
  /** What the user typed as the new branch's name; empty means the name made from the message. */
  protected readonly nameInput = signal('');
  private readonly draftText = signal('');
  protected readonly preparing = signal(false);
  protected readonly message = signal<string | null>(null);

  /** Null until read, and for a folder that has no Git view. */
  protected readonly repo = computed(() => {
    const result = this.result();
    return result?._tag === 'Available' ? result : null;
  });
  protected readonly branch = computed(() => {
    const head = this.repo()?.head;
    if (head === undefined) return '';
    return head._tag === 'Detached' ? head.commit.slice(0, 7) : head.branch;
  });
  protected readonly added = computed(() =>
    (this.repo()?.files ?? []).reduce((sum, file) => sum + (file.additions ?? 0), 0),
  );
  protected readonly removed = computed(() =>
    (this.repo()?.files ?? []).reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  );
  protected readonly chipLabel = computed(() => {
    const name = this.branch();
    return this.mode() === 'new' ? $localize`New worktree` : $localize`Checkout: ${name}`;
  });
  protected readonly changesLabel = computed(() => {
    const files = this.repo()?.files.length ?? 0;
    const added = this.added();
    const removed = this.removed();
    return files === 0
      ? $localize`No changes`
      : $localize`Changes: ${files} files, ${added} added, ${removed} removed`;
  });
  protected readonly autoName = computed(() => branchNameFor(this.draftText()));
  /** The branches that match what is typed in the "from" box. */
  protected readonly matchingBranches = computed(() => {
    const search = this.baseSearch().trim().toLowerCase();
    const all = this.branches();
    // A chosen branch fills the box: show everything again until the user types something else.
    return search === '' || search === (this.base() ?? '').toLowerCase()
      ? all
      : all.filter((name) => name.toLowerCase().includes(search));
  });

  constructor() {
    effect(() => {
      this.sessionId();
      untracked(() => {
        this.result.set(null);
        this.canSelect.set(false);
        this.mode.set('current');
        this.nameInput.set('');
        this.message.set(null);
        this.read();
      });
    });
    let wasRunning = false;
    effect(() => {
      const running = this.running();
      if (wasRunning && !running) untracked(() => this.read());
      wasRunning = running;
    });
  }

  private read(): void {
    const seq = ++this.seq;
    const sessionId = this.sessionId();
    void this.runtime.run(loadChanges(sessionId)).then((exit) => {
      if (seq !== this.seq) return;
      this.result.set(Exit.isSuccess(exit) ? exit.value : null);
    });
    void this.runtime.run(loadWorktrees(sessionId)).then((exit) => {
      if (seq !== this.seq) return;
      this.canSelect.set(
        Exit.isSuccess(exit) && exit.value._tag === 'Available' && exit.value.canSelect,
      );
    });
  }

  protected choose(mode: Mode): void {
    this.message.set(null);
    this.mode.set(mode);
    if (mode === 'new') this.loadBases();
  }

  /** The local branches the new worktree can start from; the current branch is the default. */
  private loadBases(): void {
    const sessionId = this.sessionId();
    void this.runtime.run(loadBranches(sessionId)).then((exit) => {
      if (sessionId !== this.sessionId()) return;
      if (!Exit.isSuccess(exit) || exit.value._tag !== 'Available') return;
      const names = exit.value.branches.map((entry) => entry.name);
      this.branches.set(names);
      if (this.base() === null || !names.includes(this.base() ?? '')) {
        const current = this.branch();
        const start = names.includes(current) ? current : (names[0] ?? null);
        this.base.set(start);
        this.baseSearch.set(start ?? '');
      }
    });
  }

  /**
   * Called when the first message is sent. In "New worktree" mode it creates the worktree and moves the draft Session
   * into it first; false means the message must not be sent (the reason is shown here).
   */
  async prepare(messageText: string): Promise<boolean> {
    this.draftText.set(messageText);
    if (!this.canSelect() || this.mode() !== 'new') return true;
    const branch = this.nameInput().trim() || branchNameFor(messageText);
    this.preparing.set(true);
    this.message.set(null);
    const sessionId = this.sessionId();
    const exit = await this.runtime.run(prepareDraft(sessionId, branch, this.base() ?? undefined));
    this.preparing.set(false);
    if (sessionId !== this.sessionId()) return false;
    if (!Exit.isSuccess(exit)) {
      this.message.set($localize`Could not create the worktree.`);
      return false;
    }
    const result = exit.value;
    if (result._tag === 'Prepared') {
      this.mode.set('current');
      this.nameInput.set('');
      this.read();
      return true;
    }
    this.message.set(
      result._tag === 'Unavailable'
        ? unavailableText(result.reason)
        : prepareRejectionText(result.reason),
    );
    return false;
  }
}
