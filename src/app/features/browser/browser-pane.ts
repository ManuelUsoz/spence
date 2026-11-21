import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  effect,
  type ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmInputImports } from '@ui/input';
import type { BrowserPage, PageId } from '../../../shared/browser/browser.rpc';
import { isAllowedExternalBrowserUrl } from '../../../shared/browser/url-policy';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import { BrowserPaneState } from '../../core/browser-pane';
import { OverlayOcclusion } from '../../core/overlay-occlusion';

/** Embedded Browser side pane: Page strip, navigation toolbar, URL address bar, and native `WebContentsView` viewport slot. */
@Component({
  selector: 'app-browser-pane',
  imports: [HlmButtonImports, HlmInputImports, HlmDropdownMenuImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'bg-background flex min-h-0 flex-1 flex-col',
    'data-testid': 'browser-pane',
  },
  template: `
    <div
      role="tablist"
      aria-label="Browser pages"
      i18n-aria-label
      data-testid="browser-page-strip"
      class="border-border/60 bg-tray/60 flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-2"
    >
      @for (page of pages(); track page.id) {
        <div
          data-testid="browser-page-tab"
          [attr.data-page-id]="page.id"
          [attr.data-active]="isActivePage(page) ? 'true' : null"
          class="group flex h-7 max-w-44 shrink-0 items-center rounded-md pr-1 transition-colors"
          [class]="
            isActivePage(page)
              ? 'bg-background text-foreground ring-border shadow-xs ring-1'
              : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
          "
        >
          <button
            type="button"
            role="tab"
            data-testid="browser-page-select"
            [attr.data-page-id]="page.id"
            [attr.aria-selected]="isActivePage(page)"
            class="focus-visible:ring-ring flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-md px-2 text-left text-xs outline-none focus-visible:ring-2"
            [class.font-medium]="isActivePage(page)"
            (click)="selectPage(page.id)"
          >
            @if (page.loading) {
              <span
                aria-hidden="true"
                class="size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
              ></span>
            }
            <span data-testid="browser-page-title" class="truncate">{{ pageTitle(page) }}</span>
          </button>
          <button
            type="button"
            data-testid="browser-page-close"
            [attr.data-page-id]="page.id"
            [attr.aria-label]="closePageLabel(page)"
            [title]="closePageLabel(page)"
            class="hover:bg-accent focus-visible:ring-ring flex size-5 shrink-0 items-center justify-center rounded-sm opacity-70 outline-none group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2"
            (click)="closePage(page.id)"
          >
            <svg
              class="size-3"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      }

      <button
        type="button"
        data-testid="browser-new-page"
        class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
        aria-label="New Page"
        i18n-aria-label
        title="New Page"
        i18n-title
        (click)="createPage()"
      >
        <svg
          class="size-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>

    <div class="border-border/60 flex h-10 shrink-0 items-center gap-1 border-b px-2">
      <button
        type="button"
        data-testid="browser-back"
        class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-40"
        aria-label="Back"
        i18n-aria-label
        title="Back"
        i18n-title
        [disabled]="!(activePage()?.canGoBack ?? false)"
        (click)="browser.goBack(sessionId())"
      >
        <svg
          class="size-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>

      <button
        type="button"
        data-testid="browser-forward"
        class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-40"
        aria-label="Forward"
        i18n-aria-label
        title="Forward"
        i18n-title
        [disabled]="!(activePage()?.canGoForward ?? false)"
        (click)="browser.goForward(sessionId())"
      >
        <svg
          class="size-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>

      <button
        type="button"
        data-testid="browser-reload"
        class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-40"
        aria-label="Reload"
        i18n-aria-label
        title="Reload"
        i18n-title
        [disabled]="activePage() === null"
        (click)="browser.reload(sessionId())"
      >
        <svg
          class="size-3.5"
          [class.animate-spin]="activePage()?.loading ?? false"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
      </button>

      <form
        class="min-w-0 flex-1"
        data-testid="browser-url-form"
        (submit)="submitUrl($event, urlInput)"
      >
        <input
          #urlInput
          hlmInput
          type="text"
          spellcheck="false"
          autocomplete="off"
          data-testid="browser-url-input"
          class="h-7 w-full font-mono text-xs"
          aria-label="Browser address"
          i18n-aria-label
          placeholder="Enter URL (e.g. localhost:3000)"
          i18n-placeholder
          [value]="urlDraft()"
          (input)="onUrlInput(urlInput.value)"
          (focus)="editingUrl.set(true)"
          (blur)="onUrlBlur()"
          (keydown.escape)="cancelUrlEdit(urlInput)"
        />
      </form>

      <button
        type="button"
        data-testid="browser-open-external"
        class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-40"
        aria-label="Open in default browser"
        i18n-aria-label
        title="Open in default browser"
        i18n-title
        [disabled]="!canOpenExternal()"
        (click)="browser.openExternal(sessionId())"
      >
        <svg
          class="size-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M15 3h6v6" />
          <path d="M10 14 21 3" />
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        </svg>
      </button>

      <button
        type="button"
        data-testid="browser-more"
        class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
        aria-label="Browser options"
        i18n-aria-label
        title="Browser options"
        i18n-title
        aria-haspopup="menu"
        [hlmDropdownMenuTrigger]="browserMenu"
      >
        <svg
          class="size-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </svg>
      </button>

      <button
        type="button"
        data-testid="browser-close"
        class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
        aria-label="Close Browser"
        i18n-aria-label
        title="Close Browser"
        i18n-title
        (click)="browser.setOpen(sessionId(), false)"
      >
        <svg
          class="size-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </div>

    @if (errorMessage(); as message) {
      <div
        data-testid="browser-error"
        role="alert"
        class="border-destructive/30 bg-destructive/10 text-destructive shrink-0 border-b px-3 py-1.5 text-xs"
      >
        {{ message }}
      </div>
    }

    <div
      #viewportSlot
      data-testid="browser-viewport"
      class="bg-background relative min-h-0 flex-1 overflow-hidden"
    >
      @if (state(); as current) {
        @if (current.pages.length === 0) {
          <div
            data-testid="browser-empty-state"
            class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
          >
            <p class="font-display text-muted-foreground text-xl" i18n>No Pages open</p>
            <p class="text-muted-foreground max-w-xs text-sm" i18n>
              Open a new Page or enter a web address above.
            </p>
            <button
              type="button"
              hlmBtn
              variant="outline"
              size="sm"
              data-testid="browser-empty-new-page"
              (click)="createPage()"
              i18n
            >
              New Page
            </button>
          </div>
        } @else if (current.occluded && current.lastFrameDataUrl; as frameUrl) {
          <img
            data-testid="browser-occluded-frame"
            [src]="frameUrl"
            alt=""
            aria-hidden="true"
            class="pointer-events-none block size-full object-cover object-left-top select-none"
          />
        }
      }
    </div>

    <ng-template #browserMenu>
      <hlm-dropdown-menu class="w-48 rounded-xl" data-testid="browser-more-menu">
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="browser-devtools"
          [disabled]="activePage() === null"
          (triggered)="browser.openDevTools(sessionId())"
          i18n
        >
          Open DevTools
        </button>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class BrowserPane {
  protected readonly browser = inject(BrowserPaneState);
  private readonly occlusion = inject(OverlayOcclusion);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  readonly sessionId = input.required<SessionId>();

  private readonly viewportSlot = viewChild<ElementRef<HTMLElement>>('viewportSlot');
  protected readonly editingUrl = signal(false);
  protected readonly urlDraft = signal('');

  protected readonly state = computed(() => this.browser.stateFor(this.sessionId()));
  protected readonly pages = computed(() => this.state()?.pages ?? []);
  protected readonly activePageId = computed(() => this.state()?.activePageId ?? null);
  protected readonly activePage = computed((): BrowserPage | null => {
    const current = this.state();
    if (current === null || current.activePageId === null) return null;
    return current.pages.find((page) => page.id === current.activePageId) ?? null;
  });
  protected readonly canOpenExternal = computed(() => {
    const url = this.activePage()?.url;
    return url !== undefined && isAllowedExternalBrowserUrl(url);
  });
  protected readonly errorMessage = computed(() => this.browser.errorFor(this.sessionId()));

  constructor() {
    effect(() => {
      const id = this.sessionId();
      untracked(() => {
        this.editingUrl.set(false);
        this.browser.ensureLoaded(id);
        this.reportBounds();
      });
    });

    effect(() => {
      this.activePageId();
      untracked(() => this.editingUrl.set(false));
    });

    effect(() => {
      const pageUrl = this.activePage()?.url ?? '';
      if (!untracked(() => this.editingUrl())) {
        this.urlDraft.set(pageUrl);
      }
    });

    afterNextRender(() => this.watchBounds());
  }

  protected isActivePage(page: BrowserPage): boolean {
    return page.id === this.activePageId();
  }

  protected pageTitle(page: BrowserPage): string {
    const trimmed = page.title.trim();
    if (trimmed === '') return $localize`New Page`;
    if (page.url === 'about:blank' && trimmed.toLowerCase() === 'about:blank') {
      return $localize`New Page`;
    }
    return trimmed;
  }

  protected closePageLabel(page: BrowserPage): string {
    return $localize`Close ${this.pageTitle(page)}:title:`;
  }

  protected createPage(): void {
    void this.browser.createPage(this.sessionId());
  }

  protected selectPage(pageId: PageId): void {
    void this.browser.selectPage(this.sessionId(), pageId);
  }

  protected closePage(pageId: PageId): void {
    void this.browser.closePage(this.sessionId(), pageId);
  }

  protected onUrlInput(value: string): void {
    this.urlDraft.set(value);
    this.browser.clearError(this.sessionId());
  }

  protected onUrlBlur(): void {
    this.editingUrl.set(false);
    if (this.errorMessage() === null) {
      this.urlDraft.set(this.activePage()?.url ?? '');
    }
  }

  protected cancelUrlEdit(inputEl: HTMLInputElement): void {
    this.editingUrl.set(false);
    this.browser.clearError(this.sessionId());
    const currentUrl = this.activePage()?.url ?? '';
    this.urlDraft.set(currentUrl);
    inputEl.value = currentUrl;
    inputEl.blur();
  }

  protected async submitUrl(event: Event, inputEl: HTMLInputElement): Promise<void> {
    event.preventDefault();
    const ok = await this.browser.navigate(this.sessionId(), this.urlDraft());
    if (ok) {
      this.editingUrl.set(false);
      inputEl.blur();
    }
  }

  private watchBounds(): void {
    const slot = this.viewportSlot()?.nativeElement;
    if (slot === undefined) return;
    const report = () => this.reportBounds();
    const win = this.document.defaultView;
    win?.addEventListener('resize', report, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(report);
      observer.observe(slot);
      observer.observe(this.document.body);
    }
    const rafId = win?.requestAnimationFrame(report);
    this.destroyRef.onDestroy(() => {
      win?.removeEventListener('resize', report);
      observer?.disconnect();
      if (rafId !== undefined) win?.cancelAnimationFrame(rafId);
    });
    report();
  }

  private reportBounds(): void {
    const slot = this.viewportSlot()?.nativeElement;
    if (slot === undefined) return;
    const rect = slot.getBoundingClientRect();
    this.browser.setBounds(this.sessionId(), {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
    this.occlusion.recheck();
  }
}
