import { describe, expect, it } from 'vitest';
import { normalize } from './parity-device';

describe('parity observation normalization', () => {
  it('normalizes a handle ending in a hyphen both as a field and inside tool text', () => {
    const handle = 'project-abcdefghijklmno-';
    expect(normalize({ handle, text: `{"project":"${handle}"}` }, [])).toEqual({
      handle: '<id:1>',
      text: '{"project":"<id:1>"}',
    });
  });
});
