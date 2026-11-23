import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { Effect, Exit } from 'effect';
import {
  DEFAULT_WALLPAPER_ID,
  type ChatBackgroundMode,
  type CustomWallpaper,
  type Settings,
} from '../../shared/settings/settings.rpc';
import { DesktopApi } from './desktop-api';
import { EffectRuntime } from './effect-runtime';

export interface WallpaperItem {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

const getSettings = Effect.fnUntraced(function* () {
  const api = yield* DesktopApi;
  return yield* api['Settings.get']();
});

const toWallpaperItem = (custom: CustomWallpaper): WallpaperItem => ({
  id: custom.id,
  name: custom.name,
  url: `data:${custom.mimeType};base64,${custom.data}`,
});

/**
 * Reactive Session chat wallpaper settings and gallery.
 * Reads `Settings.get` once at startup and stays live as `SettingsStore` commits updates.
 */
@Injectable({ providedIn: 'root' })
export class ChatBackgrounds {
  private readonly runtime = inject(EffectRuntime);
  private readonly aborts = new AbortController();

  private readonly _mode = signal<ChatBackgroundMode>('solid');
  private readonly _selectedId = signal<string>(DEFAULT_WALLPAPER_ID);
  private readonly _customWallpapers = signal<ReadonlyArray<CustomWallpaper>>([]);

  readonly mode = this._mode.asReadonly();
  readonly gallery = computed(() => this._customWallpapers().map(toWallpaperItem));
  private readonly selectedWallpaper = computed(() => {
    const items = this.gallery();
    return items.find((item) => item.id === this._selectedId()) ?? items[0];
  });
  readonly selectedId = computed(() => this.selectedWallpaper()?.id);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.aborts.abort());
    void this.runtime.run(getSettings(), { signal: this.aborts.signal }).then((exit) => {
      if (Exit.isSuccess(exit)) this.applySettings(exit.value);
    });
  }

  /** Syncs the active background mode, shared image id, and custom gallery from loaded or updated `Settings`. */
  applySettings(
    settings: Pick<Settings, 'chatBackgroundMode' | 'chatBackgroundId' | 'customWallpapers'>,
  ): void {
    if (settings.chatBackgroundMode !== undefined) {
      this._mode.set(settings.chatBackgroundMode);
    }
    if (settings.chatBackgroundId !== undefined) {
      this._selectedId.set(settings.chatBackgroundId);
    }
    if (settings.customWallpapers !== undefined) {
      this._customWallpapers.set(settings.customWallpapers);
    }
  }

  /** Picks the next non-repeating wallpaper ID from `gallery()`, preferring entries not in `usedIds`. */
  pickNext(usedIds: ReadonlySet<string>, lastId?: string): string | undefined {
    const items = this.gallery();
    const firstUnused = items.find((item) => !usedIds.has(item.id) && item.id !== lastId);
    if (firstUnused !== undefined) return firstUnused.id;
    const anyUnused = items.find((item) => !usedIds.has(item.id));
    if (anyUnused !== undefined) return anyUnused.id;
    if (lastId !== undefined) {
      const idx = items.findIndex((item) => item.id === lastId);
      if (idx !== -1 && items.length > 1) {
        return items[(idx + 1) % items.length]?.id;
      }
    }
    return items[0]?.id;
  }

  /** Resolves the wallpaper to show for a Session/Panel under the current `mode()`, or `null` in `'solid'` mode. */
  resolve(assignedId?: string): WallpaperItem | null {
    const mode = this._mode();
    if (mode === 'solid') return null;
    if (mode === 'same') return this.selectedWallpaper() ?? null;
    const items = this.gallery();
    return items.find((item) => item.id === assignedId) ?? items[0] ?? null;
  }
}
