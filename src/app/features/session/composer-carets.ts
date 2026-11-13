import { Injectable } from '@angular/core';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';

export interface ComposerCaret {
  readonly start: number;
  readonly end: number;
}

/** Per-Session Composer caret persistence across Tab switches (`SessionView` destroy/remount). */
@Injectable({ providedIn: 'root' })
export class ComposerCarets {
  private readonly carets = new Map<SessionId, ComposerCaret>();

  save(sessionId: SessionId, caret: ComposerCaret): void {
    this.carets.set(sessionId, caret);
  }

  consume(sessionId: SessionId): ComposerCaret | null {
    const caret = this.carets.get(sessionId) ?? null;
    if (caret !== null) this.carets.delete(sessionId);
    return caret;
  }

  clear(sessionId: SessionId): void {
    this.carets.delete(sessionId);
  }
}
