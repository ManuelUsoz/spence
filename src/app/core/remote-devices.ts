import {
  DestroyRef,
  Injectable,
  type Injector,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Effect, Schedule, Stream } from 'effect';
import type {
  ConnectionStatus,
  DeviceConnection,
  DeviceId,
} from '../../shared/devices/devices.rpc';
import { DesktopApi } from './desktop-api';
import { EffectRuntime } from './effect-runtime';

/** A connected Remote device: its Projects and Sessions can be used from this window. */
export interface OnlineDevice {
  readonly id: DeviceId;
  readonly name: string;
}

const followConnections = (onChange: (connections: ReadonlyArray<DeviceConnection>) => void) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    yield* api['Devices.connections']().pipe(
      Stream.runForEach((connections) => Effect.sync(() => onChange(connections))),
    );
  }).pipe(Effect.retry(Schedule.spaced('1 second')));

const connectDevice = Effect.fnUntraced(function* (id: DeviceId) {
  const api = yield* DesktopApi;
  yield* api['Devices.connect']({ id });
});

/** The Paired devices and their connections, as main keeps them. */
@Injectable({ providedIn: 'root' })
export class RemoteDevices {
  private readonly runtime = inject(EffectRuntime);
  private readonly aborts = new AbortController();
  private readonly _connections = signal<ReadonlyArray<DeviceConnection>>([]);

  readonly connections = this._connections.asReadonly();
  /** The Remote devices connected now, in pairing order. */
  readonly online = computed(
    (): ReadonlyArray<OnlineDevice> =>
      this._connections().flatMap((connection) =>
        connection.status._tag === 'Online'
          ? [{ id: connection.id, name: connection.status.name }]
          : [],
      ),
    {
      equal: (a, b) =>
        a.length === b.length && a.every((d, i) => d.id === b[i]?.id && d.name === b[i]?.name),
    },
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.aborts.abort());
    void this.runtime.run(
      followConnections((connections) => this._connections.set(connections)),
      { signal: this.aborts.signal },
    );
  }

  /** A Paired device's display name; `undefined` for an unknown one. */
  nameOf(id: DeviceId): string | undefined {
    return this._connections().find((connection) => connection.id === id)?.name;
  }

  /** How a Paired device is connected now; `undefined` for an unknown one. */
  statusOf(id: DeviceId): ConnectionStatus['_tag'] | undefined {
    return this._connections().find((connection) => connection.id === id)?.status._tag;
  }

  /** Reaches a Paired device again at once (Retry); resolves once that try is done, however it went. */
  async retry(id: DeviceId): Promise<void> {
    await this.runtime.run(connectDevice(id), { signal: this.aborts.signal });
  }

  isOnline(id: DeviceId): boolean {
    return this.online().some((device) => device.id === id);
  }

  /**
   * Calls `start` for every Remote device that connects, with a signal aborted when it goes (or when `injector` is
   * destroyed): for following something on each connected Device.
   */
  forEachOnline(start: (device: DeviceId, signal: AbortSignal) => void, injector: Injector): void {
    const follows = new Map<DeviceId, AbortController>();
    injector.get(DestroyRef).onDestroy(() => {
      for (const follow of follows.values()) follow.abort();
    });
    effect(
      () => {
        const online = new Set(this.online().map((device) => device.id));
        untracked(() => {
          for (const [device, follow] of follows) {
            if (online.has(device)) continue;
            follow.abort();
            follows.delete(device);
          }
          for (const device of online) {
            if (follows.has(device)) continue;
            const follow = new AbortController();
            follows.set(device, follow);
            start(device, follow.signal);
          }
        });
      },
      { injector },
    );
  }
}
