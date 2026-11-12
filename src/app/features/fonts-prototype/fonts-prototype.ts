// PROTOTYPE (throwaway, branch prototype/fonts): which `font-sans` and which "voice" (the rare title face that
// replaces Reckless) give Spence a calm, no-noise personality?
// ← / → cycle curated pairings (`?combo=1..8`); the bar's selects mix any sans with any voice (`?sans=`, `?voice=`).
// `?screen=thread|quiet|settings` picks the screen: the thread is mostly sans, quiet and settings show the voice.
// `?compare=1` shows the three sans side by side. `?size=15|16|17` sets the root size (Tailwind sizes are rem).
// Round 3: `?mono=` swaps the code font (↑ / ↓ cycle it), `?compare=mono` shows all five side by side. Run: `npm run prototype:fonts`.
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

const FALLBACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

const SANS = [
  { key: 'instrument', label: 'Instrument Sans', family: "'Instrument Sans Variable'" },
  { key: 'jakarta', label: 'Plus Jakarta Sans', family: "'Plus Jakarta Sans Variable'" },
  { key: 'inclusive', label: 'Inclusive Sans', family: "'Inclusive Sans Variable'" },
] as const;
type SansKey = (typeof SANS)[number]['key'];

/** A voice is a family plus how it is set: weight, tracking and axes matter more than the family. */
const VOICES = [
  {
    key: 'same',
    label: 'Same as sans, 500, tight',
    family: 'var(--font-sans)',
    css: 'font-weight: 500; letter-spacing: -0.025em;',
  },
  {
    key: 'same-light',
    label: 'Same as sans, 300, large',
    family: 'var(--font-sans)',
    css: 'font-weight: 300; letter-spacing: -0.03em;',
  },
  {
    key: 'instrument',
    label: 'Instrument Sans, 500, tight',
    family: "'Instrument Sans Variable'",
    css: 'font-weight: 500; letter-spacing: -0.025em;',
  },
  {
    key: 'iserif',
    label: 'Instrument Serif',
    family: "'Instrument Serif', Georgia, serif",
    css: 'font-weight: 400; letter-spacing: -0.01em;',
  },
  {
    key: 'iserif-italic',
    label: 'Instrument Serif italic',
    family: "'Instrument Serif', Georgia, serif",
    css: 'font-weight: 400; font-style: italic;',
  },
  {
    key: 'newsreader',
    label: 'Newsreader (opsz)',
    family: "'Newsreader Variable', Georgia, serif",
    css: 'font-weight: 400; font-optical-sizing: auto; letter-spacing: -0.015em;',
  },
  {
    key: 'fraunces',
    label: 'Fraunces, soft, no wonk',
    family: "'Fraunces Variable', Georgia, serif",
    css: "font-weight: 350; font-variation-settings: 'SOFT' 100, 'WONK' 0; letter-spacing: -0.015em;",
  },
  {
    key: 'mono',
    label: 'JetBrains Mono, 300',
    family: "'JetBrains Mono Variable', monospace",
    css: 'font-weight: 300; letter-spacing: -0.02em;',
  },
] as const;
type VoiceKey = (typeof VOICES)[number]['key'];

const COMBOS: ReadonlyArray<{ name: string; why: string; sans: SansKey; voice: VoiceKey }> = [
  {
    name: 'One family',
    why: 'No second face at all; hierarchy only from size and weight.',
    sans: 'instrument',
    voice: 'same',
  },
  {
    name: 'One family, whisper',
    why: 'Titles go lighter, not bolder: big and thin reads as quiet.',
    sans: 'instrument',
    voice: 'same-light',
  },
  {
    name: 'Siblings',
    why: 'Instrument Serif was drawn to sit next to Instrument Sans.',
    sans: 'instrument',
    voice: 'iserif',
  },
  {
    name: 'Siblings, italic',
    why: 'The serif only in italic: a soft aside, never a headline.',
    sans: 'instrument',
    voice: 'iserif-italic',
  },
  {
    name: 'Reading room',
    why: 'Newsreader is a text serif built for screens; calm, not decorative.',
    sans: 'instrument',
    voice: 'newsreader',
  },
  {
    name: 'Soft voice',
    why: 'Fraunces with its quirks turned off: rounded, warm, slow.',
    sans: 'jakarta',
    voice: 'fraunces',
  },
  {
    name: 'Warm body, crisp heads',
    why: 'Inclusive Sans for reading, Instrument Sans for the few titles.',
    sans: 'inclusive',
    voice: 'instrument',
  },
  {
    name: 'Terminal calm',
    why: 'The voice is the mono, light: fits an app about Agents and code.',
    sans: 'instrument',
    voice: 'mono',
  },
];

/** Round 3: the mono under "One family, whisper". JetBrains Mono is the reference. */
const MONOS = [
  { key: 'jetbrains', label: 'JetBrains Mono (now)', family: "'JetBrains Mono Variable'" },
  { key: 'fragment', label: 'Fragment Mono', family: "'Fragment Mono'" },
  { key: 'commit', label: 'Commit Mono', family: "'Commit Mono'" },
  { key: 'dm', label: 'DM Mono', family: "'DM Mono'" },
  { key: 'geist', label: 'Geist Mono', family: "'Geist Mono Variable'" },
] as const;
const MONO_FALLBACK = "ui-monospace, 'Cascadia Mono', Consolas, monospace";

const SCREENS = ['thread', 'quiet', 'settings'] as const;
type Screen = (typeof SCREENS)[number];
const SIZES = ['15', '16', '17'] as const;

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

/** The calm Session view, in whatever `--font-sans` the host sets. Static, read-only. */
@Component({
  selector: 'proto-session-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'relative flex min-h-0 min-w-0 flex-1 bg-background text-foreground' },
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
          @if (screen() !== 'quiet') {
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
                  <div class="text-muted-foreground truncate text-xs tabular-nums">
                    {{ r.meta }}
                  </div>
                </div>
              }
            }
          }
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
      @if (!compact() && screen() !== 'quiet') {
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
      @if (screen() === 'quiet') {
        <div class="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <h2 class="m-0 text-4xl" [style]="voice()">No Sessions in spence yet.</h2>
          <p class="text-muted-foreground m-0 max-w-sm text-sm leading-6">
            Start one and Claude works in
            <span class="font-mono text-xs">C:\\Users\\miuso\\workspace\\nxy\\spence</span>. Nothing
            runs until you send the first Message.
          </p>
          <button
            type="button"
            class="bg-primary text-primary-foreground mt-2 h-9 rounded-full px-5 text-sm font-medium"
          >
            New Session
          </button>
          <p class="text-muted-foreground mt-10 m-0 text-xl" [style]="voice()">
            Or pick up where you left off.
          </p>
        </div>
      } @else {
        <div class="flex-1 overflow-auto">
          <div class="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-8">
            <div class="bg-muted ml-auto max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-6">
              Group the Sessions in the sidebar by day — Today, Yesterday, Previous 7 days — and
              keep the draft on top. Can you check how
              <code class="font-mono text-xs">Session.list</code> sorts them?
            </div>
            <div class="flex flex-col gap-3 text-sm leading-6">
              <p class="m-0">
                <code class="bg-muted rounded px-1 py-0.5 font-mono text-xs">Session.list</code>
                returns Sessions sorted by
                <code class="bg-muted rounded px-1 py-0.5 font-mono text-xs">lastActivityAt</code>,
                newest first, so grouping is a single pass: compare each date with the start of
                today in local time and drop it into the first bucket it fits.
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
                <em>Yesterday</em> even if it was active two minutes ago in another time zone?
                Should the month groups read “October 2026” or “Oct 2026”? And is 30 days the right
                cut for the last relative group? Files:
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
            <div class="text-muted-foreground min-h-12 text-sm">
              Ask Claude to change something…
            </div>
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
      }
    </section>

    @if (screen() === 'settings' && !compact()) {
      <div class="absolute inset-0 flex items-center justify-center bg-black/40">
        <div
          class="bg-background flex max-h-[85%] w-[560px] flex-col gap-5 overflow-auto rounded-xl p-6 shadow-2xl"
        >
          <div class="flex items-center">
            <h2 class="m-0 text-2xl" [style]="voice()">Settings</h2>
            <span class="text-muted-foreground ml-auto text-sm">×</span>
          </div>
          @for (g of settings; track g.title) {
            <div class="flex flex-col gap-3">
              <div class="text-sm font-semibold">{{ g.title }}</div>
              <div class="bg-border h-px"></div>
              @for (r of g.rows; track r.label) {
                <div class="flex items-center gap-4">
                  <div class="flex flex-col">
                    <span class="text-sm">{{ r.label }}</span>
                    @if (r.hint) {
                      <span class="text-muted-foreground text-xs">{{ r.hint }}</span>
                    }
                  </div>
                  <span class="border-input ml-auto rounded-md border px-2.5 py-1 text-sm">{{
                    r.value
                  }}</span>
                </div>
              }
            </div>
          }
        </div>
      </div>
    }
  `,
})
class ProtoSessionView {
  readonly compact = input(false);
  readonly screen = input<Screen>('thread');
  readonly voice = input('');
  protected readonly groups = groups;
  protected readonly tabs = tabs;
  protected readonly settings = [
    {
      title: 'General',
      rows: [
        { label: 'Language', value: 'System default', hint: '' },
        { label: 'Theme', value: 'System · Light · Dark', hint: '' },
        { label: 'Notifications', value: 'On', hint: 'Notify me when a Session needs me' },
        { label: 'Project order', value: 'Last used, newest first', hint: '' },
      ],
    },
    {
      title: 'Sessions',
      rows: [
        { label: 'Default permission mode', value: 'Ask', hint: '' },
        { label: 'Auto-archive', value: 'After 30 days', hint: '' },
      ],
    },
    {
      title: 'Agents',
      rows: [
        { label: 'Claude', value: 'Model: Last used', hint: 'Start a Session to see its Models' },
      ],
    },
  ];
}

@Component({
  selector: 'app-fonts-prototype',
  imports: [ProtoSessionView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'fixed inset-0 z-40 flex bg-background', '(window:keydown)': 'onKey($event)' },
  template: `
    @if (compare()) {
      <div class="grid flex-1 grid-cols-3 overflow-hidden">
        @for (s of sans; track s.key) {
          <div
            class="border-border relative flex min-h-0 overflow-hidden border"
            [style]="sansStyle(s.family)"
          >
            <span
              class="absolute top-2 right-3 z-10 rounded bg-black px-2 py-0.5 text-[11px] text-white"
              style="font-family: system-ui"
              >{{ s.label }}</span
            >
            <proto-session-view
              [compact]="true"
              [screen]="screen() === 'quiet' ? 'quiet' : 'thread'"
              [voice]="voiceStyle()"
            />
          </div>
        }
      </div>
    } @else if (compareMono()) {
      <div class="grid flex-1 grid-cols-3 grid-rows-2 overflow-hidden">
        @for (m of monos; track m.key) {
          <div
            class="border-border relative flex min-h-0 overflow-hidden border"
            [style]="sansStyle(currentSans().family, m.family)"
          >
            <span
              class="absolute top-2 right-3 z-10 rounded bg-black px-2 py-0.5 text-[11px] text-white"
              style="font-family: system-ui"
              >{{ m.label }}</span
            >
            <proto-session-view [compact]="true" screen="thread" [voice]="voiceStyle()" />
          </div>
        }
      </div>
    } @else {
      <div class="flex min-w-0 flex-1" [style]="sansStyle(currentSans().family)">
        <proto-session-view [screen]="screen()" [voice]="voiceStyle()" />
      </div>
    }

    @if (showSwitcher) {
      <div
        class="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-1"
        style="font-family: system-ui"
      >
        <div class="rounded-full bg-black/85 px-3 py-1 text-[11px] text-white/80">
          {{ comboWhy() }} · mono: {{ currentMono().label }}
        </div>
        <div
          class="flex max-w-[96vw] flex-wrap items-center justify-center gap-1 rounded-3xl bg-black px-1.5 py-1.5 text-[12px] whitespace-nowrap text-white shadow-2xl ring-2 ring-fuchsia-500"
          role="toolbar"
          aria-label="Prototype switcher"
        >
          <button
            type="button"
            class="flex size-7 items-center justify-center rounded-full hover:bg-white/15"
            aria-label="Previous pairing"
            (click)="cycle(-1)"
          >
            ←
          </button>
          <span class="min-w-[170px] text-center font-medium">{{ comboLabel() }}</span>
          <button
            type="button"
            class="flex size-7 items-center justify-center rounded-full hover:bg-white/15"
            aria-label="Next pairing"
            (click)="cycle(1)"
          >
            →
          </button>
          <span class="mx-1 h-4 w-px bg-white/25"></span>
          <select
            class="h-7 rounded-full bg-white/10 px-2 outline-none"
            aria-label="Sans"
            [value]="currentSans().key"
            (change)="mix('sans', $any($event.target).value)"
          >
            @for (s of sans; track s.key) {
              <option [value]="s.key" [selected]="s.key === currentSans().key" class="text-black">
                {{ s.label }}
              </option>
            }
          </select>
          <select
            class="h-7 rounded-full bg-white/10 px-2 outline-none"
            aria-label="Voice"
            [value]="currentVoice().key"
            (change)="mix('voice', $any($event.target).value)"
          >
            @for (v of voices; track v.key) {
              <option [value]="v.key" [selected]="v.key === currentVoice().key" class="text-black">
                Voice: {{ v.label }}
              </option>
            }
          </select>
          <select
            class="h-7 rounded-full bg-white/10 px-2 outline-none"
            aria-label="Mono"
            [value]="currentMono().key"
            (change)="setParams({ mono: $any($event.target).value })"
          >
            @for (m of monos; track m.key) {
              <option [value]="m.key" [selected]="m.key === currentMono().key" class="text-black">
                Mono: {{ m.label }}
              </option>
            }
          </select>
          <span class="mx-1 h-4 w-px bg-white/25"></span>
          @for (s of screens; track s) {
            <button
              type="button"
              class="h-7 rounded-full px-2.5 capitalize hover:bg-white/15"
              [class.bg-white/25]="screen() === s"
              (click)="setParams({ screen: s })"
            >
              {{ s }}
            </button>
          }
          <button
            type="button"
            class="h-7 rounded-full px-2.5 hover:bg-white/15"
            [class.bg-white/25]="compare()"
            (click)="setParams({ compare: compare() ? null : '1' })"
          >
            Compare sans
          </button>
          <button
            type="button"
            class="h-7 rounded-full px-2.5 hover:bg-white/15"
            [class.bg-white/25]="compareMono()"
            (click)="setParams({ compare: compareMono() ? null : 'mono' })"
          >
            Compare mono
          </button>
          <span class="mx-1 h-4 w-px bg-white/25"></span>
          @for (s of sizes; track s) {
            <button
              type="button"
              class="h-7 rounded-full px-2 hover:bg-white/15"
              [class.bg-white/25]="size() === s"
              (click)="setParams({ size: s })"
            >
              {{ s }}
            </button>
          }
        </div>
      </div>
    }
  `,
})
export class FontsPrototype {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap);
  protected readonly showSwitcher = isDevMode();
  protected readonly sans = SANS;
  protected readonly voices = VOICES;
  protected readonly screens = SCREENS;
  protected readonly sizes = SIZES;

  /** A combo wins unless the bar's selects set a custom mix (`?sans=` / `?voice=`, no `combo`). */
  private readonly combo = computed(() => {
    const p = this.params();
    if (!p?.has('combo') && (p?.has('sans') || p?.has('voice'))) return undefined;
    return COMBOS[Number(p?.get('combo') ?? '2') - 1] ?? COMBOS[0];
  });
  protected readonly currentSans = computed(() => {
    const key = this.combo()?.sans ?? this.params()?.get('sans');
    return SANS.find((s) => s.key === key) ?? SANS[0];
  });
  protected readonly currentVoice = computed(() => {
    const key = this.combo()?.voice ?? this.params()?.get('voice');
    return VOICES.find((v) => v.key === key) ?? VOICES[0];
  });
  protected readonly comboLabel = computed(() => {
    const c = this.combo();
    return c ? `${COMBOS.indexOf(c) + 1}/${COMBOS.length} · ${c.name}` : 'Custom mix';
  });
  protected readonly comboWhy = computed(
    () =>
      `${this.combo()?.why ?? 'Your mix.'}  —  ${this.currentSans().label} + voice: ${this.currentVoice().label}`,
  );
  protected readonly voiceStyle = computed(
    () => `font-family: ${this.currentVoice().family}; ${this.currentVoice().css}`,
  );
  protected readonly screen = computed<Screen>(
    () => SCREENS.find((s) => s === this.params()?.get('screen')) ?? 'thread',
  );
  protected readonly compare = computed(() => this.params()?.get('compare') === '1');
  protected readonly compareMono = computed(() => this.params()?.get('compare') === 'mono');
  protected readonly monos = MONOS;
  protected readonly currentMono = computed(
    () => MONOS.find((m) => m.key === this.params()?.get('mono')) ?? MONOS[1],
  );
  protected readonly size = computed(
    () => SIZES.find((x) => x === this.params()?.get('size')) ?? '16',
  );

  constructor() {
    const root = document.documentElement;
    effect(() => {
      root.style.fontSize = `${this.size()}px`;
    });
    inject(DestroyRef).onDestroy(() => root.style.removeProperty('font-size'));
  }

  protected sansStyle(family: string, mono: string = this.currentMono().family): string {
    return `--font-sans: ${family}, ${FALLBACK}; --font-mono: ${mono}, ${MONO_FALLBACK}; --default-mono-font-family: var(--font-mono); font-family: var(--font-sans);`;
  }

  protected cycle(dir: 1 | -1): void {
    const c = this.combo();
    const i = c ? COMBOS.indexOf(c) : -1;
    const next = (i + dir + COMBOS.length) % COMBOS.length;
    this.setParams({ combo: String(next + 1), sans: null, voice: null });
  }

  protected mix(key: 'sans' | 'voice', value: string): void {
    this.setParams({
      combo: null,
      sans: this.currentSans().key,
      voice: this.currentVoice().key,
      [key]: value,
    });
  }

  protected setParams(queryParams: Record<string, string | null>): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
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
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      const i = MONOS.indexOf(this.currentMono());
      const next = MONOS[(i + (ev.key === 'ArrowDown' ? 1 : -1) + MONOS.length) % MONOS.length];
      if (next) this.setParams({ mono: next.key });
    }
  }
}
