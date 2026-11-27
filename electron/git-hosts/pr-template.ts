import { execFile } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TEMPLATE_MAX_BYTES = 8_000;
const TRUNCATION_MARKER = '[truncated]';

const CANDIDATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/pull_request_template.txt',
  'pull_request_template.md',
  'pull_request_template.txt',
  'docs/pull_request_template.md',
  'docs/pull_request_template.txt',
] as const;

const runGitBuffer = (cwd: string, args: ReadonlyArray<string>): Promise<Buffer | null> =>
  execFileAsync('git', [...args], {
    cwd,
    encoding: 'buffer',
    maxBuffer: 1024 * 1024,
    timeout: 5_000,
    windowsHide: true,
  })
    .then((r) => r.stdout)
    .catch(() => null);

interface TreeBlob {
  readonly objectId: string;
  readonly path: string;
}

const parseLsTree = (buf: Buffer): ReadonlyArray<TreeBlob> => {
  const entries: TreeBlob[] = [];
  for (const record of buf.toString('utf8').split('\0')) {
    if (record.length === 0) continue;
    const sep = record.indexOf('\t');
    if (sep < 0) continue;
    const [mode, type, objectId] = record.slice(0, sep).split(' ');
    if (
      type !== 'blob' ||
      (mode !== '100644' && mode !== '100755') ||
      !objectId ||
      !/^[0-9a-f]{40,64}$/.test(objectId)
    ) {
      continue;
    }
    entries.push({ objectId, path: record.slice(sep + 1) });
  }
  return entries;
};

const formatTemplate = (raw: Buffer): string | null => {
  const truncated = raw.byteLength > TEMPLATE_MAX_BYTES;
  const sliced = truncated ? raw.subarray(0, TEMPLATE_MAX_BYTES) : raw;
  const text = sliced.toString('utf8').trim();
  if (text.length === 0) return null;
  return truncated && !text.endsWith(TRUNCATION_MARKER) ? `${text}\n\n${TRUNCATION_MARKER}` : text;
};

const readFromWorktreeFs = async (cwd: string): Promise<string | null> => {
  const dirs = ['.github', '.', 'docs'] as const;
  const byLower = new Map<string, string>();
  for (const dir of dirs) {
    const absDir = dir === '.' ? cwd : path.join(cwd, dir);
    const names = await readdir(absDir).catch(() => [] as string[]);
    for (const name of names) {
      const rel = dir === '.' ? name : `${dir}/${name}`;
      byLower.set(rel.toLowerCase(), path.join(absDir, name));
    }
  }
  for (const candidate of CANDIDATE_PATHS) {
    const abs = byLower.get(candidate);
    if (abs === undefined) continue;
    const st = await lstat(abs).catch(() => null);
    if (st === null || !st.isFile() || st.isSymbolicLink()) continue;
    const buf = await readFile(abs).catch(() => null);
    if (buf === null) continue;
    const formatted = formatTemplate(buf);
    if (formatted !== null) return formatted;
  }
  return null;
};

/**
 * Loads the repository's Pull request template case-insensitively from `.github/pull_request_template.md`,
 * `pull_request_template.md`, or `docs/pull_request_template.md` (plus `.txt` fallbacks), capped at 8 KB.
 */
export const detectPrTemplate = async (cwd: string): Promise<string | null> => {
  const treeBuf = await runGitBuffer(cwd, [
    'ls-tree',
    '-r',
    '-z',
    'HEAD',
    '--',
    '.github',
    'docs',
    '.',
  ]);
  if (treeBuf !== null) {
    const blobs = parseLsTree(treeBuf);
    const byLower = new Map<string, TreeBlob>();
    for (const blob of blobs) {
      const lower = blob.path.toLowerCase();
      if (!byLower.has(lower)) {
        byLower.set(lower, blob);
      }
    }
    for (const candidate of CANDIDATE_PATHS) {
      const match = byLower.get(candidate);
      if (match === undefined) continue;
      const content = await runGitBuffer(cwd, ['cat-file', 'blob', match.objectId]);
      if (content === null) continue;
      const formatted = formatTemplate(content);
      if (formatted !== null) return formatted;
    }
  }
  return readFromWorktreeFs(cwd);
};
