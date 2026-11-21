import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { AgentTile } from '@ui/agent-tile';
import { HlmBadgeImports } from '@ui/badge';
import { HlmKbdImports } from '@ui/kbd';
import { HlmTooltipImports } from '@ui/tooltip';
import type { Effort, Model } from '../../../shared/agents/agents.rpc';
import { Keymap } from '../../core/keymap';

export interface PaletteAgent {
  readonly id: string;
  readonly name: string;
  readonly crossDeviceTools: boolean;
}

export interface ModelOptionState {
  readonly value?: string;
  readonly choices: ReadonlyArray<Model>;
}

export interface EffortOptionState {
  readonly value: Effort;
  readonly choices: ReadonlyArray<Effort>;
}

export const PALETTE_EFFORT_LEVELS: ReadonlyArray<Effort> = ['low', 'medium', 'high', 'max'];

const EFFORT_BARS: Readonly<Record<Effort, 1 | 2 | 3 | 4>> = {
  low: 1,
  medium: 2,
  high: 3,
  max: 4,
};

const EFFORT_ALIASES: Readonly<Record<string, Effort>> = {
  low: 'low',
  '@low': 'low',
  med: 'medium',
  medium: 'medium',
  '@med': 'medium',
  '@medium': 'medium',
  high: 'high',
  '@high': 'high',
  max: 'max',
  '@max': 'max',
};

/** Splits a search query into model/agent filter terms and an optional trailing effort keyword (e.g. "sonnet max"). */
export function parseModelPaletteQuery(raw: string): {
  readonly terms: ReadonlyArray<string>;
  readonly effort: Effort | null;
} {
  const tokens = raw
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  let effort: Effort | null = null;
  const terms: Array<string> = [];
  for (const token of tokens) {
    const matched = EFFORT_ALIASES[token];
    if (matched !== undefined) {
      effort = matched;
    } else {
      terms.push(token);
    }
  }
  return { terms, effort };
}

/**
 * Searchable Agent, Model & Effort command palette for the Composer: supports cross-term filtering, inline effort
 * keywords (e.g. `sonnet max`), and a zero-height-jump 4-bar scrub meter.
 */
@Component({
  selector: 'app-model-palette',
  imports: [AgentTile, HlmBadgeImports, HlmKbdImports, HlmTooltipImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:pointerdown)': 'onWindowPointerDown($event)',
    '(window:pointerup)': 'onWindowPointerUp()',
  },
  template: `
    <div class="relative inline-flex items-center">
      <button
        #triggerBtn
        type="button"
        data-testid="model-picker"
        class="hover:bg-accent focus-visible:ring-ring border-input flex h-8 items-center gap-2 rounded-full border ps-1 pe-2.5 text-xs outline-none focus-visible:ring-2"
        aria-haspopup="dialog"
        [attr.aria-expanded]="open()"
        [attr.aria-label]="pickerLabel()"
        [hlmTooltip]="modelTip"
        position="top"
        (click)="toggle()"
      >
        <app-agent-tile [agentId]="activeAgentId()" [name]="agentName()" size="sm" />
        @if (modelsSupported() && model()) {
          <span>{{ modelName() }}</span>
        } @else {
          <span>{{ agentName() }}</span>
        }
        @if (effortSupported() && effort(); as effortOption) {
          @let activeBars = barsFor(effortOption.value);
          <span class="text-muted-foreground inline-flex items-center gap-1">
            <svg aria-hidden="true" class="size-3" viewBox="0 0 16 14" fill="currentColor">
              <rect
                x="1"
                y="9"
                width="2.5"
                height="4"
                rx="0.75"
                [attr.opacity]="activeBars >= 1 ? 1 : 0.25"
              />
              <rect
                x="4.8"
                y="6.5"
                width="2.5"
                height="6.5"
                rx="0.75"
                [attr.opacity]="activeBars >= 2 ? 1 : 0.25"
              />
              <rect
                x="8.6"
                y="3.8"
                width="2.5"
                height="9.2"
                rx="0.75"
                [attr.opacity]="activeBars >= 3 ? 1 : 0.25"
              />
              <rect
                x="12.4"
                y="1"
                width="2.5"
                height="12"
                rx="0.75"
                [attr.opacity]="activeBars >= 4 ? 1 : 0.25"
              />
            </svg>
            <span data-testid="effort-current">{{ effortLabel(effortOption.value) }}</span>
          </span>
        }
        <svg
          class="text-muted-foreground size-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <ng-template #modelTip>
        <span class="inline-flex items-center gap-1.5">
          <span i18n>Model</span>
          <kbd hlmKbd class="font-mono font-normal">{{
            keymap.format({ mod: true, shift: true, key: 'm' })
          }}</kbd>
        </span>
      </ng-template>

      @if (open()) {
        <div
          role="dialog"
          data-testid="agent-menu"
          [attr.aria-label]="pickerLabel()"
          class="bg-popover text-popover-foreground ring-foreground/10 absolute bottom-full left-0 z-40 mb-2 flex w-[28rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl shadow-lg ring-1"
        >
          <!-- Search input + parsed effort indicator -->
          <div class="border-border/60 flex items-center gap-2 border-b px-3 py-2.5">
            <svg
              aria-hidden="true"
              class="text-muted-foreground size-3.5 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              #searchInput
              type="text"
              data-testid="model-palette-search"
              class="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
              [placeholder]="searchPlaceholder()"
              [value]="query()"
              (input)="onSearch(searchInput.value)"
              (keydown)="onSearchKeydown($event)"
            />
            @if (parsed().effort; as parsedEffort) {
              @if (effortSupported() && effort()?.choices?.includes(parsedEffort)) {
                <span
                  class="bg-primary text-primary-foreground inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                >
                  {{ effortLabel(parsedEffort) }}
                </span>
              }
            }
            @if (query() !== '') {
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground shrink-0 text-xs"
                (click)="onSearch('')"
                i18n
              >
                Clear
              </button>
            }
          </div>

          @if (modelsLimitation(); as limitation) {
            <p
              class="border-border/60 bg-muted/50 text-muted-foreground border-b px-3 py-1.5 text-xs"
            >
              {{ limitation }}
            </p>
          }

          <div class="max-h-80 overflow-y-auto p-1.5">
            <!-- Active Agent's Models -->
            <div class="flex items-center justify-between gap-2 px-2 pt-1.5 pb-1">
              <span class="text-muted-foreground flex items-center gap-1.5 text-[11px] font-medium">
                <app-agent-tile [agentId]="activeAgentId()" [name]="agentName()" size="sm" />
                <span>{{ agentName() }}</span>
              </span>
              @if (showHandoffNote()) {
                <span class="text-muted-foreground text-[11px]" i18n
                  >Model switch opens handoff</span
                >
              }
            </div>

            @if (!modelsSupported()) {
              <p
                class="text-muted-foreground px-2.5 py-2 text-xs"
                data-testid="models-unavailable"
                i18n
              >
                Model selection isn't available for {{ agentName() }}
              </p>
            } @else if (model(); as modelOption) {
              @for (choice of filteredModels(); track choice.id) {
                @let isSelected = choice.id === modelOption.value;
                @let isHighlighted = activeHighlightId() === choice.id;
                @let showMeter =
                  effortSupported() && effort() !== undefined && meterChoiceId() === choice.id;
                <div
                  class="flex items-center gap-2 rounded-xl px-2.5 py-2 transition-colors"
                  [class.bg-accent]="isHighlighted || isSelected"
                  (mouseenter)="onModelHover(choice.id)"
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    class="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 text-start text-sm outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
                    [attr.aria-checked]="isSelected"
                    [attr.data-checked]="isSelected ? '' : null"
                    [disabled]="controlsDisabled()"
                    [attr.data-testid]="'model-option-' + choice.id"
                    (click)="pickModel(choice.id)"
                  >
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span class="flex items-center gap-1.5 font-medium">
                        <span class="truncate">{{ choice.name }}</span>
                        @if (showHandoffNote() && !isSelected) {
                          <span hlmBadge variant="outline" i18n>Handoff</span>
                        }
                      </span>
                      @if (choice.description; as description) {
                        <span class="text-muted-foreground truncate text-xs">{{
                          description
                        }}</span>
                      }
                    </span>
                  </button>

                  @if (showMeter) {
                    @if (effort(); as effortOption) {
                      @let shownEffort = displayedEffort(effortOption);
                      @let activeBars = barsFor(shownEffort);
                      <div
                        role="radiogroup"
                        aria-labelledby="effort-label"
                        class="bg-background/85 border-border/80 flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1"
                        (mouseleave)="hoveredEffort.set(null)"
                      >
                        <span id="effort-label" class="sr-only" i18n>Effort</span>
                        <div class="flex items-end gap-0.5">
                          @for (level of effortLevels; track level; let idx = $index) {
                            @let offered = effortOption.choices.includes(level);
                            @let lit = barsFor(level) <= activeBars;
                            <button
                              type="button"
                              role="radio"
                              [attr.aria-checked]="level === effortOption.value"
                              [attr.aria-label]="effortLabel(level)"
                              [disabled]="controlsDisabled() || !offered"
                              [attr.title]="
                                offered ? effortLabel(level) : unavailableLevelTooltip()
                              "
                              [attr.data-testid]="'effort-' + level"
                              class="focus-visible:ring-ring flex h-5 w-2.5 items-end justify-center rounded-xs outline-none focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-25"
                              (pointerdown)="startEffortScrub($event, choice.id, level, offered)"
                              (pointerenter)="onEffortPointerEnter(choice.id, level, offered)"
                              (click)="pickEffort(choice.id, level, offered)"
                            >
                              <span
                                class="w-1.5 rounded-xs transition-all"
                                [style.height.px]="5 + idx * 3"
                                [class.bg-foreground]="lit"
                                [class.bg-muted-foreground/30]="!lit"
                              ></span>
                            </button>
                          }
                        </div>
                        <span
                          class="text-foreground w-10 text-end text-[11px] font-medium tabular-nums"
                        >
                          {{ effortShort(shownEffort) }}
                        </span>
                      </div>
                    }
                  } @else if (isSelected) {
                    <svg
                      class="size-4 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  }
                </div>
              } @empty {
                @if (modelOption.choices.length > 0) {
                  <p class="text-muted-foreground px-2.5 py-2 text-xs" i18n>
                    No models match this filter.
                  </p>
                }
              }
            }

            <!-- Effort row when Effort is unavailable, or when no Models are offered to host the inline meter -->
            @if (!effortSupported()) {
              <div
                class="border-border/60 mt-1 flex items-center justify-between gap-2 border-t px-2.5 py-2"
              >
                <span class="text-muted-foreground text-xs" i18n>Effort</span>
                <span class="text-muted-foreground text-xs" data-testid="effort-unavailable" i18n>
                  Effort selection isn't available for {{ agentName() }}
                </span>
              </div>
            } @else if (needsStandaloneEffort()) {
              @if (effort(); as effortOption) {
                @let shownEffort = displayedEffort(effortOption);
                @let activeBars = barsFor(shownEffort);
                <div
                  class="border-border/60 mt-1 flex items-center justify-between gap-3 border-t px-2.5 py-2"
                >
                  <span id="effort-label" class="text-muted-foreground text-xs" i18n>Effort</span>
                  <div
                    role="radiogroup"
                    aria-labelledby="effort-label"
                    class="bg-background/85 border-border/80 flex items-center gap-1.5 rounded-lg border px-2 py-1"
                    (mouseleave)="hoveredEffort.set(null)"
                  >
                    <div class="flex items-end gap-0.5">
                      @for (level of effortLevels; track level; let idx = $index) {
                        @let offered = effortOption.choices.includes(level);
                        @let lit = barsFor(level) <= activeBars;
                        <button
                          type="button"
                          role="radio"
                          [attr.aria-checked]="level === effortOption.value"
                          [attr.aria-label]="effortLabel(level)"
                          [disabled]="controlsDisabled() || !offered"
                          [attr.title]="offered ? effortLabel(level) : unavailableLevelTooltip()"
                          [attr.data-testid]="'effort-' + level"
                          class="focus-visible:ring-ring flex h-5 w-2.5 items-end justify-center rounded-xs outline-none focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-25"
                          (pointerdown)="startEffortScrub($event, null, level, offered)"
                          (pointerenter)="onEffortPointerEnter(null, level, offered)"
                          (click)="pickEffort(null, level, offered)"
                        >
                          <span
                            class="w-1.5 rounded-xs transition-all"
                            [style.height.px]="5 + idx * 3"
                            [class.bg-foreground]="lit"
                            [class.bg-muted-foreground/30]="!lit"
                          ></span>
                        </button>
                      }
                    </div>
                    <span
                      class="text-foreground w-10 text-end text-[11px] font-medium tabular-nums"
                    >
                      {{ effortShort(shownEffort) }}
                    </span>
                  </div>
                </div>
              }
            }

            <!-- Catalog Agents / Vendors -->
            @if (filteredAgents().length > 0) {
              <div class="border-border/60 mt-1 border-t pt-1.5">
                <div class="flex items-center justify-between px-2 pb-1">
                  <span class="text-muted-foreground text-[11px] font-medium" i18n>Agents</span>
                  @if (!canSwitchAgent() && menuAgents().length > 1) {
                    <span class="text-muted-foreground text-[11px]" i18n>
                      The Agent is fixed once the first Turn has run.
                    </span>
                  }
                </div>
                <div role="tablist" aria-orientation="vertical" class="flex flex-col gap-0.5">
                  @for (agent of filteredAgents(); track agent.id) {
                    @let active = agent.id === activeAgentId();
                    <button
                      type="button"
                      role="tab"
                      class="hover:bg-accent focus-visible:ring-ring flex h-10 items-center gap-2.5 rounded-xl px-2.5 text-start text-sm outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
                      [class.bg-accent]="active"
                      [attr.aria-selected]="active"
                      [disabled]="!active && !canSwitchAgent()"
                      [attr.data-testid]="'agent-option-' + agent.id"
                      (click)="pickAgent(agent.id)"
                    >
                      <app-agent-tile [agentId]="agent.id" [name]="agent.name" />
                      <span class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate" [class.font-medium]="active">{{ agent.name }}</span>
                        @if (!agent.crossDeviceTools) {
                          <span
                            class="text-muted-foreground truncate text-xs"
                            data-testid="no-cross-device-tools"
                            i18n
                            >No cross-device tools</span
                          >
                        }
                      </span>
                      @if (active) {
                        <span class="text-muted-foreground text-[11px]" i18n>Active</span>
                      }
                    </button>
                  }
                </div>
              </div>
            }
          </div>

          <div
            class="border-border/60 bg-muted/30 text-muted-foreground flex items-center justify-between border-t px-3 py-1.5 text-[11px]"
          >
            <span class="flex items-center gap-2">
              <span class="inline-flex items-center gap-1">
                <kbd hlmKbd class="font-mono text-[10px]">↑↓</kbd>
                <span i18n>Model</span>
              </span>
              @if (effortSupported()) {
                <span class="inline-flex items-center gap-1">
                  <kbd hlmKbd class="font-mono text-[10px]">←→</kbd>
                  <span i18n>Effort</span>
                </span>
              }
              <span class="inline-flex items-center gap-1">
                <kbd hlmKbd class="font-mono text-[10px]">↵</kbd>
                <span i18n>Select</span>
              </span>
            </span>
            <kbd hlmKbd class="font-mono text-[10px]">Esc</kbd>
          </div>
        </div>
      }
    </div>
  `,
})
export class ModelPalette {
  protected readonly keymap = inject(Keymap);
  private readonly hostRef = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  private readonly triggerBtn = viewChild<ElementRef<HTMLButtonElement>>('triggerBtn');
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  readonly activeAgentId = input.required<string>();
  readonly agentName = input.required<string>();
  readonly menuAgents = input.required<ReadonlyArray<PaletteAgent>>();
  readonly canSwitchAgent = input.required<boolean>();
  readonly isDraft = input.required<boolean>();
  readonly modelsSupported = input.required<boolean>();
  readonly effortSupported = input.required<boolean>();
  readonly modelChangePreservesContext = input.required<boolean>();
  readonly modelsLimitation = input<string | null>(null);
  readonly model = input<ModelOptionState | undefined>(undefined);
  readonly effort = input<EffortOptionState | undefined>(undefined);
  readonly controlsDisabled = input.required<boolean>();
  readonly pickerLabel = input.required<string>();

  readonly agentSelect = output<string>();
  readonly modelSelect = output<string>();
  readonly effortSelect = output<Effort>();

  protected readonly open = signal(false);
  protected readonly query = signal('');
  protected readonly highlightedModelId = signal<string | null>(null);
  protected readonly hoveredEffort = signal<Effort | null>(null);
  protected readonly scrubbing = signal(false);
  private scrubHandledClick = false;

  protected readonly effortLevels = PALETTE_EFFORT_LEVELS;
  protected readonly unavailableLevelTooltip = () => $localize`this Agent doesn't offer it`;

  protected readonly parsed = computed(() => parseModelPaletteQuery(this.query()));

  protected readonly modelName = computed(() => {
    const option = this.model();
    return (
      option?.choices.find((choice) => choice.id === option.value)?.name ?? $localize`Select model…`
    );
  });

  protected readonly showHandoffNote = computed(
    () => !this.isDraft() && !this.modelChangePreservesContext(),
  );

  protected readonly searchPlaceholder = computed(
    () => $localize`Filter models or type effort (e.g. "max")…`,
  );

  protected readonly filteredModels = computed((): ReadonlyArray<Model> => {
    const option = this.model();
    if (!this.modelsSupported() || option === undefined) return [];
    const { terms } = this.parsed();
    if (terms.length === 0) return option.choices;
    const agent = this.agentName().toLowerCase();
    return option.choices.filter((choice) => {
      const haystack =
        `${choice.name} ${choice.id} ${choice.description ?? ''} ${agent}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  });

  protected readonly filteredAgents = computed((): ReadonlyArray<PaletteAgent> => {
    const agents = this.menuAgents();
    const { terms } = this.parsed();
    if (terms.length === 0) return agents;
    return agents.filter((agent) => {
      const haystack = agent.name.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  });

  protected readonly activeHighlightId = computed(() => {
    const visible = this.filteredModels();
    if (visible.length === 0) return null;
    const current = this.highlightedModelId();
    if (current !== null && visible.some((choice) => choice.id === current)) return current;
    const selected = this.model()?.value;
    if (selected !== undefined && visible.some((choice) => choice.id === selected)) return selected;
    return visible[0]?.id ?? null;
  });

  /** Ensures only one row renders the effort `data-testid="effort-*"` radio group at a time. */
  protected readonly meterChoiceId = computed(() => this.activeHighlightId());

  protected readonly needsStandaloneEffort = computed(
    () => this.effortSupported() && this.filteredModels().length === 0,
  );

  constructor() {
    this.keymap.registerEscape({
      layer: 'menu',
      when: () => this.open(),
      run: () => this.closeAndRestoreFocus(),
      destroyRef: this.destroyRef,
    });

    effect(() => {
      if (this.open()) {
        queueMicrotask(() => this.searchInput()?.nativeElement.focus());
      }
    });
  }

  protected toggle(): void {
    const next = !this.open();
    this.open.set(next);
    if (next) {
      this.query.set('');
      this.hoveredEffort.set(null);
      this.highlightedModelId.set(this.model()?.value ?? null);
    }
  }

  protected onSearch(value: string): void {
    this.query.set(value);
    const first = this.filteredModels()[0];
    this.highlightedModelId.set(first?.id ?? null);
  }

  protected onModelHover(modelId: string): void {
    if (this.highlightedModelId() !== modelId) {
      this.highlightedModelId.set(modelId);
      this.hoveredEffort.set(null);
    }
  }

  protected barsFor(level: Effort): 1 | 2 | 3 | 4 {
    return EFFORT_BARS[level];
  }

  protected effortLabel(level: Effort): string {
    switch (level) {
      case 'low':
        return $localize`Low`;
      case 'medium':
        return $localize`Medium`;
      case 'high':
        return $localize`High`;
      case 'max':
        return $localize`Max`;
    }
  }

  protected effortShort(level: Effort): string {
    switch (level) {
      case 'low':
        return $localize`Low`;
      case 'medium':
        return $localize`Med`;
      case 'high':
        return $localize`High`;
      case 'max':
        return $localize`Max`;
    }
  }

  protected displayedEffort(effortOption: EffortOptionState): Effort {
    const hovered = this.hoveredEffort();
    if (hovered !== null && effortOption.choices.includes(hovered)) return hovered;
    const queryEffort = this.parsed().effort;
    if (queryEffort !== null && effortOption.choices.includes(queryEffort)) return queryEffort;
    return effortOption.value;
  }

  protected pickModel(modelId: string): void {
    const queryEffort = this.parsed().effort;
    const canApplyEffortDirectly =
      this.isDraft() || this.modelChangePreservesContext() || modelId === this.model()?.value;
    if (
      canApplyEffortDirectly &&
      queryEffort !== null &&
      this.effortSupported() &&
      this.effort()?.choices.includes(queryEffort) === true
    ) {
      this.effortSelect.emit(queryEffort);
    }
    this.modelSelect.emit(modelId);
    this.open.set(false);
  }

  protected pickAgent(agentId: string): void {
    if (agentId === this.activeAgentId() || !this.canSwitchAgent()) return;
    this.agentSelect.emit(agentId);
    this.open.set(false);
  }

  protected startEffortScrub(
    event: PointerEvent,
    modelId: string | null,
    level: Effort,
    offered: boolean,
  ): void {
    if (!offered || this.controlsDisabled()) return;
    event.stopPropagation();
    this.scrubbing.set(true);
    this.scrubHandledClick = true;
    this.hoveredEffort.set(level);
    this.applyEffort(modelId, level);
  }

  protected onEffortPointerEnter(modelId: string | null, level: Effort, offered: boolean): void {
    if (!offered || this.controlsDisabled()) return;
    this.hoveredEffort.set(level);
    if (this.scrubbing()) {
      this.applyEffort(modelId, level);
    }
  }

  protected pickEffort(modelId: string | null, level: Effort, offered: boolean): void {
    if (this.scrubHandledClick) {
      this.scrubHandledClick = false;
      return;
    }
    if (!offered || this.controlsDisabled()) return;
    this.applyEffort(modelId, level);
  }

  private applyEffort(modelId: string | null, level: Effort): void {
    if (modelId !== null && modelId !== this.model()?.value) {
      this.modelSelect.emit(modelId);
    }
    if (level !== this.effort()?.value) {
      this.effortSelect.emit(level);
    }
  }

  protected onSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeAndRestoreFocus();
      return;
    }

    const models = this.filteredModels();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (models.length === 0) return;
      event.preventDefault();
      const current = this.activeHighlightId();
      const idx = models.findIndex((choice) => choice.id === current);
      const curIdx = idx >= 0 ? idx : 0;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = models[(curIdx + delta + models.length) % models.length];
      if (next !== undefined) {
        this.highlightedModelId.set(next.id);
        this.hoveredEffort.set(null);
      }
      return;
    }

    if (
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      this.query() === '' &&
      this.effortSupported() &&
      !this.controlsDisabled()
    ) {
      const choices = this.effort()?.choices;
      if (choices === undefined || choices.length === 0) return;
      event.preventDefault();
      const current = this.effort()?.value;
      const idx = current !== undefined ? choices.indexOf(current) : 0;
      const curIdx = idx >= 0 ? idx : 0;
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const next = choices[(curIdx + delta + choices.length) % choices.length];
      if (next !== undefined) {
        this.effortSelect.emit(next);
      }
      return;
    }

    if (event.key === 'Enter') {
      const targetModel = this.activeHighlightId();
      if (targetModel !== null) {
        event.preventDefault();
        this.pickModel(targetModel);
        return;
      }
      const switchableAgent = this.filteredAgents().find(
        (agent) => agent.id !== this.activeAgentId() && this.canSwitchAgent(),
      );
      if (switchableAgent !== undefined) {
        event.preventDefault();
        this.pickAgent(switchableAgent.id);
      }
    }
  }

  protected onWindowPointerDown(event: PointerEvent): void {
    if (!this.open()) return;
    const target = event.target;
    if (target instanceof Node && !this.hostRef.nativeElement.contains(target)) {
      this.open.set(false);
    }
  }

  protected onWindowPointerUp(): void {
    if (this.scrubbing()) {
      this.scrubbing.set(false);
    }
  }

  private closeAndRestoreFocus(): void {
    this.open.set(false);
    this.triggerBtn()?.nativeElement.focus({ preventScroll: true });
  }
}
