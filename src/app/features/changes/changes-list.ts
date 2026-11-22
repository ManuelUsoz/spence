import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import type { ChangedFile } from '../../../shared/source-control/source-control.rpc';
import { LineCounts, StatusMark } from './file-label';
import { splitPath } from './file-status';
import { Icon } from './icon';

/** A conflicted file cannot be committed or discarded until it is resolved. */
const isTickable = (file: ChangedFile): boolean => file.status !== 'Conflicted';

/**
 * The changed files of a Session: a select-all header, one row per file (tick it to commit it, click it to read
 * its diff) and a menu with the discard actions. It decides nothing: the page owns the selection.
 */
@Component({
  selector: 'app-changes-list',
  imports: [HlmButtonImports, HlmDropdownMenuImports, Icon, LineCounts, StatusMark],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 flex-1 flex-col', 'data-testid': 'changes-list' },
  template: `
    <div class="flex h-10 shrink-0 items-center gap-2.5 pr-2.5 pl-5">
      <input
        type="checkbox"
        class="shrink-0"
        data-testid="change-select-all"
        aria-label="Select all files"
        i18n-aria-label
        [checked]="allTicked()"
        [indeterminate]="someTicked()"
        (change)="toggleAll.emit(!allTicked())"
      />
      <span class="text-muted-foreground min-w-0 flex-1 truncate text-[12.5px] tabular-nums">{{
        summary()
      }}</span>
      <button
        type="button"
        hlmBtn
        variant="ghost"
        size="icon"
        data-testid="change-more"
        aria-label="More: discard selected, discard all"
        i18n-aria-label
        [hlmDropdownMenuTrigger]="moreMenu"
      >
        <app-icon name="more" />
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      @for (file of files(); track file.path) {
        <div
          class="hover:bg-accent flex min-h-[46px] items-center gap-1.5 rounded-xl pr-1.5 pl-2.5"
          [class.bg-accent]="selectedPath() === file.path"
          data-testid="change-row"
        >
          <input
            type="checkbox"
            class="ml-0.5 shrink-0"
            data-testid="change-check"
            [attr.aria-label]="file.path"
            [checked]="isTicked(file)"
            [disabled]="!isTickableFile(file)"
            (change)="toggle.emit(file)"
          />
          <button
            type="button"
            class="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1.5 text-left outline-none focus-visible:ring-2"
            data-testid="change-open"
            [attr.aria-current]="selectedPath() === file.path ? 'true' : null"
            (click)="open.emit(file)"
          >
            <app-status-mark [status]="file.status" />
            <span class="flex min-w-0 flex-1 flex-col leading-snug">
              <span class="truncate font-mono text-xs">{{ nameOf(file) }}</span>
              <span class="text-muted-foreground truncate font-mono text-[11.5px]">{{
                dirOf(file)
              }}</span>
            </span>
            <app-line-counts [additions]="file.additions" [deletions]="file.deletions" />
          </button>
          @if (running()) {
            <span
              class="size-1.5 shrink-0 rounded-full bg-[var(--attention)]"
              data-testid="editing-mark"
              title="The Agent is still editing"
              i18n-title
            ></span>
          }
        </div>
      }
      @if (excludedCount() > 0) {
        <p
          class="text-muted-foreground px-3 pt-2 text-[11.5px]"
          data-testid="changes-excluded"
          i18n
        >
          Paths not listed: {{ excludedCount() }} (nested repositories or special files).
        </p>
      }
    </div>

    <ng-template #moreMenu>
      <hlm-dropdown-menu class="w-56 rounded-xl" data-testid="change-more-menu">
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="discard-button"
          [disabled]="tickedCount() === 0"
          (triggered)="discardSelected.emit()"
          i18n
        >
          Discard selected…
        </button>
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="discard-all-button"
          [disabled]="tickable().length === 0"
          (triggered)="discardAll.emit()"
          i18n
        >
          Discard all…
        </button>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class ChangesList {
  readonly files = input.required<ReadonlyArray<ChangedFile>>();
  /** The file whose diff is open on the right. */
  readonly selectedPath = input<string | null>(null);
  /** Paths the user unticked; every other changed file is committed, so new ones start ticked. */
  readonly deselected = input<ReadonlySet<string>>(new Set());
  /** The Agent is mid-Turn, so the files may still change. */
  readonly running = input<boolean>(false);
  readonly excludedCount = input<number>(0);

  readonly open = output<ChangedFile>();
  readonly toggle = output<ChangedFile>();
  readonly toggleAll = output<boolean>();
  readonly discardSelected = output<void>();
  readonly discardAll = output<void>();

  protected readonly tickable = computed(() => this.files().filter(isTickable));
  protected readonly tickedCount = computed(
    () => this.tickable().filter((file) => !this.deselected().has(file.path)).length,
  );
  protected readonly allTicked = computed(
    () => this.tickable().length > 0 && this.tickedCount() === this.tickable().length,
  );
  protected readonly someTicked = computed(
    () => this.tickedCount() > 0 && this.tickedCount() < this.tickable().length,
  );
  protected readonly summary = computed(() => {
    const total = this.files().length;
    const ticked = this.tickedCount();
    return total === 1
      ? $localize`1 file · ${ticked} selected`
      : $localize`${total} files · ${ticked} selected`;
  });

  protected readonly isTickableFile = isTickable;

  protected isTicked(file: ChangedFile): boolean {
    return isTickable(file) && !this.deselected().has(file.path);
  }

  protected nameOf(file: ChangedFile): string {
    return splitPath(file.path).name;
  }

  protected dirOf(file: ChangedFile): string {
    return splitPath(file.path).dir;
  }
}
