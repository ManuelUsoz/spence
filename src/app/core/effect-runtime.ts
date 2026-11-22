import { inject, Injectable, InjectionToken, type OnDestroy } from '@angular/core';
import { ManagedRuntime, type Effect, type Exit, type Layer } from 'effect';
import type { DesktopApi } from './desktop-api';
import type { DesktopBridgeError } from './desktop-error';
import { layerDesktop } from './desktop-layers';
import { DeviceScope, onDevice } from './device-scope';

/**
 * The layer `EffectRuntime` builds `DesktopApi` from: the real client by default. Component specs provide
 * `makeDesktopTestLayer(handlers)` here, so components run against the real contract with in-memory handlers.
 */
export const DESKTOP_LAYER = new InjectionToken<Layer.Layer<DesktopApi, DesktopBridgeError>>(
  'DESKTOP_LAYER',
  { providedIn: 'root', factory: () => layerDesktop },
);

/**
 * The renderer's single Effect runtime.
 *
 * `ManagedRuntime` builds the app layer once and shares it across every run, so
 * layer memoization works and app-lifetime resources are disposed together.
 * Run effects here at the UI boundary; keep domain logic in services.
 *
 * Provided again under a `DeviceScope` (see `DeviceScopeDirective`), it shares the root runtime and runs every effect
 * for that scope's Device: everything a Remote Session's views call reaches its Device, with no Device in their code.
 */
@Injectable({ providedIn: 'root' })
export class EffectRuntime implements OnDestroy {
  private readonly parent = inject(EffectRuntime, { skipSelf: true, optional: true });
  private readonly scope = inject(DeviceScope, { optional: true });
  private readonly runtime: ManagedRuntime.ManagedRuntime<DesktopApi, DesktopBridgeError> =
    this.parent?.runtime ?? ManagedRuntime.make(inject(DESKTOP_LAYER));

  /** Layer build failures (e.g. no desktop bridge) appear in the error channel. Aborting the signal interrupts the effect. */
  run<A, E>(
    effect: Effect.Effect<A, E, DesktopApi>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Exit.Exit<A, E | DesktopBridgeError>> {
    const device = this.scope?.device();
    return this.runtime.runPromiseExit(onDevice(device)(effect), options);
  }

  ngOnDestroy(): void {
    if (this.parent === null) void this.runtime.dispose();
  }
}
