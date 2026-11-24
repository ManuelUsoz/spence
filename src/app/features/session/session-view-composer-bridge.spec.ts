import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { toast } from '@ui/toast';
import { Deferred, Effect, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionId,
  SessionsRpcs,
  TurnId,
  type ComposerDraft,
  type LiveState,
  type MessagePart,
  type SessionStreamItem,
} from '../../../shared/sessions/sessions.rpc';
import { ComposerBridge } from '../../core/composer-bridge';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { SessionView } from './session-view';

const sessionId = SessionId.make('bridge-session-1');
const turnId = TurnId.make('bridge-turn-1');

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const pngBase64 = (width = 10, height = 10, padding = 0) =>
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
      ...new Array<number>(5 + padding).fill(0),
    ),
  );

const liveState = (overrides: Partial<LiveState> = {}): SessionStreamItem => ({
  _tag: 'Live',
  state: {
    agentStatus: 'ready',
    status: 'idle',
    title: { autoIsPlaceholder: false },
    options: { permissionMode: 'auto' },
    commands: [],
    commandsLoaded: true,
    queue: [],
    canAttachImages: true,
    imageLimits: { maxBase64Bytes: 1000, maxDimensionPx: 100, maxPerMessage: 2 },
    agentName: 'Claude',
    ...overrides,
  },
});

const mount = (
  options: {
    readonly live?: Partial<LiveState>;
    readonly getComposer?: Effect.Effect<ComposerDraft>;
  } = {},
) => {
  const prompts: Array<ReadonlyArray<MessagePart>> = [];
  const handlers = SessionsRpcs.toLayer({
    'Session.changes': () => Stream.empty,
    'Session.list': () => Effect.succeed([]),
    'Session.create': () => Effect.succeed(sessionId),
    'Session.setAgent': () => Effect.die('unused'),
    'Session.prompt': ({ parts }) =>
      Effect.sync(() => {
        prompts.push(parts);
        return turnId;
      }),
    'Session.steer': () => Effect.die('unused'),
    'Session.enqueue': () => Effect.die('unused'),
    'Session.setQueue': () => Effect.die('unused'),
    'Session.clearQueue': () => Effect.die('unused'),
    'Session.setOption': () => Effect.die('unused'),
    'Session.clearContext': () => Effect.die('unused'),
    'Session.compact': () => Effect.die('unused'),
    'Session.startEmptyContext': () => Effect.die('unused'),
    'Session.prepareHandoff': () => Effect.die('unused'),
    'Session.revalidateHandoff': () => Effect.die('unused'),
    'Session.executeHandoff': () => Effect.die('unused'),
    'Session.listHandoffAttempts': () => Effect.die('unused'),
    'Session.archive': () => Effect.die('unused'),
    'Session.unarchive': () => Effect.die('unused'),
    'Session.countWorkers': () => Effect.die('unused'),
    'Session.delete': () => Effect.die('unused'),
    'Session.answerPermission': () => Effect.die('unused'),
    'Session.rename': () => Effect.void,
    'Session.openAgentLog': () => Effect.void,
    'Session.retryAgent': () => Effect.void,
    'Session.loginAgent': () => Effect.void,
    'Session.cancel': () => Effect.void,
    'Session.stopAgent': () => Effect.die('unused'),
    'Session.events': () => Stream.make(liveState(options.live)).pipe(Stream.concat(Stream.never)),
    'Session.getComposer': () => options.getComposer ?? Effect.succeed({ text: '', images: [] }),
    'Session.setComposer': () => Effect.void,
  });

  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers) }],
  });

  const bridge = TestBed.inject(ComposerBridge);
  const fixture = TestBed.createComponent(SessionView);
  fixture.componentRef.setInput('sessionId', sessionId);
  fixture.detectChanges();
  return { fixture, bridge, prompts };
};

const composerInput = (fixture: ComponentFixture<SessionView>): HTMLTextAreaElement => {
  fixture.detectChanges();
  const el = (fixture.nativeElement as HTMLElement).querySelector<HTMLTextAreaElement>(
    '[data-testid="composer-input"]',
  );
  if (el === null) throw new Error('expected composer-input');
  return el;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SessionView ComposerBridge integration', () => {
  it('drains screenshots through admitImages + imageHeaderSize, appends element/error text, focuses composer, and sends', async () => {
    const { fixture, bridge, prompts } = mount();
    await vi.waitFor(() => {
      expect(composerInput(fixture)).toBeDefined();
    });

    const shot = pngBase64(16, 12);
    bridge.attachImage(sessionId, {
      name: 'browser-screenshot.png',
      mimeType: 'image/png',
      data: shot,
    });
    bridge.attachPickedElement(sessionId, {
      selector: '#submit-btn',
      tagName: 'button',
      text: 'Save',
      htmlExcerpt: '<button id="submit-btn">Save</button>',
    });

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="image-thumbnail"]'),
      ).toHaveLength(1);
      const input = composerInput(fixture);
      expect(input.value).toContain('#submit-btn');
      expect(document.activeElement).toBe(input);
    });

    bridge.attachConsoleErrors(sessionId, [
      {
        kind: 'network',
        message: 'GET 500',
        url: 'http://localhost:3000/api/fail',
        status: 500,
        at: 1,
      },
    ]);

    await vi.waitFor(() => {
      const input = composerInput(fixture);
      expect(input.value).toContain('#submit-btn');
      expect(input.value).toContain('[network] GET 500 (http://localhost:3000/api/fail)');
    });

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-testid="send"]')
      ?.click();
    await vi.waitFor(() => {
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.[0]).toEqual({ _tag: 'image', mimeType: 'image/png', data: shot });
      expect(prompts[0]?.[1]).toMatchObject({ _tag: 'text' });
    });
  });

  it('waits until composerLoaded restores existing draft before draining queued bridge items', async () => {
    const deferred = Effect.runSync(Deferred.make<ComposerDraft>());
    const { fixture, bridge } = mount({ getComposer: Deferred.await(deferred) });

    bridge.attachText(sessionId, 'Browser errors:\n- [console] Boom');
    fixture.detectChanges();
    expect(composerInput(fixture).value).toBe('');

    Effect.runSync(Deferred.succeed(deferred, { text: 'Investigate this:', images: [] }));
    await vi.waitFor(() => {
      expect(composerInput(fixture).value).toBe(
        'Investigate this:\n\nBrowser errors:\n- [console] Boom',
      );
    });
  });

  it('refuses oversized or unsupported screenshots through admitImages with a toast', async () => {
    const toastError = vi.spyOn(toast, 'error');
    const { fixture, bridge } = mount({ live: { canAttachImages: false } });
    await vi.waitFor(() => {
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[data-testid="attach"]'),
      ).not.toBeNull();
    });

    bridge.attachImage(sessionId, {
      name: 'browser-screenshot.png',
      mimeType: 'image/png',
      data: pngBase64(12, 12),
    });

    await vi.waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Claude can't take images"));
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="image-thumbnail"]'),
    ).toHaveLength(0);
  });
});
