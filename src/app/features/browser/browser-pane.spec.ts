import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Queue, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_DEFAULT_WIDTH,
  BrowserError,
  BrowserRpcs,
  PageId,
  type BrowserEvent,
  type BrowserState,
} from '../../../shared/browser/browser.rpc';
import { parseUserUrl } from '../../../shared/browser/url-policy';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
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
  readonly pushState: (state: BrowserState) => void;
}

const mountPane = async (initial: BrowserState = makeState()): Promise<PaneHarness> => {
  let state = initial;
  let nextPageNumber = 2;
  const navigated: Array<string> = [];
  const calls: Array<string> = [];
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
    'Browser.navigate': ({ url }) =>
      Effect.gen(function* () {
        navigated.push(url);
        const parsed = parseUserUrl(url);
        if (!parsed.ok) {
          return yield* new BrowserError({ reason: parsed.reason, detail: parsed.detail });
        }
        const activeId = state.activePageId ?? p1;
        state = {
          ...state,
          pages: state.pages.map((page) =>
            page.id === activeId
              ? {
                  ...page,
                  url: parsed.url,
                  title: 'Loaded Page',
                  loading: false,
                  canGoBack: true,
                  canGoForward: false,
                }
              : page,
          ),
          activePageId: activeId,
        };
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
    'Browser.createPage': ({ url }) =>
      Effect.sync(() => {
        const id = PageId.make(`page-${nextPageNumber++}`);
        calls.push(`createPage:${id}`);
        const page = {
          id,
          url: url ?? 'about:blank',
          title: '',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          suspended: false,
        };
        state = {
          ...state,
          pages: [...state.pages, page],
          activePageId: id,
        };
        return state;
      }),
    'Browser.selectPage': ({ pageId }) =>
      Effect.sync(() => {
        calls.push(`selectPage:${pageId}`);
        state = { ...state, activePageId: pageId };
        return state;
      }),
    'Browser.closePage': ({ pageId }) =>
      Effect.sync(() => {
        calls.push(`closePage:${pageId}`);
        const index = state.pages.findIndex((page) => page.id === pageId);
        const rest = state.pages.filter((page) => page.id !== pageId);
        const nextActive =
          state.activePageId === pageId
            ? ((rest[index] ?? rest[index - 1])?.id ?? null)
            : state.activePageId;
        state = {
          ...state,
          pages: rest,
          activePageId: nextActive,
        };
        return state;
      }),
    'Browser.events': () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<BrowserEvent>();
          publishEvent = (event) => {
            Queue.offerUnsafe(queue, event);
          };
          return Stream.fromQueue(queue);
        }),
      ),
  });

  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers) }],
  });

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
    navigated,
    calls,
    pushState: (next) => {
      state = next;
      publishEvent?.({ _tag: 'State', state: next });
    },
  };
};

afterEach(() => {
  document.body.innerHTML = '';
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

  it('renders Page strip with New Page fallback, switches/creates/closes Pages, and shows empty state when 0 Pages exist', async () => {
    const p2 = PageId.make('page-2');
    const { fixture, calls, pushState } = await mountPane();
    const root = fixture.nativeElement as HTMLElement;

    const tabs = () =>
      Array.from(root.querySelectorAll<HTMLElement>('[data-testid="browser-page-tab"]'));
    const tabTitle = (el: HTMLElement) =>
      el.querySelector('[data-testid="browser-page-title"]')?.textContent?.trim();
    const urlInput = root.querySelector('[data-testid="browser-url-input"]') as HTMLInputElement;

    // Initial untitled about:blank Page uses fallback label and active highlight.
    expect(root.querySelector('[data-testid="browser-page-strip"]')).not.toBeNull();
    expect(tabs()).toHaveLength(1);
    expect(tabTitle(tabs()[0]!)).toBe('New Page');
    expect(tabs()[0]?.getAttribute('data-active')).toBe('true');
    expect(root.querySelector('[data-testid="browser-empty-state"]')).toBeNull();

    // Clicking New Page (+) creates a second Page.
    (root.querySelector('[data-testid="browser-new-page"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(calls).toContain(`createPage:${p2}`);
      expect(tabs()).toHaveLength(2);
      expect(tabs()[1]?.getAttribute('data-active')).toBe('true');
      expect(tabs()[0]?.getAttribute('data-active')).toBeNull();
    });

    // Host state event updates Page titles and URLs; user can switch back to Page 1.
    pushState(
      makeState({
        pages: [
          {
            id: p1,
            url: 'https://one.example',
            title: 'Page One',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            suspended: false,
          },
          {
            id: p2,
            url: 'https://two.example',
            title: 'Page Two',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            suspended: false,
          },
        ],
        activePageId: p2,
      }),
    );

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(tabTitle(tabs()[0]!)).toBe('Page One');
      expect(tabTitle(tabs()[1]!)).toBe('Page Two');
      expect(urlInput.value).toBe('https://two.example');
    });

    // While user was typing in URL bar, switching tabs resets editing and shows newly selected Page's URL.
    urlInput.dispatchEvent(new Event('focus'));
    urlInput.value = 'https://typing.example';
    urlInput.dispatchEvent(new Event('input'));

    (tabs()[0]?.querySelector('[data-testid="browser-page-select"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(calls).toContain(`selectPage:${p1}`);
      expect(tabs()[0]?.getAttribute('data-active')).toBe('true');
      expect(urlInput.value).toBe('https://one.example');
    });

    // Close Page 1 and then Page 2 -> renders empty state inside viewport with New Page action.
    (tabs()[0]?.querySelector('[data-testid="browser-page-close"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(calls).toContain(`closePage:${p1}`);
      expect(tabs()).toHaveLength(1);
      expect(tabTitle(tabs()[0]!)).toBe('Page Two');
      expect(urlInput.value).toBe('https://two.example');
    });

    (tabs()[0]?.querySelector('[data-testid="browser-page-close"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(calls).toContain(`closePage:${p2}`);
      expect(tabs()).toHaveLength(0);
      expect(urlInput.value).toBe('');
      expect(root.querySelector('[data-testid="browser-empty-state"]')).not.toBeNull();
    });

    // Clicking empty state's New Page button creates a Page and hides the empty state.
    (root.querySelector('[data-testid="browser-empty-new-page"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(tabs()).toHaveLength(1);
      expect(root.querySelector('[data-testid="browser-empty-state"]')).toBeNull();
      expect(urlInput.value).toBe('about:blank');
    });
  });
});
