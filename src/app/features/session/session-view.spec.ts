import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Queue, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MessageId,
  SessionError,
  SessionId,
  SessionsRpcs,
  TurnId,
  type LiveState,
  type MessagePart,
  type SessionStreamItem,
  type TranscriptItem,
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
const ended = () => event({ _tag: 'TurnEnded', turnId, outcome: { _tag: 'done' } });

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
});
