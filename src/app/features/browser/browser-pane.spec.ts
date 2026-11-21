import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmDialogImports } from '@ui/dialog';
import { HlmPopoverImports } from '@ui/popover';
import { HlmSheetImports } from '@ui/sheet';
import { toast } from '@ui/toast';
import { HlmTooltipImports } from '@ui/tooltip';
import { Effect, Queue, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_DEFAULT_WIDTH,
  type BrowserConsoleError,
  BrowserError,
  BrowserRpcs,
  PageId,
  type BrowserEvent,
  type BrowserScreenshotResult,
  type BrowserState,
} from '../../../shared/browser/browser.rpc';
import { parseUserUrl } from '../../../shared/browser/url-policy';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import { ComposerBridge } from '../../core/composer-bridge';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { BrowserPane } from './browser-pane';

const s1 = SessionId.make('browser-ui-s1');
const p1 = PageId.make('page-1');

const makeState = (overrides: Partial<BrowserState> = {}): BrowserState => ({
  sessionId: s1,
  open: true,
  width: BROWSER_DEFAULT_WIDTH,
  pages: [
    {
      id: p1,
      url: 'about:blank',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      suspended: false,
    },
  ],
  activePageId: p1,
  control: { _tag: 'idle' },
  pickerActive: false,
  occluded: false,
  ...overrides,
});

interface PaneHarness {
  readonly fixture: ComponentFixture<BrowserPane>;
  readonly navigated: Array<string>;
  readonly calls: Array<string>;
  readonly bridge: ComposerBridge;
  readonly occludedCalls: Array<boolean>;
  readonly pushState: (state: BrowserState) => void;
  readonly pushEvent: (event: BrowserEvent) => void;
  readonly setConsoleErrors: (errors: ReadonlyArray<BrowserConsoleError>) => void;
}

const sampleShot: BrowserScreenshotResult = {
  name: 'browser-screenshot.png',
  mimeType: 'image/png',
  data: 'iVBORw0KGgo=',
};

const makeBrowserHandlers = (
  initial: BrowserState,
  onPublishReady?: (publish: (event: BrowserEvent) => void) => void,
) => {
  let state = initial;
  const navigated: Array<string> = [];
  const calls: Array<string> = [];
  const occludedCalls: Array<boolean> = [];
  let recordedErrors: ReadonlyArray<BrowserConsoleError> = [];
  let publishEvent: ((event: BrowserEvent) => void) | undefined;

  const handlers = BrowserRpcs.toLayer({
    'Browser.getState': () => Effect.succeed(state),
    'Browser.setOpen': ({ open }) =>
      Effect.sync(() => {
        calls.push(`setOpen:${String(open)}`);
        state = { ...state, open };
        return state;
      }),
    'Browser.setWidth': ({ width }) =>
      Effect.sync(() => {
        state = { ...state, width };
        return state;
      }),
    'Browser.setActiveSession': () => Effect.void,
    'Browser.setBounds': () => Effect.void,
    'Browser.setOccluded': ({ occluded, captureFrame }) =>
      Effect.sync(() => {
        occludedCalls.push(occluded);
        const { lastFrameDataUrl: _prev, ...rest } = state;
        state = {
          ...rest,
          occluded,
          ...(occluded && captureFrame !== false
            ? { lastFrameDataUrl: 'data:image/png;base64,captured' }
            : {}),
        };
        publishEvent?.({ _tag: 'State', state });
      }),
    'Browser.navigate': ({ url }) =>
      Effect.gen(function* () {
        navigated.push(url);
        const parsed = parseUserUrl(url);
        if (!parsed.ok) {
          return yield* new BrowserError({ reason: parsed.reason, detail: parsed.detail });
        }
        state = makeState({
          pages: [
            {
              id: p1,
              url: parsed.url,
              title: 'Loaded Page',
              loading: false,
              canGoBack: true,
              canGoForward: false,
              suspended: false,
            },
          ],
        });
        return state;
      }),
    'Browser.goBack': () =>
      Effect.sync(() => {
        calls.push('goBack');
        return state;
      }),
    'Browser.goForward': () =>
      Effect.sync(() => {
        calls.push('goForward');
        return state;
      }),
    'Browser.reload': () =>
      Effect.sync(() => {
        calls.push('reload');
        return state;
      }),
    'Browser.openExternal': () =>
      Effect.sync(() => {
        calls.push('openExternal');
      }),
    'Browser.openDevTools': () =>
      Effect.sync(() => {
        calls.push('openDevTools');
      }),
    'Browser.captureScreenshot': () =>
      Effect.sync(() => {
        calls.push('captureScreenshot');
        return sampleShot;
      }),
    'Browser.startElementPicker': () =>
      Effect.sync(() => {
        calls.push('startElementPicker');
        state = { ...state, pickerActive: true };
        return state;
      }),
    'Browser.cancelElementPicker': () =>
      Effect.sync(() => {
        calls.push('cancelElementPicker');
        state = { ...state, pickerActive: false };
        return state;
      }),
    'Browser.getConsoleErrors': () =>
      Effect.sync(() => {
        calls.push('getConsoleErrors');
        return { errors: recordedErrors };
      }),
    'Browser.events': () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<BrowserEvent>();
          publishEvent = (event) => {
            Queue.offerUnsafe(queue, event);
          };
          onPublishReady?.(publishEvent);
          return Stream.fromQueue(queue);
        }),
      ),
  });

  return {
    handlers,
    navigated,
    calls,
    occludedCalls,
    pushState: (next: BrowserState) => {
      state = next;
      publishEvent?.({ _tag: 'State', state: next });
    },
    pushEvent: (event: BrowserEvent) => {
      publishEvent?.(event);
    },
    setConsoleErrors: (errors: ReadonlyArray<BrowserConsoleError>) => {
      recordedErrors = errors;
    },
  };
};

const mountPane = async (initial: BrowserState = makeState()): Promise<PaneHarness> => {
  const harness = makeBrowserHandlers(initial);

  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(harness.handlers) }],
  });

  const bridge = TestBed.inject(ComposerBridge);
  const fixture = TestBed.createComponent(BrowserPane);
  fixture.componentRef.setInput('sessionId', s1);
  fixture.detectChanges();

  await vi.waitFor(() => {
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector(
      '[data-testid="browser-url-input"]',
    ) as HTMLInputElement | null;
    expect(input?.value).toBe(initial.pages[0]?.url ?? '');
  });

  return {
    fixture,
    navigated: harness.navigated,
    calls: harness.calls,
    bridge,
    occludedCalls: harness.occludedCalls,
    pushState: harness.pushState,
    pushEvent: harness.pushEvent,
    setConsoleErrors: harness.setConsoleErrors,
  };
};

@Component({
  selector: 'app-browser-occlusion-host',
  imports: [
    BrowserPane,
    HlmDialogImports,
    HlmAlertDialogImports,
    HlmSheetImports,
    HlmPopoverImports,
    HlmTooltipImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      data-testid="left-tip-trigger"
      [hlmTooltip]="'Sidebar tip'"
      position="right"
    >
      Tip
    </button>
    <hlm-popover>
      <button type="button" hlmPopoverTrigger data-testid="popover-trigger">Popover</button>
      <div *hlmPopoverPortal="let ctx" hlmPopoverContent data-testid="test-popover">
        Popover body
      </div>
    </hlm-popover>

    <hlm-dialog
      [state]="dialogOpen() ? 'open' : 'closed'"
      (stateChanged)="dialogOpen.set($event === 'open')"
    >
      <hlm-dialog-content *hlmDialogPortal="let ctx" data-testid="test-dialog">
        <h2 hlmDialogTitle>Dialog</h2>
      </hlm-dialog-content>
    </hlm-dialog>

    <hlm-alert-dialog
      [state]="alertOpen() ? 'open' : 'closed'"
      (stateChanged)="alertOpen.set($event === 'open')"
    >
      <hlm-alert-dialog-content *hlmAlertDialogPortal="let ctx" data-testid="test-alert-dialog">
        <h2 hlmAlertDialogTitle>Alert</h2>
      </hlm-alert-dialog-content>
    </hlm-alert-dialog>

    <hlm-sheet
      [state]="sheetOpen() ? 'open' : 'closed'"
      (stateChanged)="sheetOpen.set($event === 'open')"
    >
      <hlm-sheet-content *hlmSheetPortal="let ctx" data-testid="test-sheet">
        <h2 hlmSheetTitle>Sheet</h2>
      </hlm-sheet-content>
    </hlm-sheet>

    <app-browser-pane [sessionId]="sessionId" />
  `,
})
class BrowserOcclusionHost {
  readonly sessionId = s1;
  readonly dialogOpen = signal(false);
  readonly alertOpen = signal(false);
  readonly sheetOpen = signal(false);
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('BrowserPane', () => {
  it('renders navigation controls, disables back/forward/external on about:blank, and navigates on submit', async () => {
    const { fixture, navigated } = await mountPane();
    const root = fixture.nativeElement as HTMLElement;

    const back = root.querySelector('[data-testid="browser-back"]') as HTMLButtonElement;
    const forward = root.querySelector('[data-testid="browser-forward"]') as HTMLButtonElement;
    const external = root.querySelector(
      '[data-testid="browser-open-external"]',
    ) as HTMLButtonElement;
    const urlInput = root.querySelector('[data-testid="browser-url-input"]') as HTMLInputElement;
    const form = root.querySelector('[data-testid="browser-url-form"]') as HTMLFormElement;

    expect(back.disabled).toBe(true);
    expect(forward.disabled).toBe(true);
    expect(external.disabled).toBe(true);
    expect(root.querySelector('[data-testid="browser-viewport"]')).not.toBeNull();

    urlInput.value = 'localhost:3000/app';
    urlInput.dispatchEvent(new Event('input'));
    form.dispatchEvent(new Event('submit'));

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(navigated).toEqual(['localhost:3000/app']);
      expect(urlInput.value).toBe('http://localhost:3000/app');
      expect(back.disabled).toBe(false);
      expect(external.disabled).toBe(false);
    });
  });

  it('shows an error message for blocked schemes and invokes back, forward, reload, external, devtools, and close', async () => {
    const { fixture, calls } = await mountPane(
      makeState({
        pages: [
          {
            id: p1,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            canGoBack: true,
            canGoForward: true,
            suspended: false,
          },
        ],
      }),
    );
    const root = fixture.nativeElement as HTMLElement;
    const urlInput = root.querySelector('[data-testid="browser-url-input"]') as HTMLInputElement;
    const form = root.querySelector('[data-testid="browser-url-form"]') as HTMLFormElement;

    urlInput.value = 'javascript:alert(1)';
    urlInput.dispatchEvent(new Event('input'));
    form.dispatchEvent(new Event('submit'));

    await vi.waitFor(() => {
      fixture.detectChanges();
      const error = root.querySelector('[data-testid="browser-error"]');
      expect(error?.textContent?.trim().length).toBeGreaterThan(0);
    });

    (root.querySelector('[data-testid="browser-back"]') as HTMLButtonElement).click();
    (root.querySelector('[data-testid="browser-forward"]') as HTMLButtonElement).click();
    (root.querySelector('[data-testid="browser-reload"]') as HTMLButtonElement).click();
    (root.querySelector('[data-testid="browser-open-external"]') as HTMLButtonElement).click();
    (root.querySelector('[data-testid="browser-more"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    await vi.waitFor(() => {
      const devtools = document.querySelector<HTMLElement>('[data-testid="browser-devtools"]');
      expect(devtools).not.toBeNull();
      devtools?.click();
    });

    (root.querySelector('[data-testid="browser-close"]') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(calls).toEqual([
        'goBack',
        'goForward',
        'reload',
        'openExternal',
        'openDevTools',
        'setOpen:false',
      ]);
    });
  });

  it('captures screenshots, toggles/escapes element picker, and attaches or toasts console errors via ComposerBridge', async () => {
    const toastInfo = vi.spyOn(toast, 'info');
    const { fixture, calls, bridge, pushEvent, pushState, setConsoleErrors } = await mountPane();
    const root = fixture.nativeElement as HTMLElement;

    const screenshotBtn = root.querySelector(
      '[data-testid="browser-screenshot"]',
    ) as HTMLButtonElement;
    const pickerBtn = root.querySelector(
      '[data-testid="browser-element-picker"]',
    ) as HTMLButtonElement;
    const errorsBtn = root.querySelector(
      '[data-testid="browser-console-errors"]',
    ) as HTMLButtonElement;

    expect(screenshotBtn).not.toBeNull();
    expect(pickerBtn).not.toBeNull();
    expect(errorsBtn).not.toBeNull();
    expect(pickerBtn.getAttribute('aria-pressed')).toBe('false');

    // Screenshot queues image in ComposerBridge.
    screenshotBtn.click();
    await vi.waitFor(() => {
      expect(calls).toContain('captureScreenshot');
      expect(bridge.consume(s1)).toEqual([{ kind: 'image', image: sampleShot }]);
    });

    // Element picker enters active state, cancels on Escape, and toggles off on second click.
    pickerBtn.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(calls).toContain('startElementPicker');
      expect(pickerBtn.getAttribute('aria-pressed')).toBe('true');
    });

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true }),
    );
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(calls).toContain('cancelElementPicker');
      expect(pickerBtn.getAttribute('aria-pressed')).toBe('false');
    });

    // Toggling the Element picker button while active also cancels it.
    pickerBtn.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(pickerBtn.getAttribute('aria-pressed')).toBe('true');
    });
    pickerBtn.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(pickerBtn.getAttribute('aria-pressed')).toBe('false');
    });

    // Clicking an element inside Page emits ElementPicked + State(pickerActive: false) and queues snippet.
    pickerBtn.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(pickerBtn.getAttribute('aria-pressed')).toBe('true');
    });
    pushState(makeState({ pickerActive: false }));
    pushEvent({
      _tag: 'ElementPicked',
      sessionId: s1,
      element: {
        selector: 'button#buy',
        tagName: 'button',
        text: 'Buy',
        htmlExcerpt: '<button id="buy">Buy</button>',
      },
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(pickerBtn.getAttribute('aria-pressed')).toBe('false');
      const items = bridge.consume(s1);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: 'text' });
      if (items[0]?.kind === 'text') {
        expect(items[0].text).toContain('button#buy');
        expect(items[0].text).toContain('<button id="buy">Buy</button>');
      }
    });

    // Empty console errors show an info toast without queuing anything.
    errorsBtn.click();
    await vi.waitFor(() => {
      expect(toastInfo).toHaveBeenCalledWith(
        expect.stringContaining('No console or network errors'),
      );
      expect(bridge.pendingFor(s1)).toEqual([]);
    });

    // Recorded console and network errors are formatted and queued into ComposerBridge.
    setConsoleErrors([
      { kind: 'console', message: 'Boom', url: 'http://localhost:3000/app.js:4', at: 1 },
      {
        kind: 'network',
        message: 'GET 500',
        url: 'http://localhost:3000/api/data',
        status: 500,
        at: 2,
      },
    ]);
    errorsBtn.click();
    await vi.waitFor(() => {
      const items = bridge.consume(s1);
      expect(items).toHaveLength(1);
      if (items[0]?.kind === 'text') {
        expect(items[0].text).toContain('[console] Boom');
        expect(items[0].text).toContain('[network] GET 500');
      }
    });
  });

  it('signals occlusion and renders static lastFrameDataUrl while dropdown menu is open, then restores on close', async () => {
    const { fixture, occludedCalls } = await mountPane();
    const root = fixture.nativeElement as HTMLElement;

    (root.querySelector('[data-testid="browser-more"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(occludedCalls.at(-1)).toBe(true);
      const frame = root.querySelector<HTMLImageElement>('[data-testid="browser-occluded-frame"]');
      expect(frame).not.toBeNull();
      expect(frame?.getAttribute('src')).toBe('data:image/png;base64,captured');
    });

    const menu = document.querySelector<HTMLElement>('[data-testid="browser-more-menu"]');
    expect(menu).not.toBeNull();
    menu?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }),
    );
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(occludedCalls.at(-1)).toBe(false);
      expect(root.querySelector('[data-testid="browser-occluded-frame"]')).toBeNull();
    });
  });

  it('occludes across Spartan dialog, alert-dialog, sheet, and popover overlays while ignoring non-intersecting tooltips', async () => {
    const harness = makeBrowserHandlers(makeState());
    TestBed.configureTestingModule({
      providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(harness.handlers) }],
    });

    const fixture = TestBed.createComponent(BrowserOcclusionHost);
    fixture.detectChanges();
    const host = fixture.componentInstance;
    const root = fixture.nativeElement as HTMLElement;

    await vi.waitFor(() => {
      fixture.detectChanges();
      const input = root.querySelector<HTMLInputElement>('[data-testid="browser-url-input"]');
      expect(input?.value).toBe('about:blank');
    });

    // Non-intersecting left-side tooltip must NOT occlude.
    const tipTrigger = root.querySelector<HTMLElement>('[data-testid="left-tip-trigger"]')!;
    tipTrigger.dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    });
    expect(harness.occludedCalls).not.toContain(true);
    tipTrigger.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    // Dialog opens -> occluded true; closes -> occluded false.
    host.dialogOpen.set(true);
    fixture.detectChanges();
    await vi.waitFor(() => expect(harness.occludedCalls.at(-1)).toBe(true));
    host.dialogOpen.set(false);
    fixture.detectChanges();
    await vi.waitFor(() => expect(harness.occludedCalls.at(-1)).toBe(false));

    // AlertDialog opens -> occluded true; closes -> occluded false.
    host.alertOpen.set(true);
    fixture.detectChanges();
    await vi.waitFor(() => expect(harness.occludedCalls.at(-1)).toBe(true));
    host.alertOpen.set(false);
    fixture.detectChanges();
    await vi.waitFor(() => expect(harness.occludedCalls.at(-1)).toBe(false));

    // Sheet opens -> occluded true; closes -> occluded false.
    host.sheetOpen.set(true);
    fixture.detectChanges();
    await vi.waitFor(() => expect(harness.occludedCalls.at(-1)).toBe(true));
    host.sheetOpen.set(false);
    fixture.detectChanges();
    await vi.waitFor(() => expect(harness.occludedCalls.at(-1)).toBe(false));

    // Popover opens -> occluded true; closes -> occluded false.
    root.querySelector<HTMLButtonElement>('[data-testid="popover-trigger"]')!.click();
    fixture.detectChanges();
    await vi.waitFor(() => expect(harness.occludedCalls.at(-1)).toBe(true));
    root.querySelector<HTMLButtonElement>('[data-testid="popover-trigger"]')!.click();
    fixture.detectChanges();
    await vi.waitFor(() => expect(harness.occludedCalls.at(-1)).toBe(false));
  });
});
