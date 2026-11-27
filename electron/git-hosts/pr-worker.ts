import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  CheckRunId,
  CommentId,
  GitHostError,
  ReviewThreadId,
  type CheckRollupStatus,
  type CheckRun,
  type HostActor,
  type PrDiffHunk,
  type PrDiffLine,
  type PullRequestDetail,
  type PullRequestDiff,
  type PullRequestDiffFile,
  type ReviewComment,
  type ReviewThread,
} from '../../src/shared/pull-requests/pull-requests.rpc';
import type { Timestamp } from '../../src/shared/projects/projects.rpc';

export interface DiffParseOptions {
  readonly maxFileLines?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxFiles?: number;
}

const DEFAULT_MAX_FILE_LINES = 2000;
const DEFAULT_MAX_FILE_BYTES = 128 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 100;

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const DIFF_GIT_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;

const stripCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

const unquoteGitPath = (raw: string): string => {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return raw;
};

interface MutableHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: PrDiffLine[];
}

const parseSingleFileSection = (
  sectionLines: ReadonlyArray<string>,
  options: {
    readonly maxFileLines: number;
    readonly maxFileBytes: number;
    readonly remainingTotalBytes: number;
  },
): { readonly file: PullRequestDiffFile; readonly bytesUsed: number } => {
  const firstLine = stripCr(sectionLines[0] ?? '');
  const gitMatch = DIFF_GIT_HEADER_RE.exec(firstLine);
  let oldPath = gitMatch ? unquoteGitPath(gitMatch[1] ?? '') : '';
  let newPath = gitMatch ? unquoteGitPath(gitMatch[2] ?? '') : '';
  let previousPath: string | undefined;
  let status: PullRequestDiffFile['status'] = 'modified';
  let isBinary = false;

  const hunks: PrDiffHunk[] = [];
  let currentHunk: MutableHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let additions = 0;
  let deletions = 0;
  let capturedLines = 0;
  let capturedBytes = 0;
  let truncated = false;
  let noPreviewReason: string | undefined;
  let inHeader = true;

  for (let i = 1; i < sectionLines.length; i++) {
    const line = stripCr(sectionLines[i] ?? '');
    if (inHeader) {
      if (line.startsWith('new file mode ')) {
        status = 'added';
        continue;
      }
      if (line.startsWith('deleted file mode ')) {
        status = 'removed';
        continue;
      }
      if (line.startsWith('rename from ')) {
        status = 'renamed';
        previousPath = unquoteGitPath(line.slice('rename from '.length));
        continue;
      }
      if (line.startsWith('rename to ')) {
        status = 'renamed';
        newPath = unquoteGitPath(line.slice('rename to '.length));
        continue;
      }
      if (line.startsWith('--- /dev/null')) {
        status = 'added';
        continue;
      }
      if (line.startsWith('--- a/')) {
        oldPath = unquoteGitPath(line.slice('--- a/'.length));
        continue;
      }
      if (line.startsWith('+++ /dev/null')) {
        status = 'removed';
        continue;
      }
      if (line.startsWith('+++ b/')) {
        newPath = unquoteGitPath(line.slice('+++ b/'.length));
        continue;
      }
      if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') {
        isBinary = true;
        break;
      }
    }

    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch !== null) {
      inHeader = false;
      if (currentHunk !== null) {
        hunks.push(currentHunk);
      }
      oldLine = Number(hunkMatch[1] ?? '0');
      const oldLines = Number(hunkMatch[2] ?? '1');
      newLine = Number(hunkMatch[3] ?? '0');
      const newLines = Number(hunkMatch[4] ?? '1');
      currentHunk = {
        header: line,
        oldStart: oldLine,
        oldLines,
        newStart: newLine,
        newLines,
        lines: [],
      };
      continue;
    }

    if (currentHunk === null) continue;
    if (line === '\\ No newline at end of file' || line === '') continue;

    const prefix = line[0];
    if (prefix !== '+' && prefix !== '-' && prefix !== ' ') continue;

    if (prefix === '+') additions += 1;
    if (prefix === '-') deletions += 1;

    if (truncated) continue;

    const content = line.slice(1);
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (
      capturedLines >= options.maxFileLines ||
      capturedBytes + lineBytes > options.maxFileBytes ||
      capturedBytes + lineBytes > options.remainingTotalBytes
    ) {
      truncated = true;
      noPreviewReason = 'Diff preview truncated after exceeding size cap.';
      continue;
    }

    capturedLines += 1;
    capturedBytes += lineBytes;
    if (prefix === '+') {
      currentHunk.lines.push({ kind: 'added', content, oldLine: null, newLine });
      newLine += 1;
    } else if (prefix === '-') {
      currentHunk.lines.push({ kind: 'removed', content, oldLine, newLine: null });
      oldLine += 1;
    } else {
      currentHunk.lines.push({ kind: 'context', content, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  if (currentHunk !== null) {
    hunks.push(currentHunk);
  }

  const resolvedPath = status === 'removed' ? oldPath || newPath : newPath || oldPath;
  if (isBinary) {
    return {
      file: {
        path: resolvedPath,
        ...(previousPath !== undefined ? { previousPath } : {}),
        status,
        additions: 0,
        deletions: 0,
        hunks: [],
        truncated: false,
        noPreviewReason: 'Binary file',
      },
      bytesUsed: 0,
    };
  }

  return {
    file: {
      path: resolvedPath,
      ...(previousPath !== undefined ? { previousPath } : {}),
      status,
      additions,
      deletions,
      hunks,
      truncated,
      ...(noPreviewReason !== undefined ? { noPreviewReason } : {}),
    },
    bytesUsed: capturedBytes,
  };
};

/** Parses a multi-file unified diff string into bounded `PullRequestDiffFile` records. */
export const parseMultiFileUnifiedDiff = (
  rawDiff: string,
  options?: DiffParseOptions,
): ReadonlyArray<PullRequestDiffFile> => {
  if (rawDiff.trim().length === 0) return [];
  const maxFileLines = options?.maxFileLines ?? DEFAULT_MAX_FILE_LINES;
  const maxFileBytes = options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;

  const allLines = rawDiff.split('\n');
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const line of allLines) {
    if (line.startsWith('diff --git ')) {
      if (current !== null) sections.push(current);
      current = [line];
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) sections.push(current);

  const files: PullRequestDiffFile[] = [];
  let remainingTotalBytes = maxTotalBytes;

  for (const section of sections.slice(0, maxFiles)) {
    const parsed = parseSingleFileSection(section, {
      maxFileLines,
      maxFileBytes,
      remainingTotalBytes,
    });
    remainingTotalBytes = Math.max(0, remainingTotalBytes - parsed.bytesUsed);
    files.push(parsed.file);
  }
  return files;
};

export interface RawStatusCheckNode {
  readonly __typename?: string;
  readonly id?: string | null;
  readonly name?: string | null;
  readonly status?: string | null;
  readonly conclusion?: string | null;
  readonly detailsUrl?: string | null;
  readonly context?: string | null;
  readonly state?: string | null;
  readonly targetUrl?: string | null;
  readonly description?: string | null;
  readonly isRequired?: boolean | null;
}

const mapCheckRunStatus = (status: string | null | undefined): CheckRun['status'] => {
  switch ((status ?? '').toUpperCase()) {
    case 'QUEUED':
    case 'WAITING':
    case 'REQUESTED':
    case 'PENDING':
      return 'queued';
    case 'IN_PROGRESS':
      return 'inProgress';
    default:
      return 'completed';
  }
};

const mapCheckRunConclusion = (conclusion: string | null | undefined): CheckRun['conclusion'] => {
  switch ((conclusion ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
      return 'failure';
    case 'NEUTRAL':
      return 'neutral';
    case 'CANCELLED':
      return 'cancelled';
    case 'SKIPPED':
      return 'skipped';
    case 'TIMED_OUT':
      return 'timedOut';
    case 'ACTION_REQUIRED':
      return 'actionRequired';
    case 'STALE':
      return 'stale';
    case 'STARTUP_FAILURE':
      return 'startupFailure';
    default:
      return null;
  }
};

const isFailingConclusion = (conclusion: CheckRun['conclusion']): boolean =>
  conclusion === 'failure' ||
  conclusion === 'timedOut' ||
  conclusion === 'actionRequired' ||
  conclusion === 'startupFailure' ||
  conclusion === 'cancelled';

/** Normalizes GraphQL `statusCheckRollup.contexts.nodes` into `CheckRun[]` and `CheckRollupStatus`. */
export const normalizeStatusCheckRollup = (
  nodes: ReadonlyArray<RawStatusCheckNode | null | undefined>,
): { readonly checkRollup: CheckRollupStatus; readonly checks: ReadonlyArray<CheckRun> } => {
  const checks: CheckRun[] = [];
  let hasFailing = false;
  let hasPending = false;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;
    if (node.__typename === 'StatusContext' || node.context !== undefined) {
      const state = node.state?.toUpperCase() ?? 'PENDING';
      const isPending = state === 'PENDING' || state === 'EXPECTED';
      const isFail = state === 'FAILURE' || state === 'ERROR';
      if (isFail) hasFailing = true;
      else if (isPending) hasPending = true;
      checks.push({
        id: CheckRunId.make(node.id ?? `status-${i}-${node.context ?? 'ctx'}`),
        name: node.context ?? 'Status check',
        status: isPending ? 'inProgress' : 'completed',
        conclusion: isPending ? null : isFail ? 'failure' : 'success',
        url: node.targetUrl ?? null,
        summary: node.description ?? null,
        isRequired: Boolean(node.isRequired),
      });
      continue;
    }

    const status = mapCheckRunStatus(node.status);
    const conclusion = mapCheckRunConclusion(node.conclusion);
    if (status !== 'completed') {
      hasPending = true;
    } else if (isFailingConclusion(conclusion)) {
      hasFailing = true;
    }
    checks.push({
      id: CheckRunId.make(node.id ?? `check-${i}-${node.name ?? 'run'}`),
      name: node.name ?? 'Check',
      status,
      conclusion,
      url: node.detailsUrl ?? null,
      summary: null,
      isRequired: Boolean(node.isRequired),
    });
  }

  const checkRollup: CheckRollupStatus =
    checks.length === 0 ? 'none' : hasFailing ? 'failing' : hasPending ? 'pending' : 'passing';

  return { checkRollup, checks };
};

export interface RawActorNode {
  readonly login?: string | null;
  readonly name?: string | null;
  readonly avatarUrl?: string | null;
}

export interface RawReviewThreadNode {
  readonly id?: string | null;
  readonly path?: string | null;
  readonly line?: number | null;
  readonly startLine?: number | null;
  readonly diffSide?: string | null;
  readonly isResolved?: boolean | null;
  readonly isOutdated?: boolean | null;
  readonly comments?: {
    readonly nodes?: ReadonlyArray<{
      readonly id?: string | null;
      readonly body?: string | null;
      readonly createdAt?: string | null;
      readonly updatedAt?: string | null;
      readonly url?: string | null;
      readonly author?: RawActorNode | null;
    } | null> | null;
  } | null;
}

const toHostActor = (actor: RawActorNode | null | undefined): HostActor => ({
  login: actor?.login ?? 'ghost',
  displayName: actor?.name ?? null,
  avatarUrl: actor?.avatarUrl ?? null,
});

const toTimestamp = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Normalizes GraphQL `reviewThreads.nodes` into domain `ReviewThread[]`. */
export const normalizeReviewThreads = (
  nodes: ReadonlyArray<RawReviewThreadNode | null | undefined>,
): ReadonlyArray<ReviewThread> => {
  const threads: ReviewThread[] = [];
  for (const node of nodes) {
    if (!node || !node.id || !node.path) continue;
    const comments: ReviewComment[] = [];
    for (const c of node.comments?.nodes ?? []) {
      if (!c || !c.id) continue;
      comments.push({
        id: CommentId.make(c.id),
        author: toHostActor(c.author),
        body: c.body ?? '',
        createdAt: toTimestamp(c.createdAt),
        updatedAt: toTimestamp(c.updatedAt),
        url: c.url ?? '',
      });
    }
    threads.push({
      id: ReviewThreadId.make(node.id),
      path: node.path,
      line: node.line ?? null,
      startLine: node.startLine ?? null,
      side: node.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
      isResolved: Boolean(node.isResolved),
      isOutdated: Boolean(node.isOutdated),
      comments,
    });
  }
  return threads;
};

export type FormatPrSnapshotInput =
  | {
      readonly kind: 'pullRequest';
      readonly detail: PullRequestDetail;
      readonly diff?: PullRequestDiff;
      readonly isWorktreeAtHeadCleanly: boolean;
      readonly cachedFallbackFetchedAt?: Timestamp;
    }
  | {
      readonly kind: 'reviewThread';
      readonly detail: PullRequestDetail;
      readonly diff?: PullRequestDiff;
      readonly threadId: ReviewThreadId;
      readonly cachedFallbackFetchedAt?: Timestamp;
    }
  | {
      readonly kind: 'checkRun';
      readonly detail: PullRequestDetail;
      readonly checkId: CheckRunId;
      readonly cachedFallbackFetchedAt?: Timestamp;
    };

const MAX_BODY_BYTES = 8 * 1024;
const MAX_PATCH_BYTES = 24 * 1024;
const MAX_CHECK_SUMMARY_BYTES = 16 * 1024;
const MAX_FAILING_PENDING_CHECKS = 20;
const MAX_UNRESOLVED_THREADS = 25;
const MAX_GENERAL_COMMENTS = 15;
const MAX_DIFF_FILES = 100;

const capUtf8Bytes = (text: string, maxBytes: number, suffix = '\n[truncated]'): string => {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  let end = Math.max(0, maxBytes - suffixBytes);
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString('utf8')}${suffix}`;
};

const formatHunk = (hunk: PrDiffHunk): string => {
  const lines = [hunk.header];
  for (const line of hunk.lines) {
    const prefix = line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ';
    lines.push(`${prefix}${line.content}`);
  }
  return lines.join('\n');
};

const formatPrHeader = (detail: PullRequestDetail, includeFullMetadata: boolean): string[] => {
  const headLabel = detail.headRepo
    ? `${detail.headRepo.canonicalPath}:${detail.headRef}`
    : detail.headRef;
  const lines = [
    `PR #${detail.ref.number}: ${detail.title}`,
    `State: ${detail.state} | URL: ${detail.url}`,
    `Branches: ${headLabel} -> ${detail.baseRef} | headSha: ${detail.headSha}`,
  ];
  if (includeFullMetadata) {
    const labels = detail.labels.map((l) => l.name).join(', ') || 'none';
    lines.push(
      `Author: @${detail.author.login} | Merge state: ${detail.mergeState} | Review: ${detail.reviewDecision} | Labels: ${labels}`,
    );
  }
  return lines;
};

const isFailingOrPendingCheck = (check: CheckRun): boolean => {
  if (check.status !== 'completed') return true;
  return (
    check.conclusion === 'failure' ||
    check.conclusion === 'timedOut' ||
    check.conclusion === 'cancelled' ||
    check.conclusion === 'actionRequired' ||
    check.conclusion === 'startupFailure'
  );
};

export const formatPrSnapshot = (input: FormatPrSnapshotInput): string => {
  const { detail } = input;
  const sections: string[] = [];

  if (input.cachedFallbackFetchedAt !== undefined) {
    sections.push(
      `[cached snapshot · fetched at ${new Date(input.cachedFallbackFetchedAt).toISOString()}; offline/unreachable]`,
    );
  }

  if (input.kind === 'pullRequest') {
    const header = formatPrHeader(detail, true);
    header.push(`HEAD === headSha cleanly: ${input.isWorktreeAtHeadCleanly ? 'yes' : 'no'}`);
    sections.push(header.join('\n'));

    const bodyText =
      detail.body.trim().length > 0 ? capUtf8Bytes(detail.body, MAX_BODY_BYTES) : '(empty)';
    sections.push(`## Description\n${bodyText}`);

    const failingOrPending = detail.checks.filter(isFailingOrPendingCheck);
    const checkLines = [
      `## Checks (${detail.checkRollup}; ${detail.checks.length} total, ${failingOrPending.length} failing/pending)`,
    ];
    for (const check of failingOrPending.slice(0, MAX_FAILING_PENDING_CHECKS)) {
      const conclusion = check.conclusion ?? 'pending';
      const url = check.url ? ` (${check.url})` : '';
      checkLines.push(`- ${check.name}: ${check.status}/${conclusion}${url}`);
    }
    if (failingOrPending.length > MAX_FAILING_PENDING_CHECKS) {
      checkLines.push(`... (${failingOrPending.length - MAX_FAILING_PENDING_CHECKS} more)`);
    }
    sections.push(checkLines.join('\n'));

    const unresolved = detail.reviewThreads.filter((t) => !t.isResolved);
    const resolvedCount = detail.reviewThreads.length - unresolved.length;
    const threadLines = [
      `## Review threads (${unresolved.length} unresolved; Resolved threads: ${resolvedCount})`,
    ];
    for (const thread of unresolved.slice(0, MAX_UNRESOLVED_THREADS)) {
      const loc =
        thread.startLine !== null && thread.line !== null
          ? `${thread.path}:${thread.startLine}-${thread.line}`
          : thread.line !== null
            ? `${thread.path}:${thread.line}`
            : thread.path;
      threadLines.push(`### ${loc}${thread.isOutdated ? ' [outdated]' : ''}`);
      for (const c of thread.comments) {
        threadLines.push(`- @${c.author.login}: ${c.body}`);
      }
    }
    if (unresolved.length > MAX_UNRESOLVED_THREADS) {
      threadLines.push(
        `... (${unresolved.length - MAX_UNRESOLVED_THREADS} more unresolved threads)`,
      );
    }
    sections.push(threadLines.join('\n'));

    const recentComments = detail.comments.slice(-MAX_GENERAL_COMMENTS);
    if (recentComments.length > 0) {
      const commentLines = [
        `## Recent comments (${recentComments.length} of ${detail.comments.length})`,
      ];
      for (const c of recentComments) {
        commentLines.push(`- @${c.author.login}: ${c.body}`);
      }
      sections.push(commentLines.join('\n'));
    }

    if (input.diff && input.diff.files.length > 0) {
      const files = input.diff.files.slice(0, MAX_DIFF_FILES);
      const fileLines = [`## Changed files (${files.length} of ${input.diff.files.length})`];
      for (const f of files) {
        fileLines.push(`- ${f.path} (${f.status}, +${f.additions} -${f.deletions})`);
      }
      sections.push(fileLines.join('\n'));

      if (!input.isWorktreeAtHeadCleanly) {
        const patchParts: string[] = ['## Diff patches'];
        let usedBytes = 0;
        for (const f of files) {
          if (f.truncated || f.hunks.length === 0) continue;
          const filePatch = `--- ${f.path}\n${f.hunks.map(formatHunk).join('\n')}`;
          const nextBytes = Buffer.byteLength(filePatch, 'utf8');
          if (usedBytes + nextBytes > MAX_PATCH_BYTES) {
            const remaining = MAX_PATCH_BYTES - usedBytes;
            if (remaining > 64) {
              patchParts.push(capUtf8Bytes(filePatch, remaining));
            } else {
              patchParts.push('[patches truncated at 24 KB]');
            }
            break;
          }
          patchParts.push(filePatch);
          usedBytes += nextBytes;
        }
        if (patchParts.length > 1) {
          sections.push(patchParts.join('\n'));
        }
      }
    }

    return sections.join('\n\n');
  }

  if (input.kind === 'reviewThread') {
    sections.push(formatPrHeader(detail, false).join('\n'));
    const thread = detail.reviewThreads.find((t) => t.id === input.threadId);
    if (!thread) {
      sections.push(`Review thread ${input.threadId} not found.`);
      return sections.join('\n\n');
    }
    const loc =
      thread.startLine !== null && thread.line !== null
        ? `${thread.path}:${thread.startLine}-${thread.line}`
        : thread.line !== null
          ? `${thread.path}:${thread.line}`
          : thread.path;
    const status = `${thread.isResolved ? 'resolved' : 'unresolved'}${thread.isOutdated ? ', outdated' : ''}`;
    const threadLines = [`## Review thread: ${loc} (${status})`];
    const diffFile = input.diff?.files.find((f) => f.path === thread.path);
    if (diffFile) {
      const targetLine = thread.line ?? thread.startLine;
      const matchingHunk =
        (targetLine !== null
          ? diffFile.hunks.find(
              (h) =>
                h.lines.some((l) => l.newLine === targetLine || l.oldLine === targetLine) ||
                (targetLine >= h.newStart && targetLine <= h.newStart + h.newLines),
            )
          : undefined) ?? diffFile.hunks[0];
      if (matchingHunk) {
        threadLines.push('```diff', formatHunk(matchingHunk), '```');
      }
    }
    for (const c of thread.comments) {
      threadLines.push(`- @${c.author.login}: ${c.body}`);
    }
    sections.push(threadLines.join('\n'));
    return sections.join('\n\n');
  }

  // kind === 'checkRun'
  sections.push(formatPrHeader(detail, false).join('\n'));
  const check = detail.checks.find((c) => c.id === input.checkId);
  if (!check) {
    sections.push(`Check run ${input.checkId} not found (rollup: ${detail.checkRollup}).`);
    return sections.join('\n\n');
  }
  const checkLines = [
    `## Check run: ${check.name} (rollup: ${detail.checkRollup})`,
    `Status: ${check.status} | Conclusion: ${check.conclusion ?? 'none'}${check.url ? ` | URL: ${check.url}` : ''}`,
  ];
  if (check.summary && check.summary.trim().length > 0) {
    checkLines.push(`### Summary\n${capUtf8Bytes(check.summary, MAX_CHECK_SUMMARY_BYTES)}`);
  }
  sections.push(checkLines.join('\n'));
  return sections.join('\n\n');
};

export type PrWorkerTaskInput =
  | {
      readonly kind: 'parseDiff';
      readonly rawDiff: string;
      readonly options?: DiffParseOptions;
    }
  | {
      readonly kind: 'normalizeChecks';
      readonly nodes: ReadonlyArray<RawStatusCheckNode | null | undefined>;
    }
  | {
      readonly kind: 'normalizeReviewThreads';
      readonly nodes: ReadonlyArray<RawReviewThreadNode | null | undefined>;
    }
  | {
      readonly kind: 'formatPrSnapshot';
      readonly input: FormatPrSnapshotInput;
    };

export type PrWorkerTask = PrWorkerTaskInput & { readonly id: number };

type PrWorkerResponse =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

if (!isMainThread && parentPort !== null) {
  const port = parentPort;
  port.on('message', (task: PrWorkerTask) => {
    try {
      let result: unknown;
      switch (task.kind) {
        case 'parseDiff':
          result = parseMultiFileUnifiedDiff(task.rawDiff, task.options);
          break;
        case 'normalizeChecks':
          result = normalizeStatusCheckRollup(task.nodes);
          break;
        case 'normalizeReviewThreads':
          result = normalizeReviewThreads(task.nodes);
          break;
        case 'formatPrSnapshot':
          result = formatPrSnapshot(task.input);
          break;
      }
      const response: PrWorkerResponse = { id: task.id, ok: true, result };
      port.postMessage(response);
    } catch (error) {
      const response: PrWorkerResponse = {
        id: task.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      port.postMessage(response);
    }
  });
}

let nextTaskId = 1;

/**
 * Runs a PR worker task on `dist-electron/pr-worker.js` when bundled, or falls back to
 * synchronous execution in Vitest/source environments where the bundle is absent.
 */
export const runPrWorkerTask = <A>(task: PrWorkerTaskInput): Promise<A> => {
  const workerPath = path.join(__dirname, 'pr-worker.js');
  if (!existsSync(workerPath)) {
    switch (task.kind) {
      case 'parseDiff':
        return Promise.resolve(parseMultiFileUnifiedDiff(task.rawDiff, task.options) as A);
      case 'normalizeChecks':
        return Promise.resolve(normalizeStatusCheckRollup(task.nodes) as A);
      case 'normalizeReviewThreads':
        return Promise.resolve(normalizeReviewThreads(task.nodes) as A);
      case 'formatPrSnapshot':
        return Promise.resolve(formatPrSnapshot(task.input) as A);
    }
  }

  const id = nextTaskId++;
  return new Promise<A>((resolve, reject) => {
    const worker = new Worker(workerPath);
    worker.once('message', (response: PrWorkerResponse) => {
      void worker.terminate();
      if (response.ok) {
        resolve(response.result as A);
      } else {
        reject(new GitHostError({ reason: 'HostError', detail: response.error }));
      }
    });
    worker.once('error', (err) => {
      void worker.terminate();
      reject(err);
    });
    worker.postMessage({ ...task, id });
  });
};
