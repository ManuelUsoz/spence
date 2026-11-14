import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  LOCALE_ID,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmTooltipImports } from '@ui/tooltip';
import type { ContextUsage, ContextUsageReading } from '../../../shared/sessions/sessions.rpc';

interface RingModel {
  readonly measured: boolean;
  readonly over: boolean;
  readonly glyph: '?' | '…' | null;
  readonly ringOffset: number;
  readonly headline: string;
  readonly detail: string;
  readonly provenance: string;
  readonly freshness: string;
  readonly ariaLabel: string;
}

/**
 * Compact circular context-usage indicator beside the Composer, revealing exact
 * Agent-reported token figures, provenance, and freshness on hover or focus.
 */
@Component({
  selector: 'app-context-ring',
  imports: [HlmButtonImports, HlmTooltipImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #tip>
      <div class="space-y-1 text-left font-sans text-xs">
        <p class="font-medium tabular-nums">{{ model().headline }}</p>
        <p class="text-background/75 tabular-nums">{{ model().detail }}</p>
        <p class="text-background/75">{{ model().provenance }}</p>
        <p class="text-background/75">{{ model().freshness }}</p>
      </div>
    </ng-template>
    <button
      hlmBtn
      type="button"
      variant="ghost"
      size="icon"
      class="text-muted-foreground hover:text-foreground relative"
      data-testid="context-ring"
      [attr.aria-label]="model().ariaLabel"
      [hlmTooltip]="tip"
      position="top"
    >
      <svg viewBox="0 0 24 24" class="size-5 -rotate-90" aria-hidden="true">
        <circle
          data-testid="context-ring-track"
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          class="text-muted-foreground/25"
          [attr.stroke-dasharray]="model().measured ? null : '2 3'"
        />
        @if (model().measured) {
          <circle
            data-testid="context-ring-arc"
            cx="12"
            cy="12"
            r="9"
            pathLength="100"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-dasharray="100"
            [attr.stroke-dashoffset]="model().ringOffset"
            [class.text-destructive]="model().over"
          />
        }
      </svg>
      @if (model().glyph; as glyph) {
        <span
          class="text-muted-foreground pointer-events-none absolute text-[9px] leading-none"
          aria-hidden="true"
          >{{ glyph }}</span
        >
      }
    </button>
  `,
})
export class ContextRing {
  readonly usage = input<ContextUsage>({ _tag: 'unavailable' });
  readonly agentName = input.required<string>();

  private readonly locale = inject(LOCALE_ID);
  private readonly exactFmt = new Intl.NumberFormat(this.locale);
  private readonly decimalFmt = new Intl.NumberFormat(this.locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  protected readonly model = computed<RingModel>(() =>
    this.toRingModel(this.usage(), this.agentName()),
  );

  private formatExact(tokens: number): string {
    return this.exactFmt.format(tokens);
  }

  private formatCompact(tokens: number): string {
    if (tokens >= 1_000_000) return `${this.decimalFmt.format(tokens / 1_000_000)}M`;
    if (tokens >= 1_000) return `${this.decimalFmt.format(tokens / 1_000)}k`;
    return this.exactFmt.format(tokens);
  }

  private formatPercent(pct: number): string {
    return `${this.decimalFmt.format(pct)}%`;
  }

  private formatReadingDetail(reading: ContextUsageReading): string {
    const usedExact = this.formatExact(reading.used);
    if (reading.capacity !== undefined && reading.capacity > 0) {
      const capExact = this.formatExact(reading.capacity);
      return $localize`:@@session.contextRing.exactValues:Exact values: ${usedExact}:used: / ${capExact}:capacity: tokens.`;
    }
    return $localize`:@@session.contextRing.exactCount:Exact count: ${usedExact}:used: tokens. Capacity not reported.`;
  }

  /** Maps a `ContextUsage` reading and Agent name into ring geometry and localized copy. */
  private toRingModel(usage: ContextUsage, agent: string): RingModel {
    const provenance = $localize`:@@session.contextRing.provenance:Reported by ${agent}:agent:.`;
    const freshnessLatest = $localize`:@@session.contextRing.freshnessLatest:Latest report; not a live counter.`;
    const freshnessHistorical = $localize`:@@session.contextRing.freshnessHistorical:Historical reading; waiting for a new report.`;
    const noReportDetail = $localize`:@@session.contextRing.unavailableDetail:No report for this Agent context and Model.`;

    switch (usage._tag) {
      case 'unavailable':
        return {
          measured: false,
          over: false,
          glyph: '?',
          ringOffset: 100,
          headline: $localize`:@@session.contextRing.unavailableHeadline:Context usage unavailable`,
          detail: noReportDetail,
          provenance,
          freshness: freshnessLatest,
          ariaLabel: $localize`:@@session.contextRing.unavailableAria:Context usage unavailable. Reported by ${agent}:agent:.`,
        };
      case 'reported': {
        const pct = (usage.used / usage.capacity) * 100;
        const over = pct > 100;
        const clamped = Math.min(100, Math.max(0, pct));
        // Round to two decimal places to keep SVG dashoffset predictable in DOM/tests.
        const ringOffset = over ? 0 : Math.round((100 - clamped) * 100) / 100;
        const usedCompact = this.formatCompact(usage.used);
        const capCompact = this.formatCompact(usage.capacity);
        const pctText = this.formatPercent(pct);
        return {
          measured: true,
          over,
          glyph: null,
          ringOffset,
          headline: $localize`:@@session.contextRing.reportedHeadline:${usedCompact}:used: / ${capCompact}:capacity: · ${pctText}:percent:`,
          detail: this.formatReadingDetail(usage),
          provenance,
          freshness: freshnessLatest,
          ariaLabel: $localize`:@@session.contextRing.reportedAria:Context usage: ${usedCompact}:used: / ${capCompact}:capacity: (${pctText}:percent:). Reported by ${agent}:agent:.`,
        };
      }
      case 'countOnly': {
        const usedCompact = this.formatCompact(usage.used);
        return {
          measured: false,
          over: false,
          glyph: '?',
          ringOffset: 100,
          headline: $localize`:@@session.contextRing.countOnlyHeadline:${usedCompact}:used: · capacity unknown`,
          detail: this.formatReadingDetail(usage),
          provenance,
          freshness: freshnessLatest,
          ariaLabel: $localize`:@@session.contextRing.countOnlyAria:Context usage: ${usedCompact}:used:, capacity unknown. Reported by ${agent}:agent:.`,
        };
      }
      case 'historical': {
        const usedCompact = this.formatCompact(usage.used);
        if (usage.capacity !== undefined && usage.capacity > 0) {
          const capCompact = this.formatCompact(usage.capacity);
          const pctText = this.formatPercent((usage.used / usage.capacity) * 100);
          return {
            measured: false,
            over: false,
            glyph: '?',
            ringOffset: 100,
            headline: $localize`:@@session.contextRing.historicalWithCapHeadline:Historical · ${usedCompact}:used: / ${capCompact}:capacity: · ${pctText}:percent:`,
            detail: this.formatReadingDetail(usage),
            provenance,
            freshness: freshnessHistorical,
            ariaLabel: $localize`:@@session.contextRing.historicalWithCapAria:Historical context usage: ${usedCompact}:used: / ${capCompact}:capacity: (${pctText}:percent:). Reported by ${agent}:agent:.`,
          };
        }
        return {
          measured: false,
          over: false,
          glyph: '?',
          ringOffset: 100,
          headline: $localize`:@@session.contextRing.historicalCountHeadline:Historical · ${usedCompact}:used: · capacity unknown`,
          detail: this.formatReadingDetail(usage),
          provenance,
          freshness: freshnessHistorical,
          ariaLabel: $localize`:@@session.contextRing.historicalCountAria:Historical context usage: ${usedCompact}:used:, capacity unknown. Reported by ${agent}:agent:.`,
        };
      }
      case 'waiting':
        return {
          measured: false,
          over: false,
          glyph: '…',
          ringOffset: 100,
          headline: $localize`:@@session.contextRing.waitingHeadline:Awaiting context report`,
          detail:
            usage.prior !== undefined ? this.formatReadingDetail(usage.prior) : noReportDetail,
          provenance,
          freshness: freshnessHistorical,
          ariaLabel: $localize`:@@session.contextRing.waitingAria:Awaiting context report. Reported by ${agent}:agent:.`,
        };
    }
  }
}
