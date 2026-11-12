import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Queue, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompactionId,
  MessageId,
  SessionError,
  SessionId,
  SessionsRpcs,
  StepId,
  TurnId,
  type LiveState,
  type MessagePart,
  type SessionStreamItem,
  type TranscriptItem,
  type TurnOutcome,
} from '../../../shared/sessions/sessions.rpc';
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

interface Served {
  /** What each `Session.events` subscription streams, in order of subscription. */
  readonly subscriptions: Array<Stream.Stream<SessionStreamItem, SessionError>>;
  readonly afterSeqs: Array<number | undefined>;
  readonly prompts: Array<ReadonlyArray<MessagePart>>;
  cancels: number;
}

const serve = (subscriptions: Array<Stream.Stream<SessionStreamItem, SessionError>>): Served => ({
  subscriptions,
  afterSeqs: [],
  prompts: [],
  cancels: 0,
});

const handlers = (served: Served) =>
  SessionsRpcs.toLayer({
    'Session.list': () => Effect.succeed([]),
    'Session.create': () => Effect.succeed(sessionId),
    'Session.prompt': ({ parts }) =>
      Effect.sync(() => {
        served.prompts.push(parts);
        return turnId;
      }),
    'Session.cancel': () =>
      Effect.sync(() => {
        served.cancels += 1;
      }),
    'Session.events': ({ afterSeq }) => {
      served.afterSeqs.push(afterSeq);
      return served.subscriptions.shift() ?? Stream.never;
    },
  });

const mount = (served: Served): ComponentFixture<SessionView> => {
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers(served)) }],
  });
  const fixture = TestBed.createComponent(SessionView);
  fixture.componentRef.setInput('sessionId', sessionId);
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
  return root(fixture).querySelector('[data-testid="dock"]');
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

const sendButton = (fixture: ComponentFixture<SessionView>) =>
  byTestId(fixture, 'send') as HTMLButtonElement;

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
});
