import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { toast } from '@ui/toast';
import { Effect, Queue, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MessageId,
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

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
/** The first bytes of a PNG: enough for its size to be read. */
const png = (name: string, width = 10, height = 10, padding = 0): File =>
  new File(
    [
      new Uint8Array([
        0x89,
        ...ascii('PNG\r\n'),
        0x1a,
        0x0a,
        ...u32be(13),
        ...ascii('IHDR'),
        ...u32be(width),
        ...u32be(height),
        ...new Array<number>(5 + padding).fill(0),
      ]),
    ],
    name,
    { type: 'image/png' },
  );
const pngBase64 = (width = 10, height = 10) =>
  btoa(
    String.fromCharCode(
      0x89,
      ...ascii('PNG\r\n'),
      0x1a,
      0x0a,
      ...u32be(13),
      ...ascii('IHDR'),
      ...u32be(width),
      ...u32be(height),
      0,
      0,
      0,
      0,
      0,
    ),
  );

const liveState = (overrides: Partial<LiveState> = {}): SessionStreamItem => ({
  _tag: 'Live',
  state: {
    agentStatus: 'ready',
    title: { autoIsPlaceholder: false },
    options: { permissionMode: 'auto' },
    commands: [],
    canAttachImages: true,
    imageLimits: { maxBase64Bytes: 1000, maxDimensionPx: 100, maxPerMessage: 2 },
    agentName: 'Claude',
    ...overrides,
  },
});

let seq = 0;
const event = (item: TranscriptItem): SessionStreamItem => ({
  _tag: 'Transcript',
  event: { seq: ++seq, at: seq, item },
});

interface Served {
  readonly prompts: Array<ReadonlyArray<MessagePart>>;
}

const mount = (stream: Stream.Stream<SessionStreamItem>) => {
  const served: Served = { prompts: [] };
  const handlers = SessionsRpcs.toLayer({
    'Session.list': () => Effect.succeed([]),
    'Session.create': () => Effect.succeed(sessionId),
    'Session.prompt': ({ parts }) =>
      Effect.sync(() => {
        served.prompts.push(parts);
        return turnId;
      }),
    'Session.setOption': () => Effect.die('not served'),
    'Session.clearContext': () => Effect.die('not served'),
    'Session.archive': () => Effect.die('not served'),
    'Session.unarchive': () => Effect.die('not served'),
    'Session.delete': () => Effect.die('not served'),
    'Session.answerPermission': () => Effect.die('not served'),
    'Session.cancel': () => Effect.void,
    'Session.events': () => stream,
  });
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers) }],
  });
  const fixture = TestBed.createComponent(SessionView);
  fixture.componentRef.setInput('sessionId', sessionId);
  fixture.detectChanges();
  return { fixture, served };
};

const following = (state: SessionStreamItem, ...rest: ReadonlyArray<SessionStreamItem>) =>
  Stream.make(state, ...rest).pipe(Stream.concat(Stream.never));

const root = (fixture: ComponentFixture<SessionView>): HTMLElement =>
  fixture.nativeElement as HTMLElement;

const all = (fixture: ComponentFixture<SessionView>, id: string) => {
  fixture.detectChanges();
  return [...root(fixture).querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
};

const one = (fixture: ComponentFixture<SessionView>, id: string): HTMLElement => {
  const [element] = all(fixture, id);
  if (element === undefined) throw new Error(`no ${id}`);
  return element;
};

/** Offers files through the paperclip's file input. */
const pick = (fixture: ComponentFixture<SessionView>, files: ReadonlyArray<File>) => {
  const input = one(fixture, 'attach-input') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
};

const paste = (fixture: ComponentFixture<SessionView>, files: ReadonlyArray<File>) => {
  const pasted = new Event('paste', { cancelable: true });
  Object.defineProperty(pasted, 'clipboardData', { value: { files } });
  one(fixture, 'composer-input').dispatchEvent(pasted);
};

const type = (fixture: ComponentFixture<SessionView>, text: string) => {
  const input = one(fixture, 'composer-input') as HTMLTextAreaElement;
  input.value = text;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
};

const sendButton = (fixture: ComponentFixture<SessionView>) =>
  one(fixture, 'send') as HTMLButtonElement;

afterEach(() => {
  seq = 0;
  vi.restoreAllMocks();
});

describe('SessionView Images', () => {
  it('sends attached Images before the text, and empties the Composer', async () => {
    const { fixture, served } = mount(following(liveState()));
    await vi.waitFor(() => expect(all(fixture, 'attach').length).toBe(1));

    pick(fixture, [png('one.png')]);
    await vi.waitFor(() => expect(all(fixture, 'image-thumbnail').length).toBe(1));
    type(fixture, 'Look');
    sendButton(fixture).click();

    await vi.waitFor(() =>
      expect(served.prompts).toEqual([
        [
          { _tag: 'image', mimeType: 'image/png', data: pngBase64() },
          { _tag: 'text', text: 'Look' },
        ],
      ]),
    );
    await vi.waitFor(() => expect(all(fixture, 'image-thumbnail').length).toBe(0));
  });

  it('removes an attached Image with its ×', async () => {
    const { fixture } = mount(following(liveState()));
    pick(fixture, [png('one.png')]);
    await vi.waitFor(() => expect(all(fixture, 'image-thumbnail').length).toBe(1));
    one(fixture, 'image-remove').click();
    expect(all(fixture, 'image-thumbnail').length).toBe(0);
  });

  it('refuses a file that is not an image, with a toast', async () => {
    const toastError = vi.spyOn(toast, 'error');
    const { fixture } = mount(following(liveState()));
    pick(fixture, [new File(['notes'], 'notes.txt', { type: 'text/plain' })]);
    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining('Only images can be attached'),
      ),
    );
    expect(all(fixture, 'image-thumbnail').length).toBe(0);
  });

  it('refuses an image over the size or side limit, saying why', async () => {
    const toastError = vi.spyOn(toast, 'error');
    const { fixture } = mount(following(liveState()));
    await vi.waitFor(() => expect(all(fixture, 'attach').length).toBe(1));
    pick(fixture, [png('huge.png', 10, 10, 1000), png('wide.png', 101, 10)]);
    await vi.waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('huge.png is too large'));
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('wide.png is too large'));
    });
    expect(all(fixture, 'image-thumbnail').length).toBe(0);
  });

  it('refuses the Images past the count a Message can hold', async () => {
    const toastError = vi.spyOn(toast, 'error');
    const { fixture } = mount(following(liveState()));
    await vi.waitFor(() => expect(all(fixture, 'attach').length).toBe(1));
    pick(fixture, [png('a.png'), png('b.png'), png('c.png')]);
    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining('A Message can hold up to 2 images'),
      ),
    );
    expect(all(fixture, 'image-thumbnail').length).toBe(2);
  });

  it("disables the paperclip and refuses pasted Images when the Agent can't take them", async () => {
    const toastError = vi.spyOn(toast, 'error');
    const { fixture } = mount(following(liveState({ canAttachImages: false })));
    await vi.waitFor(() =>
      expect((one(fixture, 'attach') as HTMLButtonElement).disabled).toBe(true),
    );
    paste(fixture, [png('one.png')]);
    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Claude can't take images")),
    );
    expect(all(fixture, 'image-thumbnail').length).toBe(0);
  });

  it("blocks Send while Images attached before the Agent was ready can't be taken", async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const { fixture, served } = mount(Stream.fromQueue(queue));
    Queue.offerUnsafe(queue, liveState({ agentStatus: 'starting', canAttachImages: false }));
    await vi.waitFor(() => expect(all(fixture, 'attach').length).toBe(1));
    pick(fixture, [png('early.png')]);
    await vi.waitFor(() => expect(all(fixture, 'image-thumbnail').length).toBe(1));
    type(fixture, 'Look');

    Queue.offerUnsafe(queue, liveState({ canAttachImages: false }));
    await vi.waitFor(() =>
      expect(one(fixture, 'images-blocked').textContent).toContain(
        "Claude can't take images. Remove them to send.",
      ),
    );
    expect(sendButton(fixture).disabled).toBe(true);

    one(fixture, 'image-remove').click();
    expect(all(fixture, 'images-blocked').length).toBe(0);
    expect(sendButton(fixture).disabled).toBe(false);
    sendButton(fixture).click();
    await vi.waitFor(() => expect(served.prompts).toEqual([[{ _tag: 'text', text: 'Look' }]]));
  });

  it("shows a Message's Images above its text, and opens them in a lightbox", async () => {
    const parts: ReadonlyArray<MessagePart> = [
      { _tag: 'image', mimeType: 'image/png', data: 'AAAA' },
      { _tag: 'image', mimeType: 'image/png', data: 'BBBB' },
      { _tag: 'text', text: 'Two shots' },
    ];
    const { fixture } = mount(
      following(
        liveState(),
        event({ _tag: 'TurnStarted', turnId, permissionMode: 'auto' }),
        event({ _tag: 'Message', id: MessageId.make('u1'), turnId, role: 'user', parts }),
      ),
    );
    await vi.waitFor(() => expect(all(fixture, 'message-images').length).toBe(1));
    const thumbnails = one(fixture, 'message-images').querySelectorAll('img');
    expect([...thumbnails].map((img) => img.getAttribute('src'))).toEqual([
      'data:image/png;base64,AAAA',
      'data:image/png;base64,BBBB',
    ]);

    one(fixture, 'message-images').querySelector('button')?.click();
    fixture.detectChanges();
    const lightboxImage = () =>
      document.querySelector('[data-testid="lightbox-image"]')?.getAttribute('src');
    await vi.waitFor(() => expect(lightboxImage()).toBe('data:image/png;base64,AAAA'));
    document
      .querySelector('[data-testid="lightbox"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    await vi.waitFor(() => expect(lightboxImage()).toBe('data:image/png;base64,BBBB'));
  });

  it('returns a failed Message to the empty Composer with its Images', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const { fixture, served } = mount(Stream.fromQueue(queue));
    Queue.offerUnsafe(queue, liveState());
    await vi.waitFor(() => expect(all(fixture, 'attach').length).toBe(1));
    pick(fixture, [png('one.png')]);
    await vi.waitFor(() => expect(all(fixture, 'image-thumbnail').length).toBe(1));
    type(fixture, 'Look');
    sendButton(fixture).click();
    await vi.waitFor(() => expect(served.prompts.length).toBe(1));
    await vi.waitFor(() => expect(all(fixture, 'image-thumbnail').length).toBe(0));

    Queue.offerAllUnsafe(queue, [
      event({ _tag: 'TurnStarted', turnId, permissionMode: 'auto' }),
      event({
        _tag: 'Message',
        id: MessageId.make('u1'),
        turnId,
        role: 'user',
        parts: [
          { _tag: 'image', mimeType: 'image/png', data: pngBase64() },
          { _tag: 'text', text: 'Look' },
        ],
      }),
      event({
        _tag: 'TurnEnded',
        turnId,
        outcome: { _tag: 'failed', reason: 'agentError', detail: 'Overloaded' },
      }),
    ]);
    await vi.waitFor(() => expect(all(fixture, 'image-remove').length).toBe(1));
    expect((one(fixture, 'composer-input') as HTMLTextAreaElement).value).toBe('Look');
  });
  it('restores a running Turn after recreating the view without restoring an old failure', async () => {
    const queue = Effect.runSync(Queue.unbounded<SessionStreamItem>());
    const { fixture } = mount(Stream.fromQueue(queue));
    const oldTurn = TurnId.make('old-turn');
    Queue.offerAllUnsafe(queue, [
      liveState({ runningTurn: turnId }),
      event({ _tag: 'TurnStarted', turnId: oldTurn, permissionMode: 'auto' }),
      event({
        _tag: 'Message',
        id: MessageId.make('old'),
        turnId: oldTurn,
        role: 'user',
        parts: [{ _tag: 'text', text: 'Old' }],
      }),
      event({
        _tag: 'TurnEnded',
        turnId: oldTurn,
        outcome: { _tag: 'failed', reason: 'agentError', detail: 'Old failure' },
      }),
      event({ _tag: 'TurnStarted', turnId, permissionMode: 'auto' }),
      event({
        _tag: 'Message',
        id: MessageId.make('new'),
        turnId,
        role: 'user',
        parts: [
          { _tag: 'image', mimeType: 'image/png', data: pngBase64() },
          { _tag: 'text', text: 'Look' },
        ],
      }),
    ]);
    await vi.waitFor(() => expect(all(fixture, 'message-images')).toHaveLength(1));
    expect((one(fixture, 'composer-input') as HTMLTextAreaElement).value).toBe('');
    Queue.offerUnsafe(
      queue,
      event({
        _tag: 'TurnEnded',
        turnId,
        outcome: { _tag: 'failed', reason: 'agentError', detail: 'Overloaded' },
      }),
    );
    await vi.waitFor(() => expect(all(fixture, 'image-remove')).toHaveLength(1));
    expect((one(fixture, 'composer-input') as HTMLTextAreaElement).value).toBe('Look');
  });
});
