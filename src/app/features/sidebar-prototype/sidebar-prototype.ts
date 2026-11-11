// PROTOTYPE (throwaway, branch prototype/project-sidebar): "Sidebar inside a Project" (issue #19).
// Three sidebars, switchable via `?variant=A|B|C`, over in-memory data picked with `?scenario=` and Session
// order picked with `?order=activity|created`. The shell swaps its real sidebar for `ProtoSidebar` while
// the route is #/prototype/sidebar; this route component is the main area plus the switcher bar.
// Run: `npm run prototype:sidebar`. Ctrl/Cmd-click and Shift-click select; right-click opens the menu.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  isDevMode,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import { SidebarProto, scenarios } from './proto-model';
import type { Order } from './proto-model';
import { ProtoOverlays } from './proto-shared';
import { VariantA } from './variant-a-tree';
import { VariantB } from './variant-b-recent';
import { VariantC } from './variant-c-focus';

const VARIANTS = [
  { key: 'A', label: VariantA.label },
  { key: 'B', label: VariantB.label },
  { key: 'C', label: VariantC.label },
] as const;

function readParams() {
  const route = inject(ActivatedRoute);
  return toSignal(route.queryParamMap.pipe(map((p) => p)));
}

/** Mounted by the shell in place of its real sidebar while the prototype route is open. */
@Component({
  selector: 'proto-sidebar',
  imports: [VariantA, VariantB, VariantC, ProtoOverlays],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (variant()) {
      @case ('B') { <proto-variant-b /> }
      @case ('C') { <proto-variant-c /> }
      @default { <proto-variant-a /> }
    }
    <proto-overlays />
  `,
})
export class ProtoSidebar {
  private readonly router = inject(Router);
  private readonly url = toSignal(this.router.events.pipe(map(() => this.router.url)), { initialValue: this.router.url });
  protected readonly variant = computed(() => {
    const v = new URLSearchParams(this.url().split('?')[1] ?? '').get('variant')?.toUpperCase();
    return VARIANTS.some((x) => x.key === v) ? (v as string) : 'A';
  });
}

@Component({
  selector: 'app-sidebar-prototype',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex flex-col h-[calc(100svh-3rem-3rem)] -m-6 bg-background',
    '(window:keydown)': 'onKey($event)',
  },
  template: `
    <div class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      @if (proto.draft(); as d) {
        <p class="text-muted-foreground m-0 text-xs tracking-wide uppercase">{{ d.projectId }} · draft</p>
        <h2 class="m-0 text-xl font-semibold">New Session</h2>
        <p class="text-muted-foreground m-0 max-w-sm text-sm">A draft has a Tab but is not listed until its first Message.</p>
        <button type="button" class="bg-primary text-primary-foreground h-9 rounded-full px-4 text-sm" (click)="proto.sendDraft()">Send first Message</button>
      } @else if (proto.active(); as s) {
        <p class="text-muted-foreground m-0 text-xs tracking-wide uppercase">{{ s.projectId }}</p>
        <h2 class="m-0 text-xl font-semibold">{{ s.title }}</h2>
        <p class="text-muted-foreground m-0 text-sm">The Session view would be here.</p>
      } @else {
        <p class="text-muted-foreground m-0 text-sm">No Session open.</p>
      }
    </div>

    @if (showSwitcher) {
      @if (showState()) {
        <pre class="bg-foreground text-background fixed top-4 right-4 bottom-20 z-50 m-0 w-[380px] overflow-auto rounded-xl p-3 font-mono text-[11px] leading-4 opacity-95">{{ stateJson() }}</pre>
      }
      <div class="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black px-1.5 py-1.5 text-[12px] text-white shadow-2xl ring-2 ring-fuchsia-500" role="toolbar" aria-label="Prototype switcher">
        <button type="button" class="flex size-7 items-center justify-center rounded-full hover:bg-white/15" aria-label="Previous variant" (click)="cycle(-1)">←</button>
        <span class="min-w-[180px] text-center font-medium">{{ variant() }} · {{ variantLabel() }}</span>
        <button type="button" class="flex size-7 items-center justify-center rounded-full hover:bg-white/15" aria-label="Next variant" (click)="cycle(1)">→</button>
        <span class="mx-1 h-4 w-px bg-white/25"></span>
        <select class="h-7 rounded-full bg-white/10 px-2 outline-none" aria-label="Scenario" [value]="scenario().id" (change)="setParam('scenario', $any($event.target).value)">
          @for (sc of scenarios; track sc.id) {
            <option [value]="sc.id" class="text-black">{{ sc.label }}</option>
          }
        </select>
        <select class="h-7 rounded-full bg-white/10 px-2 outline-none" aria-label="Session order" [value]="proto.order()" (change)="setParam('order', $any($event.target).value)">
          <option value="activity" class="text-black">Order: last activity</option>
          <option value="created" class="text-black">Order: created</option>
        </select>
        <button type="button" class="h-7 rounded-full px-2.5 whitespace-nowrap hover:bg-white/15" (click)="reload()" title="Reset the scenario">↺ Reset</button>
        <button type="button" class="h-7 rounded-full px-2.5 whitespace-nowrap hover:bg-white/15" [class.bg-white/20]="showState()" (click)="showState.set(!showState())">State</button>
        <span class="group relative ml-0.5 flex size-7 cursor-help items-center justify-center rounded-full hover:bg-white/15" tabindex="0" aria-label="About this scenario">
          ?
          <span class="pointer-events-none absolute right-0 bottom-9 hidden w-72 rounded-lg bg-black p-2.5 text-left leading-4 group-hover:block group-focus:block">
            {{ scenario().hint }} Ctrl-click / Shift-click to select, right-click for actions, Esc clears.
          </span>
        </span>
      </div>
    }
  `,
})
export class SidebarPrototype {
  protected readonly proto = inject(SidebarProto);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly showSwitcher = isDevMode();
  protected readonly scenarios = scenarios;
  protected readonly showState = signal(false);
  private readonly params = readParams();

  protected readonly variant = computed(() => {
    const v = this.params()?.get('variant')?.toUpperCase();
    return VARIANTS.some((x) => x.key === v) ? (v as string) : 'A';
  });
  protected readonly variantLabel = computed(() => VARIANTS.find((v) => v.key === this.variant())?.label ?? '');
  protected readonly scenario = computed(() => {
    const id = this.params()?.get('scenario');
    return scenarios.find((s) => s.id === id) ?? scenarios[0]!;
  });
  protected readonly stateJson = computed(() =>
    JSON.stringify(
      {
        variant: this.variant(),
        scenario: this.scenario().id,
        order: this.proto.order(),
        query: this.proto.query(),
        activeId: this.proto.activeId(),
        draft: this.proto.draft(),
        selection: [...this.proto.selection()],
        log: this.proto.log(),
        sessions: this.proto.sessions().map((s) => ({
          id: s.id,
          project: s.projectId,
          title: s.title,
          ...(s.running ? { running: true } : {}),
          ...(s.attention ? { attention: s.attention } : {}),
          ...(s.archivedAt ? { archived: true } : {}),
        })),
      },
      null,
      2,
    ),
  );

  constructor() {
    effect(() => {
      const sc = this.scenario();
      untracked(() => this.proto.load(sc));
    });
    effect(() => {
      const o = this.params()?.get('order');
      this.proto.order.set((o === 'created' ? 'created' : 'activity') satisfies Order);
    });
  }

  protected reload(): void {
    this.proto.load(this.scenario());
  }

  protected cycle(dir: 1 | -1): void {
    const i = VARIANTS.findIndex((v) => v.key === this.variant());
    const next = VARIANTS[(i + dir + VARIANTS.length) % VARIANTS.length];
    if (next) this.setParam('variant', next.key);
  }

  protected setParam(key: string, value: string): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { [key]: value }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected onKey(ev: KeyboardEvent): void {
    const t = ev.target;
    if (t instanceof HTMLElement && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (ev.key === 'ArrowLeft') this.cycle(-1);
    if (ev.key === 'ArrowRight') this.cycle(1);
  }
}
