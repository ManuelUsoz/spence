import { TestBed } from '@angular/core/testing';
import { Effect, Layer, Queue, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { DeviceId } from '../../shared/devices/devices.rpc';
import { ProjectId } from '../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  TurnId,
  type LiveState,
  type SessionChange,
} from '../../shared/sessions/sessions.rpc';
import {
  TabsRpcs,
  type RemoteTabs,
  type RestoredTabs,
  type TabActivation,
} from '../../shared/tabs/tabs.rpc';
import { makeDesktopTestLayer } from './desktop-layers';
import { DESKTOP_LAYER } from './effect-runtime';
import { Tabs, titleOf } from './tabs';

const app = ProjectId.make('app');
const api = ProjectId.make('api');
const fixBuild = { id: SessionId.make('s1'), projectId: app, title: 'Fix the build' };
const addLogin = { id: SessionId.make('s2'), projectId: api, title: 'Add login' };

const liveState = (overrides: Partial<LiveState> = {}): LiveState => ({
  agentStatus: 'ready',
  title: { auto: 'Fix the build', autoIsPlaceholder: false },
  options: { permissionMode: 'auto' },
  commands: [],
  commandsLoaded: true,
  queue: [],
  canAttachImages: false,
  imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
  ...overrides,
});

/** What a `Tabs.update` told main, as plain data. */
const updateOf = (update: {
  readonly open: ReadonlyArray<SessionId>;
  readonly active?: SessionId;
  readonly remote?: RemoteTabs;
}) => ({ open: update.open, active: update.active, remote: update.remote });

const tabsLayer = (options?: {
  readonly restored?: RestoredTabs;
  readonly updates?: Array<Parameters<typeof updateOf>[0]>;
  readonly changes?: Stream.Stream<SessionChange>;
  readonly activations?: Stream.Stream<TabActivation>;
}) =>
  makeDesktopTestLayer(
    Layer.mergeAll(
      TabsRpcs.toLayer({
        'Tabs.restore': () => Effect.succeed(options?.restored ?? { tabs: [] }),
        'Tabs.update': (update) =>
          Effect.sync(() => {
            options?.updates?.push(updateOf(update));
          }),
        'Tabs.activations': () => options?.activations ?? Stream.empty,
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => options?.changes ?? Stream.empty,
        'Session.list': () => Effect.die('unused'),
        'Session.create': () => Effect.die('unused'),
        'Session.setAgent': () => Effect.die('unused'),
        'Session.prompt': () => Effect.die('unused'),
        'Session.steer': () => Effect.die('unused'),
        'Session.enqueue': () => Effect.die('unused'),
        'Session.setQueue': () => Effect.die('unused'),
        'Session.clearQueue': () => Effect.die('unused'),
        'Session.cancel': () => Effect.die('unused'),
        'Session.stopAgent': () => Effect.die('unused'),
        'Session.answerPermission': () => Effect.die('unused'),
        'Session.setOption': () => Effect.die('unused'),
        'Session.clearContext': () => Effect.die('unused'),
        'Session.compact': () => Effect.die('unused'),
        'Session.startEmptyContext': () => Effect.die('unused'),
        'Session.prepareHandoff': () => Effect.die('unused'),
        'Session.revalidateHandoff': () => Effect.die('unused'),
        'Session.executeHandoff': () => Effect.die('unused'),
        'Session.listHandoffAttempts': () => Effect.die('unused'),
        'Session.events': () => Stream.die('unused'),
        'Session.getComposer': () => Effect.die('unused'),
        'Session.setComposer': () => Effect.die('unused'),
        'Session.rename': () => Effect.die('unused'),
        'Session.retryAgent': () => Effect.die('unused'),
        'Session.loginAgent': () => Effect.die('unused'),
        'Session.openAgentLog': () => Effect.die('unused'),
        'Session.archive': () => Effect.die('unused'),
        'Session.unarchive': () => Effect.die('unused'),
        'Session.countWorkers': () => Effect.die('unused'),
        'Session.delete': () => Effect.die('unused'),
      }),
    ),
  );

const tabs = (options?: Parameters<typeof tabsLayer>[0]): Tabs => {
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: tabsLayer(options) }],
  });
  return TestBed.inject(Tabs);
};

describe('Tabs', () => {
  it('opens a Session in one Tab and activates it; opening it again reuses that Tab', async () => {
    const state = tabs();
    await vi.waitFor(() => expect(state.tabs()).toEqual([]));

    state.open(fixBuild);
    state.open(addLogin);
    expect(state.tabs().map((tab) => tab.title)).toEqual(['Fix the build', 'Add login']);
    expect(state.active()?.title).toBe('Add login');

    state.open(fixBuild);
    expect(state.tabs()).toHaveLength(2);
    expect(state.active()?.title).toBe('Fix the build');
  });

  it('starts a draft per Project, reusing that Project draft when there is one', async () => {
    const state = tabs();
    await vi.waitFor(() => expect(state.tabs()).toEqual([]));

    const draft = state.startDraft(app);
    expect(draft.session).toBeNull();
    expect(state.active()).toBe(draft);
    expect(state.draftOf(app)).toBe(draft);
    expect(state.draftOf(api)).toBeNull();

    state.open(fixBuild);
    expect(state.startDraft(app)).toBe(draft);
    expect(state.active()).toBe(draft);
    expect(state.tabs()).toHaveLength(2);
  });

  it('closes a Tab and activates its neighbour; closing a draft forgets it', async () => {
    const state = tabs();
    await vi.waitFor(() => expect(state.tabs()).toEqual([]));

    const draft = state.startDraft(app);
    state.open(fixBuild);
    state.open(addLogin);
    state.activate(state.tabs()[1]?.id ?? '');
    expect(state.active()?.title).toBe('Fix the build');

    state.close(state.tabs()[1]?.id ?? '');
    expect(state.tabs().map((tab) => tab.session)).toEqual([null, addLogin.id]);
    expect(state.active()?.title).toBe('Add login');

    state.close(draft.id);
    expect(state.draftOf(app)).toBeNull();
    state.close(state.tabs()[0]?.id ?? '');
    expect(state.active()).toBeNull();
  });

  it('knows which Sessions are open', async () => {
    const state = tabs();
    await vi.waitFor(() => expect(state.tabs()).toEqual([]));

    state.open(fixBuild);
    expect(state.isOpen(fixBuild.id)).toBe(true);
    expect(state.isOpen(addLogin.id)).toBe(false);
  });

  it('restores kept Sessions, drafts, attention, running state, and the active Tab at launch', async () => {
    const draftId = SessionId.make('draft-session');
    const state = tabs({
      restored: {
        tabs: [
          {
            ...addLogin,
            title: { auto: addLogin.title, autoIsPlaceholder: false },
            attention: 'needsAnswer',
            running: true,
          },
          { ...fixBuild, title: { auto: fixBuild.title, autoIsPlaceholder: false } },
          {
            id: draftId,
            projectId: app,
            title: { autoIsPlaceholder: false },
            draft: true,
          },
        ],
        active: fixBuild.id,
      },
    });
    await vi.waitFor(() => expect(state.tabs()).toHaveLength(3));

    expect(state.tabs().map((tab) => tab.title)).toEqual(['Add login', 'Fix the build', null]);
    expect(state.active()?.title).toBe('Fix the build');
    expect(state.tabs()[0]).toMatchObject({
      session: addLogin.id,
      attention: 'needsAnswer',
      running: true,
    });
    expect(state.tabs()[1]?.session).toBe(fixBuild.id);
    expect(state.tabs()[2]).toMatchObject({
      session: null,
      draftSession: draftId,
    });
    expect(state.draftOf(app)?.draftSession).toBe(draftId);
  });

  it('tracks attention, running, and title live from Session.changes', async () => {
    const changes = Effect.runSync(Queue.unbounded<SessionChange>());
    const state = tabs({ changes: Stream.fromQueue(changes) });

    state.open(fixBuild);
    await vi.waitFor(() => expect(state.tabs()).toHaveLength(1));

    Queue.offerUnsafe(changes, {
      sessionId: fixBuild.id,
      projectId: app,
      state: liveState({
        attention: 'needsAnswer',
        runningTurn: TurnId.make('t1'),
        title: { auto: 'Updated title', autoIsPlaceholder: false },
      }),
    });

    await vi.waitFor(() =>
      expect(state.tabs()[0]).toMatchObject({
        title: 'Updated title',
        attention: 'needsAnswer',
        running: true,
      }),
    );

    Queue.offerUnsafe(changes, {
      sessionId: fixBuild.id,
      projectId: app,
      state: liveState({ title: { auto: 'Updated title', autoIsPlaceholder: false } }),
    });

    await vi.waitFor(() => {
      expect(state.tabs()[0]?.attention).toBeUndefined();
      expect(state.tabs()[0]?.running).toBeUndefined();
    });
  });

  it('opens and activates a Tab when main emits on Tabs.activations', async () => {
    const activations = Effect.runSync(Queue.unbounded<TabActivation>());
    const state = tabs({ activations: Stream.fromQueue(activations) });

    state.open(fixBuild);
    expect(state.active()?.session).toBe(fixBuild.id);

    Queue.offerUnsafe(activations, {
      sessionId: addLogin.id,
      projectId: api,
      title: { auto: 'Add login', autoIsPlaceholder: false },
    });

    await vi.waitFor(() => expect(state.active()?.session).toBe(addLogin.id));
    expect(state.tabs()).toHaveLength(2);
  });

  it("opens a Remote Session's Tab on its Device when its notification is clicked", async () => {
    const activations = Effect.runSync(Queue.unbounded<TabActivation>());
    const state = tabs({ activations: Stream.fromQueue(activations) });
    const studio = DeviceId.make('device-studio');

    Queue.offerUnsafe(activations, {
      device: studio,
      sessionId: addLogin.id,
      projectId: api,
      title: { auto: 'Add login', autoIsPlaceholder: false },
    });

    await vi.waitFor(() =>
      expect(state.active()).toMatchObject({ session: addLogin.id, device: studio }),
    );
  });

  it('closes all Tabs of a Project with closeProject', async () => {
    const state = tabs();
    state.startDraft(app);
    state.open(fixBuild);
    state.open(addLogin);
    expect(state.tabs()).toHaveLength(3);

    state.closeProject(app);
    expect(state.tabs().map((tab) => tab.session)).toEqual([addLogin.id]);
    expect(state.active()?.session).toBe(addLogin.id);
  });

  it('resolves SessionTitle with user > auto > image count > null', () => {
    expect(titleOf({ autoIsPlaceholder: false })).toBeNull();
    expect(titleOf({ autoImageCount: 1, autoIsPlaceholder: true })).toBe('Image');
    expect(titleOf({ autoImageCount: 3, autoIsPlaceholder: true })).toBe('3 Images');
    expect(titleOf({ auto: 'Auto', autoImageCount: 2, autoIsPlaceholder: false })).toBe('Auto');
    expect(
      titleOf({ user: 'Custom', auto: 'Auto', autoImageCount: 2, autoIsPlaceholder: false }),
    ).toBe('Custom');
  });

  it('closes Tabs by Session or Project and bumps sessionsVersion on keep', async () => {
    const state = tabs();
    await vi.waitFor(() => expect(state.tabs()).toEqual([]));

    const v0 = state.sessionsVersion();
    const draft = state.startDraft(app);
    state.keep(draft.id, fixBuild.id);
    expect(state.sessionsVersion()).toBe(v0 + 1);
    expect(state.tabs()[0]?.session).toBe(fixBuild.id);

    // Calling keep on an already-kept Session still bumps sessionsVersion (e.g. prompt unarchives)
    state.keep(draft.id, fixBuild.id);
    expect(state.sessionsVersion()).toBe(v0 + 2);

    state.open(addLogin);
    state.closeSession(fixBuild.id);
    expect(state.isOpen(fixBuild.id)).toBe(false);
    expect(state.isOpen(addLogin.id)).toBe(true);

    state.open(fixBuild);
    state.closeProject(app);
    expect(state.isOpen(fixBuild.id)).toBe(false);
    expect(state.isOpen(addLogin.id)).toBe(true);
  });

  it('cycles Tabs with next and prev, wrapping at the ends', async () => {
    const state = tabs();
    await vi.waitFor(() => expect(state.tabs()).toEqual([]));

    state.next();
    state.prev();
    expect(state.active()).toBeNull();

    const draft = state.startDraft(app);
    state.next();
    expect(state.active()?.id).toBe(draft.id);
    state.prev();
    expect(state.active()?.id).toBe(draft.id);

    const t1 = state.open(fixBuild);
    const t2 = state.open(addLogin);
    state.activate(draft.id);
    expect(state.active()?.id).toBe(draft.id);

    state.next();
    expect(state.active()?.id).toBe(t1.id);
    state.next();
    expect(state.active()?.id).toBe(t2.id);
    state.next();
    expect(state.active()?.id).toBe(draft.id);

    state.prev();
    expect(state.active()?.id).toBe(t2.id);
    state.prev();
    expect(state.active()?.id).toBe(t1.id);
  });

  it('activates Tabs by 0-based index and activateLast, ignoring out-of-range indices', async () => {
    const state = tabs();
    await vi.waitFor(() => expect(state.tabs()).toEqual([]));

    state.activateIndex(0);
    state.activateLast();
    expect(state.active()).toBeNull();

    const draft = state.startDraft(app);
    const t1 = state.open(fixBuild);
    const t2 = state.open(addLogin);

    state.activateIndex(0);
    expect(state.active()?.id).toBe(draft.id);
    state.activateIndex(1);
    expect(state.active()?.id).toBe(t1.id);
    state.activateIndex(9);
    expect(state.active()?.id).toBe(t1.id);
    state.activateIndex(-1);
    expect(state.active()?.id).toBe(t1.id);

    state.activateLast();
    expect(state.active()?.id).toBe(t2.id);
  });

  it("remembers a Remote Session's Tab as a stub, with its place in the strip", async () => {
    const updates: Array<ReturnType<typeof updateOf>> = [];
    const state = tabs({ updates });
    await vi.waitFor(() => expect(state.tabs()).toEqual([]));
    const studio = DeviceId.make('studio');

    state.open(fixBuild);
    state.open({ ...addLogin, device: studio });
    state.startDraft(app, studio);

    await vi.waitFor(() =>
      expect(updates.at(-1)).toEqual({
        open: [fixBuild.id],
        active: undefined,
        remote: {
          tabs: [
            {
              deviceId: studio,
              sessionId: addLogin.id,
              projectId: api,
              title: 'Add login',
              index: 1,
            },
          ],
        },
      }),
    );
  });

  it('restores Remote Tabs at their place, on their Device, and the active one', async () => {
    const studio = DeviceId.make('studio');
    const draft = SessionId.make('d1');
    const state = tabs({
      restored: {
        tabs: [
          {
            id: fixBuild.id,
            projectId: app,
            title: { user: 'Fix the build', autoIsPlaceholder: false },
          },
        ],
        remote: {
          tabs: [
            {
              deviceId: studio,
              sessionId: addLogin.id,
              projectId: api,
              title: 'Add login',
              index: 0,
            },
            {
              deviceId: studio,
              sessionId: draft,
              projectId: api,
              title: null,
              draft: true,
              index: 2,
            },
          ],
          active: addLogin.id,
        },
      },
    });

    await vi.waitFor(() => expect(state.tabs()).toHaveLength(3));
    expect(
      state.tabs().map((tab) => [tab.device, tab.session, tab.draftSession, tab.title]),
    ).toEqual([
      [studio, addLogin.id, undefined, 'Add login'],
      [undefined, fixBuild.id, undefined, 'Fix the build'],
      [studio, null, draft, null],
    ]);
    expect(state.active()?.session).toBe(addLogin.id);
  });

  it('a draft whose Session vanished starts over as a fresh draft', async () => {
    const studio = DeviceId.make('studio');
    const draft = SessionId.make('d1');
    const state = tabs({
      restored: {
        tabs: [],
        remote: {
          tabs: [
            {
              deviceId: studio,
              sessionId: draft,
              projectId: api,
              title: null,
              draft: true,
              index: 0,
            },
          ],
        },
      },
    });
    await vi.waitFor(() => expect(state.tabs()).toHaveLength(1));
    const tab = state.tabs()[0];
    if (tab === undefined) throw new Error('no Tab');

    state.resetDraft(tab.id);

    expect(state.tabs()[0]).toMatchObject({ id: tab.id, device: studio, session: null });
    expect(state.tabs()[0]?.draftSession).toBeUndefined();
  });
});
