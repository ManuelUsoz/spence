import { afterEach, describe, expect, it, vi } from 'vitest';
import { findUpdate } from './github';

afterEach(() => vi.unstubAllGlobals());

describe('GitHub update discovery', () => {
  it('includes a published prerelease and skips incomplete releases', async () => {
    const assets = (names: string[]) =>
      names.map((name) => ({ name, browser_download_url: `https://example.com/${name}` }));
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json([
            {
              tag_name: 'v0.1.0-rc.3',
              draft: false,
              prerelease: true,
              assets: assets(['RELEASES']),
            },
            {
              tag_name: 'v0.1.0-rc.2',
              draft: false,
              prerelease: true,
              assets: assets(['RELEASES', 'spence-full.nupkg']),
            },
            { tag_name: 'v0.1.0', draft: true, assets: assets(['RELEASES', 'spence-full.nupkg']) },
          ]),
        ),
      ),
    );
    expect((await findUpdate('0.1.0-rc.1', 'win32'))?.tag_name).toBe('v0.1.0-rc.2');
  });
  it('reports a failed GitHub request instead of claiming no update', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 403 }))),
    );
    await expect(findUpdate('0.1.0-rc.1', 'win32')).rejects.toBe(
      'GitHub releases returned HTTP 403',
    );
  });
});
