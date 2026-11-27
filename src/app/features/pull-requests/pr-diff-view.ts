import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { HlmBadgeImports } from '@ui/badge';
import { HlmButtonImports } from '@ui/button';
import { MarkdownView, type MarkdownBlock } from '@ui/markdown';
import { HlmTextareaImports } from '@ui/textarea';
import type {
  CommentId,
  PullRequestDiff,
  PullRequestDiffFile,
  ReviewId,
  ReviewThread,
  ReviewThreadId,
} from '../../../shared/pull-requests/pull-requests.rpc';
import type { PrRenderClient } from './pr-render-client';
import type {
  HighlightToken,
  RenderedDiffFile,
  RenderedDiffLine,
  WordDiffSegment,
} from './pr-render';

/**
 * Renders the Changed files list and expandable unified diff hunks for a Pull request,
 * offloading Shiki syntax highlighting, word-level diff decoration, Review thread line anchoring,
 * and Remark GFM thread comment parsing to `PrRenderClient` (Web Worker).
 */
export interface DiffCommentSelection {
  readonly path: string;
  readonly side: 'LEFT' | 'RIGHT';
  readonly startLine: number;
  readonly endLine: number;
}

@Component({
  selector: 'app-pr-diff-view',
  imports: [HlmBadgeImports, HlmButtonImports, HlmTextareaImports, MarkdownView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', 'data-testid': 'pr-diff-view' },
  template: `
    <div class="space-y-3">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-sm font-medium" i18n>
          Changed files
          <span class="text-muted-foreground ml-1 font-normal tabular-nums"
            >({{ files().length }})</span
          >
        </h3>
        <div class="flex items-center gap-2 font-mono text-xs tabular-nums">
          <span class="text-diff-add">+{{ totalAdditions() }}</span>
          <span class="text-diff-del">−{{ totalDeletions() }}</span>
        </div>
      </div>

      @if (files().length === 0) {
        <p class="text-muted-foreground text-sm" i18n>No changed files in this diff.</p>
      } @else {
        <div class="space-y-2">
          @for (file of files(); track file.path) {
            @let expanded = isExpanded(file.path);
            @let rendered = renderedFiles().get(file.path) ?? null;
            <section
              class="border-border/60 bg-card overflow-hidden rounded-lg border"
              [attr.data-testid]="'pr-diff-file-' + file.path"
            >
              <button
                type="button"
                class="hover:bg-accent/50 focus-visible:ring-ring flex w-full items-center justify-between gap-3 px-3 py-2 text-left outline-none focus-visible:ring-2"
                [class.bg-accent/30]="activeFilePath() === file.path"
                [attr.aria-expanded]="expanded"
                [attr.data-testid]="'pr-diff-file-toggle-' + file.path"
                (click)="toggleFile(file)"
              >
                <div class="flex min-w-0 items-center gap-2">
                  <span class="text-muted-foreground w-3 shrink-0 text-xs" aria-hidden="true">{{
                    expanded ? '▾' : '▸'
                  }}</span>
                  <span class="truncate font-mono text-xs" data-testid="pr-diff-file-path">
                    @if (file.previousPath) {
                      {{ file.previousPath }} → {{ file.path }}
                    } @else {
                      {{ file.path }}
                    }
                  </span>
                  <span hlmBadge variant="outline" class="shrink-0 text-[10px] capitalize">{{
                    file.status
                  }}</span>
                </div>
                <div class="flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums">
                  <span class="text-diff-add">+{{ file.additions }}</span>
                  <span class="text-diff-del">−{{ file.deletions }}</span>
                </div>
              </button>

              @if (expanded) {
                <div class="border-border/60 border-t">
                  @if (file.noPreviewReason) {
                    <p
                      class="text-muted-foreground px-3 py-2 text-xs"
                      data-testid="pr-diff-no-preview"
                    >
                      {{ file.noPreviewReason }}
                    </p>
                  } @else if (rendered !== null) {
                    @if (rendered.unanchoredThreads.length > 0) {
                      <div class="border-border/60 bg-muted/30 space-y-2 border-b p-3">
                        <p class="text-muted-foreground text-xs font-medium" i18n>
                          Outdated or file-level review threads
                        </p>
                        @for (thread of rendered.unanchoredThreads; track thread.id) {
                          <div
                            class="border-border/60 bg-background rounded-md border p-2.5"
                            [attr.data-testid]="'pr-diff-thread-' + thread.id"
                          >
                            <div class="mb-1.5 flex items-center gap-2 text-xs">
                              @if (thread.line !== null) {
                                <span class="text-muted-foreground font-mono tabular-nums"
                                  >L{{ thread.line }}</span
                                >
                              }
                              @if (thread.isOutdated) {
                                <span hlmBadge variant="outline" class="text-[10px]" i18n
                                  >Outdated</span
                                >
                              }
                              @if (thread.isResolved) {
                                <span hlmBadge variant="secondary" class="text-[10px]" i18n
                                  >Resolved</span
                                >
                              }
                            </div>
                            <div class="space-y-2">
                              @for (comment of thread.comments; track comment.id) {
                                <div class="text-sm">
                                  <div class="text-muted-foreground mb-0.5 text-xs">
                                    <span class="text-foreground font-medium">{{
                                      comment.author.login
                                    }}</span>
                                  </div>
                                  <app-markdown-view
                                    [text]="comment.body"
                                    [precomputedBlocks]="
                                      markdownBlocks().get('thread-' + comment.id) ?? null
                                    "
                                    [isAllowedLink]="isAllowedLink()"
                                    (openLink)="openLink.emit($event)"
                                  />
                                </div>
                              }
                            </div>
                          </div>
                        }
                      </div>
                    }

                    @for (hunk of rendered.hunks; track $index) {
                      <div
                        class="bg-tray text-muted-foreground border-border/60 border-b px-3 py-1 font-mono text-[11px]"
                      >
                        {{ hunk.header }}
                      </div>
                      <div class="overflow-x-auto py-1 font-mono text-xs leading-5">
                        <div class="min-w-max">
                          @for (line of hunk.lines; track $index) {
                            <div
                              class="group flex whitespace-pre"
                              [class]="lineClass(line)"
                              data-testid="pr-diff-line"
                            >
                              @if (canComment() && lineAnchor(line) !== null) {
                                <button
                                  type="button"
                                  class="text-muted-foreground hover:text-foreground hover:bg-accent w-6 shrink-0 text-center opacity-0 transition-opacity select-none group-hover:opacity-100 focus:opacity-100"
                                  title="Comment on line (Shift+click for range)"
                                  i18n-title
                                  data-testid="pr-diff-comment-trigger"
                                  (click)="selectLineForComment(file.path, line, $event)"
                                >
                                  +
                                </button>
                              } @else {
                                <span class="w-6 shrink-0 select-none" aria-hidden="true"></span>
                              }
                              <span
                                class="text-muted-foreground w-10 shrink-0 pr-2.5 text-right tabular-nums select-none"
                                aria-hidden="true"
                                >{{ line.oldLine }}</span
                              >
                              <span
                                class="text-muted-foreground w-10 shrink-0 pr-2.5 text-right tabular-nums select-none"
                                aria-hidden="true"
                                >{{ line.newLine }}</span
                              >
                              <span class="w-3.5 shrink-0 select-none" aria-hidden="true">{{
                                linePrefix(line)
                              }}</span>
                              @if (line.wordDiff !== null) {
                                <span>
                                  @for (seg of line.wordDiff; track $index) {
                                    <span [class]="wordDiffClass(line, seg)">{{ seg.text }}</span>
                                  }
                                </span>
                              } @else if (line.tokens !== null) {
                                <span>
                                  @for (tok of line.tokens; track $index) {
                                    <span [style.color]="tokenColor(tok)">{{ tok.content }}</span>
                                  }
                                </span>
                              } @else {
                                <span>{{ line.content }}</span>
                              }
                            </div>

                            @if (isSelectionEnd(file.path, line)) {
                              @if (commentSelection(); as sel) {
                                <div
                                  class="border-border/60 bg-muted/40 my-1 space-y-2 border-y px-4 py-3 font-sans whitespace-normal"
                                  data-testid="pr-diff-inline-composer"
                                >
                                  <div class="flex items-center justify-between gap-2 text-xs">
                                    <span class="font-mono text-xs">
                                      {{ sel.path }}:L{{
                                        sel.startLine === sel.endLine
                                          ? sel.endLine
                                          : sel.startLine + '–L' + sel.endLine
                                      }}
                                      ({{ sel.side }})
                                    </span>
                                  </div>
                                  <textarea
                                    hlmTextarea
                                    rows="3"
                                    class="w-full text-sm"
                                    placeholder="Write an inline comment…"
                                    i18n-placeholder
                                    data-testid="pr-diff-inline-input"
                                    [value]="inlineDraftBody()"
                                    (input)="inlineDraftBody.set($any($event.target).value)"
                                  ></textarea>
                                  <div class="flex flex-wrap items-center justify-end gap-2">
                                    <button
                                      hlmBtn
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      data-testid="pr-diff-inline-cancel"
                                      (click)="cancelInlineComment()"
                                      i18n
                                    >
                                      Cancel
                                    </button>
                                    @if (supportsPendingReviews()) {
                                      <button
                                        hlmBtn
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        [disabled]="
                                          mutating() || inlineDraftBody().trim().length === 0
                                        "
                                        data-testid="pr-diff-inline-comment-now"
                                        (click)="submitInlineComment(false)"
                                        i18n
                                      >
                                        Comment now
                                      </button>
                                      <button
                                        hlmBtn
                                        type="button"
                                        variant="default"
                                        size="sm"
                                        [disabled]="
                                          mutating() || inlineDraftBody().trim().length === 0
                                        "
                                        data-testid="pr-diff-inline-add-pending"
                                        (click)="submitInlineComment(true)"
                                      >
                                        {{
                                          hasPendingReview() ? addToReviewLabel : startReviewLabel
                                        }}
                                      </button>
                                    } @else {
                                      <button
                                        hlmBtn
                                        type="button"
                                        variant="default"
                                        size="sm"
                                        [disabled]="
                                          mutating() || inlineDraftBody().trim().length === 0
                                        "
                                        data-testid="pr-diff-inline-comment-now"
                                        (click)="submitInlineComment(false)"
                                        i18n
                                      >
                                        Comment
                                      </button>
                                    }
                                  </div>
                                </div>
                              }
                            }

                            @if (line.threads.length > 0) {
                              <div
                                class="border-border/60 bg-muted/30 my-1 space-y-2 border-y px-4 py-2.5 font-sans whitespace-normal"
                              >
                                @for (thread of line.threads; track thread.id) {
                                  <div
                                    class="border-border/60 bg-background rounded-md border p-2.5"
                                    [attr.data-testid]="'pr-diff-inline-thread-' + thread.id"
                                  >
                                    <div
                                      class="mb-1.5 flex items-center justify-between gap-2 text-xs"
                                    >
                                      <div class="flex items-center gap-2">
                                        <span class="text-muted-foreground font-mono"
                                          >{{ thread.path }}:{{ thread.line }}</span
                                        >
                                        @if (thread.isOutdated) {
                                          <span hlmBadge variant="outline" class="text-[10px]" i18n
                                            >Outdated</span
                                          >
                                        }
                                        <span hlmBadge variant="secondary" class="text-[10px]">
                                          {{ thread.isResolved ? resolvedLabel : unresolvedLabel }}
                                        </span>
                                      </div>
                                      @if (supportsThreadResolution() && canResolveThreads()) {
                                        <button
                                          hlmBtn
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          class="h-6 px-2 text-xs"
                                          [disabled]="mutating()"
                                          [attr.data-testid]="'pr-diff-inline-resolve-' + thread.id"
                                          (click)="
                                            resolveThread.emit({
                                              threadId: thread.id,
                                              resolved: !thread.isResolved,
                                            })
                                          "
                                        >
                                          {{ thread.isResolved ? unresolveLabel : resolveLabel }}
                                        </button>
                                      }
                                    </div>
                                    <div class="space-y-2">
                                      @for (comment of thread.comments; track comment.id) {
                                        <div class="text-sm">
                                          <div
                                            class="text-muted-foreground mb-0.5 flex items-center justify-between gap-2 text-xs"
                                          >
                                            <div class="flex items-center gap-1.5">
                                              <span class="text-foreground font-medium">{{
                                                comment.author.login
                                              }}</span>
                                              @if (
                                                pendingReviewId() !== null &&
                                                comment.reviewId === pendingReviewId()
                                              ) {
                                                <span
                                                  hlmBadge
                                                  variant="outline"
                                                  class="text-[10px]"
                                                  i18n
                                                  >Pending</span
                                                >
                                              }
                                            </div>
                                            @if (isOwnComment(comment.author.login)) {
                                              <div class="flex items-center gap-1">
                                                <button
                                                  hlmBtn
                                                  type="button"
                                                  variant="ghost"
                                                  size="sm"
                                                  class="h-5 px-1.5 text-[11px]"
                                                  (click)="
                                                    startEditComment(comment.id, comment.body)
                                                  "
                                                  i18n
                                                >
                                                  Edit
                                                </button>
                                                <button
                                                  hlmBtn
                                                  type="button"
                                                  variant="ghost"
                                                  size="sm"
                                                  class="text-destructive h-5 px-1.5 text-[11px]"
                                                  (click)="
                                                    deleteComment.emit({
                                                      commentId: comment.id,
                                                      label: comment.body.slice(0, 40),
                                                    })
                                                  "
                                                  i18n
                                                >
                                                  Delete
                                                </button>
                                              </div>
                                            }
                                          </div>
                                          @if (editingCommentId() === comment.id) {
                                            <div class="space-y-2">
                                              <textarea
                                                hlmTextarea
                                                rows="2"
                                                class="w-full text-sm"
                                                [value]="editingCommentBody()"
                                                (input)="
                                                  editingCommentBody.set($any($event.target).value)
                                                "
                                              ></textarea>
                                              <div class="flex justify-end gap-1.5">
                                                <button
                                                  hlmBtn
                                                  type="button"
                                                  variant="ghost"
                                                  size="sm"
                                                  (click)="editingCommentId.set(null)"
                                                  i18n
                                                >
                                                  Cancel
                                                </button>
                                                <button
                                                  hlmBtn
                                                  type="button"
                                                  variant="default"
                                                  size="sm"
                                                  [disabled]="
                                                    mutating() ||
                                                    editingCommentBody().trim().length === 0
                                                  "
                                                  (click)="saveEditComment(comment.id)"
                                                  i18n
                                                >
                                                  Save
                                                </button>
                                              </div>
                                            </div>
                                          } @else {
                                            <app-markdown-view
                                              [text]="comment.body"
                                              [precomputedBlocks]="
                                                markdownBlocks().get('thread-' + comment.id) ?? null
                                              "
                                              [isAllowedLink]="isAllowedLink()"
                                              (openLink)="openLink.emit($event)"
                                            />
                                          }
                                        </div>
                                      }
                                    </div>
                                    @if (canComment()) {
                                      <div class="border-border/40 mt-2 border-t pt-2">
                                        @if (replyingThreadId() === thread.id) {
                                          <div class="space-y-1.5">
                                            <textarea
                                              hlmTextarea
                                              rows="2"
                                              class="w-full text-sm"
                                              placeholder="Reply to thread…"
                                              i18n-placeholder
                                              [value]="replyBody()"
                                              (input)="replyBody.set($any($event.target).value)"
                                            ></textarea>
                                            <div class="flex justify-end gap-1.5">
                                              <button
                                                hlmBtn
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                (click)="replyingThreadId.set(null)"
                                                i18n
                                              >
                                                Cancel
                                              </button>
                                              <button
                                                hlmBtn
                                                type="button"
                                                variant="default"
                                                size="sm"
                                                [disabled]="
                                                  mutating() || replyBody().trim().length === 0
                                                "
                                                (click)="submitThreadReply(thread.id)"
                                                i18n
                                              >
                                                Reply
                                              </button>
                                            </div>
                                          </div>
                                        } @else {
                                          <button
                                            hlmBtn
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            class="h-6 px-2 text-xs"
                                            (click)="startReply(thread.id)"
                                            i18n
                                          >
                                            Reply
                                          </button>
                                        }
                                      </div>
                                    }
                                  </div>
                                }
                              </div>
                            }
                          }
                        </div>
                      </div>
                    }

                    @if (file.truncated) {
                      <p
                        class="text-muted-foreground border-border/60 border-t px-3 py-1.5 text-xs"
                        data-testid="pr-diff-truncated"
                        i18n
                      >
                        This file diff is large and has been truncated.
                      </p>
                    }
                  } @else {
                    <p class="text-muted-foreground px-3 py-2 text-xs" i18n>Rendering diff…</p>
                  }
                </div>
              }
            </section>
          }
        </div>
      }
    </div>
  `,
})
export class PrDiffView {
  readonly diff = input.required<PullRequestDiff>();
  readonly threads = input<ReadonlyArray<ReviewThread>>([]);
  readonly renderClient = input.required<PrRenderClient>();
  readonly markdownBlocks = input<ReadonlyMap<string, ReadonlyArray<MarkdownBlock>>>(new Map());
  readonly isAllowedLink = input<(url: string) => boolean>(() => false);
  readonly canComment = input<boolean>(false);
  readonly supportsPendingReviews = input<boolean>(true);
  readonly hasPendingReview = input<boolean>(false);
  readonly pendingReviewId = input<ReviewId | null>(null);
  readonly supportsThreadResolution = input<boolean>(false);
  readonly canResolveThreads = input<boolean>(false);
  readonly viewerLogin = input<string | null>(null);
  readonly mutating = input<boolean>(false);

  readonly openLink = output<string>();
  readonly addInlineComment = output<{
    readonly path: string;
    readonly line: number;
    readonly side: 'LEFT' | 'RIGHT';
    readonly startLine?: number;
    readonly startSide?: 'LEFT' | 'RIGHT';
    readonly body: string;
    readonly pending: boolean;
  }>();
  readonly replyToThread = output<{ readonly threadId: ReviewThreadId; readonly body: string }>();
  readonly editComment = output<{ readonly commentId: CommentId; readonly body: string }>();
  readonly deleteComment = output<{ readonly commentId: CommentId; readonly label: string }>();
  readonly resolveThread = output<{
    readonly threadId: ReviewThreadId;
    readonly resolved: boolean;
  }>();
  readonly activeFileChange = output<string | null>();

  protected readonly resolvedLabel = $localize`Resolved`;
  protected readonly unresolvedLabel = $localize`Unresolved`;
  protected readonly resolveLabel = $localize`Resolve conversation`;
  protected readonly unresolveLabel = $localize`Unresolve conversation`;
  protected readonly addToReviewLabel = $localize`Add to review`;
  protected readonly startReviewLabel = $localize`Start review`;

  protected readonly activeFilePath = signal<string | null>(null);
  protected readonly commentSelection = signal<DiffCommentSelection | null>(null);
  protected readonly inlineDraftBody = signal('');
  protected readonly replyingThreadId = signal<ReviewThreadId | null>(null);
  protected readonly replyBody = signal('');
  protected readonly editingCommentId = signal<CommentId | null>(null);
  protected readonly editingCommentBody = signal('');

  private readonly expandedPaths = signal<ReadonlySet<string>>(new Set());
  protected readonly renderedFiles = signal<ReadonlyMap<string, RenderedDiffFile>>(new Map());
  private renderGeneration = 0;

  protected readonly files = computed(() => this.diff().files);
  protected readonly totalAdditions = computed(() =>
    this.files().reduce((sum, f) => sum + f.additions, 0),
  );
  protected readonly totalDeletions = computed(() =>
    this.files().reduce((sum, f) => sum + f.deletions, 0),
  );

  constructor() {
    effect(() => {
      const currentDiff = this.diff();
      const currentThreads = this.threads();
      const client = this.renderClient();
      const gen = ++this.renderGeneration;

      const initialExpanded = new Set(currentDiff.files.slice(0, 3).map((f) => f.path));
      this.expandedPaths.set(initialExpanded);
      this.renderedFiles.set(new Map());
      const firstPath = currentDiff.files[0]?.path ?? null;
      this.activeFilePath.set(firstPath);
      this.activeFileChange.emit(firstPath);

      for (const file of currentDiff.files) {
        if (!initialExpanded.has(file.path) || file.noPreviewReason !== undefined) continue;
        void this.renderOneFile(client, file, currentThreads, gen);
      }
    });
  }

  protected isExpanded(path: string): boolean {
    return this.expandedPaths().has(path);
  }

  protected toggleFile(file: PullRequestDiffFile): void {
    const next = new Set(this.expandedPaths());
    if (next.has(file.path)) {
      next.delete(file.path);
      this.expandedPaths.set(next);
      if (this.activeFilePath() === file.path) {
        const fallback = next.values().next().value ?? null;
        this.activeFilePath.set(fallback);
        this.activeFileChange.emit(fallback);
      }
      return;
    }
    next.add(file.path);
    this.expandedPaths.set(next);
    this.activeFilePath.set(file.path);
    this.activeFileChange.emit(file.path);

    const already = untracked(() => this.renderedFiles().get(file.path));
    if (already === undefined && file.noPreviewReason === undefined) {
      void this.renderOneFile(this.renderClient(), file, this.threads(), this.renderGeneration);
    }
  }

  private async renderOneFile(
    client: PrRenderClient,
    file: PullRequestDiffFile,
    threads: ReadonlyArray<ReviewThread>,
    gen: number,
  ): Promise<void> {
    const rendered = await client.renderDiffFile(file, threads);
    if (gen !== this.renderGeneration) return;
    this.renderedFiles.update((prev) => {
      const next = new Map(prev);
      next.set(file.path, rendered);
      return next;
    });
  }

  protected lineClass(line: RenderedDiffLine): string {
    if (line.kind === 'added') return 'bg-diff-add/10';
    if (line.kind === 'removed') return 'bg-diff-del/10';
    return '';
  }

  protected linePrefix(line: RenderedDiffLine): string {
    if (line.kind === 'added') return '+';
    if (line.kind === 'removed') return '−';
    return ' ';
  }

  protected wordDiffClass(line: RenderedDiffLine, seg: WordDiffSegment): string {
    if (!seg.changed) return '';
    return line.kind === 'added' ? 'bg-diff-add/25 rounded-xs' : 'bg-diff-del/25 rounded-xs';
  }

  protected tokenColor(tok: HighlightToken): string | null {
    const isDark =
      typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
    return (isDark ? tok.dark : tok.light) ?? null;
  }

  protected lineAnchor(
    line: RenderedDiffLine,
  ): { readonly side: 'LEFT' | 'RIGHT'; readonly lineNumber: number } | null {
    if (line.kind === 'removed') {
      return line.oldLine !== null ? { side: 'LEFT', lineNumber: line.oldLine } : null;
    }
    return line.newLine !== null ? { side: 'RIGHT', lineNumber: line.newLine } : null;
  }

  protected selectLineForComment(path: string, line: RenderedDiffLine, event: MouseEvent): void {
    const anchor = this.lineAnchor(line);
    if (anchor === null) return;
    const prev = this.commentSelection();
    if (event.shiftKey && prev !== null && prev.path === path && prev.side === anchor.side) {
      const startLine = Math.min(prev.startLine, anchor.lineNumber);
      const endLine = Math.max(prev.startLine, anchor.lineNumber);
      this.commentSelection.set({ path, side: anchor.side, startLine, endLine });
      return;
    }
    this.commentSelection.set({
      path,
      side: anchor.side,
      startLine: anchor.lineNumber,
      endLine: anchor.lineNumber,
    });
    this.inlineDraftBody.set('');
  }

  protected isSelectionEnd(path: string, line: RenderedDiffLine): boolean {
    const sel = this.commentSelection();
    if (sel === null || sel.path !== path) return false;
    const anchor = this.lineAnchor(line);
    return anchor !== null && anchor.side === sel.side && anchor.lineNumber === sel.endLine;
  }

  protected cancelInlineComment(): void {
    this.commentSelection.set(null);
    this.inlineDraftBody.set('');
  }

  protected submitInlineComment(pending: boolean): void {
    const sel = this.commentSelection();
    const body = this.inlineDraftBody().trim();
    if (sel === null || body.length === 0) return;
    this.addInlineComment.emit({
      path: sel.path,
      line: sel.endLine,
      side: sel.side,
      ...(sel.startLine !== sel.endLine ? { startLine: sel.startLine, startSide: sel.side } : {}),
      body,
      pending,
    });
    this.commentSelection.set(null);
    this.inlineDraftBody.set('');
  }

  protected startReply(threadId: ReviewThreadId): void {
    this.replyingThreadId.set(threadId);
    this.replyBody.set('');
  }

  protected submitThreadReply(threadId: ReviewThreadId): void {
    const body = this.replyBody().trim();
    if (body.length === 0) return;
    this.replyToThread.emit({ threadId, body });
    this.replyingThreadId.set(null);
    this.replyBody.set('');
  }

  protected isOwnComment(login: string): boolean {
    const viewer = this.viewerLogin();
    return viewer !== null && viewer.toLowerCase() === login.toLowerCase();
  }

  protected startEditComment(commentId: CommentId, body: string): void {
    this.editingCommentId.set(commentId);
    this.editingCommentBody.set(body);
  }

  protected saveEditComment(commentId: CommentId): void {
    const body = this.editingCommentBody().trim();
    if (body.length === 0) return;
    this.editComment.emit({ commentId, body });
    this.editingCommentId.set(null);
  }
}
