import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Queue, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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

const step = (id: string, title: string, status = 'pending' as const) =>
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
  readonly answers: Array<{ readonly requestId: PermissionRequestId; readonly optionId: string }>;
  readonly optionChanges: Array<'ask' | 'auto'>;
  cancels: number;
}

const serve = (subscriptions: Array<Stream.Stream<SessionStreamItem, SessionError>>): Served => ({
  subscriptions,
  afterSeqs: [],
  prompts: [],
  answers: [],
  optionChanges: [],
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
    'Session.answerPermission': ({ requestId, optionId }) =>
      Effect.sync(() => {
        served.answers.push({ requestId, optionId });
      }),
    'Session.setOption': (change) =>
      Effect.sync(() => {
        if (change.option === 'permissionMode') served.optionChanges.push(change.value);
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

const pressWindow = (fixture: ComponentFixture<SessionView>, key: string) => {
  const keydown = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true });
  window.dispatchEvent(keydown);
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

  it('shows the Dock for a pending Permission request and answers it', async () => {
    const options: ReadonlyArray<PermissionOption> = [
      { id: 'reject', label: 'Reject', kind: 'rejectOnce' },
      { id: 'allow', label: 'Allow once', kind: 'allowOnce' },
    ];
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const served = serve([Stream.fromQueue(queue)]);
    const fixture = mount(served);
    Queue.offerAllUnsafe(queue, [live, started(), userMessage('Run it'), step('s1', 'ls -la')]);

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
      step('s1', 'ls -la'),
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
      step('s1', 'ls -la'),
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
      step('s1', 'ls -la'),
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
      step('s1', 'ls -la'),
      permissionRequest('p1', 's1', autoOptions, 'answered', 'policy'),
      step('s2', 'rm -rf /'),
      permissionRequest('p2', 's2', rejectOptions, 'answered'),
      agentMessage('Done'),
      event({ _tag: 'TurnEnded', turnId, outcome: { _tag: 'done' } }),
    ]);

    await vi.waitFor(() =>
      expect(root(fixture).querySelectorAll('[data-testid="receipt-step"]')).toHaveLength(2),
    );
    const marks = [...root(fixture).querySelectorAll('[data-testid="receipt-mark"]')].map(
      (element) => element.textContent?.trim() ?? '',
    );
    expect(marks).toEqual(['auto', 'rejected']);
  });
});
