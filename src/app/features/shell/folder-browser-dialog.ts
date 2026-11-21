import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmDialogImports } from '@ui/dialog';
import { HlmSelectImports } from '@ui/select';
import { HlmSwitchImports } from '@ui/switch';
import { Cause, Effect, Option } from 'effect';
import type { DeviceId } from '../../../shared/devices/devices.rpc';
import type { FolderListing, FoldersError } from '../../../shared/folders/folders.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { onDevice } from '../../core/device-scope';
import { EffectRuntime } from '../../core/effect-runtime';
import { Keymap } from '../../core/keymap';
import { FolderBrowserState } from './folder-browser-state';

const browse = (device: DeviceId, path: string | null, hidden: boolean) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    return yield* api['Folders.browse']({ path, hidden });
  }).pipe(onDevice(device));

type View =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly reason: FoldersError['reason'] | 'Unreachable' }
  | { readonly status: 'loaded'; readonly listing: FolderListing };

/**
 * The in-app folder browser for a Remote device (`FolderBrowserState.pick`): its folders only, from its home folder,
 * hidden ones behind a switch. Choose takes the folder shown.
 */
@Component({
  selector: 'app-folder-browser-dialog',
  imports: [HlmDialogImports, HlmButtonImports, HlmSelectImports, HlmSwitchImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-dialog
      [state]="state.request() === null ? 'closed' : 'open'"
      (stateChanged)="$event === 'closed' && state.cancel()"
    >
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="sm:max-w-lg"
        data-testid="folder-browser"
        closeLabel="Close"
        i18n-closeLabel
      >
        @if (state.request(); as request) {
          <hlm-dialog-header>
            <h2 hlmDialogTitle data-testid="folder-browser-title">{{ request.title }}</h2>
            <p hlmDialogDescription i18n>Pick a folder. Only folders are shown.</p>
          </hlm-dialog-header>

          <div class="flex flex-wrap items-center gap-2">
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              data-testid="folder-up"
              [disabled]="parent() === null"
              (click)="open(parent())"
              i18n
            >
              Up
            </button>
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              data-testid="folder-home"
              (click)="open(null)"
              i18n
            >
              Home
            </button>
            @if (roots().length > 1) {
              <hlm-select
                data-testid="folder-roots"
                [value]="currentRoot()"
                (valueChange)="onRoot($event)"
              >
                <label for="folder-roots-trigger" class="sr-only" i18n>Drive</label>
                <hlm-select-trigger buttonId="folder-roots-trigger"
                  ><hlm-select-value
                /></hlm-select-trigger>
                <hlm-select-content *hlmSelectPortal>
                  @for (root of roots(); track root) {
                    <hlm-select-item [value]="root" [attr.data-value]="root">{{
                      root
                    }}</hlm-select-item>
                  }
                </hlm-select-content>
              </hlm-select>
            }
            <label class="ml-auto flex items-center gap-2 text-xs" for="folder-hidden">
              <span i18n>Show hidden folders</span>
              <hlm-switch
                inputId="folder-hidden"
                data-testid="folder-hidden"
                [checked]="hidden()"
                (checkedChange)="onHidden($event)"
              />
            </label>
          </div>

          @if (shownPath(); as path) {
            <p class="text-muted-foreground truncate font-mono text-xs" data-testid="folder-path">
              {{ path }}
            </p>
          }

          <div class="border-border h-72 overflow-y-auto rounded-md border p-1">
            @switch (view().status) {
              @case ('loading') {
                <p class="text-muted-foreground p-2 text-sm" i18n>Loading…</p>
              }
              @case ('failed') {
                <p class="text-destructive p-2 text-sm" data-testid="folder-failed">
                  @switch (failure()) {
                    @case ('Missing') {
                      <ng-container i18n>This folder is not there anymore.</ng-container>
                    }
                    @case ('Unreadable') {
                      <ng-container i18n>Spence cannot read this folder.</ng-container>
                    }
                    @default {
                      <ng-container i18n>Could not reach the Device.</ng-container>
                    }
                  }
                </p>
              }
              @case ('loaded') {
                @for (entry of entries(); track entry.name) {
                  <button
                    type="button"
                    class="hover:bg-muted flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sm outline-none focus-visible:ring-2"
                    data-testid="folder-entry"
                    [attr.title]="entry.link ? entry.path : null"
                    (click)="open(entry.path)"
                  >
                    <svg
                      class="text-muted-foreground size-4 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path
                        d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
                      />
                    </svg>
                    <span class="truncate" data-testid="folder-entry-name">{{ entry.name }}</span>
                    @if (entry.link) {
                      <span
                        class="text-muted-foreground text-xs"
                        data-testid="folder-entry-link"
                        i18n
                        >link</span
                      >
                    }
                  </button>
                } @empty {
                  <p class="text-muted-foreground p-2 text-sm" data-testid="folder-empty" i18n>
                    No folders here.
                  </p>
                }
              }
            }
          </div>

          <hlm-dialog-footer>
            <button
              hlmBtn
              type="button"
              variant="ghost"
              data-testid="folder-cancel"
              (click)="state.cancel()"
              i18n
            >
              Cancel
            </button>
            <button
              hlmBtn
              type="button"
              data-testid="folder-choose"
              [disabled]="listed() === null"
              (click)="choose()"
              i18n
            >
              Choose this folder
            </button>
          </hlm-dialog-footer>
        }
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class FolderBrowserDialog {
  protected readonly state = inject(FolderBrowserState);
  private readonly runtime = inject(EffectRuntime);
  private readonly keymap = inject(Keymap);

  protected readonly view = signal<View>({ status: 'loading' });
  protected readonly hidden = signal(false);
  /** The folder asked for last; `null` is the home folder. */
  private readonly asked = signal<string | null>(null);
  private loads = 0;

  protected readonly listed = computed(() => {
    const view = this.view();
    return view.status === 'loaded' ? view.listing : null;
  });
  protected readonly entries = computed(() => this.listed()?.entries ?? []);
  protected readonly parent = computed(() => this.listed()?.parent ?? null);
  protected readonly roots = computed(() => this.listed()?.roots ?? []);
  protected readonly shownPath = computed(() => this.listed()?.path ?? this.asked());
  protected readonly currentRoot = computed(() => {
    const path = this.listed()?.path ?? '';
    return this.roots().find((root) => path.toLowerCase().startsWith(root.toLowerCase())) ?? '';
  });
  protected readonly failure = computed(() => {
    const view = this.view();
    return view.status === 'failed' ? view.reason : null;
  });

  constructor() {
    effect((onCleanup) => {
      if (this.state.request() === null) return;
      const release = this.keymap.pushModal({ onEscape: () => this.state.cancel() });
      onCleanup(release);
    });
    effect(() => {
      const request = this.state.request();
      if (request === null) return;
      untracked(() => {
        this.hidden.set(false);
        void this.open(request.start);
      });
    });
  }

  protected async open(path: string | null): Promise<void> {
    const request = this.state.request();
    if (request === null) return;
    const load = ++this.loads;
    this.asked.set(path);
    this.view.set({ status: 'loading' });
    const exit = await this.runtime.run(browse(request.device, path, this.hidden()));
    if (load !== this.loads) return;
    if (exit._tag === 'Success') {
      this.view.set({ status: 'loaded', listing: exit.value });
      return;
    }
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    this.view.set({
      status: 'failed',
      reason: error?._tag === 'FoldersError' ? error.reason : 'Unreachable',
    });
  }

  protected onHidden(hidden: boolean): void {
    this.hidden.set(hidden);
    void this.open(this.listed()?.path ?? this.asked());
  }

  protected onRoot(value: unknown): void {
    if (typeof value === 'string' && value !== '') void this.open(value);
  }

  protected choose(): void {
    const listing = this.listed();
    if (listing !== null) this.state.choose(listing.path);
  }
}
