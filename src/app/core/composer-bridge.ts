import { Injectable, signal } from '@angular/core';
import type { BrowserConsoleError, PickedElement } from '../../shared/browser/browser.rpc';
import type { SessionId } from '../../shared/sessions/sessions.rpc';

export interface ComposerImageAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly data: string;
}

export type ComposerBridgeItem =
  | { readonly kind: 'image'; readonly image: ComposerImageAttachment }
  | { readonly kind: 'text'; readonly text: string };

/** Formats a picked DOM element from the embedded Browser into a structured Composer snippet. */
export const formatPickedElement = (element: PickedElement): string => {
  const lines: Array<string> = [
    `Selected element (\`<${element.tagName}>\`, \`${element.selector}\`):`,
  ];
  if (element.text !== '') {
    lines.push(`Text: ${element.text}`);
  }
  if (element.htmlExcerpt !== '') {
    const fence = element.htmlExcerpt.includes('```') ? '~~~~html' : '```html';
    const endFence = fence.startsWith('~~~~') ? '~~~~' : '```';
    lines.push(fence, element.htmlExcerpt, endFence);
  }
  return lines.join('\n');
};

/** Formats recent console and network failures from the embedded Browser into a concise Composer summary. */
export const formatConsoleErrors = (errors: ReadonlyArray<BrowserConsoleError>): string => {
  const lines = ['Browser errors:'];
  for (const entry of errors) {
    const kindLabel = entry.kind === 'network' ? '[network]' : '[console]';
    const message =
      entry.message.length > 300 ? `${entry.message.slice(0, 297)}...` : entry.message;
    const location = entry.url !== undefined && entry.url !== '' ? ` (${entry.url})` : '';
    lines.push(`- ${kindLabel} ${message}${location}`);
  }
  return lines.join('\n');
};

/**
 * Root seam bridging Browser captures (screenshots, picked elements, console/network errors) into the active
 * Session's Composer without cross-feature imports.
 */
@Injectable({ providedIn: 'root' })
export class ComposerBridge {
  private readonly _pending = signal<ReadonlyMap<SessionId, ReadonlyArray<ComposerBridgeItem>>>(
    new Map(),
  );

  readonly pending = this._pending.asReadonly();

  pendingFor(sessionId: SessionId): ReadonlyArray<ComposerBridgeItem> {
    return this._pending().get(sessionId) ?? [];
  }

  attachImage(sessionId: SessionId, image: ComposerImageAttachment): void {
    this.enqueue(sessionId, { kind: 'image', image });
  }

  attachText(sessionId: SessionId, text: string): void {
    if (text === '') return;
    this.enqueue(sessionId, { kind: 'text', text });
  }

  attachPickedElement(sessionId: SessionId, element: PickedElement): void {
    this.attachText(sessionId, formatPickedElement(element));
  }

  attachConsoleErrors(sessionId: SessionId, errors: ReadonlyArray<BrowserConsoleError>): void {
    if (errors.length === 0) return;
    this.attachText(sessionId, formatConsoleErrors(errors));
  }

  consume(sessionId: SessionId): ReadonlyArray<ComposerBridgeItem> {
    const current = this._pending().get(sessionId);
    if (current === undefined || current.length === 0) return [];
    this._pending.update((map) => {
      const next = new Map(map);
      next.delete(sessionId);
      return next;
    });
    return current;
  }

  private enqueue(sessionId: SessionId, item: ComposerBridgeItem): void {
    this._pending.update((map) => {
      const next = new Map(map);
      const existing = next.get(sessionId) ?? [];
      next.set(sessionId, [...existing, item]);
      return next;
    });
  }
}
