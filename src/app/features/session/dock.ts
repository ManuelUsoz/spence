import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { DiffPatch } from '@ui/diff';
import { HlmKbdImports } from '@ui/kbd';
import type {
  PermissionOption,
  PermissionRequest,
  PermissionRequestId,
  Plan,
  Step,
} from '../../../shared/sessions/sessions.rpc';
import { completedPlanCount, currentPlanEntry, hunksForDiff } from './thread';

/** Pending Permission request details rendered in `<app-dock>`. */
export interface DockPermission {
  readonly requestId: PermissionRequestId;
  readonly title: string;
  readonly step: Step | null;
  readonly workflowSource?: PermissionRequest['workflowSource'];
  readonly options: ReadonlyArray<PermissionOption>;
}

/**
 * The area just above the Composer for what a running Turn wants from the user: a pending Permission request
 * (with kind-aware command/diff/input previews and pinned `1–4` options), otherwise the Plan's progress.
 */
@Component({
  selector: 'app-dock',
  imports: [HlmButtonImports, HlmKbdImports, DiffPatch],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-2', 'data-testid': 'plan-dock' },
  template: `
    @if (permission(); as pending) {
      <div
        class="border-border bg-card flex flex-col gap-2.5 rounded-2xl border p-3 shadow-sm"
        data-testid="dock"
      >
        @if (pending.workflowSource; as source) {
          <div class="text-muted-foreground text-sm" data-testid="workflow-permission-source">
            {{ source.role }} &middot; {{ source.agentName }}
          </div>
        }
        @if (pending.step; as step) {
          @if (step.kind === 'execute') {
            @if (hasDistinctExecuteTitle(pending, step)) {
              <div class="text-foreground text-sm" data-testid="dock-title">
                {{ pending.title }}
              </div>
              <pre
                class="bg-tray border-border/60 text-foreground max-h-36 overflow-auto rounded-md border px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap break-all"
                data-testid="dock-command"
                >{{ executeCommand(pending, step) }}</pre>
            } @else {
              <pre
                class="bg-tray border-border/60 text-foreground max-h-36 overflow-auto rounded-md border px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap break-all"
                data-testid="dock-title"
              ><span data-testid="dock-command">{{ executeCommand(pending, step) }}</span></pre>
            }
            @if (executeCwd(step); as cwd) {
              <div class="text-muted-foreground flex items-baseline gap-1.5 text-xs">
                <span class="shrink-0" i18n>Working directory</span>
                <span class="text-foreground font-mono text-xs break-all" data-testid="dock-cwd">{{
                  cwd
                }}</span>
              </div>
            }
          } @else {
            @if (pending.title !== '') {
              <div class="text-foreground text-sm" data-testid="dock-title">
                {{ pending.title }}
              </div>
            }
            @if (step.files.length > 0) {
              <div class="flex flex-wrap gap-1.5" data-testid="dock-files">
                @for (file of step.files; track file) {
                  <span
                    class="bg-tray border-border/60 text-foreground rounded border px-1.5 py-0.5 font-mono text-xs break-all"
                    data-testid="dock-file"
                    >{{ file }}</span
                  >
                }
              </div>
            }
            @if (step.diffs.length > 0) {
              <div class="flex max-h-48 flex-col gap-2 overflow-auto" data-testid="dock-diffs">
                @for (diff of step.diffs; track diff.path + '-' + $index) {
                  <div class="flex flex-col gap-1" data-testid="dock-diff">
                    @if (step.diffs.length > 1 || step.files.length === 0) {
                      <div class="text-muted-foreground font-mono text-xs break-all">
                        {{ diff.path }}
                      </div>
                    }
                    <app-diff-patch [hunks]="hunksForDiff(diff)" />
                  </div>
                }
              </div>
            } @else if (step.input; as inputText) {
              <pre
                class="bg-tray border-border/60 text-foreground max-h-40 overflow-auto rounded-md border px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap break-all"
                data-testid="dock-input"
                >{{ inputText }}</pre>
            }
          }
        } @else {
          <div class="text-foreground text-sm" data-testid="dock-title">{{ pending.title }}</div>
        }
        <div class="flex flex-wrap gap-2" data-testid="dock-options">
          @for (option of pending.options; track option.id; let i = $index) {
            <button
              type="button"
              hlmBtn
              [variant]="i === 0 ? 'default' : 'outline'"
              size="sm"
              data-testid="dock-option"
              (click)="answer.emit(option.id)"
            >
              <span>{{ option.label }}</span>
              @if (i < 4) {
                <kbd hlmKbd class="ml-1 font-mono font-normal">{{ i + 1 }}</kbd>
              }
            </button>
          }
        </div>
      </div>
    } @else if (plan(); as plan) {
      <button
        type="button"
        class="flex flex-col gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
        (click)="expanded.set(!expanded())"
        [attr.aria-expanded]="expanded()"
      >
        <span class="text-muted-foreground" i18n>
          Plan {{ completed() }} of {{ total() }} · {{ currentEntry()?.content }}
        </span>
        <span class="flex w-full gap-1" aria-hidden="true">
          @for (entry of plan.entries; track $index) {
            <span
              data-plan-segment
              class="h-1 flex-1 rounded-full"
              [class.bg-primary]="entry.status === 'completed'"
              [class.bg-muted]="entry.status !== 'completed'"
            ></span>
          }
        </span>
      </button>
      @if (expanded()) {
        <div class="border-border border rounded-md px-3 py-2">
          @for (entry of plan.entries; track $index) {
            <div class="flex items-center gap-2 py-1 text-sm">
              <span
                class="size-2 shrink-0 rounded-full"
                [class.bg-primary]="entry.status === 'completed'"
                [class.bg-muted]="entry.status !== 'completed'"
              ></span>
              <span [class.line-through]="entry.status === 'completed'">{{ entry.content }}</span>
            </div>
          }
        </div>
      }
    }
  `,
})
export class Dock {
  readonly permission = input<DockPermission | null>(null);
  readonly plan = input<Plan | null>(null);
  readonly sessionCwd = input<string | null>(null);
  readonly answer = output<string>();

  protected readonly expanded = signal(false);
  protected readonly hunksForDiff = hunksForDiff;

  protected readonly completed = computed(() => {
    const plan = this.plan();
    return plan === null ? 0 : completedPlanCount(plan);
  });

  protected readonly total = computed(() => this.plan()?.entries.length ?? 0);

  protected readonly currentEntry = computed(() => {
    const plan = this.plan();
    return plan === null ? undefined : currentPlanEntry(plan);
  });

  protected executeCommand(pending: DockPermission, step: Step): string {
    return step.input !== undefined && step.input !== '' ? step.input : pending.title;
  }

  protected hasDistinctExecuteTitle(pending: DockPermission, step: Step): boolean {
    const command = this.executeCommand(pending, step);
    return pending.title !== '' && pending.title !== command;
  }

  protected executeCwd(step: Step): string | null {
    const cwd = step.cwd ?? this.sessionCwd();
    return cwd !== null && cwd !== '' ? cwd : null;
  }
}
