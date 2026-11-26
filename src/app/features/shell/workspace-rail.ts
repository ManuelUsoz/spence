import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { HlmKbdImports } from '@ui/kbd';
import { HlmTooltipImports } from '@ui/tooltip';
import type { DeviceProject } from './projects-state';
import { Keymap } from '../../core/keymap';
import { RemoteDevices } from '../../core/remote-devices';
import { Tabs } from '../../core/tabs';
import { ProjectsState } from './projects-state';
import { SettingsState } from './settings-state';

export interface RailNavItem {
  readonly id: string;
  readonly label: string;
  readonly active: boolean;
  readonly select: () => void;
}

/**
 * Permanent 50px far-left workspace icon rail beside the collapsible Sessions sidebar.
 * Hosts the quiet brand mark, extensible top-level navigation (Sessions today), and Settings
 * pinned to the bottom.
 */
@Component({
  selector: 'app-workspace-rail',
  imports: [HlmKbdImports, HlmTooltipImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'relative z-20 flex h-svh w-(--workspace-rail-width) shrink-0',
  },
  template: `
    <nav
      aria-label="Workspace"
      i18n-aria-label
      data-testid="workspace-rail"
      class="bg-sidebar text-sidebar-foreground border-sidebar-border flex h-full w-full flex-col items-center gap-1.5 border-r py-2.5"
    >
      <button
        type="button"
        data-testid="rail-brand"
        [attr.aria-label]="projectMarkLabel()"
        [hlmTooltip]="projectMarkLabel()"
        position="right"
        class="focus-visible:ring-ring mb-1 flex size-[30px] shrink-0 items-center justify-center rounded-[7px] bg-transparent transition-opacity outline-none select-none focus-visible:ring-2"
        [class]="
          activeProject() !== null || settings.open()
            ? 'cursor-pointer hover:opacity-90'
            : 'cursor-default'
        "
        (click)="openSessions()"
      >
        <img src="icon.png" alt="" aria-hidden="true" class="size-[30px] object-contain" />
      </button>

      @for (item of navItems(); track item.id) {
        <button
          type="button"
          [attr.data-testid]="'rail-nav-' + item.id"
          [attr.aria-label]="item.label"
          [attr.aria-current]="item.active ? 'page' : null"
          [attr.data-active]="item.active ? 'true' : null"
          [hlmTooltip]="item.label"
          position="right"
          class="focus-visible:ring-ring flex size-[34px] shrink-0 items-center justify-center rounded-lg transition-colors outline-none focus-visible:ring-2"
          [class]="item.active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'"
          (click)="item.select()"
        >
          @switch (item.id) {
            @case ('sessions') {
              <svg
                class="size-4 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            }
          }
        </button>
      }

      <div class="flex-1"></div>

      <button
        type="button"
        data-testid="open-settings"
        aria-label="Settings"
        i18n-aria-label
        [attr.aria-current]="settings.open() ? 'page' : null"
        [attr.data-active]="settings.open() ? 'true' : null"
        [hlmTooltip]="settingsTip"
        position="right"
        class="focus-visible:ring-ring flex size-[34px] shrink-0 items-center justify-center rounded-lg transition-colors outline-none focus-visible:ring-2"
        [class]="
          settings.open() ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
        "
        (click)="settings.toggle()"
      >
        <svg
          class="size-4 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path
            d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
          />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </nav>

    <ng-template #settingsTip>
      <span class="inline-flex items-center gap-1.5">
        <span i18n>Settings</span>
        <kbd hlmKbd class="font-mono font-normal">{{ keymap.format({ mod: true, key: ',' }) }}</kbd>
      </span>
    </ng-template>
  `,
})
export class WorkspaceRail {
  protected readonly keymap = inject(Keymap);
  protected readonly settings = inject(SettingsState);
  private readonly projects = inject(ProjectsState);
  private readonly tabs = inject(Tabs);
  private readonly devices = inject(RemoteDevices);

  protected readonly activeProject = computed((): DeviceProject | null => {
    const ordered = this.projects.ordered();
    const activeId = this.tabs.activeProjectId();
    const matched = activeId === null ? undefined : ordered.find((p) => p.id === activeId);
    return matched ?? this.projects.lastUsed() ?? ordered[0] ?? null;
  });

  protected readonly projectMarkLabel = computed((): string => {
    const project = this.activeProject();
    if (project === null) return $localize`Spence — No Project yet`;
    const device =
      project.device === undefined ? null : (this.devices.nameOf(project.device) ?? null);
    return device === null
      ? $localize`${project.name}:project: — Sessions`
      : $localize`${project.name}:project: (${device}:device:) — Sessions`;
  });

  protected openSessions(): void {
    this.settings.set(false);
    if (this.tabs.activeTabOverlay() !== null) {
      this.tabs.closeTabOverlay();
    }
  }

  protected readonly navItems = computed<ReadonlyArray<RailNavItem>>(() => [
    {
      id: 'sessions',
      label: $localize`Sessions`,
      active: !this.settings.open(),
      select: () => this.openSessions(),
    },
  ]);
}
