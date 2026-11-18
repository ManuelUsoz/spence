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
import type { ChangesResult } from '../../../shared/source-control/source-control.rpc';
import { ChangesState } from '../../core/changes-view';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';

const loadChanges = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.changes']({ sessionId });
});

/**
 * The quiet line under the composer: the branch the Session works on and how many files changed, which opens the
 * Changes view. It reads the folder itself, so it shows what is on disk whoever wrote it, and shows nothing for a
 * folder that is not a Git repository.
 */
@Component({
  selector: 'app-composer-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (repo(); as info) {
      <div
        class="text-muted-foreground flex items-center gap-3 px-4 pt-1.5 pb-2 text-xs"
        data-testid="composer-status"
      >
        <span class="flex min-w-0 items-center gap-1.5" data-testid="composer-status-branch">
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
            <circle cx="6" cy="6" r="2" />
            <circle cx="6" cy="18" r="2" />
            <path d="M6 8v8" />
            <path d="M13 6h3a2 2 0 0 1 2 2v7" />
            <circle cx="18" cy="18" r="2" />
          </svg>
          <span class="truncate font-mono">{{ branch() }}</span>
        </span>
        <span class="flex-1"></span>
        <button
          type="button"
          class="hover:text-foreground focus-visible:ring-ring rounded-md px-1 outline-none focus-visible:ring-2"
          data-testid="composer-status-changes"
          (click)="changes.show()"
        >
          @if (info.files.length === 0) {
            <span i18n>No changes</span>
          } @else if (info.files.length === 1) {
            <span i18n>1 change</span>
          } @else {
            <span i18n>{{ info.files.length }} changes</span>
          }
        </button>
      </div>
    }
  `,
})
export class ComposerStatus {
  readonly sessionId = input.required<SessionId>();
  /** Reads the folder again when a running Turn ends, since that is when its edits are done. */
  readonly running = input<boolean>(false);

  protected readonly changes = inject(ChangesState);
  private readonly runtime = inject(EffectRuntime);
  /** Counts reads; an answer for another Session or an older read is dropped. */
  private seq = 0;
  private readonly result = signal<ChangesResult | null>(null);

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

  constructor() {
    effect(() => {
      this.sessionId();
      untracked(() => {
        this.result.set(null);
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
    void this.runtime.run(loadChanges(this.sessionId())).then((exit) => {
      if (seq !== this.seq) return;
      this.result.set(Exit.isSuccess(exit) ? exit.value : null);
    });
  }
}
