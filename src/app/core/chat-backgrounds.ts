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
  readonly builtin: boolean;
}

export const BUILTIN_WALLPAPERS: ReadonlyArray<WallpaperItem> = [
  {
    id: 'cobalt-halftone',
    name: 'Cobalt Halftone',
    url: 'wallpapers/cobalt-halftone.jpg',
    builtin: true,
  },
  {
    id: 'amber-halftone',
    name: 'Amber Halftone',
    url: 'wallpapers/amber-halftone.jpg',
    builtin: true,
  },
  {
    id: 'emerald-halftone',
    name: 'Emerald Halftone',
    url: 'wallpapers/emerald-halftone.jpg',
    builtin: true,
  },
  {
    id: 'violet-halftone',
    name: 'Violet Halftone',
    url: 'wallpapers/violet-halftone.jpg',
    builtin: true,
  },
  {
    id: 'rose-halftone',
    name: 'Rose Halftone',
    url: 'wallpapers/rose-halftone.jpg',
    builtin: true,
  },
  {
    id: 'slate-halftone',
    name: 'Slate Halftone',
    url: 'wallpapers/slate-halftone.jpg',
    builtin: true,
  },
  {
    id: 'ochre-halftone',
    name: 'Ochre Halftone',
    url: 'wallpapers/ochre-halftone.jpg',
    builtin: true,
  },
  {
    id: 'teal-halftone',
    name: 'Teal Halftone',
    url: 'wallpapers/teal-halftone.jpg',
    builtin: true,
  },
];

const getSettings = Effect.fnUntraced(function* () {
  const api = yield* DesktopApi;
  return yield* api['Settings.get']();
});

const toWallpaperItem = (custom: CustomWallpaper): WallpaperItem => ({
  id: custom.id,
  name: custom.name,
  url: `data:${custom.mimeType};base64,${custom.data}`,
  builtin: false,
});

/**
 * Reactive Session chat wallpaper settings and curated + custom gallery.
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
  readonly selectedId = this._selectedId.asReadonly();
  readonly customWallpapers = this._customWallpapers.asReadonly();

  readonly gallery = computed((): ReadonlyArray<WallpaperItem> => [
    ...BUILTIN_WALLPAPERS,
    ...this._customWallpapers().map(toWallpaperItem),
  ]);

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
  pickNext(usedIds: ReadonlySet<string>, lastId?: string): string {
    const items = this.gallery();
    const firstUnused = items.find((item) => !usedIds.has(item.id) && item.id !== lastId);
    if (firstUnused !== undefined) return firstUnused.id;
    const anyUnused = items.find((item) => !usedIds.has(item.id));
    if (anyUnused !== undefined) return anyUnused.id;
    if (lastId !== undefined) {
      const idx = items.findIndex((item) => item.id === lastId);
      if (idx !== -1 && items.length > 1) {
        return items[(idx + 1) % items.length]?.id ?? DEFAULT_WALLPAPER_ID;
      }
    }
    return items[0]?.id ?? DEFAULT_WALLPAPER_ID;
  }

  /** Resolves the wallpaper to show for a Session/Panel under the current `mode()`, or `null` in `'solid'` mode. */
  resolve(assignedId?: string): WallpaperItem | null {
    const mode = this._mode();
    if (mode === 'solid') return null;
    const items = this.gallery();
    if (items.length === 0) return null;
    if (mode === 'same') {
      const chosen = items.find((item) => item.id === this._selectedId());
      return chosen ?? items[0] ?? null;
    }
    if (assignedId !== undefined) {
      const matched = items.find((item) => item.id === assignedId);
      if (matched !== undefined) return matched;
    }
    return items[0] ?? null;
  }
}
