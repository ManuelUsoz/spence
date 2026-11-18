import { afterEach, describe, expect, it } from '@effect/vitest';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { listFolder, readTextFile } from './files-core';

const execFile = promisify(execFileCb);
const tempDirs: string[] = [];
const pathEnv = process.env['PATH'] ?? '';

const makeFolder = async (): Promise<string> => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'spence-files-')));
  tempDirs.push(dir);
  return dir;
};

const makeRepo = async (): Promise<string> => {
  const dir = await makeFolder();
  await execFile('git', ['init', '-b', 'main'], { cwd: dir });
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('listFolder', () => {
  it('lists folders before files, each group by name, and never shows .git', async () => {
    const dir = await makeRepo();
    await mkdir(path.join(dir, 'src'));
    await mkdir(path.join(dir, 'docs'));
    await writeFile(path.join(dir, 'b.txt'), 'b');
    await writeFile(path.join(dir, 'a.txt'), 'a');

    const result = await listFolder(dir, '', 'git', pathEnv);

    expect(result._tag).toBe('Listing');
    if (result._tag !== 'Listing') return;
    expect(result.entries.map((e) => [e.name, e.kind])).toEqual([
      ['docs', 'Dir'],
      ['src', 'Dir'],
      ['a.txt', 'File'],
      ['b.txt', 'File'],
    ]);
  });

  it('lists a subfolder by its relative path', async () => {
    const dir = await makeFolder();
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'src', 'main.ts'), 'x');

    const result = await listFolder(dir, 'src', 'git', pathEnv);

    expect(result).toMatchObject({ _tag: 'Listing', entries: [{ name: 'main.ts', kind: 'File' }] });
  });

  it('marks what .gitignore ignores, folders included', async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, '.gitignore'), 'dist/\n*.log\n');
    await mkdir(path.join(dir, 'dist'));
    await writeFile(path.join(dir, 'debug.log'), 'x');
    await writeFile(path.join(dir, 'keep.ts'), 'x');

    const result = await listFolder(dir, '', 'git', pathEnv);

    if (result._tag !== 'Listing') throw new Error('expected a listing');
    const ignored = result.entries.filter((e) => e.ignored).map((e) => e.name);
    expect(ignored.sort()).toEqual(['debug.log', 'dist']);
  });

  it('lists a folder that is not a repository, with nothing ignored', async () => {
    const dir = await makeFolder();
    await writeFile(path.join(dir, 'a.txt'), 'a');

    const result = await listFolder(dir, '', 'git', pathEnv);

    expect(result).toMatchObject({ _tag: 'Listing', entries: [{ name: 'a.txt', ignored: false }] });
  });

  it('refuses paths that leave the folder or reach .git', async () => {
    const dir = await makeFolder();

    for (const bad of [
      '..',
      '../x',
      'a/../..',
      '/etc',
      'C:/Windows',
      '.git',
      '.git/hooks',
      './.git',
      '.GIT/config',
      'src/../.git',
    ]) {
      expect(await listFolder(dir, bad, 'git', pathEnv)).toMatchObject({ _tag: 'Invalid' });
    }
  });

  it('says so when the folder does not exist', async () => {
    const dir = await makeFolder();

    expect(await listFolder(dir, 'nope', 'git', pathEnv)).toMatchObject({ _tag: 'Missing' });
  });
});

describe('readTextFile', () => {
  it('returns the text of a file', async () => {
    const dir = await makeFolder();
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'src', 'a.ts'), 'const a = 1;\n');

    expect(await readTextFile(dir, 'src/a.ts')).toEqual({
      _tag: 'Text',
      content: 'const a = 1;\n',
      size: 13,
    });
  });

  it('does not show a binary file as text', async () => {
    const dir = await makeFolder();
    await writeFile(path.join(dir, 'x.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));

    expect(await readTextFile(dir, 'x.bin')).toMatchObject({
      _tag: 'NoPreview',
      reason: 'Binary',
    });
  });

  it('does not load a file over the preview limit', async () => {
    const dir = await makeFolder();
    await writeFile(path.join(dir, 'big.txt'), 'a'.repeat(1024 * 1024 + 1));

    expect(await readTextFile(dir, 'big.txt')).toMatchObject({
      _tag: 'NoPreview',
      reason: 'TooLarge',
    });
  });

  it('tells a folder from a file, and a missing path from both', async () => {
    const dir = await makeFolder();
    await mkdir(path.join(dir, 'src'));

    expect(await readTextFile(dir, 'src')).toMatchObject({ reason: 'NotFile' });
    expect(await readTextFile(dir, 'gone.txt')).toMatchObject({ reason: 'Missing' });
  });

  it('refuses paths that leave the folder or reach .git', async () => {
    const dir = await makeFolder();

    for (const bad of ['../secret', '/etc/passwd', '.git/config', './.git/config', '.GIT/config']) {
      expect(await readTextFile(dir, bad)).toMatchObject({ _tag: 'Invalid' });
    }
  });
});
