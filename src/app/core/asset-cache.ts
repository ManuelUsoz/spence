import { Injectable } from '@angular/core';

/** How many bytes of Remote assets the window keeps in memory; nothing is ever written to disk. */
export const ASSET_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * The bytes of Remote assets this window fetched, least recently used forgotten first, bounded by `budget` decoded
 * bytes. Only memory: closing the window forgets everything.
 */
export class AssetCache {
  private readonly entries = new Map<string, { readonly data: string; readonly size: number }>();
  private used = 0;

  constructor(private readonly budget: number = ASSET_CACHE_BYTES) {}

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    // Most recently used last.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.data;
  }

  /** Keeps `data` (base64 standing for `size` bytes) unless it alone is over the budget. */
  put(key: string, data: string, size: number): void {
    if (size > this.budget) return;
    const known = this.entries.get(key);
    if (known !== undefined) {
      this.entries.delete(key);
      this.used -= known.size;
    }
    this.entries.set(key, { data, size });
    this.used += size;
    for (const [oldest, entry] of this.entries) {
      if (this.used <= this.budget) break;
      this.entries.delete(oldest);
      this.used -= entry.size;
    }
  }
}

/** The window's one `AssetCache`. */
@Injectable({ providedIn: 'root' })
export class RemoteAssetCache extends AssetCache {
  constructor() {
    super(ASSET_CACHE_BYTES);
  }
}
