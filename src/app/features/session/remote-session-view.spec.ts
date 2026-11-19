import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Effect, Layer, Queue, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_SCOPE_HEADER,
  DeviceId,
  DevicesRpcs,
  type DeviceConnection,
} from '../../../shared/devices/devices.rpc';
import { ProjectId } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  TurnId,
  type LiveState,
  type MessagePart,
} from '../../../shared/sessions/sessions.rpc';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DeviceScopeDirective } from '../../core/device-scope.directive';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { SessionView } from './session-view';

const studio = DeviceId.make('device-studio');
const sessionId = SessionId.make('session-remote');
const projectId = ProjectId.make('project-remote');

const live: LiveState = {
  agentStatus: 'ready',
  title: { autoIsPlaceholder: false },
  options: { permissionMode: 'auto' },
  commands: [],
  commandsLoaded: true,
  queue: [],
  canAttachImages: false,
  imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
};

const connections: ReadonlyArray<DeviceConnection> = [
  { id: studio, name: 'Studio PC', status: { _tag: 'Online', name: 'Studio PC' } },
];

interface Served {
  /** The Device each call named (`local` for none), by RPC. */
  readonly devices: Array<readonly [string, string]>;
  readonly prompts: Array<ReadonlyArray<MessagePart>>;
  /** How the Studio PC is connected, as main reports it; Online by default. */
  readonly status?: DeviceConnection['status'];
  /** Every later report of how it is connected. */
  readonly reports?: Queue.Queue<DeviceConnection['status']>;
  /** Devices the window asked to reach again (Retry). */
  readonly connects?: Array<DeviceId>;
}

const deviceOf = (headers: Readonly<Record<string, string | undefined>>): string =>
  headers[DEVICE_SCOPE_HEADER] ?? 'local';

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
        'Devices.connections': () =>
          Stream.concat(
            Stream.make(
              served.status === undefined
                ? connections
                : [{ id: studio, name: 'Studio PC', status: served.status }],
            ),
            served.reports === undefined
              ? Stream.never
              : Stream.fromQueue(served.reports).pipe(
                  Stream.map((status) => [{ id: studio, name: 'Studio PC', status }]),
                ),
          ),
        'Devices.connect': ({ id }) =>
          Effect.sync(() => {
            served.connects?.push(id);
          }),
        'Devices.unpair': () => Effect.die('unused'),
        'Devices.viewers': () => Stream.make([]),
        'Devices.disconnect': () => Effect.die('unused'),
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => Stream.never,
        'Session.list': () => Effect.succeed([]),
        'Session.create': () => Effect.die('unused'),
        'Session.setAgent': () => Effect.die('unused'),
        'Session.prompt': ({ parts }, { headers }) =>
          Effect.sync(() => {
            served.devices.push(['Session.prompt', deviceOf(headers)]);
            served.prompts.push(parts);
            return TurnId.make('turn-1');
          }),
        'Session.steer': () => Effect.die('unused'),
        'Session.enqueue': () => Effect.die('unused'),
        'Session.setQueue': () => Effect.die('unused'),
        'Session.clearQueue': () => Effect.die('unused'),
        'Session.cancel': () => Effect.die('unused'),
        'Session.stopAgent': () => Effect.die('unused'),
        'Session.rename': () => Effect.die('unused'),
        'Session.retryAgent': () => Effect.void,
        'Session.loginAgent': () => Effect.void,
        'Session.openAgentLog': () => Effect.void,
        'Session.answerPermission': () => Effect.die('unused'),
        'Session.setOption': () => Effect.die('unused'),
        'Session.clearContext': () => Effect.die('unused'),
        'Session.compact': () => Effect.die('unused'),
        'Session.startEmptyContext': () => Effect.die('unused'),
        'Session.archive': () => Effect.die('unused'),
        'Session.unarchive': () => Effect.die('unused'),
        'Session.delete': () => Effect.die('unused'),
        'Session.countWorkers': () => Effect.die('unused'),
        'Session.events': (_payload, { headers }) => {
          served.devices.push(['Session.events', deviceOf(headers)]);
          return Stream.concat(Stream.make({ _tag: 'Live' as const, state: live }), Stream.never);
        },
        'Session.getComposer': (_payload, { headers }) =>
          Effect.sync(() => {
            served.devices.push(['Session.getComposer', deviceOf(headers)]);
            return { text: '', images: [] };
          }),
        'Session.setComposer': () => Effect.void,
        'Session.prepareHandoff': () => Effect.die('unused'),
        'Session.revalidateHandoff': () => Effect.die('unused'),
        'Session.executeHandoff': () => Effect.die('unused'),
        'Session.listHandoffAttempts': () => Effect.succeed([]),
      }),
    ),
  );

/** The open Session's views as the shell shows them: inside the Device scope of the active Tab. */
@Component({
  selector: 'app-remote-session-host',
  imports: [DeviceScopeDirective, SessionView],
  template: `
    <div [appDeviceScope]="device()">
      <app-session-view [sessionId]="sessionId" [projectId]="projectId" />
    </div>
  `,
})
class RemoteSessionHost {
  readonly device = input<DeviceId | undefined>(undefined);
  protected readonly sessionId = sessionId;
  protected readonly projectId = projectId;
}

@Component({ selector: 'app-install-offer-stub', template: '' })
class InstallOfferStub {
  readonly agent = input.required<unknown>();
}

const mount = (served: Served, device: DeviceId | undefined) => {
  TestBed.configureTestingModule({
    providers: [
      { provide: DESKTOP_LAYER, useValue: layer(served) },
      { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
    ],
  });
  const fixture = TestBed.createComponent(RemoteSessionHost);
  fixture.componentRef.setInput('device', device);
  fixture.detectChanges();
  return fixture;
};

const composer = (root: HTMLElement) =>
  root.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');

describe('A Remote Session', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('names its Device in the Composer and sends every call to that Device', async () => {
    const served: Served = { devices: [], prompts: [] };
    const fixture = mount(served, studio);
    const root = fixture.nativeElement as HTMLElement;

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(composer(root)?.getAttribute('placeholder')).toBe('Message the Agent on Studio PC');
    });

    const input = composer(root);
    if (input === null) throw new Error('no Composer');
    input.value = 'Hello there';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('[data-testid="send"]')?.click();

    await vi.waitFor(() => expect(served.prompts).toHaveLength(1));
    expect(served.devices).toContainEqual(['Session.events', studio]);
    expect(served.devices).toContainEqual(['Session.prompt', studio]);
    expect(served.devices.filter(([, device]) => device !== studio)).toEqual([]);
  });

  it('is a Local Session with no Device: plain placeholder, calls stay Local', async () => {
    const served: Served = { devices: [], prompts: [] };
    const fixture = mount(served, undefined);
    const root = fixture.nativeElement as HTMLElement;

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(composer(root)?.getAttribute('placeholder')).toBe('Message the Agent');
    });
    expect(served.devices).toContainEqual(['Session.events', 'local']);
  });

  it('stays readable while its Device reconnects: says so, blocks sending, and Retry reaches it', async () => {
    const served: Served = {
      devices: [],
      prompts: [],
      status: { _tag: 'Reconnecting' },
      connects: [],
    };
    const fixture = mount(served, studio);
    const root = fixture.nativeElement as HTMLElement;
    const bar = () => root.querySelector('[data-testid="device-offline-bar"]');

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(bar()?.getAttribute('data-state')).toBe('reconnecting');
    });
    expect(bar()?.textContent).toContain('Reconnecting to Studio PC');
    expect(composer(root)?.disabled).toBe(true);
    expect(root.querySelector('[data-testid="thread"]')).not.toBeNull();

    root.querySelector<HTMLButtonElement>('[data-testid="device-retry"]')?.click();
    await vi.waitFor(() => expect(served.connects).toEqual([studio]));
  });

  it('says when its Device is offline, and blocks sending', async () => {
    const served: Served = { devices: [], prompts: [], status: { _tag: 'Offline' } };
    const fixture = mount(served, studio);
    const root = fixture.nativeElement as HTMLElement;

    await vi.waitFor(() => {
      fixture.detectChanges();
      const bar = root.querySelector('[data-testid="device-offline-bar"]');
      expect(bar?.getAttribute('data-state')).toBe('offline');
      expect(bar?.textContent).toContain('Studio PC is offline');
    });
    expect(composer(root)?.disabled).toBe(true);
  });

  it('shows no notice while its Device is connected', async () => {
    const served: Served = { devices: [], prompts: [] };
    const fixture = mount(served, studio);
    const root = fixture.nativeElement as HTMLElement;

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(composer(root)?.disabled).toBe(false);
    });
    expect(root.querySelector('[data-testid="device-offline-bar"]')).toBeNull();
  });

  it('follows its Device going away and coming back', async () => {
    const reports = Effect.runSync(Queue.unbounded<DeviceConnection['status']>());
    const served: Served = { devices: [], prompts: [], reports };
    const fixture = mount(served, studio);
    const root = fixture.nativeElement as HTMLElement;
    const bar = () => root.querySelector('[data-testid="device-offline-bar"]');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(composer(root)?.disabled).toBe(false);
    });

    Queue.offerUnsafe(reports, { _tag: 'Reconnecting' });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(bar()?.getAttribute('data-state')).toBe('reconnecting');
    });

    Queue.offerUnsafe(reports, { _tag: 'Online', name: 'Studio PC' });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(bar()).toBeNull();
    });
    expect(composer(root)?.disabled).toBe(false);
  });
});
