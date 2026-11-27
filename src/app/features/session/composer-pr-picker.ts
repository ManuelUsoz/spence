import {
  PullRequestNumber,
  type PullRequestSummary,
} from '../../../shared/pull-requests/pull-requests.rpc';
import {
  composerPullRequestAttachmentKey,
  MAX_COMPOSER_PULL_REQUESTS,
  type ComposerPullRequestAttachment,
  type PullRequestPart,
} from '../../../shared/sessions/sessions.rpc';

export interface ActiveAtMention {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/**
 * Detects an active `@<query>` mention at the caret when `@` appears at the start of input or after whitespace.
 */
export const parseActiveAtMention = (text: string, caret: number): ActiveAtMention | null => {
  const clamped = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, clamped);
  const atIndex = before.lastIndexOf('@');
  if (atIndex < 0) return null;
  if (atIndex > 0 && !/\s/.test(before[atIndex - 1] ?? '')) return null;
  const query = before.slice(atIndex + 1);
  if (/\s/.test(query)) return null;
  return { start: atIndex, end: clamped, query };
};

/** Strips the `@<query>` token from `text` and collapses redundant surrounding whitespace. */
export const stripAtMentionToken = (
  text: string,
  mention: ActiveAtMention,
): { readonly text: string; readonly caret: number } => {
  const before = text.slice(0, mention.start);
  const after = text.slice(mention.end);
  const needsSpace =
    before.length > 0 && after.length > 0 && !/\s$/.test(before) && !/^\s/.test(after);
  const trimmedBefore =
    before.endsWith(' ') && after.startsWith(' ') ? before.slice(0, -1) : before;
  const nextText = `${trimmedBefore}${needsSpace ? ' ' : ''}${after}`;
  return { text: nextText, caret: trimmedBefore.length + (needsSpace ? 1 : 0) };
};

/** Parses `@#<number>` queries (e.g. `#198`) for on-demand `PullRequests.lookupByNumber`. */
export const parsePrNumberQuery = (query: string): PullRequestNumber | null => {
  const match = /^#(\d+)$/.exec(query.trim());
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isSafeInteger(num) || num <= 0) return null;
  return PullRequestNumber.make(num);
};

/** Ranks the active Worktree's linked PR first and filters by `#number`, title, branch, or author. */
export const rankAndFilterPrs = (input: {
  readonly summaries: ReadonlyArray<PullRequestSummary>;
  readonly linkedPrNumber: PullRequestNumber | null;
  readonly query: string;
}): ReadonlyArray<PullRequestSummary> => {
  const q = input.query.trim().toLowerCase().replace(/^#/, '');
  const filtered = input.summaries.filter((pr) => {
    if (q.length === 0) return true;
    return (
      String(pr.ref.number).includes(q) ||
      pr.title.toLowerCase().includes(q) ||
      pr.headRef.toLowerCase().includes(q) ||
      pr.author.login.toLowerCase().includes(q) ||
      (pr.author.displayName?.toLowerCase().includes(q) ?? false)
    );
  });

  if (input.linkedPrNumber === null) return filtered;
  return [...filtered].sort((a, b) => {
    const aLinked = a.ref.number === input.linkedPrNumber ? 0 : 1;
    const bLinked = b.ref.number === input.linkedPrNumber ? 0 : 1;
    return aLinked - bLinked;
  });
};

/** Appends a `ComposerPullRequestAttachment` if not already present and under the 5-item cap. */
export const addPrAttachment = (
  list: ReadonlyArray<ComposerPullRequestAttachment>,
  attachment: ComposerPullRequestAttachment,
): {
  readonly list: ReadonlyArray<ComposerPullRequestAttachment>;
  readonly added: boolean;
  readonly reason?: 'duplicate' | 'limit';
} => {
  const key = composerPullRequestAttachmentKey(attachment);
  if (list.some((item) => composerPullRequestAttachmentKey(item) === key)) {
    return { list, added: false, reason: 'duplicate' };
  }
  if (list.length >= MAX_COMPOSER_PULL_REQUESTS) {
    return { list, added: false, reason: 'limit' };
  }
  return { list: [...list, attachment], added: true };
};

export const removePrAttachment = (
  list: ReadonlyArray<ComposerPullRequestAttachment>,
  key: string,
): ReadonlyArray<ComposerPullRequestAttachment> =>
  list.filter((item) => composerPullRequestAttachmentKey(item) !== key);

export const prAttachmentLabel = (
  item: Pick<
    ComposerPullRequestAttachment | PullRequestPart,
    'kind' | 'ref' | 'title' | 'path' | 'line' | 'checkName'
  >,
): string => {
  switch (item.kind) {
    case 'pullRequest':
      return `PR #${item.ref.number} · ${item.title}`;
    case 'reviewThread': {
      const loc =
        item.line !== undefined && item.line !== null
          ? `${item.path ?? ''}:${item.line}`
          : (item.path ?? '');
      return `Review thread · ${loc}`;
    }
    case 'checkRun':
      return `Check · ${item.checkName ?? 'Check'}`;
  }
};

export const prAttachmentTooltip = (
  item: Pick<ComposerPullRequestAttachment | PullRequestPart, 'headSha' | 'state'>,
): string => `${item.headSha.slice(0, 7)} · ${item.state}`;
