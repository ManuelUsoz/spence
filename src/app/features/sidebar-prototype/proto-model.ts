// PROTOTYPE (throwaway, branch prototype/project-sidebar): "Sidebar inside a Project" (issue #19).
// In-memory Projects and Sessions plus every sidebar action, shared by all variants. Nothing is persisted.
import { Injectable, computed, signal } from '@angular/core';

export type Attention = 'answer' | 'error' | null;
export type Order = 'activity' | 'created';

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly folderMissing: boolean;
}

export interface Session {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: number;
  /** When a Turn last started (or the Session was created). */
  readonly lastActivityAt: number;
  readonly running: boolean;
  readonly attention: Attention;
  readonly archivedAt: number | null;
  readonly tabOpen: boolean;
}

export interface Draft {
  readonly projectId: string;
}

export type MenuTarget =
  | { readonly kind: 'session'; readonly id: string }
  | { readonly kind: 'project'; readonly id: string }
  | { readonly kind: 'archived'; readonly id: string };

export interface MenuItem {
  readonly label: string;
  readonly danger?: boolean;
  readonly separator?: boolean;
  readonly run: () => void;
}

export const NOW = Date.parse('2026-11-11T15:00:00');
const H = 3_600_000;
const D = 24 * H;

let seq = 0;
function s(
  projectId: string,
  title: string,
  createdAgo: number,
  activeAgo: number,
  extra: Partial<Session> = {},
): Session {
  seq += 1;
  return {
    id: `s${seq}`,
    projectId,
    title,
    createdAt: NOW - createdAgo,
    lastActivityAt: NOW - activeAgo,
    running: false,
    attention: null,
    archivedAt: null,
    tabOpen: false,
    ...extra,
  };
}

const TITLES = [
  'Fix flaky e2e on Windows',
  'Add Spanish strings to composer',
  'Why does verify take 40s?',
  'Rename Chat to Session everywhere',
  'Sketch the transcript store',
  'Bump Effect to 4.1.3',
  'Lint rule for @ui imports',
  'Investigate MessagePort leak',
  'Write ADR for blobs folder',
  'Clean up desktop-layers',
  'Spartan sonner toast',
  'Project picker empty state',
  'Dark mode tokens',
  'Shrink electron bundle',
  'Explain RpcSerialization',
  'Kill process tree on quit',
  'Retry login flow',
  'Sort Projects by name',
  'Context menu keyboard support',
  'Archive fold animation',
];

export interface Scenario {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly build: () => { projects: Project[]; sessions: Session[] };
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'typical',
    label: 'Typical week',
    hint: 'Three Projects. One Session running, one needs an answer, one failed. A few archived.',
    build: () => {
      seq = 0;
      const projects: Project[] = [
        { id: 'spence', name: 'spence', path: 'C:\\Users\\me\\workspace\\spence', folderMissing: false },
        { id: 'blog', name: 'blog', path: 'C:\\Users\\me\\blog', folderMissing: false },
        { id: 'dotfiles', name: 'dotfiles', path: 'C:\\Users\\me\\dotfiles', folderMissing: false },
      ];
      const sessions: Session[] = [
        s('spence', 'Sidebar inside a Project', 2 * H, 5 * 60_000, { running: true, tabOpen: true }),
        s('spence', 'Kill process tree on quit', 3 * D, 40 * 60_000, { attention: 'answer', tabOpen: true }),
        s('spence', 'Add Spanish strings to composer', 26 * H, 20 * H),
        s('spence', 'Investigate MessagePort leak', 5 * D, 30 * H, { attention: 'error' }),
        s('spence', 'Write ADR for blobs folder', 4 * D, 4 * D),
        s('spence', 'Bump Effect to 4.1.3', 12 * D, 9 * D),
        s('spence', 'Lint rule for @ui imports', 20 * D, 18 * D),
        s('spence', 'Explain RpcSerialization', 45 * D, 44 * D),
        s('spence', 'Old spike: hand-rolled JSON-RPC', 60 * D, 58 * D, { archivedAt: NOW - 20 * D }),
        s('spence', 'Try Electron Forge', 70 * D, 69 * D, { archivedAt: NOW - 30 * D }),
        s('blog', 'Draft post on calm UIs', 2 * D, 3 * H),
        s('blog', 'Fix RSS feed dates', 9 * D, 9 * D),
        s('blog', 'Upgrade Astro', 40 * D, 39 * D, { archivedAt: NOW - 10 * D }),
        s('dotfiles', 'Port zshrc to PowerShell', 33 * D, 33 * D),
      ];
      return { projects, sessions };
    },
  },
  {
    id: 'busy',
    label: 'Busy Project (80 Sessions)',
    hint: 'One Project with 80 Sessions over four months, 25 archived. Does the list stay readable? Try search.',
    build: () => {
      seq = 0;
      const projects: Project[] = [
        { id: 'spence', name: 'spence', path: 'C:\\Users\\me\\workspace\\spence', folderMissing: false },
        { id: 'blog', name: 'blog', path: 'C:\\Users\\me\\blog', folderMissing: false },
      ];
      const sessions: Session[] = [];
      for (let i = 0; i < 80; i += 1) {
        const ago = Math.round((i * i) / 50 * D + i * 2 * H);
        const title = `${TITLES[i % TITLES.length]}${i >= TITLES.length ? ` (${Math.floor(i / TITLES.length) + 1})` : ''}`;
        sessions.push(
          s('spence', title, ago + 3 * H, ago, {
            running: i === 0 || i === 3,
            attention: i === 1 ? 'answer' : i === 9 ? 'error' : null,
            archivedAt: i >= 55 ? NOW - (i - 50) * D : null,
            tabOpen: i < 3,
          }),
        );
      }
      sessions.push(s('blog', 'Draft post on calm UIs', 2 * D, 3 * H));
      return { projects, sessions };
    },
  },
  {
    id: 'fresh',
    label: 'Just added a Project',
    hint: 'A new Project with no Sessions yet, next to one with a few. Click New Session: a draft gets a Tab but is not listed.',
    build: () => {
      seq = 0;
      const projects: Project[] = [
        { id: 'spence', name: 'spence', path: 'C:\\Users\\me\\workspace\\spence', folderMissing: false },
        { id: 'new', name: 'game-jam', path: 'C:\\Users\\me\\game-jam', folderMissing: false },
      ];
      return {
        projects,
        sessions: [
          s('spence', 'Sidebar inside a Project', 2 * H, 2 * H),
          s('spence', 'Add Spanish strings to composer', 26 * H, 20 * H),
        ],
      };
    },
  },
  {
    id: 'missing',
    label: 'Folder missing',
    hint: 'The blog Project’s folder moved. Its Sessions can be read; the Project menu offers Locate.',
    build: () => {
      seq = 0;
      const projects: Project[] = [
        { id: 'spence', name: 'spence', path: 'C:\\Users\\me\\workspace\\spence', folderMissing: false },
        { id: 'blog', name: 'blog', path: 'D:\\old\\blog', folderMissing: true },
      ];
      return {
        projects,
        sessions: [
          s('spence', 'Sidebar inside a Project', 2 * H, 2 * H, { running: true }),
          s('blog', 'Draft post on calm UIs', 2 * D, 3 * H),
          s('blog', 'Fix RSS feed dates', 9 * D, 9 * D),
        ],
      };
    },
  },
];

/** "Today", "Yesterday", "Previous 7 days", "Previous 30 days", then month names. */
export function dateGroup(ts: number): string {
  const day = new Date(NOW);
  day.setHours(0, 0, 0, 0);
  const start = day.getTime();
  if (ts >= start) return 'Today';
  if (ts >= start - D) return 'Yesterday';
  if (ts >= start - 7 * D) return 'Previous 7 days';
  if (ts >= start - 30 * D) return 'Previous 30 days';
  return new Date(ts).toLocaleString('en', { month: 'long', year: 'numeric' });
}

/** Short relative time: "now", "5m", "3h", "2d", "Oct 3". */
export function relTime(ts: number): string {
  const d = NOW - ts;
  if (d < 60_000) return 'now';
  if (d < H) return `${Math.floor(d / 60_000)}m`;
  if (d < D) return `${Math.floor(d / H)}h`;
  if (d < 7 * D) return `${Math.floor(d / D)}d`;
  return new Date(ts).toLocaleString('en', { month: 'short', day: 'numeric' });
}

export function groupByDate<T extends Session>(list: readonly T[], key: (s: T) => number) {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of list) {
    const label = dateGroup(key(item));
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

@Injectable({ providedIn: 'root' })
export class SidebarProto {
  readonly projects = signal<readonly Project[]>([]);
  readonly sessions = signal<readonly Session[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly draft = signal<Draft | null>(null);
  readonly selection = signal<ReadonlySet<string>>(new Set());
  private anchor: string | null = null;
  readonly order = signal<Order>('activity');
  readonly query = signal('');
  readonly menu = signal<{ x: number; y: number; target: MenuTarget } | null>(null);
  readonly toast = signal<{ text: string; undo?: () => void } | null>(null);
  readonly confirm = signal<{ text: string; ok: () => void } | null>(null);
  readonly renaming = signal<string | null>(null);
  readonly log = signal<readonly string[]>([]);
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  load(sc: Scenario): void {
    const { projects, sessions } = sc.build();
    this.projects.set(projects);
    this.sessions.set(sessions);
    this.activeId.set(sessions.find((x) => x.tabOpen)?.id ?? null);
    this.draft.set(null);
    this.selection.set(new Set());
    this.menu.set(null);
    this.toast.set(null);
    this.log.set([`loaded ${sc.id}`]);
  }

  private note(line: string): void {
    this.log.update((l) => [line, ...l].slice(0, 12));
  }

  readonly sortKey = computed(() =>
    this.order() === 'activity' ? (x: Session) => x.lastActivityAt : (x: Session) => x.createdAt,
  );

  /** Projects by last used, newest first (the global default from #16). */
  readonly orderedProjects = computed(() => {
    const last = (p: Project) =>
      Math.max(0, ...this.sessions().filter((x) => x.projectId === p.id).map((x) => x.lastActivityAt));
    return [...this.projects()].sort((a, b) => last(b) - last(a));
  });

  private matches(x: Session, p: Project | undefined): boolean {
    const q = this.query().trim().toLowerCase();
    if (q === '') return true;
    return x.title.toLowerCase().includes(q) || (p?.name.toLowerCase().includes(q) ?? false);
  }

  /** Listed (not archived) Sessions of a Project, filtered by the search, in the chosen order. */
  listed(projectId: string): Session[] {
    const p = this.projects().find((x) => x.id === projectId);
    const key = this.sortKey();
    return this.sessions()
      .filter((x) => x.projectId === projectId && x.archivedAt === null && this.matches(x, p))
      .sort((a, b) => key(b) - key(a));
  }

  archived(projectId: string): Session[] {
    const p = this.projects().find((x) => x.id === projectId);
    return this.sessions()
      .filter((x) => x.projectId === projectId && x.archivedAt !== null && this.matches(x, p))
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  }

  projectAttention(projectId: string): Attention {
    const list = this.sessions().filter((x) => x.projectId === projectId && x.archivedAt === null);
    if (list.some((x) => x.attention === 'error')) return 'error';
    if (list.some((x) => x.attention === 'answer')) return 'answer';
    return null;
  }

  projectRunning(projectId: string): boolean {
    return this.sessions().some((x) => x.projectId === projectId && x.running && x.archivedAt === null);
  }

  readonly active = computed(() => this.sessions().find((x) => x.id === this.activeId()) ?? null);

  /** Click on a row. Ctrl/Cmd toggles selection, Shift selects a range in `visible`. */
  click(ev: MouseEvent, id: string, visible: readonly Session[]): void {
    if (ev.ctrlKey || ev.metaKey) {
      this.selection.update((sel) => {
        const next = new Set(sel);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      this.anchor = id;
      return;
    }
    if (ev.shiftKey && this.anchor) {
      const ids = visible.map((x) => x.id);
      const a = ids.indexOf(this.anchor);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        this.selection.set(new Set(ids.slice(lo, hi + 1)));
        return;
      }
    }
    this.selection.set(new Set());
    this.anchor = id;
    this.open(id);
  }

  open(id: string): void {
    this.draft.set(null);
    this.activeId.set(id);
    this.sessions.update((l) => l.map((x) => (x.id === id ? { ...x, tabOpen: true } : x)));
  }

  newSession(projectId: string): void {
    this.activeId.set(null);
    this.draft.set({ projectId });
    this.note(`draft opened in ${projectId} (Tab only, not listed)`);
  }

  /** Simulates the draft's first Message: now it is a kept, listed Session. */
  sendDraft(): void {
    const d = this.draft();
    if (!d) return;
    const created = s(d.projectId, 'New Session', 0, 0, { running: true, tabOpen: true });
    this.sessions.update((l) => [...l, created]);
    this.draft.set(null);
    this.activeId.set(created.id);
    this.note(`draft sent → ${created.id} listed`);
  }

  clearSelection(): void {
    this.selection.set(new Set());
  }

  openMenu(ev: MouseEvent, target: MenuTarget): void {
    ev.preventDefault();
    if (target.kind === 'session' && !this.selection().has(target.id)) {
      this.selection.set(new Set());
    }
    this.menu.set({ x: ev.clientX, y: ev.clientY, target });
  }

  private targets(id: string): string[] {
    const sel = this.selection();
    return sel.has(id) && sel.size > 1 ? [...sel] : [id];
  }

  readonly menuItems = computed<MenuItem[]>(() => {
    const m = this.menu();
    if (!m) return [];
    const t = m.target;
    if (t.kind === 'session') {
      const ids = this.targets(t.id);
      const one = ids.length === 1;
      const ses = this.sessions().find((x) => x.id === t.id);
      const isArchived = ses?.archivedAt !== null;
      const n = one ? '' : ` ${ids.length} Sessions`;
      return [
        ...(one ? [{ label: 'Open', run: () => this.open(t.id) }, { label: 'Rename', run: () => this.renaming.set(t.id) }] : []),
        isArchived
          ? { label: `Unarchive${n}`, separator: one, run: () => this.unarchive(ids) }
          : { label: `Archive${n}`, separator: one, run: () => this.archive(ids) },
        { label: `Delete${n}…`, danger: true, run: () => this.askDelete(ids) },
      ];
    }
    if (t.kind === 'project') {
      const p = this.projects().find((x) => x.id === t.id);
      const listed = this.listed(t.id).map((x) => x.id);
      return [
        { label: 'New Session', run: () => this.newSession(t.id) },
        ...(p?.folderMissing ? [{ label: 'Locate folder…', run: () => this.locate(t.id) }] : []),
        { label: 'Rename', separator: true, run: () => this.note(`rename project ${t.id} (inline)`) },
        { label: 'Project settings', run: () => this.note(`project settings sheet for ${t.id}`) },
        ...(listed.length > 0
          ? [{ label: `Archive all (${listed.length})`, separator: true, run: () => this.archive(listed) }]
          : []),
        { label: 'Remove Project', danger: true, run: () => this.note(`remove ${t.id} (forget, Sessions kept)`) },
      ];
    }
    const arch = this.archived(t.id).map((x) => x.id);
    return [
      { label: `Unarchive all (${arch.length})`, run: () => this.unarchive(arch) },
      { label: `Delete all (${arch.length})…`, danger: true, run: () => this.askDelete(arch) },
    ];
  });

  archive(ids: readonly string[]): void {
    const set = new Set(ids);
    const before = this.sessions();
    this.sessions.update((l) => l.map((x) => (set.has(x.id) ? { ...x, archivedAt: NOW, attention: null } : x)));
    this.clearSelection();
    this.showToast(ids.length === 1 ? 'Session archived' : `${ids.length} Sessions archived`, () =>
      this.sessions.set(before),
    );
    this.note(`archive ${ids.join(',')}`);
  }

  unarchive(ids: readonly string[]): void {
    const set = new Set(ids);
    this.sessions.update((l) => l.map((x) => (set.has(x.id) ? { ...x, archivedAt: null } : x)));
    this.clearSelection();
    this.note(`unarchive ${ids.join(',')}`);
  }

  askDelete(ids: readonly string[]): void {
    const text =
      ids.length === 1
        ? `Delete “${this.sessions().find((x) => x.id === ids[0])?.title}”? Its Transcript is gone for good.`
        : `Delete ${ids.length} Sessions? Their Transcripts are gone for good.`;
    this.confirm.set({
      text,
      ok: () => {
        const set = new Set(ids);
        this.sessions.update((l) => l.filter((x) => !set.has(x.id)));
        if (set.has(this.activeId() ?? '')) this.activeId.set(null);
        this.clearSelection();
        this.note(`delete ${ids.join(',')}`);
      },
    });
  }

  rename(id: string, title: string): void {
    const t = title.trim();
    if (t !== '') this.sessions.update((l) => l.map((x) => (x.id === id ? { ...x, title: t } : x)));
    this.renaming.set(null);
  }

  private locate(id: string): void {
    this.projects.update((l) => l.map((p) => (p.id === id ? { ...p, folderMissing: false, path: 'C:\\Users\\me\\blog' } : p)));
    this.note(`located ${id}`);
  }

  private showToast(text: string, undo?: () => void): void {
    clearTimeout(this.toastTimer);
    this.toast.set({ text, undo });
    this.toastTimer = setTimeout(() => this.toast.set(null), 6000);
  }
}
