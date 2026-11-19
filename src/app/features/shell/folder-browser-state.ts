import { Injectable, signal } from '@angular/core';
import type { DeviceId } from '../../../shared/devices/devices.rpc';

/** What the folder browser was opened for. */
export interface FolderRequest {
  /** The Remote device whose disk is browsed. */
  readonly device: DeviceId;
  /** What the dialog is for, e.g. "Add a Project on Studio PC". */
  readonly title: string;
  /** Where browsing starts; the Device's home folder when `null`. */
  readonly start: string | null;
}

interface Pending extends FolderRequest {
  readonly resolve: (folder: string | null) => void;
}

/**
 * The in-app folder browser for a Remote device's disk (a Local device keeps the native dialog). `pick` opens it and
 * resolves with the chosen folder's path, or `null` when the user cancels. The shell hosts the dialog.
 */
@Injectable({ providedIn: 'root' })
export class FolderBrowserState {
  private readonly _request = signal<Pending | null>(null);
  readonly request = this._request.asReadonly();

  pick(request: FolderRequest): Promise<string | null> {
    this._request()?.resolve(null);
    return new Promise((resolve) => this._request.set({ ...request, resolve }));
  }

  choose(folder: string): void {
    this.settle(folder);
  }

  cancel(): void {
    this.settle(null);
  }

  private settle(folder: string | null): void {
    const pending = this._request();
    if (pending === null) return;
    this._request.set(null);
    pending.resolve(folder);
  }
}
