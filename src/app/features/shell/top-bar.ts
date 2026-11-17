import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  type ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmKbdImports } from '@ui/kbd';
import { HlmSidebarImports } from '@ui/sidebar';
import { HlmTooltipImports } from '@ui/tooltip';
import { Keymap } from '../../core/keymap';
import { SessionToolbar } from '../../core/session-toolbar';
import { Tabs } from '../../core/tabs';
import { SessionsState, type SessionTarget } from './sessions-state';
import { SettingsState } from './settings-state';
import { wireEditorFocus } from './sidebar-keys';

/**
 * The 48px bar above the open Session: the sidebar trigger, the Session's title (renamed in place) and the ⋯
 * Session actions menu: context use, compact, clear, switch Agent or Model, rename, archive and delete.
 * Fork is not here; it belongs to a Turn.
 */
@Component({
  selector: 'app-top-bar',
  imports: [HlmSidebarImports, HlmDropdownMenuImports, HlmKbdImports, HlmTooltipImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block shrink-0' },
  template: `
    <header class="border-border/60 flex h-12 min-w-0 items-center gap-2 border-b px-3">
      <button hlmSidebarTrigger srOnlyText="Toggle sidebar" i18n-srOnlyText></button>
      @if (settings.open()) {
        <button
          type="button"
          class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring h-8 shrink-0 rounded-md px-2 text-sm outline-none focus-visible:ring-2"
          data-testid="settings-back"
          (click)="settings.set(false)"
          i18n
        >
          ← Back
        </button>
        <h1 class="font-display shrink-0 text-xl font-normal" data-testid="topbar-title" i18n>
          Settings
        </h1>
        <span class="text-muted-foreground truncate text-xs" i18n>Changes apply at once.</span>
        <div class="flex-1"></div>
      } @else if (tab(); as active) {
        @if (renaming()) {
          <input
            #titleEditor
            data-testid="topbar-rename"
            class="bg-background border-input focus-visible:ring-ring h-8 min-w-0 flex-1 rounded-lg border px-2.5 text-sm font-medium outline-none focus-visible:ring-2"
            [value]="active.title ?? ''"
            aria-label="Session title"
            i18n-aria-label
            (keydown.enter)="$event.preventDefault(); saveRename(titleEditor.value, true)"
            (blur)="saveRename(titleEditor.value, false)"
          />
        } @else {
          <h1
            class="min-w-0 flex-1 truncate text-sm font-medium"
            [class.text-muted-foreground]="active.title === null"
            data-testid="topbar-title"
          >
            {{ title() }}
          </h1>
        }
        @if (hasMenu()) {
          <button
            #actionsTrigger
            type="button"
            data-testid="session-actions-trigger"
            class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-8 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
            aria-label="Session actions"
            i18n-aria-label
            aria-haspopup="menu"
            [hlmTooltip]="actionsTip"
            [hlmDropdownMenuTrigger]="actionsMenu"
          >
            <svg
              class="size-[18px]"
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
        }
      } @else {
        <div class="flex-1"></div>
      }
    </header>

    <ng-template #actionsMenu>
      <hlm-dropdown-menu class="w-72 rounded-xl" data-testid="session-actions-menu">
        @if (toolbar.entry(); as entry) {
          @let context = entry.context();
          <div class="flex flex-col gap-1.5 px-2.5 pt-1.5 pb-2" data-testid="session-context">
            <div class="text-muted-foreground flex justify-between text-xs tabular-nums">
              <span i18n>Context</span>
              <span data-testid="session-context-label">{{ context.label }}</span>
            </div>
            @if (context.fraction !== null) {
              <div class="bg-accent h-1 overflow-hidden rounded-full" aria-hidden="true">
                <div
                  class="bg-muted-foreground h-full rounded-full"
                  [style.width.%]="context.fraction * 100"
                ></div>
              </div>
            }
          </div>
          @for (action of entry.actions(); track action.id) {
            <button
              type="button"
              hlmDropdownMenuItem
              class="h-auto min-h-8 py-1.5"
              [disabled]="action.disabled"
              [attr.data-testid]="'session-action-' + action.id"
              (triggered)="entry.run(action.operation)"
            >
              <span class="flex min-w-0 flex-1 flex-col text-left">
                <span>{{ action.label }}</span>
                @if (action.disabled && action.reason; as reason) {
                  <span
                    class="text-muted-foreground text-xs leading-4 font-normal"
                    data-testid="session-action-reason"
                    >{{ reason }}</span
                  >
                }
              </span>
              @if (action.command; as command) {
                <span class="text-muted-foreground font-mono text-xs">{{ command }}</span>
              }
            </button>
          }
        }
        @if (sessionId() !== null) {
          @if (toolbar.entry()) {
            <hlm-dropdown-menu-separator />
          }
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="menu-rename"
            (triggered)="startRename()"
            i18n
          >
            Rename
          </button>
          @if (archived()) {
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="menu-unarchive"
              (triggered)="unarchive()"
              i18n
            >
              Unarchive
            </button>
          } @else {
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="menu-archive"
              (triggered)="archive()"
              i18n
            >
              Archive
            </button>
          }
          <button
            type="button"
            hlmDropdownMenuItem
            variant="destructive"
            data-testid="menu-delete"
            (triggered)="remove()"
            i18n
          >
            Delete…
          </button>
        }
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #actionsTip>
      <span class="inline-flex items-center gap-1.5">
        <span i18n>Session actions</span>
        <kbd hlmKbd class="font-mono font-normal">{{
          keymap.format({ mod: true, shift: true, key: 'k' })
        }}</kbd>
      </span>
    </ng-template>
  `,
})
export class TopBar {
  protected readonly keymap = inject(Keymap);
  protected readonly toolbar = inject(SessionToolbar);
  protected readonly settings = inject(SettingsState);
  private readonly tabs = inject(Tabs);
  private readonly sessionsState = inject(SessionsState);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly renaming = signal(false);
  private readonly titleEditor = viewChild<ElementRef<HTMLInputElement>>('titleEditor');
  private readonly actionsTrigger = viewChild<ElementRef<HTMLButtonElement>>('actionsTrigger');

  protected readonly tab = this.tabs.active;
  protected readonly sessionId = computed(() => this.tab()?.session ?? null);
  /** A draft has no kept Session to rename or archive, but its live Session still has context actions. */
  protected readonly hasMenu = computed(
    () => this.sessionId() !== null || this.toolbar.entry() !== null,
  );
  protected readonly title = computed(() => this.tab()?.title ?? $localize`New Session`);
  protected readonly archived = computed(() => {
    const id = this.sessionId();
    return id !== null && this.sessionsState.isArchived(id);
  });

  constructor() {
    wireEditorFocus(this.titleEditor);
    this.keymap.registerEscape({
      layer: 'rename',
      when: () => this.renaming(),
      run: () => this.renaming.set(false),
      destroyRef: this.destroyRef,
    });
    this.keymap.register({
      binding: { mod: true, shift: true, key: 'k' },
      when: () => this.hasMenu() && !this.keymap.modalOpen(),
      run: () => {
        this.actionsTrigger()?.nativeElement.click();
        return true;
      },
      destroyRef: this.destroyRef,
    });
  }

  protected startRename(): void {
    if (this.sessionId() !== null) this.renaming.set(true);
  }

  protected saveRename(title: string, restoreFocus: boolean): void {
    if (!this.renaming()) return;
    this.renaming.set(false);
    const id = this.sessionId();
    const active = this.tab();
    if (id === null || active === null) return;
    if (title.trim() !== (active.title ?? '')) void this.sessionsState.rename(id, title);
    if (restoreFocus) queueMicrotask(() => this.actionsTrigger()?.nativeElement.focus());
  }

  protected archive(): void {
    const target = this.target();
    if (target !== null) void this.sessionsState.archive([target]);
  }

  protected unarchive(): void {
    const target = this.target();
    if (target !== null) void this.sessionsState.unarchive([target]);
  }

  protected remove(): void {
    const target = this.target();
    if (target !== null) void this.sessionsState.delete([target]);
  }

  private target(): SessionTarget | null {
    const id = this.sessionId();
    return id === null ? null : { id, title: this.title() };
  }
}
