import { describe, expect, it } from '@effect/vitest';
import { Deferred, Duration, Effect, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  OperationId,
  ReviewId,
  SourceControlError,
} from '../../src/shared/source-control/source-control.rpc';
import { Timestamp } from '../../src/shared/projects/projects.rpc';
import { layerMergedPath, layerPathSources } from '../agents/merged-path';
import { DurableOperationRecord, Operations, layerOperations } from '../source-control/operations';
import {
  ReservationCoordinator,
  layerReservationCoordinator,
  reservationKeys,
} from '../source-control/reservation-coordinator';
import { layerReviewRegistry } from '../source-control/review-registry';
import { folderKey } from '../projects/folder-key';
import { writeJsonDurable } from '../store/durable';
import { layerStore } from '../store/store';
import {
  type GitWorker,
  layerGitWorkerDirect,
  layerGitWorkerWithPort,
  type WorkerClientTransport,
} from './git-client';
import { handleWorkerRequest } from '../worker/git-worker-core';
import type { WorkerRequest, WorkerResponse } from '../worker/worker-protocol';
import { WorktreeCreate, layerWorktreeCreate } from './worktree-create';
import { Worktrees, layerWorktrees } from './worktrees';

const execFile = promisify(execFileCb);
const TIMEOUT = 20_000;

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFile('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Spence Test',
      GIT_AUTHOR_EMAIL: 'spence@example.com',
      GIT_COMMITTER_NAME: 'Spence Test',
      GIT_COMMITTER_EMAIL: 'spence@example.com',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
    shell: false,
    windowsHide: true,
  });

const gitEff = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.tryPromise(async () => (await git(cwd, ...args)).stdout);

const withTempEnv = <A, E, R>(
  fn: (env: {
    readonly dir: string;
    readonly storeRoot: string;
    readonly repo: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'spence-wt-create-'));
      const storeRoot = path.join(dir, 'store');
      const repo = path.join(dir, 'repo');
      await mkdir(storeRoot, { recursive: true });
      await mkdir(repo, { recursive: true });
      return { dir, storeRoot, repo };
    }),
    fn,
    ({ dir }) =>
      Effect.promise(() =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  );

const initRealRepo = Effect.fnUntraced(function* (repo: string) {
  yield* gitEff(repo, 'init', '-b', 'main');
  yield* gitEff(repo, 'config', 'user.email', 'test@spence.local');
  yield* gitEff(repo, 'config', 'user.name', 'Spence Test');
  yield* Effect.tryPromise(() => writeFile(path.join(repo, 'app.txt'), 'v1\n', 'utf8'));
  yield* gitEff(repo, 'add', '.');
  yield* gitEff(repo, 'commit', '-m', 'initial commit');
  return (yield* gitEff(repo, 'rev-parse', 'HEAD')).trim();
});

const makeLayerWithWorker = (
  storeRoot: string,
  gitWorkerLayer: Layer.Layer<GitWorker, never, never>,
) => {
  const base = Layer.mergeAll(
    layerPathSources,
    layerStore(storeRoot),
    layerReservationCoordinator,
    layerReviewRegistry,
    gitWorkerLayer,
  );
  const ops = layerOperations.pipe(Layer.provideMerge(base));
  const wt = layerWorktrees.pipe(Layer.provideMerge(ops));
  return layerWorktreeCreate.pipe(Layer.provideMerge(wt));
};

const makeDirectLayer = (storeRoot: string) => {
  const merged = layerMergedPath.pipe(Layer.provideMerge(layerPathSources));
  const worker = layerGitWorkerDirect.pipe(Layer.provide(merged));
  return makeLayerWithWorker(storeRoot, worker);
};

describe('WorktreeCreate domain service', () => {
  it.effect(
    'prepares defaults from current HEAD, creates new branch and existing branch worktrees cleanly, and retains dirty source files',
    () =>
      withTempEnv(({ dir, storeRoot, repo }) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(1_000_000);
          const headSha = yield* initRealRepo(repo);
          yield* gitEff(repo, 'branch', 'ready-existing');
          yield* Effect.tryPromise(() =>
            writeFile(path.join(repo, 'app.txt'), 'v1-dirty\n', 'utf8'),
          );
          yield* Effect.tryPromise(() =>
            writeFile(path.join(repo, 'notes.md'), 'unsaved\n', 'utf8'),
          );

          const wtCreate = yield* WorktreeCreate;
          const worktrees = yield* Worktrees;

          const review = yield* wtCreate.prepareCreate({ path: repo });
          expect(review.sourceDirtyCount).toBe(2);
          expect(review.sourceHead).toEqual({
            _tag: 'Branch',
            branch: 'main',
            ref: 'refs/heads/main',
            commit: headSha,
          });
          expect(review.blockers).toEqual([]);
          expect(review.eligibleBranches.find((b) => b.name === 'ready-existing')).toMatchObject({
            checkedOut: false,
            commit: headSha,
          });
          expect(review.eligibleBranches.find((b) => b.name === 'main')).toMatchObject({
            checkedOut: true,
          });
          expect(review.defaultBranch.length).toBeGreaterThan(0);
          expect(review.defaultDestination).not.toBe(repo);

          const customDest = path.join(dir, 'repo-custom-feature');
          const res1 = yield* wtCreate.executeCreate({
            reviewId: review.reviewId,
            operationId: OperationId.make('op-create-1'),
            sourcePath: repo,
            destinationPath: customDest,
            branch: 'feat/custom',
            startFrom: { mode: 'Head' },
          });

          expect(res1.operation.phase).toBe('Completed');
          expect(res1.operation.outcome).toBe('Succeeded');
          expect(res1.worktree?.head).toEqual({
            _tag: 'Branch',
            branch: 'feat/custom',
            ref: 'refs/heads/feat/custom',
            commit: headSha,
          });

          // Dirty source files remain intact in original checkout; created worktree is clean.
          expect(yield* Effect.tryPromise(() => readFile(path.join(repo, 'app.txt'), 'utf8'))).toBe(
            'v1-dirty\n',
          );
          expect(
            yield* Effect.tryPromise(() => readFile(path.join(repo, 'notes.md'), 'utf8')),
          ).toBe('unsaved\n');
          expect(
            (yield* Effect.tryPromise(() =>
              readFile(path.join(customDest, 'app.txt'), 'utf8'),
            )).replace(/\r\n/g, '\n'),
          ).toBe('v1\n');

          // Inventory includes the new Worktree cleanly.
          const inv = yield* worktrees.inventory(repo);
          expect(
            inv.worktrees.some((w) => w.head._tag === 'Branch' && w.head.branch === 'feat/custom'),
          ).toBe(true);

          // Also verify checkout of an existing eligible branch.
          const review2 = yield* wtCreate.prepareCreate({ path: repo });
          const dest2 = path.join(dir, 'repo-existing-branch');
          const res2 = yield* wtCreate.executeCreate({
            reviewId: review2.reviewId,
            operationId: OperationId.make('op-create-2'),
            sourcePath: repo,
            destinationPath: dest2,
            branch: 'ready-existing',
            startFrom: { mode: 'Branch', branch: 'ready-existing' },
          });
          expect(res2.operation.outcome).toBe('Succeeded');
          expect(res2.worktree?.head).toEqual({
            _tag: 'Branch',
            branch: 'ready-existing',
            ref: 'refs/heads/ready-existing',
            commit: headSha,
          });
        }).pipe(Effect.provide(makeDirectLayer(storeRoot))),
      ),
    TIMEOUT,
  );

  it.effect(
    'enforces OperationId idempotency and rejects conflicting reuse, stale reviews, and expired reviews',
    () =>
      withTempEnv(({ dir, storeRoot, repo }) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(2_000_000);
          yield* initRealRepo(repo);
          const wtCreate = yield* WorktreeCreate;

          // 1. Expired review fails under TestClock.
          const expiredRev = yield* wtCreate.prepareCreate({ path: repo });
          yield* TestClock.adjust(Duration.minutes(15));
          const expiredRes = yield* wtCreate
            .executeCreate({
              reviewId: expiredRev.reviewId,
              operationId: OperationId.make('op-expired'),
              sourcePath: repo,
              destinationPath: path.join(dir, 'wt-exp'),
              branch: 'feat/exp',
              startFrom: { mode: 'Head' },
            })
            .pipe(Effect.result);
          expect(expiredRes._tag).toBe('Failure');
          if (expiredRes._tag === 'Failure') {
            expect(expiredRes.failure.reason).toBe('ReviewExpired');
          }

          // 2. Stale review when HEAD moves after prepareCreate.
          const staleRev = yield* wtCreate.prepareCreate({ path: repo });
          yield* Effect.tryPromise(() => writeFile(path.join(repo, 'app.txt'), 'v2\n', 'utf8'));
          yield* gitEff(repo, 'add', '.');
          yield* gitEff(repo, 'commit', '-m', 'second commit');
          const staleHeadRes = yield* wtCreate
            .executeCreate({
              reviewId: staleRev.reviewId,
              operationId: OperationId.make('op-stale-head'),
              sourcePath: repo,
              destinationPath: path.join(dir, 'wt-stale-head'),
              branch: 'feat/stale-head',
              startFrom: { mode: 'Head' },
            })
            .pipe(Effect.result);
          expect(staleHeadRes._tag).toBe('Failure');
          if (staleHeadRes._tag === 'Failure') {
            expect(staleHeadRes.failure.reason).toBe('StaleReview');
          }

          // 3. Tight revalidation catches destination appearance after review.
          const freshRev = yield* wtCreate.prepareCreate({ path: repo });
          const tightDest = path.join(dir, 'wt-tight');
          const tightRev = yield* wtCreate.revalidateCreate({
            reviewId: freshRev.reviewId,
            sourcePath: repo,
            destinationPath: tightDest,
            branch: 'feat/tight',
            startFrom: { mode: 'Head' },
          });
          expect(tightRev.stale).toBe(false);
          yield* Effect.tryPromise(() => mkdir(tightDest, { recursive: true }));
          const destDrifted = yield* wtCreate
            .executeCreate({
              reviewId: tightRev.reviewId,
              operationId: OperationId.make('op-stale-dest'),
              sourcePath: repo,
              destinationPath: tightDest,
              branch: 'feat/tight',
              startFrom: { mode: 'Head' },
            })
            .pipe(Effect.result);
          expect(destDrifted._tag).toBe('Failure');
          if (destDrifted._tag === 'Failure') {
            expect(destDrifted.failure.reason).toBe('StaleReview');
          }

          // 4. Duplicate OperationId is idempotent; conflicting OperationId rejects cleanly.
          const okRev = yield* wtCreate.prepareCreate({ path: repo });
          const okDest = path.join(dir, 'wt-ok');
          const opId = OperationId.make('op-idem');
          const first = yield* wtCreate.executeCreate({
            reviewId: okRev.reviewId,
            operationId: opId,
            sourcePath: repo,
            destinationPath: okDest,
            branch: 'feat/ok',
            startFrom: { mode: 'Head' },
          });
          expect(first.operation.outcome).toBe('Succeeded');

          const dup = yield* wtCreate.executeCreate({
            reviewId: okRev.reviewId,
            operationId: opId,
            sourcePath: repo,
            destinationPath: okDest,
            branch: 'feat/ok',
            startFrom: { mode: 'Head' },
          });
          expect(dup.operation.id).toBe(opId);
          expect(dup.operation.outcome).toBe('Succeeded');

          const conflicting = yield* wtCreate
            .executeCreate({
              reviewId: okRev.reviewId,
              operationId: opId,
              sourcePath: repo,
              destinationPath: path.join(dir, 'wt-different'),
              branch: 'feat/different',
              startFrom: { mode: 'Head' },
            })
            .pipe(Effect.result);
          expect(conflicting._tag).toBe('Failure');
          if (conflicting._tag === 'Failure') {
            expect(conflicting.failure.reason).toBe('Conflict');
          }
        }).pipe(Effect.provide(makeDirectLayer(storeRoot))),
      ),
    TIMEOUT,
  );

  it.effect(
    'rejects untrusted destinations and branch names cleanly without creating files',
    () =>
      withTempEnv(({ dir, storeRoot, repo }) =>
        Effect.gen(function* () {
          yield* initRealRepo(repo);
          const wtCreate = yield* WorktreeCreate;
          const rev = yield* wtCreate.prepareCreate({ path: repo });

          const insideRes = yield* wtCreate
            .executeCreate({
              reviewId: rev.reviewId,
              operationId: OperationId.make('op-untrusted-inside'),
              sourcePath: repo,
              destinationPath: path.join(repo, 'sub-wt'),
              branch: 'feat/inside',
              startFrom: { mode: 'Head' },
            })
            .pipe(Effect.result);
          expect(insideRes._tag).toBe('Failure');
          if (insideRes._tag === 'Failure') {
            expect(insideRes.failure.reason).toBe('UntrustedPath');
          }

          const badBranchRes = yield* wtCreate
            .executeCreate({
              reviewId: rev.reviewId,
              operationId: OperationId.make('op-invalid-branch'),
              sourcePath: repo,
              destinationPath: path.join(dir, 'wt-bad-branch'),
              branch: '--help',
              startFrom: { mode: 'Head' },
            })
            .pipe(Effect.result);
          expect(badBranchRes._tag).toBe('Failure');
          if (badBranchRes._tag === 'Failure') {
            expect(badBranchRes.failure.reason).toBe('InvalidInput');
          }

          const missingReview = yield* wtCreate
            .executeCreate({
              reviewId: ReviewId.make('rev-unknown'),
              operationId: OperationId.make('op-unknown-rev'),
              sourcePath: repo,
              destinationPath: path.join(dir, 'wt-missing-rev'),
              branch: 'feat/ok',
              startFrom: { mode: 'Head' },
            })
            .pipe(Effect.result);
          expect(missingReview._tag).toBe('Failure');
          if (missingReview._tag === 'Failure') {
            expect(missingReview.failure.reason).toBe('StaleReview');
          }
        }).pipe(Effect.provide(makeDirectLayer(storeRoot))),
      ),
    TIMEOUT,
  );

  it.effect(
    'marks worker exit mid-creation as Unknown NeedsRecovery and reconciles postconditions cleanly without replaying',
    () =>
      withTempEnv(({ dir, storeRoot, repo }) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(3_000_000);
          yield* initRealRepo(repo);
          const destCrash = path.join(dir, 'wt-crash');
          let failNextCreate = true;
          let createWorkerCalls = 0;

          const merged = layerMergedPath.pipe(Layer.provideMerge(layerPathSources));
          const listeners = new Set<(response: WorkerResponse) => void>();
          const exitListeners = new Set<(code: number) => void>();

          const transport: WorkerClientTransport = {
            onResponse: (listener) => {
              listeners.add(listener);
              return () => void listeners.delete(listener);
            },
            onExit: (listener) => {
              exitListeners.add(listener);
              return () => void exitListeners.delete(listener);
            },
            postRequest: (request: WorkerRequest) => {
              if (request.method === 'git.createWorktree' && failNextCreate) {
                createWorkerCalls += 1;
                failNextCreate = false;
                // Simulate git actually creating the worktree on disk BEFORE worker crashes exiting!
                void handleWorkerRequest(request).then(() => {
                  for (const listener of exitListeners) listener(137);
                });
                return;
              }
              if (request.method === 'git.createWorktree') {
                createWorkerCalls += 1;
              }
              void handleWorkerRequest(request).then((response) => {
                for (const listener of listeners) listener(response);
              });
            },
            shutdown: () => Effect.void,
          };

          const workerLayer = layerGitWorkerWithPort(transport).pipe(Layer.provide(merged));

          // Phase 1: Execute hits worker crash -> MUST return Unknown / NeedsRecovery cleanly.
          yield* Effect.gen(function* () {
            const wtCreate = yield* WorktreeCreate;
            const rev = yield* wtCreate.prepareCreate({ path: repo });
            const res = yield* wtCreate.executeCreate({
              reviewId: rev.reviewId,
              operationId: OperationId.make('op-worker-crash'),
              sourcePath: repo,
              destinationPath: destCrash,
              branch: 'feat/crash-survived',
              startFrom: { mode: 'Head' },
            });
            expect(res.operation.phase).toBe('NeedsRecovery');
            expect(res.operation.outcome).toBe('Unknown');
            expect(res.operation.recovery?.observedRegisteredInGit).toBe(true);
            expect(createWorkerCalls).toBe(1);
          }).pipe(Effect.provide(makeLayerWithWorker(storeRoot, workerLayer)));

          // Phase 2: Reconcile after simulated worker restart -> verifies postconditions cleanly without calling createWorktree again!
          yield* Effect.gen(function* () {
            const ops = yield* Operations;
            const worktrees = yield* Worktrees;
            const reconciled = yield* ops.reconcileOperation(OperationId.make('op-worker-crash'));
            expect(reconciled.phase).toBe('Completed');
            expect(reconciled.outcome).toBe('Succeeded');
            expect(createWorkerCalls).toBe(1);

            const inv = yield* worktrees.inventory(repo);
            expect(
              inv.worktrees.some(
                (w) => w.head._tag === 'Branch' && w.head.branch === 'feat/crash-survived',
              ),
            ).toBe(true);
          }).pipe(Effect.provide(makeDirectLayer(storeRoot)));
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    'continues Worktree creation after RPC caller disconnect and reconciles restart crash automatically',
    () =>
      withTempEnv(({ dir, storeRoot, repo }) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(4_000_000);
          yield* initRealRepo(repo);
          const destDisc = path.join(dir, 'wt-disconnect');
          let releasePromiseResolve = (): void => {};
          const releasePromise = new Promise<void>((resolve) => {
            releasePromiseResolve = resolve;
          });
          let startedCreateResolve = (): void => {};
          const startedCreatePromise = new Promise<void>((resolve) => {
            startedCreateResolve = resolve;
          });

          const merged = layerMergedPath.pipe(Layer.provideMerge(layerPathSources));
          const listeners = new Set<(response: WorkerResponse) => void>();
          const transport: WorkerClientTransport = {
            onResponse: (listener) => {
              listeners.add(listener);
              return () => void listeners.delete(listener);
            },
            postRequest: (request) => {
              if (request.method === 'git.createWorktree') {
                startedCreateResolve();
                void releasePromise
                  .then(() => handleWorkerRequest(request))
                  .then((response) => {
                    for (const l of listeners) l(response);
                  });
                return;
              }
              void handleWorkerRequest(request).then((response) => {
                for (const l of listeners) l(response);
              });
            },
            shutdown: () => Effect.void,
          };
          const workerLayer = layerGitWorkerWithPort(transport).pipe(Layer.provide(merged));

          yield* Effect.gen(function* () {
            const wtCreate = yield* WorktreeCreate;
            const ops = yield* Operations;
            const rev = yield* wtCreate.prepareCreate({ path: repo });
            const opId = OperationId.make('op-rpc-disc');
            const callerFiber = yield* wtCreate
              .executeCreate({
                reviewId: rev.reviewId,
                operationId: opId,
                sourcePath: repo,
                destinationPath: destDisc,
                branch: 'feat/disc-survives',
                startFrom: { mode: 'Head' },
              })
              .pipe(Effect.forkChild);

            yield* Effect.promise(() => startedCreatePromise);
            yield* Fiber.interrupt(callerFiber);

            // Finish worker request after disconnect; durable operation must complete on disk!
            releasePromiseResolve();
            const completed = yield* ops.awaitOperation(opId);
            expect(completed.phase).toBe('Completed');
            expect(completed.outcome).toBe('Succeeded');
          }).pipe(Effect.provide(makeLayerWithWorker(storeRoot, workerLayer)));
          void Deferred;
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    'reconciles interrupted Applying journals on startup without replaying creation (succeeded on disk vs incomplete crash)',
    () =>
      withTempEnv(({ dir, storeRoot, repo }) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(5_000_000);
          const headSha = yield* initRealRepo(repo);
          const destAlreadyCreated = path.join(dir, 'wt-startup-ok');
          const destNotCreated = path.join(dir, 'wt-startup-incomplete');

          // Case 1: git worktree add finished on disk right before process died leaving phase: 'Applying'
          yield* gitEff(repo, 'worktree', 'add', '-b', 'feat/startup-ok', destAlreadyCreated);
          const realOkDest = (yield* gitEff(
            destAlreadyCreated,
            'rev-parse',
            '--show-toplevel',
          )).trim();
          const okOpId = OperationId.make('op-startup-ok');
          const ts = Timestamp.make(4_999_000);
          const okRecord: DurableOperationRecord = {
            version: 1,
            snapshot: {
              id: okOpId,
              kind: 'Worktree.create',
              title: 'Create Worktree (feat/startup-ok)',
              phase: 'Applying',
              progress: { step: 'ExecutingGit', detail: 'Creating worktree...' },
              warnings: [],
              sourcePath: repo,
              targetPath: realOkDest,
              branch: 'feat/startup-ok',
              createdAt: ts,
              updatedAt: ts,
            },
            requestDigest: 'digest-startup-ok',
            lockKeys: [reservationKeys.folder(folderKey(realOkDest, process.platform))],
            metadata: {
              sourcePath: repo,
              destinationPath: realOkDest,
              branch: 'feat/startup-ok',
              mode: 'NewBranch',
              startCommit: headSha,
            },
          };
          yield* writeJsonDurable(
            path.join(storeRoot, 'operations', okOpId, 'journal.json'),
            okRecord,
            DurableOperationRecord,
          );

          // Case 2: crash before git worktree add ran at all, leaving phase: 'Applying' on disk
          const failOpId = OperationId.make('op-startup-incomplete');
          const failLockKey = reservationKeys.folder(folderKey(destNotCreated, process.platform));
          const failRecord: DurableOperationRecord = {
            version: 1,
            snapshot: {
              id: failOpId,
              kind: 'Worktree.create',
              title: 'Create Worktree (feat/startup-incomplete)',
              phase: 'Applying',
              progress: { step: 'ExecutingGit', detail: 'Creating worktree...' },
              warnings: [],
              sourcePath: repo,
              targetPath: destNotCreated,
              branch: 'feat/startup-incomplete',
              createdAt: ts,
              updatedAt: ts,
            },
            requestDigest: 'digest-startup-incomplete',
            lockKeys: [failLockKey],
            metadata: {
              sourcePath: repo,
              destinationPath: destNotCreated,
              branch: 'feat/startup-incomplete',
              mode: 'NewBranch',
              startCommit: headSha,
            },
          };
          yield* writeJsonDurable(
            path.join(storeRoot, 'operations', failOpId, 'journal.json'),
            failRecord,
            DurableOperationRecord,
          );

          let createWorkerCalls = 0;
          const merged = layerMergedPath.pipe(Layer.provideMerge(layerPathSources));
          const listeners = new Set<(response: WorkerResponse) => void>();
          const transport: WorkerClientTransport = {
            onResponse: (listener) => {
              listeners.add(listener);
              return () => void listeners.delete(listener);
            },
            postRequest: (request) => {
              if (request.method === 'git.createWorktree') {
                createWorkerCalls += 1;
              }
              void handleWorkerRequest(request).then((response) => {
                for (const l of listeners) l(response);
              });
            },
            shutdown: () => Effect.void,
          };
          const countingWorker = layerGitWorkerWithPort(transport).pipe(Layer.provide(merged));

          // Cold start boots fresh services -> startup reconciler runs automatically without replaying creation!
          yield* Effect.gen(function* () {
            const ops = yield* Operations;
            const coordinator = yield* ReservationCoordinator;

            const okSnap = yield* ops.getOperation(okOpId);
            expect(okSnap.phase).toBe('Completed');
            expect(okSnap.outcome).toBe('Succeeded');

            const failSnap = yield* ops.getOperation(failOpId);
            expect(failSnap.phase).toBe('NeedsRecovery');
            expect(failSnap.outcome).toBe('NeedsRecovery');
            expect(failSnap.recovery?.observedFolderExists).toBe(false);
            expect(failSnap.recovery?.observedRegisteredInGit).toBe(false);
            expect(failSnap.recovery?.canDismiss).toBe(true);

            // Unresolved recovery lock blocks conflicting lockKeys until dismissed cleanly
            const blockedErr = yield* coordinator
              .withReservation(
                {
                  holderId: 'test-after-crash',
                  keys: [failLockKey],
                  mode: 'exclusive',
                  reason: 'Verify recovery lock',
                },
                Effect.succeed('should-block'),
              )
              .pipe(Effect.flip);
            expect(blockedErr._tag).toBe('SourceControlError');
            if (blockedErr._tag === 'SourceControlError') {
              expect(blockedErr.reason).toBe('RecoveryRequired');
            }

            const dismissed = yield* ops.dismissOperation(failOpId);
            expect(dismissed.phase).toBe('Completed');
            expect(dismissed.outcome).toBe('Cancelled');

            const afterDismiss = yield* coordinator.withReservation(
              {
                holderId: 'test-after-dismiss',
                keys: [failLockKey],
                mode: 'exclusive',
                reason: 'Verify unblocked',
              },
              Effect.succeed('unblocked'),
            );
            expect(afterDismiss).toBe('unblocked');
            expect(createWorkerCalls).toBe(0);
          }).pipe(Effect.provide(makeLayerWithWorker(storeRoot, countingWorker)));
          void SourceControlError;
        }),
      ),
    TIMEOUT,
  );
});
