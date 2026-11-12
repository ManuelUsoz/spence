import { shell } from 'electron';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Context, Effect, Layer, Option, Stream } from 'effect';
import type {
  AgentId,
  InstallCommand,
  InstallEvent,
  InstallFailure,
} from '../../src/shared/agents/agents.rpc';
import { Store } from '../store/store';
import { Agents } from './agents';
import { catalog, type CatalogEntry } from './catalog';
import { MergedPath, PathSources } from './merged-path';
import { resolveExecutable } from './resolve';
import { spawnAgent } from './spawn';

/** Installs a Catalog Agent's adapter with the npm on the merged PATH. No updates, no version pinning. */
export class AgentInstall extends Context.Service<
  AgentInstall,
  {
    /** The exact command `install` runs, and whether npm is there to run it. */
    readonly command: (agentId: AgentId) => Effect.Effect<InstallCommand>;
    /**
     * `started`, then `succeeded` once a re-scan finds the adapter, or `failed`. npm's output goes to `logPath`.
     * Interrupting the stream kills npm's process tree.
     */
    readonly install: (agentId: AgentId) => Stream.Stream<InstallEvent>;
    /** `<userData>/spence/logs/agents/install.log`. */
    readonly logPath: string;
    /** Opens the install log in the system's viewer; a log that cannot be opened (e.g. not written yet) is only logged. */
    readonly openLog: Effect.Effect<void>;
  }
>()('agents/AgentInstall') {}

const NPM = 'npm';

const npmArgs = (entry: CatalogEntry): ReadonlyArray<string> => ['install', '-g', entry.package];

const commandLine = (entry: CatalogEntry): string => [NPM, ...npmArgs(entry)].join(' ');

/** Unknown ids are a renderer bug: the renderer only ever names Agents it got from `Agents.list`. */
const entryOf = (agentId: AgentId) =>
  Option.fromNullishOr(catalog.find((entry) => entry.id === agentId)).pipe(
    Option.match({
      onNone: () => Effect.die(`Unknown Agent ${agentId}`),
      onSome: Effect.succeed,
    }),
  );

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

export const layerAgentInstall = Layer.effect(
  AgentInstall,
  Effect.gen(function* () {
    const { root } = yield* Store;
    const agents = yield* Agents;
    const mergedPath = yield* MergedPath;
    const sources = yield* PathSources;
    const logPath = join(root, 'logs', 'agents', 'install.log');

    const failed = (reason: InstallFailure, detail: string): InstallEvent => ({
      _tag: 'failed',
      reason,
      detail,
      logPath,
    });

    const command = Effect.fnUntraced(function* (agentId: AgentId) {
      const entry = yield* entryOf(agentId);
      const path = yield* mergedPath.get;
      const npm = yield* resolveExecutable(NPM, path, sources.platform);
      return { command: commandLine(entry), npmFound: Option.isSome(npm) };
    });

    const isInstalled = (agentId: AgentId) =>
      agents.list.pipe(
        Effect.map((list) => list.some((agent) => agent.id === agentId && agent.installed)),
      );

    const runNpm = (entry: CatalogEntry, log: WriteStream) =>
      Effect.gen(function* () {
        const child = yield* spawnAgent({ binary: NPM, args: npmArgs(entry) });
        child.stdin.end();
        const { code, output } = yield* drain(child, log);
        log.write(`=== npm exited with code ${String(code)}\n`);
        if (code !== 0) return failed(failureOf(output), oneLine(output, code));
        if (!(yield* isInstalled(entry.id))) {
          const detail = `${entry.binary} is not on PATH after npm install`;
          log.write(`${detail}\n`);
          return failed('NotOnPath', detail);
        }
        return { _tag: 'succeeded' } satisfies InstallEvent;
      }).pipe(
        Effect.catchTag('AgentLaunchError', (error) =>
          Effect.sync(() => {
            log.write(`${error.detail}\n`);
            return failed(error.reason === 'NotInstalled' ? 'NoNpm' : 'NpmFailed', error.detail);
          }),
        ),
        Effect.provideService(MergedPath, mergedPath),
        Effect.provideService(PathSources, sources),
      );

    const run = Effect.fnUntraced(function* (agentId: AgentId) {
      const entry = yield* entryOf(agentId);
      const log = yield* openLogStream(logPath);
      log.write(`\n=== ${new Date().toISOString()} ${commandLine(entry)}\n`);
      return yield* runNpm(entry, log);
    });

    const install = (agentId: AgentId): Stream.Stream<InstallEvent> =>
      Stream.concat(
        Stream.succeed<InstallEvent>({ _tag: 'started' }),
        Stream.fromEffect(Effect.scoped(run(agentId))),
      );

    const openLog = Effect.promise(() => shell.openPath(logPath)).pipe(
      Effect.flatMap((error) =>
        error === '' ? Effect.void : Effect.logWarning(`Could not open ${logPath}: ${error}`),
      ),
    );

    return { command, install, logPath, openLog };
  }),
);
