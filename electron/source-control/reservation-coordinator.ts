import { Context, Deferred, Duration, Effect, Layer, Option } from 'effect';
import { randomUUID } from 'node:crypto';
import {
  type OperationId,
  SourceControlError,
} from '../../src/shared/source-control/source-control.rpc';

/** Canonical locking key builders so Source Control slices lock shared resources uniformly. */
export const reservationKeys = {
  repo: (repoKey: string): string => `repo:${repoKey}`,
  folder: (normalizedPathKey: string): string => `folder:${normalizedPathKey}`,
  worktree: (worktreeIdOrKey: string): string => `wt:${worktreeIdOrKey}`,
  ref: (repoKey: string, branchOrRef: string): string => `ref:${repoKey}:${branchOrRef}`,
  session: (sessionId: string): string => `session:${sessionId}`,
} as const;

export interface ReservationOptions {
  readonly holderId: string;
  readonly keys: ReadonlyArray<string>;
  readonly mode: 'shared' | 'exclusive';
  readonly reason: string;
  readonly waitMs?: number;
  readonly failIfTurnActive?: boolean;
  readonly ignoreRecoveryForOperationId?: OperationId;
}

export interface UnresolvedTargetRecord {
  readonly operationId: OperationId;
  readonly keys: ReadonlyArray<string>;
  readonly summary: string;
}

export interface ReservationCoordinatorShape {
  readonly withReservation: <A, E, R>(
    options: ReservationOptions,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SourceControlError, R>;
  readonly registerTurn: (
    sessionId: string,
    keys: ReadonlyArray<string>,
  ) => Effect.Effect<void, SourceControlError>;
  readonly releaseTurn: (sessionId: string) => Effect.Effect<void>;
  readonly registerCapture: (
    captureId: string,
    keys: ReadonlyArray<string>,
  ) => Effect.Effect<void, SourceControlError>;
  readonly releaseCapture: (captureId: string) => Effect.Effect<void>;
  readonly activeTurnsFor: (keys: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>>;
  readonly activeCapturesFor: (keys: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>>;
  readonly holdIdleTargets: (
    holderId: string,
    keys: ReadonlyArray<string>,
    reason: string,
  ) => Effect.Effect<void, SourceControlError>;
  readonly releaseIdleTargets: (holderId: string) => Effect.Effect<void>;
  readonly setUnresolvedTargets: (
    operationId: OperationId,
    keys: ReadonlyArray<string>,
    summary: string,
  ) => Effect.Effect<void>;
  readonly clearUnresolvedTargets: (operationId: OperationId) => Effect.Effect<void>;
  readonly listUnresolvedTargets: () => Effect.Effect<ReadonlyArray<UnresolvedTargetRecord>>;
}

/** App-lifetime coordinator serializing repository/worktree/ref mutations and Turn/capture boundaries. */
export class ReservationCoordinator extends Context.Service<
  ReservationCoordinator,
  ReservationCoordinatorShape
>()('source-control/ReservationCoordinator') {}

interface KeyLockEntry {
  mode: 'shared' | 'exclusive';
  readonly holders: Map<string, string>; // token -> reason
  readonly waiters: Set<() => void>;
}

const DEFAULT_WAIT_MS = 15_000;

const keysOverlap = (a: ReadonlyArray<string>, b: ReadonlySet<string>): boolean => {
  for (const item of a) {
    if (b.has(item)) return true;
  }
  return false;
};

const normalizeKeys = (keys: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(keys)].sort();

/** Creates a live single-process `ReservationCoordinator` layer using Effect timers/Clock. */
export const layerReservationCoordinator: Layer.Layer<ReservationCoordinator> = Layer.sync(
  ReservationCoordinator,
  () => {
    const keyLocks = new Map<string, KeyLockEntry>();
    const activeTurns = new Map<string, ReadonlySet<string>>();
    const activeCaptures = new Map<string, ReadonlySet<string>>();
    const idleHolds = new Map<
      string,
      { readonly keys: ReadonlySet<string>; readonly reason: string }
    >();
    const unresolvedTargets = new Map<OperationId, UnresolvedTargetRecord>();

    const findUnresolvedOverlap = (
      keys: ReadonlyArray<string>,
      ignoreOperationId?: OperationId,
    ): UnresolvedTargetRecord | undefined => {
      const wanted = new Set(keys);
      for (const record of unresolvedTargets.values()) {
        if (ignoreOperationId !== undefined && record.operationId === ignoreOperationId) {
          continue;
        }
        if (keysOverlap(record.keys, wanted)) {
          return record;
        }
      }
      return undefined;
    };

    const findIdleHoldOverlap = (keys: ReadonlyArray<string>): string | undefined => {
      const wanted = new Set(keys);
      for (const hold of idleHolds.values()) {
        for (const k of hold.keys) {
          if (wanted.has(k)) return hold.reason;
        }
      }
      return undefined;
    };

    const findActiveTurnSessions = (keys: ReadonlyArray<string>): ReadonlyArray<string> => {
      if (keys.length === 0) return [];
      const matches: string[] = [];
      for (const [sessionId, sessionKeys] of activeTurns) {
        if (keysOverlap(keys, sessionKeys)) {
          matches.push(sessionId);
        }
      }
      return matches;
    };

    const findActiveCaptureIds = (keys: ReadonlyArray<string>): ReadonlyArray<string> => {
      if (keys.length === 0) return [];
      const matches: string[] = [];
      for (const [captureId, captureKeys] of activeCaptures) {
        if (keysOverlap(keys, captureKeys)) {
          matches.push(captureId);
        }
      }
      return matches;
    };

    const tryClaimKey = (
      key: string,
      token: string,
      mode: 'shared' | 'exclusive',
      reason: string,
    ): boolean => {
      const existing = keyLocks.get(key);
      if (existing === undefined) {
        keyLocks.set(key, {
          mode,
          holders: new Map([[token, reason]]),
          waiters: new Set(),
        });
        return true;
      }
      if (existing.holders.has(token)) {
        return true;
      }
      if (mode === 'shared' && existing.mode === 'shared') {
        existing.holders.set(token, reason);
        return true;
      }
      return false;
    };

    const releaseKeyList = (keys: ReadonlyArray<string>, token: string): void => {
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        const key = keys[i];
        if (key === undefined) continue;
        const entry = keyLocks.get(key);
        if (entry === undefined) continue;
        entry.holders.delete(token);
        const waiters = [...entry.waiters];
        if (entry.holders.size === 0) {
          keyLocks.delete(key);
        }
        for (const notify of waiters) {
          notify();
        }
      }
    };

    const acquireKey = Effect.fnUntraced(function* (
      key: string,
      token: string,
      mode: 'shared' | 'exclusive',
      reason: string,
      waitMs: number,
    ) {
      if (tryClaimKey(key, token, mode, reason)) {
        return;
      }
      if (waitMs <= 0) {
        const holderReasons = [...(keyLocks.get(key)?.holders.values() ?? [])];
        return yield* new SourceControlError({
          reason: 'Busy',
          detail:
            holderReasons.length > 0
              ? `Target "${key}" is busy (${holderReasons.join(', ')}).`
              : `Target "${key}" is currently busy.`,
        });
      }

      const acquireLoop = Effect.gen(function* () {
        while (!tryClaimKey(key, token, mode, reason)) {
          const entry = keyLocks.get(key);
          if (entry === undefined) continue;
          const waiter = yield* Deferred.make<void>();
          const wake = (): void => {
            entry.waiters.delete(wake);
            Deferred.doneUnsafe(waiter, Effect.void);
          };
          entry.waiters.add(wake);
          yield* Deferred.await(waiter).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                entry.waiters.delete(wake);
              }),
            ),
          );
        }
      });

      const completed = yield* acquireLoop.pipe(
        Effect.as(true),
        Effect.timeoutOption(Duration.millis(waitMs)),
      );
      if (Option.isNone(completed)) {
        const holderReasons = [...(keyLocks.get(key)?.holders.values() ?? [])];
        return yield* new SourceControlError({
          reason: 'Busy',
          detail:
            holderReasons.length > 0
              ? `Timed out waiting for "${key}" (${holderReasons.join(', ')}).`
              : `Timed out waiting for "${key}".`,
        });
      }
    });

    const withReservation = Effect.fnUntraced(function* <A, E, R>(
      options: ReservationOptions,
      effect: Effect.Effect<A, E, R>,
    ): Effect.fn.Return<A, E | SourceControlError, R> {
      const sortedKeys = normalizeKeys(options.keys);

      const unresolved = findUnresolvedOverlap(sortedKeys, options.ignoreRecoveryForOperationId);
      if (unresolved !== undefined) {
        return yield* new SourceControlError({
          reason: 'RecoveryRequired',
          detail: `Unresolved operation "${unresolved.operationId}" requires recovery: ${unresolved.summary}`,
        });
      }

      if (options.failIfTurnActive) {
        const turns = findActiveTurnSessions(sortedKeys);
        const captures = findActiveCaptureIds(sortedKeys);
        if (turns.length > 0 || captures.length > 0) {
          return yield* new SourceControlError({
            reason: 'Busy',
            detail: 'Target Worktree has an active Turn or snapshot capture in progress.',
          });
        }
      }

      const token = `${options.holderId}:${randomUUID()}`;
      const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;

      return yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          const acquired: string[] = [];
          return yield* Effect.gen(function* () {
            for (const key of sortedKeys) {
              yield* acquireKey(key, token, options.mode, options.reason, waitMs);
              acquired.push(key);
            }
            return acquired;
          }).pipe(
            Effect.onExit((exit) =>
              exit._tag === 'Success'
                ? Effect.void
                : Effect.sync(() => {
                    releaseKeyList(acquired, token);
                  }),
            ),
          );
        }),
        () => effect,
        (acquired) =>
          Effect.sync(() => {
            releaseKeyList(acquired, token);
          }),
      );
    });

    return {
      withReservation,

      registerTurn: Effect.fn('ReservationCoordinator.registerTurn')(function* (
        sessionId: string,
        keys: ReadonlyArray<string>,
      ) {
        const normalized = normalizeKeys(keys);
        const unresolved = findUnresolvedOverlap(normalized);
        if (unresolved !== undefined) {
          return yield* new SourceControlError({
            reason: 'RecoveryRequired',
            detail: `Cannot start Turn while recovery is required: ${unresolved.summary}`,
          });
        }
        const idleReason = findIdleHoldOverlap(normalized);
        if (idleReason !== undefined) {
          return yield* new SourceControlError({
            reason: 'Busy',
            detail: `Cannot start Turn while source-control operation is active (${idleReason}).`,
          });
        }
        activeTurns.set(sessionId, new Set(normalized));
      }),

      releaseTurn: (sessionId: string) =>
        Effect.sync(() => {
          activeTurns.delete(sessionId);
        }),

      registerCapture: Effect.fn('ReservationCoordinator.registerCapture')(function* (
        captureId: string,
        keys: ReadonlyArray<string>,
      ) {
        const normalized = normalizeKeys(keys);
        const idleReason = findIdleHoldOverlap(normalized);
        if (idleReason !== undefined) {
          return yield* new SourceControlError({
            reason: 'Busy',
            detail: `Capture blocked while source-control operation holds target (${idleReason}).`,
          });
        }
        activeCaptures.set(captureId, new Set(normalized));
      }),

      releaseCapture: (captureId: string) =>
        Effect.sync(() => {
          activeCaptures.delete(captureId);
        }),

      activeTurnsFor: (keys: ReadonlyArray<string>) =>
        Effect.sync(() => findActiveTurnSessions(normalizeKeys(keys))),

      activeCapturesFor: (keys: ReadonlyArray<string>) =>
        Effect.sync(() => findActiveCaptureIds(normalizeKeys(keys))),

      holdIdleTargets: Effect.fn('ReservationCoordinator.holdIdleTargets')(function* (
        holderId: string,
        keys: ReadonlyArray<string>,
        reason: string,
      ) {
        const normalized = normalizeKeys(keys);
        const unresolved = findUnresolvedOverlap(normalized);
        if (unresolved !== undefined) {
          return yield* new SourceControlError({
            reason: 'RecoveryRequired',
            detail: unresolved.summary,
          });
        }
        const active = findActiveTurnSessions(normalized);
        const captures = findActiveCaptureIds(normalized);
        if (active.length > 0 || captures.length > 0) {
          return yield* new SourceControlError({
            reason: 'Busy',
            detail: `Cannot reserve idle targets (${reason}): active Turn or capture in progress.`,
          });
        }
        const overlap = findIdleHoldOverlap(normalized);
        if (overlap !== undefined) {
          return yield* new SourceControlError({
            reason: 'Busy',
            detail: `Targets already held by another idle operation (${overlap}).`,
          });
        }
        idleHolds.set(holderId, { keys: new Set(normalized), reason });
      }),

      releaseIdleTargets: (holderId: string) =>
        Effect.sync(() => {
          idleHolds.delete(holderId);
        }),

      setUnresolvedTargets: (
        operationId: OperationId,
        keys: ReadonlyArray<string>,
        summary: string,
      ) =>
        Effect.sync(() => {
          unresolvedTargets.set(operationId, {
            operationId,
            keys: normalizeKeys(keys),
            summary,
          });
        }),

      clearUnresolvedTargets: (operationId: OperationId) =>
        Effect.sync(() => {
          unresolvedTargets.delete(operationId);
        }),

      listUnresolvedTargets: () => Effect.sync(() => [...unresolvedTargets.values()]),
    } satisfies ReservationCoordinatorShape;
  },
);
