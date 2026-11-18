import { MAX_DIFF_BYTES, MAX_DIFF_LINES } from './git-exec';
import type { WorkerDiffHunk, WorkerDiffLine } from './worker-protocol';

export interface ParsedUnifiedDiff {
  readonly isBinary: boolean;
  readonly previousPath?: string;
  readonly hunks: ReadonlyArray<WorkerDiffHunk>;
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
  readonly truncationDetail?: string;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

const normalizeDiffLineEndings = (line: string): string =>
  line.endsWith('\r') ? line.slice(0, -1) : line;

export const parseUnifiedDiff = (rawStdout: string): ParsedUnifiedDiff => {
  if (/^Binary files .* differ$/m.test(rawStdout) || /^GIT binary patch$/m.test(rawStdout)) {
    return {
      isBinary: true,
      hunks: [],
      additions: 0,
      deletions: 0,
      truncated: false,
    };
  }

  const lines = rawStdout.split('\n');
  const hunks: WorkerDiffHunk[] = [];
  let currentHunk: {
    readonly header: string;
    readonly oldStart: number;
    readonly oldLines: number;
    readonly newStart: number;
    readonly newLines: number;
    readonly lines: WorkerDiffLine[];
  } | null = null;

  let oldLine = 0;
  let newLine = 0;
  let additions = 0;
  let deletions = 0;
  let capturedLines = 0;
  let capturedBytes = 0;
  let truncated = false;
  let truncationDetail: string | undefined;
  let previousPath: string | undefined;
  let inHeader = true;

  for (const rawLine of lines) {
    const line = normalizeDiffLineEndings(rawLine);

    if (inHeader) {
      if (line.startsWith('rename from ')) {
        previousPath = line.slice('rename from '.length);
        continue;
      }
      if (line.startsWith('copy from ')) {
        previousPath = line.slice('copy from '.length);
        continue;
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
    if (line === '\\ No newline at end of file') continue;
    if (line === '') continue;

    const prefix = line[0];
    if (prefix !== '+' && prefix !== '-' && prefix !== ' ') {
      continue;
    }

    if (capturedLines >= MAX_DIFF_LINES || capturedBytes + line.length > MAX_DIFF_BYTES) {
      truncated = true;
      truncationDetail = `Preview truncated after ${String(capturedLines)} diff lines (${String(MAX_DIFF_BYTES)} byte preview cap).`;
      break;
    }

    const content = line.slice(1);
    capturedLines += 1;
    capturedBytes += content.length + 1;

    if (prefix === '+') {
      additions += 1;
      currentHunk.lines.push({
        kind: 'add',
        newLine,
        text: content,
      });
      newLine += 1;
    } else if (prefix === '-') {
      deletions += 1;
      currentHunk.lines.push({
        kind: 'delete',
        oldLine,
        text: content,
      });
      oldLine += 1;
    } else {
      currentHunk.lines.push({
        kind: 'context',
        oldLine,
        newLine,
        text: content,
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  if (currentHunk !== null) {
    hunks.push(currentHunk);
  }

  return {
    isBinary: false,
    ...(previousPath === undefined ? {} : { previousPath }),
    hunks,
    additions,
    deletions,
    truncated,
    ...(truncationDetail === undefined ? {} : { truncationDetail }),
  };
};

export const buildAddedTextHunks = (
  text: string,
): {
  readonly hunks: ReadonlyArray<WorkerDiffHunk>;
  readonly additions: number;
  readonly truncated: boolean;
  readonly truncationDetail?: string;
} => {
  if (text.length === 0) {
    return { hunks: [], additions: 0, truncated: false };
  }
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  const rawLines = normalized.split('\n');
  const lines: WorkerDiffLine[] = [];
  let capturedBytes = 0;
  let truncated = false;
  let truncationDetail: string | undefined;

  for (let i = 0; i < rawLines.length; i += 1) {
    const lineText = normalizeDiffLineEndings(rawLines[i] ?? '');
    if (lines.length >= MAX_DIFF_LINES || capturedBytes + lineText.length > MAX_DIFF_BYTES) {
      truncated = true;
      truncationDetail = `Preview truncated after ${String(lines.length)} added lines.`;
      break;
    }
    capturedBytes += lineText.length + 1;
    lines.push({
      kind: 'add',
      newLine: i + 1,
      text: lineText,
    });
  }

  return {
    hunks: [
      {
        header: `@@ -0,0 +1,${String(lines.length)} @@`,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines,
      },
    ],
    additions: lines.length,
    truncated,
    ...(truncationDetail === undefined ? {} : { truncationDetail }),
  };
};
