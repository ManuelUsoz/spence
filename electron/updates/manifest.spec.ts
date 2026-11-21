import { describe, expect, it } from 'vitest';
import { compareVersions } from '../../src/shared/updates/manifest';

describe('update version ordering', () => {
  it('orders numeric prerelease identifiers before nonnumeric identifiers', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.11')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.11', '1.0.0')).toBeLessThan(0);
  });
});
