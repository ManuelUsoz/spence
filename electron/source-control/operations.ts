import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Schema,
  Scope,
  Stream,
} from 'effect';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { Timestamp } from '../../src/shared/projects/projects.rpc';
import {
  OperationId,
  type OperationKind,
  type OperationPathResult,
  type OperationProgress,
  type OperationRecoveryState,
  OperationSnapshot,
  SourceControlError,
} from '../../src/shared/source-control/source-control.rpc';
import {
  isSafeStoreId,
  readJsonDurable,
  removeOrphanTempFiles,
  writeJsonDurable,
} from '../store/durable';
import { Store, type StoreError } from '../store/store';
import { ReservationCoordinator } from './reservation-coordinator';

/** Persisted schema inside `<store.root>/operations/<operationId>/journal.json`. */
export const DurableOperationRecord = Schema.Struct({
  version: Schema.Literal(1),
  snapshot: OperationSnapshot,
  requestDigest: Schema.String,
  lockKeys: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
});
export type DurableOperationRecord = typeof DurableOperationRecord.Type;

export type OperationApplyOutcome =
  | {
      readonly _tag: 'Partial';
      readonly pathResults: ReadonlyArray<OperationPathResult>;
    }
  | {
      readonly _tag: 'Succeeded';
      readonly targetPath?: string;
      readonly branch?: string;
      readonly warnings?: ReadonlyArray<string>;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly _tag: 'FailedClean';
      readonly errorReason: string;
      readonly errorDetail: string;
    }
  | {
      readonly _tag: 'Unknown';
      readonly unknownReason: string;
      readonly recovery: OperationRecoveryState;
      readonly errorDetail?: string;
    };

export type OperationReconciliationOutcome =
  | {
      readonly _tag: 'Succeeded';
      readonly detail: string;
      readonly targetPath?: string;
      readonly branch?: string;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly _tag: 'FailedClean';
      readonly detail: string;
      readonly errorReason?: string;
    }
  | {
      readonly _tag: 'NeedsRecovery';
      readonly outcome: 'Unknown' | 'NeedsRecovery';
      readonly recovery: OperationRecoveryState;
      readonly errorDetail?: string;
      readonly unknownReason?: string;
    };

export type OperationReconciler = (
  record: DurableOperationRecord,
) => Effect.Effect<OperationReconciliationOutcome, SourceControlError>;

export interface ExecuteOperationRequest {
  readonly operationId: OperationId;
  readonly kind: OperationKind;
  readonly title: string;
  readonly requestDigest: string;
  readonly lockKeys: ReadonlyArray<string>;
  readonly repositoryKey?: string;
  readonly sourcePath?: string;
  readonly targetPath?: string;
  readonly branch?: string;
  readonly metadata: Record<string, unknown>;
  readonly waitMs?: number;
  readonly failIfTurnActive?: boolean;
  /** When true, a typed {@link SourceControlError} raised by `apply` is propagated to the caller
   * instead of being converted into an `Unknown` recovery state. File operations set this so
   * trash-unavailability and stale reviews surface as typed failures. */
  readonly propagateApplyFailure?: boolean;
  readonly prepare: () => Effect.Effect<
    {
      readonly metadata?: Record<string, unknown>;
      readonly lockKeys?: ReadonlyArray<string>;
      readonly warnings?: ReadonlyArray<string>;
      readonly targetPath?: string;
      readonly branch?: string;
    },
    SourceControlError
  >;
  readonly apply: (ctx: {
    readonly record: DurableOperationRecord;
    readonly reportProgress: (
      step: OperationProgress['step'],
      detail?: string,
    ) => Effect.Effect<void>;
    readonly reportPathResults: (
      results: ReadonlyArray<OperationPathResult>,
    ) => Effect.Effect<void, SourceControlError>;
  }) => Effect.Effect<OperationApplyOutcome, SourceControlError>;
}

/** Optional lifecycle fault hooks for testing crash/journal/publication boundaries deterministically. */
export interface OperationDurabilityHooks {
  readonly onPhaseTransition?: (
    phase: OperationSnapshot['phase'],
    record: DurableOperationRecord,
  ) => Effect.Effect<void, SourceControlError>;
}

export interface OperationsShape {
  readonly execute: (
    request: ExecuteOperationRequest,
  ) => Effect.Effect<OperationSnapshot, SourceControlError>;
  readonly registerReconciler: (
    kind: OperationKind,
    reconciler: OperationReconciler,
  ) => Effect.Effect<void>;
  readonly reconcilePendingForKind: (
    kind: OperationKind,
  ) => Effect.Effect<void, SourceControlError>;
  readonly reconcileOperation: (
    operationId: OperationId,
  ) => Effect.Effect<OperationSnapshot, SourceControlError>;
  readonly dismissOperation: (
    operationId: OperationId,
  ) => Effect.Effect<OperationSnapshot, SourceControlError>;
  readonly cancelOperation: (
    operationId: OperationId,
  ) => Effect.Effect<OperationSnapshot, SourceControlError>;
  readonly listOperations: (filter?: {
    readonly repositoryKey?: string;
    readonly sourcePath?: string;
  }) => Effect.Effect<ReadonlyArray<OperationSnapshot>>;
  readonly getOperation: (
    operationId: OperationId,
  ) => Effect.Effect<OperationSnapshot, SourceControlError>;
  readonly awaitOperation: (
    operationId: OperationId,
  ) => Effect.Effect<OperationSnapshot, SourceControlError>;
  readonly updates: Stream.Stream<OperationSnapshot>;
}

/** Durable journal and coordination service backing serialized Source Control operations. */
export class Operations extends Context.Service<Operations, OperationsShape>()(
  'source-control/Operations',
) {}

interface InFlightEntry {
  readonly kind: OperationKind;
  readonly requestDigest: string;
  stage: 'Validating' | 'Prepared' | 'Applying' | 'Settling';
  cancelRequested: boolean;
  readonly deferred: Deferred.Deferred<OperationSnapshot, SourceControlError>;
}

const mapStoreFailure = (err: StoreError): SourceControlError =>
  new SourceControlError({
    reason: 'OperationFailed',
    detail: `Durable operation journal failure: ${err.detail}`,
  });

const isMissingDirError = (err: unknown): boolean => {
  const code =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** Creates an `Operations` layer with optional test fault-injection hooks. */
export const makeLayerOperations = (
  hooks?: OperationDurabilityHooks,
): Layer.Layer<Operations, SourceControlError, Store | ReservationCoordinator> =>
  Layer.effect(
    Operations,
    Effect.gen(function* () {
      const store = yield* Store;
      const coordinator = yield* ReservationCoordinator;
      const layerScope = yield* Scope.Scope;

      const operationsDir = path.join(store.root, 'operations');
      const updatesPubSub = yield* PubSub.unbounded<OperationSnapshot>();
      const records = new Map<OperationId, DurableOperationRecord>();
      const inFlight = new Map<OperationId, InFlightEntry>();
      const reconcilers = new Map<OperationKind, OperationReconciler>();
      const activeFibers = new Set<Fiber.Fiber<unknown, unknown>>();
      let shuttingDown = false;

      const journalPathFor = (operationId: OperationId): string =>
        path.join(operationsDir, operationId, 'journal.json');

      const persistRecord = Effect.fnUntraced(function* (
        record: DurableOperationRecord,
        publish = true,
      ) {
        yield* writeJsonDurable(
          journalPathFor(record.snapshot.id),
          record,
          DurableOperationRecord,
        ).pipe(Effect.mapError(mapStoreFailure));
        records.set(record.snapshot.id, record);
        if (hooks?.onPhaseTransition !== undefined) {
          yield* hooks.onPhaseTransition(record.snapshot.phase, record);
        }
        if (publish) {
          yield* PubSub.publish(updatesPubSub, record.snapshot);
        }
      });

      const loadExistingJournals = Effect.fnUntraced(function* () {
        const entries = yield* Effect.tryPromise({
          try: () => readdir(operationsDir, { withFileTypes: true }),
          catch: (raw): 'MissingDir' | SourceControlError =>
            isMissingDirError(raw)
              ? 'MissingDir'
              : new SourceControlError({
                  reason: 'OperationFailed',
                  detail: `Unable to scan operations folder: ${String(raw)}`,
                }),
        }).pipe(
          Effect.catch((err) =>
            err === 'MissingDir' ? Effect.succeed([] as const) : Effect.fail(err),
          ),
        );

        const now = Timestamp.make(yield* Clock.currentTimeMillis);
        for (const dirent of entries) {
          if (!dirent.isDirectory() || !isSafeStoreId(dirent.name)) continue;
          const opId = OperationId.make(dirent.name);
          const opDir = path.join(operationsDir, dirent.name);
          yield* removeOrphanTempFiles(opDir);
          const loaded = yield* readJsonDurable(journalPathFor(opId), DurableOperationRecord).pipe(
            Effect.catch((err) =>
              Effect.fail(
                new SourceControlError({
                  reason: 'OperationFailed',
                  detail: `Corrupt journal for operation "${opId}": ${err.detail}`,
                }),
              ),
            ),
          );
          if (loaded === null) continue;

          if (loaded.snapshot.phase === 'Prepared') {
            // Crashed before mutation entered Applying: settle safely without replaying.
            const cancelled: DurableOperationRecord = {
              ...loaded,
              snapshot: {
                ...loaded.snapshot,
                phase: 'Completed',
                outcome: 'Cancelled',
                progress: { step: 'Done', detail: 'Interrupted before execution started.' },
                errorDetail: 'Operation was interrupted before Git mutation began.',
                updatedAt: now,
              },
            };
            yield* writeJsonDurable(journalPathFor(opId), cancelled, DurableOperationRecord).pipe(
              Effect.mapError(mapStoreFailure),
            );
            records.set(opId, cancelled);
            continue;
          }

          records.set(opId, loaded);
          if (loaded.snapshot.phase === 'Applying' || loaded.snapshot.phase === 'NeedsRecovery') {
            const summary =
              loaded.snapshot.recovery?.summary ??
              loaded.snapshot.unknownReason ??
              'Interrupted operation pending postcondition reconciliation.';
            yield* coordinator.setUnresolvedTargets(opId, loaded.lockKeys, summary);
          }
        }
      });

      yield* loadExistingJournals();

      yield* Effect.addFinalizer(
        Effect.fnUntraced(function* () {
          shuttingDown = true;
          for (const entry of inFlight.values()) {
            if (entry.stage === 'Validating' || entry.stage === 'Prepared') {
              entry.cancelRequested = true;
            }
          }
          const pendingFibers = [...activeFibers];
          for (const fiber of pendingFibers) {
            yield* Fiber.await(fiber);
          }
        }),
      );

      const makeUpdatedSnapshot = (
        base: OperationSnapshot,
        now: number,
        patch: Partial<OperationSnapshot>,
      ): OperationSnapshot => ({
        ...base,
        ...patch,
        updatedAt: Timestamp.make(now),
      });

      const applyReconciliationOutcome = Effect.fnUntraced(function* (
        record: DurableOperationRecord,
        outcome: OperationReconciliationOutcome,
      ) {
        const now = yield* Clock.currentTimeMillis;
        let updated: DurableOperationRecord;
        switch (outcome._tag) {
          case 'Succeeded': {
            yield* coordinator.clearUnresolvedTargets(record.snapshot.id);
            updated = {
              ...record,
              metadata:
                outcome.metadata === undefined
                  ? record.metadata
                  : { ...record.metadata, ...outcome.metadata },
              snapshot: {
                id: record.snapshot.id,
                kind: record.snapshot.kind,
                title: record.snapshot.title,
                ...(record.snapshot.repositoryKey === undefined
                  ? {}
                  : { repositoryKey: record.snapshot.repositoryKey }),
                ...(record.snapshot.sourcePath === undefined
                  ? {}
                  : { sourcePath: record.snapshot.sourcePath }),
                ...(outcome.targetPath !== undefined
                  ? { targetPath: outcome.targetPath }
                  : record.snapshot.targetPath === undefined
                    ? {}
                    : { targetPath: record.snapshot.targetPath }),
                ...(outcome.branch !== undefined
                  ? { branch: outcome.branch }
                  : record.snapshot.branch === undefined
                    ? {}
                    : { branch: record.snapshot.branch }),
                phase: 'Completed',
                outcome: 'Succeeded',
                progress: { step: 'Done', detail: outcome.detail },
                warnings: record.snapshot.warnings,
                createdAt: record.snapshot.createdAt,
                updatedAt: Timestamp.make(now),
              },
            };
            break;
          }
          case 'FailedClean': {
            yield* coordinator.clearUnresolvedTargets(record.snapshot.id);
            updated = {
              ...record,
              snapshot: {
                id: record.snapshot.id,
                kind: record.snapshot.kind,
                title: record.snapshot.title,
                ...(record.snapshot.repositoryKey === undefined
                  ? {}
                  : { repositoryKey: record.snapshot.repositoryKey }),
                ...(record.snapshot.sourcePath === undefined
                  ? {}
                  : { sourcePath: record.snapshot.sourcePath }),
                ...(record.snapshot.targetPath === undefined
                  ? {}
                  : { targetPath: record.snapshot.targetPath }),
                ...(record.snapshot.branch === undefined ? {} : { branch: record.snapshot.branch }),
                phase: 'Completed',
                outcome: 'Failed',
                progress: { step: 'Done', detail: outcome.detail },
                warnings: record.snapshot.warnings,
                errorReason: outcome.errorReason ?? 'ExecutionFailed',
                errorDetail: outcome.detail,
                createdAt: record.snapshot.createdAt,
                updatedAt: Timestamp.make(now),
              },
            };
            break;
          }
          case 'NeedsRecovery': {
            yield* coordinator.setUnresolvedTargets(
              record.snapshot.id,
              record.lockKeys,
              outcome.recovery.summary,
            );
            updated = {
              ...record,
              snapshot: makeUpdatedSnapshot(record.snapshot, now, {
                phase: 'NeedsRecovery',
                outcome: outcome.outcome,
                progress: { step: 'Reconciling', detail: outcome.recovery.summary },
                recovery: outcome.recovery,
                ...(outcome.errorDetail === undefined ? {} : { errorDetail: outcome.errorDetail }),
                ...(outcome.unknownReason === undefined
                  ? {}
                  : { unknownReason: outcome.unknownReason }),
              }),
            };
            break;
          }
        }
        yield* persistRecord(updated);
        return updated.snapshot;
      });

      const runDurableExecution = Effect.fnUntraced(function* (
        request: ExecuteOperationRequest,
        flight: InFlightEntry,
      ) {
        const failFlight = (err: SourceControlError): Effect.Effect<void> =>
          Effect.sync(() => {
            inFlight.delete(request.operationId);
            Deferred.doneUnsafe(flight.deferred, Effect.fail(err));
          });

        const succeedFlight = (snapshot: OperationSnapshot): Effect.Effect<void> =>
          Effect.sync(() => {
            inFlight.delete(request.operationId);
            Deferred.doneUnsafe(flight.deferred, Effect.succeed(snapshot));
          });

        const body = Effect.gen(function* () {
          if (flight.cancelRequested) {
            const now = Timestamp.make(yield* Clock.currentTimeMillis);
            const cancelled: DurableOperationRecord = {
              version: 1,
              requestDigest: request.requestDigest,
              lockKeys: [...request.lockKeys],
              metadata: { ...request.metadata },
              snapshot: {
                id: request.operationId,
                kind: request.kind,
                title: request.title,
                ...(request.repositoryKey === undefined
                  ? {}
                  : { repositoryKey: request.repositoryKey }),
                ...(request.sourcePath === undefined ? {} : { sourcePath: request.sourcePath }),
                ...(request.targetPath === undefined ? {} : { targetPath: request.targetPath }),
                ...(request.branch === undefined ? {} : { branch: request.branch }),
                phase: 'Completed',
                outcome: 'Cancelled',
                progress: { step: 'Done', detail: 'Cancelled before preparation.' },
                warnings: [],
                errorDetail: 'Operation was cancelled before execution started.',
                createdAt: now,
                updatedAt: now,
              },
            };
            yield* persistRecord(cancelled);
            yield* succeedFlight(cancelled.snapshot);
            return;
          }

          const lockKeys = [...request.lockKeys];

          yield* coordinator.withReservation(
            {
              holderId: request.operationId,
              keys: lockKeys,
              mode: 'exclusive',
              reason: request.title,
              ...(request.waitMs === undefined ? {} : { waitMs: request.waitMs }),
              ...(request.failIfTurnActive === undefined
                ? {}
                : { failIfTurnActive: request.failIfTurnActive }),
            },
            Effect.gen(function* () {
              const prep = yield* request.prepare();
              const effectiveKeys = prep.lockKeys ?? lockKeys;
              const metadata =
                prep.metadata === undefined
                  ? { ...request.metadata }
                  : { ...request.metadata, ...prep.metadata };
              const targetPath = prep.targetPath ?? request.targetPath;
              const branch = prep.branch ?? request.branch;
              const warnings = [...(prep.warnings ?? [])];

              const createdAt = Timestamp.make(yield* Clock.currentTimeMillis);
              if (flight.cancelRequested) {
                const cancelled: DurableOperationRecord = {
                  version: 1,
                  requestDigest: request.requestDigest,
                  lockKeys: [...effectiveKeys],
                  metadata,
                  snapshot: {
                    id: request.operationId,
                    kind: request.kind,
                    title: request.title,
                    ...(request.repositoryKey === undefined
                      ? {}
                      : { repositoryKey: request.repositoryKey }),
                    ...(request.sourcePath === undefined ? {} : { sourcePath: request.sourcePath }),
                    ...(targetPath === undefined ? {} : { targetPath }),
                    ...(branch === undefined ? {} : { branch }),
                    phase: 'Completed',
                    outcome: 'Cancelled',
                    progress: { step: 'Done', detail: 'Cancelled before preparation journal.' },
                    warnings,
                    errorDetail: 'Operation was cancelled before execution began.',
                    createdAt,
                    updatedAt: createdAt,
                  },
                };
                yield* persistRecord(cancelled);
                yield* succeedFlight(cancelled.snapshot);
                return;
              }

              flight.stage = 'Prepared';
              let current: DurableOperationRecord = {
                version: 1,
                requestDigest: request.requestDigest,
                lockKeys: [...effectiveKeys],
                metadata,
                snapshot: {
                  id: request.operationId,
                  kind: request.kind,
                  title: request.title,
                  ...(request.repositoryKey === undefined
                    ? {}
                    : { repositoryKey: request.repositoryKey }),
                  ...(request.sourcePath === undefined ? {} : { sourcePath: request.sourcePath }),
                  ...(targetPath === undefined ? {} : { targetPath }),
                  ...(branch === undefined ? {} : { branch }),
                  phase: 'Prepared',
                  progress: { step: 'Preparing', detail: 'Operation prepared.' },
                  warnings,
                  createdAt,
                  updatedAt: createdAt,
                },
              };
              yield* persistRecord(current);

              if (flight.cancelRequested) {
                const now = yield* Clock.currentTimeMillis;
                current = {
                  ...current,
                  snapshot: makeUpdatedSnapshot(current.snapshot, now, {
                    phase: 'Completed',
                    outcome: 'Cancelled',
                    progress: { step: 'Done', detail: 'Cancelled before applying changes.' },
                    errorDetail: 'Operation was cancelled before mutation began.',
                  }),
                };
                yield* persistRecord(current);
                yield* succeedFlight(current.snapshot);
                return;
              }

              flight.stage = 'Applying';
              const applyingNow = yield* Clock.currentTimeMillis;
              current = {
                ...current,
                snapshot: makeUpdatedSnapshot(current.snapshot, applyingNow, {
                  phase: 'Applying',
                  progress: { step: 'ExecutingGit', detail: 'Running Git operation…' },
                }),
              };
              yield* persistRecord(current);

              const reportProgress = Effect.fnUntraced(function* (
                step: OperationProgress['step'],
                detail?: string,
              ): Effect.fn.Return<void> {
                const now = yield* Clock.currentTimeMillis;
                const progress: OperationProgress =
                  detail === undefined ? { step } : { step, detail };
                current = {
                  ...current,
                  snapshot: makeUpdatedSnapshot(current.snapshot, now, { progress }),
                };
                records.set(request.operationId, current);
                yield* PubSub.publish(updatesPubSub, current.snapshot);
              });

              const reportPathResults = Effect.fnUntraced(function* (
                pathResults: ReadonlyArray<OperationPathResult>,
              ) {
                const now = yield* Clock.currentTimeMillis;
                current = {
                  ...current,
                  snapshot: makeUpdatedSnapshot(current.snapshot, now, { pathResults }),
                };
                yield* persistRecord(current);
              });

              const applyOutcome = yield* request
                .apply({ record: current, reportProgress, reportPathResults })
                .pipe(
                  Effect.catchCause((cause) => {
                    if (Cause.hasDies(cause)) {
                      return Effect.failCause(cause);
                    }
                    if (request.propagateApplyFailure) {
                      const failure = Cause.findErrorOption(cause);
                      if (failure._tag === 'Some' && failure.value instanceof SourceControlError) {
                        return Effect.fail(failure.value);
                      }
                    }
                    const squashed = Cause.squash(cause);
                    const detail =
                      squashed instanceof SourceControlError ? squashed.detail : String(squashed);
                    return Effect.succeed({
                      _tag: 'Unknown' as const,
                      unknownReason: detail,
                      errorDetail: detail,
                      recovery: {
                        summary: 'Operation outcome could not be confirmed.',
                        detail,
                        observedFolderExists: false,
                        observedRegisteredInGit: false,
                        observedBranchExists: false,
                        canReconcile: true,
                        canDismiss: true,
                      },
                    });
                  }),
                );

              flight.stage = 'Settling';
              const settledNow = yield* Clock.currentTimeMillis;
              switch (applyOutcome._tag) {
                case 'Partial': {
                  current = {
                    ...current,
                    snapshot: makeUpdatedSnapshot(current.snapshot, settledNow, {
                      phase: 'Completed',
                      outcome: 'Partial',
                      pathResults: applyOutcome.pathResults,
                      progress: { step: 'Done' },
                    }),
                  };
                  yield* persistRecord(current);
                  yield* succeedFlight(current.snapshot);
                  break;
                }
                case 'Succeeded': {
                  current = {
                    ...current,
                    metadata:
                      applyOutcome.metadata === undefined
                        ? current.metadata
                        : { ...current.metadata, ...applyOutcome.metadata },
                    snapshot: makeUpdatedSnapshot(current.snapshot, settledNow, {
                      ...(applyOutcome.targetPath === undefined
                        ? {}
                        : { targetPath: applyOutcome.targetPath }),
                      ...(applyOutcome.branch === undefined ? {} : { branch: applyOutcome.branch }),
                      ...(applyOutcome.warnings === undefined
                        ? {}
                        : { warnings: [...applyOutcome.warnings] }),
                      phase: 'Completed',
                      outcome: 'Succeeded',
                      progress: { step: 'Done' },
                    }),
                  };
                  yield* persistRecord(current);
                  yield* succeedFlight(current.snapshot);
                  break;
                }
                case 'FailedClean': {
                  current = {
                    ...current,
                    snapshot: makeUpdatedSnapshot(current.snapshot, settledNow, {
                      phase: 'Completed',
                      outcome: 'Failed',
                      progress: { step: 'Done', detail: applyOutcome.errorDetail },
                      errorReason: applyOutcome.errorReason,
                      errorDetail: applyOutcome.errorDetail,
                    }),
                  };
                  yield* persistRecord(current);
                  yield* succeedFlight(current.snapshot);
                  break;
                }
                case 'Unknown': {
                  yield* coordinator.setUnresolvedTargets(
                    request.operationId,
                    current.lockKeys,
                    applyOutcome.recovery.summary,
                  );
                  current = {
                    ...current,
                    snapshot: makeUpdatedSnapshot(current.snapshot, settledNow, {
                      phase: 'NeedsRecovery',
                      outcome: 'Unknown',
                      progress: {
                        step: 'Reconciling',
                        detail: applyOutcome.recovery.summary,
                      },
                      recovery: applyOutcome.recovery,
                      unknownReason: applyOutcome.unknownReason,
                      ...(applyOutcome.errorDetail === undefined
                        ? {}
                        : { errorDetail: applyOutcome.errorDetail }),
                    }),
                  };
                  yield* persistRecord(current);
                  yield* succeedFlight(current.snapshot);
                  break;
                }
              }
            }),
          );
        });

        const exit = yield* Effect.exit(body);
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          if (failure._tag === 'Some') {
            yield* failFlight(failure.value);
          } else {
            // Unexpected defect (including test crash hooks): fail caller without touching on-disk journal!
            yield* Effect.sync(() => {
              inFlight.delete(request.operationId);
              Deferred.doneUnsafe(flight.deferred, Effect.failCause(exit.cause));
            });
          }
        }
      });

      return {
        execute: Effect.fn('Operations.execute')(function* (request: ExecuteOperationRequest) {
          if (!isSafeStoreId(request.operationId)) {
            return yield* new SourceControlError({
              reason: 'InvalidInput',
              detail: `Unsafe operation ID "${request.operationId}".`,
            });
          }
          if (shuttingDown) {
            return yield* new SourceControlError({
              reason: 'Busy',
              detail:
                'Application is shutting down and not accepting new Source Control operations.',
            });
          }

          const existingFlight = inFlight.get(request.operationId);
          if (existingFlight !== undefined) {
            if (
              existingFlight.kind !== request.kind ||
              existingFlight.requestDigest !== request.requestDigest
            ) {
              return yield* new SourceControlError({
                reason: 'Conflict',
                detail: `Operation "${request.operationId}" is already running with different parameters.`,
              });
            }
            return yield* Deferred.await(existingFlight.deferred);
          }

          const existingRecord = records.get(request.operationId);
          if (existingRecord !== undefined) {
            if (
              existingRecord.snapshot.kind !== request.kind ||
              existingRecord.requestDigest !== request.requestDigest
            ) {
              return yield* new SourceControlError({
                reason: 'Conflict',
                detail: `Operation "${request.operationId}" already exists with different parameters.`,
              });
            }
            return existingRecord.snapshot;
          }

          const deferred = Deferred.makeUnsafe<OperationSnapshot, SourceControlError>();
          const flight: InFlightEntry = {
            kind: request.kind,
            requestDigest: request.requestDigest,
            stage: 'Validating',
            cancelRequested: false,
            deferred,
          };
          inFlight.set(request.operationId, flight);

          const daemonFiber = yield* runDurableExecution(request, flight).pipe(
            Effect.forkIn(layerScope),
          );
          activeFibers.add(daemonFiber);
          yield* Fiber.await(daemonFiber).pipe(
            Effect.andThen(
              Effect.sync(() => {
                activeFibers.delete(daemonFiber);
              }),
            ),
            Effect.forkIn(layerScope),
          );

          return yield* Deferred.await(deferred);
        }),

        registerReconciler: (kind, reconciler) =>
          Effect.sync(() => {
            reconcilers.set(kind, reconciler);
          }),

        reconcilePendingForKind: Effect.fn('Operations.reconcilePendingForKind')(function* (kind) {
          const reconciler = reconcilers.get(kind);
          if (reconciler === undefined) return;
          const pending = [...records.values()].filter(
            (record) => record.snapshot.kind === kind && record.snapshot.phase === 'Applying',
          );
          for (const record of pending) {
            yield* coordinator.withReservation(
              {
                holderId: `reconcile:${record.snapshot.id}`,
                keys: record.lockKeys,
                mode: 'exclusive',
                reason: `Reconcile ${record.snapshot.title}`,
                ignoreRecoveryForOperationId: record.snapshot.id,
              },
              Effect.gen(function* () {
                const outcome = yield* reconciler(record);
                yield* applyReconciliationOutcome(record, outcome);
              }),
            );
          }
        }),

        reconcileOperation: Effect.fn('Operations.reconcileOperation')(function* (operationId) {
          const record = records.get(operationId);
          if (record === undefined) {
            return yield* new SourceControlError({
              reason: 'NotFound',
              detail: `Operation "${operationId}" was not found.`,
            });
          }
          if (inFlight.has(operationId)) {
            return yield* new SourceControlError({
              reason: 'Busy',
              detail: 'Operation is currently active; wait for it to finish before reconciling.',
            });
          }
          if (record.snapshot.phase === 'Completed') {
            return record.snapshot;
          }
          const reconciler = reconcilers.get(record.snapshot.kind);
          if (reconciler === undefined) {
            return yield* new SourceControlError({
              reason: 'OperationFailed',
              detail: `No reconciler is registered for operation kind "${record.snapshot.kind}".`,
            });
          }

          return yield* coordinator.withReservation(
            {
              holderId: `reconcile:${operationId}`,
              keys: record.lockKeys,
              mode: 'exclusive',
              reason: `Reconcile ${record.snapshot.title}`,
              ignoreRecoveryForOperationId: operationId,
            },
            Effect.gen(function* () {
              const latest = records.get(operationId) ?? record;
              const outcome = yield* reconciler(latest);
              return yield* applyReconciliationOutcome(latest, outcome);
            }),
          );
        }),

        dismissOperation: Effect.fn('Operations.dismissOperation')(function* (operationId) {
          const record = records.get(operationId);
          if (record === undefined) {
            return yield* new SourceControlError({
              reason: 'NotFound',
              detail: `Operation "${operationId}" was not found.`,
            });
          }
          if (inFlight.has(operationId)) {
            return yield* new SourceControlError({
              reason: 'Busy',
              detail: 'Cannot dismiss an operation while it is still running.',
            });
          }
          yield* coordinator.clearUnresolvedTargets(operationId);
          if (record.snapshot.phase === 'Completed') {
            return record.snapshot;
          }
          const now = yield* Clock.currentTimeMillis;
          const updated: DurableOperationRecord = {
            ...record,
            snapshot: {
              id: record.snapshot.id,
              kind: record.snapshot.kind,
              title: record.snapshot.title,
              ...(record.snapshot.repositoryKey === undefined
                ? {}
                : { repositoryKey: record.snapshot.repositoryKey }),
              ...(record.snapshot.sourcePath === undefined
                ? {}
                : { sourcePath: record.snapshot.sourcePath }),
              ...(record.snapshot.targetPath === undefined
                ? {}
                : { targetPath: record.snapshot.targetPath }),
              ...(record.snapshot.branch === undefined ? {} : { branch: record.snapshot.branch }),
              phase: 'Completed',
              outcome: 'Cancelled',
              progress: { step: 'Done', detail: 'Dismissed after inspection.' },
              warnings: record.snapshot.warnings,
              ...(record.snapshot.pathResults === undefined
                ? {}
                : { pathResults: record.snapshot.pathResults }),
              errorDetail: 'Dismissed by user after inspection.',
              createdAt: record.snapshot.createdAt,
              updatedAt: Timestamp.make(now),
            },
          };
          yield* persistRecord(updated);
          return updated.snapshot;
        }),

        cancelOperation: Effect.fn('Operations.cancelOperation')(function* (operationId) {
          const flight = inFlight.get(operationId);
          if (flight !== undefined) {
            if (flight.stage === 'Applying' || flight.stage === 'Settling') {
              return yield* new SourceControlError({
                reason: 'Conflict',
                detail:
                  'Operation has already started mutating Git state and cannot be cancelled mid-step.',
              });
            }
            flight.cancelRequested = true;
            const now = Timestamp.make(yield* Clock.currentTimeMillis);
            const existing = records.get(operationId);
            const cancelled: DurableOperationRecord =
              existing !== undefined
                ? {
                    ...existing,
                    snapshot: makeUpdatedSnapshot(existing.snapshot, now, {
                      phase: 'Completed',
                      outcome: 'Cancelled',
                      progress: { step: 'Done', detail: 'Cancelled before mutation.' },
                      errorDetail: 'Operation cancelled by user before execution started.',
                    }),
                  }
                : {
                    version: 1,
                    requestDigest: flight.requestDigest,
                    lockKeys: [],
                    metadata: {},
                    snapshot: {
                      id: operationId,
                      kind: flight.kind,
                      title: 'Cancelled operation',
                      phase: 'Completed',
                      outcome: 'Cancelled',
                      progress: { step: 'Done', detail: 'Cancelled before preparation.' },
                      warnings: [],
                      errorDetail: 'Operation cancelled by user before execution started.',
                      createdAt: now,
                      updatedAt: now,
                    },
                  };
            yield* persistRecord(cancelled);
            inFlight.delete(operationId);
            Deferred.doneUnsafe(flight.deferred, Effect.succeed(cancelled.snapshot));
            return cancelled.snapshot;
          }

          const existing = records.get(operationId);
          if (existing === undefined) {
            return yield* new SourceControlError({
              reason: 'NotFound',
              detail: `Operation "${operationId}" was not found.`,
            });
          }
          if (existing.snapshot.phase === 'Completed') {
            return existing.snapshot;
          }
          return yield* new SourceControlError({
            reason: 'Conflict',
            detail:
              'Only pending pre-execution operations can be cancelled; use reconcile or dismiss for recovery states.',
          });
        }),

        listOperations: Effect.fn('Operations.listOperations')(function* (filter) {
          const all = [...records.values()].map((r) => r.snapshot);
          const filtered = all.filter((snap) => {
            if (
              filter?.repositoryKey !== undefined &&
              snap.repositoryKey !== filter.repositoryKey
            ) {
              return false;
            }
            if (filter?.sourcePath !== undefined && snap.sourcePath !== filter.sourcePath) {
              return false;
            }
            return true;
          });
          return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
        }),

        getOperation: Effect.fn('Operations.getOperation')(function* (operationId) {
          const found = records.get(operationId);
          if (found === undefined) {
            return yield* new SourceControlError({
              reason: 'NotFound',
              detail: `Operation "${operationId}" was not found.`,
            });
          }
          return found.snapshot;
        }),

        awaitOperation: Effect.fn('Operations.awaitOperation')(function* (operationId) {
          const flight = inFlight.get(operationId);
          if (flight !== undefined) {
            return yield* Deferred.await(flight.deferred);
          }
          const found = records.get(operationId);
          if (found === undefined) {
            return yield* new SourceControlError({
              reason: 'NotFound',
              detail: `Operation "${operationId}" was not found.`,
            });
          }
          return found.snapshot;
        }),

        updates: Stream.fromPubSub(updatesPubSub),
      } satisfies OperationsShape;
    }),
  );

/** Live `Operations` layer over `<Store>/operations` and `ReservationCoordinator`. */
export const layerOperations: Layer.Layer<
  Operations,
  SourceControlError,
  Store | ReservationCoordinator
> = makeLayerOperations();
