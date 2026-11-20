import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  DOCUMENT,
  inject,
  signal,
} from '@angular/core';
import { Keymap } from '../../../core/keymap';
import { SettingsState } from '../settings-state';
import { SettingsAbout } from './settings-about';
import { SettingsAgents } from './settings-agents';
import { SettingsDevices } from './settings-devices';
import { SettingsGeneral } from './settings-general';
import { SettingsKeyboard } from './settings-keyboard';
import { SettingsPermissions } from './settings-permissions';
import { SettingsProjects } from './settings-projects';
import { SettingsSessions } from './settings-sessions';
import { SettingsStore } from './settings-store';

type SectionId =
  'general' | 'projects' | 'sessions' | 'agents' | 'permissions' | 'devices' | 'keyboard' | 'about';

interface Section {
  readonly id: SectionId;
  readonly label: string;
}

const sections = (): ReadonlyArray<Section> => [
  { id: 'general', label: $localize`General` },
  { id: 'projects', label: $localize`Projects` },
  { id: 'sessions', label: $localize`Sessions` },
  { id: 'agents', label: $localize`Agents` },
  { id: 'permissions', label: $localize`Permissions` },
  { id: 'devices', label: $localize`Devices` },
  { id: 'keyboard', label: $localize`Keyboard` },
  { id: 'about', label: $localize`About` },
];

/**
 * Settings as one quiet page in the main area: sections stacked in one scroll, a side list that jumps to each.
 * Opened by `SettingsState.show()`, left with Esc or Back. Every change applies at once.
 */
@Component({
  selector: 'app-settings-page',
  imports: [
    SettingsGeneral,
    SettingsSessions,
    SettingsProjects,
    SettingsAgents,
    SettingsPermissions,
    SettingsDevices,
    SettingsKeyboard,
    SettingsAbout,
  ],
  providers: [SettingsStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', 'data-testid': 'settings-page' },
  template: `
    <div class="mx-auto flex max-w-4xl flex-wrap gap-x-10">
      <nav
        class="sticky top-0 flex w-44 shrink-0 flex-col gap-0.5 self-start pt-[1.875rem] text-sm"
        aria-label="Settings sections"
        i18n-aria-label
      >
        @for (section of list; track section.id) {
          <button
            type="button"
            class="hover:bg-muted flex h-8 items-center rounded-lg px-2.5 text-left outline-none focus-visible:ring-2"
            [class]="
              active() === section.id ? 'bg-muted font-medium' : 'text-muted-foreground font-normal'
            "
            [attr.data-testid]="'settings-nav-' + section.id"
            [attr.aria-current]="active() === section.id ? 'location' : null"
            (click)="jump(section.id)"
          >
            {{ section.label }}
          </button>
        }
      </nav>

      <div class="min-w-0 max-w-2xl flex-1 basis-[28rem]">
        @switch (store.view().status) {
          @case ('loading') {
            <p class="text-muted-foreground mt-9" i18n>Loading…</p>
          }
          @case ('failed') {
            <p class="text-destructive mt-9" data-testid="settings-failed" i18n>
              Could not load Settings.
            </p>
          }
        }

        <app-settings-general
          class="block scroll-mt-6"
          data-section="general"
          data-testid="settings-general"
        />
        <app-settings-projects class="block scroll-mt-6" data-section="projects" />
        <app-settings-sessions
          class="block scroll-mt-6"
          data-section="sessions"
          data-testid="settings-sessions"
        />
        <app-settings-agents
          class="block scroll-mt-6"
          data-section="agents"
          data-testid="settings-agents"
        />
        <app-settings-permissions
          class="block scroll-mt-6"
          data-section="permissions"
          data-testid="settings-permissions"
        />
        <app-settings-devices class="block scroll-mt-6" data-section="devices" />
        <app-settings-keyboard
          class="block scroll-mt-6"
          data-section="keyboard"
          data-testid="settings-keyboard"
        />
        <app-settings-about
          class="block scroll-mt-6 pb-12"
          data-section="about"
          data-testid="settings-about-section"
        />
      </div>
    </div>
  `,
})
export class SettingsPage {
  protected readonly state = inject(SettingsState);
  protected readonly store = inject(SettingsStore);
  private readonly document = inject(DOCUMENT);
  private readonly keymap = inject(Keymap);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly list = sections();
  protected readonly active = signal<SectionId>('general');

  constructor() {
    this.keymap.registerEscape({
      layer: 'dialog',
      when: () =>
        this.document.querySelector(
          'app-settings-projects [role="combobox"][aria-expanded="true"]',
        ) === null,
      run: () => this.state.set(false),
      destroyRef: this.destroyRef,
    });
    afterNextRender(() => this.followScroll());
  }

  protected jump(id: SectionId): void {
    this.active.set(id);
    this.section(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private section(id: SectionId): HTMLElement | null {
    return this.document.querySelector<HTMLElement>(`[data-section="${id}"]`);
  }

  /** The side list follows the section nearest the top of the scroll. */
  private followScroll(): void {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        const id = visible?.target.getAttribute('data-section');
        const match = this.list.find((section) => section.id === id);
        if (match !== undefined) this.active.set(match.id);
      },
      { rootMargin: '-10% 0px -75% 0px' },
    );
    for (const section of this.list) {
      const element = this.section(section.id);
      if (element !== null) observer.observe(element);
    }
    this.destroyRef.onDestroy(() => observer.disconnect());
  }
}
