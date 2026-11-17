import type {
  ContextUsage,
  ContextUsageReading,
  LiveState,
} from '../../../shared/sessions/sessions.rpc';
import type { SessionToolbarAction, SessionToolbarContext } from '../../core/session-toolbar';

export interface SessionActionsInput {
  readonly running: boolean;
  readonly compacting: boolean;
  readonly clearing: boolean;
  readonly agentStatus: LiveState['agentStatus'] | undefined;
  readonly supportsCompaction: boolean;
  readonly agentName: string;
}

/** Why no operation can start right now, or `null` when the Session is idle. */
const busyReason = (input: SessionActionsInput): string | null => {
  if (input.compacting)
    return $localize`Compaction is running. Stop or wait for it to finish first.`;
  if (input.clearing) return $localize`Context is clearing. Wait for it to finish first.`;
  if (input.running) return $localize`A Turn is running. Wait for it to finish or stop it first.`;
  return null;
};

/** The Session actions menu entries for a Session in the given state. */
export const sessionActions = (input: SessionActionsInput): ReadonlyArray<SessionToolbarAction> => {
  const busy = busyReason(input);
  const status = input.agentStatus;
  const readyOrStopped = status === 'ready' || status === 'stopped';
  const unavailable =
    status === 'starting'
      ? $localize`Wait until ${input.agentName} finishes starting.`
      : !readyOrStopped
        ? $localize`${input.agentName} is not ready.`
        : undefined;

  const compactReason =
    busy ??
    (!input.supportsCompaction
      ? $localize`${input.agentName} doesn't offer compaction.`
      : unavailable);

  return [
    {
      id: 'compact',
      operation: 'Compact',
      label: $localize`Compact context`,
      ...(input.supportsCompaction ? { command: '/compact' } : {}),
      disabled: busy !== null || !input.supportsCompaction || !readyOrStopped,
      ...(compactReason === undefined || compactReason === null ? {} : { reason: compactReason }),
    },
    {
      id: 'clear',
      operation: 'Clear',
      label: $localize`Clear context`,
      command: '/clear',
      disabled: busy !== null || status === undefined,
      ...(busy === null ? {} : { reason: busy }),
    },
    {
      id: 'switch-agent',
      operation: 'Switch Agent',
      label: $localize`Switch Agent or Model…`,
      disabled: busy !== null || status === undefined,
      ...(busy === null ? {} : { reason: busy }),
    },
  ];
};

const tokens = (locale: string, count: number): string =>
  new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(count);

const reading = (locale: string, value: ContextUsageReading): SessionToolbarContext => {
  const used = tokens(locale, value.used);
  if (value.capacity === undefined || value.capacity <= 0) {
    return { label: $localize`${used}:used: used`, fraction: null };
  }
  const capacity = tokens(locale, value.capacity);
  const fraction = Math.min(1, Math.max(0, value.used / value.capacity));
  const percent = new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(value.used / value.capacity);
  return {
    label: $localize`${used}:used: of ${capacity}:capacity: · ${percent}:percent:`,
    fraction,
  };
};

/** One line about context use for the menu header; the Composer's ring keeps the full provenance. */
export const contextSummary = (usage: ContextUsage, locale: string): SessionToolbarContext => {
  switch (usage._tag) {
    case 'reported':
    case 'countOnly':
    case 'historical':
      return reading(locale, usage);
    case 'waiting':
      return usage.prior === undefined
        ? { label: $localize`Waiting for a report`, fraction: null }
        : reading(locale, usage.prior);
    case 'unavailable':
      return { label: $localize`Unavailable`, fraction: null };
  }
};
