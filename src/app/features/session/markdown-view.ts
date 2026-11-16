import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { HlmCodeBlockImports } from '@ui/code-block';
import { HlmTableImports } from '@ui/table';
import { isAllowedExternalUrl } from '../../../shared/links/link-policy';
import { markdownBlocks, type MarkdownBlock } from './markdown';

/**
 * Renders one accumulated Agent reply as static Angular templates. Nothing here compiles Agent text or injects HTML:
 * raw HTML is shown literally, only absolute HTTPS links without credentials are actionable, and Markdown images show
 * their alt text without fetching anything.
 */
interface SelectionSnapshot {
  readonly start: number;
  readonly end: number;
}

const textNodesIn = (root: Node): ReadonlyArray<Text> => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Array<Text> = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
};

/** A logical character offset inside `root` for one end of a DOM range. */
const offsetIn = (root: Node, container: Node, offset: number): number => {
  if (container.nodeType === Node.TEXT_NODE) {
    let total = 0;
    for (const node of textNodesIn(root)) {
      if (node === container) return total + offset;
      total += node.data.length;
    }
    return total;
  }
  const before = container.childNodes[offset] ?? null;
  if (before === null)
    return textNodesIn(root).reduce((total, node) => total + node.data.length, 0);
  let total = 0;
  for (const node of textNodesIn(root)) {
    if (before.contains(node)) return total;
    total += node.data.length;
  }
  return total;
};

const rangeAt = (
  root: Node,
  start: number,
  end: number,
): { startNode: Text; startOffset: number; endNode: Text; endOffset: number } | null => {
  const nodes = textNodesIn(root);
  if (nodes.length === 0) return null;
  let total = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  for (const node of nodes) {
    if (node.data.length === 0) continue;
    const next = total + node.data.length;
    if (startNode === null && start < next) {
      startNode = node;
      startOffset = Math.max(0, Math.min(node.data.length, start - total));
    }
    if (endNode === null && end <= next) {
      endNode = node;
      endOffset = Math.max(0, Math.min(node.data.length, end - total));
      break;
    }
    total = next;
  }
  if (startNode === null) {
    const last = nodes.filter((node) => node.data.length > 0).at(-1);
    if (last === undefined) return null;
    startNode = last;
    startOffset = last.data.length;
  }
  if (endNode === null) {
    const last = nodes.filter((node) => node.data.length > 0).at(-1);
    if (last === undefined) return null;
    endNode = last;
    endOffset = last.data.length;
  }
  return { startNode, startOffset, endNode, endOffset };
};

@Component({
  selector: 'app-markdown-view',
  imports: [NgTemplateOutlet, HlmCodeBlockImports, HlmTableImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  preserveWhitespaces: false,
  host: { class: 'block' },
  template: `
    <ng-template #node let-n>
      @switch (n.type) {
        @case ('paragraph') {
          <p class="my-2 first:mt-0 last:mb-0">
            @for (child of n.children; track $index) {
              <ng-container *ngTemplateOutlet="node; context: { $implicit: child }" />
            }
          </p>
        }
        @case ('heading') {
          @switch (n.depth) {
            @case (1) {
              <h1 class="mt-4 mb-2 text-lg font-semibold first:mt-0">
                <ng-container *ngTemplateOutlet="inlineNodes; context: { $implicit: n.children }" />
              </h1>
            }
            @case (2) {
              <h2 class="mt-4 mb-2 text-base font-semibold first:mt-0">
                <ng-container *ngTemplateOutlet="inlineNodes; context: { $implicit: n.children }" />
              </h2>
            }
            @case (3) {
              <h3 class="mt-3 mb-1.5 text-sm font-semibold first:mt-0">
                <ng-container *ngTemplateOutlet="inlineNodes; context: { $implicit: n.children }" />
              </h3>
            }
            @default {
              <h4 class="mt-3 mb-1 text-sm font-semibold first:mt-0">
                <ng-container *ngTemplateOutlet="inlineNodes; context: { $implicit: n.children }" />
              </h4>
            }
          }
        }
        @case ('text') {
          <span>{{ n.value }}</span>
        }
        @case ('emphasis') {
          <em>
            <ng-container *ngTemplateOutlet="inlineNodes; context: { $implicit: n.children }" />
          </em>
        }
        @case ('strong') {
          <strong>
            <ng-container *ngTemplateOutlet="inlineNodes; context: { $implicit: n.children }" />
          </strong>
        }
        @case ('delete') {
          <del>
            <ng-container *ngTemplateOutlet="inlineNodes; context: { $implicit: n.children }" />
          </del>
        }
        @case ('inlineCode') {
          <code class="bg-muted rounded px-1 py-0.5 font-mono text-xs">{{ n.value }}</code>
        }
        @case ('break') {
          <br />
        }
        @case ('link') {
          @if (actionable(n.url)) {
            <a
              class="underline underline-offset-2"
              [href]="n.url"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="markdown-link"
              (click)="onLink($event, n.url)"
              (auxclick)="onLink($event, n.url)"
            >
              <ng-container *ngTemplateOutlet="inlineNodes; context: { $implicit: n.children }" />
            </a>
          } @else {
            <span data-testid="markdown-link-text">
              <ng-container *ngTemplateOutlet="inlineNodes; context: { $implicit: n.children }" />
            </span>
          }
        }
        @case ('image') {
          <span class="text-muted-foreground italic" data-testid="markdown-image">{{
            n.alt !== '' ? n.alt : imageFallback
          }}</span>
        }
        @case ('html') {
          @if (n.block) {
            <pre
              class="bg-muted my-2 overflow-x-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap"
              data-testid="markdown-html"
            ><code>{{ n.value }}</code></pre>
          } @else {
            <code
              class="bg-muted rounded px-1 py-0.5 font-mono text-xs"
              data-testid="markdown-html-inline"
              >{{ n.value }}</code
            >
          }
        }
        @case ('code') {
          <div hlmCodeBlock class="my-3" data-testid="markdown-code">
            <div hlmCodeBlockHeader>
              <span hlmCodeBlockTitle class="font-mono font-normal">{{ n.lang ?? plainText }}</span>
              <div hlmCodeBlockActions>
                <button
                  hlmCodeBlockCopyButton
                  [value]="n.value"
                  copyText="Copy"
                  i18n-copyText
                  copiedText="Copied"
                  i18n-copiedText
                  data-testid="markdown-copy"
                ></button>
              </div>
            </div>
            <pre hlmCodeBlockContent [code]="n.value" [wrap]="true"></pre>
          </div>
        }
        @case ('blockquote') {
          <blockquote class="border-border text-muted-foreground my-3 border-s-2 ps-3">
            @for (child of n.children; track $index) {
              <ng-container *ngTemplateOutlet="node; context: { $implicit: child }" />
            }
          </blockquote>
        }
        @case ('list') {
          @if (n.ordered) {
            <ol class="my-2 list-decimal space-y-1 ps-5" [attr.start]="n.start ?? 1">
              @for (item of n.items; track $index) {
                <li class="[&>p]:my-0">
                  <ng-container *ngTemplateOutlet="listItem; context: { $implicit: item }" />
                </li>
              }
            </ol>
          } @else {
            <ul class="my-2 list-disc space-y-1 ps-5">
              @for (item of n.items; track $index) {
                <li class="[&>p]:my-0">
                  <ng-container *ngTemplateOutlet="listItem; context: { $implicit: item }" />
                </li>
              }
            </ul>
          }
        }
        @case ('table') {
          <div hlmTableContainer class="my-3" data-testid="markdown-table">
            <table hlmTable>
              <thead hlmTHead>
                <tr hlmTr>
                  @for (cell of n.header; track $index; let column = $index) {
                    <th
                      hlmTh
                      [class.text-right]="n.align[column] === 'right'"
                      [class.text-center]="n.align[column] === 'center'"
                    >
                      <ng-container *ngTemplateOutlet="inlineNodes; context: { $implicit: cell }" />
                    </th>
                  }
                </tr>
              </thead>
              <tbody hlmTBody>
                @for (row of n.rows; track $index) {
                  <tr hlmTr>
                    @for (cell of row; track $index; let column = $index) {
                      <td
                        hlmTd
                        [class.text-right]="n.align[column] === 'right'"
                        [class.text-center]="n.align[column] === 'center'"
                      >
                        <ng-container
                          *ngTemplateOutlet="inlineNodes; context: { $implicit: cell }"
                        />
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        @case ('thematicBreak') {
          <hr class="border-border my-4" />
        }
        @case ('unknown') {
          @for (child of n.children; track $index) {
            <ng-container *ngTemplateOutlet="node; context: { $implicit: child }" />
          }
        }
      }
    </ng-template>

    <ng-template #inlineNodes let-nodes>
      @for (child of nodes; track $index) {
        <ng-container *ngTemplateOutlet="node; context: { $implicit: child }" />
      }
    </ng-template>

    <ng-template #listItem let-item>
      @if (item.checked !== null) {
        <input
          type="checkbox"
          class="me-1.5 align-middle"
          [checked]="item.checked === true"
          disabled
          aria-readonly="true"
        />
      }
      @for (child of item.children; track $index) {
        <ng-container *ngTemplateOutlet="node; context: { $implicit: child }" />
      }
    </ng-template>

    @for (block of blocks(); track $index) {
      <ng-container *ngTemplateOutlet="node; context: { $implicit: block }" />
    }
  `,
})
export class MarkdownView {
  readonly text = input.required<string>();
  /** A settled reply is parsed once and cached; a streaming one is reparsed as its accumulated text arrives. */
  readonly settled = input(true);
  readonly openLink = output<string>();

  protected readonly plainText = $localize`Plain text`;
  protected readonly imageFallback = $localize`Image`;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly shownText = signal('');
  private pendingText: string | null = null;
  private scheduled = false;
  private lastSelection: SelectionSnapshot | null = null;
  private readonly observer: MutationObserver;

  protected readonly blocks = computed<ReadonlyArray<MarkdownBlock>>(() =>
    markdownBlocks(this.settled() ? this.text() : this.shownText(), this.settled()),
  );

  constructor() {
    // Streamed deltas arrive in bursts: parse the latest accumulated text once per microtask, never each delta.
    effect(() => {
      const text = this.text();
      if (this.settled()) {
        this.updateShown(text);
        return;
      }
      this.pendingText = text;
      if (this.scheduled) return;
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        const pending = this.pendingText;
        this.pendingText = null;
        if (pending !== null) this.updateShown(pending);
      });
    });

    // Reparsing can replace text nodes (and the Turn ending can move rows): keep a selection the reader made inside
    // this reply anchored to the same logical text instead of letting the DOM update collapse it.
    this.observer = new MutationObserver(() => this.restoreIfLost());
    this.observer.observe(this.host.nativeElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    document.addEventListener('selectionchange', this.trackSelection);
    this.destroyRef.onDestroy(() => {
      this.observer.disconnect();
      document.removeEventListener('selectionchange', this.trackSelection);
    });
  }

  private updateShown(text: string): void {
    const selection = this.captureSelection();
    if (selection !== null) this.lastSelection = selection;
    this.shownText.set(text);
  }

  private readonly trackSelection = (): void => {
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const host = this.host.nativeElement;
    if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) {
      this.lastSelection = null;
      return;
    }
    if (selection.isCollapsed) {
      if (range.startContainer.nodeType === Node.TEXT_NODE && range.startContainer.isConnected) {
        this.lastSelection = null;
      } else if (this.lastSelection !== null) {
        queueMicrotask(() => this.restoreIfLost());
      }
      return;
    }
    const snapshot = this.captureSelection();
    if (snapshot !== null) this.lastSelection = snapshot;
  };

  private restoreIfLost(attempt = 0): void {
    const snapshot = this.lastSelection;
    if (snapshot === null) return;
    const selection = window.getSelection();
    if (selection !== null && selection.rangeCount > 0 && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      if (
        range.startContainer.isConnected &&
        this.host.nativeElement.contains(range.startContainer)
      ) {
        return;
      }
    }
    this.restoreSelection(snapshot);
    if (attempt >= 3 || typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => {
      if (this.lastSelection !== snapshot) return;
      const current = window.getSelection();
      const lost =
        current === null ||
        current.rangeCount === 0 ||
        current.isCollapsed ||
        !current.getRangeAt(0).startContainer.isConnected;
      if (lost) this.restoreIfLost(attempt + 1);
    });
  }

  private captureSelection(): SelectionSnapshot | null {
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const host = this.host.nativeElement;
    if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return null;
    return {
      start: offsetIn(host, range.startContainer, range.startOffset),
      end: offsetIn(host, range.endContainer, range.endOffset),
    };
  }

  private restoreSelection(snapshot: SelectionSnapshot): void {
    const restored = rangeAt(this.host.nativeElement, snapshot.start, snapshot.end);
    if (restored === null) return;
    const range = document.createRange();
    range.setStart(restored.startNode, restored.startOffset);
    range.setEnd(restored.endNode, restored.endOffset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  protected actionable(url: string): boolean {
    return isAllowedExternalUrl(url);
  }

  protected onLink(event: MouseEvent, url: string): void {
    event.preventDefault();
    if (isAllowedExternalUrl(url)) this.openLink.emit(url);
  }
}
