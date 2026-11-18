import { Injectable, type Signal } from '@angular/core';
import type { Effect } from 'effect';
import { RpcClient } from 'effect/rpc';
import { DEVICE_SCOPE_HEADER, type DeviceId } from '../../shared/devices/devices.rpc';

/**
 * Runs `effect` for a Device: its Device-scoped calls name it in `DEVICE_SCOPE_HEADER` and main routes them there.
 * `undefined` is the Local device (the effect is left as it is).
 */
export const onDevice =
  (device: DeviceId | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    device === undefined
      ? effect
      : RpcClient.withHeaders(effect, { [DEVICE_SCOPE_HEADER]: device });

/** The Device a part of the window is about; `undefined` for the Local device. Provided by `DeviceScopeDirective`. */
@Injectable()
export class DeviceScope {
  private source: Signal<DeviceId | undefined> | undefined;

  /** The Device now; reading it in a computed follows it. */
  device(): DeviceId | undefined {
    return this.source?.();
  }

  bind(source: Signal<DeviceId | undefined>): void {
    this.source = source;
  }
}
