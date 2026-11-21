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
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmInputImports } from '@ui/input';
import { toast } from '@ui/toast';
import type { BrowserPage } from '../../../shared/browser/browser.rpc';
import { isAllowedExternalBrowserUrl } from '../../../shared/browser/url-policy';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import { BrowserPaneState } from '../../core/browser-pane';
import { Keymap } from '../../core/keymap';

/** Embedded Browser side pane: navigation toolbar, URL address bar, and native `WebContentsView` viewport slot. */
@Component({
  selector: 'app-browser-pane',
  imports: [HlmInputImports, HlmDropdownMenuImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'bg-background flex min-h-0 flex-1 flex-col',
    'data-testid': 'browser-pane',
  },
  template: `
    <div
      class="border-border/60 flex min-h-10 shrink-0 flex-wrap items-center gap-0.5 border-b px-2 py-1.5"
    >
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
        class="min-w-28 flex-1"
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

      <div class="bg-border/60 mx-0.5 h-4 w-px shrink-0" aria-hidden="true"></div>

      <button
        type="button"
        data-testid="browser-screenshot"
        class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-40"
        aria-label="Screenshot"
        i18n-aria-label
        title="Screenshot"
        i18n-title
        [disabled]="activePage() === null || capturingScreenshot()"
        (click)="captureScreenshot()"
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
          <path
            d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"
          />
          <circle cx="12" cy="13" r="3" />
        </svg>
      </button>

      <button
        type="button"
        data-testid="browser-element-picker"
        class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-40"
        [class.bg-accent]="pickerActive()"
        [class.text-foreground]="pickerActive()"
        aria-label="Element picker"
        i18n-aria-label
        title="Element picker"
        i18n-title
        [attr.aria-pressed]="pickerActive()"
        [disabled]="activePage() === null"
        (click)="browser.toggleElementPicker(sessionId())"
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
          <path
            d="M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z"
          />
          <path d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6" />
        </svg>
      </button>

      <button
        type="button"
        data-testid="browser-console-errors"
        class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-40"
        aria-label="Attach console errors"
        i18n-aria-label
        title="Attach console errors"
        i18n-title
        [disabled]="activePage() === null"
        (click)="attachConsoleErrors()"
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
          <path d="m7 11 2-2-2-2" />
          <path d="M11 13h4" />
          <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
        </svg>
      </button>

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
    ></div>

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
  private readonly keymap = inject(Keymap);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  readonly sessionId = input.required<SessionId>();

  private readonly viewportSlot = viewChild<ElementRef<HTMLElement>>('viewportSlot');
  protected readonly editingUrl = signal(false);
  protected readonly urlDraft = signal('');
  protected readonly capturingScreenshot = signal(false);

  protected readonly state = computed(() => this.browser.stateFor(this.sessionId()));
  protected readonly pickerActive = computed(() => this.state()?.pickerActive ?? false);
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
      const pageUrl = this.activePage()?.url ?? '';
      if (!untracked(() => this.editingUrl())) {
        this.urlDraft.set(pageUrl);
      }
    });

    afterNextRender(() => this.watchBounds());

    this.keymap.registerEscape({
      layer: 'selection',
      when: () => this.pickerActive(),
      run: () => void this.browser.cancelElementPicker(this.sessionId()),
      destroyRef: this.destroyRef,
    });
  }

  protected async captureScreenshot(): Promise<void> {
    if (this.capturingScreenshot()) return;
    this.capturingScreenshot.set(true);
    try {
      await this.browser.captureScreenshot(this.sessionId());
    } finally {
      this.capturingScreenshot.set(false);
    }
  }

  protected async attachConsoleErrors(): Promise<void> {
    const result = await this.browser.attachConsoleErrors(this.sessionId());
    if (result === 'empty') {
      toast.info($localize`No console or network errors recorded on this Page.`);
    }
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
  }
}
