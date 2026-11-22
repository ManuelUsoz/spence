export interface CdpAxValue {
  readonly type: string;
  readonly value?: unknown;
}

export interface CdpAxProperty {
  readonly name: string;
  readonly value: CdpAxValue;
}

export interface CdpAxNode {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: CdpAxValue;
  readonly name?: CdpAxValue;
  readonly value?: CdpAxValue;
  readonly properties?: ReadonlyArray<CdpAxProperty>;
  readonly backendDOMNodeId?: number;
  readonly parentId?: string;
  readonly childIds?: ReadonlyArray<string>;
}

export interface SnapshotBuildResult {
  readonly outline: string;
  readonly refs: Map<string, number>;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
  'gridcell',
]);

const SKIPPED_GENERIC_ROLES = new Set(['generic', 'none', 'presentation']);
const MAX_SNAPSHOT_LINES = 800;

const stringOf = (value: CdpAxValue | undefined): string =>
  typeof value?.value === 'string' ? value.value : '';

const formatText = (value: string): string => {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  const clipped = collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
  return JSON.stringify(clipped);
};

const isTrue = (prop: CdpAxProperty): boolean => prop.value.value === true;

const hasInteractiveProperty = (properties: ReadonlyArray<CdpAxProperty> | undefined): boolean =>
  properties?.some((prop) => prop.name === 'focusable' && isTrue(prop)) ?? false;

/** Builds a compact indented accessibility outline and `ref -> backendDOMNodeId` map from a CDP AXTree. */
export const buildAccessibilitySnapshot = (
  nodes: ReadonlyArray<CdpAxNode>,
): SnapshotBuildResult => {
  const refs = new Map<string, number>();
  if (nodes.length === 0) {
    return { outline: '(empty page)', refs };
  }

  const byId = new Map<string, CdpAxNode>();
  for (const node of nodes) {
    byId.set(node.nodeId, node);
  }
  const root = nodes.find((node) => node.parentId === undefined) ?? nodes[0];
  if (root === undefined) {
    return { outline: '(empty page)', refs };
  }

  const lines: Array<string> = [];
  const visited = new Set<string>();
  let nextRef = 1;
  let truncated = false;

  const visit = (nodeId: string, depth: number, ancestorName: string): void => {
    if (visited.has(nodeId) || truncated) return;
    visited.add(nodeId);
    const node = byId.get(nodeId);
    if (node === undefined) return;

    const rawRole = stringOf(node.role) || 'unknown';
    if (rawRole === 'InlineTextBox') return;

    const rawName = stringOf(node.name).trim();
    const isInteractive = INTERACTIVE_ROLES.has(rawRole) || hasInteractiveProperty(node.properties);
    const shouldSkipNode =
      node.ignored === true ||
      (SKIPPED_GENERIC_ROLES.has(rawRole) && rawName === '' && !isInteractive) ||
      (rawRole === 'StaticText' && (rawName === '' || rawName === ancestorName));

    if (shouldSkipNode) {
      for (const childId of node.childIds ?? []) {
        visit(childId, depth, ancestorName);
      }
      return;
    }

    if (lines.length >= MAX_SNAPSHOT_LINES) {
      truncated = true;
      return;
    }

    const displayRole = rawRole === 'StaticText' ? 'text' : rawRole;
    const parts: Array<string> = [`${'  '.repeat(depth)}- ${displayRole}`];
    if (rawName !== '') {
      parts.push(formatText(rawName));
    }

    if (isInteractive && node.backendDOMNodeId !== undefined) {
      const ref = `e${nextRef++}`;
      refs.set(ref, node.backendDOMNodeId);
      parts.push(`[ref=${ref}]`);
    }

    const rawValue = stringOf(node.value);
    if (rawValue !== '') {
      parts.push(`[value=${formatText(rawValue)}]`);
    }

    for (const prop of node.properties ?? []) {
      const val = prop.value.value;
      if (prop.name === 'level' && typeof val === 'number') {
        parts.push(`[level=${val}]`);
      } else if (
        prop.name === 'checked' &&
        (val === 'true' || val === 'false' || val === 'mixed')
      ) {
        parts.push(`[checked=${val}]`);
      } else if (prop.name === 'expanded' && typeof val === 'boolean') {
        parts.push(`[expanded=${String(val)}]`);
      } else if (prop.name === 'selected' && val === true) {
        parts.push('[selected=true]');
      } else if (prop.name === 'focused' && val === true) {
        parts.push('[focused]');
      } else if (prop.name === 'disabled' && val === true) {
        parts.push('[disabled]');
      } else if (prop.name === 'required' && val === true) {
        parts.push('[required]');
      }
    }

    lines.push(parts.join(' '));
    const nextAncestorName = rawName !== '' ? rawName : ancestorName;
    for (const childId of node.childIds ?? []) {
      visit(childId, depth + 1, nextAncestorName);
    }
  };

  visit(root.nodeId, 0, '');
  if (truncated) {
    lines.push('... (snapshot truncated)');
  }
  return {
    outline: lines.length === 0 ? '(empty page)' : lines.join('\n'),
    refs,
  };
};
