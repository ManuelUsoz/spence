import { Component, inject, input, output } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Deferred, Effect, Layer, Queue, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentId, AgentsRpcs, type Agent } from '../../../shared/agents/agents.rpc';
import { DeviceId } from '../../../shared/devices/devices.rpc';
import { LinksRpcs } from '../../../shared/links/links.rpc';
import { ProjectId, ProjectsRpcs, type Project } from '../../../shared/projects/projects.rpc';
import {
  CompactionId,
  HandoffAttemptId,
  MessageId,
  PermissionRequestId,
  SessionError,
  SessionId,
  SessionsRpcs,
  StepId,
  STOP_AGENT_INTERRUPTED_DETAIL,
  TurnId,
  type Command,
  type HandoffAttempt,
  type HandoffKind,
  type HandoffPreparation,
  type HandoffResult,
  type HandoffRevalidation,
  type LiveState,
  type MessagePart,
  type PermissionOption,
  type QueuedMessage,
  type SessionStreamItem,
  type StopAgentResult,
  type TranscriptItem,
  type TurnOutcome,
} from '../../../shared/sessions/sessions.rpc';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
import {
  PaneId,
  PanelId,
  TabId,
  TabsRpcs,
  type TabActivation,
} from '../../../shared/tabs/tabs.rpc';
import { EMPTY_WORKSPACE } from '../../../shared/tabs/workspace-layout';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM, Keymap } from '../../core/keymap';
import { SessionToolbar } from '../../core/session-toolbar';
import { Tabs } from '../../core/tabs';
import { SessionView } from './session-view';

// jsdom has no layout: Spartan's Command item calls scrollIntoView when it highlights.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

const sessionId = SessionId.make('session-1');
const turnId = TurnId.make('turn-1');
const userId = MessageId.make('user-1');
const agentId = MessageId.make('agent-1');

const live: SessionStreamItem = {
  _tag: 'Live',
  state: {
    agentStatus: 'ready',
    title: { autoIsPlaceholder: false },
    options: { permissionMode: 'auto' },
    commands: [],
    commandsLoaded: true,
    queue: [],
    canAttachImages: false,
    imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
  } satisfies LiveState,
};

let seq = 0;
const event = (item: TranscriptItem): SessionStreamItem => ({
  _tag: 'Transcript',
  event: { seq: ++seq, at: seq, item },
});

const started = () => event({ _tag: 'TurnStarted', turnId, permissionMode: 'auto' });
const userMessage = (text: string) =>
  event({ _tag: 'Message', id: userId, turnId, role: 'user', parts: [{ _tag: 'text', text }] });
const agentMessage = (text: string) =>
  event({ _tag: 'Message', id: agentId, turnId, role: 'agent', parts: [{ _tag: 'text', text }] });
const agentDelta = (text: string) => event({ _tag: 'MessageDelta', id: agentId, text });
const step = (patch?: Partial<Extract<TranscriptItem, { _tag: 'Step' }>>) =>
  event({
    _tag: 'Step',
    id: StepId.make('step-1'),
    turnId,
    title: 'Read src/view.ts',
    kind: 'read',
    status: 'running',
    files: ['src/view.ts'],
    diffs: [],
    output: '',
    ...patch,
  });
const plan = () =>
  event({
    _tag: 'Plan',
    entries: [{ content: 'Read', priority: 'high', status: 'inProgress' }],
  });
const notice = () =>
  event({ _tag: 'Notice', severity: 'warning', title: 'Slow', description: 'Rate limited' });
const compaction = () =>
  event({
    _tag: 'Compaction',
    id: CompactionId.make('compaction-1'),
    status: 'running',
    summary: 'All good',
  });
const ended = (outcome: TurnOutcome = { _tag: 'done' }) =>
  event({ _tag: 'TurnEnded', turnId, outcome });

const permissionStep = (id: string, title: string, status = 'pending' as const) =>
  event({
    _tag: 'Step',
    id: StepId.make(id),
    turnId,
    title,
    kind: 'execute',
    status,
    files: [],
    diffs: [],
    output: '',
  });

const permissionRequest = (
  id: string,
  stepId: string,
  options: ReadonlyArray<PermissionOption>,
  state: 'pending' | 'answered' | 'cancelled' = 'pending',
  by: 'user' | 'policy' = 'user',
) =>
  event({
    _tag: 'PermissionRequest',
    id: PermissionRequestId.make(id),
    turnId,
    stepId: StepId.make(stepId),
    options,
    state:
      state === 'pending'
        ? { _tag: 'pending' }
        : state === 'cancelled'
          ? { _tag: 'cancelled' }
          : { _tag: 'answered', optionId: options[0]?.id ?? 'allow', by },
  });

interface Served {
  /** What each `Session.events` subscription streams, in order of subscription. */
  readonly subscriptions: Array<Stream.Stream<SessionStreamItem, SessionError>>;
  readonly afterSeqs: Array<number | undefined>;
  readonly verificationRequests: Array<TurnId | undefined>;
  readonly promptWorkflows: Array<string | undefined>;
  readonly prompts: Array<ReadonlyArray<MessagePart>>;
  readonly steers: Array<ReadonlyArray<MessagePart>>;
  readonly enqueues: Array<ReadonlyArray<MessagePart>>;
  readonly queueChanges: Array<ReadonlyArray<QueuedMessage>>;
  queueClears: number;
  steerEffect?: Effect.Effect<void, SessionError>;
  readonly options: Array<{ readonly option: 'model' | 'effort'; readonly value: string }>;
  readonly answers: Array<{ readonly requestId: PermissionRequestId; readonly optionId: string }>;
  readonly answeredSessions: Array<SessionId>;
  readonly optionChanges: Array<'ask' | 'auto'>;
  readonly agentChanges: Array<AgentId>;
  agents?: ReadonlyArray<Agent>;
  composer: {
    readonly text: string;
    readonly images: ReadonlyArray<{
      readonly name: string;
      readonly mimeType: string;
      readonly data: string;
    }>;
  };
  cancels: number;
  readonly openedLinks: string[];
  stopAgents: Array<{ readonly sessionId: SessionId; readonly force?: boolean }>;
  stopAgentEffect?: (force?: boolean) => Effect.Effect<StopAgentResult, SessionError>;
  retries: number;
  logins: number;
  loginCancelled: boolean;
  loginEffect?: Effect.Effect<void, SessionError>;
  logs: number;
  clears: number;
  compacts: number;
  startEmptyCalls: number;
  project?: Project;
  located?: Project | null;
  locates: number;
  prepareHandoffCalls: Array<{ readonly kind: HandoffKind; readonly targetModel?: string }>;
  prepareHandoffEffect?: (
    kind: HandoffKind,
    targetModel?: string,
  ) => Effect.Effect<HandoffPreparation, SessionError>;
  revalidateHandoffEffect?: () => Effect.Effect<HandoffRevalidation, SessionError>;
  executeHandoffEffect?: () => Effect.Effect<HandoffResult, SessionError>;
  handoffAttempts: Array<HandoffAttempt>;
}

const serve = (subscriptions: Array<Stream.Stream<SessionStreamItem, SessionError>>): Served => ({
  subscriptions,
  afterSeqs: [],
  prompts: [],
  promptWorkflows: [],
  verificationRequests: [],
  steers: [],
  enqueues: [],
  queueChanges: [],
  queueClears: 0,
  options: [],
  answers: [],
  answeredSessions: [],
  optionChanges: [],
  agentChanges: [],
  composer: { text: '', images: [] },
  cancels: 0,
  openedLinks: [],
  stopAgents: [],
  retries: 0,
  logins: 0,
  loginCancelled: false,
  logs: 0,
  clears: 0,
  compacts: 0,
  startEmptyCalls: 0,
  locates: 0,
  prepareHandoffCalls: [],
  handoffAttempts: [],
});

const handlers = (served: Served) => {
  const { project } = served;
  return Layer.mergeAll(
    SessionsRpcs.toLayer({
      'Session.changes': () => Stream.empty,
      'Session.list': () => Effect.succeed([]),
      'Session.create': () => Effect.succeed(sessionId),
      'Session.setAgent': ({ agentId: nextAgent }) =>
        Effect.sync(() => {
          served.agentChanges.push(nextAgent);
        }),
      'Session.prompt': ({ parts, workflow, verificationOf }) =>
        Effect.sync(() => {
          served.prompts.push(parts);
          served.promptWorkflows.push(workflow);
          served.verificationRequests.push(verificationOf);
          return turnId;
        }),
      'Session.steer': ({ parts }) =>
        Effect.sync(() => {
          served.steers.push(parts);
        }).pipe(Effect.andThen(served.steerEffect ?? Effect.void)),
      'Session.enqueue': ({ parts }) =>
        Effect.sync(() => {
          served.enqueues.push(parts);
        }),
      'Session.setQueue': ({ queue }) =>
        Effect.sync(() => {
          served.queueChanges.push(queue);
        }),
      'Session.clearQueue': () =>
        Effect.sync(() => {
          served.queueClears += 1;
        }),
      'Session.rename': () => Effect.void,
      'Session.retryAgent': () =>
        Effect.sync(() => {
          served.retries += 1;
        }),
      'Session.loginAgent': () =>
        Effect.sync(() => {
          served.logins += 1;
        }).pipe(
          Effect.andThen(served.loginEffect ?? Effect.void),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              served.loginCancelled = true;
            }),
          ),
        ),
      'Session.openAgentLog': () =>
        Effect.sync(() => {
          served.logs += 1;
        }),
      'Session.cancel': () =>
        Effect.sync(() => {
          served.cancels += 1;
        }),
      'Session.stopAgent': ({ sessionId: id, force }) =>
        Effect.sync(() => {
          served.stopAgents.push({ sessionId: id, ...(force === undefined ? {} : { force }) });
        }).pipe(
          Effect.andThen(
            served.stopAgentEffect
              ? served.stopAgentEffect(force)
              : Effect.succeed({ _tag: 'stopped', pid: 4321 } as const),
          ),
        ),
      'Session.answerPermission': ({ sessionId: id, requestId, optionId }) =>
        Effect.sync(() => {
          served.answeredSessions.push(id);
          served.answers.push({ requestId, optionId });
        }),
      'Session.setOption': ({ option, value }) =>
        Effect.sync(() => {
          if (option === 'permissionMode') served.optionChanges.push(value);
          else served.options.push({ option, value });
        }),
      'Session.clearContext': () =>
        Effect.sync(() => {
          served.clears += 1;
        }),
      'Session.compact': () =>
        Effect.sync(() => {
          served.compacts += 1;
        }),
      'Session.startEmptyContext': () =>
        Effect.sync(() => {
          served.startEmptyCalls += 1;
        }),
      'Session.archive': () => Effect.die('not served in this spec'),
      'Session.unarchive': () => Effect.die('not served in this spec'),
      'Session.countWorkers': () => Effect.die('not served in this spec'),
      'Session.delete': () => Effect.die('not served in this spec'),
      'Session.events': ({ afterSeq }) => {
        served.afterSeqs.push(afterSeq);
        return served.subscriptions.shift() ?? Stream.never;
      },
      'Session.getComposer': () => Effect.sync(() => served.composer),
      'Session.setComposer': ({ draft }) =>
        Effect.sync(() => {
          served.composer = draft;
        }),
      'Session.prepareHandoff': ({ kind, targetModel }) => {
        served.prepareHandoffCalls.push({
          kind,
          ...(targetModel === undefined ? {} : { targetModel }),
        });
        return served.prepareHandoffEffect
          ? served.prepareHandoffEffect(kind, targetModel)
          : Effect.die('not served in this spec');
      },
      'Session.revalidateHandoff': () =>
        served.revalidateHandoffEffect
          ? served.revalidateHandoffEffect()
          : Effect.die('not served in this spec'),
      'Session.executeHandoff': () =>
        served.executeHandoffEffect
          ? served.executeHandoffEffect()
          : Effect.die('not served in this spec'),
      'Session.listHandoffAttempts': () => Effect.succeed(served.handoffAttempts),
    }),
    ...(served.agents === undefined
      ? []
      : [
          AgentsRpcs.toLayer({
            'Agents.list': () => Effect.succeed(served.agents ?? []),
            'Agents.installCommand': () => Effect.die('unused'),
            'Agents.install': () => Effect.die('unused'),
            'Agents.openInstallLog': () => Effect.die('unused'),
          }),
        ]),
    ...(project === undefined
      ? []
      : [
          ProjectsRpcs.toLayer({
            'Projects.list': () => Effect.succeed([project]),
            'Projects.add': () => Effect.die('unused'),
            'Projects.rename': () => Effect.die('unused'),
            'Projects.remove': () => Effect.die('unused'),
            'Projects.addFolder': () => Effect.die('unused'),
            'Projects.locateFolder': () => Effect.die('unused'),
            'Projects.check': () => Effect.succeed(project),
            'Projects.locate': () =>
              Effect.sync(() => {
                served.locates += 1;
                return served.located ?? null;
              }),
            'Projects.setSettings': () => Effect.die('unused'),
          }),
        ]),
    LinksRpcs.toLayer({
      'Links.openExternal': ({ url }) =>
        Effect.sync(() => {
          served.openedLinks.push(url);
        }),
    }),
    TabsRpcs.toLayer({
      'Tabs.restore': () => Effect.succeed({ workspace: EMPTY_WORKSPACE, sessions: [] }),
      'Tabs.update': () => Effect.void,
      'Tabs.activations': () => Stream.empty,
    }),
  );
};

@Component({
  selector: 'app-install-offer-stub',
  template: `
    <div data-testid="install-offer-stub">
      <span>Install {{ agent().name }} ({{ agent().package }})</span>
      <button type="button" data-testid="stub-install-done" (click)="installed.emit()">Done</button>
    </div>
  `,
})
class InstallOfferStub {
  readonly agent = input.required<Agent>();
  readonly installed = output<void>();
}

const mount = (
  served: Served,
  options?: { readonly projectId?: ProjectId },
): ComponentFixture<SessionView> => {
  TestBed.configureTestingModule({
    providers: [
      { provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers(served)) },
      { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
    ],
  });
  const fixture = TestBed.createComponent(SessionView);
  fixture.componentRef.setInput('sessionId', sessionId);
  if (options?.projectId !== undefined) {
    fixture.componentRef.setInput('projectId', options.projectId);
  }
  fixture.detectChanges();
  return fixture;
};

const root = (fixture: ComponentFixture<SessionView>): HTMLElement =>
  fixture.nativeElement as HTMLElement;

const byTestId = (fixture: ComponentFixture<SessionView>, id: string): HTMLElement => {
  const element = root(fixture).querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (element === null) throw new Error(`no ${id}`);
  return element;
};

/** The picker menu renders in the CDK overlay, outside the fixture. */
const menuItem = (id: string): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

const openPicker = (fixture: ComponentFixture<SessionView>): void => {
  byTestId(fixture, 'model-picker').click();
  fixture.detectChanges();
};

const messages = (fixture: ComponentFixture<SessionView>, role: 'user' | 'agent') => {
  fixture.detectChanges();
  return [...root(fixture).querySelectorAll(`[data-testid="message-${role}"]`)].map(
    (element) => element.textContent?.trim() ?? '',
  );
};

const ticker = (fixture: ComponentFixture<SessionView>): HTMLElement | null => {
  fixture.detectChanges();
  return root(fixture).querySelector('[data-testid="ticker"]');
};

const receipt = (fixture: ComponentFixture<SessionView>): HTMLElement | null => {
  fixture.detectChanges();
  return root(fixture).querySelector('[data-testid="receipt"]');
};

const dock = (fixture: ComponentFixture<SessionView>): HTMLElement | null => {
  fixture.detectChanges();
  return root(fixture).querySelector('[data-testid="plan-dock"]');
};

const composer = (fixture: ComponentFixture<SessionView>) =>
  byTestId(fixture, 'composer-input') as HTMLTextAreaElement;

const type = (fixture: ComponentFixture<SessionView>, text: string) => {
  const input = composer(fixture);
  input.value = text;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
};

const press = (
  fixture: ComponentFixture<SessionView>,
  key: string,
  shiftKey = false,
  init: KeyboardEventInit = {},
) => {
  const keydown = new KeyboardEvent('keydown', {
    key,
    shiftKey,
    cancelable: true,
    bubbles: true,
    ...init,
  });
  composer(fixture).dispatchEvent(keydown);
  fixture.detectChanges();
  return keydown;
};

const pressWindow = (
  fixture: ComponentFixture<SessionView>,
  key: string,
  init: KeyboardEventInit = {},
) => {
  const keydown = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...init });
  document.dispatchEvent(keydown);
  fixture.detectChanges();
  return keydown;
};

const sendButton = (fixture: ComponentFixture<SessionView>) =>
  byTestId(fixture, 'send') as HTMLButtonElement;

const capabilitiesWith = (supportsCompaction: boolean) => ({
  models: true,
  effort: true,
  images: true,
  askMode: true,
  resume: true,
  contextUsage: true,
  supportsCompaction,
  supportsIsolatedSummary: true,
  modelChangePreservesContext: true,
  crossDeviceTools: true,
});

const liveWith = (patch: Partial<LiveState> = {}): SessionStreamItem => ({
  _tag: 'Live',
  state: {
    agentStatus: 'ready',
    title: { autoIsPlaceholder: false },
    options: { permissionMode: 'auto' },
    commands: [],
    commandsLoaded: true,
    queue: [],
    canAttachImages: false,
    capabilities: capabilitiesWith(true),
    imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
    ...patch,
  } satisfies LiveState,
});

/** An Agent-advertised Composer entry, shaped as main maps it. */
const agentCommand = (
  name: string,
  description: string,
  hint?: string,
  owner = 'Claude',
  kind: Command['kind'] = 'command',
): Command => ({
  id: `${owner}:${name}`,
  name,
  invocation: `/${name}`,
  owner: { kind: 'agent', name: owner },
  kind,
  description,
  ...(hint === undefined ? {} : { hint }),
});

beforeEach(() => {
  // jsdom has no layout observer; Electron layout is covered by chat-scroll.spec.ts.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  seq = 0;
});

describe('SessionView', () => {
  it('tells the user only the owned Worker sees what they write there', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          liveWith({
            parentSessionId: SessionId.make('parent-1'),
            workerKind: 'owned',
            title: { auto: 'Test writer', autoIsPlaceholder: false },
          }),
        ).pipe(Stream.concat(Stream.never)),
      ]),
      { projectId: ProjectId.make('project-1') },
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'worker-hint').textContent).toContain(
        'Only this Worker sees your message. The parent Turn keeps running.',
      );
    });
    expect(byTestId(fixture, 'composer-input').getAttribute('placeholder')).toBe(
      'Message this Worker',
    );
    type(fixture, 'Hello');
    expect((byTestId(fixture, 'send') as HTMLButtonElement).disabled).toBe(false);
    expect(fixture.nativeElement.textContent).not.toContain(
      'Messaging this Worker is not supported.',
    );
  });

  it('explains a native Worker is read-only and does not offer to send', async () => {
    const fixture = mount(
      serve([
        Stream.make(liveWith({ parentSessionId: SessionId.make('parent-1') })).pipe(
          Stream.concat(Stream.never),
        ),
      ]),
      { projectId: ProjectId.make('project-1') },
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'worker-hint').textContent).toContain(
        'Messaging this Worker is not supported.',
      );
    });
    type(fixture, 'Hello');
    expect((byTestId(fixture, 'send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('has no Worker hint on an ordinary Session', async () => {
    const fixture = mount(serve([Stream.make(liveWith()).pipe(Stream.concat(Stream.never))]));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'composer-input')).toBeTruthy();
    });
    expect(root(fixture).querySelector('[data-testid="worker-hint"]')).toBeNull();
  });

  it('lends the top bar the Worker crumb: Parent, Agent, Model and working state', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          liveWith({
            parentSessionId: SessionId.make('parent-1'),
            workerKind: 'owned',
            agentId: AgentId.make('claude'),
            agentName: 'Claude',
            options: {
              permissionMode: 'auto',
              model: { value: 'haiku', choices: [{ id: 'haiku', name: 'Haiku 5.5' }] },
            },
            runningTurn: turnId,
          }),
        ).pipe(Stream.concat(Stream.never)),
      ]),
      { projectId: ProjectId.make('project-1') },
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(TestBed.inject(SessionToolbar).entryFor(sessionId)?.worker?.()?.parentId).toBe(
        'parent-1',
      );
    });
    const crumb = TestBed.inject(SessionToolbar).entryFor(sessionId)?.worker?.();
    expect(crumb).toMatchObject({
      agentName: 'Claude',
      modelName: 'Haiku 5.5',
      working: true,
      waitingAncestorId: null,
    });
  });

  it('points the crumb at the Parent when it is waiting for Permission', async () => {
    const parentId = SessionId.make('parent-1');
    const fixture = mount(
      serve([
        Stream.make(liveWith({ parentSessionId: parentId, workerKind: 'owned' })).pipe(
          Stream.concat(Stream.never),
        ),
      ]),
      { projectId: ProjectId.make('project-1') },
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(TestBed.inject(SessionToolbar).entryFor(sessionId)?.worker?.()).not.toBeNull();
    });
    expect(
      TestBed.inject(SessionToolbar).entryFor(sessionId)?.worker?.()?.waitingAncestorId,
    ).toBeNull();
    const waiting = liveWith({ attention: 'needsAnswer' });
    if (waiting._tag !== 'Live') throw new Error('not a live state');
    TestBed.inject(Tabs).seedLive(parentId, waiting.state);
    fixture.detectChanges();
    expect(TestBed.inject(SessionToolbar).entryFor(sessionId)?.worker?.()?.waitingAncestorId).toBe(
      parentId,
    );
  });

  it('shows active/reconnecting Worker counts in the Composer and opens a Workers Panel via workers-toggle', async () => {
    const projectId = ProjectId.make('project-1');
    const childId = SessionId.make('worker-1');
    const fixture = mount(
      serve([
        Stream.make(
          liveWith({
            workers: [
              { sessionId: childId, title: 'Review', state: 'requiresAction' },
              { sessionId: SessionId.make('worker-2'), title: 'Search', state: 'unknown' },
            ],
          }),
        ).pipe(Stream.concat(Stream.never)),
      ]),
      { projectId },
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'workers-toggle').textContent).toContain('1');
    });
    byTestId(fixture, 'workers-toggle').click();
    fixture.detectChanges();
    expect(TestBed.inject(Tabs).activeTabOverlay()).toMatchObject({
      kind: 'Workers',
      sessionId,
    });
  });

  it('keeps the Composer control for Workers that are all reconnecting, with no count or spinner', async () => {
    const projectId = ProjectId.make('project-1');
    const fixture = mount(
      serve([
        Stream.make(
          liveWith({
            workers: [
              { sessionId: SessionId.make('worker-1'), title: 'Review', state: 'unknown' },
              { sessionId: SessionId.make('worker-2'), title: 'Search', state: 'unknown' },
            ],
          }),
        ).pipe(Stream.concat(Stream.never)),
      ]),
      { projectId },
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'workers-toggle').textContent).toContain('Reconnecting');
    });
    const toggle = byTestId(fixture, 'workers-toggle');
    expect(toggle.textContent).not.toMatch(/[0-9]/);
    expect(toggle.querySelector('.animate-spin')).toBeNull();
    expect(toggle.getAttribute('aria-label')).toBe('Workers reconnecting');
    toggle.click();
    fixture.detectChanges();
    expect(TestBed.inject(Tabs).activeTabOverlay()).toMatchObject({
      kind: 'Workers',
      sessionId,
    });
  });

  it('records started Workers in one quiet line and opens a finished one from its menu', async () => {
    const projectId = ProjectId.make('project-1');
    const done = SessionId.make('worker-done');
    const fixture = mount(
      serve([
        Stream.make(
          liveWith({
            workers: [
              { sessionId: done, title: 'Docs', state: 'idle', modelName: 'Haiku 5.5', turnId },
              { sessionId: SessionId.make('w-2'), title: 'Tests', state: 'running', turnId },
              { sessionId: SessionId.make('w-3'), title: 'Copy', state: 'requiresAction', turnId },
            ],
          }),
          started(),
          userMessage('Use workers'),
          agentMessage('On it'),
          ended(),
        ).pipe(Stream.concat(Stream.never)),
      ]),
      { projectId },
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'workers-line').textContent).toContain(
        'Started 3 workers · 1 finished',
      );
    });
    expect(
      byTestId(fixture, 'workers-line').querySelector('[data-testid="worker-spinner"]'),
    ).toBeNull();
    byTestId(fixture, 'workers-line').click();
    fixture.detectChanges();
    const items = [...document.querySelectorAll<HTMLElement>('[data-testid="workers-line-item"]')];
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain('Docs');
    expect(items[0]?.textContent).toContain('Done');
    expect(items[0]?.textContent).toContain('Haiku 5.5');
    expect(items[1]?.textContent).toContain('Running');
    items[0]?.click();
    expect(TestBed.inject(Tabs).active()?.session).toBe(done);
  });

  it('shows no Workers line when no Worker was started', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          liveWith({}),
          started(),
          userMessage('Hi'),
          agentMessage('Hello'),
          ended(),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => expect(root(fixture).textContent).toContain('Hello'));
    expect(root(fixture).querySelector('[data-testid="workers-line"]')).toBeNull();
  });

  it('hides workers-toggle when all active direct Workers finish', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const projectId = ProjectId.make('project-1');
    const served = serve([Stream.fromQueue(queue)]);
    served.project = {
      id: projectId,
      name: 'project-1',
      path: '/work/project-1',
      addedAt: 1,
      lastUsedAt: 1,
      settings: {},
      folderMissing: false,
    };
    const fixture = mount(served, { projectId });
    const worker = {
      sessionId: SessionId.make('worker-1'),
      title: 'Research',
      state: 'running' as const,
    };
    Queue.offerAllUnsafe(queue, [liveWith({ workers: [worker] })]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'workers-toggle').textContent).toContain('1');
    });
    byTestId(fixture, 'workers-toggle').click();
    fixture.detectChanges();
    expect(TestBed.inject(Tabs).activeTabOverlay()).toMatchObject({
      kind: 'Workers',
      sessionId,
    });
    Queue.offerAllUnsafe(queue, [liveWith({ workers: [{ ...worker, state: 'idle' }] })]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="workers-toggle"]')).toBeNull();
    });
  });

  it('shows the user Message and the Agent reply as it streams', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const fixture = mount(serve([Stream.fromQueue(queue)]));

    Queue.offerAllUnsafe(queue, [live, started(), userMessage('Hi'), agentMessage('Hel')]);
    await vi.waitFor(() => expect(messages(fixture, 'agent')).toEqual(['Hel']));
    expect(messages(fixture, 'user')).toEqual(['Hi']);

    Queue.offerAllUnsafe(queue, [agentDelta('lo'), ended()]);
    await vi.waitFor(() => expect(messages(fixture, 'agent')).toEqual(['Hello']));
  });

  it('sets code in Agent text apart from its prose', async () => {
    const fixture = mount(
      serve([
        Stream.make(live, started(), agentMessage('Run `npm test` now.'), ended()).pipe(
          Stream.concat(Stream.never),
        ),
      ]),
    );
    await vi.waitFor(() => expect(messages(fixture, 'agent')).toEqual(['Run npm test now.']));
    const code = root(fixture).querySelector('[data-testid="message-agent"] code');
    expect(code?.textContent).toBe('npm test');
    expect(code?.className).toContain('font-mono');
  });

  it('routes an Agent Markdown link through DesktopApi and never navigates the app', async () => {
    const served = serve([
      Stream.make(
        live,
        started(),
        agentMessage('[docs](https://example.com/docs) [plain](/settings)'),
        ended(),
      ).pipe(Stream.concat(Stream.never)),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() =>
      expect(root(fixture).querySelector('[data-testid="markdown-link"]')).not.toBeNull(),
    );
    const link = root(fixture).querySelector('[data-testid="markdown-link"]') as HTMLAnchorElement;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(served.openedLinks).toEqual(['https://example.com/docs']));
    expect(root(fixture).querySelector('[data-testid="markdown-link-text"]')).not.toBeNull();
  });

  it('sends the Composer text on Enter and keeps a new line on Shift+Enter', async () => {
    const served = serve([Stream.make(live).pipe(Stream.concat(Stream.never))]);
    const fixture = mount(served);
    type(fixture, 'Hello');

    expect(press(fixture, 'Enter', true).defaultPrevented).toBe(false);
    expect(served.prompts).toEqual([]);

    expect(press(fixture, 'Enter').defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(served.prompts).toEqual([[{ _tag: 'text', text: 'Hello' }]]));
    await vi.waitFor(() => expect(composer(fixture).value).toBe(''));
  });

  it('disables Send while a Turn runs, and Stop cancels it', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [live, started(), userMessage('Hi')]);
    type(fixture, 'More');

    await vi.waitFor(() => expect(sendButton(fixture).disabled).toBe(true));
    press(fixture, 'Enter');
    expect(served.prompts).toEqual([]);

    await vi.waitFor(() => expect(byTestId(fixture, 'stop')).toBeDefined());
    byTestId(fixture, 'stop').click();
    await vi.waitFor(() => expect(served.cancels).toBe(1));

    Queue.offerUnsafe(queue, ended());
    await vi.waitFor(() => expect(sendButton(fixture).disabled).toBe(false));
  });

  it('shows that the Session is opening until its first state arrives', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const fixture = mount(serve([Stream.fromQueue(queue)]));
    expect(byTestId(fixture, 'session-loading')).not.toBeNull();

    Queue.offerUnsafe(queue, live);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="session-loading"]')).toBeNull();
    });
  });

  it('shows a failure, not an empty thread, when the Session cannot be followed', async () => {
    const fixture = mount(
      serve([Stream.fail(new SessionError({ reason: 'NotFound', detail: 'no open Session' }))]),
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="session-unavailable"]')).not.toBeNull();
    });
    expect(root(fixture).querySelector('[data-testid="session-loading"]')).toBeNull();
    expect(root(fixture).querySelector('[data-testid="composer"]')).toBeNull();
  });

  it('resubscribes after the last seq it saw when the stream drops, and shows nothing twice', async () => {
    const first = [live, started(), userMessage('Hi'), agentMessage('Hel')];
    const rest = [agentDelta('lo'), ended()];
    const served = serve([
      Stream.fromIterable(first).pipe(Stream.concat(Stream.die('the port closed'))),
      // Main replays from afterSeq; an event it already sent may still come again.
      Stream.make(live, first[3] as SessionStreamItem, ...rest).pipe(Stream.concat(Stream.never)),
    ]);
    const fixture = mount(served);

    await vi.waitFor(() => expect(messages(fixture, 'agent')).toEqual(['Hello']));
    expect(served.afterSeqs).toEqual([undefined, 3]);
    expect(messages(fixture, 'user')).toEqual(['Hi']);
  });

  it('shows a quiet loading state while the Agent starts', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const fixture = mount(serve([Stream.fromQueue(queue)]));

    Queue.offerUnsafe(queue, liveWith({ agentStatus: 'starting' }));
    await vi.waitFor(() => expect(byTestId(fixture, 'controls-loading')).not.toBeNull());

    Queue.offerUnsafe(queue, liveWith({ agentStatus: 'ready' }));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="controls-loading"]')).toBeNull();
    });
  });

  it('shows the Model picker and changing it calls Session.setOption', async () => {
    const served = serve([
      Stream.make(
        liveWith({
          options: {
            permissionMode: 'auto',
            model: {
              value: 'sonnet',
              choices: [
                { id: 'sonnet', name: 'Sonnet' },
                { id: 'opus', name: 'Opus' },
              ],
            },
          },
        }),
      ).pipe(Stream.concat(Stream.never)),
    ]);
    const fixture = mount(served);
    const picker = byTestId(fixture, 'model-picker');
    await vi.waitFor(() => expect(picker.textContent).toContain('Sonnet'));
    openPicker(fixture);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(menuItem('model-option-opus')).not.toBeNull();
    });
    expect(menuItem('model-option-sonnet')?.hasAttribute('data-checked')).toBe(true);

    menuItem('model-option-opus')?.click();
    fixture.detectChanges();
    await vi.waitFor(() => expect(served.options).toEqual([{ option: 'model', value: 'opus' }]));
  });

  it('shows the Effort picker with missing levels disabled', async () => {
    const served = serve([
      Stream.make(
        liveWith({
          options: {
            permissionMode: 'auto',
            effort: { value: 'medium', choices: ['low', 'medium', 'high'] },
          },
        }),
      ).pipe(Stream.concat(Stream.never)),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() => expect(byTestId(fixture, 'effort-current')).not.toBeNull());
    openPicker(fixture);

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(menuItem('effort-max')).not.toBeNull();
    });
    expect(menuItem('effort-max')?.disabled).toBe(true);

    menuItem('effort-low')?.click();
    fixture.detectChanges();
    await vi.waitFor(() => expect(served.options).toEqual([{ option: 'effort', value: 'low' }]));
  });

  it('opens the Commands list on `/`, filters as the user types, and picks Agent commands', async () => {
    const served = serve([
      Stream.make(
        liveWith({
          commands: [
            agentCommand('compact', 'Compact the context'),
            agentCommand('review', 'Review the changes', 'what to review'),
          ],
        }),
      ).pipe(Stream.concat(Stream.never)),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        (
          fixture.componentInstance as unknown as { agentStatus: () => string | undefined }
        ).agentStatus(),
      ).toBe('ready');
    });
    expect(root(fixture).querySelector('[data-testid="clear-context"]')).toBeNull();
    expect(root(fixture).querySelector('[data-testid="compact"]')).toBeNull();

    type(fixture, '/');
    await vi.waitFor(() => expect(byTestId(fixture, 'commands-list')).not.toBeNull());
    const initial = root(fixture).querySelectorAll('[data-testid^="command-"]');
    expect(initial.length).toBe(5); // two workflows + clear + compact + review

    type(fixture, '/review');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelectorAll('[data-testid^="command-"]').length).toBe(1);
    });
    expect(root(fixture).querySelector('[data-testid="command-Claude:review"]')).not.toBeNull();

    press(fixture, 'Enter');
    await vi.waitFor(() => expect(composer(fixture).value).toBe('/review '));
    expect(root(fixture).querySelector('[data-testid="commands-list"]')).toBeNull();
  });

  it('navigates the Commands list with arrow keys and closes with Escape', async () => {
    const served = serve([
      Stream.make(liveWith({ commands: [agentCommand('review', 'Review')] })).pipe(
        Stream.concat(Stream.never),
      ),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() => expect(byTestId(fixture, 'composer-input')).not.toBeNull());

    type(fixture, '/revi');
    await vi.waitFor(() => expect(byTestId(fixture, 'commands-list')).not.toBeNull());

    press(fixture, 'ArrowDown');
    press(fixture, 'Enter');
    await vi.waitFor(() => expect(composer(fixture).value).toBe('/review '));

    type(fixture, '/');
    press(fixture, 'Escape');
    fixture.detectChanges();
    expect(root(fixture).querySelector('[data-testid="commands-list"]')).toBeNull();
  });

  it('renders finished Turn file diffs with the shared Changes patch renderer', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          live,
          started(),
          userMessage('Edit the file'),
          step({
            kind: 'edit',
            status: 'done',
            diffs: [{ path: 'src/view.ts', before: 'same\nbefore', after: 'same\nafter' }],
          }),
          ended(),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="receipt"] button')).not.toBeNull();
    });
    root(fixture).querySelector<HTMLButtonElement>('[data-testid="receipt"] button')?.click();
    fixture.detectChanges();
    const patch = root(fixture).querySelector('[data-testid="file-diff"] app-diff-patch');
    expect(patch).not.toBeNull();
    const lines = patch?.querySelectorAll('[data-testid="diff-line"]');
    expect(lines).toHaveLength(3);
    expect(lines?.[0]?.children[0]?.textContent?.trim()).toBe('1');
    expect(lines?.[0]?.children[1]?.textContent?.trim()).toBe('1');
    expect(lines?.[1]?.children[0]?.textContent?.trim()).toBe('2');
    expect(lines?.[1]?.textContent).toContain('before');
    expect(lines?.[1]?.classList.contains('bg-diff-del/10')).toBe(true);
    expect(lines?.[2]?.children[1]?.textContent?.trim()).toBe('2');
    expect(lines?.[2]?.textContent).toContain('after');
    expect(lines?.[2]?.classList.contains('bg-diff-add/10')).toBe(true);
  });
  it('folds older Agent updates in a long Turn and lets the user reveal them', async () => {
    const beginning = [live, started(), userMessage('Work')];
    const updates = Array.from({ length: 8 }, (_, index) =>
      event({
        _tag: 'Message',
        id: MessageId.make(`update-${index}`),
        turnId,
        role: 'agent',
        parts: [{ _tag: 'text', text: `Update ${index}` }],
      }),
    );
    const fixture = mount(
      serve([Stream.make(...beginning, ...updates, ended()).pipe(Stream.concat(Stream.never))]),
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelectorAll('[data-testid="message-agent"]')).toHaveLength(3);
    });
    byTestId(fixture, 'show-earlier-updates').click();
    fixture.detectChanges();
    expect(root(fixture).querySelectorAll('[data-testid="message-agent"]')).toHaveLength(8);
  });
  it('keeps the highlighted command visible when navigating with arrow keys', async () => {
    const served = serve([
      Stream.make(liveWith({ commands: [agentCommand('review', 'Review')] })).pipe(
        Stream.concat(Stream.never),
      ),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() => expect(byTestId(fixture, 'composer-input')).not.toBeNull());
    type(fixture, '/');
    await vi.waitFor(() => expect(byTestId(fixture, 'command-Claude:review')).not.toBeNull());

    const review = byTestId(fixture, 'command-Claude:review');
    const scrollIntoView = vi.fn();
    review.scrollIntoView = scrollIntoView;
    press(fixture, 'ArrowDown');
    press(fixture, 'ArrowDown');
    press(fixture, 'ArrowDown');
    press(fixture, 'ArrowDown');

    expect(review.getAttribute('aria-selected')).toBe('true');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('groups entries by owner, keeps kind and owner distinct, and shows hints without inserting them', async () => {
    const served = serve([
      Stream.make(
        liveWith({
          commands: [
            agentCommand('review', 'Review the changes', 'branch or focus', 'Claude', 'skill'),
            agentCommand('status', 'Inspect the Session'),
          ],
        }),
      ).pipe(Stream.concat(Stream.never)),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() => expect(byTestId(fixture, 'composer-input')).not.toBeNull());

    type(fixture, '/');
    await vi.waitFor(() => expect(byTestId(fixture, 'commands-list')).not.toBeNull());

    const element = root(fixture);
    const labels = [...element.querySelectorAll('[data-slot="command-group-label"]')].map((label) =>
      label.textContent?.trim(),
    );
    expect(labels).toEqual(['Spence', 'Claude']);

    const review = element.querySelector('[data-testid="command-Claude:review"]');
    expect(review?.textContent).toContain('/review');
    expect(review?.textContent).toContain('Skill');
    expect(review?.textContent).toContain('Claude');
    expect(review?.textContent).toContain('branch or focus');
    expect(element.textContent).toContain('Command');

    type(fixture, '/review');
    press(fixture, 'Enter');
    await vi.waitFor(() => expect(composer(fixture).value).toBe('/review '));
    expect(served.prompts).toEqual([]);
  });

  it('reserves clear and compact for Spence and keeps other equal names as separate identities', async () => {
    const served = serve([
      Stream.make(
        liveWith({
          commands: [
            agentCommand('clear', 'Agent clear'),
            agentCommand('compact', 'Agent compact'),
            {
              id: 'Claude:one',
              name: 'same',
              invocation: '/same',
              owner: { kind: 'agent', name: 'Claude' },
              kind: 'command',
              description: 'First',
            },
            {
              id: 'Claude:two',
              name: 'same',
              invocation: '/same',
              owner: { kind: 'agent', name: 'Claude' },
              kind: 'command',
              description: 'Second',
            },
          ],
        }),
      ).pipe(Stream.concat(Stream.never)),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() => expect(byTestId(fixture, 'composer-input')).not.toBeNull());

    type(fixture, '/');
    await vi.waitFor(() => expect(byTestId(fixture, 'commands-list')).not.toBeNull());
    const element = root(fixture);
    expect(element.querySelector('[data-testid="command-Claude:clear"]')).toBeNull();
    expect(element.querySelector('[data-testid="command-Claude:compact"]')).toBeNull();
    expect(element.querySelector('[data-testid="command-Claude:one"]')).not.toBeNull();
    expect(element.querySelector('[data-testid="command-Claude:two"]')).not.toBeNull();
  });

  it('distinguishes loading, known-empty and no-match states while preserving the draft across catalog updates', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerUnsafe(
      queue,
      liveWith({ agentStatus: 'starting', commandsLoaded: false, commands: [] }),
    );
    await vi.waitFor(() => expect(byTestId(fixture, 'composer-input')).not.toBeNull());

    type(fixture, '/');
    await vi.waitFor(() =>
      expect(byTestId(fixture, 'commands-status').textContent).toContain('Loading Agent actions'),
    );

    Queue.offerUnsafe(queue, liveWith({ commandsLoaded: true, commands: [] }));
    await vi.waitFor(() =>
      expect(byTestId(fixture, 'commands-status').textContent).toContain(
        'No Agent actions advertised',
      ),
    );

    type(fixture, '/nothing');
    await vi.waitFor(() =>
      expect(byTestId(fixture, 'commands-list').textContent).toContain('No commands match'),
    );

    type(fixture, '/rev');
    Queue.offerUnsafe(
      queue,
      liveWith({
        commands: [agentCommand('review', 'Review the changes')],
      }),
    );
    await vi.waitFor(() =>
      expect(root(fixture).querySelector('[data-testid="command-Claude:review"]')).not.toBeNull(),
    );
    expect(composer(fixture).value).toBe('/rev');
  });

  it('does not send when a command is selected with Tab', async () => {
    const served = serve([
      Stream.make(liveWith({ commands: [agentCommand('review', 'Review')] })).pipe(
        Stream.concat(Stream.never),
      ),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() => expect(byTestId(fixture, 'composer-input')).not.toBeNull());

    type(fixture, '/rev');
    press(fixture, 'Tab');
    await vi.waitFor(() => expect(composer(fixture).value).toBe('/review '));
    expect(served.prompts).toEqual([]);
  });

  it('sends an unknown `/word` as text', async () => {
    const served = serve([Stream.make(live).pipe(Stream.concat(Stream.never))]);
    const fixture = mount(served);
    await vi.waitFor(() => expect(byTestId(fixture, 'composer-input')).not.toBeNull());

    type(fixture, '/unknown');
    await vi.waitFor(() => expect(byTestId(fixture, 'commands-list')).not.toBeNull());

    press(fixture, 'Enter');
    await vi.waitFor(() => expect(served.prompts).toEqual([[{ _tag: 'text', text: '/unknown' }]]));
  });

  it('arms Coordinator without sending the command to the Agent', async () => {
    const served = serve([Stream.make(liveWith()).pipe(Stream.concat(Stream.never))]);
    const fixture = mount(served);
    type(fixture, '/coordinate');
    press(fixture, 'Enter');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'coordinate-armed')).not.toBeNull();
    });
    expect(served.prompts).toEqual([]);
    type(fixture, 'Implement the task');
    press(fixture, 'Enter');
    await vi.waitFor(() => expect(served.promptWorkflows).toEqual(['coordinate']));
    await vi.waitFor(() => expect(composer(fixture).value).toBe(''));
    type(fixture, 'Follow up');
    press(fixture, 'Enter');
    await vi.waitFor(() => expect(served.promptWorkflows).toEqual(['coordinate', undefined]));
  });

  it('arms Divide and Conquer from its command and consumes it on the next Turn', async () => {
    const served = serve([Stream.make(liveWith()).pipe(Stream.concat(Stream.never))]);
    const fixture = mount(served);
    type(fixture, '/divide-and-conquer');
    press(fixture, 'Enter');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'divide-and-conquer-armed')).not.toBeNull();
    });
    expect(served.prompts).toEqual([]);
    type(fixture, 'Implement in stages');
    press(fixture, 'Enter');
    await vi.waitFor(() => expect(served.promptWorkflows).toEqual(['divide-and-conquer']));
    await vi.waitFor(() => expect(composer(fixture).value).toBe(''));
    type(fixture, 'Ordinary follow-up');
    press(fixture, 'Enter');
    await vi.waitFor(() =>
      expect(served.promptWorkflows).toEqual(['divide-and-conquer', undefined]),
    );
  });

  it('offers verification again for an eligible Turn and submits only its source id', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [
      liveWith(),
      started(),
      userMessage('Implement the task'),
      ended({ _tag: 'failed', reason: 'agentError', detail: 'Verification incomplete' }),
    ]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'outcome').textContent).toContain('Verification incomplete');
    });
    expect(root(fixture).querySelector('[data-testid="verify-again"]')).toBeNull();
    Queue.offerUnsafe(
      queue,
      liveWith({ verificationRetries: [{ turnId, originalTurnId: turnId }] }),
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'verify-again').textContent).toContain('Verify again');
    });
    byTestId(fixture, 'verify-again').click();
    await vi.waitFor(() => expect(served.verificationRequests).toEqual([turnId]));
    expect(served.prompts).toEqual([[]]);
  });

  it('intercepts `/clear` always and `/compact` only when supportsCompaction is true', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerUnsafe(
      queue,
      liveWith({
        capabilities: capabilitiesWith(true),
        commands: [agentCommand('compact', 'Compact')],
      }),
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        (
          fixture.componentInstance as unknown as { agentStatus: () => string | undefined }
        ).agentStatus(),
      ).toBe('ready');
    });

    type(fixture, '/clear');
    press(fixture, 'Enter');
    await vi.waitFor(() => expect(served.clears).toBe(1));
    await vi.waitFor(() => expect(composer(fixture).value).toBe(''));
    expect(served.prompts).toEqual([]);

    type(fixture, '/compact');
    press(fixture, 'Enter');
    await vi.waitFor(() => expect(served.compacts).toBe(1));
    expect(served.prompts).toEqual([]);

    // When supportsCompaction is false, `/compact` picks as an Agent Command and sends as text.
    Queue.offerUnsafe(
      queue,
      liveWith({
        agentName: 'Codex',
        capabilities: capabilitiesWith(false),
        commands: [agentCommand('compact', 'Compact', undefined, 'Codex')],
      }),
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        (
          fixture.componentInstance as unknown as { supportsCompaction: () => boolean }
        ).supportsCompaction(),
      ).toBe(false);
    });
    type(fixture, '/compact');
    press(fixture, 'Enter');
    await vi.waitFor(() => expect(composer(fixture).value).toBe('/compact '));
    press(fixture, 'Enter');
    await vi.waitFor(() => expect(served.prompts).toEqual([[{ _tag: 'text', text: '/compact ' }]]));
    expect(served.compacts).toBe(1);
  });

  it('publishes Compact, Clear and Switch (never Fork) to the top bar and runs them, leaving Mod+K alone', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    const toolbar = TestBed.inject(SessionToolbar);
    Queue.offerUnsafe(
      queue,
      liveWith({ capabilities: capabilitiesWith(true), agentName: 'Claude' }),
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        (
          fixture.componentInstance as unknown as { agentStatus: () => string | undefined }
        ).agentStatus(),
      ).toBe('ready');
    });

    // The Composer no longer carries a launcher; Mod+K and Mod+Shift+K belong to the shell.
    expect(root(fixture).querySelector('[data-testid="session-actions-trigger"]')).toBeNull();

    const entry = toolbar.entryFor(sessionId);
    expect(entry?.actions().map((action) => action.id)).toEqual([
      'compact',
      'clear',
      'coordinate',
      'divide-and-conquer',
      'switch-agent',
    ]);
    expect(entry?.actions().every((action) => !action.disabled)).toBe(true);

    entry?.run('Coordinate');
    fixture.detectChanges();
    expect(byTestId(fixture, 'coordinate-armed')).not.toBeNull();
    entry?.run('Divide and Conquer');
    fixture.detectChanges();
    expect(byTestId(fixture, 'divide-and-conquer-armed')).not.toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(composer(fixture)));
    entry?.run('Clear');
    await vi.waitFor(() => expect(served.clears).toBe(1));
    entry?.run('Compact');
    await vi.waitFor(() => expect(served.compacts).toBe(1));
  });

  it('gates the actions while a Turn or Compaction runs and explains supportsCompaction false', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    const toolbar = TestBed.inject(SessionToolbar);
    Queue.offerUnsafe(
      queue,
      liveWith({ capabilities: capabilitiesWith(false), agentName: 'Claude' }),
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        (
          fixture.componentInstance as unknown as { agentStatus: () => string | undefined }
        ).agentStatus(),
      ).toBe('ready');
    });
    const action = (id: string) =>
      toolbar
        .entryFor(sessionId)
        ?.actions()
        .find((candidate) => candidate.id === id);

    // Idle with supportsCompaction: false -> Compact disabled with an explanation, Clear enabled.
    expect(action('compact')?.disabled).toBe(true);
    expect(action('compact')?.reason).toContain('Claude');
    expect(action('clear')?.disabled).toBe(false);

    // While a Turn runs -> every action is disabled and says why.
    Queue.offerAllUnsafe(queue, [
      liveWith({ capabilities: capabilitiesWith(true), runningTurn: turnId }),
      started(),
      userMessage('Hi'),
    ]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      for (const id of ['compact', 'clear', 'switch-agent']) {
        expect(action(id)?.disabled).toBe(true);
        expect(action(id)?.reason).toMatch(/finish|stop/i);
      }
    });
    expect(served.cancels).toBe(0);

    // Standalone Compaction running -> Stop button + Esc cancel it, and Send is disabled.
    Queue.offerAllUnsafe(queue, [
      ended({ _tag: 'done' }),
      liveWith({ capabilities: capabilitiesWith(true), compacting: true }),
      event({ _tag: 'Compaction', id: CompactionId.make('c-run'), status: 'running', summary: '' }),
    ]);
    await vi.waitFor(() => expect(byTestId(fixture, 'stop')).not.toBeNull());
    type(fixture, 'wait');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(sendButton(fixture).disabled).toBe(true);
    });
    byTestId(fixture, 'stop').click();
    await vi.waitFor(() => expect(served.cancels).toBe(1));
  });

  it('shows a divider in the thread when the context is cleared', async () => {
    const fixture = mount(
      serve([
        Stream.make(live, started(), userMessage('Before'), agentMessage('Reply'), ended(), {
          _tag: 'Transcript',
          event: { seq: 5, at: 5, item: { _tag: 'ContextCleared', reason: 'cleared' } },
        }).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => expect(messages(fixture, 'user')).toEqual(['Before']));
    await vi.waitFor(() =>
      expect(
        (
          fixture.componentInstance as unknown as {
            thread: () => { dividers: ReadonlyArray<unknown> };
          }
        ).thread().dividers.length,
      ).toBe(1),
    );
    const dividers = root(fixture).querySelectorAll('[data-testid="context-divider"]');
    expect(dividers.length).toBe(1);
    expect(dividers[0]?.textContent?.trim()).toContain('Context cleared');
  });

  it('shows the Ticker while a Turn runs and the Receipt when it ends', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const fixture = mount(serve([Stream.fromQueue(queue)]));

    Queue.offerAllUnsafe(queue, [live, started(), userMessage('Hi'), plan(), step()]);
    await vi.waitFor(() => expect(ticker(fixture)).not.toBeNull());
    expect(ticker(fixture)?.querySelectorAll('ng-icon')).toHaveLength(2);
    expect(ticker(fixture)?.getAttribute('title')).toContain('Reading');
    expect(receipt(fixture)).toBeNull();
    expect(dock(fixture)?.textContent).toContain('Plan 0 of 1');
    expect(dock(fixture)?.querySelectorAll('[data-plan-segment]')).toHaveLength(1);

    Queue.offerAllUnsafe(queue, [agentMessage('Done')]);
    await vi.waitFor(() =>
      expect(root(fixture).querySelector('[data-testid="message-agent"]')).not.toBeNull(),
    );
    const agent = root(fixture).querySelector('[data-testid="message-agent"]');
    if (agent === null) throw new Error('Agent Message missing');
    expect(ticker(fixture)?.compareDocumentPosition(agent)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    Queue.offerAllUnsafe(queue, [ended()]);
    await vi.waitFor(() => expect(receipt(fixture)).not.toBeNull());
    expect(ticker(fixture)).toBeNull();
    expect(dock(fixture)?.textContent?.trim()).toBe('');
  });

  it('shows Notices and Compactions in the thread', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          live,
          started(),
          userMessage('Hi'),
          notice(),
          compaction(),
          agentMessage('Done'),
          ended(),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => expect(messages(fixture, 'agent')).toEqual(['Done']));
    const rootElement = root(fixture);
    expect(rootElement.textContent).toContain('Slow');
    expect(rootElement.textContent).toContain('Summary');
  });

  it('counts repeated added lines in a changed file', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          live,
          started(),
          userMessage('Hi'),
          step({
            kind: 'edit',
            diffs: [{ path: 'a.ts', before: 'same\n', after: 'same\nsame\n' }],
          }),
          agentMessage('Done'),
          ended(),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => expect(receipt(fixture)).not.toBeNull());
    expect(receipt(fixture)?.textContent).toContain('+1');
  });

  it('shows the combined changes when multiple Steps edit the same file', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          live,
          started(),
          userMessage('Hi'),
          step({ kind: 'edit', diffs: [{ path: 'a.ts', before: 'one', after: 'one\ntwo' }] }),
          step({
            id: StepId.make('step-2'),
            kind: 'edit',
            diffs: [{ path: 'a.ts', before: 'one\ntwo', after: 'one\ntwo\nthree' }],
          }),
          agentMessage('Done'),
          ended(),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => expect(receipt(fixture)).not.toBeNull());
    expect(receipt(fixture)?.textContent).toContain('+2');
  });

  it('uses singular step label when a Receipt has 1 step and plural for multiple steps', async () => {
    const turn2 = TurnId.make('turn-2');
    const fixture = mount(
      serve([
        Stream.make(
          live,
          started(),
          userMessage('Hi'),
          step(),
          agentMessage('Done'),
          ended(),
          event({ _tag: 'TurnStarted', turnId: turn2, permissionMode: 'auto' }),
          event({
            _tag: 'Message',
            id: MessageId.make('user-2'),
            turnId: turn2,
            role: 'user',
            parts: [{ _tag: 'text', text: 'Again' }],
          }),
          step({ id: StepId.make('step-2'), turnId: turn2 }),
          step({ id: StepId.make('step-3'), turnId: turn2 }),
          event({
            _tag: 'Message',
            id: MessageId.make('agent-2'),
            turnId: turn2,
            role: 'agent',
            parts: [{ _tag: 'text', text: 'Done again' }],
          }),
          event({ _tag: 'TurnEnded', turnId: turn2, outcome: { _tag: 'done' } }),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() =>
      expect(root(fixture).querySelectorAll('[data-testid="receipt"]')).toHaveLength(2),
    );
    const receipts = [...root(fixture).querySelectorAll('[data-testid="receipt"]')];
    expect(receipts[0]?.textContent).toContain('1 step');
    expect(receipts[0]?.textContent).not.toContain('1 steps');
    expect(receipts[1]?.textContent).toContain('2 steps');
  });

  it('shows Failed aria-label on failed steps in the Receipt', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          live,
          started(),
          userMessage('Hi'),
          step({ status: 'failed' }),
          agentMessage('Done'),
          ended(),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => expect(receipt(fixture)).not.toBeNull());
    expect(
      receipt(fixture)?.querySelector('[data-testid="receipt-step"] [aria-label="Failed"]'),
    ).not.toBeNull();
  });

  it('keeps Receipt steps collapsed by default, shows tabular-nums durations with slow highlight >= 10s, and toggles Step details on click', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          live,
          started(),
          userMessage('Run and fix'),
          step({
            id: StepId.make('fast-step'),
            kind: 'edit',
            title: 'Edit src/view.ts',
            status: 'done',
            files: ['src/view.ts'],
            diffs: [{ path: 'src/view.ts', before: 'old line', after: 'new line' }],
            input: JSON.stringify({
              file_path: 'src/view.ts',
              old_string: 'old line',
              new_string: 'new line',
            }),
            output: 'Updated src/view.ts',
            startedAt: 1_000,
            endedAt: 2_500,
          }),
          step({
            id: StepId.make('slow-step'),
            kind: 'execute',
            title: 'npm test',
            status: 'failed',
            files: [],
            diffs: [],
            cwd: '/work/demo',
            input: 'npm test',
            output: 'FAIL src/view.spec.ts',
            exitCode: 1,
            outputTruncated: true,
            startedAt: 3_000,
            endedAt: 15_000,
          }),
          agentMessage('Finished'),
          ended(),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => expect(receipt(fixture)).not.toBeNull());
    const rec = receipt(fixture)!;

    // "N steps" trigger starts collapsed by default.
    const stepsTrigger = rec.querySelector<HTMLButtonElement>('[hlmTraceCollapsibleTrigger]');
    expect(stepsTrigger?.getAttribute('aria-expanded')).toBe('false');
    stepsTrigger?.click();
    fixture.detectChanges();
    expect(stepsTrigger?.getAttribute('aria-expanded')).toBe('true');

    // Step rows start collapsed, show tabular-nums durations, and highlight >= 10s steps.
    const stepRows = [...rec.querySelectorAll<HTMLButtonElement>('[data-testid="receipt-step"]')];
    expect(stepRows).toHaveLength(2);
    expect(stepRows[0]?.getAttribute('aria-expanded')).toBe('false');
    expect(stepRows[1]?.getAttribute('aria-expanded')).toBe('false');
    expect(rec.querySelector('[data-testid="receipt-step-details"]')).toBeNull();

    const durations = [
      ...rec.querySelectorAll<HTMLElement>('[data-testid="receipt-step-duration"]'),
    ];
    expect(durations).toHaveLength(2);
    expect(durations[0]?.textContent?.trim()).toBe('1.5s');
    expect(durations[0]?.classList.contains('tabular-nums')).toBe(true);
    expect(durations[0]?.getAttribute('data-slow')).toBeNull();
    expect(durations[1]?.textContent?.trim()).toBe('12s');
    expect(durations[1]?.classList.contains('tabular-nums')).toBe(true);
    expect(durations[1]?.getAttribute('data-slow')).toBe('true');

    // Clicking the slow execute Step opens its inline detail area.
    stepRows[1]?.click();
    fixture.detectChanges();
    expect(stepRows[1]?.getAttribute('aria-expanded')).toBe('true');
    const slowDetails = rec.querySelector('[data-testid="receipt-step-details"]');
    expect(slowDetails).not.toBeNull();
    expect(slowDetails?.querySelector('[data-testid="receipt-step-input"]')?.textContent).toContain(
      'npm test',
    );
    expect(
      slowDetails?.querySelector('[data-testid="receipt-step-output"]')?.textContent,
    ).toContain('FAIL src/view.spec.ts');
    expect(slowDetails?.querySelector('[data-testid="receipt-step-truncated"]')).not.toBeNull();
    expect(
      slowDetails?.querySelector('[data-testid="receipt-step-exit-code"]')?.textContent,
    ).toContain('1');

    // Clicking the edit Step opens its inline diff patch too.
    stepRows[0]?.click();
    fixture.detectChanges();
    const diffPatches = rec.querySelectorAll('[data-testid="receipt-step-diff"] app-diff-patch');
    expect(diffPatches).toHaveLength(1);
    expect(diffPatches[0]?.textContent).toContain('new line');

    // Clicking again collapses the detail block.
    stepRows[1]?.click();
    fixture.detectChanges();
    expect(stepRows[1]?.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows streamed StepDelta output and exitCode in Receipt Step inspection across final Step updates', async () => {
    const termStepId = StepId.make('term-step-1');
    const fixture = mount(
      serve([
        Stream.make(
          live,
          started(),
          step({
            id: termStepId,
            kind: 'execute',
            title: 'node stream',
            status: 'running',
            files: [],
            diffs: [],
            output: '',
            startedAt: 1_000,
          }),
          event({ _tag: 'StepDelta', id: termStepId, output: 'first-line\n' }),
          event({ _tag: 'StepDelta', id: termStepId, output: 'second-line\n', truncated: true }),
          step({
            id: termStepId,
            kind: 'execute',
            title: 'node stream',
            status: 'failed',
            files: [],
            diffs: [],
            output: '',
            exitCode: 2,
            startedAt: 1_000,
            endedAt: 2_000,
          }),
          agentMessage('terminal done'),
          ended(),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => expect(receipt(fixture)).not.toBeNull());
    const rec = receipt(fixture)!;

    rec.querySelector<HTMLButtonElement>('[hlmTraceCollapsibleTrigger]')?.click();
    fixture.detectChanges();
    const stepRow = rec.querySelector<HTMLButtonElement>('[data-testid="receipt-step"]');
    expect(stepRow).not.toBeNull();
    stepRow?.click();
    fixture.detectChanges();

    const details = rec.querySelector('[data-testid="receipt-step-details"]');
    expect(details?.querySelector('[data-testid="receipt-step-output"]')?.textContent).toContain(
      'first-line\nsecond-line',
    );
    expect(details?.querySelector('[data-testid="receipt-step-truncated"]')).not.toBeNull();
    expect(details?.querySelector('[data-testid="receipt-step-exit-code"]')?.textContent).toContain(
      '2',
    );
  });

  it('shows a failed outcome as a red block with the Agent text verbatim', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          live,
          started(),
          userMessage('Hi'),
          agentMessage('Done'),
          ended({ _tag: 'failed', reason: 'agentError', detail: 'Something broke' }),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => expect(receipt(fixture)).not.toBeNull());
    const outcome = root(fixture).querySelector('[data-testid="outcome"]');
    expect(outcome?.textContent).toContain('Something broke');
    expect(outcome?.className).toContain('text-destructive');
  });

  it('describes an Agent crash and folds the diagnostic detail', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          liveWith({ agentName: 'Claude' }),
          started(),
          userMessage('Hi'),
          ended({ _tag: 'failed', reason: 'agentStopped', detail: 'exit code 3' }),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => expect(receipt(fixture)).not.toBeNull());
    const outcome = root(fixture).querySelector('[data-testid="outcome"]');
    expect(outcome?.textContent).toContain('Claude stopped unexpectedly');
    expect(outcome?.querySelector('details')?.textContent).toContain('exit code 3');
  });

  it('translates an interrupted Turn outcome instead of showing raw persisted detail', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          live,
          started(),
          userMessage('Hi'),
          ended({
            _tag: 'failed',
            reason: 'interrupted',
            detail: 'raw persisted detail',
          }),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => expect(receipt(fixture)).not.toBeNull());
    const outcome = root(fixture).querySelector('[data-testid="outcome"]');
    expect(outcome?.textContent).toContain('Spence closed while the Turn was running');
    expect(outcome?.textContent).not.toContain('raw persisted detail');
  });

  it('falls back to Agent when agentName is absent', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          liveWith({ agentStatus: 'cantStart', cantStartReason: 'spawn' }),
          started(),
          userMessage('Hi'),
          ended({ _tag: 'failed', reason: 'agentStopped', detail: 'exit code 3' }),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => expect(receipt(fixture)).not.toBeNull());
    expect(root(fixture).querySelector('[data-testid="outcome"]')?.textContent).toContain(
      'Agent stopped unexpectedly',
    );
    expect(byTestId(fixture, 'agent-bar').textContent).toContain("Agent couldn't start");
  });

  it('keeps the Composer editable but blocks sending while the Agent cannot start', async () => {
    const served = serve([
      Stream.make(
        liveWith({ agentName: 'Claude', agentStatus: 'cantStart', cantStartReason: 'spawn' }),
      ).pipe(Stream.concat(Stream.never)),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() => expect(byTestId(fixture, 'composer-input')).not.toBeNull());
    type(fixture, 'Keep this draft');
    expect(composer(fixture).value).toBe('Keep this draft');
    expect((byTestId(fixture, 'send') as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId(fixture, 'agent-bar').textContent).toContain("Claude couldn't start");
    byTestId(fixture, 'agent-retry').click();
    await vi.waitFor(() => expect(served.retries).toBe(1));
    byTestId(fixture, 'open-agent-log').click();
    await vi.waitFor(() => expect(served.logs).toBe(1));
  });

  it('embeds the install offer when notInstalled and retries when installed emits', async () => {
    const served = serve([
      Stream.make(
        liveWith({
          agentName: 'Claude',
          agentId: AgentId.make('claude'),
          agentPackage: '@agentclientprotocol/claude-agent-acp',
          agentStatus: 'notInstalled',
        }),
      ).pipe(Stream.concat(Stream.never)),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() =>
      expect(root(fixture).querySelector('[data-testid="install-offer-stub"]')).not.toBeNull(),
    );
    expect(byTestId(fixture, 'install-offer-stub').textContent).toContain(
      '@agentclientprotocol/claude-agent-acp',
    );
    type(fixture, 'Draft while installing');
    expect((byTestId(fixture, 'send') as HTMLButtonElement).disabled).toBe(true);
    byTestId(fixture, 'stub-install-done').click();
    await vi.waitFor(() => expect(served.retries).toBe(1));
  });

  it('shows the incompatible adapter message and @latest command with no Try again on protocolVersion error', async () => {
    const served = serve([
      Stream.make(
        liveWith({
          agentName: 'Claude',
          agentPackage: '@agentclientprotocol/claude-agent-acp',
          agentStatus: 'cantStart',
          cantStartReason: 'protocolVersion',
        }),
      ).pipe(Stream.concat(Stream.never)),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() =>
      expect(root(fixture).querySelector('[data-testid="agent-bar"]')).not.toBeNull(),
    );
    const bar = byTestId(fixture, 'agent-bar');
    expect(bar.textContent).toContain("Claude's adapter isn't compatible with this Spence");
    expect(bar.textContent).toContain(
      'npm install -g @agentclientprotocol/claude-agent-acp@latest',
    );
    expect(root(fixture).querySelector('[data-testid="agent-retry"]')).toBeNull();
  });

  it('shows the login bar, runs loginAgent, lists Other ways, and cancels on Cancel', async () => {
    const gate = Deferred.makeUnsafe<void>();
    const served = serve([
      Stream.make(
        liveWith({
          agentName: 'Claude',
          agentStatus: 'needsLogin',
          authMethods: [
            {
              id: 'claudeai',
              name: 'Claude.ai',
              command: 'claude-agent-acp --cli auth login --claudeai',
            },
            {
              id: 'api-key',
              name: 'Anthropic API Key',
              command: 'claude-agent-acp --cli auth login --api-key',
            },
          ],
        }),
      ).pipe(Stream.concat(Stream.never)),
    ]);
    served.loginEffect = Deferred.await(gate);
    const fixture = mount(served);
    await vi.waitFor(() =>
      expect(root(fixture).querySelector('[data-testid="agent-login"]')).not.toBeNull(),
    );
    expect(byTestId(fixture, 'agent-bar').textContent).toContain('Claude needs to log in');
    type(fixture, 'Draft before login');
    expect((byTestId(fixture, 'send') as HTMLButtonElement).disabled).toBe(true);

    byTestId(fixture, 'agent-login').click();
    await vi.waitFor(() => expect(served.logins).toBe(1));
    await vi.waitFor(() =>
      expect(root(fixture).querySelector('[data-testid="agent-login-cancel"]')).not.toBeNull(),
    );
    const barText = byTestId(fixture, 'agent-bar').textContent ?? '';
    expect(barText).toContain('Finish logging in in your browser…');
    expect(barText).toContain('Other ways');
    expect(barText).toContain('Anthropic API Key');
    expect(barText).toContain('claude-agent-acp --cli auth login --api-key');

    byTestId(fixture, 'agent-login-cancel').click();
    await vi.waitFor(() => expect(served.loginCancelled).toBe(true));
    await vi.waitFor(() =>
      expect(root(fixture).querySelector('[data-testid="agent-login"]')).not.toBeNull(),
    );
  });

  it('shows loginInstructions on needsLogin when provided', async () => {
    const served = serve([
      Stream.make(
        liveWith({
          agentName: 'Codex',
          agentStatus: 'needsLogin',
          loginInstructions:
            'Sign in with your ChatGPT account using Log in, or run `codex login` in a terminal and then Try again.',
        }),
      ).pipe(Stream.concat(Stream.never)),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() =>
      expect(
        root(fixture).querySelector('[data-testid="agent-login-instructions"]'),
      ).not.toBeNull(),
    );
    expect(byTestId(fixture, 'agent-login-instructions').textContent).toContain('ChatGPT');
  });

  it('shows Folder not found when folderMissing and clears it after Locate', async () => {
    const projectId = ProjectId.make('proj-1');
    const missingProject: Project = {
      id: projectId,
      name: 'App',
      path: '/missing/app',
      addedAt: 1,
      lastUsedAt: 1,
      settings: {},
      folderMissing: true,
    };
    const served = serve([Stream.make(live).pipe(Stream.concat(Stream.never))]);
    served.project = missingProject;
    served.located = { ...missingProject, path: '/found/app', folderMissing: false };
    const fixture = mount(served, { projectId });

    await vi.waitFor(() =>
      expect(root(fixture).querySelector('[data-testid="locate-folder"]')).not.toBeNull(),
    );
    expect(byTestId(fixture, 'agent-bar').textContent).toContain('Folder not found');
    type(fixture, 'Hello');
    expect((byTestId(fixture, 'send') as HTMLButtonElement).disabled).toBe(true);

    byTestId(fixture, 'locate-folder').click();
    await vi.waitFor(() => expect(served.locates).toBe(1));
    await vi.waitFor(() =>
      expect(root(fixture).querySelector('[data-testid="locate-folder"]')).toBeNull(),
    );
    expect((byTestId(fixture, 'send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the Dock for a pending Permission request and answers it', async () => {
    const options: ReadonlyArray<PermissionOption> = [
      { id: 'reject', label: 'Reject', kind: 'rejectOnce' },
      { id: 'allow', label: 'Allow once', kind: 'allowOnce' },
    ];
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [
      live,
      started(),
      userMessage('Run it'),
      permissionStep('s1', 'ls -la'),
    ]);

    await vi.waitFor(() => expect(root(fixture).querySelector('[data-testid="dock"]')).toBeNull());

    Queue.offerUnsafe(queue, permissionRequest('p1', 's1', options));
    await vi.waitFor(() =>
      expect(root(fixture).querySelector('[data-testid="dock-title"]')?.textContent?.trim()).toBe(
        'ls -la',
      ),
    );

    const buttons = root(fixture).querySelectorAll('[data-testid="dock-option"]');
    expect(buttons).toHaveLength(2);
    // allow-once is first and primary.
    expect(buttons[0]?.textContent?.trim()).toContain('Allow once');
    expect(buttons[1]?.textContent?.trim()).toContain('Reject');

    (buttons[0] as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(served.answers).toEqual([
        { requestId: PermissionRequestId.make('p1'), optionId: 'allow' },
      ]),
    );
  });

  it('shows a workflow approval in the parent dock and answers it there', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [
      liveWith(),
      started(),
      userMessage('Run the workflow'),
      event({
        _tag: 'PermissionRequest',
        id: PermissionRequestId.make('workflow-approval'),
        turnId,
        stepId: StepId.make('worker-step'),
        options: [{ id: 'allow', label: 'Allow once', kind: 'allowOnce' }],
        state: { _tag: 'pending' },
        workflowSource: { role: 'Verifier', agentName: 'Claude', title: 'Run checks' },
      }),
    ]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'workflow-permission-source').textContent).toContain('Verifier');
      expect(byTestId(fixture, 'workflow-permission-source').textContent).toContain('Claude');
      expect(byTestId(fixture, 'dock-title').textContent).toBe('Run checks');
    });
    byTestId(fixture, 'dock-option').click();
    await vi.waitFor(() => expect(served.answeredSessions).toEqual([sessionId]));
    expect(served.answers).toEqual([
      { requestId: PermissionRequestId.make('workflow-approval'), optionId: 'allow' },
    ]);
  });

  it('answers a Worker Permission request in the Worker chat, addressed to that Worker, without navigating', async () => {
    const options: ReadonlyArray<PermissionOption> = [
      { id: 'allow', label: 'Allow once', kind: 'allowOnce' },
    ];
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [
      liveWith({ parentSessionId: SessionId.make('parent-1'), workerKind: 'owned' }),
      started(),
      userMessage('Run it'),
      permissionStep('s1', 'ls -la'),
      permissionRequest('p1', 's1', options),
    ]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="dock-title"]')?.textContent?.trim()).toBe(
        'ls -la',
      );
    });
    expect(TestBed.inject(Tabs).active()).toBeNull();
    (root(fixture).querySelector('[data-testid="dock-option"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(served.answeredSessions).toEqual([sessionId]));
    expect(served.answers).toEqual([
      { requestId: PermissionRequestId.make('p1'), optionId: 'allow' },
    ]);
    expect(TestBed.inject(Tabs).active()).toBeNull();
  });

  it('ignores a second answer when the request is no longer pending', async () => {
    const options: ReadonlyArray<PermissionOption> = [
      { id: 'allow', label: 'Allow once', kind: 'allowOnce' },
    ];
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [
      live,
      started(),
      userMessage('Run it'),
      permissionStep('s1', 'ls -la'),
      permissionRequest('p1', 's1', options),
    ]);

    await vi.waitFor(() =>
      expect(root(fixture).querySelectorAll('[data-testid="dock-option"]')).toHaveLength(1),
    );

    Queue.offerUnsafe(queue, permissionRequest('p1', 's1', options, 'answered'));
    await vi.waitFor(() => expect(root(fixture).querySelector('[data-testid="dock"]')).toBeNull());

    // The Dock is gone, so there is nothing to click; the answer RPC was never called.
    expect(served.answers).toEqual([]);
  });

  it('answers a Dock option with a bare digit key when focus is outside text', async () => {
    const options: ReadonlyArray<PermissionOption> = [
      { id: 'allow', label: 'Allow once', kind: 'allowOnce' },
      { id: 'reject', label: 'Reject', kind: 'rejectOnce' },
    ];
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [
      live,
      started(),
      userMessage('Run it'),
      permissionStep('s1', 'ls -la'),
      permissionRequest('p1', 's1', options),
    ]);

    await vi.waitFor(() =>
      expect(root(fixture).querySelectorAll('[data-testid="dock-option"]')).toHaveLength(2),
    );

    const keydown = pressWindow(fixture, '2', { code: 'Digit2' });
    expect(keydown.defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(served.answers).toEqual([
        { requestId: PermissionRequestId.make('p1'), optionId: 'reject' },
      ]),
    );
  });

  it('does not answer a digit key while the Composer has focus and text', async () => {
    const options: ReadonlyArray<PermissionOption> = [
      { id: 'allow', label: 'Allow once', kind: 'allowOnce' },
    ];
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [
      live,
      started(),
      userMessage('Run it'),
      permissionStep('s1', 'ls -la'),
      permissionRequest('p1', 's1', options),
    ]);

    await vi.waitFor(() =>
      expect(root(fixture).querySelectorAll('[data-testid="dock-option"]')).toHaveLength(1),
    );

    type(fixture, 'typing');
    composer(fixture).focus();
    const keydown = new KeyboardEvent('keydown', {
      key: '1',
      code: 'Digit1',
      cancelable: true,
      bubbles: true,
    });
    composer(fixture).dispatchEvent(keydown);
    fixture.detectChanges();
    expect(keydown.defaultPrevented).toBe(false);
    expect(served.answers).toEqual([]);
  });

  it('pins pending Permission requests inside app-dock above the Composer, replaces Plan while pending, keeps the thread Waiting ticker, and shows kind-aware previews', async () => {
    const options: ReadonlyArray<PermissionOption> = [
      { id: 'allow', label: 'Allow once', kind: 'allowOnce' },
      { id: 'reject', label: 'Reject', kind: 'rejectOnce' },
    ];
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    const liveWithCwd: SessionStreamItem = {
      _tag: 'Live',
      state: { ...live.state, cwd: '/repo/demo' },
    };

    Queue.offerAllUnsafe(queue, [
      liveWithCwd,
      started(),
      userMessage('Check and edit'),
      plan(),
      event({
        _tag: 'Step',
        id: StepId.make('exec-step'),
        turnId,
        title: 'Run tests',
        kind: 'execute',
        status: 'pending',
        files: [],
        diffs: [],
        output: '',
        input: 'npm test -- --run',
      }),
      permissionRequest('perm-exec', 'exec-step', options),
    ]);

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'dock')).toBeTruthy();
    });

    const planDock = dock(fixture);
    const dockEl = byTestId(fixture, 'dock');
    const scrollerEl = byTestId(fixture, 'thread-scroller');
    const composerEl = byTestId(fixture, 'composer');
    expect(planDock?.contains(dockEl)).toBe(true);
    expect(scrollerEl.contains(dockEl)).toBe(false);
    expect(dockEl.compareDocumentPosition(composerEl)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // Plan progress bar yields while permission is pending.
    expect(planDock?.querySelector('[data-plan-segment]')).toBeNull();

    // Waiting ticker stays in the scrolling thread with the amber Attention dot.
    const tickerEl = ticker(fixture);
    expect(tickerEl).not.toBeNull();
    expect(scrollerEl.contains(tickerEl)).toBe(true);
    expect(tickerEl?.textContent).toContain('Waiting for you below');
    expect(tickerEl?.querySelector('.bg-\\[var\\(--attention\\)\\]')).not.toBeNull();

    // Execute preview falls back to live.cwd and displays full command in font-mono.
    expect(byTestId(fixture, 'dock-command').textContent?.trim()).toBe('npm test -- --run');
    expect(byTestId(fixture, 'dock-cwd').textContent?.trim()).toBe('/repo/demo');

    // Answering restores the Plan progress bar.
    Queue.offerUnsafe(queue, permissionRequest('perm-exec', 'exec-step', options, 'answered'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="dock"]')).toBeNull();
      expect(planDock?.querySelectorAll('[data-plan-segment]')).toHaveLength(1);
    });

    // Edit permission shows relative files and inline @ui/diff preview.
    Queue.offerAllUnsafe(queue, [
      event({
        _tag: 'Step',
        id: StepId.make('edit-step'),
        turnId,
        title: 'Edit src/app.ts',
        kind: 'edit',
        status: 'pending',
        files: ['src/app.ts'],
        diffs: [{ path: 'src/app.ts', before: 'old line', after: 'new line' }],
        output: '',
      }),
      permissionRequest('perm-edit', 'edit-step', options),
    ]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'dock-file').textContent?.trim()).toBe('src/app.ts');
      expect(root(fixture).querySelector('app-diff-patch')).not.toBeNull();
    });
    expect(root(fixture).querySelector('[data-testid="dock-diffs"]')?.textContent).toContain(
      'new line',
    );
    Queue.offerUnsafe(queue, permissionRequest('perm-edit', 'edit-step', options, 'answered'));
    await vi.waitFor(() => expect(root(fixture).querySelector('[data-testid="dock"]')).toBeNull());

    // Delete / other permission shows affected files and structured input.
    Queue.offerAllUnsafe(queue, [
      event({
        _tag: 'Step',
        id: StepId.make('del-step'),
        turnId,
        title: 'Delete old.ts',
        kind: 'delete',
        status: 'pending',
        files: ['src/old.ts'],
        diffs: [],
        output: '',
        input: '{\n  "path": "src/old.ts"\n}',
      }),
      permissionRequest('perm-del', 'del-step', options),
    ]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'dock-file').textContent?.trim()).toBe('src/old.ts');
      expect(byTestId(fixture, 'dock-input').textContent).toContain('"path": "src/old.ts"');
    });

    // Escape still cancels the Turn while a Permission request is pending.
    pressWindow(fixture, 'Escape');
    await vi.waitFor(() => expect(served.cancels).toBe(1));
  });

  it('shows the Composer Permission mode control and changes it', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerUnsafe(queue, live);

    await vi.waitFor(() =>
      expect(root(fixture).querySelector('[data-testid="permission-mode"]')).not.toBeNull(),
    );

    byTestId(fixture, 'permission-mode').click();
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(menuItem('permission-mode-ask')).not.toBeNull();
    });
    menuItem('permission-mode-ask')?.click();
    await vi.waitFor(() => expect(served.optionChanges).toEqual(['ask']));
  });

  it('marks policy answers as auto and rejected answers as rejected on the Receipt', async () => {
    const autoOptions: ReadonlyArray<PermissionOption> = [
      { id: 'allow', label: 'Allow once', kind: 'allowOnce' },
    ];
    const rejectOptions: ReadonlyArray<PermissionOption> = [
      { id: 'reject', label: 'Reject', kind: 'rejectOnce' },
    ];
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const fixture = mount(serve([Stream.fromQueue(queue)]));
    Queue.offerAllUnsafe(queue, [
      live,
      started(),
      userMessage('Do both'),
      permissionStep('s1', 'ls -la'),
      permissionRequest('p1', 's1', autoOptions, 'answered', 'policy'),
      permissionStep('s2', 'rm -rf /'),
      permissionRequest('p2', 's2', rejectOptions, 'answered'),
      agentMessage('Done'),
      event({ _tag: 'TurnEnded', turnId, outcome: { _tag: 'done' } }),
    ]);

    await vi.waitFor(() =>
      expect(root(fixture).querySelectorAll('[data-testid="receipt-step"]')).toHaveLength(2),
    );
    expect(
      root(fixture).querySelectorAll('[data-testid="receipt"] [data-testid="receipt-step"]'),
    ).toHaveLength(2);
    const marks = [...root(fixture).querySelectorAll('[data-testid="receipt-mark"]')].map(
      (element) => element.textContent?.trim() ?? '',
    );
    expect(marks).toEqual(['auto', 'rejected']);
  });

  it('restores unsent Composer text and images from Session.getComposer, saves edits, and clears on send', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    served.composer = {
      text: 'Remembered draft',
      images: [{ name: 'shot.png', mimeType: 'image/png', data: 'AAAA' }],
    };
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [liveWith({ canAttachImages: true })]);

    await vi.waitFor(() => expect(composer(fixture).value).toBe('Remembered draft'));
    expect(root(fixture).querySelectorAll('[data-testid="image-thumbnail"]')).toHaveLength(1);

    // Editing text persists back through Session.setComposer.
    type(fixture, 'Updated draft');
    await vi.waitFor(() =>
      expect(served.composer).toEqual({
        text: 'Updated draft',
        images: [{ name: 'shot.png', mimeType: 'image/png', data: 'AAAA' }],
      }),
    );

    // Sending clears both the Composer and the remembered draft.
    sendButton(fixture).click();
    await vi.waitFor(() => expect(served.prompts).toHaveLength(1));
    await vi.waitFor(() => expect(served.composer).toEqual({ text: '', images: [] }));
  });

  it('flushes the final Composer keystroke without aborting when destroyed immediately', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [liveWith({ canAttachImages: true })]);
    await vi.waitFor(() => expect(composer(fixture)).toBeTruthy());

    // Type without waiting for Angular's effect flush, then destroy immediately (as on Tab switch).
    const input = composer(fixture);
    input.value = 'unsent draft';
    input.dispatchEvent(new Event('input'));
    fixture.destroy();

    await vi.waitFor(() => expect(served.composer).toEqual({ text: 'unsent draft', images: [] }));
  });

  it('focuses Composer on Mod+L, Model/Effort picker on Mod+Shift+M, and toggles Permission mode on Mod+Shift+A', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [
      liveWith({
        options: {
          permissionMode: 'auto',
          model: { value: 'sonnet', choices: [{ id: 'sonnet', name: 'Sonnet' }] },
          effort: { value: 'medium', choices: ['low', 'medium', 'high'] },
        },
      }),
    ]);
    await vi.waitFor(() => expect(byTestId(fixture, 'model-picker')).not.toBeNull());
    await vi.waitFor(() => expect(byTestId(fixture, 'effort-current')).not.toBeNull());

    const outsideBtn = document.createElement('button');
    document.body.append(outsideBtn);
    try {
      outsideBtn.focus();
      pressWindow(fixture, 'l', { ctrlKey: true });
      expect(document.activeElement).toBe(composer(fixture));

      pressWindow(fixture, 'M', { ctrlKey: true, shiftKey: true });
      const active = document.activeElement;
      // The shortcut focuses the picker and opens it.
      expect(active?.getAttribute('data-testid')).toBe('model-picker');

      pressWindow(fixture, 'A', { ctrlKey: true, shiftKey: true });
      await vi.waitFor(() => expect(served.optionChanges).toEqual(['ask']));
      Queue.offerUnsafe(
        queue,
        liveWith({
          options: {
            permissionMode: 'ask',
            model: { value: 'sonnet', choices: [{ id: 'sonnet', name: 'Sonnet' }] },
            effort: { value: 'medium', choices: ['low', 'medium', 'high'] },
          },
        }),
      );
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(byTestId(fixture, 'permission-mode').textContent).toContain('Ask');
      });
      pressWindow(fixture, 'A', { ctrlKey: true, shiftKey: true });
      await vi.waitFor(() => expect(served.optionChanges).toEqual(['ask', 'auto']));
    } finally {
      outsideBtn.remove();
    }
  });

  it('answers Dock 1-4 in sortedOptions order only when Composer is empty or non-input, never with Mod or modal, and without stealing focus', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    const unsortedOptions: ReadonlyArray<PermissionOption> = [
      { id: 'reject', label: 'No', kind: 'rejectOnce' },
      { id: 'allow', label: 'Yes', kind: 'allowOnce' },
    ];
    Queue.offerAllUnsafe(queue, [
      live,
      started(),
      permissionStep('s1', 'ls'),
      permissionRequest('req-1', 's1', unsortedOptions),
    ]);
    await vi.waitFor(() => expect(byTestId(fixture, 'dock')).not.toBeNull());

    // Mod+1 must not answer permission.
    pressWindow(fixture, '1', { code: 'Digit1', ctrlKey: true });
    expect(served.answers).toEqual([]);

    // Non-empty Composer blocks Dock 1-4.
    type(fixture, 'draft');
    composer(fixture).focus();
    press(fixture, '1', false, { code: 'Digit1' });
    expect(served.answers).toEqual([]);

    // Modal blocks Dock 1-4.
    type(fixture, '');
    const releaseModal = TestBed.inject(Keymap).pushModal();
    pressWindow(fixture, '1', { code: 'Digit1' });
    expect(served.answers).toEqual([]);
    releaseModal();

    // Outside focus: physical Digit1 (even when event.key differs by layout) selects sortedOptions()[0] without stealing focus.
    (document.activeElement as HTMLElement | null)?.blur?.();
    await Promise.resolve();
    (document.activeElement as HTMLElement | null)?.blur?.();
    const before = document.activeElement;
    pressWindow(fixture, '1', { code: 'Numpad1' });
    expect(served.answers).toEqual([]);
    const keydown = pressWindow(fixture, '&', { code: 'Digit1' });
    expect(keydown.defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(served.answers).toEqual([{ requestId: 'req-1', optionId: 'allow' }]),
    );
    expect(document.activeElement).toBe(before);
  });

  it('layers Escape: Commands list and higher layers close before stopping Turn, modal blocks Esc, and Esc stops Turn even with focus outside SessionView', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [
      liveWith({ commands: [agentCommand('review', 'Review')] }),
      started(),
      userMessage('Go'),
    ]);
    await vi.waitFor(() => expect(byTestId(fixture, 'stop')).not.toBeNull());

    // Modal blocks Esc stop.
    const releaseModal = TestBed.inject(Keymap).pushModal();
    pressWindow(fixture, 'Escape');
    expect(served.cancels).toBe(0);
    releaseModal();

    // Higher Esc layer (e.g. selection) consumes Esc before stopTurn.
    const releaseSelection = TestBed.inject(Keymap).registerEscape({
      layer: 'selection',
      run: () => {},
    });
    pressWindow(fixture, 'Escape');
    expect(served.cancels).toBe(0);
    releaseSelection();

    // Commands list consumes first Esc.
    composer(fixture).focus();
    type(fixture, '/');
    await vi.waitFor(() => expect(byTestId(fixture, 'commands-list')).not.toBeNull());
    press(fixture, 'Escape');
    expect(root(fixture).querySelector('[data-testid="commands-list"]')).toBeNull();
    expect(served.cancels).toBe(0);

    // Focus outside SessionView still stops the running Turn on Esc when no higher layer is active.
    const sidebarBtn = document.createElement('button');
    document.body.append(sidebarBtn);
    try {
      sidebarBtn.focus();
      pressWindow(fixture, 'Escape');
      await vi.waitFor(() => expect(served.cancels).toBe(1));
    } finally {
      sidebarBtn.remove();
    }
  });

  it('types to focus Composer from body or thread, including `/`, while ignoring pending 1-4, Space on buttons, sidebar, menus, and modals', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [
      liveWith({ commands: [agentCommand('review', 'Review')] }),
      started(),
      userMessage('Hello thread'),
    ]);
    await vi.waitFor(() => expect(messages(fixture, 'user')).toEqual(['Hello thread']));

    // Sidebar / external region must not trigger type-to-focus.
    const sidebar = document.createElement('aside');
    sidebar.setAttribute('data-sidebar', 'sidebar');
    const sidebarBtn = document.createElement('button');
    sidebar.append(sidebarBtn);
    document.body.append(sidebar);
    try {
      sidebarBtn.focus();
      sidebarBtn.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'x', cancelable: true, bubbles: true }),
      );
      fixture.detectChanges();
      expect(composer(fixture).value).toBe('');
      expect(document.activeElement).toBe(sidebarBtn);
    } finally {
      sidebar.remove();
    }

    // Space on a SessionView button (Stop) must not jump to Composer.
    const stopBtn = byTestId(fixture, 'stop');
    stopBtn.focus();
    stopBtn.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', cancelable: true, bubbles: true }),
    );
    fixture.detectChanges();
    expect(composer(fixture).value).toBe('');
    expect(document.activeElement).toBe(stopBtn);

    // Modal and menu layers block type-to-focus.
    (document.activeElement as HTMLElement | null)?.blur?.();
    const keymap = TestBed.inject(Keymap);
    const releaseModal = keymap.pushModal();
    pressWindow(fixture, 'm');
    expect(composer(fixture).value).toBe('');
    releaseModal();
    await Promise.resolve();

    const releaseMenu = keymap.registerEscape({ layer: 'menu', run: () => {} });
    (document.activeElement as HTMLElement | null)?.blur?.();
    pressWindow(fixture, 'n');
    expect(composer(fixture).value).toBe('');
    releaseMenu();

    // Pending permission blocks digits 1-4 (even '3' when only 2 options exist) from typing into Composer.
    Queue.offerAllUnsafe(queue, [
      permissionStep('s1', 'ls'),
      permissionRequest('req-1', 's1', [
        { id: 'allow', label: 'Yes', kind: 'allowOnce' },
        { id: 'reject', label: 'No', kind: 'rejectOnce' },
      ]),
    ]);
    await vi.waitFor(() => expect(byTestId(fixture, 'dock')).not.toBeNull());
    (document.activeElement as HTMLElement | null)?.blur?.();
    pressWindow(fixture, '3');
    expect(composer(fixture).value).toBe('');

    // Clear permission by answering so typing into thread works, including '/'.
    Queue.offerUnsafe(
      queue,
      permissionRequest(
        'req-1',
        's1',
        [
          { id: 'allow', label: 'Yes', kind: 'allowOnce' },
          { id: 'reject', label: 'No', kind: 'rejectOnce' },
        ],
        'answered',
      ),
    );
    await vi.waitFor(() => expect(root(fixture).querySelector('[data-testid="dock"]')).toBeNull());

    const msgEl = byTestId(fixture, 'message-user');
    msgEl.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', cancelable: true, bubbles: true }),
    );
    fixture.detectChanges();
    expect(document.activeElement).toBe(composer(fixture));
    expect(composer(fixture).value).toBe('/');
    expect(byTestId(fixture, 'commands-list')).not.toBeNull();
  });

  it('auto-focuses Composer on mount unless a modal or input is active, and saves/restores caret across remounts', async () => {
    const queue1 = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue1)]);
    served.composer = { text: 'Hello world', images: [] };
    const fixture1 = mount(served);
    Queue.offerAllUnsafe(queue1, [live]);

    await vi.waitFor(() => expect(composer(fixture1).value).toBe('Hello world'));
    expect(document.activeElement).toBe(composer(fixture1));

    // Move caret to (2, 5) and destroy (simulating switching away from Tab).
    composer(fixture1).setSelectionRange(2, 5);
    fixture1.destroy();

    // Remount same sessionId: restores text and caret (2, 5) + focus.
    const remount = (): ComponentFixture<SessionView> => {
      const next = TestBed.createComponent(SessionView);
      next.componentRef.setInput('sessionId', sessionId);
      next.detectChanges();
      return next;
    };
    const queue2 = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    served.subscriptions.push(Stream.fromQueue(queue2));
    const fixture2 = remount();
    Queue.offerAllUnsafe(queue2, [live]);
    await vi.waitFor(() => {
      fixture2.detectChanges();
      expect(composer(fixture2).value).toBe('Hello world');
      expect(composer(fixture2).selectionStart).toBe(2);
      expect(composer(fixture2).selectionEnd).toBe(5);
    });
    expect(document.activeElement).toBe(composer(fixture2));
    fixture2.destroy();

    // Does not steal focus if an existing input (e.g. rename) is already focused.
    const renameInput = document.createElement('input');
    document.body.append(renameInput);
    try {
      renameInput.focus();
      const queue3 = Effect.runSync(Queue.unbounded<SessionStreamItem>());
      served.subscriptions.push(Stream.fromQueue(queue3));
      const fixture3 = remount();
      Queue.offerAllUnsafe(queue3, [live]);
      await vi.waitFor(() => expect(composer(fixture3).value).toBe('Hello world'));
      expect(document.activeElement).toBe(renameInput);
      fixture3.destroy();
    } finally {
      renameInput.remove();
    }
  });

  it('shows font-mono @ui/kbd hints on Dock 1-4 and OS-aware tooltips on Session controls', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    TestBed.configureTestingModule({
      providers: [
        { provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers(served)) },
        { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
        { provide: KEYMAP_PLATFORM, useValue: 'mac' },
      ],
    });
    const fixture = TestBed.createComponent(SessionView);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.detectChanges();

    Queue.offerAllUnsafe(queue, [
      liveWith({
        options: {
          permissionMode: 'auto',
          model: { value: 'sonnet', choices: [{ id: 'sonnet', name: 'Sonnet' }] },
        },
      }),
      started(),
      permissionStep('s1', 'ls'),
      permissionRequest('req-1', 's1', [{ id: 'allow', label: 'Yes', kind: 'allowOnce' }]),
    ]);
    await vi.waitFor(() => expect(byTestId(fixture, 'dock')).not.toBeNull());

    const dockKbd = byTestId(fixture, 'dock-option').querySelector('kbd');
    expect(dockKbd?.textContent?.trim()).toBe('1');
    expect(dockKbd?.className).toContain('font-mono');

    byTestId(fixture, 'stop').dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(document.querySelector('.cdk-overlay-container kbd')).not.toBeNull(),
    );
    const stopKbd = document.querySelector('.cdk-overlay-container kbd');
    expect(stopKbd?.textContent?.trim()).toBe('Esc');
    expect(stopKbd?.className).toContain('font-mono');
  });

  it('shows Stopping… during cancel grace, Stop Agent after 5s, and stops immediately when no other Session is working', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    TestBed.configureTestingModule({
      providers: [
        { provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers(served)) },
        { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
        { provide: KEYMAP_PLATFORM, useValue: 'mac' },
      ],
    });
    const fixture = TestBed.createComponent(SessionView);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.detectChanges();

    Queue.offerAllUnsafe(queue, [liveWith({ agentName: 'Claude' }), started()]);
    await vi.waitFor(() => expect(byTestId(fixture, 'stop')).not.toBeNull());

    byTestId(fixture, 'stop').click();
    await vi.waitFor(() => expect(served.cancels).toBe(1));

    Queue.offerUnsafe(
      queue,
      liveWith({
        agentName: 'Claude',
        runningTurn: turnId,
        cancelGrace: { phase: 'waiting', otherWorkingCount: 0 },
      }),
    );
    await vi.waitFor(() => expect(byTestId(fixture, 'stop-waiting')).not.toBeNull());
    expect((byTestId(fixture, 'stop-waiting') as HTMLButtonElement).disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="stop"]')).toBeNull();

    Queue.offerUnsafe(
      queue,
      liveWith({
        agentName: 'Claude',
        runningTurn: turnId,
        cancelGrace: { phase: 'ready', otherWorkingCount: 0 },
      }),
    );
    await vi.waitFor(() => expect(byTestId(fixture, 'stop-agent')).not.toBeNull());

    // Esc does not invoke Stop Agent once Stop Agent is visible.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Promise.resolve();
    expect(served.cancels).toBe(1);
    expect(served.stopAgents).toEqual([]);

    byTestId(fixture, 'stop-agent').click();
    await vi.waitFor(() => expect(served.stopAgents.length).toBe(1));
    expect(served.stopAgents[0]).toEqual({ sessionId });
  });

  it('surfaces Stop Agent for stalled Compaction and resets stopAgentConfirm when Compaction settles', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    TestBed.configureTestingModule({
      providers: [
        { provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers(served)) },
        { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
        { provide: KEYMAP_PLATFORM, useValue: 'mac' },
      ],
    });
    const fixture = TestBed.createComponent(SessionView);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.detectChanges();

    Queue.offerUnsafe(
      queue,
      liveWith({
        agentName: 'Claude',
        compacting: true,
        cancelGrace: { phase: 'waiting', otherWorkingCount: 0 },
      }),
    );
    await vi.waitFor(() => expect(byTestId(fixture, 'stop-waiting')).not.toBeNull());

    Queue.offerUnsafe(
      queue,
      liveWith({
        agentName: 'Claude',
        compacting: true,
        cancelGrace: { phase: 'ready', otherWorkingCount: 1 },
      }),
    );
    await vi.waitFor(() => expect(byTestId(fixture, 'stop-agent')).not.toBeNull());

    byTestId(fixture, 'stop-agent').click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="stop-agent-confirm-dialog"]')).not.toBeNull(),
    );

    Queue.offerUnsafe(queue, liveWith({ agentName: 'Claude' }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="stop-agent-confirm-dialog"]')).toBeNull(),
    );
  });

  it('asks confirmation before force-stopping when other Sessions on the same Agent are working', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    TestBed.configureTestingModule({
      providers: [
        { provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers(served)) },
        { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
        { provide: KEYMAP_PLATFORM, useValue: 'mac' },
      ],
    });
    const fixture = TestBed.createComponent(SessionView);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.detectChanges();

    Queue.offerAllUnsafe(queue, [
      liveWith({
        agentName: 'Claude',
        runningTurn: turnId,
        cancelGrace: { phase: 'ready', otherWorkingCount: 2 },
      }),
      started(),
    ]);
    await vi.waitFor(() => expect(byTestId(fixture, 'stop-agent')).not.toBeNull());

    byTestId(fixture, 'stop-agent').click();
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="stop-agent-confirm-dialog"]')).not.toBeNull(),
    );
    const dialog = document.querySelector('[data-testid="stop-agent-confirm-dialog"]')!;
    expect(dialog.textContent).toContain(
      'Stopping Claude will also interrupt 2 other working Sessions',
    );
    expect(served.stopAgents).toEqual([]);

    (document.querySelector('[data-testid="stop-agent-confirm-cancel"]') as HTMLElement).click();
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="stop-agent-confirm-dialog"]')).toBeNull(),
    );
    expect(served.stopAgents).toEqual([]);

    byTestId(fixture, 'stop-agent').click();
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="stop-agent-confirm-action"]')).not.toBeNull(),
    );
    (document.querySelector('[data-testid="stop-agent-confirm-action"]') as HTMLElement).click();
    await vi.waitFor(() => expect(served.stopAgents).toEqual([{ sessionId, force: true }]));
  });

  it('renders agent stopped outcome for STOP_AGENT_INTERRUPTED_DETAIL while keeping Spence closed for persisted interrupts', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const turnTwo = TurnId.make('turn-2');
    TestBed.configureTestingModule({
      providers: [
        { provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers(served)) },
        { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
        { provide: KEYMAP_PLATFORM, useValue: 'mac' },
      ],
    });
    const fixture = TestBed.createComponent(SessionView);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.detectChanges();

    Queue.offerAllUnsafe(queue, [
      liveWith({ agentName: 'Claude' }),
      started(),
      userMessage('first'),
      ended({ _tag: 'failed', reason: 'interrupted', detail: STOP_AGENT_INTERRUPTED_DETAIL }),
      event({ _tag: 'TurnStarted', turnId: turnTwo, permissionMode: 'auto' }),
      event({
        _tag: 'Message',
        id: MessageId.make('user-2'),
        turnId: turnTwo,
        role: 'user',
        parts: [{ _tag: 'text', text: 'second' }],
      }),
      event({
        _tag: 'TurnEnded',
        turnId: turnTwo,
        outcome: { _tag: 'failed', reason: 'interrupted', detail: 'raw persisted detail' },
      }),
    ]);
    await vi.waitFor(() => {
      const text = fixture.nativeElement.textContent ?? '';
      expect(text).toContain('Claude was stopped.');
      expect(text).toContain('Spence closed while the Turn was running');
    });
  });

  it('shows unconfirmed process exit PID and state in AgentBar and disables Send until exit confirms', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    TestBed.configureTestingModule({
      providers: [
        { provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers(served)) },
        { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
        { provide: KEYMAP_PLATFORM, useValue: 'mac' },
      ],
    });
    const fixture = TestBed.createComponent(SessionView);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.detectChanges();

    Queue.offerUnsafe(
      queue,
      liveWith({
        agentName: 'Claude',
        agentStatus: 'stopped',
        unconfirmedExit: { pid: 9999, state: 'killTimedOut' },
      }),
    );
    await vi.waitFor(() => expect(byTestId(fixture, 'agent-exit-unconfirmed')).not.toBeNull());
    const bannerText = byTestId(fixture, 'agent-exit-unconfirmed').textContent ?? '';
    expect(bannerText).toContain('9999');
    expect(bannerText).toContain('killTimedOut');

    type(fixture, 'follow up');
    fixture.detectChanges();
    expect(sendButton(fixture).disabled).toBe(true);

    Queue.offerUnsafe(queue, liveWith({ agentName: 'Claude', agentStatus: 'stopped' }));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="agent-exit-unconfirmed"]'),
      ).toBeNull();
      expect(sendButton(fixture).disabled).toBe(false);
    });
  });

  it('keeps Send disabled while Session.stopAgent is in flight even if LiveState already transitioned to stopped', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const stopGate = Deferred.makeUnsafe<void>();
    served.stopAgentEffect = () =>
      Deferred.await(stopGate).pipe(Effect.as({ _tag: 'stopped' as const }));
    TestBed.configureTestingModule({
      providers: [
        { provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers(served)) },
        { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
        { provide: KEYMAP_PLATFORM, useValue: 'mac' },
      ],
    });
    const fixture = TestBed.createComponent(SessionView);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.detectChanges();

    Queue.offerAllUnsafe(queue, [
      liveWith({
        agentName: 'Claude',
        runningTurn: turnId,
        cancelGrace: { phase: 'ready', otherWorkingCount: 0 },
      }),
      started(),
    ]);
    await vi.waitFor(() => expect(byTestId(fixture, 'stop-agent')).not.toBeNull());

    byTestId(fixture, 'stop-agent').click();
    await vi.waitFor(() => expect(served.stopAgents.length).toBe(1));

    // Main publishes stopped outcome before killAgent completes; Send must stay disabled until RPC returns.
    Queue.offerAllUnsafe(queue, [
      liveWith({ agentName: 'Claude', agentStatus: 'stopped' }),
      ended({ _tag: 'failed', reason: 'interrupted', detail: STOP_AGENT_INTERRUPTED_DETAIL }),
    ]);
    await vi.waitFor(() =>
      expect(fixture.nativeElement.querySelector('[data-testid="stop-agent"]')).toBeNull(),
    );
    type(fixture, 'echo:recovered');
    fixture.detectChanges();
    expect(sendButton(fixture).disabled).toBe(true);

    Effect.runSync(Deferred.succeed(stopGate, undefined));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(sendButton(fixture).disabled).toBe(false);
    });
  });

  it('shows non-blocking unverified version notice with upgrade command, and unsupported cantStart detail', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);

    Queue.offerAllUnsafe(queue, [
      liveWith({
        agentId: AgentId.make('claude'),
        agentName: 'Claude',
        agentStatus: 'ready',
        installedVersion: '0.105.0',
        versionQualification: 'unverified',
        upgradeCommand: 'npm install -g @zed-industries/claude-agent-acp@0.106.0',
      }),
    ]);

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'agent-unverified')).not.toBeNull();
    });
    expect(byTestId(fixture, 'agent-unverified').textContent).toContain('Unverified version');
    expect(byTestId(fixture, 'agent-unverified').textContent).toContain('0.105.0');
    expect(byTestId(fixture, 'agent-unverified').textContent).toContain(
      'npm install -g @zed-industries/claude-agent-acp@0.106.0',
    );
    // Unverified version does not block sending.
    composer(fixture).value = 'hello';
    composer(fixture).dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect((byTestId(fixture, 'send') as HTMLButtonElement).disabled).toBe(false);

    Queue.offerAllUnsafe(queue, [
      liveWith({
        agentId: AgentId.make('codex'),
        agentName: 'Codex',
        agentStatus: 'cantStart',
        cantStartReason: 'unsupported',
        cantStartDetail: 'Codex does not support Auto permission mode',
      }),
    ]);

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'agent-unsupported')).not.toBeNull();
    });
    expect(byTestId(fixture, 'agent-unsupported').textContent).toContain(
      'Codex does not support Auto permission mode',
    );
    byTestId(fixture, 'open-agent-log').click();
    await vi.waitFor(() => expect(served.logs).toBe(1));
  });

  it('switches draft Agent via Session.setAgent while preserving queued images and hides picker after first Turn', async () => {
    const claudeId = AgentId.make('claude');
    const codexId = AgentId.make('codex');
    const makeAgent = (id: AgentId, name: string): Agent => ({
      id,
      name,
      installKind: 'npm',
      package: `@test/${id}`,
      installed: true,
      qualifiedVersion: '1.0.0',
      imageLimits: { maxBase64Bytes: 1000, maxDimensionPx: 100, maxPerMessage: 5 },
      capabilities: {
        models: true,
        effort: true,
        images: true,
        askMode: true,
        resume: true,
        contextUsage: true,
        supportsCompaction: true,
        supportsIsolatedSummary: true,
        modelChangePreservesContext: true,
        crossDeviceTools: true,
      },
    });
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    served.agents = [makeAgent(claudeId, 'Claude'), makeAgent(codexId, 'Codex')];
    served.composer = {
      text: 'look at this',
      images: [{ name: 'pic.png', mimeType: 'image/png', data: 'AQID' }],
    };
    const fixture = mount(served);

    Queue.offerAllUnsafe(queue, [
      liveWith({
        isDraft: true,
        agentId: claudeId,
        agentName: 'Claude',
        canAttachImages: true,
      }),
    ]);

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="model-picker"]')?.textContent,
      ).toContain('Claude');
    });
    openPicker(fixture);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(menuItem('agent-option-codex')).not.toBeNull();
    });
    menuItem('agent-option-codex')?.click();
    await vi.waitFor(() => expect(served.agentChanges).toEqual([codexId]));

    // Switching to an Agent without image support keeps queued image visible and blocks send instead of dropping it.
    Queue.offerAllUnsafe(queue, [
      liveWith({
        isDraft: true,
        agentId: codexId,
        agentName: 'Codex',
        canAttachImages: false,
      }),
    ]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="images-blocked"]')).not.toBeNull();
    });
    expect(fixture.nativeElement.querySelector('[data-testid="composer-images"]')).not.toBeNull();

    // Once the first Turn runs (isDraft: false), draft agent picker disappears.
    Queue.offerAllUnsafe(queue, [
      liveWith({
        isDraft: false,
        agentId: codexId,
        agentName: 'Codex',
      }),
    ]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      openPicker(fixture);
      expect(menuItem('agent-option-claude')?.disabled).toBe(true);
    });
  });

  it('notes "No cross-device tools" in the Agent picker for an Agent that cannot carry them', async () => {
    const makeAgent = (id: string, name: string, crossDeviceTools: boolean): Agent => ({
      id: AgentId.make(id),
      name,
      installKind: 'npm',
      package: `@test/${id}`,
      installed: true,
      qualifiedVersion: '1.0.0',
      imageLimits: { maxBase64Bytes: 1000, maxDimensionPx: 100, maxPerMessage: 5 },
      capabilities: {
        models: true,
        effort: true,
        images: true,
        askMode: true,
        resume: true,
        contextUsage: true,
        supportsCompaction: true,
        supportsIsolatedSummary: true,
        modelChangePreservesContext: true,
        crossDeviceTools,
      },
    });
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    served.agents = [makeAgent('claude', 'Claude', true), makeAgent('plain', 'Plain', false)];
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [
      liveWith({ isDraft: true, agentId: AgentId.make('claude'), agentName: 'Claude' }),
    ]);

    await vi.waitFor(() => {
      fixture.detectChanges();
      openPicker(fixture);
      expect(menuItem('agent-option-plain')).not.toBeNull();
    });

    expect(menuItem('agent-option-plain')?.textContent).toContain('No cross-device tools');
    expect(menuItem('agent-option-claude')?.textContent).not.toContain('No cross-device tools');
  });

  it('shows Google login instructions on needsLogin and Try again when no authMethods are advertised', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);

    Queue.offerAllUnsafe(queue, [
      liveWith({
        agentId: AgentId.make('antigravity'),
        agentName: 'Antigravity',
        agentStatus: 'needsLogin',
        loginInstructions:
          'Sign in with your Google account in Google Antigravity, then click Log in or try again.',
      }),
    ]);

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="agent-login-instructions"]'),
      ).not.toBeNull();
    });
    expect(byTestId(fixture, 'agent-login-instructions').textContent).toContain('Google account');
    expect(fixture.nativeElement.querySelector('[data-testid="agent-login"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="agent-retry"]')).not.toBeNull();
  });

  it('disables Ask mode when askMode is false and shows capability limitation notes', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);

    Queue.offerAllUnsafe(queue, [
      liveWith({
        agentId: AgentId.make('antigravity'),
        agentName: 'Antigravity',
        modelsLimitation: 'Third-party models require an eligible subscription.',
        capabilities: {
          models: false,
          effort: false,
          images: true,
          askMode: false,
          resume: true,
          contextUsage: true,
          supportsCompaction: false,
          supportsIsolatedSummary: false,
          modelChangePreservesContext: true,
          crossDeviceTools: true,
        },
        options: { permissionMode: 'auto' },
      }),
    ]);

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="model-picker"]')?.textContent,
      ).toContain('Antigravity');
    });
    openPicker(fixture);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(menuItem('models-unavailable')).not.toBeNull();
    });
    expect(byTestId(fixture, 'models-limitation').textContent).toContain('Third-party models');
    expect(menuItem('effort-unavailable')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    byTestId(fixture, 'permission-mode').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(menuItem('permission-mode-ask')?.getAttribute('aria-disabled')).toBe('true');
    });

    // Mod+Shift+A does not switch to Ask when askMode is unsupported.
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'a',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(served.optionChanges).toEqual([]);
  });

  describe('Context usage ring', () => {
    const tooltipText = () =>
      document.querySelector('.cdk-overlay-container [role="tooltip"]')?.textContent ?? '';

    it('renders neutral dotted ring and hover tooltip when unavailable', async () => {
      const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
      const fixture = mount(serve([Stream.fromQueue(queue)]));

      Queue.offerAllUnsafe(queue, [
        liveWith({ agentName: 'Claude', contextUsage: { _tag: 'unavailable' } }),
      ]);
      await vi.waitFor(() => expect(byTestId(fixture, 'context-ring')).not.toBeNull());

      const ring = byTestId(fixture, 'context-ring');
      expect(ring.getAttribute('aria-label')).toContain('Context usage unavailable');
      expect(byTestId(fixture, 'context-ring-track').getAttribute('stroke-dasharray')).toBe('2 3');
      expect(root(fixture).querySelector('[data-testid="context-ring-arc"]')).toBeNull();
      expect(ring.textContent?.trim()).toBe('?');

      ring.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
      fixture.detectChanges();
      await vi.waitFor(() => expect(tooltipText()).toContain('Context usage unavailable'));
      expect(tooltipText()).toContain('No report for this Agent context and Model.');
      expect(tooltipText()).toContain('Reported by Claude.');
      expect(tooltipText()).toContain('Latest report; not a live counter.');
    });

    it('renders measured arc, 2-decimal percentage on focus, and un-clamped over-capacity details', async () => {
      const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
      const fixture = mount(serve([Stream.fromQueue(queue)]));

      Queue.offerAllUnsafe(queue, [
        liveWith({
          agentName: 'Claude',
          contextUsage: { _tag: 'reported', used: 24_000, capacity: 200_000 },
        }),
      ]);
      await vi.waitFor(() =>
        expect(root(fixture).querySelector('[data-testid="context-ring-arc"]')).not.toBeNull(),
      );

      const ring = byTestId(fixture, 'context-ring');
      expect(byTestId(fixture, 'context-ring-track').getAttribute('stroke-dasharray')).toBeNull();
      const arc = byTestId(fixture, 'context-ring-arc');
      expect(arc.getAttribute('stroke-dashoffset')).toBe('88');
      expect(arc.classList.contains('text-destructive')).toBe(false);
      expect(ring.getAttribute('aria-label')).toContain('24.00k / 200.00k');
      expect(ring.getAttribute('aria-label')).toContain('12.00%');

      ring.dispatchEvent(new Event('focus'));
      fixture.detectChanges();
      await vi.waitFor(() => expect(tooltipText()).toContain('24.00k / 200.00k · 12.00%'));
      expect(tooltipText()).toContain('Exact values: 24,000 / 200,000 tokens.');
      expect(tooltipText()).toContain('Reported by Claude.');
      expect(tooltipText()).toContain('Latest report; not a live counter.');

      // Over capacity: SVG arc caps at 100% (offset 0) with destructive token; details keep 105.00%
      Queue.offerAllUnsafe(queue, [
        liveWith({
          agentName: 'Claude',
          contextUsage: { _tag: 'reported', used: 210_000, capacity: 200_000 },
        }),
      ]);
      await vi.waitFor(() =>
        expect(byTestId(fixture, 'context-ring-arc').getAttribute('stroke-dashoffset')).toBe('0'),
      );
      expect(byTestId(fixture, 'context-ring-arc').classList.contains('text-destructive')).toBe(
        true,
      );
      expect(tooltipText()).toContain('210.00k / 200.00k · 105.00%');
      expect(tooltipText()).toContain('Exact values: 210,000 / 200,000 tokens.');
    });

    it('renders countOnly, historical, and waiting states distinctly', async () => {
      const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
      const fixture = mount(serve([Stream.fromQueue(queue)]));

      // countOnly
      Queue.offerAllUnsafe(queue, [
        liveWith({
          agentName: 'Claude',
          contextUsage: { _tag: 'countOnly', used: 12_500 },
        }),
      ]);
      await vi.waitFor(() =>
        expect(byTestId(fixture, 'context-ring').getAttribute('aria-label')).toContain(
          'capacity unknown',
        ),
      );
      const ring = byTestId(fixture, 'context-ring');
      expect(byTestId(fixture, 'context-ring-track').getAttribute('stroke-dasharray')).toBe('2 3');
      expect(root(fixture).querySelector('[data-testid="context-ring-arc"]')).toBeNull();
      expect(ring.textContent?.trim()).toBe('?');

      ring.dispatchEvent(new Event('focus'));
      fixture.detectChanges();
      await vi.waitFor(() => expect(tooltipText()).toContain('12.50k · capacity unknown'));
      expect(tooltipText()).toContain('Exact count: 12,500 tokens. Capacity not reported.');
      expect(tooltipText()).toContain('Latest report; not a live counter.');

      // historical
      Queue.offerAllUnsafe(queue, [
        liveWith({
          agentName: 'Claude',
          contextUsage: { _tag: 'historical', used: 24_000, capacity: 200_000 },
        }),
      ]);
      await vi.waitFor(() =>
        expect(tooltipText()).toContain('Historical · 24.00k / 200.00k · 12.00%'),
      );
      expect(byTestId(fixture, 'context-ring-track').getAttribute('stroke-dasharray')).toBe('2 3');
      expect(root(fixture).querySelector('[data-testid="context-ring-arc"]')).toBeNull();
      expect(ring.textContent?.trim()).toBe('?');
      expect(tooltipText()).toContain('Exact values: 24,000 / 200,000 tokens.');
      expect(tooltipText()).toContain('Historical reading; waiting for a new report.');

      // historical (count only)
      Queue.offerAllUnsafe(queue, [
        liveWith({
          agentName: 'Claude',
          contextUsage: { _tag: 'historical', used: 12_500 },
        }),
      ]);
      await vi.waitFor(() =>
        expect(tooltipText()).toContain('Historical · 12.50k · capacity unknown'),
      );
      expect(tooltipText()).toContain('Exact count: 12,500 tokens. Capacity not reported.');

      // waiting (with prior reading)
      Queue.offerAllUnsafe(queue, [
        liveWith({
          agentName: 'Claude',
          contextUsage: { _tag: 'waiting', prior: { used: 24_000, capacity: 200_000 } },
        }),
      ]);
      await vi.waitFor(() => expect(tooltipText()).toContain('Awaiting context report'));
      expect(byTestId(fixture, 'context-ring-track').getAttribute('stroke-dasharray')).toBe('2 3');
      expect(root(fixture).querySelector('[data-testid="context-ring-arc"]')).toBeNull();
      expect(ring.textContent?.trim()).toBe('…');
      expect(tooltipText()).toContain('Exact values: 24,000 / 200,000 tokens.');
      expect(tooltipText()).toContain('Historical reading; waiting for a new report.');

      // waiting (without prior reading)
      Queue.offerAllUnsafe(queue, [
        liveWith({
          agentName: 'Claude',
          contextUsage: { _tag: 'waiting' },
        }),
      ]);
      await vi.waitFor(() =>
        expect(tooltipText()).toContain('No report for this Agent context and Model.'),
      );
      expect(ring.textContent?.trim()).toBe('…');
    });
  });

  describe('memoryLost reopen gate', () => {
    it('shows the Composer-top notice bar, keeps Composer typable, disables Send, and resolves on Start with empty context', async () => {
      const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
      const served = serve([Stream.fromQueue(queue)]);
      const fixture = mount(served);

      Queue.offerAllUnsafe(queue, [
        liveWith({ memoryLost: true }),
        {
          _tag: 'Transcript',
          event: {
            seq: 1,
            at: 1,
            item: { _tag: 'ContextCleared', reason: 'lost' },
          },
        },
      ]);

      await vi.waitFor(() => {
        expect(byTestId(fixture, 'memory-lost-bar')).toBeTruthy();
      });
      const input = byTestId(fixture, 'composer-input') as HTMLTextAreaElement;
      expect(input.disabled).toBe(false);
      input.value = 'continue work';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();

      const send = byTestId(fixture, 'send') as HTMLButtonElement;
      expect(send.disabled).toBe(true);

      (byTestId(fixture, 'start-empty-context') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(served.startEmptyCalls).toBe(1));

      Queue.offerAllUnsafe(queue, [liveWith({ memoryLost: false })]);
      await vi.waitFor(() => {
        expect(root(fixture).querySelector('[data-testid="memory-lost-bar"]')).toBeNull();
      });
      expect((byTestId(fixture, 'send') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  describe('Summary handoff', () => {
    const claudeId = AgentId.make('claude');
    const codexId = AgentId.make('codex');
    const turn1 = TurnId.make('turn-1');

    const makePrep = (kind: HandoffKind, targetModel?: string): HandoffPreparation => ({
      kind,
      endpoint: { sessionId, turnId: turn1, turnNumber: 1, seq: 2, messageCount: 2 },
      summary: 'Goal: ship summary handoff.',
      draftSource: 'isolatedSummary',
      images: [
        {
          id: '1:1',
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          turnId: turn1,
          role: 'user',
          seq: 1,
        },
      ],
      destinations: [
        {
          agentId: claudeId,
          agentName: 'Claude',
          installed: true,
          canRun: true,
          capabilities: {
            models: true,
            effort: true,
            images: true,
            askMode: true,
            resume: true,
            contextUsage: true,
            supportsCompaction: true,
            supportsIsolatedSummary: true,
            modelChangePreservesContext: false,
            crossDeviceTools: true,
          },
          imageLimits: { maxBase64Bytes: 1_000_000, maxDimensionPx: 4096, maxPerMessage: 4 },
          availableModels: [
            { id: 'small', name: 'Small' },
            { id: 'large', name: 'Large' },
          ],
          resolvedModel: targetModel ?? 'small',
          resolvedPermissionMode: 'auto',
          blockedImages: [],
        },
        {
          agentId: codexId,
          agentName: 'Codex',
          installed: true,
          canRun: true,
          capabilities: {
            models: true,
            effort: false,
            images: false,
            askMode: false,
            resume: true,
            contextUsage: true,
            supportsCompaction: false,
            supportsIsolatedSummary: false,
            modelChangePreservesContext: true,
            crossDeviceTools: true,
          },
          imageLimits: { maxBase64Bytes: 1_000_000, maxDimensionPx: 4096, maxPerMessage: 4 },
          availableModels: [{ id: 'codex-1', name: 'Codex 1' }],
          resolvedModel: 'codex-1',
          modelMismatchNote: 'Codex does not offer "small"; prefilled default "codex-1".',
          effortNote: 'Effort unavailable on Codex.',
          permissionNote: 'Ask mode is unavailable on Codex; Auto will be used.',
          resolvedPermissionMode: 'auto',
          blockedImages: [{ imageId: '1:1', reason: 'Destination Agent does not accept Images.' }],
        },
      ],
      defaultDestinationAgentId: kind === 'switch' ? codexId : claudeId,
      ...(targetModel === undefined ? {} : { requestedModel: targetModel }),
    });

    it('opens Switch Agent review UI, enforces budget & blocked Images, handles failed attempt & retry', async () => {
      const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
      const served = serve([Stream.fromQueue(queue)]);
      let execCalls = 0;
      const prep = makePrep('switch');
      served.prepareHandoffEffect = () => Effect.succeed(prep);
      served.revalidateHandoffEffect = () =>
        Effect.succeed({
          endpointAdvanced: false,
          currentEndpoint: prep.endpoint,
          compatibility: prep.destinations[1]!,
          budget: {
            estimatedTokens: 10,
            capTokens: 4000,
            knownCapacity: false,
            overBudget: false,
          },
        });
      served.executeHandoffEffect = () => {
        execCalls += 1;
        if (execCalls === 1) {
          return Effect.succeed({
            _tag: 'failed',
            attempt: {
              id: HandoffAttemptId.make('att-1'),
              kind: 'switch',
              status: 'failed',
              createdAt: 1,
              sourceEndpoint: prep.endpoint,
              targetAgentId: codexId,
              targetAgentName: 'Codex',
              targetModel: 'codex-1',
              summary: prep.summary,
              selectedImageIds: [],
              messages: [],
              steps: [],
              diskStateNote: 'Destination edited files before failing.',
              failureReason: 'Codex ran unexpected tool steps instead of acknowledging.',
            },
          });
        }
        return Effect.succeed({ _tag: 'committed', contextId: 'ctx-2' });
      };

      const fixture = mount(served);
      Queue.offerAllUnsafe(queue, [liveWith({ agentStatus: 'ready', agentId: claudeId })]);

      const toolbar = TestBed.inject(SessionToolbar);
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(
          toolbar
            .entryFor(sessionId)
            ?.actions()
            .find((a) => a.id === 'switch-agent')?.disabled,
        ).toBe(false);
      });
      toolbar.entryFor(sessionId)?.run('Switch Agent');

      await vi.waitFor(() => expect(byTestId(fixture, 'handoff-dialog')).toBeTruthy());
      expect(byTestId(fixture, 'handoff-model-note').textContent).toContain('Codex does not offer');
      expect(byTestId(fixture, 'handoff-effort-note').textContent).toContain('Effort unavailable');
      expect(byTestId(fixture, 'handoff-image-blocked-1:1').textContent).toContain(
        'does not accept Images',
      );

      // Budget overflow blocks confirmation without silent truncation
      const summaryInput = byTestId(fixture, 'handoff-summary-input') as HTMLTextAreaElement;
      summaryInput.value = 'x'.repeat(4001 * 4);
      summaryInput.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(byTestId(fixture, 'handoff-budget-overflow')).toBeTruthy();
      expect((byTestId(fixture, 'handoff-confirm') as HTMLButtonElement).disabled).toBe(true);

      // Shorten summary back within budget and confirm -> fails first attempt
      summaryInput.value = 'Goal: ship summary handoff.';
      summaryInput.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect((byTestId(fixture, 'handoff-confirm') as HTMLButtonElement).disabled).toBe(false);

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(byTestId(fixture, 'handoff-confirm')).toBeTruthy();
      });
      (byTestId(fixture, 'handoff-confirm') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(byTestId(fixture, 'handoff-failed')).toBeTruthy());
      expect(byTestId(fixture, 'handoff-failure-reason').textContent).toContain(
        'unexpected tool steps',
      );
      expect(byTestId(fixture, 'handoff-disk-note').textContent).toContain('edited files');

      // Retry -> commits and closes dialog
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(byTestId(fixture, 'handoff-confirm')).toBeTruthy();
      });
      (byTestId(fixture, 'handoff-confirm') as HTMLButtonElement).click();
      await vi.waitFor(() =>
        expect(root(fixture).querySelector('[data-testid="handoff-dialog"]')).toBeNull(),
      );
      expect(execCalls).toBe(2);
    });

    it('opens Prepare summary handoff from MemoryLostBar and gates Model change when modelChangePreservesContext is false', async () => {
      const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
      const served = serve([Stream.fromQueue(queue)]);
      served.prepareHandoffEffect = (kind, targetModel) =>
        Effect.succeed(makePrep(kind, targetModel));

      const fixture = mount(served);
      Queue.offerAllUnsafe(queue, [
        liveWith({
          agentId: claudeId,
          isDraft: false,
          memoryLost: true,
          capabilities: {
            models: true,
            effort: true,
            images: true,
            askMode: true,
            resume: true,
            contextUsage: true,
            supportsCompaction: true,
            supportsIsolatedSummary: true,
            modelChangePreservesContext: false,
            crossDeviceTools: true,
          },
          options: {
            model: {
              value: 'small',
              choices: [
                { id: 'small', name: 'Small' },
                { id: 'large', name: 'Large' },
              ],
            },
            permissionMode: 'auto',
          },
        }),
      ]);

      await vi.waitFor(() => expect(byTestId(fixture, 'prepare-summary-handoff')).toBeTruthy());
      (byTestId(fixture, 'prepare-summary-handoff') as HTMLButtonElement).click();

      await vi.waitFor(() => expect(byTestId(fixture, 'handoff-dialog')).toBeTruthy());
      expect(served.prepareHandoffCalls[0]?.kind).toBe('memoryLost');

      (byTestId(fixture, 'handoff-close') as HTMLButtonElement).click();
      await vi.waitFor(() =>
        expect(root(fixture).querySelector('[data-testid="handoff-dialog"]')).toBeNull(),
      );

      // Changing Model on non-draft Session with modelChangePreservesContext: false opens handoff
      openPicker(fixture);
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(menuItem('model-option-large')).not.toBeNull();
      });
      menuItem('model-option-large')?.click();
      fixture.detectChanges();

      await vi.waitFor(() => expect(byTestId(fixture, 'handoff-dialog')).toBeTruthy());
      expect(served.prepareHandoffCalls[1]).toEqual({ kind: 'modelChange', targetModel: 'large' });
      expect(served.options).toEqual([]);
    });

    it('creates a Fork directly via the Turn Fork button without a modal while keeping source intact', async () => {
      const claudeId = AgentId.make('claude');
      const projectId = ProjectId.make('proj-1');
      const forkId = SessionId.make('fork-1');
      const turn1 = TurnId.make('turn-1');
      const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
      const served = serve([
        Stream.make(
          liveWith({ agentStatus: 'ready', agentId: claudeId }),
          started(),
          userMessage('Plan it'),
          agentMessage('Planned'),
          ended(),
        ).pipe(Stream.concat(Stream.fromQueue(queue))),
      ]);

      const compat = {
        agentId: claudeId,
        agentName: 'Claude',
        installed: true,
        canRun: true,
        capabilities: capabilitiesWith(false),
        imageLimits: { maxBase64Bytes: 100, maxDimensionPx: 100, maxPerMessage: 1 },
        availableModels: [],
        resolvedPermissionMode: 'auto' as const,
        blockedImages: [],
      };
      const endpoint = { sessionId, turnId: turn1, turnNumber: 1, seq: 2, messageCount: 2 };

      served.prepareHandoffEffect = (kind) =>
        Effect.succeed({
          kind,
          endpoint,
          summary: 'Goal: fork from turn 1.',
          draftSource: 'transcriptExtract',
          images: [],
          destinations: [compat],
          defaultDestinationAgentId: claudeId,
        });
      served.executeHandoffEffect = () =>
        Effect.succeed({ _tag: 'committed', contextId: 'ctx-fork', forkSessionId: forkId });

      const fixture = mount(served, { projectId });
      const tabs = TestBed.inject(Tabs);
      const initialVersion = tabs.sessionsVersion();

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(byTestId(fixture, 'turn-fork')).toBeTruthy();
      });
      (byTestId(fixture, 'turn-fork') as HTMLButtonElement).click();

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(tabs.sessionsVersion()).toBe(initialVersion + 1);
      });
      expect(root(fixture).querySelector('[data-testid="handoff-dialog"]')).toBeNull();
      expect(served.prepareHandoffCalls[0]).toEqual({ kind: 'fork' });
      expect(tabs.isOpen(forkId)).toBe(true);
      expect(tabs.active()?.session).toBe(forkId);
    });

    it('renders Forked from boundary with source redirect, summary dialog, and Forked to inline markers', async () => {
      const projectId = ProjectId.make('proj-1');
      const sourceId = SessionId.make('source-1');
      const forkId = SessionId.make('fork-1');
      const sourceTurnId = TurnId.make('turn-1');
      const served = serve([
        Stream.make(
          liveWith({
            agentStatus: 'ready',
            forkLineage: {
              sourceSessionId: sourceId,
              sourceTurnId,
              sourceTurnNumber: 1,
              sourceTitle: 'Original Session',
            },
            forks: [{ forkSessionId: forkId, sourceTurnId, forkTitle: 'Fork of Original' }],
          }),
          event({
            _tag: 'HandoffBoundary',
            kind: 'fork',
            fromAgentId: AgentId.make('claude'),
            toAgentId: AgentId.make('codex'),
            summary: 'Approved fork summary text',
            imageCount: 0,
            contextId: 'ctx-fork',
          }),
          started(),
          userMessage('hello'),
          agentMessage('world'),
          ended({ _tag: 'done' }),
        ).pipe(Stream.concat(Stream.never)),
      ]);

      const fixture = mount(served, { projectId });
      const tabs = TestBed.inject(Tabs);

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(byTestId(fixture, 'fork-source-link')).toBeTruthy();
      });
      expect(byTestId(fixture, 'fork-source-link').textContent).toContain(
        'Forked from Original Session · Turn 1',
      );
      expect(document.querySelector('[data-testid="fork-summary-dialog"]')).toBeNull();

      (byTestId(fixture, 'fork-summary-trigger') as HTMLButtonElement).click();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(document.querySelector('[data-testid="fork-summary-dialog"]')).toBeTruthy();
      });
      expect(
        document.querySelector('[data-testid="handoff-boundary-summary"]')?.textContent,
      ).toContain('Approved fork summary text');

      (document.querySelector('[data-testid="fork-summary-close"]') as HTMLButtonElement).click();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(document.querySelector('[data-testid="fork-summary-dialog"]')).toBeNull();
      });

      // Clicking Forked from opens source Tab and requests scroll to sourceTurnId
      (byTestId(fixture, 'fork-source-link') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(tabs.active()?.session).toBe(sourceId);
      expect(tabs.pendingTurnScroll()).toEqual({ sessionId: sourceId, turnId: sourceTurnId });

      // Clicking Forked to opens Fork Tab
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(byTestId(fixture, 'fork-target-link')).toBeTruthy();
      });
      expect(byTestId(fixture, 'fork-target-link').textContent).toContain(
        'Forked to Fork of Original',
      );
      (byTestId(fixture, 'fork-target-link') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(tabs.active()?.session).toBe(forkId);
    });

    it('renders Source deleted without redirect when forkLineage.sourceDeleted is true', async () => {
      const projectId = ProjectId.make('proj-1');
      const sourceId = SessionId.make('source-1');
      const sourceTurnId = TurnId.make('turn-1');
      const served = serve([
        Stream.make(
          liveWith({
            agentStatus: 'ready',
            forkLineage: {
              sourceSessionId: sourceId,
              sourceTurnId,
              sourceTurnNumber: 1,
              sourceTitle: 'Original Session',
              sourceDeleted: true,
            },
          }),
          event({
            _tag: 'HandoffBoundary',
            kind: 'fork',
            fromAgentId: AgentId.make('claude'),
            toAgentId: AgentId.make('codex'),
            summary: 'Preserved fork summary',
            imageCount: 0,
            contextId: 'ctx-fork',
          }),
          started(),
          userMessage('hello'),
          agentMessage('world'),
          ended({ _tag: 'done' }),
        ).pipe(Stream.concat(Stream.never)),
      ]);

      const fixture = mount(served, { projectId });
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(byTestId(fixture, 'fork-source-deleted')).toBeTruthy();
      });
      expect(byTestId(fixture, 'fork-source-deleted').textContent).toContain('Source deleted');
      expect(root(fixture).querySelector('[data-testid="fork-source-link"]')).toBeNull();

      (byTestId(fixture, 'fork-summary-trigger') as HTMLButtonElement).click();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(document.querySelector('[data-testid="fork-summary-dialog"]')).toBeTruthy();
      });
      expect(
        document.querySelector('[data-testid="handoff-boundary-summary"]')?.textContent,
      ).toContain('Preserved fork summary');
    });
  });

  it('shows the send mode chip while a Turn runs, with Steer enabled only when the Agent supports it', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);

    Queue.offerUnsafe(queue, liveWith());
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="send-mode"]')).toBeNull();
    });

    Queue.offerUnsafe(queue, liveWith({ runningTurn: turnId, steeringSupported: true }));
    Queue.offerUnsafe(queue, started());
    Queue.offerUnsafe(queue, userMessage('Hi'));
    await vi.waitFor(() => expect(byTestId(fixture, 'send-mode')).toBeDefined());
    expect(byTestId(fixture, 'send-mode-queue').getAttribute('aria-checked')).toBe('true');
    expect(byTestId(fixture, 'send-mode-steer').getAttribute('aria-disabled')).toBeNull();

    Queue.offerUnsafe(queue, liveWith({ runningTurn: turnId }));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'send-mode-steer').getAttribute('aria-disabled')).toBe('true');
    });
    byTestId(fixture, 'send-mode-steer').click();
    fixture.detectChanges();
    expect(byTestId(fixture, 'send-mode-queue').getAttribute('aria-checked')).toBe('true');
  });

  it('sends with Mod+Enter in the chosen send mode while a Turn runs', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [
      liveWith({ runningTurn: turnId, steeringSupported: true }),
      started(),
      userMessage('Hi'),
    ]);
    await vi.waitFor(() => expect(byTestId(fixture, 'send-mode')).toBeDefined());

    type(fixture, 'Queued');
    expect(press(fixture, 'Enter', false, { ctrlKey: true }).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(served.enqueues).toEqual([[{ _tag: 'text', text: 'Queued' }]]));
    expect(served.prompts).toEqual([]);

    byTestId(fixture, 'send-mode-steer').click();
    fixture.detectChanges();
    type(fixture, 'Steered');
    expect(press(fixture, 'Enter', false, { ctrlKey: true }).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(served.steers).toEqual([[{ _tag: 'text', text: 'Steered' }]]));

    type(fixture, 'New line');
    expect(press(fixture, 'Enter', true).defaultPrevented).toBe(false);
    expect(served.prompts).toEqual([]);
    expect(composer(fixture).value).toBe('New line');
  });

  it('falls back to Send when Steer loses the race with the Turn settling', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    served.steerEffect = Effect.fail(
      new SessionError({ reason: 'NotRunning', detail: 'the Turn settled' }),
    );
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [
      liveWith({ runningTurn: turnId, steeringSupported: true }),
      started(),
      userMessage('Hi'),
    ]);
    await vi.waitFor(() => expect(byTestId(fixture, 'send-mode')).toBeDefined());
    byTestId(fixture, 'send-mode-steer').click();
    fixture.detectChanges();

    type(fixture, 'Send instead');
    press(fixture, 'Enter', false, { ctrlKey: true });
    await vi.waitFor(() =>
      expect(served.prompts).toEqual([[{ _tag: 'text', text: 'Send instead' }]]),
    );
    await vi.waitFor(() => expect(composer(fixture).value).toBe(''));
  });

  it('shows queued Messages inline and edits, reorders, removes and clears them', async () => {
    const first: QueuedMessage = {
      id: MessageId.make('queued-1'),
      parts: [{ _tag: 'text', text: 'first' }],
    };
    const second: QueuedMessage = {
      id: MessageId.make('queued-2'),
      parts: [{ _tag: 'text', text: 'second' }],
    };
    const served = serve([
      Stream.make(
        liveWith({ runningTurn: turnId, steeringSupported: true, queue: [first, second] }),
        started(),
        userMessage('Hi'),
      ).pipe(Stream.concat(Stream.never)),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelectorAll('[data-testid="queued-message"]')).toHaveLength(2);
    });
    const rows = root(fixture).querySelectorAll<HTMLElement>('[data-testid="queued-message"]');
    expect(rows[0]?.textContent).toContain('queued 1');
    expect(rows[1]?.textContent).toContain('queued 2');

    rows[1]?.querySelector<HTMLElement>('[data-testid="queue-up"]')?.click();
    await vi.waitFor(() =>
      expect(served.queueChanges[0]?.map((item) => item.id)).toEqual([second.id, first.id]),
    );

    rows[0]?.querySelector<HTMLElement>('[data-testid="queue-edit"]')?.click();
    fixture.detectChanges();
    const edit = byTestId(fixture, 'queue-edit-input') as HTMLInputElement;
    edit.value = 'edited';
    edit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(
        served.queueChanges[1]?.map((item) =>
          item.parts.map((part) => (part._tag === 'text' ? part.text : '')).join(''),
        ),
      ).toEqual(['edited', 'second']),
    );

    rows[1]?.querySelector<HTMLElement>('[data-testid="queue-remove"]')?.click();
    await vi.waitFor(() => expect(served.queueChanges[2]).toHaveLength(1));
    byTestId(fixture, 'clear-queue').click();
    await vi.waitFor(() => expect(served.queueClears).toBe(1));
  });

  it('attributes a Message from another Session to its sender, not to the user', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          liveWith({}),
          started(),
          event({
            _tag: 'Message',
            id: MessageId.make('from-1'),
            turnId,
            role: 'user',
            parts: [{ _tag: 'text', text: 'which database?' }],
            from: { sessionId: SessionId.make('worker-1'), title: 'Research', needsUser: true },
          }),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="message-from"]')).not.toBeNull();
    });
    expect(root(fixture).querySelector('[data-testid="message-user"]')).toBeNull();
    const message = byTestId(fixture, 'message-from').textContent ?? '';
    expect(message).toContain('Research');
    expect(message).toContain('which database?');
    expect(message).toContain('needs your answer');
  });

  it('names the sender Project on a Message that came from another Project', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          liveWith({}),
          started(),
          event({
            _tag: 'Message',
            id: MessageId.make('from-2'),
            turnId,
            role: 'user',
            parts: [{ _tag: 'text', text: 'can you review?' }],
            from: {
              sessionId: SessionId.make('other-1'),
              title: 'Billing fix',
              projectName: 'payments',
            },
          }),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="message-from"]')).not.toBeNull();
    });
    const header = byTestId(fixture, 'message-from').textContent ?? '';
    expect(header).toContain('From Billing fix in payments');
  });

  it('shows Provenance on a Message a person sent from another Device', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          liveWith({}),
          started(),
          event({
            _tag: 'Message',
            id: MessageId.make('from-device'),
            turnId,
            role: 'user',
            parts: [{ _tag: 'text', text: 'please take this over' }],
            from: {
              sessionId: SessionId.make('far-1'),
              title: 'Plan the release',
              projectName: 'spence',
              hops: 0,
              device: { id: DeviceId.make('device-laptop'), name: 'Laptop' },
              by: 'person',
            },
          }),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="message-provenance"]')).not.toBeNull();
    });
    const line = (byTestId(fixture, 'message-provenance').textContent ?? '').replace(/\s+/g, ' ');
    expect(line.trim()).toBe('From you · Laptop · Plan the release in spence');
  });

  it('shows Provenance on a Message an Agent sent from another Device, with the mode it asked under', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          liveWith({}),
          started(),
          event({
            _tag: 'Message',
            id: MessageId.make('from-agent'),
            turnId,
            role: 'user',
            parts: [{ _tag: 'text', text: 'run the migration' }],
            from: {
              sessionId: SessionId.make('far-2'),
              title: 'Plan the release',
              projectName: 'spence',
              hops: 1,
              device: { id: DeviceId.make('device-laptop'), name: 'Laptop' },
              by: 'agent',
              permissionMode: 'ask',
            },
          }),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="message-provenance"]')).not.toBeNull();
    });
    const line = (byTestId(fixture, 'message-provenance').textContent ?? '').replace(/\s+/g, ' ');
    expect(line.trim()).toBe(
      'From an Agent · Laptop · Plan the release in spence · asked under its Ask mode',
    );
  });

  it('marks a steering Message with its own badge', async () => {
    const fixture = mount(
      serve([
        Stream.make(
          liveWith({ runningTurn: turnId, steeringSupported: true }),
          started(),
          userMessage('initial'),
          event({
            _tag: 'Message',
            id: MessageId.make('steer-1'),
            turnId,
            role: 'user',
            parts: [{ _tag: 'text', text: 'redirect' }],
            steer: true,
          }),
        ).pipe(Stream.concat(Stream.never)),
      ]),
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="steered-badge"]')).not.toBeNull();
    });
    expect(byTestId(fixture, 'steered-badge').textContent).toContain('steered');
    expect(messages(fixture, 'user')).toHaveLength(2);
    expect(messages(fixture, 'user')[1]).toContain('redirect');
  });

  it('gates shortcuts, type-to-focus, and mount focus on the focused input so simultaneous SessionViews do not collide', async () => {
    const s1 = SessionId.make('dual-1');
    const s2 = SessionId.make('dual-2');
    const cancelled: SessionId[] = [];
    const modeToggled: Array<{ readonly sessionId: SessionId; readonly value: string }> = [];
    const queued: SessionId[] = [];
    const steered: SessionId[] = [];
    const answered: SessionId[] = [];

    const dualLayer = makeDesktopTestLayer(
      Layer.mergeAll(
        SessionsRpcs.toLayer({
          'Session.changes': () => Stream.empty,
          'Session.list': () => Effect.succeed([]),
          'Session.create': () => Effect.die('unused'),
          'Session.setAgent': () => Effect.die('unused'),
          'Session.prompt': () => Effect.die('unused'),
          'Session.steer': ({ sessionId: id }) =>
            Effect.sync(() => {
              steered.push(id);
            }),
          'Session.enqueue': ({ sessionId: id }) =>
            Effect.sync(() => {
              queued.push(id);
            }),
          'Session.setQueue': () => Effect.void,
          'Session.clearQueue': () => Effect.void,
          'Session.rename': () => Effect.void,
          'Session.openAgentLog': () => Effect.void,
          'Session.retryAgent': () => Effect.void,
          'Session.loginAgent': () => Effect.void,
          'Session.cancel': ({ sessionId: id }) =>
            Effect.sync(() => {
              cancelled.push(id);
            }),
          'Session.stopAgent': () => Effect.die('unused'),
          'Session.answerPermission': ({ sessionId: id }) =>
            Effect.sync(() => {
              answered.push(id);
            }),
          'Session.setOption': ({ sessionId: id, value }) =>
            Effect.sync(() => {
              modeToggled.push({ sessionId: id, value });
            }),
          'Session.clearContext': () => Effect.void,
          'Session.compact': () => Effect.void,
          'Session.startEmptyContext': () => Effect.void,
          'Session.prepareHandoff': () => Effect.die('unused'),
          'Session.revalidateHandoff': () => Effect.die('unused'),
          'Session.executeHandoff': () => Effect.die('unused'),
          'Session.listHandoffAttempts': () => Effect.succeed([]),
          'Session.archive': () => Effect.die('unused'),
          'Session.unarchive': () => Effect.die('unused'),
          'Session.countWorkers': () => Effect.die('unused'),
          'Session.delete': () => Effect.die('unused'),
          'Session.events': ({ sessionId: id }) =>
            Stream.make(
              liveWith({
                runningTurn: turnId,
                steeringSupported: true,
                options: {
                  permissionMode: 'auto',
                  model: { value: 'm1', choices: [{ id: 'm1', name: 'Model 1' }] },
                },
                contextUsage: { _tag: 'countOnly', used: id === s1 ? 1000 : 2000 },
              }),
              started(),
              permissionStep('step-dual', 'Run cmd'),
              permissionRequest('perm-dual', 'step-dual', [
                { id: 'allow', label: 'Allow', kind: 'allowOnce' },
              ]),
            ).pipe(Stream.concat(Stream.never)),
          'Session.getComposer': () => Effect.succeed({ text: '', images: [] }),
          'Session.setComposer': () => Effect.void,
        }),
      ),
    );

    @Component({
      selector: 'app-dual-session-host',
      imports: [SessionView],
      template: `
        <div data-testid="pane-1">
          <app-session-view [sessionId]="s1" [focused]="focused() === 's1'" />
        </div>
        <div data-testid="pane-2">
          <app-session-view [sessionId]="s2" [focused]="focused() === 's2'" />
        </div>
      `,
    })
    class DualSessionHost {
      readonly s1 = s1;
      readonly s2 = s2;
      focused = input<'s1' | 's2' | 'none'>('s1');
    }

    TestBed.configureTestingModule({
      providers: [
        { provide: DESKTOP_LAYER, useValue: dualLayer },
        { provide: KEYMAP_PLATFORM, useValue: 'other' },
        { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
      ],
    });
    const hostFixture = TestBed.createComponent(DualSessionHost);
    hostFixture.componentRef.setInput('focused', 'none');
    hostFixture.detectChanges();

    const hostEl = hostFixture.nativeElement as HTMLElement;
    const composer1 = () =>
      hostEl.querySelector<HTMLTextAreaElement>(
        '[data-testid="pane-1"] [data-testid="composer-input"]',
      )!;
    const composer2 = () =>
      hostEl.querySelector<HTMLTextAreaElement>(
        '[data-testid="pane-2"] [data-testid="composer-input"]',
      )!;

    await vi.waitFor(() => {
      hostFixture.detectChanges();
      expect(hostEl.querySelectorAll('[data-testid="dock-option"]')).toHaveLength(2);
    });

    // Neither SessionView is focused: neither composer stole focus on mount.
    expect(document.activeElement).not.toBe(composer1());
    expect(document.activeElement).not.toBe(composer2());

    // Both Sessions published independent SessionToolbar entries.
    const toolbar = TestBed.inject(SessionToolbar);
    expect(toolbar.entryFor(s1)).not.toBeNull();
    expect(toolbar.entryFor(s2)).not.toBeNull();
    expect(toolbar.entryFor(s1)).not.toBe(toolbar.entryFor(s2));

    // When neither is focused, shortcuts and type-to-focus do nothing.
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'a',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '1', code: 'Digit1', bubbles: true, cancelable: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }),
    );
    expect(modeToggled).toEqual([]);
    expect(answered).toEqual([]);
    expect(cancelled).toEqual([]);
    expect(composer1().value).toBe('');
    expect(composer2().value).toBe('');

    // Focus s2: shortcuts route exclusively to s2!
    hostFixture.componentRef.setInput('focused', 's2');
    hostFixture.detectChanges();

    // Mod+L focuses s2's composer only.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(composer2());

    // Mod+Shift+A toggles s2 only.
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'a',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(modeToggled).toEqual([{ sessionId: s2, value: 'ask' }]);

    // Digit1 answers s2's permission only.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '1', code: 'Digit1', bubbles: true, cancelable: true }),
    );
    expect(answered).toEqual([s2]);

    // Mod+Enter and Mod+Shift+Enter act on s2 only when both composers have text.
    composer1().value = 'one';
    composer1().dispatchEvent(new Event('input'));
    composer2().value = 'two';
    composer2().dispatchEvent(new Event('input'));
    hostFixture.detectChanges();
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() => expect(queued).toEqual([s2]));

    hostEl
      .querySelector<HTMLElement>('[data-testid="pane-2"] [data-testid="send-mode-steer"]')
      ?.click();
    composer2().value = 'steer two';
    composer2().dispatchEvent(new Event('input'));
    hostFixture.detectChanges();
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() => expect(steered).toEqual([s2]));

    // Esc stopTurn cancels s2 only.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(cancelled).toEqual([s2]));

    // Mod+Shift+M opens s2's model picker only.
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'm',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    hostFixture.detectChanges();
    expect(document.activeElement).toBe(
      hostEl.querySelector('[data-testid="pane-2"] [data-testid="model-picker"]'),
    );
  });

  it('focuses the Composer in DOM when activating an already-expanded unfocused Session Panel without hijacking text inputs', async () => {
    const projectId = ProjectId.make('p1');
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');
    const t1 = TabId.make('t1');
    const pane1 = PaneId.make('pane-1');
    const pane2 = PaneId.make('pane-2');
    const panel1 = PanelId.make('panel-1');
    const panel2 = PanelId.make('panel-2');
    const splitPane = PaneId.make('split-1');
    const activations = Effect.runSync(Queue.unbounded<TabActivation>());

    const layer = makeDesktopTestLayer(
      Layer.mergeAll(
        TabsRpcs.toLayer({
          'Tabs.restore': () =>
            Effect.succeed({
              workspace: {
                activeProjectId: projectId,
                projects: [
                  {
                    projectId,
                    activeTabId: t1,
                    tabs: [
                      {
                        id: t1,
                        focusedPanelId: panel1,
                        layout: {
                          rootPaneId: splitPane,
                          nodes: [
                            {
                              _tag: 'Split',
                              id: splitPane,
                              direction: 'horizontal',
                              ratio: 0.5,
                              first: pane1,
                              second: pane2,
                            },
                            {
                              _tag: 'Leaf',
                              id: pane1,
                              panels: [
                                {
                                  id: panel1,
                                  spec: { _tag: 'Session', sessionId: s1 },
                                  collapsed: false,
                                  heightShare: 1,
                                },
                              ],
                            },
                            {
                              _tag: 'Leaf',
                              id: pane2,
                              panels: [
                                {
                                  id: panel2,
                                  spec: { _tag: 'Session', sessionId: s2 },
                                  collapsed: false,
                                  heightShare: 1,
                                },
                              ],
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
              sessions: [
                { id: s1, projectId, title: { auto: 'One', autoIsPlaceholder: false } },
                { id: s2, projectId, title: { auto: 'Two', autoIsPlaceholder: false } },
              ],
            }),
          'Tabs.update': () => Effect.void,
          'Tabs.activations': () => Stream.fromQueue(activations),
        }),
        AgentsRpcs.toLayer({
          'Agents.list': () => Effect.succeed([]),
          'Agents.installCommand': () => Effect.die('unused'),
          'Agents.install': () => Effect.die('unused'),
          'Agents.openInstallLog': () => Effect.die('unused'),
        }),
        ProjectsRpcs.toLayer({
          'Projects.list': () => Effect.die('unused'),
          'Projects.add': () => Effect.die('unused'),
          'Projects.rename': () => Effect.die('unused'),
          'Projects.remove': () => Effect.die('unused'),
          'Projects.check': () =>
            Effect.succeed({
              id: projectId,
              name: 'app',
              path: '/work/app',
              addedAt: 1,
              lastUsedAt: 1,
              settings: {},
              folderMissing: false,
            }),
          'Projects.locate': () => Effect.die('unused'),
          'Projects.addFolder': () => Effect.die('unused'),
          'Projects.locateFolder': () => Effect.die('unused'),
          'Projects.setSettings': () => Effect.die('unused'),
        }),
        LinksRpcs.toLayer({ 'Links.openExternal': () => Effect.void }),
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
          'Session.listHandoffAttempts': () => Effect.succeed([]),
          'Session.events': () => Stream.make(liveWith()).pipe(Stream.concat(Stream.never)),
          'Session.getComposer': () => Effect.succeed({ text: '', images: [] }),
          'Session.setComposer': () => Effect.void,
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

    @Component({
      selector: 'app-activated-session-host',
      imports: [SessionView],
      template: `
        <button type="button" data-testid="sidebar-trigger-stub">Sidebar row</button>
        <input type="text" data-testid="other-text-input" />
        @if (tabs.restored()) {
          <div data-testid="pane-1">
            <app-session-view [sessionId]="s1" [focused]="tabs.active()?.session === s1" />
          </div>
          <div data-testid="pane-2">
            <app-session-view [sessionId]="s2" [focused]="tabs.active()?.session === s2" />
          </div>
        }
      `,
    })
    class ActivatedSessionHost {
      readonly tabs = inject(Tabs);
      readonly s1 = s1;
      readonly s2 = s2;
    }

    TestBed.configureTestingModule({
      providers: [
        { provide: DESKTOP_LAYER, useValue: layer },
        { provide: KEYMAP_PLATFORM, useValue: 'other' },
        { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
      ],
    });
    const hostFixture = TestBed.createComponent(ActivatedSessionHost);
    const tabs = TestBed.inject(Tabs);
    await vi.waitFor(() => {
      hostFixture.detectChanges();
      expect(tabs.restored()).toBe(true);
    });

    const hostEl = hostFixture.nativeElement as HTMLElement;
    const composer1 = () =>
      hostEl.querySelector<HTMLTextAreaElement>(
        '[data-testid="pane-1"] [data-testid="composer-input"]',
      )!;
    const composer2 = () =>
      hostEl.querySelector<HTMLTextAreaElement>(
        '[data-testid="pane-2"] [data-testid="composer-input"]',
      )!;

    await vi.waitFor(() => {
      hostFixture.detectChanges();
      expect(composer1()).not.toBeNull();
      expect(composer2()).not.toBeNull();
    });
    expect(document.activeElement).toBe(composer1());

    // Simulate clicking a sidebar button, then activating already-expanded unfocused s2.
    hostEl.querySelector<HTMLButtonElement>('[data-testid="sidebar-trigger-stub"]')!.focus();
    tabs.open({ id: s2, projectId, title: 'Two' });
    await vi.waitFor(() => {
      hostFixture.detectChanges();
      expect(document.activeElement).toBe(composer2());
    });

    // When a text input holds focus, Tabs.activations for s1 updates focus state without hijacking the text input.
    const otherInput = hostEl.querySelector<HTMLInputElement>('[data-testid="other-text-input"]')!;
    otherInput.focus();
    expect(document.activeElement).toBe(otherInput);
    Queue.offerUnsafe(activations, {
      sessionId: s1,
      projectId,
      title: { auto: 'One', autoIsPlaceholder: false },
    });
    await vi.waitFor(() => {
      hostFixture.detectChanges();
      expect(tabs.active()?.session).toBe(s1);
    });
    expect(document.activeElement).toBe(otherInput);

    // Clearing text-input focus and activating s1 again via Tabs.activations focuses s1's Composer.
    otherInput.blur();
    Queue.offerUnsafe(activations, {
      sessionId: s1,
      projectId,
      title: { auto: 'One', autoIsPlaceholder: false },
    });
    await vi.waitFor(() => {
      hostFixture.detectChanges();
      expect(document.activeElement).toBe(composer1());
    });
  });

  it('shows composer-border-beam while a Turn runs, switches to attention on pending PermissionRequest, and hides when settled', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);

    Queue.offerUnsafe(queue, live);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="composer-card"]')).not.toBeNull();
    });
    expect(root(fixture).querySelector('[data-testid="composer-border-beam"]')).toBeNull();

    // Turn running -> working border beam active on composer-card.
    Queue.offerUnsafe(queue, started());
    await vi.waitFor(() => {
      fixture.detectChanges();
      const beam = root(fixture).querySelector('[data-testid="composer-border-beam"]');
      expect(beam).not.toBeNull();
      expect(beam?.getAttribute('data-beam-state')).toBe('working');
    });

    // Pending PermissionRequest -> switches beam state to attention.
    Queue.offerAllUnsafe(queue, [
      permissionStep('s1', 'ls -la'),
      permissionRequest('p1', 's1', [{ id: 'allow', label: 'Allow once', kind: 'allowOnce' }]),
    ]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        root(fixture)
          .querySelector('[data-testid="composer-border-beam"]')
          ?.getAttribute('data-beam-state'),
      ).toBe('attention');
    });

    // Turn settles -> border beam hides cleanly.
    Queue.offerUnsafe(queue, ended());
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelector('[data-testid="composer-border-beam"]')).toBeNull();
    });
  });
});
