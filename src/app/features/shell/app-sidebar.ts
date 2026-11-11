import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmSidebarImports } from '@ui/sidebar';
import { ChatsState } from './chats-state';
import { SettingsState } from './settings-state';

/** The sidebar: Chats with a button to start one, and Settings at the foot. */
@Component({
  selector: 'app-sidebar',
  imports: [HlmSidebarImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-sidebar collapsible="offcanvas">
      <div hlmSidebarHeader class="flex-row items-center justify-between">
        <span class="px-2 text-sm font-semibold">Spence</span>
        <button
          type="button"
          data-testid="new-chat"
          class="hover:bg-sidebar-accent inline-flex size-8 items-center justify-center rounded-md"
          aria-label="New chat"
          title="New chat"
          (click)="chats.start()"
        >
          <svg
            class="size-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      <div hlmSidebarContent>
        <div hlmSidebarGroup>
          <div hlmSidebarGroupLabel>Chats</div>
          <div hlmSidebarGroupContent>
            @if (chats.chats().length === 0) {
              <p class="text-muted-foreground px-2 py-1 text-sm" data-testid="no-chats">
                No chats yet.
              </p>
            } @else {
              <ul hlmSidebarMenu data-testid="chat-list">
                @for (chat of chats.chats(); track chat.id) {
                  <li hlmSidebarMenuItem>
                    <button
                      type="button"
                      hlmSidebarMenuButton
                      [isActive]="chat.id === chats.activeId()"
                      (click)="chats.open(chat.id)"
                    >
                      <span>{{ chat.title }}</span>
                    </button>
                    <button
                      type="button"
                      hlmSidebarMenuAction
                      showOnHover
                      [attr.aria-label]="'Delete ' + chat.title"
                      (click)="chats.remove(chat.id)"
                    >
                      <svg
                        class="size-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        aria-hidden="true"
                      >
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </li>
                }
              </ul>
            }
          </div>
        </div>
      </div>

      <div hlmSidebarFooter>
        <ul hlmSidebarMenu>
          <li hlmSidebarMenuItem>
            <button
              type="button"
              hlmSidebarMenuButton
              data-testid="open-settings"
              (click)="settings.show()"
            >
              <svg
                class="size-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12" />
                <circle cx="16" cy="6" r="2" />
                <circle cx="8" cy="12" r="2" />
                <circle cx="18" cy="18" r="2" />
              </svg>
              <span>Settings</span>
            </button>
          </li>
        </ul>
      </div>
    </hlm-sidebar>
  `,
})
export class AppSidebar {
  protected readonly chats = inject(ChatsState);
  protected readonly settings = inject(SettingsState);
}
