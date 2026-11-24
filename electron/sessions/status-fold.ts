import type {
  AgentStatus,
  LastTurn,
  LiveState,
  MessageSender,
  PermissionRequestId,
  QueuedMessage,
  SessionStatus,
  TranscriptItem,
  TurnId,
  TurnOutcome,
} from '../../src/shared/sessions/sessions.rpc';
import type { StoredEvent } from './transcript-file';

export type FoldableItem = TranscriptItem | StoredEvent['item'];

/**
 * Whether a Message from another Session asks for the user's answer here: when its sender said so, or when it came
 * from another Project, unless a person sent it (a person's own Cross-device message needs nobody's answer).
 */
export const asksUser = (from: MessageSender): boolean =>
  from.needsUser === true ||
  (from.exchangeId === undefined && from.projectName !== undefined && from.by !== 'person');

/** Incremental status, last-Turn, and workflow verification state folded from a Session's Transcript. */
export interface TranscriptStatusFold {
  readonly empty: boolean;
  readonly openTurn: TurnId | undefined;
  readonly pendingPermissions: ReadonlySet<PermissionRequestId>;
  readonly asked: boolean;
  readonly lastFailed: boolean;
  readonly lastTurn: LastTurn | undefined;
  readonly workflowTurns: ReadonlyMap<TurnId, TurnId>;
  readonly workflowTurnIds: ReadonlySet<TurnId>;
  readonly workflowOutcomes: ReadonlyMap<TurnId, TurnOutcome>;
}

/** Mutable accumulator owned by `SessionStore` for O(1) incremental folding under its lock. */
export interface MutableStatusFold {
  empty: boolean;
  openTurn: TurnId | undefined;
  readonly pendingPermissions: Set<PermissionRequestId>;
  asked: boolean;
  lastFailed: boolean;
  lastTurn: LastTurn | undefined;
  readonly workflowTurns: Map<TurnId, TurnId>;
  readonly workflowTurnIds: Set<TurnId>;
  readonly workflowOutcomes: Map<TurnId, TurnOutcome>;
}

const EMPTY_SET: ReadonlySet<never> = new Set<never>();
const EMPTY_MAP: ReadonlyMap<never, never> = new Map<never, never>();

const EMPTY_FOLD: TranscriptStatusFold = {
  empty: true,
  openTurn: undefined,
  pendingPermissions: EMPTY_SET,
  asked: false,
  lastFailed: false,
  lastTurn: undefined,
  workflowTurns: EMPTY_MAP,
  workflowTurnIds: EMPTY_SET,
  workflowOutcomes: EMPTY_MAP,
};

export const emptyStatusFold = (): TranscriptStatusFold => EMPTY_FOLD;

export const createMutableStatusFold = (): MutableStatusFold => ({
  empty: true,
  openTurn: undefined,
  pendingPermissions: new Set(),
  asked: false,
  lastFailed: false,
  lastTurn: undefined,
  workflowTurns: new Map(),
  workflowTurnIds: new Set(),
  workflowOutcomes: new Map(),
});

export const applyStatusFold = (fold: MutableStatusFold, item: FoldableItem): void => {
  fold.empty = false;
  switch (item._tag) {
    case 'Message':
      if (item.role === 'user') {
        if (item.from === undefined) fold.asked = false;
        else if (asksUser(item.from)) fold.asked = true;
      }
      return;
    case 'ContextCleared':
      fold.openTurn = undefined;
      fold.asked = false;
      fold.lastFailed = false;
      fold.lastTurn = undefined;
      fold.pendingPermissions.clear();
      return;
    case 'TurnStarted':
      fold.openTurn = item.turnId;
      fold.lastFailed = false;
      fold.pendingPermissions.clear();
      if (item.workflow !== undefined) {
        fold.workflowTurns.set(item.verificationOf ?? item.turnId, item.turnId);
        fold.workflowTurnIds.add(item.turnId);
      }
      return;
    case 'TurnEnded':
      if (fold.openTurn === item.turnId) fold.openTurn = undefined;
      fold.lastTurn = { turnId: item.turnId, outcome: item.outcome._tag };
      fold.lastFailed = item.outcome._tag === 'failed';
      fold.pendingPermissions.clear();
      if (fold.workflowTurnIds.has(item.turnId)) {
        fold.workflowOutcomes.set(item.turnId, item.outcome);
      }
      return;
    case 'PermissionRequest':
      if (item.state._tag === 'pending') fold.pendingPermissions.add(item.id);
      else fold.pendingPermissions.delete(item.id);
      return;
    case 'Compaction':
    case 'HandoffBoundary':
    case 'MessageDelta':
    case 'Notice':
    case 'Plan':
    case 'Step':
    case 'StepDelta':
    case 'Thought':
    case 'ThoughtDelta':
      return;
  }
};

export const snapshotStatusFold = (fold: MutableStatusFold): TranscriptStatusFold => ({
  empty: fold.empty,
  openTurn: fold.openTurn,
  pendingPermissions:
    fold.pendingPermissions.size === 0 ? EMPTY_SET : new Set(fold.pendingPermissions),
  asked: fold.asked,
  lastFailed: fold.lastFailed,
  lastTurn: fold.lastTurn,
  workflowTurns: fold.workflowTurns.size === 0 ? EMPTY_MAP : new Map(fold.workflowTurns),
  workflowTurnIds: fold.workflowTurnIds.size === 0 ? EMPTY_SET : new Set(fold.workflowTurnIds),
  workflowOutcomes: fold.workflowOutcomes.size === 0 ? EMPTY_MAP : new Map(fold.workflowOutcomes),
});

/**
 * Derives the unified `SessionStatus` with precedence:
 * archived (`idle`) > `blocked` > `error` > `working` > `idle`.
 */
export const deriveSessionStatus = (input: {
  readonly archived: boolean;
  readonly fold: TranscriptStatusFold;
  readonly queue?: ReadonlyArray<QueuedMessage>;
  readonly browserHandoffPending?: boolean;
  readonly agentStatus: AgentStatus;
  readonly working: boolean;
  readonly openInRun: boolean;
}): SessionStatus => {
  if (input.archived) return 'idle';
  const interruptedUnopened = !input.openInRun && input.fold.openTurn !== undefined;
  const pendingCount = interruptedUnopened ? 0 : input.fold.pendingPermissions.size;
  const hasQueuedAsk =
    input.queue?.some((item) => item.from !== undefined && asksUser(item.from)) === true;
  if (
    pendingCount > 0 ||
    input.browserHandoffPending === true ||
    input.fold.asked ||
    hasQueuedAsk
  ) {
    return 'blocked';
  }
  const failed = interruptedUnopened || input.fold.lastFailed;
  if (failed || input.agentStatus === 'stopped') return 'error';
  if (input.working) return 'working';
  return 'idle';
};

/** Computes eligible workflow verification retries from the incrementally folded Transcript state. */
export const verificationRetriesFromFold = (
  fold: TranscriptStatusFold,
  records: ReadonlyArray<{
    readonly turnId: TurnId;
    readonly phase: 'preparing' | 'implementing' | 'verifying';
  }>,
): NonNullable<LiveState['verificationRetries']> => {
  if (records.length === 0) return [];
  return records.flatMap(({ turnId: originalTurnId, phase }) => {
    const turnId = fold.workflowTurns.get(originalTurnId);
    if (turnId === undefined) return [];
    const outcome = fold.workflowOutcomes.get(turnId);
    const interrupted = outcome?._tag === 'failed' && outcome.reason === 'interrupted';
    const incomplete =
      (phase === 'verifying' || turnId !== originalTurnId) &&
      (outcome?._tag === 'failed' || outcome?._tag === 'cancelled');
    return incomplete || (interrupted && phase === 'implementing')
      ? [{ turnId, originalTurnId }]
      : [];
  });
};
