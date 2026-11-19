import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_SCOPE_HEADER,
  DeviceId,
  DevicesRpcs,
  type DeviceConnection,
} from '../../../shared/devices/devices.rpc';
import { AgentId } from '../../../shared/agents/agents.rpc';
import { ProjectId, ProjectsRpcs, type Project } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  type SessionSummary,
} from '../../../shared/sessions/sessions.rpc';
import { TabsRpcs } from '../../../shared/tabs/tabs.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM } from '../../core/keymap';
import { Tabs } from '../../core/tabs';
import { AppSidebar } from './app-sidebar';
import { TopBar } from './top-bar';

const studio = DeviceId.make('device-studio');

const project = (id: string, name: string, lastUsedAt: number): Project => ({
  id: ProjectId.make(id),
  name,
  path: `/work/${name}`,
  addedAt: 1,
  lastUsedAt,
  settings: {},
  folderMissing: false,
});

/** The same folder name on two Devices: two Projects, never one. */
const localApp = project('local-app', 'app', 20);
const localDocs = project('local-docs', 'docs', 10);
const remoteApp = project('remote-app', 'app', 30);

const remoteSession: SessionSummary = {
  id: SessionId.make('remote-session'),
  agentId: AgentId.make('fake'),
  title: { user: 'Render the site', autoIsPlaceholder: false },
  lastActivityAt: Date.now(),
};

const online: ReadonlyArray<DeviceConnection> = [
  { id: studio, name: 'Studio PC', status: { _tag: 'Online', name: 'Studio PC' } },
];

interface Served {
  readonly connections: ReadonlyArray<DeviceConnection>;
  /** The Device each `Session.list` was asked of (`local` for none), with the Project. */
  readonly lists: Array<readonly [string, ProjectId]>;
  /** What the Remote Session calls for, if anything. */
  readonly remoteAttention?: SessionSummary['attention'];
}

const deviceOf = (headers: Readonly<Record<string, string | undefined>>): string =>
  headers[DEVICE_SCOPE_HEADER] ?? 'local';

const die = () => Effect.die('unused');

const layer = (served: Served) =>
  makeDesktopTestLayer(
    Layer.mergeAll(
      DevicesRpcs.toLayer({
        'Devices.local': die,
        'Devices.rename': die,
        'Devices.setHosting': die,
        'Devices.watch': () => Stream.die('unused'),
        'Devices.nearby': () => Stream.die('unused'),
        'Devices.startPairing': die,
        'Devices.cancelPairing': die,
        'Devices.pair': die,
        'Devices.check': die,
        'Devices.connections': () => Stream.concat(Stream.make(served.connections), Stream.never),
        'Devices.connect': () => Effect.void,
        'Devices.unpair': die,
        'Devices.setAllowAgents': die,
      }),
      ProjectsRpcs.toLayer({
        'Projects.list': (_payload, { headers }) =>
          Effect.succeed(deviceOf(headers) === studio ? [remoteApp] : [localApp, localDocs]),
        'Projects.add': die,
        'Projects.rename': die,
        'Projects.remove': die,
        'Projects.locate': die,
        'Projects.addFolder': () => Effect.die('unused'),
        'Projects.locateFolder': () => Effect.die('unused'),
        'Projects.check': die,
        'Projects.setSettings': die,
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => Stream.never,
        'Session.list': ({ projectId }, { headers }) =>
          Effect.sync(() => {
            served.lists.push([deviceOf(headers), projectId]);
            return deviceOf(headers) === studio && projectId === remoteApp.id
              ? [
                  served.remoteAttention === undefined
                    ? remoteSession
                    : { ...remoteSession, attention: served.remoteAttention },
                ]
              : [];
          }),
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
        'Session.retryAgent': () => Effect.void,
        'Session.loginAgent': () => Effect.void,
        'Session.openAgentLog': () => Effect.void,
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
        'Session.prepareHandoff': die,
        'Session.revalidateHandoff': die,
        'Session.executeHandoff': die,
        'Session.listHandoffAttempts': die,
      }),
      TabsRpcs.toLayer({
        'Tabs.restore': () => Effect.succeed({ tabs: [] }),
        'Tabs.update': () => Effect.void,
        'Tabs.activations': () => Stream.empty,
      }),
    ),
  );

@Component({
  selector: 'app-remote-projects-host',
  imports: [AppSidebar, TopBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-sidebar /><app-top-bar />`,
})
class Host {}

const mount = (served: Served): ComponentFixture<Host> => {
  TestBed.configureTestingModule({
    providers: [
      { provide: DESKTOP_LAYER, useValue: layer(served) },
      { provide: KEYMAP_PLATFORM, useValue: 'other' },
    ],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return fixture;
};

/** The switcher opens in an overlay outside the component. */
const all = (fixture: ComponentFixture<Host>, testId: string): HTMLElement[] => {
  fixture.detectChanges();
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
};

const texts = (fixture: ComponentFixture<Host>, testId: string): string[] =>
  all(fixture, testId).map((element) => element.textContent?.trim() ?? '');

const click = (fixture: ComponentFixture<Host>, testId: string, index = 0): void => {
  const element = all(fixture, testId)[index];
  if (element === undefined) throw new Error(`no ${testId} #${index}`);
  element.click();
  fixture.detectChanges();
};

describe('Projects grouped by Device', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('lists the Local device first, then each connected Remote device, never merging Projects', async () => {
    const fixture = mount({ connections: online, lists: [] });
    await vi.waitFor(() => expect(texts(fixture, 'current-project')[0]).toContain('app'));

    click(fixture, 'current-project');
    await vi.waitFor(() =>
      expect(texts(fixture, 'project-group-name')).toEqual(['This Device', 'Studio PC']),
    );
    expect(texts(fixture, 'project-option-name')).toEqual(['app', 'docs', 'app']);
    // The Remote device's group carries its status dot; the Local one needs none.
    expect(all(fixture, 'project-group-online')).toHaveLength(1);
  });

  it("shows a Remote Project's Sessions from its Device and opens one as a Remote Session", async () => {
    const served: Served = { connections: online, lists: [] };
    const fixture = mount(served);
    await vi.waitFor(() => expect(texts(fixture, 'current-project')[0]).toContain('app'));

    click(fixture, 'current-project');
    await vi.waitFor(() => expect(all(fixture, 'project-option')).toHaveLength(3));
    click(fixture, 'project-option', 2);

    await vi.waitFor(() => expect(texts(fixture, 'project-device')).toEqual(['Studio PC']));
    expect(served.lists).toContainEqual([studio, remoteApp.id]);
    expect(served.lists).not.toContainEqual(['local', remoteApp.id]);
    await vi.waitFor(() => expect(texts(fixture, 'session-title')).toEqual(['Render the site']));

    click(fixture, 'session-row');
    const tabs = TestBed.inject(Tabs);
    expect(tabs.active()).toMatchObject({ session: remoteSession.id, device: studio });
    await vi.waitFor(() => expect(texts(fixture, 'device-chip')).toEqual(['Studio PC']));
  });

  it('starts a new Session in a Remote Project on its Device', async () => {
    const fixture = mount({ connections: online, lists: [] });
    await vi.waitFor(() => expect(texts(fixture, 'current-project')[0]).toContain('app'));
    click(fixture, 'current-project');
    await vi.waitFor(() => expect(all(fixture, 'project-option')).toHaveLength(3));
    click(fixture, 'project-option', 2);

    click(fixture, 'new-session');

    expect(TestBed.inject(Tabs).active()).toMatchObject({
      session: null,
      projectId: remoteApp.id,
      device: studio,
    });
  });

  it("marks a Remote device's group with the amber dot while one of its Sessions needs you", async () => {
    const fixture = mount({ connections: online, lists: [], remoteAttention: 'needsAnswer' });
    await vi.waitFor(() => expect(texts(fixture, 'current-project')[0]).toContain('app'));

    click(fixture, 'current-project');
    await vi.waitFor(() =>
      expect(texts(fixture, 'project-group-name')).toEqual(['This Device', 'Studio PC']),
    );
    await vi.waitFor(() => expect(all(fixture, 'project-group-attention')).toHaveLength(1));
    const studioGroup = all(fixture, 'project-group')[1];
    expect(studioGroup?.querySelector('[data-testid="project-group-attention"]')).not.toBeNull();
  });

  it('shows no amber dot on a Device whose Sessions need nothing', async () => {
    const fixture = mount({ connections: online, lists: [] });
    await vi.waitFor(() => expect(texts(fixture, 'current-project')[0]).toContain('app'));

    click(fixture, 'current-project');
    await vi.waitFor(() => expect(all(fixture, 'project-option')).toHaveLength(3));
    expect(all(fixture, 'project-group-attention')).toEqual([]);
  });

  it('names no Devices while no Remote device is connected', async () => {
    const fixture = mount({ connections: [], lists: [] });
    await vi.waitFor(() => expect(texts(fixture, 'current-project')[0]).toContain('app'));

    click(fixture, 'current-project');
    await vi.waitFor(() => expect(texts(fixture, 'project-option-name')).toEqual(['app', 'docs']));
    expect(all(fixture, 'project-group')).toEqual([]);
    expect(all(fixture, 'device-chip')).toEqual([]);
  });
});
