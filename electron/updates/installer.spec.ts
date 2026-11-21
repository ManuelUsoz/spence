import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { makeInstaller } from './installer';

describe('update installer', () => {
  it('reports a Windows installer that cannot start', async () => {
    const installer = makeInstaller({
      platform: 'win32',
      appImagePath: () => undefined,
      startDetached: () => Promise.reject(new Error('launch failed')),
    });
    await Effect.runPromise(installer.prepare('update.exe'));
    const result = await Effect.runPromise(Effect.exit(installer.apply));
    expect(result._tag).toBe('Failure');
  });
});
