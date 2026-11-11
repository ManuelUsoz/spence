// PROTOTYPE (throwaway, branch prototype/calm-thread): "The calm thread" (issue #12).
// Three variants of a Session's thread, switchable via `?variant=A|B|C`, each driven by scripted
// ACP-shaped traffic picked with `?scenario=`. Mounted inside the real shell at #/prototype/thread.
// Run: `npm run prototype:thread`.
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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
import { ThreadPlayer } from './prototype-player';
import { scenarios } from './prototype-scenarios';
import { ProtoFold, ProtoIcon, ProtoSpinner } from './prototype-shared';
import { VariantA } from './variant-a-fold';
import { VariantB } from './variant-b-ticker';
import { VariantC } from './variant-c-inspector';

const VARIANTS = [
  { key: 'A', label: VariantA.label },
  { key: 'B', label: VariantB.label },
  { key: 'C', label: VariantC.label },
] as const;

@Component({
  selector: 'proto-agent-bar',
  imports: [ProtoIcon, ProtoSpinner, ProtoFold],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let s = player.state();
    <div class="flex flex-col gap-2 px-4 pt-2.5 pb-3 text-[13px]" role="status">
      @switch (s.agent) {
        @case ('notInstalled') {
          <div class="flex items-center gap-3">
            <proto-icon name="info" [size]="16" class="text-muted-foreground" />
            <span class="flex-1">Claude isn’t installed on this computer.</span>
            <button type="button" class="hover:bg-muted h-8 rounded-full border px-3" (click)="showCmd.set(!showCmd())">Show command</button>
            <button type="button" class="bg-primary text-primary-foreground h-8 rounded-full px-3.5 font-medium" (click)="player.agentAction('install')">Install</button>
          </div>
          @if (showCmd()) {
            <code class="bg-background self-start rounded-md border px-2 py-1 font-mono text-xs">npm install -g &#64;agentclientprotocol/claude-agent-acp</code>
          }
        }
        @case ('installing') {
          <div class="flex items-center gap-3">
            <span class="flex-1">Installing Claude…</span>
          </div>
          <div class="bg-border relative h-1 overflow-hidden rounded-full">
            <div class="bg-foreground/70 absolute inset-y-0 w-1/3 animate-[proto-indeterminate_1.2s_ease-in-out_infinite] rounded-full"></div>
          </div>
        }
        @case ('needsLogin') {
          <div class="flex items-center gap-3">
            <proto-icon name="info" [size]="16" class="text-muted-foreground" />
            <span class="flex-1">Log in to Claude to keep going.</span>
            <button type="button" class="bg-primary text-primary-foreground h-8 rounded-full px-3.5 font-medium" (click)="player.agentAction('login')">Log in</button>
          </div>
        }
        @case ('loggingIn') {
          <div class="flex items-center gap-3">
            <proto-spinner [size]="14" class="text-muted-foreground" />
            <span class="flex-1">Finish logging in in your browser…</span>
            <button type="button" class="text-muted-foreground hover:text-foreground h-8 px-2">Cancel</button>
          </div>
        }
        @case ('cantStart') {
          <div class="flex items-center gap-3">
            <proto-icon name="alert" [size]="16" class="text-destructive" />
            <span class="flex-1">Claude can’t start.</span>
            <button type="button" class="text-muted-foreground hover:text-foreground h-8 px-2">Open log</button>
            <button type="button" class="bg-primary text-primary-foreground h-8 rounded-full px-3.5 font-medium" (click)="player.agentAction('retry')">Try again</button>
          </div>
          @if (s.agentDetail) {
            <proto-fold label="What it said" [text]="s.agentDetail" />
          }
        }
        @default {}
      }
    </div>
  `,
})
class AgentBar {
  protected readonly player = inject(ThreadPlayer);
  protected readonly showCmd = signal(false);
}

@Component({
  selector: 'app-thread-prototype',
  imports: [VariantA, VariantB, VariantC, AgentBar, ProtoIcon, ProtoSpinner],
  providers: [ThreadPlayer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex flex-col h-[calc(100svh-3rem-3rem)] -m-6 bg-background',
    '(window:keydown)': 'onKey($event)',
  },
  styles: `
    @keyframes proto-indeterminate {
      from { left: -33%; }
      to { left: 100%; }
    }
  `,
  template: `
    @let s = player.state();
    <header class="flex h-[52px] shrink-0 items-center gap-2 px-4">
      <h1 class="m-0 truncate text-sm font-medium">{{ s.title }}</h1>
      @if (s.agent === 'starting') {
        <span class="text-muted-foreground flex items-center gap-1.5 text-xs"><proto-spinner [size]="11" /> Starting Claude…</span>
      }
    </header>

    <div class="flex min-h-0 flex-1 flex-col">
      @switch (variant()) {
        @case ('B') {
          <proto-variant-b class="min-h-0" />
        }
        @case ('C') {
          <proto-variant-c class="min-h-0" />
        }
        @default {
          <proto-variant-a class="min-h-0" />
        }
      }
    </div>

    <div class="shrink-0 px-6 pb-16">
      <div class="mx-auto max-w-[680px]">
        <!-- The composer always stays. An Agent problem is a notice docked on top of it, never a replacement. -->
        <div [class]="agentBlocked() ? 'bg-muted/70 rounded-[24px]' : ''">
          @if (agentBlocked()) {
            <proto-agent-bar />
          }
          <div class="bg-background flex flex-col gap-2.5 rounded-[22px] border px-3.5 pt-3.5 pb-3 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_10px_28px_-14px_rgb(0_0_0/0.14)]">
            <label for="proto-composer" class="sr-only">Message</label>
            <textarea
              id="proto-composer"
              rows="2"
              class="w-full resize-none bg-transparent px-1 text-[15px] leading-[22px] outline-none"
              placeholder="Ask Claude…"
              [value]="draft()"
              (input)="draft.set($any($event.target).value)"
              (keydown.enter)="$event.preventDefault(); send()"
            ></textarea>
            <div class="flex items-center gap-1.5">
              <span class="text-muted-foreground flex h-9 items-center gap-1.5 rounded-full border px-3 text-[13px]">
                <proto-icon name="shield" [size]="14" /> {{ scenario().id === 'permission' ? 'Ask' : 'Auto' }}
              </span>
              <span class="flex h-9 items-center rounded-full border px-3 text-[13px]">Opus 5.5 <span class="text-muted-foreground ml-1.5">High</span></span>
              <span class="flex-1"></span>
              @if (player.runningTurn()) {
                <button type="button" class="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-full" aria-label="Stop" title="Stop" (click)="player.cancel()">
                  <span class="size-3 rounded-[3px] bg-current"></span>
                </button>
              } @else {
                <button type="button" class="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-full disabled:opacity-35" aria-label="Send" [title]="agentBlocked() ? 'Claude isn’t ready yet' : 'Send'" [disabled]="agentBlocked()" (click)="send()">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7M12 19V5" /></svg>
                </button>
              }
            </div>
          </div>
        </div>
      </div>
    </div>

    @if (showSwitcher) {
      @if (showState()) {
        <pre class="bg-foreground text-background fixed top-4 right-4 bottom-20 z-50 m-0 w-[420px] overflow-auto rounded-xl p-3 font-mono text-[11px] leading-4 opacity-95">{{ stateJson() }}</pre>
      }
      <div
        class="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black px-1.5 py-1.5 text-[12px] text-white shadow-2xl ring-2 ring-fuchsia-500"
        role="toolbar"
        aria-label="Prototype switcher"
      >
        <button type="button" class="flex size-7 items-center justify-center rounded-full hover:bg-white/15" aria-label="Previous variant" (click)="cycle(-1)">←</button>
        <span class="min-w-[200px] text-center font-medium">{{ variant() }} · {{ variantLabel() }}</span>
        <button type="button" class="flex size-7 items-center justify-center rounded-full hover:bg-white/15" aria-label="Next variant" (click)="cycle(1)">→</button>
        <span class="mx-1 h-4 w-px bg-white/25"></span>
        <select
          class="h-7 rounded-full bg-white/10 px-2 outline-none"
          aria-label="Scenario"
          [value]="scenario().id"
          (change)="setParam('scenario', $any($event.target).value)"
        >
          @for (sc of scenarios; track sc.id) {
            <option [value]="sc.id" class="text-black">{{ sc.label }}</option>
          }
        </select>
        <button type="button" class="h-7 rounded-full px-2.5 whitespace-nowrap hover:bg-white/15" (click)="player.replay()" title="Replay the scenario">↺ Replay</button>
        <button type="button" class="h-7 rounded-full px-2.5 tabular-nums hover:bg-white/15" (click)="cycleSpeed()" title="Playback speed">{{ player.speed() }}×</button>
        <button type="button" class="h-7 rounded-full px-2.5 whitespace-nowrap hover:bg-white/15" [class.bg-white/20]="showState()" (click)="showState.set(!showState())">State</button>
        <span class="group relative ml-0.5 flex size-7 cursor-help items-center justify-center rounded-full hover:bg-white/15" tabindex="0" aria-label="About this scenario">
          ?
          <span class="pointer-events-none absolute right-0 bottom-9 hidden w-72 rounded-lg bg-black p-2.5 text-left leading-4 group-hover:block group-focus:block">{{ scenario().hint }}</span>
        </span>
      </div>
    }
  `,
})
export class ThreadPrototype {
  protected readonly player = inject(ThreadPlayer);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly showSwitcher = isDevMode();
  protected readonly scenarios = scenarios;
  protected readonly showState = signal(false);
  protected readonly draft = signal('');

  private readonly params = toSignal(this.route.queryParamMap.pipe(map((p) => p)));
  protected readonly variant = computed(() => {
    const v = this.params()?.get('variant')?.toUpperCase();
    return VARIANTS.some((x) => x.key === v) ? (v as string) : 'A';
  });
  protected readonly variantLabel = computed(
    () => VARIANTS.find((v) => v.key === this.variant())?.label ?? '',
  );
  protected readonly scenario = computed(() => {
    const id = this.params()?.get('scenario');
    return scenarios.find((s) => s.id === id) ?? scenarios[0]!;
  });
  protected readonly agentBlocked = computed(() =>
    ['notInstalled', 'installing', 'needsLogin', 'loggingIn', 'cantStart'].includes(this.player.state().agent),
  );
  protected readonly stateJson = computed(() =>
    JSON.stringify({ variant: this.variant(), scenario: this.scenario().id, ...this.player.state() }, null, 2),
  );

  constructor() {
    effect(() => {
      const sc = this.scenario();
      untracked(() => this.player.load(sc));
    });
    // A failed Message returns to the composer (#10).
    effect(() => {
      const d = this.player.state().composerDraft;
      if (d !== '') this.draft.set(d);
    });
    inject(DestroyRef).onDestroy(() => this.player.destroy());
  }

  protected send(): void {
    if (this.agentBlocked()) return;
    this.player.send(this.draft());
    this.draft.set('');
  }

  protected cycle(dir: 1 | -1): void {
    const i = VARIANTS.findIndex((v) => v.key === this.variant());
    const next = VARIANTS[(i + dir + VARIANTS.length) % VARIANTS.length];
    if (next) this.setParam('variant', next.key);
  }

  protected cycleSpeed(): void {
    const speeds = [1, 2, 4, 0.5];
    this.player.speed.set(speeds[(speeds.indexOf(this.player.speed()) + 1) % speeds.length] ?? 1);
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
    if (t instanceof HTMLElement && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (ev.key === 'ArrowLeft') this.cycle(-1);
    if (ev.key === 'ArrowRight') this.cycle(1);
  }
}
