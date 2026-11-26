import { codeToTokensWithThemes } from 'shiki';
import { markdownBlocks, type MarkdownBlock } from '@ui/markdown';
import type {
  PrDiffHunk,
  PrDiffLine,
  PullRequestDiffFile,
  ReviewThread,
} from '../../../shared/pull-requests/pull-requests.rpc';

/** A single word-level diff span inside a changed diff line. */
export interface WordDiffSegment {
  readonly text: string;
  readonly changed: boolean;
}

/** A Shiki syntax-highlighted token with light and dark theme colors. */
export interface HighlightToken {
  readonly content: string;
  readonly light: string | undefined;
  readonly dark: string | undefined;
}

/** A diff line enriched with Shiki tokens, word-level diff segments, and anchored review threads. */
export interface RenderedDiffLine {
  readonly kind: PrDiffLine['kind'];
  readonly content: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly tokens: ReadonlyArray<HighlightToken> | null;
  readonly wordDiff: ReadonlyArray<WordDiffSegment> | null;
  readonly threads: ReadonlyArray<ReviewThread>;
}

/** A diff hunk with enriched lines. */
export interface RenderedDiffHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: ReadonlyArray<RenderedDiffLine>;
}

/** A diff file prepared off the UI thread for rendering. */
export interface RenderedDiffFile {
  readonly path: string;
  readonly hunks: ReadonlyArray<RenderedDiffHunk>;
  readonly unanchoredThreads: ReadonlyArray<ReviewThread>;
}

export type PrRenderRequest =
  | { readonly kind: 'markdown'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'markdownBatch';
      readonly items: ReadonlyArray<{ readonly id: string; readonly text: string }>;
    }
  | {
      readonly kind: 'diffFile';
      readonly file: PullRequestDiffFile;
      readonly threads: ReadonlyArray<ReviewThread>;
    };

export type PrRenderResponse =
  | {
      readonly kind: 'markdown';
      readonly id: string;
      readonly blocks: ReadonlyArray<MarkdownBlock>;
    }
  | {
      readonly kind: 'markdownBatch';
      readonly results: ReadonlyArray<{
        readonly id: string;
        readonly blocks: ReadonlyArray<MarkdownBlock>;
      }>;
    }
  | { readonly kind: 'diffFile'; readonly rendered: RenderedDiffFile };

type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'markdown'
  | 'html'
  | 'css'
  | 'python'
  | 'shellscript'
  | 'yaml'
  | 'rust'
  | 'go'
  | 'docker';

const FILE_NAMES: Readonly<Record<string, SupportedLanguage>> = {
  dockerfile: 'docker',
  '.gitignore': 'shellscript',
};

const FILE_EXTENSIONS: Readonly<Record<string, SupportedLanguage>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  css: 'css',
  scss: 'css',
  py: 'python',
  sh: 'shellscript',
  yml: 'yaml',
  yaml: 'yaml',
  rs: 'rust',
  go: 'go',
};

const languageForPath = (path: string): SupportedLanguage | undefined => {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (FILE_NAMES[name] !== undefined) return FILE_NAMES[name];
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? undefined : FILE_EXTENSIONS[name.slice(dot + 1)];
};

/** Parses GFM Markdown text into static AST blocks using Remark. */
export const renderMarkdownBlocks = (text: string): ReadonlyArray<MarkdownBlock> =>
  markdownBlocks(text, true);

const tokenizeForWordDiff = (text: string): ReadonlyArray<string> => {
  const tokens: Array<string> = [];
  const regex = /[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_]+/g;
  for (const match of text.matchAll(regex)) {
    tokens.push(match[0]);
  }
  return tokens;
};

const mergeSegments = (
  segments: ReadonlyArray<WordDiffSegment>,
): ReadonlyArray<WordDiffSegment> => {
  const merged: Array<WordDiffSegment> = [];
  for (const seg of segments) {
    if (seg.text.length === 0) continue;
    const prev = merged.at(-1);
    if (prev !== undefined && prev.changed === seg.changed) {
      merged[merged.length - 1] = { text: prev.text + seg.text, changed: prev.changed };
    } else {
      merged.push(seg);
    }
  }
  return merged;
};

/**
 * Computes token-level word diff segments between a removed line and an added line.
 * Uses a bounded Myers-style LCS table; falls back to whole-line highlight on very long lines.
 */
export const computeWordDiff = (
  removedText: string,
  addedText: string,
): {
  readonly removed: ReadonlyArray<WordDiffSegment>;
  readonly added: ReadonlyArray<WordDiffSegment>;
} => {
  if (removedText === addedText) {
    return {
      removed: [{ text: removedText, changed: false }],
      added: [{ text: addedText, changed: false }],
    };
  }
  const left = tokenizeForWordDiff(removedText);
  const right = tokenizeForWordDiff(addedText);
  if (left.length === 0 || right.length === 0 || left.length * right.length > 4096) {
    return {
      removed: removedText.length > 0 ? [{ text: removedText, changed: true }] : [],
      added: addedText.length > 0 ? [{ text: addedText, changed: true }] : [],
    };
  }

  const rows = left.length + 1;
  const cols = right.length + 1;
  const dp = new Uint16Array(rows * cols);

  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      const idx = i * cols + j;
      if (left[i] === right[j]) {
        dp[idx] = (dp[(i + 1) * cols + (j + 1)] ?? 0) + 1;
      } else {
        const down = dp[(i + 1) * cols + j] ?? 0;
        const rightCell = dp[i * cols + (j + 1)] ?? 0;
        dp[idx] = down >= rightCell ? down : rightCell;
      }
    }
  }

  const removedSegs: Array<WordDiffSegment> = [];
  const addedSegs: Array<WordDiffSegment> = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const l = left[i] ?? '';
    const r = right[j] ?? '';
    if (l === r) {
      removedSegs.push({ text: l, changed: false });
      addedSegs.push({ text: r, changed: false });
      i++;
      j++;
    } else if ((dp[(i + 1) * cols + j] ?? 0) >= (dp[i * cols + (j + 1)] ?? 0)) {
      removedSegs.push({ text: l, changed: true });
      i++;
    } else {
      addedSegs.push({ text: r, changed: true });
      j++;
    }
  }
  while (i < left.length) {
    removedSegs.push({ text: left[i] ?? '', changed: true });
    i++;
  }
  while (j < right.length) {
    addedSegs.push({ text: right[j] ?? '', changed: true });
    j++;
  }

  return {
    removed: mergeSegments(removedSegs),
    added: mergeSegments(addedSegs),
  };
};

/** Maps inline Review threads for `filePath` onto matching `oldLine` (LEFT) or `newLine` (RIGHT) hunk lines. */
export const anchorReviewThreads = (
  filePath: string,
  hunks: ReadonlyArray<PrDiffHunk>,
  threads: ReadonlyArray<ReviewThread>,
): {
  readonly hunks: ReadonlyArray<RenderedDiffHunk>;
  readonly unanchoredThreads: ReadonlyArray<ReviewThread>;
} => {
  const fileThreads = threads.filter((t) => t.path === filePath);
  const anchoredIds = new Set<string>();

  const renderedHunks: Array<RenderedDiffHunk> = hunks.map((hunk) => ({
    header: hunk.header,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines.map((line) => {
      const matched = fileThreads.filter((thread) => {
        if (thread.line === null) return false;
        if (thread.side === 'LEFT') {
          return line.oldLine !== null && line.oldLine === thread.line;
        }
        return line.newLine !== null && line.newLine === thread.line;
      });
      for (const m of matched) anchoredIds.add(m.id);
      return {
        kind: line.kind,
        content: line.content,
        oldLine: line.oldLine,
        newLine: line.newLine,
        tokens: null,
        wordDiff: null,
        threads: matched,
      };
    }),
  }));

  const unanchoredThreads = fileThreads.filter((t) => !anchoredIds.has(t.id));
  return { hunks: renderedHunks, unanchoredThreads };
};

const attachWordDiffs = (hunks: ReadonlyArray<RenderedDiffHunk>): ReadonlyArray<RenderedDiffHunk> =>
  hunks.map((hunk) => {
    const lines = hunk.lines.map((line) => ({ ...line }));
    let i = 0;
    while (i < lines.length) {
      if (lines[i]?.kind !== 'removed') {
        i++;
        continue;
      }
      const removedStart = i;
      while (i < lines.length && lines[i]?.kind === 'removed') i++;
      const addedStart = i;
      while (i < lines.length && lines[i]?.kind === 'added') i++;
      const removedCount = addedStart - removedStart;
      const addedCount = i - addedStart;
      const pairCount = Math.min(removedCount, addedCount);
      for (let k = 0; k < pairCount; k++) {
        const rem = lines[removedStart + k];
        const add = lines[addedStart + k];
        if (rem === undefined || add === undefined) continue;
        const diff = computeWordDiff(rem.content, add.content);
        lines[removedStart + k] = { ...rem, wordDiff: diff.removed };
        lines[addedStart + k] = { ...add, wordDiff: diff.added };
      }
    }
    return { ...hunk, lines };
  });

/** Highlights all hunk lines in a PR diff file with Shiki, computes word diffs, and anchors review threads. */
export const renderDiffFile = async (
  file: PullRequestDiffFile,
  threads: ReadonlyArray<ReviewThread>,
): Promise<RenderedDiffFile> => {
  const anchored = anchorReviewThreads(file.path, file.hunks, threads);
  const withWordDiff = attachWordDiffs(anchored.hunks);
  const lang = languageForPath(file.path);

  if (lang === undefined || withWordDiff.length === 0) {
    return {
      path: file.path,
      hunks: withWordDiff,
      unanchoredThreads: anchored.unanchoredThreads,
    };
  }

  const allLines: Array<string> = [];
  for (const hunk of withWordDiff) {
    for (const line of hunk.lines) {
      allLines.push(line.content);
    }
  }

  if (allLines.length === 0) {
    return {
      path: file.path,
      hunks: withWordDiff,
      unanchoredThreads: anchored.unanchoredThreads,
    };
  }

  try {
    const tokenLines = await codeToTokensWithThemes(allLines.join('\n'), {
      lang,
      themes: { light: 'github-light', dark: 'github-dark' },
    });

    let cursor = 0;
    const highlightedHunks: Array<RenderedDiffHunk> = withWordDiff.map((hunk) => ({
      ...hunk,
      lines: hunk.lines.map((line) => {
        const rawTokens = tokenLines[cursor++];
        const tokens: ReadonlyArray<HighlightToken> | null =
          rawTokens === undefined
            ? null
            : rawTokens.map((t) => ({
                content: t.content,
                light: t.variants['light']?.color,
                dark: t.variants['dark']?.color,
              }));
        return { ...line, tokens };
      }),
    }));

    return {
      path: file.path,
      hunks: highlightedHunks,
      unanchoredThreads: anchored.unanchoredThreads,
    };
  } catch {
    return {
      path: file.path,
      hunks: withWordDiff,
      unanchoredThreads: anchored.unanchoredThreads,
    };
  }
};

/** Executes one render request (used both in `pr-render.worker.ts` and in-process test fallback). */
export const processRenderRequest = async (req: PrRenderRequest): Promise<PrRenderResponse> => {
  switch (req.kind) {
    case 'markdown':
      return {
        kind: 'markdown',
        id: req.id,
        blocks: renderMarkdownBlocks(req.text),
      };
    case 'markdownBatch':
      return {
        kind: 'markdownBatch',
        results: req.items.map((item) => ({
          id: item.id,
          blocks: renderMarkdownBlocks(item.text),
        })),
      };
    case 'diffFile':
      return {
        kind: 'diffFile',
        rendered: await renderDiffFile(req.file, req.threads),
      };
  }
};
