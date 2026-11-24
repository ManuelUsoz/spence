import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmSelectImports } from '@ui/select';
import { HlmSwitchImports } from '@ui/switch';
import { toast } from '@ui/toast';
import { HlmToggleGroupImports } from '@ui/toggle-group';
import { Schema } from 'effect';
import {
  ChatBackgroundMode,
  DEFAULT_WALLPAPER_ID,
  FontPreset,
  Language,
  ProjectOrder,
  SendMode,
  Theme,
  type CustomWallpaper,
  type Settings,
} from '../../../../shared/settings/settings.rpc';
import { ChatBackgrounds } from '../../../core/chat-backgrounds';
import { fontPresetOf } from '../../../core/font-presets';
import { FontPresetDialog } from './font-preset-dialog';
import { SettingsRow } from './settings-row';
import { SettingsStore } from './settings-store';

const isLanguage = Schema.is(Language);
const isSendMode = Schema.is(SendMode);
const isTheme = Schema.is(Theme);
const isFontPreset = Schema.is(FontPreset);
const isChatBackgroundMode = Schema.is(ChatBackgroundMode);
const isOrderBy = Schema.is(ProjectOrder.fields.by);
const isOrderDirection = Schema.is(ProjectOrder.fields.direction);

const WALLPAPER_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const MAX_WALLPAPER_BYTES = 10 * 1024 * 1024;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
};

const createWallpaperId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `custom-${crypto.randomUUID()}`
    : `custom-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** General: how Spence looks and lists things. */
@Component({
  selector: 'app-settings-general',
  imports: [
    FontPresetDialog,
    SettingsRow,
    HlmButtonImports,
    HlmSelectImports,
    HlmSwitchImports,
    HlmToggleGroupImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.loaded(); as current) {
      @let bgMode = modeOf(current.settings);
      @let bgId = backgrounds.selectedId();
      <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>General</h2>

      <app-settings-row label="Theme" i18n-label labelId="settings-theme-label">
        <div
          hlmToggleGroup
          variant="outline"
          size="sm"
          aria-labelledby="settings-theme-label"
          [nullable]="false"
          [value]="current.settings.theme"
          (valueChange)="onTheme($event)"
        >
          <button hlmToggleGroupItem value="system" data-testid="theme-system" i18n>
            System default
          </button>
          <button hlmToggleGroupItem value="light" data-testid="theme-light" i18n>Light</button>
          <button hlmToggleGroupItem value="dark" data-testid="theme-dark" i18n>Dark</button>
        </div>
      </app-settings-row>

      <app-settings-row
        label="Fonts"
        i18n-label
        hint="Pairs the Titles, Interface and Code fonts. Preview before applying."
        i18n-hint
        labelId="settings-fonts-label"
      >
        <span class="text-muted-foreground text-sm" data-testid="settings-font-preset">{{
          fontLabel(current.settings)
        }}</span>
        <button
          hlmBtn
          type="button"
          variant="outline"
          size="sm"
          aria-labelledby="settings-fonts-label"
          data-testid="settings-font-change"
          (click)="fontsOpen.set(true)"
          i18n
        >
          Change…
        </button>
      </app-settings-row>
      <app-font-preset-dialog
        [open]="fontsOpen()"
        [current]="current.settings.fontPreset ?? 'goeist'"
        (applied)="onFontPreset($event)"
        (closed)="fontsOpen.set(false)"
      />
      <app-settings-row
        label="Chat background"
        i18n-label
        labelId="settings-chat-bg-label"
        [hint]="backgroundHint(bgMode)"
      >
        <div
          hlmToggleGroup
          variant="outline"
          size="sm"
          aria-labelledby="settings-chat-bg-label"
          data-testid="chat-bg-mode"
          [nullable]="false"
          [value]="bgMode"
          (valueChange)="onBackgroundMode($event)"
        >
          <button hlmToggleGroupItem value="different" data-testid="chat-bg-different" i18n>
            Different per Session
          </button>
          <button hlmToggleGroupItem value="same" data-testid="chat-bg-same" i18n>
            Same image
          </button>
          <button hlmToggleGroupItem value="solid" data-testid="chat-bg-solid" i18n>
            Solid color
          </button>
        </div>
      </app-settings-row>

      @if (bgMode !== 'solid') {
        <div class="pb-3.5" data-testid="chat-bg-gallery">
          <div class="grid grid-cols-4 gap-2 sm:grid-cols-6">
            @for (item of backgrounds.gallery(); track item.id) {
              @let selected = bgMode === 'same' && bgId === item.id;
              <div class="group relative">
                <button
                  type="button"
                  data-testid="chat-bg-item"
                  [attr.data-wallpaper-id]="item.id"
                  [attr.aria-pressed]="bgMode === 'same' ? selected : null"
                  [attr.aria-label]="item.name"
                  class="focus-visible:ring-ring relative block aspect-[4/3] w-full overflow-hidden rounded-lg border outline-none transition-all focus-visible:ring-2"
                  [class]="
                    selected
                      ? 'border-ring ring-ring ring-2'
                      : bgMode === 'same'
                        ? 'border-border/70 hover:border-foreground/40 cursor-pointer'
                        : 'border-border/70 cursor-default'
                  "
                  (click)="onPickWallpaper(bgMode, item.id)"
                >
                  <img [src]="item.url" alt="" class="h-full w-full object-cover" />
                  <span
                    class="bg-background/75 text-foreground pointer-events-none absolute inset-x-0 bottom-0 truncate px-1.5 py-0.5 text-[10px] font-medium backdrop-blur-xs"
                  >
                    {{ item.name }}
                  </span>
                </button>
                <button
                  hlmBtn
                  type="button"
                  variant="secondary"
                  size="icon-xs"
                  data-testid="chat-bg-remove"
                  [attr.data-wallpaper-id]="item.id"
                  aria-label="Remove wallpaper"
                  i18n-aria-label
                  class="absolute top-1 right-1 opacity-0 shadow-xs transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  (click)="onRemoveWallpaper(current.settings, item.id)"
                >
                  ×
                </button>
              </div>
            }
            <button
              type="button"
              data-testid="chat-bg-upload"
              class="border-border/70 text-muted-foreground hover:border-foreground/40 hover:text-foreground hover:bg-muted/40 focus-visible:ring-ring flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-xs transition-colors outline-none focus-visible:ring-2"
              (click)="bgFileInput.click()"
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
              <span i18n>Add image</span>
            </button>
            <input
              #bgFileInput
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              class="sr-only"
              data-testid="chat-bg-file-input"
              (change)="onUploadWallpaper(current.settings, $event)"
            />
          </div>
        </div>
      }

      <app-settings-row
        label="Language"
        i18n-label
        hint="Spence’s own labels. Agent replies are never translated."
        i18n-hint
        controlId="settings-language"
      >
        <hlm-select
          data-testid="settings-language"
          [value]="current.settings.language"
          (valueChange)="onLanguage($event)"
        >
          <hlm-select-trigger buttonId="settings-language">
            @switch (current.settings.language) {
              @case ('system') {
                <span i18n>System default</span>
              }
              @case ('en') {
                <span>English</span>
              }
              @case ('es') {
                <span>Español</span>
              }
            }
          </hlm-select-trigger>
          <hlm-select-content *hlmSelectPortal>
            <hlm-select-item value="system" data-value="system" i18n
              >System default</hlm-select-item
            >
            <hlm-select-item value="en" data-value="en">English</hlm-select-item>
            <hlm-select-item value="es" data-value="es">Español</hlm-select-item>
          </hlm-select-content>
        </hlm-select>
      </app-settings-row>

      <app-settings-row label="Project order" i18n-label controlId="settings-project-order-by">
        <hlm-select
          data-testid="settings-project-order-by"
          [value]="current.settings.projectOrder.by"
          (valueChange)="onOrderBy(current.settings, $event)"
        >
          <hlm-select-trigger buttonId="settings-project-order-by">
            @switch (current.settings.projectOrder.by) {
              @case ('lastUsed') {
                <span i18n>Last used</span>
              }
              @case ('name') {
                <span i18n>Name</span>
              }
            }
          </hlm-select-trigger>
          <hlm-select-content *hlmSelectPortal>
            <hlm-select-item value="lastUsed" data-value="lastUsed" i18n>Last used</hlm-select-item>
            <hlm-select-item value="name" data-value="name" i18n>Name</hlm-select-item>
          </hlm-select-content>
        </hlm-select>
        @if (current.settings.projectOrder.by === 'name') {
          <hlm-select
            data-testid="settings-project-order-direction"
            [value]="current.settings.projectOrder.direction"
            (valueChange)="onOrderDirection(current.settings, $event)"
          >
            <label for="settings-project-order-direction" class="sr-only" i18n>Direction</label>
            <hlm-select-trigger buttonId="settings-project-order-direction">
              @switch (current.settings.projectOrder.direction) {
                @case ('asc') {
                  <span i18n>Ascending</span>
                }
                @case ('desc') {
                  <span i18n>Descending</span>
                }
              }
            </hlm-select-trigger>
            <hlm-select-content *hlmSelectPortal>
              <hlm-select-item value="asc" data-value="asc" i18n>Ascending</hlm-select-item>
              <hlm-select-item value="desc" data-value="desc" i18n>Descending</hlm-select-item>
            </hlm-select-content>
          </hlm-select>
        }
      </app-settings-row>

      <app-settings-row
        label="Notify me about background Sessions"
        i18n-label
        controlId="settings-notifications"
      >
        <hlm-switch
          inputId="settings-notifications"
          data-testid="settings-notifications"
          [checked]="current.settings.notifications"
          (checkedChange)="store.change({ notifications: $event })"
        />
      </app-settings-row>

      <app-settings-row
        label="While an Agent works, send with"
        i18n-label
        hint="The Composer’s send mode. Queue waits for the Turn to end; Steer sends into the running Turn. You can switch it per Session."
        i18n-hint
        controlId="settings-send-mode"
      >
        <hlm-select
          data-testid="settings-send-mode"
          [value]="current.settings.sendMode"
          (valueChange)="onSendMode($event)"
        >
          <hlm-select-trigger buttonId="settings-send-mode">
            @switch (current.settings.sendMode) {
              @case ('queue') {
                <span i18n>Queue</span>
              }
              @case ('steer') {
                <span i18n>Steer</span>
              }
            }
          </hlm-select-trigger>
          <hlm-select-content *hlmSelectPortal>
            <hlm-select-item value="queue" data-value="queue" i18n>Queue</hlm-select-item>
            <hlm-select-item value="steer" data-value="steer" i18n>Steer</hlm-select-item>
          </hlm-select-content>
        </hlm-select>
      </app-settings-row>
    }
  `,
})
export class SettingsGeneral {
  protected readonly store = inject(SettingsStore);
  protected readonly backgrounds = inject(ChatBackgrounds);
  protected readonly fontsOpen = signal(false);

  protected modeOf(settings: Settings): ChatBackgroundMode {
    return settings.chatBackgroundMode ?? 'solid';
  }

  protected backgroundHint(mode: ChatBackgroundMode): string {
    switch (mode) {
      case 'different':
        return $localize`Each new Session gets a different image from the gallery. You can swap one in Session actions.`;
      case 'same':
        return $localize`All Sessions share the selected image below.`;
      case 'solid':
        return $localize`Sessions use the solid theme background.`;
    }
  }

  protected onLanguage(value: unknown): void {
    if (isLanguage(value)) void this.store.change({ language: value });
  }

  protected onSendMode(value: unknown): void {
    if (isSendMode(value)) void this.store.change({ sendMode: value });
  }

  protected fontLabel(settings: Settings): string {
    return fontPresetOf(settings.fontPreset).label;
  }

  protected onFontPreset(value: unknown): void {
    if (isFontPreset(value)) void this.store.change({ fontPreset: value });
  }

  protected onTheme(value: unknown): void {
    if (isTheme(value)) void this.store.change({ theme: value });
  }

  protected onBackgroundMode(value: unknown): void {
    if (isChatBackgroundMode(value)) void this.store.change({ chatBackgroundMode: value });
  }

  protected onPickWallpaper(mode: ChatBackgroundMode, id: string): void {
    if (mode !== 'same') return;
    void this.store.change({ chatBackgroundId: id });
  }

  protected onRemoveWallpaper(settings: Settings, id: string): void {
    const nextCustom = (settings.customWallpapers ?? []).filter((entry) => entry.id !== id);
    const resetSelected = settings.chatBackgroundId === id;
    void this.store.change({
      customWallpapers: nextCustom,
      ...(resetSelected ? { chatBackgroundId: nextCustom[0]?.id ?? DEFAULT_WALLPAPER_ID } : {}),
    });
  }

  protected async onUploadWallpaper(settings: Settings, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file === undefined) return;
    if (!WALLPAPER_TYPES.has(file.type)) {
      toast.error($localize`Only PNG, JPEG, GIF, or WebP images are supported.`);
      return;
    }
    if (file.size > MAX_WALLPAPER_BYTES) {
      toast.error($localize`Image is too large (max 10 MB).`);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = file.name.replace(/\.[^.]+$/, '') || $localize`Custom`;
    const added: CustomWallpaper = {
      id: createWallpaperId(),
      name,
      mimeType: file.type,
      data: toBase64(bytes),
    };
    const nextCustom = [...(settings.customWallpapers ?? []), added];
    await this.store.change({
      customWallpapers: nextCustom,
      ...(settings.chatBackgroundMode === 'same' ? { chatBackgroundId: added.id } : {}),
    });
  }

  protected onOrderBy(settings: Settings, value: unknown): void {
    if (isOrderBy(value)) {
      void this.store.change({ projectOrder: { ...settings.projectOrder, by: value } });
    }
  }

  protected onOrderDirection(settings: Settings, value: unknown): void {
    if (isOrderDirection(value)) {
      void this.store.change({ projectOrder: { ...settings.projectOrder, direction: value } });
    }
  }
}
