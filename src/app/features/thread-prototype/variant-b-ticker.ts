// PROTOTYPE (throwaway, branch prototype/calm-thread).
// Variant B, "Ticker and dock": while a Turn runs, the thread shows one changing line, never a list.
// Anything that needs you (permission request) or tracks progress (plan) docks above the composer,
// out of the reading flow. When the Turn ends, the work collapses into a receipt under the reply:
// changed files first (click for the diff), then "N steps" and "Thought" for the curious.
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { Diff, PermissionEntry, StepEntry, ThoughtEntry, TurnBlock } from './prototype-model';
import {
  basename,
  changedFiles,
  diffStat,
  elapsed,
  planOf,
  stepsOf,
  verbs,
} from './prototype-model';
import { ProtoAsideItem, ProtoOutcome } from './prototype-items';
import { ThreadPlayer } from './prototype-player';
import {
  ProtoDiff,
  ProtoIcon,
  ProtoParts,
  ProtoSpinner,
  ProtoStickToBottom,
  ProtoUserMessage,
  kindIcon,
} from './prototype-shared';

@Component({
  selector: 'proto-b-turn',
  imports: [ProtoIcon, ProtoSpinner, ProtoParts, ProtoUserMessage, ProtoOutcome, ProtoAsideItem, ProtoDiff],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-8' },
  template: `
    @let b = block();
    @if (b.user) {
      <proto-user-message [msg]="b.user" />
    }
    <div class="flex flex-col gap-4 leading-6">
      @for (e of prose(); track e.id) {
        @if (e.type === 'message') {
          <proto-parts [parts]="e.parts" [streaming]="running() && $last" />
        } @else {
          <proto-aside-item [entry]="e" />
        }
      }

      @if (running()) {
        <div class="text-muted-foreground flex h-6 min-w-0 items-center gap-2 text-[13px]" role="status">
          @if (waiting()) {
            <span class="mx-[3px] size-2 shrink-0 rounded-full bg-amber-500"></span>
            <span class="text-foreground">Waiting for you below</span>
          } @else {
            <!-- No state words: a fixed spinner, then our icon for what it is doing, then only the target. -->
            <proto-spinner [size]="13" class="shrink-0" />
            <proto-icon [name]="liveIcon()" [size]="13" class="text-foreground shrink-0" [attr.title]="liveTitle()" />
            @if (thinkingTail(); as tail) {
              <span class="min-w-0 truncate italic">{{ tail }}</span>
            } @else if (liveStep(); as s) {
              <span class="text-foreground min-w-0 truncate font-mono text-xs">{{ s.kind === 'execute' || s.kind === 'search' ? s.title : name(s.title) }}</span>
            }
          }
          <span class="ml-auto shrink-0 tabular-nums">{{ took() }}</span>
        </div>
      } @else {
        <!-- the receipt -->
        <div class="flex flex-col gap-2">
          <div class="flex flex-wrap items-center gap-1.5 text-[12px]">
            @for (f of files(); track f.path) {
              <button
                type="button"
                class="hover:bg-muted flex h-6 items-center gap-1.5 rounded-md border px-2 font-mono"
                [class.bg-muted]="openDiff() === f.path"
                [title]="f.path"
                (click)="toggleDiff(f)"
              >
                {{ name(f.path) }}
                <span class="text-emerald-600">+{{ stat(f).add }}</span>
                @if (stat(f).del) {
                  <span class="text-red-600">−{{ stat(f).del }}</span>
                }
              </button>
            }
            @if (steps().length > 0) {
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground h-6 px-1.5"
                [class.text-foreground]="panel() === 'steps'"
                (click)="togglePanel('steps')"
              >
                {{ steps().length }} {{ steps().length === 1 ? 'step' : 'steps' }}
              </button>
            }
            @if (thought()) {
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground h-6 px-1.5"
                (click)="togglePanel('thought')"
              >
                Thought {{ thoughtTime() }}
              </button>
            }
            <span class="text-muted-foreground ml-auto tabular-nums">{{ took() }}</span>
          </div>
          @if (openDiffEntry(); as d) {
            <proto-diff [diff]="d" />
          }
          @if (panel() === 'steps') {
            <ol class="m-0 flex list-none flex-col gap-0.5 rounded-lg border p-2 text-[13px]">
              @for (s of steps(); track s.id) {
                <li class="flex min-w-0 items-center gap-2">
                  <proto-icon [name]="icon(s)" [size]="13" class="text-muted-foreground" />
                  <span class="min-w-0 flex-1 truncate font-mono text-xs" [class.line-through]="s.status === 'cancelled'">{{ s.title }}</span>
                  @if (s.allowedBy === 'policy') {
                    <span class="text-muted-foreground text-[11px]">auto</span>
                  }
                  @if (s.rejected) {
                    <span class="text-muted-foreground text-[11px]">rejected</span>
                  }
                  @if (s.status === 'failed') {
                    <proto-icon name="x" [size]="12" class="text-destructive" />
                  }
                </li>
              }
            </ol>
          }
          @if (panel() === 'thought') {
            <p class="text-muted-foreground m-0 border-l pl-3 text-[13px] leading-5 italic">{{ thought()?.text }}</p>
          }
        </div>
      }

      @if (b.turn.outcome; as o) {
        <proto-outcome [outcome]="o" />
      }
    </div>
  `,
})
class BTurn {
  private readonly player = inject(ThreadPlayer);
  readonly block = input.required<TurnBlock>();
  protected readonly panel = signal<'steps' | 'thought' | null>(null);
  protected readonly openDiff = signal<string | null>(null);

  protected readonly running = computed(() => this.block().turn.outcome === undefined);
  protected readonly steps = computed(() => stepsOf(this.block().entries));
  protected readonly files = computed(() => changedFiles(this.steps()));
  protected readonly thought = computed(() =>
    this.block().entries.find((e): e is ThoughtEntry => e.type === 'thought'),
  );
  protected readonly waiting = computed(() =>
    this.block().entries.some((e) => e.type === 'permission' && e.state.kind === 'pending'),
  );
  protected readonly prose = computed(() =>
    this.block().entries.filter(
      (e) => e.type === 'message' || e.type === 'notice' || e.type === 'compaction',
    ),
  );
  protected readonly liveStep = computed(() =>
    [...this.steps()].reverse().find((s) => s.status === 'running'),
  );
  protected readonly thinkingTail = computed(() => {
    const th = this.thought();
    if (!th || th.done) return null;
    const t = th.text.trim();
    return t === '' ? null : '…' + t.slice(-90);
  });
  /** What the Agent is doing, as one of our icons; the word only lives in the tooltip and for screen readers. */
  protected readonly liveIcon = computed(() => {
    const s = this.liveStep();
    if (s) return kindIcon(s.kind);
    const th = this.thought();
    if (th && !th.done) return 'thought';
    if (this.prose().some((e) => e.type === 'message')) return 'text';
    return 'dot';
  });
  protected readonly liveTitle = computed(() => {
    const s = this.liveStep();
    if (s) return verbs[s.kind].live;
    const th = this.thought();
    if (th && !th.done) return 'Thinking';
    return this.prose().some((e) => e.type === 'message') ? 'Writing' : 'Working';
  });
  protected readonly took = computed(() => {
    const t = this.block().turn;
    return elapsed(t.startedAt, t.endedAt ?? this.player.now());
  });
  protected readonly thoughtTime = computed(() => {
    const th = this.thought();
    return th ? elapsed(th.startedAt, th.endedAt ?? this.player.now()) : '';
  });
  protected readonly openDiffEntry = computed(() =>
    this.files().find((f) => f.path === this.openDiff()),
  );
  protected readonly stat = diffStat;
  protected readonly name = basename;
  protected icon(s: StepEntry): string {
    return kindIcon(s.kind);
  }
  protected toggleDiff(f: Diff): void {
    this.openDiff.set(this.openDiff() === f.path ? null : f.path);
  }
  protected togglePanel(p: 'steps' | 'thought'): void {
    this.panel.set(this.panel() === p ? null : p);
  }
}

/** The dock: plan progress, or the permission request, above the composer. */
@Component({
  selector: 'proto-b-dock',
  imports: [ProtoIcon, ProtoSpinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (request(); as req) {
      <div class="bg-background flex flex-col gap-3 rounded-2xl border p-4 shadow-[0_10px_28px_-14px_rgb(0_0_0/0.18)]" role="alertdialog" aria-label="Permission request">
        <div class="flex items-start gap-3">
          <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <proto-icon name="shield" [size]="16" />
          </span>
          <div class="flex min-w-0 flex-col">
            <span class="font-medium">Claude wants to {{ step()?.kind === 'execute' ? 'run a command' : 'make a change' }}</span>
            <code class="bg-muted mt-1.5 self-start rounded-md px-2 py-1 font-mono text-xs break-all">{{ step()?.title }}</code>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-1.5">
          @for (o of req.options; track o.id; let i = $index) {
            <button
              type="button"
              (click)="player.answer(req.id, o.id)"
              [class]="
                (o.kind === 'allowOnce'
                  ? 'bg-primary text-primary-foreground font-medium'
                  : 'hover:bg-muted border') + ' flex h-9 items-center justify-between rounded-lg px-3 text-[13px]'
              "
            >
              {{ o.label }}
              <kbd class="font-mono text-[11px] opacity-60">{{ i + 1 }}</kbd>
            </button>
          }
        </div>
      </div>
    } @else if (plan(); as p) {
      <button
        type="button"
        class="bg-background flex w-full flex-col gap-2 rounded-2xl border px-4 py-2.5 text-left text-[13px]"
        (click)="planOpen.set(!planOpen())"
      >
        <div class="flex w-full items-center gap-2">
          <proto-icon name="list" [size]="14" class="text-muted-foreground" />
          <span class="text-muted-foreground">Plan {{ done() }} of {{ p.entries.length }}</span>
          <span class="min-w-0 flex-1 truncate">{{ current() }}</span>
          <proto-icon name="down" [size]="14" class="text-muted-foreground" [class.rotate-180]="planOpen()" />
        </div>
        <div class="flex gap-1">
          @for (e of p.entries; track $index) {
            <span
              class="h-1 flex-1 rounded-full"
              [class]="e.status === 'completed' ? 'bg-foreground/70' : e.status === 'inProgress' ? 'bg-foreground/30 animate-pulse' : 'bg-border'"
            ></span>
          }
        </div>
        @if (planOpen()) {
          <ol class="m-0 flex list-none flex-col gap-0.5 p-0">
            @for (e of p.entries; track $index) {
              <li class="flex items-center gap-2" [class.text-muted-foreground]="e.status === 'pending'">
                @if (e.status === 'completed') {
                  <proto-icon name="check" [size]="12" />
                } @else if (e.status === 'inProgress') {
                  <proto-spinner [size]="11" />
                } @else {
                  <span class="mx-[1px] size-2.5 rounded-full border"></span>
                }
                {{ e.content }}
              </li>
            }
          </ol>
        }
      </button>
    }
  `,
})
class BDock {
  protected readonly player = inject(ThreadPlayer);
  protected readonly planOpen = signal(false);
  private readonly running = computed(() => {
    const t = this.player.runningTurn();
    const blocks = this.player.blocks();
    return t ? blocks.find((b): b is TurnBlock => b.kind === 'turn' && b.turn.id === t.id) : undefined;
  });
  protected readonly request = computed(() =>
    this.running()?.entries.find(
      (e): e is PermissionEntry => e.type === 'permission' && e.state.kind === 'pending',
    ),
  );
  protected readonly step = computed(() => {
    const req = this.request();
    return req ? stepsOf(this.running()?.entries ?? []).find((s) => s.id === req.stepId) : undefined;
  });
  protected readonly plan = computed(() => planOf(this.running()?.entries ?? []));
  protected readonly done = computed(
    () => this.plan()?.entries.filter((e) => e.status === 'completed').length ?? 0,
  );
  protected readonly current = computed(
    () => this.plan()?.entries.find((e) => e.status === 'inProgress')?.content ?? '',
  );
}

@Component({
  selector: 'proto-variant-b',
  imports: [BTurn, BDock, ProtoAsideItem, ProtoStickToBottom],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex min-h-0 flex-1 flex-col',
    '(window:keydown)': 'key($event)',
  },
  template: `
    <div class="min-h-0 flex-1 overflow-y-auto px-6" protoStickToBottom>
      <div class="mx-auto flex max-w-[680px] flex-col gap-8 pt-6 pb-6">
        @for (b of player.blocks(); track b.kind === 'turn' ? b.turn.id : b.entry.id) {
          @if (b.kind === 'turn') {
            <proto-b-turn [block]="b" />
          } @else {
            <proto-aside-item [entry]="b.entry" />
          }
        }
      </div>
    </div>
    <div class="px-6">
      <div class="mx-auto max-w-[680px] pb-2">
        <proto-b-dock />
      </div>
    </div>
  `,
})
export class VariantB {
  static readonly label = 'Ticker and dock';
  protected readonly player = inject(ThreadPlayer);

  /** 1–4 answer a docked permission request when focus is not in a text field. */
  protected key(ev: KeyboardEvent): void {
    const t = ev.target;
    if (t instanceof HTMLElement && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
    const n = Number(ev.key);
    if (!Number.isInteger(n) || n < 1) return;
    const req = this.player
      .state()
      .entries.find((e): e is PermissionEntry => e.type === 'permission' && e.state.kind === 'pending');
    const opt = req?.options[n - 1];
    if (req && opt) this.player.answer(req.id, opt.id);
  }
}
