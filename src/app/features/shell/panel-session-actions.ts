import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  type ElementRef,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmKbdImports } from '@ui/kbd';
import { HlmProgressImports } from '@ui/progress';
import { HlmTooltipImports } from '@ui/tooltip';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { WorkspacePanel } from '../../../shared/tabs/tabs.rpc';
import { ChatBackgrounds } from '../../core/chat-backgrounds';
import { Keymap } from '../../core/keymap';
import { SessionToolbar } from '../../core/session-toolbar';
import { Tabs } from '../../core/tabs';
import { ProjectsState } from './projects-state';
import { SendToSession } from './send-to-session';
import { SessionsState, type SessionTarget } from './sessions-state';

/**
 * Per-Session `⋯` actions menu in `PanelHeader`: context usage bar, toolbar actions,
 * Rename / Archive / Delete, per-Session background picker (when in `different` mode),
 * and the `Mod+Shift+K` shortcut.
 */
@Component({
  selector: 'app-panel-session-actions',
  imports: [
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmKbdImports,
    HlmProgressImports,
    HlmTooltipImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    @if (hasMenu()) {
      <button
        #actionsTrigger
        hlmBtn
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="session-actions-trigger"
        class="text-muted-foreground rounded-full"
        aria-label="Session actions"
        i18n-aria-label
        aria-haspopup="menu"
        [hlmTooltip]="actionsTip"
        [hlmDropdownMenuTrigger]="actionsMenu"
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
    }

    <ng-template #actionsMenu>
      <hlm-dropdown-menu class="w-72 rounded-xl" data-testid="session-actions-menu">
        @if (toolbarEntry(); as entry) {
          @let context = entry.context();
          <div class="flex flex-col gap-1.5 px-2.5 pt-1.5 pb-2" data-testid="session-context">
            <div class="text-muted-foreground flex justify-between text-xs tabular-nums">
              <span i18n>Context</span>
              <span data-testid="session-context-label">{{ context.label }}</span>
            </div>
            @if (context.fraction !== null) {
              <hlm-progress
                aria-hidden="true"
                [value]="contextPercent(context.fraction)"
                [max]="100"
                class="bg-accent h-1 rounded-full"
                data-testid="session-context-progress"
              >
                <hlm-progress-indicator class="bg-muted-foreground rounded-full" />
              </hlm-progress>
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
        @if (canPickBackground()) {
          @if (toolbarEntry()) {
            <hlm-dropdown-menu-separator />
          }
          <button
            type="button"
            hlmDropdownMenuItem
            [hlmDropdownMenuSubTrigger]="backgroundSub"
            side="left"
            data-testid="menu-change-background"
          >
            <span i18n>Change background</span>
            <hlm-dropdown-menu-item-sub-indicator />
          </button>
        }
        @if (keptSessionId() !== null) {
          @if (toolbarEntry() || canPickBackground()) {
            <hlm-dropdown-menu-separator />
          }
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="menu-rename"
            (triggered)="startRename.emit()"
            i18n
          >
            Rename
          </button>
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="menu-send-to-session"
            (triggered)="sendToSession()"
            i18n
          >
            Send to another Session…
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

    <ng-template #backgroundSub>
      <hlm-dropdown-menu-sub class="w-56 rounded-xl" data-testid="menu-background-list">
        @for (wp of chatBackgrounds.gallery(); track wp.id) {
          <button
            type="button"
            hlmDropdownMenuRadio
            [keepOpen]="false"
            [checked]="currentWallpaperId() === wp.id"
            data-testid="menu-background-option"
            [attr.data-wallpaper-id]="wp.id"
            (triggered)="pickWallpaper(wp.id)"
          >
            <img [src]="wp.url" alt="" class="size-4 shrink-0 rounded-sm object-cover" />
            <span class="truncate">{{ wp.name }}</span>
            <hlm-dropdown-menu-radio-indicator />
          </button>
        }
      </hlm-dropdown-menu-sub>
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
export class PanelSessionActions {
  readonly isSessionPanel = input.required<boolean>();
  readonly panel = input<WorkspacePanel | null>(null);
  readonly projectId = input<ProjectId | null>(null);
  readonly projectName = input('');
  readonly keptSessionId = input<SessionId | null>(null);
  readonly liveSessionId = input<SessionId | null>(null);
  readonly focused = input(true);
  readonly title = input.required<string>();

  readonly startRename = output<void>();

  protected readonly keymap = inject(Keymap);
  protected readonly chatBackgrounds = inject(ChatBackgrounds);
  private readonly toolbar = inject(SessionToolbar);
  private readonly tabs = inject(Tabs);
  private readonly projects = inject(ProjectsState);
  private readonly sendTo = inject(SendToSession);
  private readonly sessionsState = inject(SessionsState);
  private readonly destroyRef = inject(DestroyRef);

  private readonly actionsTrigger = viewChild<ElementRef<HTMLButtonElement>>('actionsTrigger');

  protected readonly toolbarEntry = computed(() => this.toolbar.entryFor(this.liveSessionId()));

  protected readonly canPickBackground = computed(
    () =>
      this.isSessionPanel() && this.panel() !== null && this.chatBackgrounds.mode() === 'different',
  );

  protected readonly currentWallpaperId = computed(() => {
    const panel = this.panel();
    return panel === null ? undefined : this.tabs.panelWallpaperId(panel);
  });

  protected readonly hasMenu = computed(
    () =>
      this.isSessionPanel() &&
      (this.keptSessionId() !== null || this.toolbarEntry() !== null || this.canPickBackground()),
  );

  protected readonly archived = computed(() => {
    const id = this.keptSessionId();
    return id !== null && this.sessionsState.isArchived(id);
  });

  constructor() {
    this.keymap.register({
      binding: { mod: true, shift: true, key: 'k' },
      when: () => this.focused() && this.hasMenu() && !this.keymap.modalOpen(),
      run: () => {
        this.actionsTrigger()?.nativeElement.click();
        return true;
      },
      destroyRef: this.destroyRef,
    });
  }

  /** Restores focus to the `⋯` trigger button after inline rename completes via Enter. */
  focusTrigger(): void {
    this.actionsTrigger()?.nativeElement.focus();
  }

  protected contextPercent(fraction: number): number {
    return Math.min(100, Math.max(0, fraction * 100));
  }

  protected pickWallpaper(wallpaperId: string): void {
    const panel = this.panel();
    if (panel !== null) {
      this.tabs.setPanelWallpaper(panel.id, wallpaperId);
    }
  }

  /** Opens "Send to another Session…" from the open Session, on whichever Device it lives. */
  protected sendToSession(): void {
    const id = this.keptSessionId();
    if (id === null) return;
    const projectId = this.projectId();
    const device =
      projectId === null
        ? undefined
        : (this.tabs.projectDevice(projectId) ?? this.projects.deviceOf(projectId));
    this.sendTo.open({
      ...(device === undefined ? {} : { device }),
      sessionId: id,
      title: this.title(),
      projectName: this.projectName(),
    });
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
    const id = this.keptSessionId();
    return id === null ? null : { id, title: this.title() };
  }
}
