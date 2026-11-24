import { shell } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import {
  type Cause,
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  pipe,
  Queue,
  Schema,
  Stream,
} from 'effect';
import {
  type AgentId,
  type InstallEvent,
  InstallFailure,
  type InstallPhase,
  type InstallStatus,
} from '../../src/shared/agents/agents.rpc';
import { Store } from '../store/store';
import { Agents } from './agents';
import { catalog, type CatalogEntry } from './catalog';
import { e2eAgentBin, e2eFakeAgent } from './e2e-agent';
import { type Env } from './exec';
import { inspectManagedAgent, inspectManagedPrefix, managedAgentDir } from './managed';
import { MergedPath, PathSources } from './merged-path';
import {
  AgentInstallIoError,
  AgentRuntime,
  type ManagedRuntimePaths,
  type RuntimeArchiveError,
  stripAppImageEnv,
  stripNpmConfigEnv,
  swapDirectory,
} from './runtime';
import { killChildProcessTree } from './spawn';

class AdapterInstallError extends Schema.TaggedError<AdapterInstallError>()('AdapterInstallError', {
  reason: InstallFailure,
  detail: Schema.String,
}) {}

/** Installs packaged (`npm`) Catalog Agents into isolated per-Agent prefixes using Spence's managed Node runtime. */
export class AgentInstall extends Context.Service<
  AgentInstall,
  {
    /**
     * Phased setup stream (`downloadingRuntime` -> `installingAdapter` -> `succeeded` | `cancelled` | `failed`).
     * Disconnecting from the stream detaches only the caller; the main-process job continues until completion or
     * explicit `cancel` / `cancelAll`.
     */
    readonly install: (agentId: AgentId) => Stream.Stream<InstallEvent>;
    /** Aborts an active setup job for `agentId`, cleans staging, and emits `cancelled` to attached streams. */
    readonly cancel: (agentId: AgentId) => Effect.Effect<void>;
    /** Aborts all active setup jobs and awaits process-tree + staging cleanup (used on app shutdown). */
    readonly cancelAll: Effect.Effect<void>;
    /** Current active setup status for `agentId`, or `{ _tag: 'idle' }` when none is running. */
    readonly status: (agentId: AgentId) => Effect.Effect<InstallStatus>;
    /** `<userData>/spence/logs/agents/install.log`. */
    readonly logPath: string;
    /** Opens the install log in the system's viewer; a log that cannot be opened (e.g. not written yet) is only logged. */
    readonly openLog: Effect.Effect<void>;
  }
>()('agents/AgentInstall') {}

const npmInstallArgs = (
  npmCli: string,
  stagingDir: string,
  entry: CatalogEntry,
): ReadonlyArray<string> => [
  npmCli,
  'install',
  '--prefix',
  stagingDir,
  '--no-save',
  '--no-package-lock',
  '--no-audit',
  '--no-fund',
  '--no-update-notifier',
  entry.installPackage ?? entry.package,
];

/** Unknown ids are a renderer bug: the renderer only ever names Agents it got from `Agents.list`. */
const entryOf = (agentId: AgentId, env: Env) => {
  const candidates = e2eAgentBin(env) !== undefined ? [...catalog, e2eFakeAgent] : catalog;
  return Option.fromNullishOr(candidates.find((entry) => entry.id === agentId)).pipe(
    Option.match({
      onNone: () => Effect.die(`Unknown Agent ${agentId}`),
      onSome: Effect.succeed,
    }),
  );
};

/** npm's error lines (`npm error …`, or `npm ERR! …` before npm 10) without their prefix. */
const npmErrorLines = (output: string): ReadonlyArray<string> =>
  output
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^npm (?:error|ERR!)\s+(.*)$/.exec(line.trim());
      return match?.[1] === undefined ? [] : [match[1].trim()];
    })
    .filter((line) => line.length > 0);

/** The line that says what went wrong: npm's first error line that is not just its code or syscall. */
const oneLine = (output: string, code: number | null): string =>
  npmErrorLines(output).find((line) => !/^(code|syscall|errno|path)\b/.test(line)) ??
  `npm exited with code ${String(code)}`;

const failureOf = (output: string): InstallFailure =>
  /\b(EACCES|EPERM)\b/.test(output) ? 'PermissionDenied' : 'NpmFailed';

const runtimeFailureReason = (error: RuntimeArchiveError): InstallFailure =>
  error.reason === 'ChecksumMismatch' ? 'ChecksumMismatch' : 'RuntimeDownloadFailed';

const openLogStream = (logPath: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      await mkdir(dirname(logPath), { recursive: true });
      return createWriteStream(logPath, { flags: 'a' });
    }),
    (log) =>
      Effect.callback<void>((resume) => {
        log.end(() => resume(Effect.void));
      }),
  );

/** Copies the child's output into the log and gives its exit code and the text, once both streams closed. */
const drain = (child: ChildProcessWithoutNullStreams, log: WriteStream) =>
  Effect.callback<{ readonly code: number | null; readonly output: string }>((resume) => {
    let output = '';
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
      log.write(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('close', (code) => resume(Effect.succeed({ code, output })));
  });

const swapAdapterPrefix = (stagingDir: string, targetDir: string) =>
  Effect.tryPromise({
    try: () => mkdir(dirname(targetDir), { recursive: true }),
    catch: (error) =>
      new AgentInstallIoError({
        reason: 'Mkdir',
        detail: error instanceof Error ? error.message : String(error),
      }),
  }).pipe(Effect.andThen(swapDirectory(stagingDir, targetDir)));

export const layerAgentInstall = Layer.effect(
  AgentInstall,
  Effect.gen(function* () {
    const layerScope = yield* Effect.scope;
    const { root } = yield* Store;
    const agents = yield* Agents;
    const runtime = yield* AgentRuntime;
    const mergedPath = yield* MergedPath;
    const sources = yield* PathSources;
    const logPath = join(root, 'logs', 'agents', 'install.log');

    type SubscriberQueue = Queue.Queue<InstallEvent, Cause.Done>;

    interface ActiveJobState {
      phase: InstallPhase;
      fiber: Fiber.Fiber<void> | undefined;
      cancelling: boolean;
      finished: boolean;
    }

    interface ActiveJob {
      readonly agentId: AgentId;
      readonly startedAt: number;
      readonly subscribers: Set<SubscriberQueue>;
      readonly state: ActiveJobState;
      readonly finish: (event: InstallEvent) => Effect.Effect<void>;
    }

    const jobs = new Map<AgentId, ActiveJob>();

    const failed = (reason: InstallFailure, detail: string): InstallEvent => ({
      _tag: 'failed',
      reason,
      detail,
      logPath,
    });

    const isInstalled = (agentId: AgentId) =>
      agents.list.pipe(
        Effect.map((list) => list.some((agent) => agent.id === agentId && agent.installed)),
      );

    const acquireRuntime = Effect.fnUntraced(function* (
      log: WriteStream,
      startedAt: number,
      emit: (event: InstallEvent) => Effect.Effect<void>,
    ) {
      const existing = yield* runtime.inspect;
      if (Option.isSome(existing)) return existing.value;
      yield* emit({ _tag: 'downloadingRuntime', startedAt });
      log.write(`=== Acquiring managed Node runtime\n`);
      return yield* runtime.ensure.pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            log.write(`=== Runtime acquisition failed (${error.reason}): ${error.detail}\n`);
          }),
        ),
      );
    });

    const runManagedNpm = Effect.fnUntraced(function* (
      entry: CatalogEntry,
      managedRuntime: ManagedRuntimePaths,
      log: WriteStream,
    ) {
      const agentsRoot = join(root, 'agents');
      const stagingDir = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const dir = join(agentsRoot, `.staging-${entry.id}-${randomUUID()}`);
          await mkdir(dir, { recursive: true });
          return dir;
        }),
        (dir) =>
          Effect.promise(() =>
            rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
          ),
      );

      const path = yield* mergedPath.get;
      const baseEnv = pipe(sources.env, stripAppImageEnv, stripNpmConfigEnv);
      const cleanRest = Object.fromEntries(
        Object.entries(baseEnv).filter(([key]) => key.toUpperCase() !== 'PATH'),
      );
      const childPath = [dirname(managedRuntime.node), path].filter(Boolean).join(delimiter);
      const args = npmInstallArgs(managedRuntime.npmCli, stagingDir, entry);
      log.write(`=== ${new Date().toISOString()} ${managedRuntime.node} ${args.join(' ')}\n`);

      const child = yield* Effect.acquireRelease(
        Effect.callback<ChildProcessWithoutNullStreams, AdapterInstallError>((resume) => {
          const proc = spawn(managedRuntime.node, [...args], {
            cwd: stagingDir,
            env: { ...cleanRest, PATH: childPath },
            stdio: 'pipe',
            shell: false,
            windowsHide: true,
            detached: sources.platform !== 'win32',
          });
          proc.once('spawn', () => resume(Effect.succeed(proc)));
          proc.once('error', (error) => {
            log.write(`=== spawn error: ${error.message}\n`);
            resume(
              Effect.fail(new AdapterInstallError({ reason: 'NpmFailed', detail: error.message })),
            );
          });
        }),
        (proc) =>
          killChildProcessTree(proc, sources.platform, sources.env, 'npm').pipe(Effect.asVoid),
      );

      child.stdin.end();
      const { code, output } = yield* drain(child, log);
      log.write(`=== npm exited with code ${String(code)}\n`);
      if (code !== 0) {
        return yield* new AdapterInstallError({
          reason: failureOf(output),
          detail: oneLine(output, code),
        });
      }

      const inspected = yield* inspectManagedPrefix(stagingDir, entry);
      if (Option.isNone(inspected)) {
        const detail = `${entry.binary} was not found in installed package ${entry.package}`;
        log.write(`${detail}\n`);
        return yield* new AdapterInstallError({ reason: 'NpmFailed', detail });
      }

      yield* swapAdapterPrefix(stagingDir, managedAgentDir(root, entry.id)).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            log.write(`=== swap failed: ${error.detail}\n`);
          }),
        ),
        Effect.mapError(
          () =>
            new AdapterInstallError({
              reason: 'PermissionDenied',
              detail: `Could not move installed ${entry.name} into place`,
            }),
        ),
      );

      const verified =
        entry.id === e2eFakeAgent.id
          ? Option.isSome(yield* inspectManagedAgent(root, entry))
          : yield* isInstalled(entry.id);
      if (!verified) {
        const detail = `${entry.name} failed verification after setup`;
        log.write(`${detail}\n`);
        return yield* new AdapterInstallError({ reason: 'NpmFailed', detail });
      }
    });

    const startJob = Effect.fnUntraced(function* (
      entry: CatalogEntry,
      initialSubscriber: SubscriberQueue,
    ) {
      const startedAt = Date.now();
      const subscribers = new Set<SubscriberQueue>([initialSubscriber]);
      const state: ActiveJobState = {
        phase: 'preparing',
        fiber: undefined,
        cancelling: false,
        finished: false,
      };

      const finish = Effect.fnUntraced(function* (event: InstallEvent) {
        if (state.finished) return;
        state.finished = true;
        if (jobs.get(job.agentId) === job) jobs.delete(job.agentId);
        for (const sub of [...subscribers]) {
          yield* Queue.offer(sub, event);
          yield* Queue.end(sub);
        }
        subscribers.clear();
      });

      const job: ActiveJob = {
        agentId: entry.id,
        startedAt,
        subscribers,
        state,
        finish,
      };
      jobs.set(entry.id, job);

      const emit = Effect.fnUntraced(function* (event: InstallEvent) {
        if (event._tag === 'downloadingRuntime' || event._tag === 'installingAdapter') {
          state.phase = event._tag;
        }
        for (const sub of [...subscribers]) {
          yield* Queue.offer(sub, event);
        }
      });

      const body = Effect.scoped(
        Effect.gen(function* () {
          const log = yield* openLogStream(logPath);
          const paths = yield* acquireRuntime(log, startedAt, emit);
          yield* emit({ _tag: 'installingAdapter', startedAt });
          yield* runManagedNpm(entry, paths, log);
          return { _tag: 'succeeded' } as const satisfies InstallEvent;
        }).pipe(
          Effect.catchTags({
            RuntimeArchiveError: (error) =>
              Effect.succeed(failed(runtimeFailureReason(error), error.detail)),
            AdapterInstallError: (error) => Effect.succeed(failed(error.reason, error.detail)),
          }),
        ),
      );

      const program = body.pipe(
        Effect.flatMap((outcome) => finish(outcome)),
        Effect.onInterrupt(() => finish({ _tag: 'cancelled' })),
        Effect.ensuring(
          Effect.gen(function* () {
            if (jobs.get(job.agentId) === job) jobs.delete(job.agentId);
            for (const sub of [...subscribers]) {
              yield* Queue.end(sub);
            }
            subscribers.clear();
          }),
        ),
      );

      state.fiber = yield* Effect.forkIn(program, layerScope);
      return job;
    });

    const install = (agentId: AgentId): Stream.Stream<InstallEvent> =>
      Stream.callback<InstallEvent>(
        Effect.fnUntraced(function* (queue) {
          const entry = yield* entryOf(agentId, sources.env);
          if (entry.installKind === 'native') {
            const outcome: InstallEvent = (yield* isInstalled(entry.id))
              ? { _tag: 'succeeded' }
              : failed('NotOnPath', entry.installInstructions ?? `${entry.binary} is not on PATH`);
            yield* Queue.offer(queue, outcome);
            yield* Queue.end(queue);
            return;
          }

          const existing = jobs.get(agentId);
          if (
            existing !== undefined &&
            existing.state.cancelling &&
            existing.state.fiber !== undefined
          ) {
            yield* Fiber.await(existing.state.fiber);
          }

          const current = jobs.get(agentId);
          if (current !== undefined && !current.state.cancelling && !current.state.finished) {
            current.subscribers.add(queue);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                current.subscribers.delete(queue);
              }),
            );
            if (current.state.phase !== 'preparing') {
              yield* Queue.offer(queue, {
                _tag: current.state.phase,
                startedAt: current.startedAt,
              });
            }
            return;
          }

          const job = yield* startJob(entry, queue);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              job.subscribers.delete(queue);
            }),
          );
        }),
      );

    const cancel = Effect.fnUntraced(function* (agentId: AgentId) {
      const job = jobs.get(agentId);
      if (job === undefined) return;
      job.state.cancelling = true;
      if (job.state.fiber !== undefined) {
        yield* Fiber.interrupt(job.state.fiber);
      }
      yield* job.finish({ _tag: 'cancelled' });
    });

    const cancelAll: Effect.Effect<void> = Effect.forEach(
      Array.from(jobs.keys()),
      (agentId) => cancel(agentId),
      { concurrency: 'unbounded', discard: true },
    );

    yield* Effect.addFinalizer(() => cancelAll);

    const status = (agentId: AgentId): Effect.Effect<InstallStatus> =>
      Effect.sync(() => {
        const job = jobs.get(agentId);
        if (job === undefined || job.state.cancelling || job.state.finished) {
          return { _tag: 'idle' };
        }
        return {
          _tag: 'installing',
          phase: job.state.phase,
          startedAt: job.startedAt,
        };
      });

    const openLog = Effect.promise(() => shell.openPath(logPath)).pipe(
      Effect.flatMap((error) =>
        error === '' ? Effect.void : Effect.logWarning(`Could not open ${logPath}: ${error}`),
      ),
    );

    return { install, cancel, cancelAll, status, logPath, openLog };
  }),
);
