import { Component, input, output } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Deferred, Effect, Layer, Queue, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentId, type Agent } from '../../../shared/agents/agents.rpc';
import { ProjectId, ProjectsRpcs, type Project } from '../../../shared/projects/projects.rpc';
import {
  CompactionId,
  MessageId,
  PermissionRequestId,
  SessionError,
  SessionId,
  SessionsRpcs,
  StepId,
  TurnId,
  type LiveState,
  type MessagePart,
  type PermissionOption,
  type SessionStreamItem,
  type TranscriptItem,
  type TurnOutcome,
} from '../../../shared/sessions/sessions.rpc';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
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
  composer: {
    readonly text: string;
    readonly images: ReadonlyArray<{
      readonly name: string;
      readonly mimeType: string;
      readonly data: string;
    }>;
  };
  cancels: number;
  retries: number;
  logins: number;
  loginCancelled: boolean;
  loginEffect?: Effect.Effect<void, SessionError>;
  logs: number;
  clears: number;
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
  composer: { text: '', images: [] },
  cancels: 0,
  retries: 0,
  logins: 0,
  loginCancelled: false,
  logs: 0,
  clears: 0,
  locates: 0,
});

const handlers = (served: Served) => {
  const { project } = served;
  return Layer.mergeAll(
    SessionsRpcs.toLayer({
      'Session.changes': () => Stream.empty,
      'Session.list': () => Effect.succeed([]),
      'Session.create': () => Effect.succeed(sessionId),
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

const press = (fixture: ComponentFixture<SessionView>, key: string, shiftKey = false) => {
  const keydown = new KeyboardEvent('keydown', { key, shiftKey, cancelable: true });
  composer(fixture).dispatchEvent(keydown);
  fixture.detectChanges();
  return keydown;
};

const pressWindow = (fixture: ComponentFixture<SessionView>, key: string) => {
  const keydown = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true });
  window.dispatchEvent(keydown);
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

    const keydown = pressWindow(fixture, '2');
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
    const keydown = new KeyboardEvent('keydown', { key: '1', cancelable: true, bubbles: true });
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
});
