import { Injectable, signal } from '@angular/core';
import type { SendingSession } from '../../../shared/messaging/messaging.rpc';

/** Which Session "Send to another Session…" was opened from; `null` while the dialog is closed. */
@Injectable({ providedIn: 'root' })
export class SendToSession {
  private readonly _from = signal<SendingSession | null>(null);

  readonly from = this._from.asReadonly();

  open(from: SendingSession): void {
    this._from.set(from);
  }

  close(): void {
    this._from.set(null);
  }
}
