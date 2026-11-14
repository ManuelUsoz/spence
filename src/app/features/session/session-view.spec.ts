import { Component, input, output } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Deferred, Effect, Layer, Queue, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentId, AgentsRpcs, type Agent } from '../../../shared/agents/agents.rpc';
import { ProjectId, ProjectsRpcs, type Project } from '../../../shared/projects/projects.rpc';
import {
  CompactionId,
  MessageId,
  PermissionRequestId,
  SessionError,
  SessionId,
  SessionsRpcs,
  StepId,
  STOP_AGENT_INTERRUPTED_DETAIL,
  TurnId,
  type LiveState,
  type MessagePart,
  type PermissionOption,
  type SessionStreamItem,
  type StopAgentResult,
  type TranscriptItem,
  type TurnOutcome,
} from '../../../shared/sessions/sessions.rpc';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM, Keymap } from '../../core/keymap';
import { SessionView } from './session-view';

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
  readonly prompts: Array<ReadonlyArray<MessagePart>>;
  readonly options: Array<{ readonly option: 'model' | 'effort'; readonly value: string }>;
  readonly answers: Array<{ readonly requestId: PermissionRequestId; readonly optionId: string }>;
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
  stopAgents: Array<{ readonly sessionId: SessionId; readonly force?: boolean }>;
  stopAgentEffect?: (force?: boolean) => Effect.Effect<StopAgentResult, SessionError>;
  retries: number;
  logins: number;
  loginCancelled: boolean;
  loginEffect?: Effect.Effect<void, SessionError>;
  logs: number;
  clears: number;
  startEmptyCalls: number;
  project?: Project;
  located?: Project | null;
  locates: number;
}

const serve = (subscriptions: Array<Stream.Stream<SessionStreamItem, SessionError>>): Served => ({
  subscriptions,
  afterSeqs: [],
  prompts: [],
  options: [],
  answers: [],
  optionChanges: [],
  agentChanges: [],
  composer: { text: '', images: [] },
  cancels: 0,
  stopAgents: [],
  retries: 0,
  logins: 0,
  loginCancelled: false,
  logs: 0,
  clears: 0,
  startEmptyCalls: 0,
  locates: 0,
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
      'Session.prompt': ({ parts }) =>
        Effect.sync(() => {
          served.prompts.push(parts);
          return turnId;
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
      'Session.answerPermission': ({ requestId, optionId }) =>
        Effect.sync(() => {
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
      'Session.startEmptyContext': () =>
        Effect.sync(() => {
          served.startEmptyCalls += 1;
        }),
      'Session.archive': () => Effect.die('not served in this spec'),
      'Session.unarchive': () => Effect.die('not served in this spec'),
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
            'Projects.check': () => Effect.succeed(project),
            'Projects.locate': () =>
              Effect.sync(() => {
                served.locates += 1;
                return served.located ?? null;
              }),
            'Projects.setSettings': () => Effect.die('unused'),
          }),
        ]),
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

const liveWith = (patch: Partial<LiveState> = {}): SessionStreamItem => ({
  _tag: 'Live',
  state: {
    agentStatus: 'ready',
    title: { autoIsPlaceholder: false },
    options: { permissionMode: 'auto' },
    commands: [],
    canAttachImages: false,
    imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
    ...patch,
  } satisfies LiveState,
});

afterEach(() => {
  seq = 0;
});

describe('SessionView', () => {
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
    const select = picker.querySelector('select') as HTMLSelectElement;
    await vi.waitFor(() => expect(select.options.length).toBe(2));
    expect(select.value).toBe('sonnet');

    select.value = 'opus';
    select.dispatchEvent(new Event('change'));
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
    await vi.waitFor(() => expect(byTestId(fixture, 'effort-picker')).not.toBeNull());

    const maxButton = byTestId(fixture, 'effort-max') as HTMLButtonElement;
    expect(maxButton.disabled).toBe(true);

    const lowButton = byTestId(fixture, 'effort-low') as HTMLButtonElement;
    lowButton.click();
    fixture.detectChanges();
    await vi.waitFor(() => expect(served.options).toEqual([{ option: 'effort', value: 'low' }]));
  });

  it('opens the Commands list on `/`, filters as the user types, and picks with Enter', async () => {
    const served = serve([
      Stream.make(
        liveWith({
          commands: [
            { name: 'compact', description: 'Compact the context' },
            { name: 'review', description: 'Review the changes', hint: 'what to review' },
          ],
        }),
      ).pipe(Stream.concat(Stream.never)),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() => expect(byTestId(fixture, 'clear-context')).not.toBeNull());

    type(fixture, '/');
    await vi.waitFor(() => expect(byTestId(fixture, 'commands-list')).not.toBeNull());
    const initial = root(fixture).querySelectorAll('[data-testid^="command-"]');
    expect(initial.length).toBe(3); // clear + compact + review

    type(fixture, '/co');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root(fixture).querySelectorAll('[data-testid^="command-"]').length).toBe(1);
    });
    expect(root(fixture).querySelector('[data-testid="command-compact"]')).not.toBeNull();

    press(fixture, 'Enter');
    await vi.waitFor(() => expect(composer(fixture).value).toBe('/compact '));
    expect(root(fixture).querySelector('[data-testid="commands-list"]')).toBeNull();
  });

  it('navigates the Commands list with arrow keys and closes with Escape', async () => {
    const served = serve([
      Stream.make(liveWith({ commands: [{ name: 'review', description: 'Review' }] })).pipe(
        Stream.concat(Stream.never),
      ),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() => expect(byTestId(fixture, 'clear-context')).not.toBeNull());

    type(fixture, '/');
    await vi.waitFor(() => expect(byTestId(fixture, 'commands-list')).not.toBeNull());

    press(fixture, 'ArrowDown');
    press(fixture, 'Enter');
    await vi.waitFor(() => expect(composer(fixture).value).toBe('/review '));

    type(fixture, '/');
    press(fixture, 'Escape');
    fixture.detectChanges();
    expect(root(fixture).querySelector('[data-testid="commands-list"]')).toBeNull();
  });

  it('sends an unknown `/word` as text', async () => {
    const served = serve([Stream.make(live).pipe(Stream.concat(Stream.never))]);
    const fixture = mount(served);
    await vi.waitFor(() => expect(byTestId(fixture, 'clear-context')).not.toBeNull());

    type(fixture, '/unknown');
    await vi.waitFor(() => expect(byTestId(fixture, 'commands-list')).not.toBeNull());

    press(fixture, 'Enter');
    await vi.waitFor(() => expect(served.prompts).toEqual([[{ _tag: 'text', text: '/unknown' }]]));
  });

  it('calls Session.clearContext from the Clear button and from the `/` list', async () => {
    const served = serve([Stream.make(live).pipe(Stream.concat(Stream.never))]);
    const fixture = mount(served);
    await vi.waitFor(() => expect(byTestId(fixture, 'clear-context')).not.toBeNull());

    byTestId(fixture, 'clear-context').click();
    await vi.waitFor(() => expect(served.clears).toBe(1));

    type(fixture, '/');
    await vi.waitFor(() => expect(byTestId(fixture, 'commands-list')).not.toBeNull());
    press(fixture, 'Enter');
    await vi.waitFor(() => expect(served.clears).toBe(2));
  });

  it('hides the Compact button when the Agent does not list `/compact`', async () => {
    const served = serve([
      Stream.make(liveWith({ commands: [{ name: 'review', description: 'Review' }] })).pipe(
        Stream.concat(Stream.never),
      ),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() => expect(byTestId(fixture, 'composer-input')).not.toBeNull());
    expect(root(fixture).querySelector('[data-testid="compact"]')).toBeNull();
  });

  it('shows the Compact button and inserts `/compact ` when clicked', async () => {
    const served = serve([
      Stream.make(
        liveWith({ commands: [{ name: 'compact', description: 'Compact the context' }] }),
      ).pipe(Stream.concat(Stream.never)),
    ]);
    const fixture = mount(served);
    await vi.waitFor(() => expect(byTestId(fixture, 'composer-input')).not.toBeNull());

    byTestId(fixture, 'compact').click();
    await vi.waitFor(() => expect(composer(fixture).value).toBe('/compact '));
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

  it('shows the Composer Permission mode control and changes it', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerUnsafe(queue, live);

    await vi.waitFor(() =>
      expect(root(fixture).querySelector('[data-testid="permission-mode-ask"]')).not.toBeNull(),
    );

    byTestId(fixture, 'permission-mode-ask').click();
    await vi.waitFor(() => expect(served.optionChanges).toEqual(['ask']));

    byTestId(fixture, 'permission-mode-ask').click();
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
    expect(byTestId(fixture, 'effort-picker')).not.toBeNull();

    const outsideBtn = document.createElement('button');
    document.body.append(outsideBtn);
    try {
      outsideBtn.focus();
      pressWindow(fixture, 'l', { ctrlKey: true });
      expect(document.activeElement).toBe(composer(fixture));

      pressWindow(fixture, 'M', { ctrlKey: true, shiftKey: true });
      const active = document.activeElement;
      expect(active?.id).toBe('model-picker');
      expect(byTestId(fixture, 'model-picker').contains(active)).toBe(true);

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
        expect(byTestId(fixture, 'permission-mode-ask').getAttribute('aria-pressed')).toBe('true');
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
      liveWith({ commands: [{ name: 'review', description: 'Review' }] }),
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
      liveWith({ commands: [{ name: 'review', description: 'Review' }] }),
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
        fixture.nativeElement.querySelector('[data-testid="draft-agent-picker"]'),
      ).not.toBeNull();
    });

    const select = byTestId(fixture, 'draft-agent-picker').querySelector('select');
    if (select === null) throw new Error('no draft-agent-picker select');
    select.value = codexId;
    select.dispatchEvent(new Event('change'));
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
      expect(fixture.nativeElement.querySelector('[data-testid="draft-agent-picker"]')).toBeNull();
    });
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
        },
        options: { permissionMode: 'auto' },
      }),
    ]);

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="models-unavailable"]'),
      ).not.toBeNull();
    });
    expect((byTestId(fixture, 'permission-mode-ask') as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId(fixture, 'models-limitation').textContent).toContain('Third-party models');
    expect(
      fixture.nativeElement.querySelector('[data-testid="effort-unavailable"]'),
    ).not.toBeNull();

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
});
