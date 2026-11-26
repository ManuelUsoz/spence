import { Injectable } from '@angular/core';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';

/** Deduplicates per-Session model limitation toasts across `SessionView` tab switches. */
@Injectable({ providedIn: 'root' })
export class ModelsLimitationNotices {
  private readonly shown = new Set<string>();

  /** Returns `true` the first time `(sessionId, note)` is seen in this app session. */
  markShown(sessionId: SessionId, note: string): boolean {
    const key = `${sessionId}\0${note}`;
    if (this.shown.has(key)) return false;
    this.shown.add(key);
    return true;
  }
}
