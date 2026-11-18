import { Directive, inject, input } from '@angular/core';
import type { DeviceId } from '../../shared/devices/devices.rpc';
import { DeviceScope } from './device-scope';
import { EffectRuntime } from './effect-runtime';

/**
 * Puts everything inside it on a Device: its `EffectRuntime` runs every effect for `appDeviceScope` (`undefined`: the
 * Local device). Wrap the open Session's views in it; the sidebar and Settings stay outside.
 */
@Directive({
  selector: '[appDeviceScope]',
  providers: [DeviceScope, EffectRuntime],
})
export class DeviceScopeDirective {
  readonly appDeviceScope = input<DeviceId | undefined>(undefined);

  constructor() {
    inject(DeviceScope).bind(this.appDeviceScope);
  }
}
