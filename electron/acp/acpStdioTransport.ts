import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { Deferred, Duration, Effect } from 'effect';
import type { CatalogEntry } from '../agents/catalog';
import { spawnAgent } from '../agents/spawn';
import { AgentLogs } from './acpAgentLog';

/** How an Agent process ended. */
export interface AgentExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderrTail: string;
}

/** An Agent's stdio as an ACP stream, plus a way to learn when the process is gone. */
export interface AcpTransport {
  readonly stream: Stream;
  /** Completes when the Agent process exits, for whatever reason. */
  readonly exited: Effect.Effect<AgentExit>;
}

/** How long an Agent gets to exit on its own after its stdin closes, before its tree is killed. */
const STDIN_CLOSE_GRACE = Duration.seconds(2);
const MAX_STDERR_LINES = 20;
const MAX_STDERR_CHARS = 2000;

export const describeExit = ({ code, signal }: Pick<AgentExit, 'code' | 'signal'>): string =>
  signal === null ? `exit code ${code}` : `signal ${signal}`;

const lines = (chunk: Buffer): ReadonlyArray<string> =>
  chunk
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

/**
 * Spawns a Catalog Agent through the discovery resolver and connects its stdio as newline-delimited JSON-RPC. stderr
 * and lifecycle lines go to the Agent's log. Closing the scope closes stdin, gives the Agent a moment to leave, then
 * kills its tree.
 *
 * This is the seam for running Agents in a utility process later: only this file knows they are child processes.
 */
export const openStdioTransport = Effect.fn('Acp.openStdioTransport')(function* (
  entry: CatalogEntry,
) {
  const log = yield* AgentLogs.use((logs) => logs.open(entry.id));
  const child = yield* spawnAgent(entry).pipe(
    Effect.tapError((error) =>
      Effect.sync(() =>
        log.write(`cannot start ${entry.binary}: ${error.reason}: ${error.detail}`),
      ),
    ),
  );
  log.write(`spawned pid ${child.pid ?? '?'}: ${child.spawnargs.join(' ')}`);

  const stderrLines: Array<string> = [];
  const pushStderr = (chunk: Buffer): void => {
    for (const line of lines(chunk)) {
      log.write(`stderr ${line}`);
      stderrLines.push(line);
      if (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift();
    }
  };
  child.stderr.on('data', pushStderr);

  const exited = yield* Deferred.make<AgentExit>();
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    const exit: AgentExit = {
      code,
      signal,
      stderrTail: stderrLines.join('\n').slice(-MAX_STDERR_CHARS),
    };
    log.write(`exited with ${describeExit(exit)}`);
    Deferred.doneUnsafe(exited, Effect.succeed(exit));
  };
  if (child.exitCode !== null || child.signalCode !== null)
    onExit(child.exitCode, child.signalCode);
  else child.once('exit', onExit);
  // A write racing the Agent's exit fails with EPIPE; the exit itself is what we report.
  child.stdin.on('error', (error) => log.write(`stdin ${error.message}`));

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => child.stdin.end()).pipe(
      Effect.andThen(Deferred.await(exited)),
      Effect.timeoutOrElse({ duration: STDIN_CLOSE_GRACE, orElse: () => Effect.void }),
      Effect.asVoid,
    ),
  );

  // Node's web stream types and the DOM ones the SDK is typed against differ only in BYOB reader details.
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  return { stream, exited: Deferred.await(exited) } satisfies AcpTransport;
});
