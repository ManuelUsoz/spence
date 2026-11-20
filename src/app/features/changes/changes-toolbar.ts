import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmSelectImports } from '@ui/select';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { ChangesResult } from '../../../shared/source-control/source-control.rpc';
import { RemoteActions } from './remote-actions';
import { segmentClass } from './segment';
import { WorktreeBar } from './worktree-bar';

export type ChangesTab = 'changes' | 'history' | 'files';

export type AvailableChanges = Extract<ChangesResult, { _tag: 'Available' }>;

/**
 * The slim row above the frame: the three tabs, the Worktree and branch, Fetch / Pull / Push and Refresh.
 * It is the same for every tab; it holds no state of its own.
 */
@Component({
  selector: 'app-changes-toolbar',
  imports: [HlmButtonImports, HlmSelectImports, RemoteActions, WorktreeBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'border-border/60 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5',
    'data-testid': 'changes-toolbar',
  },
  template: `
    <div
      role="group"
      aria-label="Source control"
      i18n-aria-label
      class="bg-accent flex gap-0.5 rounded-xl p-0.5"
    >
      <button
        type="button"
        data-testid="changes-tab"
        class="h-7 rounded-lg px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        [class]="segmentClass(tab() === 'changes')"
        [attr.aria-pressed]="tab() === 'changes'"
        (click)="tabChange.emit('changes')"
      >
        <span i18n>Changes</span>
        @if (fileCount() > 0) {
          <span class="text-muted-foreground ml-1 text-xs tabular-nums">{{ fileCount() }}</span>
        }
      </button>
      <button
        type="button"
        data-testid="history-tab"
        class="h-7 rounded-lg px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        [class]="segmentClass(tab() === 'history')"
        [attr.aria-pressed]="tab() === 'history'"
        (click)="tabChange.emit('history')"
        i18n
      >
        History
      </button>
      <button
        type="button"
        data-testid="files-tab-button"
        class="h-7 rounded-lg px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        [class]="segmentClass(tab() === 'files')"
        [attr.aria-pressed]="tab() === 'files'"
        (click)="tabChange.emit('files')"
        i18n
      >
        Files
      </button>
    </div>
    <app-worktree-bar [sessionId]="sessionId()" [reload]="reloads()" />
    @if (headLabel(); as label) {
      <span class="text-muted-foreground font-mono text-xs" data-testid="changes-head">{{
        label
      }}</span>
    }
    <span class="flex-1"></span>
    @if (repo(); as available) {
      @if (available.upstream === undefined && available.remotes.length > 1) {
        <hlm-select
          data-testid="remote-select"
          [value]="remote() ?? null"
          (valueChange)="chooseRemote($event)"
        >
          <hlm-select-trigger
            class="w-40"
            size="sm"
            aria-label="Remote"
            i18n-aria-label
            data-testid="remote-select-trigger"
          >
            <hlm-select-value placeholder="Choose a remote" i18n-placeholder />
          </hlm-select-trigger>
          <hlm-select-content *hlmSelectPortal>
            @for (name of available.remotes; track name) {
              <hlm-select-item [value]="name">{{ name }}</hlm-select-item>
            }
          </hlm-select-content>
        </hlm-select>
      }
      <app-remote-actions
        [sessionId]="sessionId()"
        [ahead]="available.upstream?.ahead ?? 0"
        [behind]="available.upstream?.behind ?? 0"
        [hasUpstream]="available.upstream !== undefined"
        [canPush]="canPush()"
        [remote]="remote()"
        (changed)="changed.emit()"
      />
    }
    <button
      type="button"
      hlmBtn
      variant="ghost"
      size="sm"
      data-testid="changes-refresh"
      (click)="refresh.emit()"
      i18n
    >
      Refresh
    </button>
  `,
})
export class ChangesToolbar {
  readonly sessionId = input.required<SessionId>();
  readonly tab = input.required<ChangesTab>();
  /** Counts refreshes; the Worktree label reads again when it changes. */
  readonly reloads = input<number>(0);
  readonly fileCount = input<number>(0);
  readonly headLabel = input<string | null>(null);
  /** The repository, once its changes are read; the remote buttons need it. */
  readonly repo = input<AvailableChanges | null>(null);
  readonly canPush = input<boolean>(false);
  readonly remote = input<string | undefined>(undefined);

  readonly tabChange = output<ChangesTab>();
  readonly refresh = output<void>();
  readonly remoteChosen = output<string | undefined>();
  /** A fetch, pull or push happened: the page reads the folder again. */
  readonly changed = output<void>();

  protected readonly segmentClass = segmentClass;

  protected chooseRemote(value: unknown): void {
    this.remoteChosen.emit(typeof value === 'string' ? value : undefined);
  }
}
