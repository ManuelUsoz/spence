import { execFile } from 'node:child_process';
import { access, copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { buildGitEnv, GIT_MAX_BUFFER } from '../source-control/git-exec';

const exec = promisify(execFile);

const missing = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');

export const releaseWorkflowBaseline = (folder: string): Promise<void> =>
  rm(folder, { recursive: true, force: true });

interface WorktreeSnapshot {
  readonly staged: string;
  readonly working: string;
}

export const workflowWorktreeRoot = async (cwd: string): Promise<string> => {
  const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    env: buildGitEnv(process.env['PATH'] ?? process.env['Path'] ?? ''),
    windowsHide: true,
    timeout: 30_000,
  });
  return realpath(stdout.trimEnd());
};

export const openWorkflowWorktree = async (cwd: string, baselineFolder?: string) => {
  const baseEnv = {
    ...buildGitEnv(process.env['PATH'] ?? process.env['Path'] ?? ''),
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
  };
  if (baselineFolder !== undefined) await access(join(baselineFolder, 'pack'));
  const git = async (args: string[], env = baseEnv, input?: string, maxBuffer = 1024 * 1024) => {
    const pending = exec('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd,
      env,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer,
    });
    if (input !== undefined && pending.child.stdin !== null) {
      pending.child.stdin.on('error', () => undefined);
      pending.child.stdin.end(input);
    }
    return (await pending).stdout;
  };
  const indexPath = (
    await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  ).trimEnd();
  const objectPath = (
    await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'])
  ).trimEnd();
  const scratch = await mkdtemp(join(tmpdir(), 'spence-coordinate-'));
  const index = join(scratch, 'index');
  const objects = join(scratch, 'objects');
  const close = () => rm(scratch, { recursive: true, force: true });
  try {
    await mkdir(objects);
    const env = {
      ...baseEnv,
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [
        objectPath,
        ...(baselineFolder === undefined ? [] : [baselineFolder]),
      ]
        .map((folder) => JSON.stringify(folder))
        .join(process.platform === 'win32' ? ';' : ':'),
    };
    const capture = async (): Promise<WorktreeSnapshot> => {
      await rm(index, { force: true });
      await copyFile(indexPath, index).catch((error: unknown) => {
        return error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? undefined
          : Promise.reject(error);
      });
      const indexEntries = (
        await git(['ls-files', '-v', '-z'], env, undefined, GIT_MAX_BUFFER)
      ).split('\0');
      const assumed = indexEntries
        .filter((entry) => /^[a-z] /.test(entry))
        .map((entry) => entry.slice(2));
      const skipped = indexEntries
        .filter((entry) => /^[Ss] /.test(entry))
        .map((entry) => entry.slice(2));
      const presentSkipped: string[] = [];
      for (const file of skipped) {
        const info = await lstat(join(cwd, file)).catch((error: unknown) =>
          missing(error) ? undefined : Promise.reject(error),
        );
        if (info !== undefined) presentSkipped.push(file);
      }
      const noHooks = ['-c', `core.hooksPath=${join(scratch, 'no-hooks')}`];
      const updateFlags = (flag: string, files: ReadonlyArray<string>) =>
        files.length === 0
          ? Promise.resolve('')
          : git([...noHooks, 'update-index', flag, '-z', '--stdin'], env, files.join('\0') + '\0');
      await updateFlags('--no-assume-unchanged', assumed);
      await updateFlags('--no-skip-worktree', presentSkipped);
      const staged = (await git([...noHooks, 'write-tree'], env)).trim();
      // Git add normally runs configured filters. Snapshotting must not execute project commands.
      const keys = (await git(['config', '--null', '--name-only', '--list'])).split('\0');
      const filters = new Set(
        keys.flatMap((key) => /^filter\.(.+)\.(clean|process|required)$/i.exec(key)?.[1] ?? []),
      );
      const overrides = [...filters].flatMap((name) => [
        '-c',
        `filter.${name}.clean=`,
        '-c',
        `filter.${name}.process=`,
        '-c',
        `filter.${name}.required=false`,
      ]);
      await git(
        [
          ...noHooks,
          ...overrides,
          'add',
          ...(presentSkipped.length === 0 ? [] : ['--sparse']),
          '--all',
          '--',
          ':/',
        ],
        env,
      );
      const working = (await git([...noHooks, 'write-tree'], env)).trim();
      return { staged, working };
    };
    const diff = async (before: WorktreeSnapshot, after: WorktreeSnapshot) => {
      const compare = (oldTree: string, newTree: string) =>
        git(['diff', '--no-ext-diff', '--no-textconv', oldTree, newTree, '--'], env);
      const working = await compare(before.working, after.working);
      if (before.working === before.staged && after.working === after.staged) return working;
      const staged = await compare(before.staged, after.staged);
      return staged === '' || staged === working
        ? working
        : `Worktree diff:\n${working}\nIndex diff:\n${staged}`;
    };
    const retain = async (baseline: WorktreeSnapshot, folder: string) => {
      const parent = dirname(folder);
      await mkdir(parent, { recursive: true });
      const staging = await mkdtemp(join(parent, '.pending-'));
      try {
        const pack = join(staging, 'pack');
        await mkdir(pack);
        // Retain all objects reachable from the two trees, independently of repository garbage collection.
        await git(
          ['pack-objects', '--revs', join(pack, 'baseline')],
          env,
          `${baseline.staged}\n${baseline.working}\n`,
        );
        await rename(staging, folder);
      } finally {
        await releaseWorkflowBaseline(staging);
      }
    };
    return { capture, diff, retain, close };
  } catch (error) {
    await close();
    return Promise.reject(error);
  }
};
