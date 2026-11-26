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
import { MarkdownView, type MarkdownBlock } from '@ui/markdown';
import type {
  PullRequestDiff,
  PullRequestDiffFile,
  ReviewThread,
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
@Component({
  selector: 'app-pr-diff-view',
  imports: [HlmBadgeImports, MarkdownView],
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
                              class="flex whitespace-pre"
                              [class]="lineClass(line)"
                              data-testid="pr-diff-line"
                            >
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

                            @if (line.threads.length > 0) {
                              <div
                                class="border-border/60 bg-muted/30 my-1 space-y-2 border-y px-4 py-2.5 font-sans whitespace-normal"
                              >
                                @for (thread of line.threads; track thread.id) {
                                  <div
                                    class="border-border/60 bg-background rounded-md border p-2.5"
                                    [attr.data-testid]="'pr-diff-inline-thread-' + thread.id"
                                  >
                                    <div class="mb-1.5 flex items-center gap-2 text-xs">
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
  readonly openLink = output<string>();

  protected readonly resolvedLabel = $localize`Resolved`;
  protected readonly unresolvedLabel = $localize`Unresolved`;

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
      return;
    }
    next.add(file.path);
    this.expandedPaths.set(next);

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
}
