import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ openExternal: vi.fn<(url: string) => Promise<void>>() }));

vi.mock('electron', () => ({ shell: electron }));

import { openExternal } from './links';

beforeEach(() => {
  electron.openExternal.mockReset();
  electron.openExternal.mockResolvedValue(undefined);
});

describe('openExternal', () => {
  it('opens an absolute HTTPS link without credentials in the operating system', async () => {
    await Effect.runPromise(openExternal('https://example.com/docs'));
    expect(electron.openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('revalidates in main and rejects a scheme or credentials the renderer should not send', async () => {
    for (const url of [
      'http://example.com',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:secret@example.com/x',
      '/settings',
    ]) {
      await expect(Effect.runPromise(openExternal(url))).rejects.toMatchObject({
        _tag: 'LinkError',
        reason: 'Rejected',
      });
    }
    expect(electron.openExternal).not.toHaveBeenCalled();
  });

  it('reports a failure to ask the operating system to open the link', async () => {
    electron.openExternal.mockRejectedValue(new Error('no browser'));
    await expect(Effect.runPromise(openExternal('https://example.com'))).rejects.toMatchObject({
      _tag: 'LinkError',
      reason: 'OpenFailed',
    });
  });
});
