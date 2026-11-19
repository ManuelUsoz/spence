import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Effect, Schedule, Stream } from 'effect';
import type { ConnectedViewer, DeviceId } from '../../shared/devices/devices.rpc';
import { DesktopApi } from './desktop-api';
import { EffectRuntime } from './effect-runtime';

const followViewers = (onChange: (viewers: ReadonlyArray<ConnectedViewer>) => void) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    yield* api['Devices.viewers']().pipe(
      Stream.runForEach((viewers) => Effect.sync(() => onChange(viewers))),
    );
  }).pipe(Effect.retry(Schedule.spaced('1 second')));

const disconnectViewer = Effect.fnUntraced(function* (id: DeviceId) {
  const api = yield* DesktopApi;
  yield* api['Devices.disconnect']({ id });
});

const unpairViewer = Effect.fnUntraced(function* (id: DeviceId) {
  const api = yield* DesktopApi;
  yield* api['Devices.unpair']({ id });
});

/**
 * The Remote devices connected to this Device while it hosts (its viewers), as main keeps them: Settings > Devices
 * lists them, the top bar shows a quiet chip while there is one. `null` until main first answers.
 */
@Injectable({ providedIn: 'root' })
export class HostedViewers {
  private readonly runtime = inject(EffectRuntime);
  private readonly aborts = new AbortController();
  private readonly _viewers = signal<ReadonlyArray<ConnectedViewer> | null>(null);

  readonly viewers = this._viewers.asReadonly();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.aborts.abort());
    void this.runtime.run(
      followViewers((viewers) => this._viewers.set(viewers)),
      { signal: this.aborts.signal },
    );
  }

  /** Closes a viewer's connections; it stays paired and may connect again. */
  async disconnect(id: DeviceId): Promise<void> {
    await this.runtime.run(disconnectViewer(id), { signal: this.aborts.signal });
  }

  /** Forgets a viewer (Unpair): its connections close and it can no longer connect. */
  async unpair(id: DeviceId): Promise<void> {
    await this.runtime.run(unpairViewer(id), { signal: this.aborts.signal });
  }
}
