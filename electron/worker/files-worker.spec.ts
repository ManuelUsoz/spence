import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyLstatKind,
  listWorkspaceDir,
  readWorkspacePreview,
  validateWorkspaceOpenTarget,
} from './files-worker-core';
import { handleWorkerRequest } from './git-worker-core';

const createdDirs: string[] = [];

const makeTempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
};

const runGit = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

const initGitRepo = async (dir: string): Promise<void> => {
  runGit(dir, 'init');
  runGit(dir, 'config', 'user.email', 'test@example.com');
  runGit(dir, 'config', 'user.name', 'Test User');
  await writeFile(join(dir, 'README.md'), '# Repo\n');
  runGit(dir, 'add', 'README.md');
  runGit(dir, 'commit', '-m', 'init');
};

const findGitExe = (): string | null => 'git';
const envPath = (): string => process.env['PATH'] ?? '';

afterEach(async () => {
  while (createdDirs.length > 0) {
    const next = createdDirs.pop();
    if (next) {
      await rm(next, { recursive: true, force: true });
    }
  }
});

describe('files-worker-core', () => {
  it('paginates a large directory across scan batches without losing entries', async () => {
    const folder = await makeTempDir('spence-files-many-');
    await Promise.all(
      Array.from({ length: 260 }, (_, index) =>
        writeFile(join(folder, `file-${String(index).padStart(3, '0')}.txt`), ''),
      ),
    );
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listWorkspaceDir({
        rootPath: folder,
        expectedRootIdentity: null,
        dirPath: '',
        ...(cursor === undefined ? {} : { cursor }),
        limit: 70,
        showIgnoredFiles: false,
        gitExecutable: null,
        pathEnv: envPath(),
      });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      names.push(...page.result.entries.map((entry) => entry.name));
      cursor = page.result.nextCursor;
    } while (cursor !== undefined);
    expect(names).toEqual(
      Array.from({ length: 260 }, (_, index) => `file-${String(index).padStart(3, '0')}.txt`),
    );
  });

  it('lists directories first then files, hides .git, and supports bounded cursor pagination', async () => {
    const repo = await makeTempDir('spence-files-page-');
    await initGitRepo(repo);
    await mkdir(join(repo, 'src'));
    await mkdir(join(repo, 'docs'));
    await writeFile(join(repo, 'src', 'index.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'alpha.txt'), 'a');
    await writeFile(join(repo, 'zeta.txt'), 'z');

    const first = await listWorkspaceDir({
      rootPath: repo,
      expectedRootIdentity: null,
      dirPath: '',
      limit: 2,
      showIgnoredFiles: false,
      gitExecutable: findGitExe(),
      pathEnv: envPath(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.result.isGitRepo).toBe(true);
    expect(first.result.hasMore).toBe(true);
    expect(first.result.entries.map((entry) => entry.name)).toEqual(['docs', 'src']);
    expect(first.result.entries.map((entry) => entry.kind)).toEqual(['directory', 'directory']);

    const second = await listWorkspaceDir({
      rootPath: repo,
      expectedRootIdentity: null,
      dirPath: '',
      ...(first.result.nextCursor === undefined ? {} : { cursor: first.result.nextCursor }),
      limit: 10,
      showIgnoredFiles: false,
      gitExecutable: findGitExe(),
      pathEnv: envPath(),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.hasMore).toBe(false);
    expect(second.result.entries.map((entry) => entry.name)).toEqual([
      'alpha.txt',
      'README.md',
      'zeta.txt',
    ]);
    expect(second.result.entries.some((entry) => entry.name.toLowerCase() === '.git')).toBe(false);
  });

  it('respects Git ignore visibility toggles while keeping .git metadata hidden', async () => {
    const repo = await makeTempDir('spence-files-ignore-');
    await initGitRepo(repo);
    await writeFile(join(repo, '.gitignore'), 'dist/\n*.log\n!keep.log\n');
    await mkdir(join(repo, 'dist'));
    await writeFile(join(repo, 'dist', 'bundle.js'), 'console.log(1)\n');
    await writeFile(join(repo, 'debug.log'), 'ignored');
    await writeFile(join(repo, 'keep.log'), 'negated');

    const hidden = await listWorkspaceDir({
      rootPath: repo,
      expectedRootIdentity: null,
      dirPath: '',
      limit: 100,
      showIgnoredFiles: false,
      gitExecutable: findGitExe(),
      pathEnv: envPath(),
    });
    expect(hidden.ok).toBe(true);
    if (!hidden.ok) return;
    expect(hidden.result.entries.map((entry) => entry.name)).toEqual([
      '.gitignore',
      'keep.log',
      'README.md',
    ]);

    const visible = await listWorkspaceDir({
      rootPath: repo,
      expectedRootIdentity: null,
      dirPath: '',
      limit: 100,
      showIgnoredFiles: true,
      gitExecutable: findGitExe(),
      pathEnv: envPath(),
    });
    expect(visible.ok).toBe(true);
    if (!visible.ok) return;
    expect(visible.result.entries).toEqual([
      expect.objectContaining({ name: 'dist', kind: 'directory', ignored: true }),
      expect.objectContaining({ name: '.gitignore', kind: 'file', ignored: false }),
      expect.objectContaining({ name: 'debug.log', kind: 'file', ignored: true }),
      expect.objectContaining({ name: 'keep.log', kind: 'file', ignored: false }),
      expect.objectContaining({ name: 'README.md', kind: 'file', ignored: false }),
    ]);
    expect(visible.result.entries.some((entry) => entry.name === '.git')).toBe(false);
  });

  it('works in linked Git worktrees and plain non-Git local folders', async () => {
    const parent = await makeTempDir('spence-files-wt-');
    const repo = join(parent, 'main-repo');
    const linked = join(parent, 'linked-wt');
    await mkdir(repo);
    await initGitRepo(repo);
    runGit(repo, 'worktree', 'add', '-b', 'feat-files', linked);
    await writeFile(join(linked, 'feature.ts'), 'export const x = 42;\n');

    const wtListing = await listWorkspaceDir({
      rootPath: linked,
      expectedRootIdentity: null,
      dirPath: '',
      limit: 50,
      showIgnoredFiles: true,
      gitExecutable: findGitExe(),
      pathEnv: envPath(),
    });
    expect(wtListing.ok).toBe(true);
    if (wtListing.ok) {
      expect(wtListing.result.isGitRepo).toBe(true);
      expect(wtListing.result.entries.some((entry) => entry.name === '.git')).toBe(false);
      expect(wtListing.result.entries.some((entry) => entry.name === 'feature.ts')).toBe(true);
    }

    const blockedWtGit = await readWorkspacePreview({
      rootPath: linked,
      expectedRootIdentity: null,
      relativePath: '.git',
      maxBytes: 1024,
    });
    expect(blockedWtGit).toEqual({
      ok: false,
      reason: 'OutsideRoot',
      detail: expect.any(String),
    });

    const plainFolder = await makeTempDir('spence-files-nongit-');
    await mkdir(join(plainFolder, 'notes'));
    await writeFile(join(plainFolder, 'notes', 'todo.md'), '- ship #101\n');
    const plainListing = await listWorkspaceDir({
      rootPath: plainFolder,
      expectedRootIdentity: null,
      dirPath: '',
      limit: 50,
      showIgnoredFiles: false,
      gitExecutable: findGitExe(),
      pathEnv: envPath(),
    });
    expect(plainListing.ok).toBe(true);
    if (plainListing.ok) {
      expect(plainListing.result.isGitRepo).toBe(false);
      expect(plainListing.result.entries).toEqual([
        expect.objectContaining({ name: 'notes', kind: 'directory', ignored: false }),
      ]);
    }
  });

  it('rejects path traversal, .git metadata, linked-parent escapes, nested repos, and swapped roots', async () => {
    const parent = await makeTempDir('spence-files-sec-');
    const repo = join(parent, 'repo');
    const outside = join(parent, 'outside');
    await mkdir(repo);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'TOP_SECRET');
    await initGitRepo(repo);

    // Linked-parent escape (junction on Windows, dir symlink on POSIX)
    await symlink(
      outside,
      join(repo, 'escape-dir'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    // Nested repo
    const nested = join(repo, 'vendor', 'subrepo');
    await mkdir(nested, { recursive: true });
    await initGitRepo(nested);
    await writeFile(join(nested, 'private.txt'), 'subrepo content');

    const attacks = [
      '../outside/secret.txt',
      'escape-dir/secret.txt',
      '.git/HEAD',
      '.git/config',
      '.GIT/HEAD',
      '.git./HEAD',
      'vendor/subrepo/private.txt',
      'C:\\Windows\\win.ini',
      '/etc/passwd',
      'src\\app.ts',
      'a\0b',
    ];

    for (const attack of attacks) {
      const preview = await readWorkspacePreview({
        rootPath: repo,
        expectedRootIdentity: null,
        relativePath: attack,
        maxBytes: 1024,
      });
      expect(preview, `readPreview attack: ${attack}`).toMatchObject({
        ok: false,
        reason: 'OutsideRoot',
      });

      const openTarget = await validateWorkspaceOpenTarget({
        rootPath: repo,
        expectedRootIdentity: null,
        relativePath: attack,
      });
      expect(openTarget, `validateOpenTarget attack: ${attack}`).toMatchObject({
        ok: false,
        reason: 'OutsideRoot',
      });
    }

    const vendorListing = await listWorkspaceDir({
      rootPath: repo,
      expectedRootIdentity: null,
      dirPath: 'vendor',
      limit: 50,
      showIgnoredFiles: false,
      gitExecutable: findGitExe(),
      pathEnv: envPath(),
    });
    expect(vendorListing.ok).toBe(true);
    if (vendorListing.ok) {
      expect(vendorListing.result.entries).toEqual([
        expect.objectContaining({ name: 'subrepo', path: 'vendor/subrepo', kind: 'nestedRepo' }),
      ]);
    }

    const nestedList = await listWorkspaceDir({
      rootPath: repo,
      expectedRootIdentity: null,
      dirPath: 'vendor/subrepo',
      limit: 50,
      showIgnoredFiles: false,
      gitExecutable: findGitExe(),
      pathEnv: envPath(),
    });
    expect(nestedList).toMatchObject({ ok: false, reason: 'OutsideRoot' });

    const rootList = await listWorkspaceDir({
      rootPath: repo,
      expectedRootIdentity: null,
      dirPath: '',
      limit: 50,
      showIgnoredFiles: false,
      gitExecutable: findGitExe(),
      pathEnv: envPath(),
    });
    expect(rootList.ok).toBe(true);
    if (rootList.ok) {
      expect(rootList.result.entries).toContainEqual(
        expect.objectContaining({ name: 'escape-dir', kind: 'symlink' }),
      );
    }

    const escapeDirList = await listWorkspaceDir({
      rootPath: repo,
      expectedRootIdentity: null,
      dirPath: 'escape-dir',
      limit: 50,
      showIgnoredFiles: false,
      gitExecutable: findGitExe(),
      pathEnv: envPath(),
    });
    expect(escapeDirList).toMatchObject({ ok: false, reason: 'OutsideRoot' });

    const swappedRoot = await listWorkspaceDir({
      rootPath: repo,
      expectedRootIdentity: 'wrong:0:0',
      dirPath: '',
      limit: 50,
      showIgnoredFiles: false,
      gitExecutable: findGitExe(),
      pathEnv: envPath(),
    });
    expect(swappedRoot).toMatchObject({ ok: false, reason: 'OutsideRoot' });
  });

  it('distinguishes bounded UTF-8 text, truncated large text, binary, and unavailable files', async () => {
    const folder = await makeTempDir('spence-files-preview-');
    await writeFile(join(folder, 'hello.ts'), 'export const greeting = "hola café 🚀";\n');

    const small = await readWorkspacePreview({
      rootPath: folder,
      expectedRootIdentity: null,
      relativePath: 'hello.ts',
      maxBytes: 1024,
    });
    expect(small.ok).toBe(true);
    if (small.ok) {
      expect(small.result).toMatchObject({
        _tag: 'Text',
        path: 'hello.ts',
        content: 'export const greeting = "hola café 🚀";\n',
        truncated: false,
      });
    }

    // Multibyte boundary truncation without invalid U+FFFD replacement bytes
    await writeFile(join(folder, 'emoji.txt'), 'ab🚀🚀🚀cd');
    const capped = await readWorkspacePreview({
      rootPath: folder,
      expectedRootIdentity: null,
      relativePath: 'emoji.txt',
      maxBytes: 5,
    });
    expect(capped.ok).toBe(true);
    if (capped.ok && capped.result._tag === 'Text') {
      expect(capped.result.truncated).toBe(true);
      expect(capped.result.content.includes('\uFFFD')).toBe(false);
      expect(capped.result.byteLength).toBeLessThanOrEqual(5);
      expect(capped.result.totalBytes).toBeGreaterThan(5);
    }

    // Real > 2 MiB text file enforces default 2 MiB cap
    const largeChunk = 'line-of-text\n'.repeat(200_000);
    await writeFile(join(folder, 'huge.log'), largeChunk);
    const largePreview = await readWorkspacePreview({
      rootPath: folder,
      expectedRootIdentity: null,
      relativePath: 'huge.log',
      maxBytes: 10 * 1024 * 1024,
    });
    expect(largePreview.ok).toBe(true);
    if (largePreview.ok && largePreview.result._tag === 'Text') {
      expect(largePreview.result.truncated).toBe(true);
      expect(largePreview.result.previewLimitBytes).toBe(2 * 1024 * 1024);
      expect(largePreview.result.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    }

    // Binary content detection
    await writeFile(join(folder, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const binary = await readWorkspacePreview({
      rootPath: folder,
      expectedRootIdentity: null,
      relativePath: 'image.bin',
      maxBytes: 1024,
    });
    expect(binary.ok).toBe(true);
    if (binary.ok) {
      expect(binary.result).toMatchObject({
        _tag: 'Binary',
        path: 'image.bin',
        totalBytes: 6,
      });
    }

    // Missing file inside valid root
    const missing = await readWorkspacePreview({
      rootPath: folder,
      expectedRootIdentity: null,
      relativePath: 'deleted.ts',
      maxBytes: 1024,
    });
    expect(missing).toEqual({
      ok: true,
      result: {
        _tag: 'Unavailable',
        path: 'deleted.ts',
        reason: 'Missing',
        detail: expect.any(String),
      },
    });

    const missingOpen = await validateWorkspaceOpenTarget({
      rootPath: folder,
      expectedRootIdentity: null,
      relativePath: 'deleted.ts',
    });
    expect(missingOpen).toMatchObject({ ok: false, reason: 'NotFound' });

    const validOpen = await validateWorkspaceOpenTarget({
      rootPath: folder,
      expectedRootIdentity: null,
      relativePath: 'hello.ts',
    });
    expect(validOpen.ok).toBe(true);
    if (validOpen.ok) {
      const raw = await readFile(validOpen.result.targetPath, 'utf8');
      expect(raw).toContain('hola café');
    }
  });

  it('classifies special files (FIFO/socket/device) as unsupported without opening them', async () => {
    const folder = await makeTempDir('spence-files-special-');
    const file = join(folder, 'regular.txt');
    await writeFile(file, 'ok');
    const regularStats = await lstat(file);
    expect(classifyLstatKind(regularStats)).toBe('file');

    const fakeFifo = {
      isSymbolicLink: () => false,
      isFIFO: () => true,
      isSocket: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isDirectory: () => false,
      isFile: () => false,
    };
    expect(classifyLstatKind(fakeFifo)).toBe('special');
  });

  it('dispatches files.* requests through handleWorkerRequest', async () => {
    const folder = await makeTempDir('spence-files-worker-dispatch-');
    await writeFile(join(folder, 'app.ts'), 'const ok = true;\n');

    const listRes = await handleWorkerRequest({
      id: 1,
      method: 'files.listDir',
      rootPath: folder,
      expectedRootIdentity: null,
      dirPath: '',
      limit: 10,
      showIgnoredFiles: false,
      gitExecutable: null,
      pathEnv: envPath(),
    });
    expect(listRes).toMatchObject({
      id: 1,
      ok: true,
      result: {
        dirPath: '',
        entries: [expect.objectContaining({ name: 'app.ts', kind: 'file' })],
      },
    });

    const previewRes = await handleWorkerRequest({
      id: 2,
      method: 'files.readPreview',
      rootPath: folder,
      expectedRootIdentity: null,
      relativePath: 'app.ts',
      maxBytes: 1024,
    });
    expect(previewRes).toMatchObject({
      id: 2,
      ok: true,
      result: { _tag: 'Text', content: 'const ok = true;\n' },
    });

    const openRes = await handleWorkerRequest({
      id: 3,
      method: 'files.validateOpenTarget',
      rootPath: folder,
      expectedRootIdentity: null,
      relativePath: '../escape',
    });
    expect(openRes).toMatchObject({
      id: 3,
      ok: false,
      reason: 'OutsideRoot',
    });
  });
});
