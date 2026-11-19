import { Component, input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, Queue, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AssetHandle,
  AssetsError,
  AssetsRpcs,
  MAX_ASSET_BYTES,
} from '../../../shared/assets/assets.rpc';
import {
  DEVICE_SCOPE_HEADER,
  DeviceId,
  DevicesRpcs,
  type DeviceConnection,
} from '../../../shared/devices/devices.rpc';
import type { ImagePart } from '../../../shared/sessions/sessions.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DeviceScopeDirective } from '../../core/device-scope.directive';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { RemoteDevices } from '../../core/remote-devices';
import { MessageImages } from './message-images';

const studio = DeviceId.make('device-studio');

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const pngBase64 = (width = 10, height = 10) =>
  btoa(
    String.fromCharCode(
      0x89,
      ...ascii('PNG\r\n'),
      0x1a,
      0x0a,
      ...u32be(13),
      ...ascii('IHDR'),
      ...u32be(width),
      ...u32be(height),
      0,
      0,
      0,
      0,
      0,
    ),
  );

const online: DeviceConnection = {
  id: studio,
  name: 'Studio PC',
  status: { _tag: 'Online', name: 'Studio PC' },
};
const offline: DeviceConnection = { id: studio, name: 'Studio PC', status: { _tag: 'Offline' } };

/** An Image as a Remote device sends it: no bytes, a handle to fetch them with. */
const remoteImage = (handle: string, size = 30): ImagePart => ({
  _tag: 'image',
  mimeType: 'image/png',
  data: '',
  asset: { size, handle: AssetHandle.make(handle) },
});

interface Served {
  /** Every `Assets.read`, as the handle and the Device it named. */
  readonly reads: Array<readonly [string, string | undefined]>;
  /** The bytes by handle; a handle missing here fails as an Offline Device does. */
  readonly bytes: Map<string, string>;
  readonly connections: Queue.Queue<ReadonlyArray<DeviceConnection>>;
}

const layer = (served: Served) =>
  makeDesktopTestLayer(
    Layer.mergeAll(
      DevicesRpcs.toLayer({
        'Devices.local': () => Effect.die('unused'),
        'Devices.rename': () => Effect.die('unused'),
        'Devices.setHosting': () => Effect.die('unused'),
        'Devices.watch': () => Stream.die('unused'),
        'Devices.nearby': () => Stream.die('unused'),
        'Devices.startPairing': () => Effect.die('unused'),
        'Devices.cancelPairing': () => Effect.die('unused'),
        'Devices.pair': () => Effect.die('unused'),
        'Devices.check': () => Effect.die('unused'),
        'Devices.connections': () => Stream.fromQueue(served.connections),
        'Devices.connect': () => Effect.void,
        'Devices.unpair': () => Effect.die('unused'),
        'Devices.viewers': () => Stream.make([]),
        'Devices.disconnect': () => Effect.die('unused'),
        'Devices.setAllowAgents': () => Effect.die('unused'),
      }),
      AssetsRpcs.toLayer({
        'Assets.read': ({ handle }, { headers }) =>
          Effect.suspend(() => {
            served.reads.push([handle, headers[DEVICE_SCOPE_HEADER]]);
            const data = served.bytes.get(handle);
            if (data === 'NotFound') {
              return Effect.fail(new AssetsError({ reason: 'NotFound', detail: 'gone' }));
            }
            return data === undefined
              ? Effect.fail(new AssetsError({ reason: 'Unavailable', detail: 'offline' }))
              : Effect.succeed({ data });
          }),
      }),
    ),
  );

@Component({
  selector: 'app-remote-images-host',
  imports: [DeviceScopeDirective, MessageImages],
  template: `
    <div [appDeviceScope]="device">
      <app-message-images [images]="images()" data-testid="message-images" />
    </div>
  `,
})
class RemoteImagesHost {
  readonly images = input.required<ReadonlyArray<ImagePart>>();
  protected readonly device = studio;
}

const makeServed = (bytes: Record<string, string>): Served => ({
  reads: [],
  bytes: new Map(Object.entries(bytes)),
  connections: Effect.runSync(Queue.unbounded<ReadonlyArray<DeviceConnection>>()),
});

const mount = (served: Served, images: ReadonlyArray<ImagePart>) => {
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: layer(served) }],
  });
  Queue.offerUnsafe(served.connections, [online]);
  const fixture = TestBed.createComponent(RemoteImagesHost);
  fixture.componentRef.setInput('images', images);
  fixture.detectChanges();
  return fixture;
};

const thumbnails = (fixture: ComponentFixture<unknown>) => {
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return [...root.querySelectorAll('[data-testid="image-thumbnail"] img')].map((img) =>
    img.getAttribute('src'),
  );
};

const placeholders = (fixture: ComponentFixture<unknown>) => {
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return [...root.querySelectorAll('[data-testid="image-placeholder"]')].map((el) => ({
    issue: el.getAttribute('data-issue'),
    text: el.textContent?.trim(),
  }));
};

describe('Images of a Remote Session', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('are fetched from their Device when shown', async () => {
    const served = makeServed({ h1: pngBase64() });
    const fixture = mount(served, [remoteImage('h1')]);

    await vi.waitFor(() =>
      expect(thumbnails(fixture)).toEqual([`data:image/png;base64,${pngBase64()}`]),
    );
    expect(served.reads).toEqual([['h1', studio]]);
  });

  it('over 10 MiB show a too-large placeholder and are never fetched', async () => {
    const served = makeServed({});
    const fixture = mount(served, [
      { _tag: 'image', mimeType: 'image/png', data: '', asset: { size: MAX_ASSET_BYTES + 1 } },
    ]);

    await vi.waitFor(() =>
      expect(placeholders(fixture)).toEqual([
        { issue: 'tooLarge', text: 'Image is too large to show' },
      ]),
    );
    expect(served.reads).toEqual([]);
  });

  it('that cannot be fetched show a placeholder, and are fetched again when the Device reconnects', async () => {
    const served = makeServed({});
    const fixture = mount(served, [remoteImage('h1')]);

    await vi.waitFor(() =>
      expect(placeholders(fixture)).toEqual([
        { issue: 'unavailable', text: 'Image not available right now' },
      ]),
    );

    served.bytes.set('h1', pngBase64());
    Queue.offerUnsafe(served.connections, [offline]);
    const devices = TestBed.inject(RemoteDevices);
    await vi.waitFor(() => expect(devices.isOnline(studio)).toBe(false));
    fixture.detectChanges();
    Queue.offerUnsafe(served.connections, [online]);

    await vi.waitFor(() =>
      expect(thumbnails(fixture)).toEqual([`data:image/png;base64,${pngBase64()}`]),
    );
    expect(served.reads.length).toBe(2);
  });

  it('a Device no longer has show a placeholder too', async () => {
    const served = makeServed({ h1: 'NotFound' });
    const fixture = mount(served, [remoteImage('h1')]);

    await vi.waitFor(() =>
      expect(placeholders(fixture)).toEqual([
        { issue: 'unavailable', text: 'Image not available right now' },
      ]),
    );
  });

  it('are kept in memory: showing one again does not fetch it again', async () => {
    const served = makeServed({ h1: pngBase64() });
    const first = mount(served, [remoteImage('h1')]);
    await vi.waitFor(() => expect(thumbnails(first)).toHaveLength(1));

    const again = TestBed.createComponent(RemoteImagesHost);
    again.componentRef.setInput('images', [remoteImage('h1')]);
    again.detectChanges();
    await vi.waitFor(() => expect(thumbnails(again)).toHaveLength(1));
    expect(served.reads).toEqual([['h1', studio]]);
  });
});
