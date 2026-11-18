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
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { WorktreeEntry, WorktreesResult } from '../../../shared/worktrees/worktrees.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';

const loadWorktrees = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Worktrees.list']({ sessionId });
});

/**
 * Which Worktree the Session works in, shown read-only. A Session chooses its worktree before its first message,
 * in the line under the Composer; afterwards it stays there.
 */
@Component({
  selector: 'app-worktree-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (current(); as entry) {
      <div class="flex flex-wrap items-center gap-2 text-xs" data-testid="worktree-bar">
        <span class="text-muted-foreground" i18n>Worktree</span>
        <span class="font-mono" data-testid="worktree-current">{{ label(entry) }}</span>
      </div>
    }
  `,
})
export class WorktreeBar {
  readonly sessionId = input.required<SessionId>();
  /** Changes whenever the page reads the folder again. */
  readonly reload = input<number>(0);

  private readonly runtime = inject(EffectRuntime);
  /** Counts reads; an answer for a Session that is no longer shown is dropped. */
  private seq = 0;
  private readonly listed = signal<WorktreesResult | null>(null);

  /** Null while loading, and when the folder has no Worktrees to show (not a repository). */
  protected readonly current = computed(() => {
    const result = this.listed();
    return result?._tag === 'Available'
      ? result.entries.find((entry) => entry.isCurrent)
      : undefined;
  });

  constructor() {
    effect(() => {
      this.sessionId();
      untracked(() => {
        this.listed.set(null);
        this.load();
      });
    });
    let firstReload = true;
    effect(() => {
      this.reload();
      if (firstReload) {
        firstReload = false;
        return;
      }
      untracked(() => this.load());
    });
  }

  private load(): void {
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
}
