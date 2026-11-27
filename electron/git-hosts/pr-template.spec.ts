import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { detectPrTemplate } from './pr-template';

const execFileAsync = promisify(execFile);

const git = (cwd: string, ...args: string[]) =>
  execFileAsync('git', args, { cwd, windowsHide: true }).then((r) => r.stdout.trimEnd());

const initRepo = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'spence-pr-tpl-'));
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@spence.local');
  await git(dir, 'config', 'user.name', 'Spence Test');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  await git(dir, 'add', 'README.md');
  await git(dir, 'commit', '-m', 'init');
  return dir;
};

describe('detectPrTemplate', () => {
  it('returns null when no template exists', async () => {
    const dir = await initRepo();
    try {
      expect(await detectPrTemplate(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads .github/PULL_REQUEST_TEMPLATE.md case-insensitively and prefers .github over root and docs', async () => {
    const dir = await initRepo();
    try {
      await mkdir(path.join(dir, 'docs'), { recursive: true });
      await writeFile(path.join(dir, 'docs', 'pull_request_template.md'), 'docs template\n');
      await git(dir, 'add', '.');
      await git(dir, 'commit', '-m', 'add docs template');
      expect(await detectPrTemplate(dir)).toBe('docs template');

      await writeFile(path.join(dir, 'PULL_REQUEST_TEMPLATE.md'), 'root template\n');
      await git(dir, 'add', '.');
      await git(dir, 'commit', '-m', 'add root template');
      expect(await detectPrTemplate(dir)).toBe('root template');

      await mkdir(path.join(dir, '.github'), { recursive: true });
      await writeFile(path.join(dir, '.github', 'PULL_REQUEST_TEMPLATE.md'), 'github template\n');
      await git(dir, 'add', '.');
      await git(dir, 'commit', '-m', 'add github template');
      expect(await detectPrTemplate(dir)).toBe('github template');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('caps templates at 8 KB and appends [truncated]', async () => {
    const dir = await initRepo();
    try {
      await mkdir(path.join(dir, '.github'), { recursive: true });
      await writeFile(path.join(dir, '.github', 'pull_request_template.md'), 'a'.repeat(12_000));
      await git(dir, 'add', '.');
      await git(dir, 'commit', '-m', 'add large template');

      const tpl = await detectPrTemplate(dir);
      expect(tpl).not.toBeNull();
      expect(tpl?.endsWith('[truncated]')).toBe(true);
      expect((tpl ?? '').length).toBeLessThan(8_500);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
