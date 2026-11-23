import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Release } from './releases';

let temp = '';
vi.mock('electron', () => ({ app: { getPath: () => temp } }));
import { downloadDeb } from './linux';

const bytes = new TextEncoder().encode('test package');
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const release = (hash: string): Release => ({
  tag_name: 'v0.1.0-rc.1',
  draft: false,
  assets: [
    {
      name: 'spence_0.1.0~rc1_amd64.deb',
      digest: hash,
      browser_download_url:
        'https://github.com/ManuelUsoz/spence/releases/download/v0.1.0-rc.1/spence_0.1.0~rc1_amd64.deb',
    },
  ],
});
beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'spence-linux-test-'));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(bytes))),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(temp, { recursive: true, force: true });
});
describe('Ubuntu update download', () => {
  it('accepts a package whose digest matches', async () => {
    const result = await downloadDeb(release(digest));
    expect(await readFile(result)).toEqual(Buffer.from(bytes));
  });
  it('rejects a package with a mismatched digest', async () => {
    await expect(downloadDeb(release(`sha256:${'0'.repeat(64)}`))).rejects.toBe(
      'Update package checksum does not match',
    );
  });
});
