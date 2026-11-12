// PROTOTYPE (throwaway, branch prototype/fonts): which family should replace Manrope as `font-sans`?
// The same calm Session view (Tab strip, sidebar, thread, Composer) in four families, switchable via
// `?variant=A|B|C|D`, plus `?variant=E` with all four side by side. JetBrains Mono stays for code.
// `?size=15|16|17` sets the root font size (all Tailwind sizes are rem), to even out x-height differences.
// Run: `npm run prototype:fonts`. ← / → cycle variants.
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  isDevMode,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';

const FONTS = [
  { key: 'A', label: 'Manrope (now)', family: "'Manrope Variable'" },
  { key: 'B', label: 'Instrument Sans', family: "'Instrument Sans Variable'" },
  { key: 'C', label: 'Source Sans 3', family: "'Source Sans 3 Variable'" },
  {
    key: 'D',
    label: 'Atkinson Hyperlegible Next',
    family: "'Atkinson Hyperlegible Next Variable'",
  },
] as const;
const VARIANTS = [...FONTS, { key: 'E', label: 'All four, side by side', family: '' }] as const;
const SIZES = ['15', '16', '17'] as const;
const FALLBACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

const tabs = [
  { title: 'Fix the flaky reconnect test in the RPC client', active: false },
  { title: 'Sidebar grouping by day', active: true },
  {
    title: 'Why does the install log open twice on Windows when the Agent is missing?',
    active: false,
  },
];

const groups = [
  {
    label: 'Today',
    rows: [
      { title: 'Sidebar grouping by day', meta: 'active 2m · open in a Tab', current: true },
      { title: 'Fix the flaky reconnect test', meta: 'active 1h · open in a Tab' },
    ],
  },
  { label: 'Yesterday', rows: [{ title: 'Settings dialog: Theme toggle', meta: 'active 1d' }] },
  {
    label: 'Previous 7 days',
    rows: [
      { title: 'Transcript store batching', meta: 'active 3d' },
      { title: 'Rename AcpSessionId and brand it', meta: 'active 5d' },
      { title: 'Install log for Agents (1,284 lines)', meta: 'active 6d' },
    ],
  },
  { label: 'October 2026', rows: [{ title: 'Spike: MessagePort RPC', meta: 'active 31 Oct' }] },
];

/** The calm Session view, in whatever `font-sans` the host sets. Static, read-only. */
@Component({
  selector: 'proto-session-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 min-w-0 flex-1 bg-background text-foreground' },
  template: `
    @if (!compact()) {
      <aside class="bg-sidebar border-sidebar-border flex w-[272px] shrink-0 flex-col border-r">
        <button
          type="button"
          class="hover:bg-sidebar-accent m-2 flex flex-col items-start rounded-lg px-2.5 py-2 text-left"
        >
          <span class="flex w-full items-center gap-1 text-sm font-semibold"
            >spence <span class="text-muted-foreground ml-auto text-xs">▾</span></span
          >
          <span class="text-muted-foreground font-mono text-xs"
            >C:\\Users\\miuso\\workspace\\nxy\\spence</span
          >
        </button>
        <div class="flex items-center gap-1 px-2">
          <button
            type="button"
            class="hover:bg-sidebar-accent flex h-8 flex-1 items-center gap-2 rounded-md px-2.5 text-sm font-medium"
          >
            ＋ New Session
          </button>
          <button
            type="button"
            class="hover:bg-sidebar-accent text-muted-foreground flex size-8 items-center justify-center rounded-md text-sm"
            aria-label="Search"
          >
            ⌕
          </button>
        </div>
        <nav class="mt-2 flex-1 overflow-auto px-2 pb-3">
          <div class="mb-1 rounded-md px-2.5 py-1.5">
            <div class="text-sm italic">New Session</div>
          </div>
          @for (g of groups; track g.label) {
            <div class="text-muted-foreground mt-3 mb-1 px-2.5 text-xs font-medium">
              {{ g.label }}
            </div>
            @for (r of g.rows; track r.title) {
              <div class="rounded-md px-2.5 py-1.5" [class.bg-sidebar-accent]="r.current">
                <div class="truncate text-sm" [class.font-medium]="r.current">{{ r.title }}</div>
                <div class="text-muted-foreground truncate text-xs tabular-nums">{{ r.meta }}</div>
              </div>
            }
          }
          <p class="font-display text-muted-foreground mt-8 px-2.5 text-xl">
            No Sessions in docs yet.
          </p>
        </nav>
        <div class="border-sidebar-border flex items-center border-t p-2">
          <button
            type="button"
            class="hover:bg-sidebar-accent text-muted-foreground flex size-8 items-center justify-center rounded-md"
            aria-label="Settings"
          >
            ⚙
          </button>
        </div>
      </aside>
    }
    <section class="flex min-w-0 flex-1 flex-col">
      @if (!compact()) {
        <div class="border-border flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b px-2">
          @for (t of tabs; track t.title) {
            <div
              class="flex h-8 max-w-[220px] items-center gap-2 rounded-t-md px-3 text-sm"
              [class.bg-muted]="t.active"
              [class.text-muted-foreground]="!t.active"
              [title]="t.title"
            >
              <span class="truncate">{{ t.title }}</span
              ><span class="text-muted-foreground text-xs">×</span>
            </div>
          }
        </div>
      }
      <div class="flex-1 overflow-auto">
        <div class="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-8">
          <div class="bg-muted ml-auto max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-6">
            Group the Sessions in the sidebar by day — Today, Yesterday, Previous 7 days — and keep
            the draft on top. Can you check how
            <code class="font-mono text-xs">Session.list</code> sorts them?
          </div>
          <div class="flex flex-col gap-3 text-sm leading-6">
            <p class="m-0">
              <code class="bg-muted rounded px-1 py-0.5 font-mono text-xs">Session.list</code>
              returns Sessions sorted by
              <code class="bg-muted rounded px-1 py-0.5 font-mono text-xs">lastActivityAt</code>,
              newest first, so grouping is a single pass: compare each date with the start of today
              in local time and drop it into the first bucket it fits.
            </p>
            <p class="m-0">
              I added the grouping as a pure function so the spec can pin the clock:
            </p>
            <pre
              class="bg-muted m-0 overflow-auto rounded-lg p-3 font-mono text-xs leading-5"
            ><code>export const groupByDay = (sessions: ReadonlyArray&lt;SessionSummary&gt;, now: Date) =&gt;
  sessions.reduce((groups, s) =&gt; {{ '{' }}
    const key = bucketOf(s.lastActivityAt, now); // 'today' | 'yesterday' | ...
    (groups[key] ??= []).push(s);
    return groups;
  {{ '}' }}, {{ '{' }}{{ '}' }} as Record&lt;Bucket, SessionSummary[]&gt;);</code></pre>
            <p class="m-0">
              Three things to decide. Should a Session from 11:58 pm yesterday land in
              <em>Yesterday</em> even if it was active two minutes ago in another time zone? Should
              the month groups read “October 2026” or “Oct 2026”? And is 30 days the right cut for
              the last relative group? Files:
              <span class="font-mono text-xs">src/app/features/sidebar/group-by-day.ts</span>, 12
              tests, <span class="tabular-nums">+148 −0</span>, took 0:41.
            </p>
            <p class="text-muted-foreground m-0 text-xs tabular-nums">
              Done · 3 Steps · 1,284 tokens · Il1 | 0O | rn m | 10:11
            </p>
          </div>
        </div>
      </div>
      <div class="mx-auto w-full max-w-[720px] px-6 pb-5">
        <div class="border-input rounded-2xl border p-3 shadow-sm">
          <div class="text-muted-foreground min-h-12 text-sm">Ask Claude to change something…</div>
          <div class="flex items-center gap-2">
            <span class="text-muted-foreground text-xs">Sonnet · Effort medium</span>
            <span class="text-muted-foreground ml-auto font-mono text-xs">⏎</span>
            <button
              type="button"
              class="bg-primary text-primary-foreground h-8 rounded-full px-4 text-sm font-medium"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </section>
  `,
})
class ProtoSessionView {
  readonly compact = input(false);
  protected readonly groups = groups;
  protected readonly tabs = tabs;
}

@Component({
  selector: 'app-fonts-prototype',
  imports: [ProtoSessionView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'fixed inset-0 z-40 flex bg-background', '(window:keydown)': 'onKey($event)' },
  template: `
    @if (variant() === 'E') {
      <div class="grid flex-1 grid-cols-2 grid-rows-2 overflow-hidden">
        @for (f of fonts; track f.key) {
          <div
            class="border-border relative flex min-h-0 overflow-hidden border"
            [style]="fontStyle(f.family)"
          >
            <span
              class="absolute top-2 right-3 z-10 rounded bg-black px-2 py-0.5 font-sans text-[11px] text-white"
              >{{ f.key }} · {{ f.label }}</span
            >
            <proto-session-view [compact]="true" />
          </div>
        }
      </div>
    } @else {
      <div class="flex min-w-0 flex-1" [style]="fontStyle(current().family)">
        <proto-session-view />
      </div>
    }

    @if (showSwitcher) {
      <div
        class="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black px-1.5 py-1.5 text-[12px] text-white shadow-2xl ring-2 ring-fuchsia-500"
        style="font-family: system-ui"
        role="toolbar"
        aria-label="Prototype switcher"
      >
        <button
          type="button"
          class="flex size-7 items-center justify-center rounded-full hover:bg-white/15"
          aria-label="Previous variant"
          (click)="cycle(-1)"
        >
          ←
        </button>
        <span class="min-w-[220px] text-center font-medium"
          >{{ current().key }} · {{ current().label }}</span
        >
        <button
          type="button"
          class="flex size-7 items-center justify-center rounded-full hover:bg-white/15"
          aria-label="Next variant"
          (click)="cycle(1)"
        >
          →
        </button>
        <span class="mx-1 h-4 w-px bg-white/25"></span>
        @for (s of sizes; track s) {
          <button
            type="button"
            class="h-7 rounded-full px-2.5 hover:bg-white/15"
            [class.bg-white/25]="size() === s"
            (click)="setParam('size', s)"
          >
            {{ s }}px
          </button>
        }
      </div>
    }
  `,
})
export class FontsPrototype {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  protected readonly showSwitcher = isDevMode();
  protected readonly fonts = FONTS;
  protected readonly sizes = SIZES;

  protected readonly current = computed(() => {
    const v = this.params()?.get('variant')?.toUpperCase();
    return VARIANTS.find((x) => x.key === v) ?? VARIANTS[0];
  });
  protected readonly variant = computed(() => this.current().key);
  protected readonly size = computed(() => {
    const s = this.params()?.get('size');
    return SIZES.find((x) => x === s) ?? '16';
  });

  constructor() {
    const root = document.documentElement;
    effect(() => {
      root.style.fontSize = `${this.size()}px`;
    });
    inject(DestroyRef).onDestroy(() => root.style.removeProperty('font-size'));
  }

  protected fontStyle(family: string): string {
    return `--font-sans: ${family}, ${FALLBACK}; font-family: var(--font-sans);`;
  }

  protected cycle(dir: 1 | -1): void {
    const i = VARIANTS.findIndex((v) => v.key === this.variant());
    const next = VARIANTS[(i + dir + VARIANTS.length) % VARIANTS.length];
    if (next) this.setParam('variant', next.key);
  }

  protected setParam(key: string, value: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { [key]: value },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected onKey(ev: KeyboardEvent): void {
    const t = ev.target;
    if (
      t instanceof HTMLElement &&
      (t.tagName === 'TEXTAREA' ||
        t.tagName === 'INPUT' ||
        t.tagName === 'SELECT' ||
        t.isContentEditable)
    )
      return;
    if (ev.key === 'ArrowLeft') this.cycle(-1);
    if (ev.key === 'ArrowRight') this.cycle(1);
  }
}
