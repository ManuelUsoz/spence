import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { HlmInput } from '@ui/input';
import { HlmSelectImports } from '@ui/select';
import { toast } from '@ui/toast';
import { HlmSwitch } from '@ui/switch';
import { Effect, Exit } from 'effect';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type {
  CreatePrPreparation,
  DraftPullRequestResult,
  PullRequestSummary,
} from '../../../shared/pull-requests/pull-requests.rpc';
import { DEFAULT_PULL_REQUEST_SETTINGS } from '../../../shared/settings/settings.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { Keymap } from '../../core/keymap';

type PrepState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly detail: string }
  | { readonly status: 'loaded'; readonly value: CreatePrPreparation };

@Component({
  selector: 'app-pr-create-form',
  imports: [HlmButton, HlmInput, HlmSelectImports, HlmSwitch, HlmAlertDialogImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block px-8 py-6', 'data-testid': 'pr-create-form' },
  template: `
    <div class="mx-auto max-w-2xl space-y-5">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-xl font-normal" i18n>Create Pull request</h2>
        <button
          hlmBtn
          type="button"
          variant="ghost"
          size="sm"
          data-testid="pr-create-cancel"
          (click)="cancelled.emit()"
          i18n
        >
          Cancel
        </button>
      </div>

      @switch (prepState().status) {
        @case ('loading') {
          <p class="text-muted-foreground text-sm" data-testid="pr-create-loading" i18n>
            Inspecting branch and repository…
          </p>
        }
        @case ('failed') {
          @if (prepState(); as failed) {
            @if (failed.status === 'failed') {
              <div class="space-y-3" data-testid="pr-create-error">
                <p class="text-destructive text-sm">{{ failed.detail }}</p>
                <button
                  hlmBtn
                  type="button"
                  variant="outline"
                  size="sm"
                  (click)="loadPreparation()"
                  i18n
                >
                  Retry
                </button>
              </div>
            }
          }
        }
        @case ('loaded') {
          @if (prepState(); as loaded) {
            @if (loaded.status === 'loaded') {
              @let prep = loaded.value;

              <!-- Branch Summary & Base Picker -->
              <div
                class="border-border bg-muted/20 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm"
              >
                <div class="flex items-center gap-2">
                  <span class="text-muted-foreground text-xs" i18n>Base</span>
                  <hlm-select
                    data-testid="pr-create-base-select"
                    [value]="prep.baseRef"
                    (valueChange)="onBaseChange($event)"
                  >
                    <hlm-select-trigger class="h-7 font-mono text-xs" buttonId="pr-create-base">
                      {{ prep.baseRef }}
                    </hlm-select-trigger>
                    <hlm-select-content *hlmSelectPortal>
                      @for (branch of prep.availableBaseRefs; track branch) {
                        <hlm-select-item
                          class="font-mono text-xs"
                          [value]="branch"
                          [attr.data-value]="branch"
                        >
                          {{ branch }}
                        </hlm-select-item>
                      }
                    </hlm-select-content>
                  </hlm-select>
                </div>

                <span class="text-muted-foreground" aria-hidden="true">←</span>

                <div class="flex items-center gap-2">
                  <span class="text-muted-foreground text-xs" i18n>Compare</span>
                  <span class="font-mono text-xs" data-testid="pr-create-head-branch">
                    {{ prep.headRef ?? '(detached HEAD)' }}
                  </span>
                </div>

                <span class="text-muted-foreground ml-auto text-xs tabular-nums">
                  @if (prep.aheadCount === 1) {
                    <ng-container i18n>1 commit ahead</ng-container>
                  } @else {
                    <ng-container i18n>{{ prep.aheadCount }} commits ahead</ng-container>
                  }
                </span>
              </div>

              <!-- Hard Blockers -->
              @if (prep.blockers.length > 0) {
                <div
                  class="border-destructive/40 bg-destructive/5 space-y-1.5 rounded-lg border px-4 py-3 text-sm"
                  data-testid="pr-create-blockers"
                >
                  @for (blocker of prep.blockers; track blocker.reason) {
                    <p class="text-destructive text-xs">{{ blocker.detail }}</p>
                  }
                </div>
              }

              <!-- Dirty Working-Tree Non-blocking Note -->
              @if (prep.isDirty) {
                <div
                  class="border-border bg-muted/30 text-muted-foreground rounded-lg border px-4 py-2.5 text-xs"
                  data-testid="pr-create-dirty-note"
                  i18n
                >
                  This Worktree has uncommitted changes. Only committed changes on
                  <span class="font-mono">{{ prep.headRef ?? 'HEAD' }}</span> will be included.
                </div>
              }

              <!-- Pending Apply-Draft Banner -->
              @if (pendingDraft(); as draft) {
                <div
                  class="border-border bg-accent/40 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-2.5 text-xs"
                  data-testid="pr-create-apply-draft-banner"
                >
                  <span i18n>An Agent draft is ready. Apply it over your current edits?</span>
                  <div class="flex items-center gap-2">
                    <button
                      hlmBtn
                      type="button"
                      variant="outline"
                      size="sm"
                      class="h-7 px-2.5 text-xs"
                      data-testid="pr-create-apply-draft"
                      (click)="applyPendingDraft(draft)"
                      i18n
                    >
                      Apply draft
                    </button>
                    <button
                      hlmBtn
                      type="button"
                      variant="ghost"
                      size="sm"
                      class="h-7 px-2 text-xs"
                      (click)="pendingDraft.set(null)"
                      i18n
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              }

              <!-- Title & Description -->
              <div class="space-y-4">
                <div class="space-y-1.5">
                  <div class="flex items-center justify-between gap-2">
                    <label class="text-xs font-medium" for="pr-create-title" i18n>Title</label>
                    <div class="flex items-center gap-2">
                      @if (drafting()) {
                        <span
                          class="text-muted-foreground text-xs"
                          data-testid="pr-create-drafting"
                          i18n
                        >
                          Drafting…
                        </span>
                      } @else if (draftFailed()) {
                        <span
                          class="text-muted-foreground text-xs"
                          data-testid="pr-create-draft-failed"
                          i18n
                        >
                          Couldn't draft
                        </span>
                      }
                      <button
                        hlmBtn
                        type="button"
                        variant="ghost"
                        size="sm"
                        class="h-6 px-2 text-xs"
                        data-testid="pr-create-redraft"
                        [disabled]="drafting() || prep.headRef === null || prep.aheadCount === 0"
                        (click)="onRedraftClick()"
                        i18n
                      >
                        Redraft
                      </button>
                    </div>
                  </div>
                  <input
                    hlmInput
                    id="pr-create-title"
                    data-testid="pr-create-title-input"
                    class="w-full"
                    placeholder="Pull request title"
                    i18n-placeholder
                    [value]="title()"
                    (input)="onTitleInput($any($event.target).value)"
                  />
                </div>

                <div class="space-y-1.5">
                  <label class="text-xs font-medium" for="pr-create-body" i18n>Description</label>
                  <textarea
                    id="pr-create-body"
                    data-testid="pr-create-body-input"
                    rows="10"
                    class="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-[3px]"
                    placeholder="Describe your changes…"
                    i18n-placeholder
                    [value]="body()"
                    (input)="onBodyInput($any($event.target).value)"
                  ></textarea>
                </div>
              </div>

              <!-- Footer: Draft Toggle + Primary Action -->
              <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
                @if (prep.supportsDraft) {
                  <label class="flex cursor-pointer items-center gap-2 text-xs">
                    <hlm-switch
                      data-testid="pr-create-draft-toggle"
                      [checked]="draft()"
                      (checkedChange)="draft.set($event)"
                    />
                    <span i18n>Create as draft</span>
                  </label>
                } @else {
                  <span></span>
                }

                <div class="flex items-center gap-2">
                  <button
                    hlmBtn
                    type="button"
                    variant="default"
                    size="sm"
                    data-testid="pr-create-submit"
                    [disabled]="
                      submitting() ||
                      prep.blockers.length > 0 ||
                      prep.headRef === null ||
                      title().trim().length === 0
                    "
                    (click)="submit(prep)"
                  >
                    @if (submitting()) {
                      @if (prep.needsPush) {
                        <ng-container i18n>Pushing &amp; creating…</ng-container>
                      } @else {
                        <ng-container i18n>Creating…</ng-container>
                      }
                    } @else if (prep.needsPush) {
                      <ng-container i18n>Push &amp; create</ng-container>
                    } @else {
                      <ng-container i18n>Create pull request</ng-container>
                    }
                  </button>
                </div>
              </div>
            }
          }
        }
      }
    </div>

    <!-- Confirm Redraft Modal -->
    <hlm-alert-dialog
      [state]="confirmRedraft() ? 'open' : 'closed'"
      (stateChanged)="onRedraftDialogState($event)"
    >
      <hlm-alert-dialog-content
        *hlmAlertDialogPortal="let ctx"
        data-testid="pr-create-redraft-dialog"
      >
        <hlm-alert-dialog-header>
          <h2 hlmAlertDialogTitle class="text-lg font-medium" i18n>
            Replace edits with a fresh draft?
          </h2>
          <p hlmAlertDialogDescription i18n>
            Your current title and description edits will be replaced by a new Agent draft.
          </p>
        </hlm-alert-dialog-header>
        <hlm-alert-dialog-footer>
          <button
            hlmAlertDialogCancel
            data-testid="pr-create-redraft-cancel"
            (click)="confirmRedraft.set(false)"
            i18n
          >
            Cancel
          </button>
          <button
            hlmAlertDialogAction
            data-testid="pr-create-redraft-confirm"
            (click)="confirmAndRedraft()"
            i18n
          >
            Redraft
          </button>
        </hlm-alert-dialog-footer>
      </hlm-alert-dialog-content>
    </hlm-alert-dialog>
  `,
})
export class PrCreateForm {
  private readonly runtime = inject(EffectRuntime);
  private readonly destroyRef = inject(DestroyRef);
  private readonly keymap = inject(Keymap);

  readonly projectId = input.required<ProjectId>();
  readonly worktreePath = input<string | null>(null);
  readonly cancelled = output<void>();
  readonly created = output<PullRequestSummary>();

  protected readonly prepState = signal<PrepState>({ status: 'loading' });
  protected readonly title = signal('');
  protected readonly body = signal('');
  protected readonly draft = signal(false);
  protected readonly userEdited = signal(false);
  protected readonly drafting = signal(false);
  protected readonly draftFailed = signal(false);
  protected readonly pendingDraft = signal<DraftPullRequestResult | null>(null);
  protected readonly submitting = signal(false);
  protected readonly confirmRedraft = signal(false);

  private prepController: AbortController | null = null;
  private draftController: AbortController | null = null;

  constructor() {
    effect(() => {
      this.projectId();
      this.worktreePath();
      untracked(() => {
        this.title.set('');
        this.body.set('');
        this.userEdited.set(false);
        this.pendingDraft.set(null);
        this.draftFailed.set(false);
        this.loadPreparation();
      });
    });

    effect((onCleanup) => {
      if (!this.confirmRedraft()) return;
      const release = this.keymap.pushModal({
        onEscape: () => this.confirmRedraft.set(false),
      });
      onCleanup(release);
    });

    this.destroyRef.onDestroy(() => {
      this.prepController?.abort();
      this.draftController?.abort();
    });
  }

  protected loadPreparation(baseRefOverride?: string): void {
    this.prepController?.abort();
    this.draftController?.abort();
    const controller = new AbortController();
    this.prepController = controller;
    const pid = this.projectId();
    const wt = this.worktreePath();

    this.prepState.set({ status: 'loading' });

    void this.runtime
      .run(
        DesktopApi.use((api) =>
          api['PullRequests.prepareCreate']({
            projectId: pid,
            ...(wt !== null ? { worktreePath: wt } : {}),
            ...(baseRefOverride !== undefined ? { baseRef: baseRefOverride } : {}),
          }),
        ),
        { signal: controller.signal },
      )
      .then((exit) => {
        if (controller.signal.aborted) return;
        if (Exit.isSuccess(exit)) {
          const prep = exit.value;
          this.prepState.set({ status: 'loaded', value: prep });
          if (!this.userEdited() && prep.templateBody !== null && this.body().length === 0) {
            this.body.set(prep.templateBody);
          }
          if (
            baseRefOverride === undefined &&
            prep.headRef !== null &&
            prep.aheadCount > 0 &&
            !prep.blockers.some(
              (b) => b.reason === 'DetachedHead' || b.reason === 'ZeroCommitsAhead',
            )
          ) {
            void this.maybeAutoDraft(prep);
          }
        } else {
          this.prepState.set({
            status: 'failed',
            detail: $localize`Could not inspect branch for Pull request creation.`,
          });
        }
      });
  }

  private async maybeAutoDraft(prep: CreatePrPreparation): Promise<void> {
    const settingsExit = await this.runtime.run(
      DesktopApi.use((api) => api['Settings.get']()).pipe(Effect.option),
    );
    if (this.prepController?.signal.aborted) return;
    const enabled =
      Exit.isSuccess(settingsExit) && settingsExit.value._tag === 'Some'
        ? (settingsExit.value.value.pullRequests?.draftingEnabled ??
          DEFAULT_PULL_REQUEST_SETTINGS.draftingEnabled)
        : DEFAULT_PULL_REQUEST_SETTINGS.draftingEnabled;
    if (enabled) {
      this.runDraft(prep.baseRef);
    }
  }

  private runDraft(baseRef: string): void {
    this.draftController?.abort();
    const controller = new AbortController();
    this.draftController = controller;
    const pid = this.projectId();
    const wt = this.worktreePath();

    this.drafting.set(true);
    this.draftFailed.set(false);
    this.pendingDraft.set(null);

    void this.runtime
      .run(
        DesktopApi.use((api) =>
          api['PullRequests.draftCreate']({
            projectId: pid,
            ...(wt !== null ? { worktreePath: wt } : {}),
            baseRef,
          }),
        ),
        { signal: controller.signal },
      )
      .then((exit) => {
        if (controller.signal.aborted) return;
        this.drafting.set(false);
        if (Exit.isSuccess(exit)) {
          if (this.userEdited()) {
            this.pendingDraft.set(exit.value);
          } else {
            this.title.set(exit.value.title);
            this.body.set(exit.value.body);
          }
        } else {
          this.draftFailed.set(true);
        }
      });
  }

  protected onBaseChange(next: string | readonly string[] | null | undefined): void {
    const baseRef = typeof next === 'string' ? next : next?.[0];
    if (!baseRef) return;
    this.loadPreparation(baseRef);
  }

  protected onTitleInput(value: string): void {
    this.userEdited.set(true);
    this.title.set(value);
  }

  protected onBodyInput(value: string): void {
    this.userEdited.set(true);
    this.body.set(value);
  }

  protected applyPendingDraft(draft: DraftPullRequestResult): void {
    this.title.set(draft.title);
    this.body.set(draft.body);
    this.pendingDraft.set(null);
    this.userEdited.set(false);
  }

  protected onRedraftClick(): void {
    const state = this.prepState();
    if (state.status !== 'loaded') return;
    if (this.userEdited()) {
      this.confirmRedraft.set(true);
      return;
    }
    this.runDraft(state.value.baseRef);
  }

  protected confirmAndRedraft(): void {
    this.confirmRedraft.set(false);
    const state = this.prepState();
    if (state.status !== 'loaded') return;
    this.userEdited.set(false);
    this.runDraft(state.value.baseRef);
  }

  protected onRedraftDialogState(state: 'open' | 'closed'): void {
    if (state === 'closed') this.confirmRedraft.set(false);
  }

  protected submit(prep: CreatePrPreparation): void {
    if (prep.headRef === null || this.submitting()) return;
    const pid = this.projectId();
    const wt = this.worktreePath();
    this.submitting.set(true);

    void this.runtime
      .run(
        DesktopApi.use((api) =>
          api['PullRequests.create']({
            projectId: pid,
            ...(wt !== null ? { worktreePath: wt } : {}),
            title: this.title().trim(),
            body: this.body(),
            baseRef: prep.baseRef,
            headRef: prep.headRef ?? '',
            draft: this.draft(),
            pushFirst: prep.needsPush,
          }),
        ),
      )
      .then((exit) => {
        this.submitting.set(false);
        if (Exit.isSuccess(exit)) {
          this.created.emit(exit.value);
          return;
        }
        toast.error($localize`Could not create Pull request.`);
      });
  }
}
