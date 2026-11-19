import { TestBed } from '@angular/core/testing';
import { Effect, Queue, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { DeviceId, DevicesRpcs, type DeviceConnection } from '../../shared/devices/devices.rpc';
import { makeDesktopTestLayer } from './desktop-layers';
import { DESKTOP_LAYER } from './effect-runtime';
import { RemoteDevices } from './remote-devices';

const studio = DeviceId.make('studio');
const unused = () => Effect.die('unused');

const devices = (connections: Stream.Stream<ReadonlyArray<DeviceConnection>>) => {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: DESKTOP_LAYER,
        useValue: makeDesktopTestLayer(
          DevicesRpcs.toLayer({
            'Devices.local': unused,
            'Devices.rename': unused,
            'Devices.setHosting': unused,
            'Devices.watch': () => Stream.die('unused'),
            'Devices.nearby': () => Stream.die('unused'),
            'Devices.startPairing': unused,
            'Devices.cancelPairing': unused,
            'Devices.pair': unused,
            'Devices.check': unused,
            'Devices.connections': () => connections,
            'Devices.connect': () => Effect.void,
            'Devices.unpair': unused,
          }),
        ),
      },
    ],
  });
  return TestBed.inject(RemoteDevices);
};

describe('RemoteDevices', () => {
  it("follows every change of a Paired device's connection", async () => {
    const changes = Effect.runSync(Queue.unbounded<ReadonlyArray<DeviceConnection>>());
    const report = (status: DeviceConnection['status']) =>
      Queue.offerUnsafe(changes, [{ id: studio, name: 'Studio PC', status }]);
    const state = devices(Stream.fromQueue(changes));

    report({ _tag: 'Online', name: 'Studio PC' });
    await vi.waitFor(() => expect(state.statusOf(studio)).toBe('Online'));
    report({ _tag: 'Reconnecting' });
    await vi.waitFor(() => expect(state.statusOf(studio)).toBe('Reconnecting'));
    report({ _tag: 'Offline' });
    await vi.waitFor(() => expect(state.statusOf(studio)).toBe('Offline'));
    expect(state.isOnline(studio)).toBe(false);
  });
});
