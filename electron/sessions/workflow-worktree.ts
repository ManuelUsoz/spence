import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildGitEnv } from '../source-control/git-exec';

const exec = promisify(execFile);

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

export const openWorkflowWorktree = async (cwd: string) => {
  const baseEnv = buildGitEnv(process.env['PATH'] ?? '');
  const git = async (args: string[], env = baseEnv) => {
    const { stdout } = await exec('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd,
      env,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
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
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objectPath),
    };
    const capture = async (): Promise<WorktreeSnapshot> => {
      await rm(index, { force: true });
      await copyFile(indexPath, index).catch((error: unknown) => {
        return error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? undefined
          : Promise.reject(error);
      });
      const staged = (await git(['write-tree'], env)).trim();
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
      await git([...overrides, 'add', '--all', '--', ':/'], env);
      const working = (await git(['write-tree'], env)).trim();
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
    return { capture, diff, close };
  } catch (error) {
    await close();
    return Promise.reject(error);
  }
};
