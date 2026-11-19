import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { HlmSidebarImports } from '@ui/sidebar';
import { HlmToasterImports } from '@ui/sonner';
import {
  BROWSER_MAX_WIDTH,
  BROWSER_MIN_WIDTH,
  clampBrowserWidth,
} from '../../../shared/browser/browser.rpc';
import { isRemoteDevice } from '../../../shared/browser/url-policy';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import { BROWSER_PANE_VIEW, BrowserPaneState } from '../../core/browser-pane';
import { Keymap } from '../../core/keymap';
import { CHANGES_VIEW, ChangesState, changesSessionOf } from '../../core/changes-view';
import { SESSION_VIEW } from '../../core/session-view';
import { Tabs } from '../../core/tabs';
import { AppSidebar } from './app-sidebar';
import { ProjectSettingsSheet } from './project-settings-sheet';
import { ProjectsState } from './projects-state';
import { SessionConfirmDialog } from './session-confirm-dialog';
import { SettingsPage } from './settings/settings-page';
import { SettingsState } from './settings-state';
import { TopBar } from './top-bar';

/**
 * The window's frame: the sidebar on one side; beside it the top bar and the open Session, or whatever view the
 * router shows when no Session is open.
 */
@Component({
  selector: 'app-shell',
  imports: [
    HlmSidebarImports,
    HlmToasterImports,
    AppSidebar,
    SettingsPage,
    ProjectSettingsSheet,
    RouterOutlet,
    TopBar,
    SessionConfirmDialog,
    NgComponentOutlet,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div hlmSidebarWrapper>
      <app-sidebar />
      <main hlmSidebarInset class="min-w-0">
        <app-top-bar />
        @if (browserPaneReady() && activeBrowserSession(); as browserSessionId) {
          <div
            #splitContainer
            class="flex h-[calc(100svh-3rem)] overflow-hidden"
            data-testid="shell-split"
          >
            <div class="min-w-0 flex-1 overflow-y-auto p-6" data-testid="shell-thread-pane">
              @if (tabs.active(); as tab) {
                @if (sessionView; as view) {
                  <ng-container
                    *ngComponentOutlet="view; inputs: { tab, projectName: projectName() }"
                  />
                }
              }
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize Browser pane"
              i18n-aria-label
              [attr.aria-valuenow]="browserWidth()"
              [attr.aria-valuemin]="minBrowserWidth"
              [attr.aria-valuemax]="maxBrowserWidth"
              tabindex="0"
              data-testid="browser-resize-handle"
              class="bg-border hover:bg-ring/60 w-1 shrink-0 cursor-col-resize touch-none transition-colors select-none"
              (pointerdown)="startResize($event, splitContainer, browserSessionId)"
              (keydown.arrowLeft)="nudgeWidth(splitContainer, browserSessionId, 16)"
              (keydown.arrowRight)="nudgeWidth(splitContainer, browserSessionId, -16)"
            ></div>
            <aside
              data-testid="browser-pane-container"
              class="bg-background flex h-full shrink-0 flex-col"
              [style.width.px]="browserWidth()"
            >
              @if (browserView; as view) {
                <ng-container *ngComponentOutlet="view; inputs: { sessionId: browserSessionId }" />
              }
            </aside>
          </div>
        } @else {
          <div class="flex-1 p-6">
            @if (settings.open()) {
              <app-settings-page />
            } @else if (tabs.active(); as tab) {
              @if (changes.open() && changesView && changesSessionOf(tab); as sessionId) {
                <ng-container
                  *ngComponentOutlet="
                    changesView;
                    inputs: { sessionId, running: tab.running ?? false }
                  "
                />
              } @else if (sessionView; as view) {
                <ng-container
                  *ngComponentOutlet="view; inputs: { tab, projectName: projectName() }"
                />
              }
            } @else {
              <router-outlet />
            }
          </div>
        }
      </main>
    </div>
    <app-project-settings-sheet />
    <app-session-confirm-dialog />
    <!-- prefers-color-scheme follows the Theme Setting: main sets nativeTheme.themeSource. -->
    <hlm-toaster theme="system" />
  `,
})
export class Shell {
  protected readonly minBrowserWidth = BROWSER_MIN_WIDTH;
  protected readonly maxBrowserWidth = BROWSER_MAX_WIDTH;
  protected readonly tabs = inject(Tabs);
  protected readonly sessionView = inject(SESSION_VIEW);
  protected readonly browserView = inject(BROWSER_PANE_VIEW);
  private readonly projects = inject(ProjectsState);
  private readonly keymap = inject(Keymap);
  private readonly browser = inject(BrowserPaneState);
  private readonly document = inject(DOCUMENT);
  protected readonly settings = inject(SettingsState);
  protected readonly changes = inject(ChangesState);
  protected readonly changesView = inject(CHANGES_VIEW);
  protected readonly changesSessionOf = changesSessionOf;
  private readonly destroyRef = inject(DestroyRef);
  private stopActiveDrag: (() => void) | undefined;

  protected readonly activeBrowserSession = computed((): SessionId | null => {
    if (this.settings.open() || this.changes.open()) return null;
    const tab = this.tabs.active();
    if (tab === null || isRemoteDevice(tab.deviceId)) return null;
    return changesSessionOf(tab);
  });

  protected readonly browserPaneReady = computed(() => {
    const id = this.activeBrowserSession();
    return this.browserView !== null && id !== null && this.browser.isOpen(id);
  });

  protected readonly browserWidth = computed(() =>
    this.browser.widthFor(this.activeBrowserSession()),
  );

  constructor() {
    this.destroyRef.onDestroy(() => this.stopActiveDrag?.());
    this.registerShortcuts();
    effect(() => {
      const id = this.activeBrowserSession();
      untracked(() => this.browser.syncContext(id));
    });
    // Asking for a Tab (a Session row, a new Session, a shortcut) leaves the Settings page.
    effect(() => {
      this.tabs.activations();
      untracked(() => {
        this.settings.set(false);
        this.changes.set(false);
      });
    });
    effect(() => {
      const state = this.projects.state();
      if (state.status !== 'loaded') return;
      const listed = new Set(state.projects.map((project) => project.id));
      for (const tab of this.tabs.tabs()) {
        if (!listed.has(tab.projectId)) this.tabs.closeProject(tab.projectId);
      }
    });
  }

  private registerShortcuts(): void {
    const destroyRef = this.destroyRef;

    this.keymap.register({
      binding: { mod: true, key: ',' },
      run: () => this.settings.show(),
      destroyRef,
    });
  }

  protected readonly projectName = computed(() => {
    const projectId = this.tabs.active()?.projectId;
    return this.projects.ordered().find((project) => project.id === projectId)?.name ?? '';
  });

  protected startResize(event: PointerEvent, container: HTMLElement, sessionId: SessionId): void {
    event.preventDefault();
    this.stopActiveDrag?.();
    const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    if (target !== null && typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointer events in unit tests may have no active pointer id.
      }
    }
    const win = this.document.defaultView;
    if (win === null) return;
    const startX = event.clientX;
    const startWidth = this.browserWidth();
    let currentWidth = startWidth;
    const clampForContainer = (raw: number): number => {
      const maxAllowed =
        container.clientWidth > 0
          ? Math.min(BROWSER_MAX_WIDTH, Math.max(BROWSER_MIN_WIDTH, container.clientWidth - 320))
          : BROWSER_MAX_WIDTH;
      return Math.min(maxAllowed, clampBrowserWidth(raw));
    };

    const onMove = (moveEvent: PointerEvent) => {
      currentWidth = clampForContainer(startWidth + (startX - moveEvent.clientX));
      this.browser.setDragWidth(currentWidth);
    };

    const cleanup = () => {
      win.removeEventListener('pointermove', onMove);
      win.removeEventListener('pointerup', onEnd);
      win.removeEventListener('pointercancel', onEnd);
      this.stopActiveDrag = undefined;
    };

    const onEnd = () => {
      cleanup();
      void this.browser.commitWidth(sessionId, currentWidth);
    };

    this.stopActiveDrag = cleanup;
    win.addEventListener('pointermove', onMove);
    win.addEventListener('pointerup', onEnd);
    win.addEventListener('pointercancel', onEnd);
  }

  protected nudgeWidth(container: HTMLElement, sessionId: SessionId, delta: number): void {
    const maxAllowed =
      container.clientWidth > 0
        ? Math.min(BROWSER_MAX_WIDTH, Math.max(BROWSER_MIN_WIDTH, container.clientWidth - 320))
        : BROWSER_MAX_WIDTH;
    const next = Math.min(maxAllowed, clampBrowserWidth(this.browserWidth() + delta));
    void this.browser.commitWidth(sessionId, next);
  }
}
