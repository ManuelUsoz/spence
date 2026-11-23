import { describe, expect, it } from 'vitest';
import { compareReleaseVersions, parseReleaseVersion, selectRelease } from './releases';

describe('release selection', () => {
  it('orders numbered candidates before the final version and numerically', () => {
    const rc2 = parseReleaseVersion('0.1.0-rc.2');
    const rc10 = parseReleaseVersion('0.1.0-rc.10');
    const final = parseReleaseVersion('0.1.0');
    expect(rc2 && rc10 && compareReleaseVersions(rc2, rc10)).toBeLessThan(0);
    expect(rc10 && final && compareReleaseVersions(rc10, final)).toBeLessThan(0);
    expect(parseReleaseVersion('0.1.0-rc.01')).toBeNull();
  });
  it('ignores drafts and incomplete releases and includes prereleases', () => {
    const asset = (name: string) => ({ name, browser_download_url: '' });
    const release = (tag_name: string, draft: boolean, names: string[]) => ({
      tag_name,
      draft,
      assets: names.map(asset),
    });
    const releases = [
      release('v0.1.0-rc.2', false, ['RELEASES', 'spence-full.nupkg']),
      release('v0.1.0', true, ['RELEASES', 'spence-full.nupkg']),
      release('v0.1.0-rc.3', false, ['RELEASES']),
    ];
    expect(selectRelease(releases, '0.1.0-rc.1', 'win32')?.tag_name).toBe('v0.1.0-rc.2');
  });
});
