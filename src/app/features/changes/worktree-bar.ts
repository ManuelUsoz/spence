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
import { HlmButtonImports } from '@ui/button';
import { HlmInputImports } from '@ui/input';
import { HlmNativeSelectImports } from '@ui/native-select';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { WorktreeEntry, WorktreesResult } from '../../../shared/worktrees/worktrees.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { unavailableText } from './git-text';

const loadWorktrees = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Worktrees.list']({ sessionId });
});

const selectWorktree = Effect.fnUntraced(function* (sessionId: SessionId, path: string) {
  const api = yield* DesktopApi;
  return yield* api['Worktrees.select']({ sessionId, path });
});

const createWorktree = Effect.fnUntraced(function* (sessionId: SessionId, branch: string) {
  const api = yield* DesktopApi;
  return yield* api['Worktrees.create']({ sessionId, branch });
});

/**
 * Which Worktree the Session works in. Before its first message a draft Session can move to another Worktree of
 * its repository, or to a new one on a new branch; afterwards the Worktree is fixed and only shown.
 */
@Component({
  selector: 'app-worktree-bar',
  imports: [HlmButtonImports, HlmInputImports, HlmNativeSelectImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (entries(); as worktrees) {
      <div class="flex flex-wrap items-center gap-2 text-xs" data-testid="worktree-bar">
        <span class="text-muted-foreground" i18n>Worktree</span>
        @if (draft() && worktrees.length > 1) {
          <hlm-native-select
            data-testid="worktree-select"
            aria-label="Worktree"
            i18n-aria-label
            [value]="currentPath()"
            (valueChange)="select($event)"
          >
            @for (entry of worktrees; track entry.path) {
              <option [value]="entry.path" [disabled]="entry.missing">{{ label(entry) }}</option>
            }
          </hlm-native-select>
        } @else {
          <span class="font-mono" data-testid="worktree-current">{{ currentLabel() }}</span>
        }
        @if (draft()) {
          <button
            type="button"
            hlmBtn
            variant="ghost"
            size="sm"
            data-testid="worktree-new"
            (click)="creating.set(!creating())"
            i18n
          >
            New Worktree
          </button>
        }
      </div>
      @if (creating()) {
        <form class="mt-2 flex items-center gap-2" (submit)="create($event)">
          <input
            hlmInput
            class="h-8 w-64"
            data-testid="worktree-branch"
            placeholder="New branch name"
            i18n-placeholder
            aria-label="New branch name"
            i18n-aria-label
            [value]="branch()"
            (input)="branch.set($any($event.target).value)"
          />
          <button
            type="submit"
            hlmBtn
            size="sm"
            data-testid="worktree-create"
            [disabled]="busy() || branch().trim().length === 0"
            i18n
          >
            Create
          </button>
        </form>
      }
      @if (message(); as text) {
        <p class="text-destructive mt-1 text-xs" data-testid="worktree-message">{{ text }}</p>
      }
    }
  `,
})
export class WorktreeBar {
  readonly sessionId = input.required<SessionId>();
  /** The Session has not run a Turn yet, so it can still move to another Worktree. */
  readonly draft = input<boolean>(false);
  /** The Session moved to another Worktree: its changes and files are different now. */
  readonly moved = output<void>();

  private readonly runtime = inject(EffectRuntime);
  /** Counts reads; an answer for a Session that is no longer shown is dropped. */
  private seq = 0;

  private readonly listed = signal<WorktreesResult | null>(null);
  protected readonly creating = signal(false);
  protected readonly branch = signal('');
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);

  /** Null while loading, or when the folder has no Worktrees to show (not a repository). */
  protected readonly entries = computed(() => {
    const result = this.listed();
    return result?._tag === 'Available' ? result.entries : null;
  });
  protected readonly current = computed(() => this.entries()?.find((entry) => entry.isCurrent));
  protected readonly currentPath = computed(() => this.current()?.path ?? '');
  protected readonly currentLabel = computed(() => {
    const entry = this.current();
    return entry === undefined ? '' : this.label(entry);
  });

  constructor() {
    effect(() => {
      this.sessionId();
      untracked(() => {
        this.listed.set(null);
        this.creating.set(false);
        this.branch.set('');
        this.message.set(null);
        this.reload();
      });
    });
  }

  private reload(): void {
    const seq = ++this.seq;
    void this.runtime.run(loadWorktrees(this.sessionId())).then((exit) => {
      if (seq !== this.seq || !Exit.isSuccess(exit)) return;
      this.listed.set(exit.value);
    });
  }

  protected label(entry: WorktreeEntry): string {
    const branch = entry.branch ?? $localize`detached`;
    return entry.missing
      ? $localize`${branch} · ${entry.folderName} (missing)`
      : `${branch} · ${entry.folderName}`;
  }

  protected select(path: string | null | undefined): Promise<void> {
    if (path === null || path === undefined || path === this.currentPath()) {
      return Promise.resolve();
    }
    this.message.set(null);
    return this.runtime.run(selectWorktree(this.sessionId(), path)).then((exit) => {
      if (!Exit.isSuccess(exit)) {
        this.message.set($localize`Could not change the Worktree.`);
        return;
      }
      const result = exit.value;
      if (result._tag === 'Selected') {
        this.reload();
        this.moved.emit();
        return;
      }
      this.message.set(
        result._tag === 'Unavailable'
          ? unavailableText(result.reason)
          : result.reason === 'Busy'
            ? $localize`This Session already has messages, so it stays in its Worktree.`
            : result.reason === 'Missing'
              ? $localize`That Worktree's folder no longer exists.`
              : $localize`That is not a Worktree of this repository.`,
      );
      this.reload();
    });
  }

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.branch().trim();
    if (name.length === 0 || this.busy()) return;
    this.busy.set(true);
    this.message.set(null);
    const exit = await this.runtime.run(createWorktree(this.sessionId(), name));
    this.busy.set(false);
    if (!Exit.isSuccess(exit)) {
      this.message.set($localize`Could not create the Worktree.`);
      return;
    }
    const result = exit.value;
    if (result._tag === 'Created') {
      this.creating.set(false);
      this.branch.set('');
      this.reload();
      await this.select(result.entry.path);
      const problem = this.message();
      // The Worktree exists even when moving into it failed.
      if (problem !== null) {
        this.message.set($localize`The Worktree was created. ${problem}`);
      }
      return;
    }
    this.message.set(
      result._tag === 'Unavailable'
        ? unavailableText(result.reason)
        : result.reason === 'InvalidBranch'
          ? $localize`That is not a valid branch name.`
          : result.reason === 'BranchExists'
            ? $localize`A branch with that name already exists.`
            : $localize`The folder for that Worktree already exists.`,
    );
  }
}
