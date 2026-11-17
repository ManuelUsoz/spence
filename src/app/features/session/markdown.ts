import type { ListItem, Parent, PhrasingContent, Root, RootContent, Table } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/** A block of an Agent reply, ready for static Angular templates. */
export type MarkdownBlock =
  | { readonly type: 'paragraph'; readonly children: ReadonlyArray<MarkdownInline> }
  | {
      readonly type: 'heading';
      readonly depth: number;
      readonly children: ReadonlyArray<MarkdownInline>;
    }
  | { readonly type: 'code'; readonly value: string; readonly lang: string | null }
  | { readonly type: 'html'; readonly value: string; readonly block: true }
  | { readonly type: 'blockquote'; readonly children: ReadonlyArray<MarkdownBlock> }
  | {
      readonly type: 'list';
      readonly ordered: boolean;
      readonly start: number | null;
      readonly items: ReadonlyArray<MarkdownListItem>;
    }
  | {
      readonly type: 'table';
      readonly align: ReadonlyArray<'left' | 'center' | 'right' | null>;
      readonly header: ReadonlyArray<ReadonlyArray<MarkdownInline>>;
      readonly rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<MarkdownInline>>>;
    }
  | { readonly type: 'thematicBreak' }
  | { readonly type: 'unknown'; readonly children: ReadonlyArray<MarkdownBlock> };

/** A list entry; `checked` is null when it is not a task. */
export interface MarkdownListItem {
  readonly checked: boolean | null;
  readonly children: ReadonlyArray<MarkdownBlock>;
}

/** A run inside a paragraph, heading, table cell or link. */
export type MarkdownInline =
  | { readonly type: 'text'; readonly value: string }
  | {
      readonly type: 'emphasis' | 'strong' | 'delete';
      readonly children: ReadonlyArray<MarkdownInline>;
    }
  | { readonly type: 'inlineCode'; readonly value: string }
  | { readonly type: 'break' }
  | {
      readonly type: 'link';
      readonly url: string;
      readonly children: ReadonlyArray<MarkdownInline>;
    }
  | { readonly type: 'image'; readonly url: string; readonly alt: string }
  | { readonly type: 'html'; readonly value: string; readonly block: false }
  | { readonly type: 'unknown'; readonly children: ReadonlyArray<MarkdownInline> };

const processor = unified().use(remarkParse).use(remarkGfm).freeze();

type Definitions = ReadonlyMap<string, string>;

const definitionsOf = (root: Root): Definitions => {
  const definitions = new Map<string, string>();
  for (const node of root.children) {
    if (node.type === 'definition') definitions.set(node.identifier, node.url);
  }
  return definitions;
};

const textOf = (node: PhrasingContent): string => ('value' in node ? node.value : '');

const unknownInline = (node: PhrasingContent, defs: Definitions): MarkdownInline => {
  const children = 'children' in node ? inlineChildren(node, defs) : [];
  if (children.length > 0) return { type: 'unknown', children };
  return { type: 'text', value: textOf(node) };
};

const resolveUrl = (node: { url?: string; identifier?: string }, defs: Definitions): string =>
  node.url ?? defs.get(node.identifier ?? '') ?? '';

const inlineOf = (node: PhrasingContent, defs: Definitions): MarkdownInline => {
  switch (node.type) {
    case 'text':
      return { type: 'text', value: node.value };
    case 'emphasis':
    case 'strong':
    case 'delete':
      return { type: node.type, children: inlineChildren(node, defs) };
    case 'inlineCode':
      return { type: 'inlineCode', value: node.value };
    case 'break':
      return { type: 'break' };
    case 'link':
      return { type: 'link', url: node.url, children: inlineChildren(node, defs) };
    case 'linkReference':
      return {
        type: 'link',
        url: resolveUrl(node, defs),
        children: inlineChildren(node, defs),
      };
    case 'image':
      return { type: 'image', url: node.url, alt: node.alt ?? '' };
    case 'imageReference':
      return {
        type: 'image',
        url: resolveUrl(node, defs),
        alt: node.alt ?? '',
      };
    case 'html':
      return { type: 'html', value: node.value, block: false };
    case 'footnoteReference':
      return { type: 'text', value: `[${node.label ?? node.identifier}]` };
    default:
      return unknownInline(node, defs);
  }
};

const inlineChildren = (parent: Parent, defs: Definitions): ReadonlyArray<MarkdownInline> =>
  parent.children.map((child) => inlineOf(child as PhrasingContent, defs));

const listItemOf = (item: ListItem, defs: Definitions): MarkdownListItem => ({
  checked: typeof item.checked === 'boolean' ? item.checked : null,
  children: blockChildren(item, defs),
});

const tableOf = (node: Table, defs: Definitions) => {
  const cells = (row: Table['children'][number]) =>
    row.children.map((cell) => inlineChildren(cell, defs));
  const [header, ...rows] = node.children;
  return {
    type: 'table' as const,
    align: node.align ?? [],
    header: header === undefined ? [] : cells(header),
    rows: rows.map(cells),
  };
};

const blockOf = (node: RootContent, defs: Definitions): MarkdownBlock | null => {
  if (node.type === 'paragraph') {
    return { type: 'paragraph', children: inlineChildren(node, defs) };
  }
  if (node.type === 'heading') {
    return { type: 'heading', depth: node.depth, children: inlineChildren(node, defs) };
  }
  if (node.type === 'code') {
    return {
      type: 'code',
      value: node.value,
      lang: typeof node.lang === 'string' && node.lang.trim() !== '' ? node.lang.trim() : null,
    };
  }
  if (node.type === 'html') return { type: 'html', value: node.value, block: true };
  if (node.type === 'blockquote') {
    return { type: 'blockquote', children: blockChildren(node, defs) };
  }
  if (node.type === 'list') {
    return {
      type: 'list',
      ordered: node.ordered === true,
      start: node.start ?? null,
      items: node.children.map((item) => listItemOf(item, defs)),
    };
  }
  if (node.type === 'table') return tableOf(node, defs);
  if (node.type === 'thematicBreak') return { type: 'thematicBreak' };
  if (node.type === 'definition') return null;
  if ('children' in node) return { type: 'unknown', children: blockChildren(node, defs) };
  return 'value' in node
    ? { type: 'paragraph', children: [{ type: 'text', value: node.value }] }
    : null;
};

const blockChildren = (parent: Parent, defs: Definitions): ReadonlyArray<MarkdownBlock> =>
  parent.children
    .map((child) => blockOf(child, defs))
    .filter((child): child is MarkdownBlock => child !== null);

/** Parses accumulated Message text into a typed tree; no HTML is compiled or injected. */
export const parseMarkdown = (text: string): ReadonlyArray<MarkdownBlock> => {
  if (text === '') return [];
  const root = processor.parse(text);
  const defs = definitionsOf(root);
  return blockChildren(root, defs);
};

/** Parsed settled replies, keyed by their exact text, so scrolling and re-rendering do not parse again. */
const settled = new Map<string, ReadonlyArray<MarkdownBlock>>();
const SETTLED_CACHE_LIMIT = 64;

/** The tree for a reply; only settled replies are cached. */
export const markdownBlocks = (text: string, isSettled: boolean): ReadonlyArray<MarkdownBlock> => {
  if (!isSettled) return parseMarkdown(text);
  const cached = settled.get(text);
  if (cached !== undefined) return cached;
  const blocks = parseMarkdown(text);
  settled.set(text, blocks);
  if (settled.size > SETTLED_CACHE_LIMIT) {
    const oldest = settled.keys().next().value;
    if (oldest !== undefined) settled.delete(oldest);
  }
  return blocks;
};

/** Clears the settled-reply cache (tests). */
export const clearMarkdownCache = (): void => {
  settled.clear();
};
