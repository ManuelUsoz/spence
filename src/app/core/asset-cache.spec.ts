import { describe, expect, it } from 'vitest';
import { AssetCache, ASSET_CACHE_BYTES } from './asset-cache';

describe('AssetCache', () => {
  it('keeps about 64 MiB of Remote assets in memory', () => {
    expect(ASSET_CACHE_BYTES).toBe(64 * 1024 * 1024);
  });

  it('returns what it holds and nothing for what it does not', () => {
    const cache = new AssetCache(100);
    cache.put('a', 'AAAA', 3);
    expect(cache.get('a')).toBe('AAAA');
    expect(cache.get('b')).toBeUndefined();
  });

  it('forgets the least recently used assets once over its budget', () => {
    const cache = new AssetCache(10);
    cache.put('a', 'a', 4);
    cache.put('b', 'b', 4);
    // Reading `a` makes `b` the least recently used.
    cache.get('a');
    cache.put('c', 'c', 4);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('a');
    expect(cache.get('c')).toBe('c');
  });

  it('never holds an asset bigger than its whole budget', () => {
    const cache = new AssetCache(10);
    cache.put('a', 'a', 4);
    cache.put('huge', 'h', 11);
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.get('a')).toBe('a');
  });
});
