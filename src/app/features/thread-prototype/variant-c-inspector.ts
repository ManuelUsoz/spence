// PROTOTYPE (throwaway, branch prototype/calm-thread).
// Variant C, "Conversation and inspector": the thread holds only what is said. A permission request is
// said, too: the Agent asks in the thread and you reply with a chip, which stays as your short reply.
// The work of each Turn is a quiet trail of marks in the margin; clicking it opens an inspector on the
// right with Steps, Files, Plan and Thinking for that Turn.
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import type { PermissionEntry, StepEntry, ThoughtEntry, TurnBlock } from './prototype-model';
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
  ProtoIcon,
  ProtoParts,
  ProtoSpinner,
  ProtoStickToBottom,
  ProtoUserMessage,
  kindIcon,
} from './prototype-shared';

@Component({
  selector: 'proto-c-turn',
  imports: [ProtoIcon, ProtoSpinner, ProtoParts, ProtoUserMessage, ProtoOutcome, ProtoAsideItem],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-8' },
  template: `
    @let b = block();
    @if (b.user) {
      <proto-user-message [msg]="b.user" />
    }
    <div class="relative flex flex-col gap-4 leading-6">
      <!-- the margin trail -->
      @if (steps().length > 0 || running()) {
        <button
          type="button"
          class="absolute top-1 -left-10 flex w-6 flex-col items-center gap-1 rounded-md py-1"
          [class]="selected() ? 'bg-muted' : 'hover:bg-muted/70'"
          [attr.aria-label]="'Show the work of this Turn: ' + summary()"
          [title]="summary()"
          (click)="inspect.emit(b.turn.id)"
        >
          @for (s of trail(); track s.id) {
            <span
              class="size-1.5 rounded-full"
              [class]="
                s.status === 'failed' ? 'bg-destructive'
                : s.status === 'pending' ? 'bg-amber-500'
                : s.status === 'running' ? 'bg-foreground animate-pulse'
                : s.diffs.length > 0 ? 'bg-foreground/60'
                : 'bg-foreground/20'
              "
            ></span>
          }
          @if (steps().length > trail().length) {
            <span class="text-muted-foreground text-[9px] leading-none">+{{ steps().length - trail().length }}</span>
          }
        </button>
      }

      @for (e of prose(); track e.id) {
        @if (e.type === 'message') {
          <proto-parts [parts]="e.parts" [streaming]="running() && $last" />
        } @else if (e.type === 'permission') {
          <div class="flex flex-col gap-2">
            <p class="m-0">
              May I {{ askVerb(e) }} <code class="bg-muted rounded px-1 py-px font-mono text-[13px]">{{ stepOf(e.stepId)?.title }}</code>?
            </p>
            @switch (e.state.kind) {
              @case ('pending') {
                <div class="flex flex-wrap justify-end gap-1.5">
                  @for (o of e.options; track o.id) {
                    <button
                      type="button"
                      (click)="player.answer(e.id, o.id)"
                      [class]="
                        (o.kind === 'allowOnce' ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted') +
                        ' h-8 rounded-full border px-3.5 text-[13px]'
                      "
                    >
                      {{ o.label }}
                    </button>
                  }
                </div>
              }
              @case ('answered') {
                <div class="bg-muted self-end rounded-[18px] px-4 py-1.5 text-[13px]">{{ optionLabel(e) }}</div>
              }
              @case ('cancelled') {
                <div class="text-muted-foreground self-end text-xs">No answer, the Turn ended</div>
              }
            }
          </div>
        } @else {
          <proto-aside-item [entry]="e" />
        }
      }

      @if (running() && !waiting()) {
        <div class="text-muted-foreground flex items-center gap-2 text-[13px]" role="status">
          <proto-spinner [size]="13" />
          {{ liveLabel() }}
          <span class="tabular-nums">· {{ took() }}</span>
        </div>
      }
      @if (!running() && steps().length > 0) {
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground flex items-center gap-1.5 self-start text-xs"
          (click)="inspect.emit(b.turn.id)"
        >
          <proto-icon name="list" [size]="12" />
          {{ summary() }} · {{ took() }}
        </button>
      }

      @if (b.turn.outcome; as o) {
        <proto-outcome [outcome]="o" />
      }
    </div>
  `,
})
class CTurn {
  protected readonly player = inject(ThreadPlayer);
  readonly block = input.required<TurnBlock>();
  readonly selected = input(false);
  readonly inspect = output<string>();

  protected readonly running = computed(() => this.block().turn.outcome === undefined);
  protected readonly steps = computed(() => stepsOf(this.block().entries));
  protected readonly trail = computed(() => this.steps().slice(-12));
  protected readonly waiting = computed(() =>
    this.block().entries.some((e) => e.type === 'permission' && e.state.kind === 'pending'),
  );
  /** Permission requests answered by policy are already folded into their Step by main. */
  protected readonly prose = computed(() =>
    this.block().entries.filter(
      (e) =>
        e.type === 'message' || e.type === 'notice' || e.type === 'compaction' || e.type === 'permission',
    ),
  );
  protected readonly summary = computed(() => foldSummary(this.steps()));
  protected readonly liveLabel = computed(() => {
    const s = [...this.steps()].reverse().find((x) => x.status === 'running');
    if (s) return `${verbs[s.kind].live} ${s.kind === 'execute' || s.kind === 'search' ? s.title : basename(s.title)}`;
    const th = this.block().entries.find((e): e is ThoughtEntry => e.type === 'thought');
    if (th && !th.done) return 'Thinking…';
    return 'Working…';
  });
  protected readonly took = computed(() => {
    const t = this.block().turn;
    return elapsed(t.startedAt, t.endedAt ?? this.player.now());
  });
  protected stepOf(id: string): StepEntry | undefined {
    return this.steps().find((s) => s.id === id);
  }
  protected askVerb(e: PermissionEntry): string {
    return this.stepOf(e.stepId)?.kind === 'execute' ? 'run' : 'change';
  }
  protected optionLabel(e: PermissionEntry): string {
    return e.state.kind === 'answered'
      ? (e.options.find((o) => e.state.kind === 'answered' && o.id === e.state.optionId)?.label ?? '')
      : '';
  }
}

type Tab = 'steps' | 'files' | 'plan' | 'thinking';

@Component({
  selector: 'proto-c-inspector',
  imports: [ProtoIcon, ProtoSpinner, ProtoDiff],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex w-[380px] shrink-0 flex-col border-l bg-sidebar' },
  template: `
    <div class="flex h-11 items-center gap-1 border-b px-2">
      @for (t of tabs(); track t.id) {
        <button
          type="button"
          class="h-7 rounded-md px-2.5 text-[13px]"
          [class]="tab() === t.id ? 'bg-background shadow-xs font-medium' : 'text-muted-foreground hover:text-foreground'"
          (click)="tab.set(t.id)"
        >
          {{ t.label }}
        </button>
      }
      <button type="button" class="text-muted-foreground hover:bg-muted ml-auto flex size-7 items-center justify-center rounded-md" aria-label="Close" (click)="closed.emit()">
        <proto-icon name="x" [size]="14" />
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto p-3 text-[13px]">
      @switch (tab()) {
        @case ('steps') {
          <ol class="m-0 flex list-none flex-col p-0">
            @for (s of steps(); track s.id) {
              <li class="flex gap-2.5">
                <div class="flex flex-col items-center">
                  <span class="bg-background flex size-6 items-center justify-center rounded-full border" [class.text-destructive]="s.status === 'failed'">
                    @if (s.status === 'running') {
                      <proto-spinner [size]="11" />
                    } @else {
                      <proto-icon [name]="icon(s)" [size]="11" />
                    }
                  </span>
                  @if (!$last) {
                    <span class="bg-border w-px flex-1"></span>
                  }
                </div>
                <div class="flex min-w-0 flex-1 flex-col gap-1.5 pb-3">
                  <div class="flex items-baseline gap-1.5 pt-0.5">
                    <span class="text-muted-foreground">{{ s.status === 'running' ? verbs[s.kind].live : verbs[s.kind].past }}</span>
                    <span class="min-w-0 truncate font-mono text-xs">{{ s.title }}</span>
                  </div>
                  @if (s.allowedBy === 'policy') {
                    <span class="text-muted-foreground text-[11px]">Allowed automatically</span>
                  }
                  @if (s.rejected) {
                    <span class="text-muted-foreground text-[11px]">You rejected this</span>
                  }
                  @if (s.output) {
                    <pre class="bg-background m-0 max-h-32 overflow-auto rounded-md border p-2 font-mono text-[11px] leading-4">{{ s.output }}</pre>
                  }
                </div>
              </li>
            }
          </ol>
        }
        @case ('files') {
          <div class="flex flex-col gap-3">
            @for (d of files(); track d.path) {
              <proto-diff [diff]="d" />
            } @empty {
              <p class="text-muted-foreground m-0">No files changed in this Turn.</p>
            }
          </div>
        }
        @case ('plan') {
          <ol class="m-0 flex list-none flex-col gap-1 p-0">
            @for (e of plan()?.entries ?? []; track $index) {
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
        @case ('thinking') {
          <p class="text-muted-foreground m-0 leading-5 whitespace-pre-wrap italic">{{ thought()?.text }}</p>
        }
      }
    </div>
  `,
})
class CInspector {
  readonly block = input.required<TurnBlock>();
  readonly closed = output();
  protected readonly tab = signal<Tab>('steps');
  protected readonly verbs = verbs;
  protected readonly steps = computed(() => stepsOf(this.block().entries));
  protected readonly files = computed(() => changedFiles(this.steps()));
  protected readonly plan = computed(() => planOf(this.block().entries));
  protected readonly thought = computed(() =>
    this.block().entries.find((e): e is ThoughtEntry => e.type === 'thought'),
  );
  protected readonly tabs = computed(() => {
    const t: { id: Tab; label: string }[] = [{ id: 'steps', label: `Steps ${this.steps().length}` }];
    const n = this.files().length;
    if (n > 0) {
      const add = this.files().reduce((a, f) => a + diffStat(f).add, 0);
      t.push({ id: 'files', label: `Files ${n} · +${add}` });
    }
    if (this.plan()) t.push({ id: 'plan', label: 'Plan' });
    if (this.thought()) t.push({ id: 'thinking', label: 'Thinking' });
    return t;
  });
  protected icon(s: StepEntry): string {
    return kindIcon(s.kind);
  }
}

@Component({
  selector: 'proto-variant-c',
  imports: [CTurn, CInspector, ProtoAsideItem, ProtoStickToBottom],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-0 flex-1' },
  template: `
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="min-h-0 flex-1 overflow-y-auto px-6" protoStickToBottom>
        <div class="mx-auto flex max-w-[680px] flex-col gap-8 pt-6 pb-10 pl-10">
          @for (b of player.blocks(); track b.kind === 'turn' ? b.turn.id : b.entry.id) {
            @if (b.kind === 'turn') {
              <proto-c-turn [block]="b" [selected]="inspected() === b.turn.id" (inspect)="toggle($event)" />
            } @else {
              <proto-aside-item [entry]="b.entry" />
            }
          }
        </div>
      </div>
    </div>
    @if (inspectedBlock(); as b) {
      <proto-c-inspector [block]="b" (closed)="inspected.set(null)" />
    }
  `,
})
export class VariantC {
  static readonly label = 'Conversation and inspector';
  protected readonly player = inject(ThreadPlayer);
  protected readonly inspected = signal<string | null>(null);
  protected readonly inspectedBlock = computed(() =>
    this.player
      .blocks()
      .find((b): b is TurnBlock => b.kind === 'turn' && b.turn.id === this.inspected()),
  );
  protected toggle(turnId: string): void {
    this.inspected.set(this.inspected() === turnId ? null : turnId);
  }
}
