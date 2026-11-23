import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentId } from '../../../shared/agents/agents.rpc';
import {
  DEVICE_SCOPE_HEADER,
  DeviceId,
  DevicesRpcs,
  type DeviceConnection,
} from '../../../shared/devices/devices.rpc';
import { MessagingError, MessagingRpcs } from '../../../shared/messaging/messaging.rpc';
import { ProjectId, ProjectsRpcs, type Project } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  type HandoffPreparation,
  type SessionSummary,
} from '../../../shared/sessions/sessions.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM } from '../../core/keymap';
import { SendToSession } from './send-to-session';
import { SendToSessionDialog } from './send-to-session-dialog';

const studio = DeviceId.make('device-studio');
const attic = DeviceId.make('device-attic');

const project = (id: string, name: string): Project => ({
  id: ProjectId.make(id),
  name,
  path: `/work/${name}`,
  addedAt: 1,
  lastUsedAt: 1,
  settings: {},
  folderMissing: false,
});

const localApp = project('local-app', 'app');
const remoteSite = project('remote-site', 'site');

const summary = (id: string, title: string): SessionSummary => ({
  id: SessionId.make(id),
  agentId: AgentId.make('fake'),
  title: { user: title, autoIsPlaceholder: false },
  lastActivityAt: 1,
  status: 'idle',
});

/** The Session the dialog is opened from (Local), and the others it can reach. */
const openSession = summary('local-open', 'Plan the release');
const localOther = summary('local-other', 'Fix the build');
const remoteRender = summary('remote-render', 'Render the site');

const connections: ReadonlyArray<DeviceConnection> = [
  { id: studio, name: 'Studio PC', status: { _tag: 'Online', name: 'Studio PC' } },
  { id: attic, name: 'Attic Mac', status: { _tag: 'Offline' } },
];

interface Served {
  readonly sent: Array<unknown>;
  readonly started: Array<unknown>;
  readonly prepared: Array<string>;
  readonly refuse?: MessagingError;
}

const deviceOf = (headers: Readonly<Record<string, string | undefined>>): string =>
  headers[DEVICE_SCOPE_HEADER] ?? 'local';

const die = () => Effect.die('unused');

const preparation = (text: string): HandoffPreparation => ({
  kind: 'fork',
  endpoint: { sessionId: openSession.id, turnNumber: 1, seq: 4, messageCount: 2 },
  summary: text,
  draftSource: 'transcriptExtract',
  images: [],
  destinations: [],
  defaultDestinationAgentId: AgentId.make('fake'),
});

const layer = (served: Served) =>
  makeDesktopTestLayer(
    Layer.mergeAll(
      DevicesRpcs.toLayer({
        'Devices.local': () =>
          Effect.succeed({
            id: DeviceId.make('device-laptop'),
            name: 'Laptop',
            hosting: false,
            port: null,
          }),
        'Devices.rename': die,
        'Devices.setHosting': die,
        'Devices.watch': () => Stream.die('unused'),
        'Devices.nearby': () => Stream.die('unused'),
        'Devices.startPairing': die,
        'Devices.cancelPairing': die,
        'Devices.pair': die,
        'Devices.check': die,
        'Devices.connections': () => Stream.concat(Stream.make(connections), Stream.never),
        'Devices.connect': () => Effect.void,
        'Devices.unpair': die,
        'Devices.viewers': () => Stream.make([]),
        'Devices.disconnect': () => Effect.die('unused'),
        'Devices.setAllowAgents': die,
      }),
      ProjectsRpcs.toLayer({
        'Projects.list': (_payload, { headers }) =>
          Effect.succeed(deviceOf(headers) === studio ? [remoteSite] : [localApp]),
        'Projects.add': die,
        'Projects.rename': die,
        'Projects.remove': die,
        'Projects.locate': die,
        'Projects.addFolder': die,
        'Projects.locateFolder': die,
        'Projects.check': die,
        'Projects.setSettings': die,
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => Stream.never,
        'Session.list': (_payload, { headers }) =>
          Effect.succeed(deviceOf(headers) === studio ? [remoteRender] : [openSession, localOther]),
        'Session.create': die,
        'Session.setAgent': die,
        'Session.prompt': die,
        'Session.steer': die,
        'Session.enqueue': die,
        'Session.setQueue': die,
        'Session.clearQueue': die,
        'Session.cancel': die,
        'Session.stopAgent': die,
        'Session.rename': die,
        'Session.retryAgent': die,
        'Session.loginAgent': die,
        'Session.openAgentLog': die,
        'Session.answerPermission': die,
        'Session.setOption': die,
        'Session.clearContext': die,
        'Session.compact': die,
        'Session.startEmptyContext': die,
        'Session.archive': die,
        'Session.unarchive': die,
        'Session.delete': die,
        'Session.countWorkers': die,
        'Session.events': () => Stream.die('unused'),
        'Session.getComposer': die,
        'Session.setComposer': die,
        'Session.prepareHandoff': ({ sessionId }, { headers }) =>
          Effect.sync(() => {
            served.prepared.push(`${deviceOf(headers)}/${sessionId}`);
            return preparation('We drafted the changelog.');
          }),
        'Session.revalidateHandoff': die,
        'Session.executeHandoff': die,
        'Session.listHandoffAttempts': die,
      }),
      MessagingRpcs.toLayer({
        'Messaging.send': (input) =>
          served.refuse === undefined
            ? Effect.sync(() => {
                served.sent.push(input);
                return 'started' as const;
              })
            : Effect.fail(served.refuse),
        'Messaging.startSession': (input) =>
          Effect.sync(() => {
            served.started.push(input);
            return SessionId.make('new-session');
          }),
      }),
    ),
  );

const mount = (served: Served): ComponentFixture<SendToSessionDialog> => {
  TestBed.configureTestingModule({
    providers: [
      { provide: DESKTOP_LAYER, useValue: layer(served) },
      { provide: KEYMAP_PLATFORM, useValue: 'other' },
    ],
  });
  const fixture = TestBed.createComponent(SendToSessionDialog);
  fixture.detectChanges();
  TestBed.inject(SendToSession).open({
    sessionId: openSession.id,
    title: 'Plan the release',
    projectName: 'app',
  });
  fixture.detectChanges();
  return fixture;
};

/** The dialog renders in an overlay outside the component. */
const all = (fixture: ComponentFixture<unknown>, testId: string): HTMLElement[] => {
  fixture.detectChanges();
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
};

const texts = (fixture: ComponentFixture<unknown>, testId: string): string[] =>
  all(fixture, testId).map((element) => element.textContent?.replace(/\s+/g, ' ').trim() ?? '');

const click = (fixture: ComponentFixture<unknown>, testId: string, index = 0): void => {
  const element = all(fixture, testId)[index];
  if (element === undefined) throw new Error(`no ${testId} #${index}`);
  element.click();
  fixture.detectChanges();
};

const type = (fixture: ComponentFixture<unknown>, testId: string, text: string): void => {
  const element = all(fixture, testId)[0] as HTMLTextAreaElement | undefined;
  if (element === undefined) throw new Error(`no ${testId}`);
  element.value = text;
  element.dispatchEvent(new Event('input'));
  fixture.detectChanges();
};

const fresh = (refuse?: MessagingError): Served => ({
  sent: [],
  started: [],
  prepared: [],
  ...(refuse === undefined ? {} : { refuse }),
});

describe('Send to another Session', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('lists targets by Device, offline Devices disabled, with a Provenance preview', async () => {
    const fixture = mount(fresh());

    await vi.waitFor(() =>
      expect(texts(fixture, 'send-target-session')).toEqual(['Fix the build', 'Render the site']),
    );
    expect(texts(fixture, 'send-device-name')).toEqual(['This Device', 'Studio PC', 'Attic Mac']);
    expect(texts(fixture, 'send-device-offline')).toEqual(['Offline']);
    const offline = all(fixture, 'send-target-offline');
    expect(offline).toHaveLength(1);
    expect((offline[0] as HTMLButtonElement).disabled).toBe(true);
    await vi.waitFor(() =>
      expect(texts(fixture, 'send-provenance-preview')).toEqual([
        'They will see: From you · Laptop · Plan the release in app',
      ]),
    );
  });

  it('sends to a Session on another Device and closes', async () => {
    const served = fresh();
    const fixture = mount(served);
    await vi.waitFor(() => expect(all(fixture, 'send-target-session')).toHaveLength(2));

    click(fixture, 'send-target-session', 1);
    type(fixture, 'send-text', 'Please render it again');
    click(fixture, 'send-submit');

    await vi.waitFor(() => expect(served.sent).toHaveLength(1));
    expect(served.sent[0]).toEqual({
      from: { sessionId: openSession.id, title: 'Plan the release', projectName: 'app' },
      device: studio,
      sessionId: remoteRender.id,
      text: 'Please render it again',
    });
    await vi.waitFor(() => expect(TestBed.inject(SendToSession).from()).toBeNull());
  });

  it('starts a new Session in a Project, seeded by a reviewed Summary of this Session', async () => {
    const served = fresh();
    const fixture = mount(served);
    await vi.waitFor(() => expect(all(fixture, 'send-target-new')).toHaveLength(2));

    click(fixture, 'send-target-new', 1);
    type(fixture, 'send-text', 'Take over the release notes.');
    click(fixture, 'send-seed');
    await vi.waitFor(() => expect(all(fixture, 'send-summary')).toHaveLength(1));
    expect(served.prepared).toEqual([`local/${openSession.id}`]);
    type(fixture, 'send-summary', 'We drafted the changelog; ship Friday.');
    click(fixture, 'send-submit');

    await vi.waitFor(() => expect(served.started).toHaveLength(1));
    expect(served.started[0]).toEqual({
      from: { sessionId: openSession.id, title: 'Plan the release', projectName: 'app' },
      device: studio,
      projectId: remoteSite.id,
      text: 'Take over the release notes.',
      summary: 'We drafted the changelog; ship Friday.',
    });
  });

  it('says why a send was refused and keeps the dialog open', async () => {
    const fixture = mount(
      fresh(new MessagingError({ reason: 'Offline', detail: 'not connected' })),
    );
    await vi.waitFor(() => expect(all(fixture, 'send-target-session')).toHaveLength(2));

    click(fixture, 'send-target-session', 1);
    type(fixture, 'send-text', 'Hello?');
    click(fixture, 'send-submit');

    await vi.waitFor(() =>
      expect(texts(fixture, 'send-error')).toEqual(['That Device is offline. Nothing was sent.']),
    );
    expect(TestBed.inject(SendToSession).from()).not.toBeNull();
  });
});
