// PROTOTYPE (throwaway, branch prototype/calm-thread).
// Variant A, "One fold per Turn": the design board's strip, grown up. All work of a Turn (thought, plan,
// steps, answered requests) lives behind one line above the reply. While running, the line is live; a
// pending permission request breaks out of the fold, inline, right under it.
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { Entry, PermissionEntry, StepEntry, TurnBlock } from './prototype-model';
import {
  basename,
  changedFiles,
  diffStat,
  elapsed,
  foldSummary,
  planOf,
  stepsOf,
  verbs,
} from './prototype-model';
import { ProtoAsideItem, ProtoOutcome } from './prototype-items';
import { ThreadPlayer } from './prototype-player';
import {
  ProtoDiff,
  ProtoFold,
  ProtoIcon,
  ProtoParts,
  ProtoSpinner,
  ProtoStickToBottom,
  ProtoUserMessage,
} from './prototype-shared';

@Component({
  selector: 'proto-a-permission',
  imports: [ProtoIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-3 rounded-xl bg-amber-50 px-3.5 py-3 text-[13px] dark:bg-amber-950/40">
      <div class="flex items-center gap-2">
        <proto-icon name="shield" [size]="15" class="text-amber-700 dark:text-amber-400" />
        <span>
          Claude wants to {{ verb() }}
          <code class="font-mono text-xs">{{ step()?.title }}</code>
        </span>
      </div>
      <div class="flex flex-wrap justify-end gap-1.5">
        @for (o of request().options; track o.id) {
          <button
            type="button"
            (click)="player.answer(request().id, o.id)"
            [class]="
              o.kind === 'allowOnce'
                ? 'bg-primary text-primary-foreground h-[30px] rounded-full px-3 font-medium'
                : 'bg-background hover:bg-muted h-[30px] rounded-full border px-3'
            "
          >
            {{ o.label }}
          </button>
        }
      </div>
    </div>
  `,
})
class APermission {
  protected readonly player = inject(ThreadPlayer);
  readonly request = input.required<PermissionEntry>();
  readonly step = input<StepEntry>();
  protected verb(): string {
    const k = this.step()?.kind;
    return k === 'execute' ? 'run' : k === 'edit' ? 'edit' : k === 'delete' ? 'delete' : k === 'fetch' ? 'fetch' : 'use';
  }
}

@Component({
  selector: 'proto-a-step',
  imports: [ProtoIcon, ProtoSpinner, ProtoDiff],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let s = step();
    <li class="flex flex-col">
      <button
        type="button"
        class="hover:bg-muted/60 -mx-1.5 flex h-[26px] items-center gap-2 rounded-md px-1.5 text-left text-[13px]"
        [disabled]="!hasDetail()"
        (click)="open.set(!open())"
      >
        <span class="text-muted-foreground w-16 shrink-0">{{ s.status === 'running' ? verbs[s.kind].live : verbs[s.kind].past }}</span>
        <span class="min-w-0 flex-1 truncate font-mono text-xs" [class.line-through]="s.status === 'cancelled'">{{ s.title }}</span>
        @if (s.allowedBy === 'policy') {
          <span class="text-muted-foreground text-[11px]" title="Allowed automatically (Auto)">auto</span>
        }
        @if (s.allowedBy === 'user') {
          <span class="text-muted-foreground text-[11px]">you allowed</span>
        }
        @if (s.rejected) {
          <span class="text-muted-foreground text-[11px]">you rejected</span>
        }
        @for (d of s.diffs; track d.path) {
          <span class="font-mono text-[11px] tabular-nums">
            <span class="text-emerald-600">+{{ stat(d).add }}</span>
            @if (stat(d).del) {
              <span class="text-red-600"> −{{ stat(d).del }}</span>
            }
          </span>
        }
        @switch (s.status) {
          @case ('running') {
            <proto-spinner [size]="12" class="text-muted-foreground" />
          }
          @case ('pending') {
            <span class="size-2 rounded-full bg-amber-500"></span>
          }
          @case ('failed') {
            <proto-icon name="x" [size]="12" class="text-destructive" />
          }
          @default {}
        }
      </button>
      @if (open()) {
        <div class="my-1.5 flex flex-col gap-2">
          @for (d of s.diffs; track d.path) {
            <proto-diff [diff]="d" />
          }
          @if (s.output) {
            <pre class="bg-muted/50 m-0 max-h-40 overflow-auto rounded-md p-2.5 font-mono text-xs leading-5">{{ s.output }}</pre>
          }
        </div>
      }
    </li>
  `,
})
class AStep {
  readonly step = input.required<StepEntry>();
  protected readonly open = signal(false);
  protected readonly verbs = verbs;
  protected readonly stat = diffStat;
  protected hasDetail(): boolean {
    return this.step().diffs.length > 0 || this.step().output !== undefined;
  }
}

@Component({
  selector: 'proto-a-turn',
  imports: [
    ProtoIcon,
    ProtoSpinner,
    ProtoParts,
    ProtoUserMessage,
    ProtoOutcome,
    ProtoAsideItem,
    ProtoFold,
    APermission,
    AStep,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let b = block();
    @if (b.user) {
      <proto-user-message [msg]="b.user" />
    }
    <div class="flex flex-col gap-4 leading-6">
      @if (steps().length > 0 || thought() || plan() || running()) {
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground flex h-6 items-center gap-1.5 self-start text-[13px]"
          [attr.aria-expanded]="open()"
          (click)="open.set(!open())"
        >
          @if (running()) {
            @if (waiting()) {
              <span class="mx-[3px] size-2 rounded-full bg-amber-500"></span>
              <span class="text-foreground">Waiting for you</span>
            } @else {
              <proto-spinner [size]="13" />
              <span class="text-foreground">{{ liveLabel() }}</span>
            }
            @if (steps().length > 0) {
              <span>· {{ steps().length }} {{ steps().length === 1 ? 'step' : 'steps' }}</span>
            }
            <span class="tabular-nums">· {{ took() }}</span>
          } @else {
            <proto-icon [name]="b.turn.outcome?.kind === 'done' ? 'check' : 'dot'" [size]="14" />
            {{ summary() }} · {{ took() }}
          }
          <proto-icon name="chevron" [size]="14" [class]="open() ? 'rotate-90 transition-transform' : 'transition-transform'" />
        </button>

        @if (open()) {
          <div class="-mt-2 ml-1.5 flex flex-col gap-3 border-l pl-5">
            @if (thought(); as th) {
              <proto-fold [label]="th.done ? 'Thought for ' + thoughtTime() : 'Thinking…'" [text]="th.text" />
            }
            @if (plan(); as p) {
              <ol class="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px]">
                @for (e of p.entries; track $index) {
                  <li class="flex items-center gap-2" [class.text-muted-foreground]="e.status !== 'inProgress'">
                    <span class="flex size-3.5 items-center justify-center">
                      @if (e.status === 'completed') {
                        <proto-icon name="check" [size]="12" />
                      } @else if (e.status === 'inProgress') {
                        <proto-spinner [size]="11" />
                      } @else {
                        <span class="border-muted-foreground/50 size-2.5 rounded-full border"></span>
                      }
                    </span>
                    {{ e.content }}
                  </li>
                }
              </ol>
            }
            @if (steps().length > 0) {
              <ul class="m-0 flex list-none flex-col p-0">
                @for (s of steps(); track s.id) {
                  <proto-a-step [step]="s" />
                }
              </ul>
            }
          </div>
        } @else if (running() && plan(); as p) {
          <!-- While running, the plan peeks out of the fold as a one-line progress. -->
          <div class="text-muted-foreground -mt-3 ml-5 text-xs">
            Plan {{ planDone() }}/{{ p.entries.length }}@if (planNow(); as now) {<span> · {{ now }}</span>}
          </div>
        }
      }

      @if (pending(); as req) {
        <proto-a-permission [request]="req" [step]="stepOf(req.stepId)" />
      }

      @for (e of prose(); track e.id) {
        @if (e.type === 'message') {
          <proto-parts [parts]="e.parts" [streaming]="running() && $last" />
        } @else {
          <proto-aside-item [entry]="e" />
        }
      }

      @if (b.turn.outcome; as o) {
        <proto-outcome [outcome]="o" />
      }
    </div>
  `,
  host: { class: 'flex flex-col gap-8' },
})
class ATurn {
  private readonly player = inject(ThreadPlayer);
  readonly block = input.required<TurnBlock>();
  protected readonly open = signal(false);

  protected readonly running = computed(() => this.block().turn.outcome === undefined);
  protected readonly steps = computed(() => stepsOf(this.block().entries));
  protected readonly plan = computed(() => planOf(this.block().entries));
  protected readonly thought = computed(() =>
    this.block().entries.find((e): e is Extract<Entry, { type: 'thought' }> => e.type === 'thought'),
  );
  protected readonly pending = computed(() =>
    this.block().entries.find(
      (e): e is PermissionEntry => e.type === 'permission' && e.state.kind === 'pending',
    ),
  );
  protected readonly waiting = computed(() => this.pending() !== undefined);
  protected readonly prose = computed(() =>
    this.block().entries.filter(
      (e) => e.type === 'message' || e.type === 'notice' || e.type === 'compaction',
    ),
  );
  protected readonly liveLabel = computed(() => {
    const live = [...this.steps()].reverse().find((s) => s.status === 'running');
    if (live) return `${verbs[live.kind].live} ${live.kind === 'execute' || live.kind === 'search' ? live.title : basename(live.title)}`;
    const th = this.thought();
    if (th && !th.done) return 'Thinking…';
    if (this.prose().some((e) => e.type === 'message')) return 'Writing…';
    return 'Working…';
  });
  protected readonly summary = computed(() => {
    const s = this.steps();
    return s.length > 0 ? foldSummary(s) : this.thought() ? 'Thought it through' : 'No steps';
  });
  protected readonly took = computed(() => {
    const t = this.block().turn;
    return elapsed(t.startedAt, t.endedAt ?? this.player.now());
  });
  protected readonly thoughtTime = computed(() => {
    const th = this.thought();
    return th ? elapsed(th.startedAt, th.endedAt ?? this.player.now()) : '';
  });
  protected readonly planDone = computed(
    () => this.plan()?.entries.filter((e) => e.status === 'completed').length ?? 0,
  );
  protected readonly planNow = computed(
    () => this.plan()?.entries.find((e) => e.status === 'inProgress')?.content,
  );
  protected readonly files = computed(() => changedFiles(this.steps()));
  protected stepOf(id: string): StepEntry | undefined {
    return this.steps().find((s) => s.id === id);
  }
}

@Component({
  selector: 'proto-variant-a',
  imports: [ATurn, ProtoAsideItem, ProtoStickToBottom],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <div class="min-h-0 flex-1 overflow-y-auto px-6" protoStickToBottom>
      <div class="mx-auto flex max-w-[680px] flex-col gap-8 pt-6 pb-10">
        @for (b of player.blocks(); track b.kind === 'turn' ? b.turn.id : b.entry.id) {
          @if (b.kind === 'turn') {
            <proto-a-turn [block]="b" />
          } @else {
            <proto-aside-item [entry]="b.entry" />
          }
        }
      </div>
    </div>
  `,
})
export class VariantA {
  static readonly label = 'One fold per Turn';
  protected readonly player = inject(ThreadPlayer);
}
