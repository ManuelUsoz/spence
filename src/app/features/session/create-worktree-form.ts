import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  type OnInit,
} from '@angular/core';
import { Exit } from 'effect';
import { HlmButtonImports } from '@ui/button';
import { HlmInputImports } from '@ui/input';
import { HlmLabelImports } from '@ui/label';
import { HlmNativeSelectImports } from '@ui/native-select';
import { HlmProgressImports } from '@ui/progress';
import { toast } from '@ui/toast';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import {
  OperationId,
  type OperationSnapshot,
} from '../../../shared/source-control/source-control.rpc';
import type {
  WorktreeCreateReview,
  WorktreeEligibleBranch,
  WorktreeInventory,
  WorktreeStartPoint,
} from '../../../shared/worktrees/worktrees.rpc';
import { EffectRuntime } from '../../core/effect-runtime';
import {
  deriveSuggestedDestination,
  executeCreateWorktree,
  extractTypedRpcError,
  formatBlockerLine,
  pickWorktreeDestination,
  prepareCreateWorktree,
  progressStepLabel,
  progressStepPercent,
  revalidateCreateWorktree,
} from './worktree-operations';

const makeOperationId = (): OperationId => {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return OperationId.make(`wt-create-${uuid}`);
};

/**
 * Calm review-and-execute form for creating a new Git Worktree from the Composer Worktree dialog.
 */
@Component({
  selector: 'app-create-worktree-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmInputImports,
    HlmLabelImports,
    HlmNativeSelectImports,
    HlmProgressImports,
  ],
  template: `
    <div class="flex flex-col gap-3" data-testid="worktree-create-form">
      @if (loadingReview()) {
        <p class="text-muted-foreground text-xs" i18n>Inspecting repository state…</p>
      } @else if (loadError(); as err) {
        <div
          class="border-destructive/30 bg-destructive/5 flex flex-col gap-2 rounded-md border p-3 text-xs"
          data-testid="worktree-create-load-error"
        >
          <p class="text-destructive font-medium" i18n>Unable to prepare Worktree review</p>
          <p class="text-foreground">{{ err }}</p>
          <div class="flex gap-2">
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              (click)="loadInitialReview()"
              i18n
            >
              Try again
            </button>
            <button
              hlmBtn
              type="button"
              variant="secondary"
              size="sm"
              data-testid="worktree-create-cancel"
              (click)="cancelled.emit()"
              i18n
            >
              Cancel
            </button>
          </div>
        </div>
      } @else if (review(); as rev) {
        <div class="flex flex-col gap-1">
          <h3 class="text-sm font-medium" i18n>Create Worktree</h3>
          <p class="text-muted-foreground text-xs">
            <span i18n>Source checkout:</span>
            <code class="font-mono font-normal text-xs"> {{ sourceSummary(rev) }}</code>
          </p>
        </div>

        <label class="flex flex-col gap-1.5">
          <span hlmLabel for="wt-create-start-from" i18n>Start from</span>
          <select
            #startFromSelect
            id="wt-create-start-from"
            hlmNativeSelect
            data-testid="worktree-create-start-from"
            [value]="startFromSelectValue()"
            [disabled]="submitting()"
            (change)="onStartFromChange(startFromSelect.value)"
          >
            <option value="head">{{ headOptionLabel(rev) }}</option>
            @for (item of rev.eligibleBranches; track item.name) {
              <option [value]="branchOptionValue(item)" [disabled]="item.checkedOut">
                {{ branchOptionLabel(item) }}
              </option>
            }
          </select>
        </label>

        <label class="flex flex-col gap-1.5">
          <span hlmLabel for="wt-create-branch" i18n>Branch</span>
          <input
            #branchInput
            id="wt-create-branch"
            hlmInput
            type="text"
            class="font-mono font-normal text-xs"
            data-testid="worktree-create-branch"
            [value]="branch()"
            [readonly]="startFrom().mode === 'Branch'"
            [disabled]="submitting()"
            (input)="onBranchInput(branchInput.value)"
          />
        </label>

        <div class="flex flex-col gap-1.5">
          <label hlmLabel for="wt-create-destination" i18n>Destination folder</label>
          <div class="flex items-center gap-2">
            <input
              #destInput
              id="wt-create-destination"
              hlmInput
              type="text"
              class="min-w-0 flex-1 font-mono font-normal text-xs"
              data-testid="worktree-create-destination"
              [value]="destinationPath()"
              [disabled]="submitting()"
              (input)="onDestinationInput(destInput.value)"
            />
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              data-testid="worktree-create-browse"
              [disabled]="submitting()"
              (click)="onBrowseDestination()"
              i18n
            >
              Browse…
            </button>
          </div>
        </div>

        <div class="flex flex-col gap-1 text-xs">
          <p class="text-muted-foreground" i18n>
            Uncommitted changes stay in the original Worktree.
          </p>
          @if (rev.sourceDirtyCount > 0) {
            <p class="text-muted-foreground tabular-nums">
              <span class="tabular-nums">{{ rev.sourceDirtyCount }}</span>
              @if (rev.sourceDirtyCount === 1) {
                <span i18n> uncommitted change in the source Worktree will stay put.</span>
              } @else {
                <span i18n> uncommitted changes in the source Worktree will stay put.</span>
              }
            </p>
          }
        </div>

        @if (rev.blockers.length > 0 || rev.stale || needsRereview() || submitError() !== null) {
          <div
            class="border-destructive/30 bg-destructive/5 flex flex-col gap-2 rounded-md border p-3 text-xs"
            data-testid="worktree-create-blockers"
          >
            @if (submitError(); as errMsg) {
              <p class="text-destructive font-medium">{{ errMsg }}</p>
            }
            @if (rev.stale && rev.staleReason; as staleReason) {
              <p class="text-foreground">{{ staleReason }}</p>
            }
            @for (blocker of rev.blockers; track blocker.code + blocker.detail) {
              <p class="text-foreground">{{ blockerText(blocker) }}</p>
            }
            @if (rev.stale || needsRereview() || rev.blockers.length > 0) {
              <div>
                <button
                  hlmBtn
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="worktree-create-rereview"
                  [disabled]="revalidating() || submitting()"
                  (click)="onRereview()"
                  i18n
                >
                  Refresh review
                </button>
              </div>
            }
          </div>
        }

        @if (activeProgressOperation(); as op) {
          <div
            class="border-border bg-muted/40 flex flex-col gap-1.5 rounded-md border p-3 text-xs"
            data-testid="worktree-create-progress"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="font-medium">{{ stepLabel(op) }}</span>
              <span class="text-muted-foreground font-mono font-normal text-xs">
                {{ op.branch }}
              </span>
            </div>
            <hlm-progress [value]="stepPercent(op)">
              <hlm-progress-indicator />
            </hlm-progress>
            @if (op.progress?.detail; as detail) {
              <p class="text-muted-foreground">{{ detail }}</p>
            }
          </div>
        }

        <div class="flex items-center justify-end gap-2 pt-1">
          <button
            hlmBtn
            type="button"
            variant="secondary"
            size="sm"
            data-testid="worktree-create-cancel"
            [disabled]="submitting()"
            (click)="cancelled.emit()"
            i18n
          >
            Cancel
          </button>
          <button
            hlmBtn
            type="button"
            size="sm"
            data-testid="worktree-create-submit"
            [disabled]="createDisabled()"
            (click)="onSubmit()"
          >
            @if (submitting()) {
              <span i18n>Creating…</span>
            } @else {
              <span i18n>Create</span>
            }
          </button>
        </div>
      }
    </div>
  `,
})
export class CreateWorktreeForm implements OnInit {
  private readonly runtime = inject(EffectRuntime);
  private readonly destroyRef = inject(DestroyRef);
  private readonly formAborts = new AbortController();

  readonly sourcePath = input.required<string>();
  readonly projectId = input<ProjectId | undefined>(undefined);
  readonly operations = input<ReadonlyArray<OperationSnapshot>>([]);

  readonly cancelled = output<void>();
  readonly operationUpserted = output<OperationSnapshot>();
  readonly inventoryUpdated = output<WorktreeInventory>();
  readonly completed = output<{ readonly recoveryNeeded: boolean }>();

  protected readonly loadingReview = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly review = signal<WorktreeCreateReview | null>(null);
  protected readonly branch = signal('');
  protected readonly destinationPath = signal('');
  protected readonly destinationManual = signal(false);
  protected readonly startFrom = signal<WorktreeStartPoint>({ mode: 'Head' });
  protected readonly submitting = signal(false);
  protected readonly revalidating = signal(false);
  protected readonly needsRereview = signal(false);
  protected readonly submitError = signal<string | null>(null);
  protected readonly submittedOperationId = signal<OperationId | null>(null);

  protected readonly startFromSelectValue = computed(() => {
    const sf = this.startFrom();
    return sf.mode === 'Head' ? 'head' : `branch:${sf.branch}`;
  });

  protected readonly activeProgressOperation = computed(() => {
    const opId = this.submittedOperationId();
    if (opId === null) return null;
    return this.operations().find((op) => op.id === opId) ?? null;
  });

  protected readonly createDisabled = computed(() => {
    const rev = this.review();
    if (rev === null || this.submitting() || this.revalidating()) return true;
    if (rev.stale || this.needsRereview() || rev.blockers.length > 0) return true;
    return this.branch().trim() === '' || this.destinationPath().trim() === '';
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.formAborts.abort();
    });
    effect(() => {
      const op = this.activeProgressOperation();
      if (op !== null && op.phase === 'Completed' && op.outcome === 'Succeeded') {
        this.submitting.set(false);
      }
    });
  }

  ngOnInit(): void {
    void this.loadInitialReview();
  }

  protected async loadInitialReview(): Promise<void> {
    this.loadingReview.set(true);
    this.loadError.set(null);
    const exit = await this.runtime.run(
      prepareCreateWorktree(this.sourcePath(), this.projectId()),
      {
        signal: this.formAborts.signal,
      },
    );
    if (this.formAborts.signal.aborted) return;
    this.loadingReview.set(false);
    if (Exit.isSuccess(exit)) {
      const rev = exit.value;
      this.review.set(rev);
      this.branch.set(rev.defaultBranch);
      this.destinationPath.set(rev.defaultDestination);
      this.destinationManual.set(false);
      this.startFrom.set({ mode: 'Head' });
      this.needsRereview.set(rev.stale);
      this.submitError.set(null);
      return;
    }
    const err = extractTypedRpcError(exit.cause);
    this.loadError.set(
      err?.detail || $localize`Could not inspect the repository for Worktree creation.`,
    );
  }

  protected onStartFromChange(value: string): void {
    const rev = this.review();
    if (rev === null) return;
    if (value.startsWith('branch:')) {
      const chosen = value.slice('branch:'.length);
      this.startFrom.set({ mode: 'Branch', branch: chosen });
      this.branch.set(chosen);
      if (!this.destinationManual()) {
        this.destinationPath.set(
          deriveSuggestedDestination(rev.sourcePath, rev.defaultDestination, chosen),
        );
      }
      return;
    }
    this.startFrom.set({ mode: 'Head' });
    this.submitError.set(null);
  }

  protected onBranchInput(nextBranch: string): void {
    this.branch.set(nextBranch);
    this.submitError.set(null);
    const rev = this.review();
    if (rev !== null && !this.destinationManual()) {
      this.destinationPath.set(
        deriveSuggestedDestination(rev.sourcePath, rev.defaultDestination, nextBranch),
      );
    }
  }

  protected onDestinationInput(nextDest: string): void {
    this.destinationPath.set(nextDest);
    this.destinationManual.set(true);
    this.submitError.set(null);
  }

  protected async onBrowseDestination(): Promise<void> {
    const exit = await this.runtime.run(
      pickWorktreeDestination(this.destinationPath() || this.sourcePath()),
      { signal: this.formAborts.signal },
    );
    if (this.formAborts.signal.aborted || !Exit.isSuccess(exit) || exit.value === null) return;
    this.destinationPath.set(exit.value);
    this.destinationManual.set(true);
    this.submitError.set(null);
  }

  protected async onRereview(): Promise<void> {
    const rev = this.review();
    if (rev === null || this.revalidating()) return;
    this.revalidating.set(true);
    const pid = this.projectId();
    const exit = await this.runtime.run(
      revalidateCreateWorktree({
        reviewId: rev.reviewId,
        sourcePath: rev.sourcePath,
        destinationPath: this.destinationPath().trim(),
        branch: this.branch().trim(),
        startFrom: this.startFrom(),
        ...(pid === undefined ? {} : { projectId: pid }),
      }),
      { signal: this.formAborts.signal },
    );
    if (this.formAborts.signal.aborted) return;
    this.revalidating.set(false);
    if (Exit.isSuccess(exit)) {
      const fresh = exit.value;
      this.review.set(fresh);
      this.needsRereview.set(fresh.stale);
      this.submitError.set(
        fresh.stale
          ? (fresh.staleReason ?? $localize`Review needs refresh before creating.`)
          : null,
      );
      return;
    }
    const err = extractTypedRpcError(exit.cause);
    this.submitError.set(err?.detail || $localize`Failed to refresh Worktree review.`);
  }

  protected async onSubmit(): Promise<void> {
    const rev = this.review();
    if (rev === null || this.createDisabled()) return;

    const operationId = makeOperationId();
    const trimmedBranch = this.branch().trim();
    const trimmedDest = this.destinationPath().trim();
    const pid = this.projectId();

    this.submitting.set(true);
    this.submittedOperationId.set(operationId);
    this.submitError.set(null);

    const exit = await this.runtime.run(
      executeCreateWorktree({
        reviewId: rev.reviewId,
        operationId,
        sourcePath: rev.sourcePath,
        destinationPath: trimmedDest,
        branch: trimmedBranch,
        startFrom: this.startFrom(),
        ...(pid === undefined ? {} : { projectId: pid }),
      }),
      { signal: this.formAborts.signal },
    );
    if (this.formAborts.signal.aborted) return;

    this.submitting.set(false);
    if (Exit.isFailure(exit)) {
      const err = extractTypedRpcError(exit.cause);
      if (err?.reason === 'StaleReview' || err?.reason === 'ReviewExpired') {
        this.needsRereview.set(true);
      }
      this.submitError.set(err?.detail || $localize`Worktree creation failed.`);
      return;
    }

    const result = exit.value;
    this.operationUpserted.emit(result.operation);
    if (result.inventory !== undefined) {
      this.inventoryUpdated.emit(result.inventory);
    }

    if (result.operation.phase === 'Completed' && result.operation.outcome === 'Succeeded') {
      toast.success($localize`Created Worktree for branch ${trimmedBranch}.`);
      this.completed.emit({ recoveryNeeded: false });
      return;
    }

    if (result.operation.phase === 'NeedsRecovery') {
      this.completed.emit({ recoveryNeeded: true });
      return;
    }

    this.submitError.set(
      result.operation.errorDetail ??
        result.operation.unknownReason ??
        $localize`Worktree creation did not complete.`,
    );
  }

  protected sourceSummary(rev: WorktreeCreateReview): string {
    switch (rev.sourceHead._tag) {
      case 'Branch':
        return rev.sourceHead.commit === undefined
          ? rev.sourceHead.branch
          : `${rev.sourceHead.branch} · ${rev.sourceHead.commit.slice(0, 7)}`;
      case 'Detached':
        return `@${rev.sourceHead.commit.slice(0, 7)}`;
      case 'Unborn':
        return rev.sourceHead.branch;
    }
  }

  protected headOptionLabel(rev: WorktreeCreateReview): string {
    switch (rev.sourceHead._tag) {
      case 'Branch':
        return rev.sourceHead.commit === undefined
          ? $localize`Current HEAD`
          : $localize`Current HEAD · ${rev.sourceHead.commit.slice(0, 7)}`;
      case 'Detached':
        return $localize`Current HEAD · ${rev.sourceHead.commit.slice(0, 7)}`;
      case 'Unborn':
        return $localize`Current HEAD · unborn`;
    }
  }

  protected branchOptionValue(item: WorktreeEligibleBranch): string {
    return `branch:${item.name}`;
  }

  protected branchOptionLabel(item: WorktreeEligibleBranch): string {
    const shortCommit = item.commit.slice(0, 7);
    return item.checkedOut
      ? $localize`${item.name} · ${shortCommit} (checked out)`
      : $localize`${item.name} · ${shortCommit}`;
  }

  protected blockerText(blocker: WorktreeCreateReview['blockers'][number]): string {
    return formatBlockerLine(blocker);
  }

  protected stepLabel(op: OperationSnapshot): string {
    return progressStepLabel(op.progress?.step ?? 'Preparing');
  }

  protected stepPercent(op: OperationSnapshot): number {
    return progressStepPercent(op.progress?.step ?? 'Preparing');
  }
}
