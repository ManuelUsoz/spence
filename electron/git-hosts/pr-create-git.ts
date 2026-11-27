import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectPrTemplate } from './pr-template';

const execFileAsync = promisify(execFile);

const DIFF_MAX_BYTES = 24 * 1024;
const DIFF_TRUNCATION_MARKER = '\n\n[diff truncated at 24 KB]';

const runGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  maxBuffer = 1024 * 1024,
): Promise<string | null> =>
  execFileAsync('git', [...args], { cwd, maxBuffer, timeout: 10_000, windowsHide: true })
    .then((r) => r.stdout.trimEnd())
    .catch(() => null);

const refExists = async (cwd: string, ref: string): Promise<boolean> =>
  (await runGit(cwd, ['rev-parse', '--verify', '--quiet', ref])) !== null;

const resolveCompareRef = async (
  cwd: string,
  targetRemoteName: string,
  baseRef: string,
): Promise<string | null> => {
  const remoteRef = `refs/remotes/${targetRemoteName}/${baseRef}`;
  if (await refExists(cwd, remoteRef)) return remoteRef;
  const localRef = `refs/heads/${baseRef}`;
  if (await refExists(cwd, localRef)) return localRef;
  if (await refExists(cwd, baseRef)) return baseRef;
  return null;
};

export interface InspectedCreateContext {
  readonly headRef: string | null;
  readonly headSha: string | null;
  readonly defaultBaseRef: string;
  readonly baseRef: string;
  readonly availableBaseRefs: ReadonlyArray<string>;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly needsPush: boolean;
  readonly isDirty: boolean;
  readonly templateBody: string | null;
}

export const inspectCreateContext = async (input: {
  readonly worktreePath: string;
  readonly targetRemoteName: string;
  readonly headRemoteName: string;
  readonly baseRefOverride?: string;
  readonly createdFromBranch: string | null;
}): Promise<InspectedCreateContext> => {
  const { worktreePath, targetRemoteName, headRemoteName } = input;
  const [headSha, headRef, statusOut, localOut, remoteOut, remoteHeadOut, templateBody] =
    await Promise.all([
      runGit(worktreePath, ['rev-parse', '--verify', 'HEAD']),
      runGit(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      runGit(worktreePath, ['status', '--porcelain']),
      runGit(worktreePath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      runGit(worktreePath, [
        'for-each-ref',
        '--format=%(refname:short)',
        `refs/remotes/${targetRemoteName}`,
      ]),
      runGit(worktreePath, [
        'symbolic-ref',
        '--quiet',
        '--short',
        `refs/remotes/${targetRemoteName}/HEAD`,
      ]),
      detectPrTemplate(worktreePath),
    ]);

  const branchSet = new Set<string>();
  for (const line of (localOut ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) branchSet.add(trimmed);
  }
  const remotePrefix = `${targetRemoteName}/`;
  for (const line of (remoteOut ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed === `${remotePrefix}HEAD`) continue;
    branchSet.add(trimmed.startsWith(remotePrefix) ? trimmed.slice(remotePrefix.length) : trimmed);
  }
  const availableBaseRefs = [...branchSet].filter((b) => b !== headRef);
  if (availableBaseRefs.length === 0) availableBaseRefs.push('main');

  let defaultBaseRef: string | null = null;
  if (
    input.createdFromBranch !== null &&
    input.createdFromBranch !== headRef &&
    (await resolveCompareRef(worktreePath, targetRemoteName, input.createdFromBranch)) !== null
  ) {
    defaultBaseRef = input.createdFromBranch;
  }
  if (defaultBaseRef === null && remoteHeadOut !== null) {
    const stripped = remoteHeadOut.startsWith(remotePrefix)
      ? remoteHeadOut.slice(remotePrefix.length)
      : remoteHeadOut;
    if (stripped.length > 0 && stripped !== 'HEAD') {
      defaultBaseRef = stripped;
    }
  }
  if (defaultBaseRef === null) {
    defaultBaseRef = availableBaseRefs.includes('main')
      ? 'main'
      : availableBaseRefs.includes('master')
        ? 'master'
        : (availableBaseRefs[0] ?? 'main');
  }

  const baseRef =
    input.baseRefOverride !== undefined && input.baseRefOverride.trim().length > 0
      ? input.baseRefOverride.trim()
      : defaultBaseRef;

  const compareRef = await resolveCompareRef(worktreePath, targetRemoteName, baseRef);
  let aheadCount = 0;
  let behindCount = 0;
  if (compareRef !== null && headSha !== null) {
    const counts = await runGit(worktreePath, [
      'rev-list',
      '--left-right',
      '--count',
      `${compareRef}...HEAD`,
    ]);
    if (counts !== null) {
      const [behindStr, aheadStr] = counts.split(/\s+/);
      behindCount = Number.parseInt(behindStr ?? '0', 10) || 0;
      aheadCount = Number.parseInt(aheadStr ?? '0', 10) || 0;
    }
  }

  let needsPush = false;
  if (headRef !== null && headSha !== null) {
    const remoteSha = await runGit(worktreePath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/${headRemoteName}/${headRef}`,
    ]);
    needsPush = remoteSha === null || remoteSha !== headSha;
  }

  return {
    headRef,
    headSha,
    defaultBaseRef,
    baseRef,
    availableBaseRefs,
    aheadCount,
    behindCount,
    needsPush,
    isDirty: (statusOut ?? '').trim().length > 0,
    templateBody,
  };
};

export interface DraftCreateInput {
  readonly commitLog: string;
  readonly diffStat: string;
  readonly unifiedDiff: string;
  readonly templateBody: string | null;
}

export const gatherDraftCreateInput = async (input: {
  readonly worktreePath: string;
  readonly baseRef: string;
  readonly targetRemoteName: string;
  readonly templateBody: string | null;
}): Promise<DraftCreateInput> => {
  const compareRef =
    (await resolveCompareRef(input.worktreePath, input.targetRemoteName, input.baseRef)) ??
    input.baseRef;
  const range = `${compareRef}..HEAD`;
  const [commitLog, diffStat, rawDiff] = await Promise.all([
    runGit(input.worktreePath, ['log', '--oneline', '--no-decorate', '-n', '30', range]),
    runGit(input.worktreePath, ['diff', '--stat', range]),
    runGit(input.worktreePath, ['diff', range], 4 * 1024 * 1024),
  ]);

  const diffStr = rawDiff ?? '';
  const diffBytes = Buffer.from(diffStr, 'utf8');
  const unifiedDiff =
    diffBytes.byteLength > DIFF_MAX_BYTES
      ? `${diffBytes.subarray(0, DIFF_MAX_BYTES).toString('utf8')}${DIFF_TRUNCATION_MARKER}`
      : diffStr;

  return {
    commitLog: commitLog ?? '',
    diffStat: diffStat ?? '',
    unifiedDiff,
    templateBody: input.templateBody,
  };
};

export const buildDraftCreatePrompt = (input: {
  readonly headRef: string;
  readonly baseRef: string;
  readonly context: DraftCreateInput;
}): string => {
  const sections = [
    `Draft a concise, accurate Pull request title and description for merging \`${input.headRef}\` into \`${input.baseRef}\`.`,
    'Respond ONLY with a valid JSON object matching `{"title": string, "body": string}` and no other commentary.',
    'Do not call any tools or access files; everything you need is provided below.',
    `## Commits\n${input.context.commitLog || '(none)'}`,
    `## Diffstat\n${input.context.diffStat || '(none)'}`,
  ];
  if (input.context.templateBody !== null) {
    sections.push(`## Pull request template\n${input.context.templateBody}`);
  }
  sections.push(`## Unified diff\n\`\`\`diff\n${input.context.unifiedDiff || '(empty)'}\n\`\`\``);
  return sections.join('\n\n');
};

export const parseDraftAgentReply = (
  replyText: string,
  fallbackTitle: string,
): { readonly title: string; readonly body: string } => {
  const trimmed = replyText.trim();
  const unwrapped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const parsed: unknown = JSON.parse(unwrapped);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'title' in parsed &&
      'body' in parsed &&
      typeof parsed.title === 'string' &&
      typeof parsed.body === 'string'
    ) {
      return {
        title: parsed.title.trim() || fallbackTitle,
        body: parsed.body.trim(),
      };
    }
  } catch {
    // Fallback to plain-text parsing below.
  }

  const lines = trimmed.split(/\r?\n/);
  const firstNonEmptyIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstNonEmptyIdx < 0) {
    return { title: fallbackTitle, body: '' };
  }
  const rawTitle = (lines[firstNonEmptyIdx] ?? '')
    .trim()
    .replace(/^(?:title:\s*|#+\s*)/i, '')
    .trim();
  const body = lines
    .slice(firstNonEmptyIdx + 1)
    .join('\n')
    .trim();
  return {
    title: rawTitle || fallbackTitle,
    body,
  };
};
