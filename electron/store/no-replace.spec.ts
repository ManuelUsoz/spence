import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishNoReplace } from './no-replace';

describe('publishNoReplace', () => {
  it('preserves existing target and source bytes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spence-link-'));
    try {
      const source = path.join(dir, 'source');
      const target = path.join(dir, 'target');
      await writeFile(source, 'new');
      await writeFile(target, 'original');
      expect(await publishNoReplace(source, target)).toBe('Exists');
      expect(await readFile(target, 'utf8')).toBe('original');
      expect(await readFile(source, 'utf8')).toBe('new');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('publishes exactly once under concurrent attempts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spence-link-'));
    try {
      const source = path.join(dir, 'source');
      const target = path.join(dir, 'target');
      await writeFile(source, 'bytes');
      const results = await Promise.all([
        publishNoReplace(source, target),
        publishNoReplace(source, target),
      ]);
      expect(results.sort()).toEqual(['Exists', 'Published']);
      expect(await readFile(target, 'utf8')).toBe('bytes');
      expect(await readFile(source, 'utf8')).toBe('bytes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
