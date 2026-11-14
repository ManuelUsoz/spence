import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Effect, Exit } from 'effect';
import { HlmButtonImports } from '@ui/button';
import { HlmNativeSelectImports } from '@ui/native-select';
import { HlmTextareaImports } from '@ui/textarea';
import type { AgentId } from '../../../shared/agents/agents.rpc';
import { computeHandoffBudget } from '../../../shared/sessions/handoff';
import type {
  CancelGrace,
  HandoffAttempt,
  HandoffCompatibility,
  HandoffKind,
  HandoffPreparation,
  HandoffSourceEndpoint,
  SessionId,
} from '../../../shared/sessions/sessions.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';

export type HandoffPhase = 'preparing' | 'review' | 'starting' | 'failed' | 'success';

const prepareHandoff = Effect.fnUntraced(function* (
  sessionId: SessionId,
  kind: HandoffKind,
  targetAgentId?: AgentId,
  targetModel?: string,
) {
  const api = yield* DesktopApi;
  return yield* api['Session.prepareHandoff']({
    sessionId,
    kind,
    ...(targetAgentId === undefined ? {} : { targetAgentId }),
    ...(targetModel === undefined ? {} : { targetModel }),
  });
});

const revalidateHandoff = Effect.fnUntraced(function* (input: {
  readonly sessionId: SessionId;
  readonly endpoint: HandoffSourceEndpoint;
  readonly targetAgentId: AgentId;
  readonly targetModel?: string;
  readonly summary: string;
  readonly selectedImageIds: ReadonlyArray<string>;
}) {
  const api = yield* DesktopApi;
  return yield* api['Session.revalidateHandoff'](input);
});

const executeHandoff = Effect.fnUntraced(function* (input: {
  readonly sessionId: SessionId;
  readonly kind: HandoffKind;
  readonly endpoint: HandoffSourceEndpoint;
  readonly targetAgentId: AgentId;
  readonly targetModel?: string;
  readonly summary: string;
  readonly selectedImageIds: ReadonlyArray<string>;
  readonly allowEndpointAdvance?: boolean;
}) {
  const api = yield* DesktopApi;
  return yield* api['Session.executeHandoff'](input);
});

const cancelHandoff = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Session.cancel']({ sessionId });
});

const stopHandoffAgent = Effect.fnUntraced(function* (sessionId: SessionId, force = false) {
  const api = yield* DesktopApi;
  return yield* api['Session.stopAgent']({ sessionId, force });
});

/**
 * Reviewed Summary handoff dialog for Switch Agent, Model change (`modelChangePreservesContext: false`),
 * `memoryLost` recovery, and Fork (#76).
 */
@Component({
  selector: 'app-handoff-dialog',
  imports: [HlmButtonImports, HlmNativeSelectImports, HlmTextareaImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="bg-background/90 fixed inset-0 z-50 flex items-center justify-center p-4"
      data-testid="handoff-backdrop"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="handoff-dialog-title"
        data-testid="handoff-dialog"
        class="border-border bg-background flex max-h-[90vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-xl border p-6 shadow-lg"
      >
        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 id="handoff-dialog-title" class="text-lg font-medium">
              @switch (kind()) {
                @case ('switch') {
                  <span i18n>Switch Agent</span>
                }
                @case ('modelChange') {
                  <span i18n>Switch Model via Summary handoff</span>
                }
                @case ('memoryLost') {
                  <span i18n>Prepare summary handoff</span>
                }
                @case ('fork') {
                  <span i18n>Fork Session</span>
                }
              }
            </h2>
            <p class="text-muted-foreground mt-1 text-sm">
              @if (kind() === 'fork') {
                <span i18n
                  >Start a linked Session in the same Project from a reviewed summary.</span
                >
              } @else {
                <span i18n
                  >Keep this Session and Transcript. Give the incoming context a reviewed
                  summary.</span
                >
              }
            </p>
          </div>
          <button
            hlmBtn
            type="button"
            variant="ghost"
            size="sm"
            data-testid="handoff-close"
            [disabled]="phase() === 'starting'"
            (click)="closed.emit()"
            i18n
          >
            Close
          </button>
        </div>

        @if (phase() === 'preparing') {
          <p class="text-muted-foreground py-6 text-sm" data-testid="handoff-preparing" i18n>
            Preparing summary…
          </p>
        } @else if (prepareError(); as err) {
          <div class="border-destructive/50 bg-destructive/10 rounded-md border p-3 text-sm">
            <p class="text-destructive font-medium" i18n>Could not prepare Summary handoff</p>
            <p class="text-muted-foreground mt-1">{{ err }}</p>
          </div>
          <div class="flex justify-end gap-2">
            <button hlmBtn type="button" variant="outline" (click)="closed.emit()" i18n>
              Cancel
            </button>
            <button hlmBtn type="button" (click)="loadPreparation()" i18n>Try again</button>
          </div>
        } @else if (preparation(); as prep) {
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1 text-sm">
              <span class="font-medium" i18n>Destination Agent</span>
              <select
                #agentSelect
                hlmNativeSelect
                data-testid="handoff-agent-select"
                [value]="selectedAgentId() ?? ''"
                [disabled]="
                  kind() === 'modelChange' || kind() === 'memoryLost' || phase() === 'starting'
                "
                (change)="onAgentChange(agentSelect.value)"
              >
                @for (dest of prep.destinations; track dest.agentId) {
                  <option [value]="dest.agentId" [disabled]="!dest.installed">
                    {{ dest.agentName }}
                    @if (!dest.installed) {
                      (<span i18n>not installed</span>)
                    }
                  </option>
                }
              </select>
            </label>

            <label class="flex flex-col gap-1 text-sm">
              <span class="font-medium" i18n>Model</span>
              @if (availableModels().length > 0) {
                <select
                  #modelSelect
                  hlmNativeSelect
                  data-testid="handoff-model-select"
                  [value]="selectedModel() ?? ''"
                  [disabled]="phase() === 'starting'"
                  (change)="onModelChange(modelSelect.value)"
                >
                  @if (selectedModel() === undefined) {
                    <option value="" disabled i18n>Select a Model…</option>
                  }
                  @for (model of availableModels(); track model.id) {
                    <option [value]="model.id">{{ model.name }}</option>
                  }
                </select>
              } @else {
                <div
                  class="border-border bg-muted text-muted-foreground rounded-md border px-3 py-2 text-sm"
                  data-testid="handoff-model-readonly"
                >
                  {{ selectedModel() ?? 'Default model' }}
                </div>
              }
            </label>
          </div>

          @if (selectedCompatibility(); as compat) {
            <div class="bg-muted/60 flex flex-col gap-1 rounded-md px-3 py-2 text-xs">
              <p class="text-muted-foreground">
                @if (compat.resolvedPermissionMode === 'ask') {
                  <span i18n>Permission mode: Ask</span>
                } @else {
                  <span i18n>Permission mode: Auto</span>
                }
                @if (compat.resolvedEffort; as effort) {
                  <span> · </span><span i18n>Effort: {{ effort }}</span>
                }
                <span> · </span>
                <span i18n>Source: Turn {{ prep.endpoint.turnNumber }}</span>
              </p>
              @if (compat.modelMismatchNote; as note) {
                <p class="text-destructive" data-testid="handoff-model-note">{{ note }}</p>
              }
              @if (compat.effortNote; as note) {
                <p class="text-muted-foreground" data-testid="handoff-effort-note">{{ note }}</p>
              }
              @if (compat.permissionNote; as note) {
                <p class="text-muted-foreground" data-testid="handoff-permission-note">
                  {{ note }}
                </p>
              }
              @if (compat.unconfirmedExit; as unconfirmed) {
                <p class="text-destructive" data-testid="handoff-exit-note" i18n>
                  Waiting for {{ compat.agentName }} process exit confirmation (PID
                  {{ unconfirmed.pid ?? 'unknown' }}).
                </p>
              }
            </div>
          }

          @if (endpointAdvanced()) {
            <div
              class="border-destructive/50 bg-destructive/10 flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
              data-testid="handoff-endpoint-advanced"
            >
              <span i18n
                >New Messages arrived on the source Session since this summary was prepared.</span
              >
              <div class="flex gap-2">
                <button
                  hlmBtn
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="handoff-regenerate"
                  (click)="loadPreparation()"
                  i18n
                >
                  Regenerate
                </button>
                <button
                  hlmBtn
                  type="button"
                  size="sm"
                  data-testid="handoff-accept-endpoint"
                  (click)="endpointAccepted.set(true)"
                  i18n
                >
                  Review against new endpoint
                </button>
              </div>
            </div>
          }

          <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between gap-2 text-sm">
              <label for="handoff-summary-input" class="font-medium" i18n>
                Review and edit summary
              </label>
              <span class="text-muted-foreground text-xs" data-testid="handoff-draft-source">
                @if (prep.draftSource === 'isolatedSummary') {
                  <span i18n>Drafted in isolated tool-free session</span>
                } @else {
                  <span i18n>Structured Transcript extract</span>
                }
              </span>
            </div>
            @if (prep.fallbackReason; as reason) {
              <p class="text-muted-foreground text-xs" data-testid="handoff-fallback-reason">
                {{ reason }}
              </p>
            }
            <textarea
              #summaryInput
              id="handoff-summary-input"
              hlmTextarea
              rows="8"
              class="min-h-40 text-sm"
              data-testid="handoff-summary-input"
              [value]="summary()"
              [disabled]="phase() === 'starting'"
              (input)="summary.set(summaryInput.value)"
            ></textarea>
            <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span
                class="tabular-nums"
                [class]="
                  budget().overBudget ? 'text-destructive font-medium' : 'text-muted-foreground'
                "
                data-testid="handoff-budget"
              >
                @if (budget().knownCapacity) {
                  <span i18n
                    >{{ budget().estimatedTokens }} / {{ budget().capTokens }} tokens (10% capacity
                    cap)</span
                  >
                } @else {
                  <span i18n
                    >{{ budget().estimatedTokens }} / {{ budget().capTokens }} tokens (provisional
                    estimated cap)</span
                  >
                }
              </span>
              @if (budget().overBudget) {
                <span
                  class="text-destructive font-medium"
                  data-testid="handoff-budget-overflow"
                  i18n
                >
                  Summary exceeds token budget; shorten it before confirming.
                </span>
              }
            </div>
          </div>

          @if (prep.images.length > 0) {
            <div class="flex flex-col gap-1.5" data-testid="handoff-images-section">
              <p class="text-sm font-medium" i18n>Original Images from source Messages</p>
              <div class="flex flex-col gap-1.5">
                @for (image of prep.images; track image.id) {
                  @let blockedReason = blockedReasonFor(image.id);
                  <label
                    class="border-border flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs"
                  >
                    <span class="flex items-center gap-2">
                      <input
                        type="checkbox"
                        [attr.data-testid]="'handoff-image-' + image.id"
                        [checked]="isImageSelected(image.id)"
                        [disabled]="blockedReason !== undefined || phase() === 'starting'"
                        (change)="toggleImage(image.id)"
                      />
                      <span class="font-mono">{{ image.mimeType }}</span>
                      <span class="text-muted-foreground" i18n>Turn {{ image.turnId }}</span>
                    </span>
                    @if (blockedReason; as reason) {
                      <span
                        class="text-destructive"
                        [attr.data-testid]="'handoff-image-blocked-' + image.id"
                      >
                        {{ reason }}
                      </span>
                    }
                  </label>
                }
              </div>
            </div>
          }

          @if (phase() === 'starting') {
            <div
              class="bg-muted flex flex-wrap items-center justify-between gap-2 rounded-md p-3 text-sm"
              data-testid="handoff-starting"
            >
              <span i18n>Waiting for destination acknowledgement. Source unchanged.</span>
              <div class="flex gap-2">
                <button
                  hlmBtn
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="handoff-cancel-startup"
                  (click)="onCancelStartup()"
                  i18n
                >
                  Cancel
                </button>
                @if (cancelGrace()?.phase === 'ready') {
                  <button
                    hlmBtn
                    type="button"
                    size="sm"
                    variant="destructive"
                    data-testid="handoff-stop-agent"
                    (click)="onStopAgent()"
                    i18n
                  >
                    Stop Agent
                  </button>
                }
              </div>
            </div>
          }

          @if (phase() === 'failed' && lastAttempt(); as attempt) {
            <div
              class="border-destructive/50 bg-destructive/10 flex flex-col gap-2 rounded-md border p-3 text-sm"
              data-testid="handoff-failed"
            >
              <p class="text-destructive font-medium" i18n>
                Handoff failed ({{ attempt.status }}). Source Agent is unchanged.
              </p>
              <p class="text-muted-foreground" data-testid="handoff-failure-reason">
                {{ attempt.failureReason }}
              </p>
              @if (attempt.diskStateNote; as diskNote) {
                <p class="text-muted-foreground text-xs" data-testid="handoff-disk-note">
                  {{ diskNote }}
                </p>
              }
              @if (attempt.steps.length > 0) {
                <ul class="text-muted-foreground list-disc pl-5 text-xs">
                  @for (step of attempt.steps; track step.id) {
                    <li>{{ step.title }} ({{ step.status }})</li>
                  }
                </ul>
              }
            </div>
          }

          @if (actionError(); as err) {
            <p class="text-destructive text-sm" data-testid="handoff-action-error">{{ err }}</p>
          }

          @if (attempts().length > 0) {
            <details
              class="border-border rounded-md border px-3 py-2 text-xs"
              data-testid="handoff-attempts-history"
            >
              <summary class="cursor-pointer font-medium" i18n>
                Previous failed handoff attempts ({{ attempts().length }})
              </summary>
              <div class="mt-2 flex flex-col gap-2">
                @for (item of attempts(); track item.id) {
                  <div class="border-border border-t pt-2">
                    <p class="font-medium">{{ item.targetAgentName }} · {{ item.status }}</p>
                    <p class="text-muted-foreground">{{ item.failureReason }}</p>
                    @if (item.diskStateNote; as note) {
                      <p class="text-muted-foreground">{{ note }}</p>
                    }
                  </div>
                }
              </div>
            </details>
          }

          <div class="flex justify-end gap-2 pt-2">
            <button
              hlmBtn
              type="button"
              variant="outline"
              data-testid="handoff-cancel"
              [disabled]="phase() === 'starting'"
              (click)="closed.emit()"
              i18n
            >
              Cancel
            </button>
            <button
              hlmBtn
              type="button"
              data-testid="handoff-confirm"
              [disabled]="!canConfirm()"
              (click)="onConfirm()"
            >
              @if (phase() === 'failed') {
                <span i18n>Retry handoff</span>
              } @else if (kind() === 'fork') {
                <span i18n>Create Fork</span>
              } @else {
                <span i18n>Confirm handoff</span>
              }
            </button>
          </div>
        }
      </section>
    </div>
  `,
})
export class HandoffDialog {
  private readonly runtime = inject(EffectRuntime);

  readonly sessionId = input.required<SessionId>();
  readonly kind = input.required<HandoffKind>();
  readonly targetAgentId = input<AgentId | undefined>(undefined);
  readonly targetModel = input<string | undefined>(undefined);
  readonly cancelGrace = input<CancelGrace | undefined>(undefined);
  readonly attempts = input<ReadonlyArray<HandoffAttempt>>([]);

  readonly closed = output<void>();
  readonly committed = output<{ readonly contextId: string; readonly forkSessionId?: SessionId }>();
  readonly attemptRecorded = output<HandoffAttempt>();

  protected readonly phase = signal<HandoffPhase>('preparing');
  protected readonly preparation = signal<HandoffPreparation | null>(null);
  protected readonly prepareError = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  protected readonly selectedAgentId = signal<AgentId | undefined>(undefined);
  protected readonly selectedModel = signal<string | undefined>(undefined);
  protected readonly summary = signal('');
  protected readonly selectedImageIds = signal<ReadonlyArray<string>>([]);
  protected readonly endpoint = signal<HandoffSourceEndpoint | null>(null);
  protected readonly endpointAdvanced = signal(false);
  protected readonly endpointAccepted = signal(false);
  protected readonly revalidatedCompat = signal<HandoffCompatibility | null>(null);
  protected readonly lastAttempt = signal<HandoffAttempt | null>(null);

  protected readonly selectedCompatibility = computed<HandoffCompatibility | null>(() => {
    const reval = this.revalidatedCompat();
    if (reval !== null) return reval;
    const prep = this.preparation();
    const agentId = this.selectedAgentId();
    if (prep === null || agentId === undefined) return null;
    return prep.destinations.find((d) => d.agentId === agentId) ?? null;
  });

  protected readonly availableModels = computed(
    () => this.selectedCompatibility()?.availableModels ?? [],
  );

  protected readonly budget = computed(() =>
    computeHandoffBudget(this.summary(), this.selectedCompatibility()?.destinationCapacity),
  );

  protected readonly canConfirm = computed(() => {
    if (this.phase() !== 'review' && this.phase() !== 'failed') return false;
    const compat = this.selectedCompatibility();
    if (compat === null || !compat.canRun || compat.unconfirmedExit !== undefined) return false;
    if (this.availableModels().length > 0 && this.selectedModel() === undefined) return false;
    if (this.summary().trim().length === 0 || this.budget().overBudget) return false;
    if (this.endpointAdvanced() && !this.endpointAccepted()) return false;
    const blocked = new Set(compat.blockedImages.map((b) => b.imageId));
    if (this.selectedImageIds().some((id) => blocked.has(id))) return false;
    return true;
  });

  constructor() {
    effect(() => {
      this.sessionId();
      this.kind();
      this.targetAgentId();
      this.targetModel();
      void this.loadPreparation();
    });
  }

  protected async loadPreparation(): Promise<void> {
    this.phase.set('preparing');
    this.prepareError.set(null);
    this.actionError.set(null);
    this.endpointAdvanced.set(false);
    this.endpointAccepted.set(false);
    this.revalidatedCompat.set(null);

    const exit = await this.runtime.run(
      prepareHandoff(this.sessionId(), this.kind(), this.targetAgentId(), this.targetModel()),
    );
    if (Exit.isFailure(exit)) {
      this.prepareError.set(String(exit.cause));
      return;
    }
    const prep = exit.value;
    this.preparation.set(prep);
    this.endpoint.set(prep.endpoint);
    this.summary.set(prep.summary);
    this.selectedAgentId.set(prep.defaultDestinationAgentId);
    const defaultCompat = prep.destinations.find(
      (d) => d.agentId === prep.defaultDestinationAgentId,
    );
    this.selectedModel.set(prep.requestedModel ?? defaultCompat?.resolvedModel);
    const blocked = new Set((defaultCompat?.blockedImages ?? []).map((b) => b.imageId));
    this.selectedImageIds.set(
      prep.images.filter((img) => !blocked.has(img.id)).map((img) => img.id),
    );
    this.phase.set('review');
  }

  protected onAgentChange(rawId: string): void {
    const prep = this.preparation();
    if (prep === null) return;
    const dest = prep.destinations.find((d) => d.agentId === rawId);
    if (dest === undefined) return;
    this.selectedAgentId.set(dest.agentId);
    this.selectedModel.set(dest.resolvedModel);
    this.revalidatedCompat.set(null);
    const blocked = new Set(dest.blockedImages.map((b) => b.imageId));
    this.selectedImageIds.update((ids) => ids.filter((id) => !blocked.has(id)));
  }

  protected onModelChange(value: string): void {
    this.selectedModel.set(value === '' ? undefined : value);
    this.revalidatedCompat.set(null);
  }

  protected isImageSelected(id: string): boolean {
    return this.selectedImageIds().includes(id);
  }

  protected toggleImage(id: string): void {
    this.selectedImageIds.update((ids) =>
      ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id],
    );
  }

  protected blockedReasonFor(imageId: string): string | undefined {
    return this.selectedCompatibility()?.blockedImages.find((b) => b.imageId === imageId)?.reason;
  }

  protected async onConfirm(): Promise<void> {
    const ep = this.endpoint();
    const targetAgentId = this.selectedAgentId();
    if (ep === null || targetAgentId === undefined) return;

    this.actionError.set(null);
    // Revalidate source endpoint, capabilities, `'exit'` confirmation, and budget before starting.
    const revalExit = await this.runtime.run(
      revalidateHandoff({
        sessionId: this.sessionId(),
        endpoint: ep,
        targetAgentId,
        ...(this.selectedModel() === undefined ? {} : { targetModel: this.selectedModel() }),
        summary: this.summary(),
        selectedImageIds: this.selectedImageIds(),
      }),
    );
    if (Exit.isFailure(revalExit)) {
      this.actionError.set($localize`Could not revalidate handoff requirements.`);
      return;
    }
    const reval = revalExit.value;
    this.revalidatedCompat.set(reval.compatibility);
    if (reval.endpointAdvanced && !this.endpointAccepted()) {
      this.endpointAdvanced.set(true);
      this.endpoint.set(reval.currentEndpoint);
      return;
    }
    if (!reval.compatibility.canRun || reval.compatibility.unconfirmedExit !== undefined) {
      this.actionError.set($localize`Destination Agent is not ready or exit is unconfirmed.`);
      return;
    }
    if (reval.budget.overBudget) {
      this.actionError.set($localize`Summary exceeds the token budget.`);
      return;
    }

    this.phase.set('starting');
    const execExit = await this.runtime.run(
      executeHandoff({
        sessionId: this.sessionId(),
        kind: this.kind(),
        endpoint: reval.currentEndpoint,
        targetAgentId,
        ...(this.selectedModel() === undefined ? {} : { targetModel: this.selectedModel() }),
        summary: this.summary(),
        selectedImageIds: this.selectedImageIds(),
        allowEndpointAdvance: this.endpointAccepted() || reval.endpointAdvanced,
      }),
    );
    if (Exit.isFailure(execExit)) {
      this.phase.set('failed');
      this.actionError.set($localize`Handoff could not start.`);
      return;
    }
    const result = execExit.value;
    if (result._tag === 'committed') {
      this.phase.set('success');
      this.committed.emit({
        contextId: result.contextId,
        ...(result.forkSessionId === undefined ? {} : { forkSessionId: result.forkSessionId }),
      });
      return;
    }
    this.lastAttempt.set(result.attempt);
    this.attemptRecorded.emit(result.attempt);
    this.phase.set('failed');
  }

  protected onCancelStartup(): void {
    void this.runtime.run(cancelHandoff(this.sessionId()));
  }

  protected onStopAgent(): void {
    void this.runtime.run(stopHandoffAgent(this.sessionId(), true));
  }
}
