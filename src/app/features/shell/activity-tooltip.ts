import {
  ChangeDetectionStrategy,
  Component,
  type DestroyRef,
  input,
  type Signal,
  signal,
} from '@angular/core';
import type {
  Attention,
  LiveActivity,
  LiveActivityKind,
} from '../../../shared/sessions/sessions.rpc';

/** Compact elapsed seconds/minutes/hours formatter for live hover tooltips (e.g., `14s`, `1m 14s`). */
export const formatTooltipElapsed = (startedAt: number, now: number): string => {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (totalSeconds < 60) {
    return $localize`:tooltip elapsed seconds:${totalSeconds}:seconds:s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return $localize`:tooltip elapsed minutes and seconds:${minutes}:minutes:m ${seconds}:seconds:s`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return $localize`:tooltip elapsed hours and minutes:${hours}:hours:h ${remMinutes}:minutes:m`;
};

const activityVerb = (kind: LiveActivityKind): string => {
  switch (kind) {
    case 'read':
      return $localize`:activity verb:reading`;
    case 'edit':
      return $localize`:activity verb:editing`;
    case 'delete':
      return $localize`:activity verb:deleting`;
    case 'move':
      return $localize`:activity verb:moving`;
    case 'search':
      return $localize`:activity verb:searching`;
    case 'execute':
      return $localize`:activity verb:running`;
    case 'fetch':
      return $localize`:activity verb:fetching`;
    case 'other':
      return $localize`:activity verb:working`;
    case 'thinking':
      return $localize`:activity verb:thinking`;
    case 'writing':
      return $localize`:activity verb:writing`;
  }
};

export interface ActivityTooltipInput {
  readonly attention?: Attention;
  readonly running?: boolean;
  readonly activity?: LiveActivity;
  readonly blockedTarget?: string;
  readonly errorSummary?: string;
  readonly fallbackStatus?: string;
}

export interface ActivityTooltipStatus {
  readonly prefix: string;
  readonly target?: string;
  readonly elapsed?: string;
}

/** Projects a Session, Worker, or Tab's live state into a calm tooltip micro-status line. */
export const activityTooltipStatus = (
  source: ActivityTooltipInput,
  now: number,
): ActivityTooltipStatus | null => {
  if (source.attention === 'needsAnswer') {
    const target = source.blockedTarget?.trim();
    if (target !== undefined && target !== '') {
      return { prefix: $localize`:tooltip status:waiting for permission:`, target };
    }
    return { prefix: $localize`:tooltip status:Waiting for your answer` };
  }
  if (source.attention === 'error') {
    const summary = source.errorSummary?.trim();
    return {
      prefix:
        summary !== undefined && summary !== ''
          ? summary
          : $localize`:tooltip status:Stopped with an error`,
    };
  }
  if (source.activity !== undefined) {
    const verb = activityVerb(source.activity.kind);
    const target = source.activity.target.trim();
    const elapsed = formatTooltipElapsed(source.activity.startedAt, now);
    return target !== '' ? { prefix: verb, target, elapsed } : { prefix: verb, elapsed };
  }
  if (source.running === true) {
    return { prefix: $localize`:tooltip status:Working` };
  }
  if (source.fallbackStatus !== undefined && source.fallbackStatus !== '') {
    return { prefix: source.fallbackStatus };
  }
  return null;
};

/** Read-only epoch-ms signal updating every second until `destroyRef` fires. */
export const secondTicker = (destroyRef: DestroyRef): Signal<number> => {
  const now = signal(Date.now());
  const timer = setInterval(() => now.set(Date.now()), 1000);
  destroyRef.onDestroy(() => clearInterval(timer));
  return now.asReadonly();
};

/** Presentational tooltip body showing full title and optional live micro-status. */
@Component({
  selector: 'app-activity-tooltip-content',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="max-w-72 space-y-0.5 text-left font-sans text-xs">
      <p class="font-medium break-words">{{ title() }}</p>
      @if (status(); as s) {
        <p class="text-background/80 break-words">
          <span>{{ s.prefix }}</span>
          @if (s.target; as target) {
            <span class="font-mono text-[11px]">{{ ' ' + target }}</span>
          }
          @if (s.elapsed; as elapsed) {
            <span class="tabular-nums">{{ ' · ' + elapsed }}</span>
          }
        </p>
      }
    </div>
  `,
})
export class ActivityTooltipContent {
  readonly title = input.required<string>();
  readonly status = input<ActivityTooltipStatus | null>(null);
}
