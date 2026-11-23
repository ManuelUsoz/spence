import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Effect, Layer, Queue, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentId } from '../../../shared/agents/agents.rpc';
import { ProjectId } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  type LiveState,
  type SessionStreamItem,
  type WorkerInfo,
} from '../../../shared/sessions/sessions.rpc';
import {
  PanelId,
  TabId,
  TabsRpcs,
  type PaneId,
  type WorkspacePanel,
} from '../../../shared/tabs/tabs.rpc';
import { EMPTY_WORKSPACE, allTabLeaves, allTabPanels } from '../../../shared/tabs/workspace-layout';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { SessionToolbar } from '../../core/session-toolbar';
import { Tabs } from '../../core/tabs';
import { WorkersPanelHost } from './workers-panel';

const p1 = ProjectId.make('p1');
const s1 = SessionId.make('s1');
const s2 = SessionId.make('s2');
const w1 = SessionId.make('worker-1');
const w2 = SessionId.make('worker-2');

const liveWithWorkers = (workers: ReadonlyArray<WorkerInfo>): LiveState => ({
  agentStatus: 'ready',
  status: 'idle',
  title: { auto: 'Parent', autoIsPlaceholder: false },
  options: { permissionMode: 'auto' },
  commands: [],
  commandsLoaded: true,
  queue: [],
  canAttachImages: false,
  imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
  ...(workers.length === 0 ? {} : { workers }),
});

const mountHost = async (options?: {
  readonly panel?: WorkspacePanel;
  readonly paneId?: PaneId | null;
  readonly events?: (sessionId: SessionId) => Stream.Stream<SessionStreamItem>;
  readonly beforeMount?: (tabs: Tabs, toolbar: SessionToolbar) => void;
}) => {
  const subscribed: SessionId[] = [];
  const layer = makeDesktopTestLayer(
    Layer.mergeAll(
      TabsRpcs.toLayer({
        'Tabs.restore': () => Effect.succeed({ workspace: EMPTY_WORKSPACE, sessions: [] }),
        'Tabs.update': () => Effect.void,
        'Tabs.setVisibility': () => Effect.void,
        'Tabs.activations': () => Stream.empty,
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => Stream.empty,
        'Session.list': () => Effect.succeed([]),
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
        'Session.events': ({ sessionId }) => {
          subscribed.push(sessionId);
          return options?.events?.(sessionId) ?? Stream.empty;
        },
        'Session.getComposer': () => Effect.die('unused'),
        'Session.setComposer': () => Effect.die('unused'),
        'Session.rename': () => Effect.die('unused'),
        'Session.retryAgent': () => Effect.void,
        'Session.loginAgent': () => Effect.void,
        'Session.openAgentLog': () => Effect.void,
        'Session.archive': () => Effect.die('unused'),
        'Session.unarchive': () => Effect.die('unused'),
        'Session.countWorkers': () => Effect.succeed(0),
        'Session.delete': () => Effect.die('unused'),
      }),
    ),
  );

  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: layer }],
  });

  const tabs = TestBed.inject(Tabs);
  const toolbar = TestBed.inject(SessionToolbar);
  await vi.waitFor(() => expect(tabs.restored()).toBe(true));
  options?.beforeMount?.(tabs, toolbar);

  const fixture = TestBed.createComponent(WorkersPanelHost);
  fixture.componentRef.setInput(
    'panel',
    options?.panel ?? {
      id: PanelId.make('panel-workers'),
      spec: { _tag: 'Workers', sessionId: s1 },
    },
  );
  fixture.componentRef.setInput('projectId', p1);
  fixture.componentRef.setInput('paneId', options?.paneId ?? null);
  fixture.detectChanges();
  return { fixture, tabs, toolbar, subscribed };
};

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('WorkersPanelHost', () => {
  it('renders inline without a fixed overlay or duplicate header and subscribes to Session.events when parent Session is unmounted', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const queue2 = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const { fixture, subscribed } = await mountHost({
      events: (sid) => Stream.fromQueue(sid === s1 ? queue : queue2),
    });
    const host = fixture.nativeElement as HTMLElement;

    // Inline Panel body: no fixed overlay, no duplicate header/close button.
    const panelEl = host.querySelector<HTMLElement>('[data-testid="workers-panel"]');
    expect(panelEl).not.toBeNull();
    expect(panelEl?.classList.contains('fixed')).toBe(false);
    expect(host.querySelector('[data-testid="workers-close"]')).toBeNull();
    expect(host.querySelector('[data-testid="workers-empty"]')).not.toBeNull();

    // Live worker updates arrive via Session.events even with no SessionView mounted.
    Queue.offerAllUnsafe(queue, [
      {
        _tag: 'Live',
        state: liveWithWorkers([
          {
            sessionId: w1,
            title: 'Test writer',
            state: 'running',
            agentId: AgentId.make('claude'),
            agentName: 'Claude',
          },
          { sessionId: w2, title: 'Finished', state: 'idle' },
        ]),
      },
    ]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelectorAll('[data-testid="worker-row"]')).toHaveLength(1);
    });
    expect(subscribed).toEqual([s1]);
    expect(host.querySelector('[data-testid="workers-running"]')?.textContent).toContain(
      '1 running',
    );
    expect(host.querySelector('[data-testid="worker-title"]')?.textContent?.trim()).toBe(
      'Test writer',
    );

    // Rebinding the Workers Panel to s2 subscribes to s2 and updates worker rows.
    fixture.componentRef.setInput('panel', {
      id: PanelId.make('panel-workers'),
      spec: { _tag: 'Workers', sessionId: s2 },
    } satisfies WorkspacePanel);
    fixture.detectChanges();
    Queue.offerAllUnsafe(queue2, [
      {
        _tag: 'Live',
        state: liveWithWorkers([{ sessionId: w2, title: 'Review diff', state: 'requiresAction' }]),
      },
    ]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelector('[data-testid="worker-title"]')?.textContent?.trim()).toBe(
        'Review diff',
      );
    });
    expect(subscribed).toEqual([s1, s2]);
  });

  it('reads live state without duplicating Session.events when parent Session is mounted and opens Worker via openWorkerFromPanel', async () => {
    let withdraw: (() => void) | undefined;
    const { fixture, tabs, subscribed } = await mountHost({
      beforeMount: (t, tb) => {
        withdraw = tb.publish({
          sessionId: signal<string>(s1),
          context: signal({ label: '', fraction: null }),
          actions: signal([]),
          run: () => undefined,
        });
        t.applyLive(s1, liveWithWorkers([{ sessionId: w1, title: 'Docs', state: 'running' }]));
      },
    });
    const parentTab = tabs.open({ id: s1, projectId: p1, title: 'Parent' });
    const sourcePaneId = allTabLeaves(parentTab)[0]!.id;
    tabs.openWorkersPanel(s1, sourcePaneId);

    fixture.componentRef.setInput('paneId', sourcePaneId);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="worker-row"]'),
      ).toHaveLength(1);
    });
    expect(subscribed).toEqual([]);

    // Clicking the Worker row closes the overlay and shows the Worker in the parent Pane.
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-testid="worker-row"]')!
      .click();
    expect(tabs.activeTabOverlay()).toBeNull();
    expect(tabs.paneCount(tabs.activeTab()!)).toBe(1);
    expect(tabs.active()?.session).toBe(w1);
    expect(allTabPanels(tabs.activeTab()!).map((p) => p.spec)).toEqual([
      { _tag: 'Session', sessionId: w1, workerAncestors: [s1], retainedSessions: [s1] },
    ]);

    // Check TabId import isn't unused if needed
    expect(TabId.make('t1')).toBeTruthy();
    withdraw?.();
  });

  it('displays model, elapsed time, current action, permission attention, and reconnecting states', async () => {
    const { fixture } = await mountHost({
      beforeMount: (t, tb) => {
        tb.publish({
          sessionId: signal<string>(s1),
          context: signal({ label: '', fraction: null }),
          actions: signal([]),
          run: () => undefined,
        });
        t.applyLive(
          s1,
          liveWithWorkers([
            {
              sessionId: w1,
              title: 'Test writer',
              state: 'running',
              agentId: AgentId.make('claude'),
              agentName: 'Claude',
              modelName: 'Haiku 5.5',
              startedAt: Date.now() - 70_000,
              action: { kind: 'execute', target: 'npm run e2e:fast' },
            },
            {
              sessionId: w2,
              title: 'Docs checker',
              state: 'requiresAction',
              agentId: AgentId.make('codex'),
              agentName: 'Codex',
              startedAt: Date.now() - 21_000,
            },
            {
              sessionId: SessionId.make('worker-3'),
              title: 'Search',
              state: 'unknown',
            },
          ]),
        );
      },
    });
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="workers-running"]')?.textContent).toContain(
      '2 running',
    );
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="worker-row"]')];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector('[data-testid="worker-meta"]')?.textContent).toMatch(
      /^Haiku 5\.5 · 01:1[0-9]$/,
    );
    expect(rows[0]?.querySelector('[data-testid="worker-status"]')?.textContent).toContain(
      'Running npm run e2e:fast',
    );
    expect(rows[0]?.querySelector('[data-testid="worker-spinner"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-testid="worker-status"]')?.textContent).toContain(
      'Needs permission',
    );
    expect(rows[1]?.querySelector('[data-testid="worker-attention"]')).not.toBeNull();
    expect(rows[2]?.querySelector('[data-testid="worker-status"]')?.textContent).toContain(
      'Reconnecting',
    );
  });
});
