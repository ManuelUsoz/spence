import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl } from './link-policy';

describe('isAllowedExternalUrl', () => {
  it('accepts absolute HTTPS links without credentials', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(true);
    expect(isAllowedExternalUrl('https://example.com/a?b=c#d')).toBe(true);
    expect(isAllowedExternalUrl('https://sub.example.com:8443/path')).toBe(true);
  });

  it('rejects every other scheme or a relative destination', () => {
    for (const url of [
      'http://example.com',
      'mailto:a@example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hello',
      '//example.com/path',
      '/settings',
      './file.md',
      '#section',
      '',
    ]) {
      expect(isAllowedExternalUrl(url)).toBe(false);
    }
  });

  it('rejects credentials, control characters and surrounding whitespace', () => {
    expect(isAllowedExternalUrl('https://user:secret@example.com/x')).toBe(false);
    expect(isAllowedExternalUrl('https://user@example.com/x')).toBe(false);
    expect(isAllowedExternalUrl(' https://example.com')).toBe(false);
    expect(isAllowedExternalUrl('https://example.com\n')).toBe(false);
    expect(isAllowedExternalUrl(`https://example.com/${'a'.repeat(9_000)}`)).toBe(false);
  });
});
