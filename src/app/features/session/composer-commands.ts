export interface SlashToken {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export interface ComposerSegment {
  readonly text: string;
  readonly isCommand: boolean;
}

export type PopoverPlacement = 'up' | 'down';

/**
 * Picks `'up'` or `'down'` for an inline popover anchored to `anchor` based on available viewport
 * space, falling back to `fallback` when layout dimensions are unavailable (e.g. jsdom).
 */
export const choosePopoverPlacement = (
  anchor: { getBoundingClientRect: () => DOMRect } | undefined,
  viewportHeight: number,
  fallback: PopoverPlacement,
  neededHeight = 340,
): PopoverPlacement => {
  if (anchor === undefined || viewportHeight <= 0) return fallback;
  const rect = anchor.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.bottom === 0) {
    return fallback;
  }
  const spaceAbove = rect.top;
  const spaceBelow = viewportHeight - rect.bottom;
  if (fallback === 'down') {
    return spaceBelow < neededHeight && spaceAbove > spaceBelow ? 'up' : 'down';
  }
  return spaceAbove < neededHeight && spaceBelow > spaceAbove ? 'down' : 'up';
};

/**
 * Finds an active `/command` token at the current caret position (at the start of text or after
 * whitespace/newline). Returns `null` when there is a range selection, the token does not start
 * with `/`, or the query already contains `/` (such as a file path).
 */
export const activeSlashToken = (
  text: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): SlashToken | null => {
  if (selectionStart !== selectionEnd) return null;
  const caret = Math.max(0, Math.min(selectionStart, text.length));
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1] ?? '')) {
    start -= 1;
  }
  if (text[start] !== '/') return null;
  const query = text.slice(start + 1, caret);
  if (query.includes('/')) return null;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end] ?? '')) {
    end += 1;
  }
  return { start, end, query };
};

/** Replaces `token` in `text` with `invocation` plus a trailing space (avoiding a double space). */
export const replaceSlashToken = (
  text: string,
  token: SlashToken,
  invocation: string,
): { readonly text: string; readonly caret: number } => {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  const insert = after.startsWith(' ') ? invocation : `${invocation} `;
  return {
    text: `${before}${insert}${after}`,
    caret: before.length + invocation.length + 1,
  };
};

/** Removes `token` from `text` while collapsing a redundant adjacent space. */
export const removeSlashToken = (text: string, token: SlashToken): string => {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  const merged =
    before.endsWith(' ') && after.startsWith(' ')
      ? `${before}${after.slice(1)}`
      : `${before}${after}`;
  return merged.trim() === '' ? '' : merged;
};

/** Splits `text` into plain segments and recognized command tokens for backdrop highlighting. */
export const splitComposerSegments = (
  text: string,
  invocations: ReadonlySet<string>,
): ReadonlyArray<ComposerSegment> => {
  if (text === '') return [];
  if (invocations.size === 0) return [{ text, isCommand: false }];
  const segments: Array<ComposerSegment> = [];
  let cursor = 0;
  for (const match of text.matchAll(/\S+/g)) {
    const index = match.index;
    const token = match[0];
    if (!invocations.has(token.toLowerCase())) continue;
    if (index > cursor) {
      segments.push({ text: text.slice(cursor, index), isCommand: false });
    }
    segments.push({ text: token, isCommand: true });
    cursor = index + token.length;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), isCommand: false });
  }
  return segments;
};
