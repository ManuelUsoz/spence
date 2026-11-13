import { app, shell } from 'electron';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Context, Effect, Layer, type Scope } from 'effect';
import type { AgentId } from '../../src/shared/agents/agents.rpc';

/** Past this size the log moves to `<agent>.1.log` (replacing the older one) and a fresh file starts. */
export const MAX_LOG_BYTES = 1024 * 1024;

/** One Agent's log: stderr and lifecycle lines, never shown in the thread. */
export interface AgentLog {
  /** Appends a timestamped line. Callable from Node callbacks; writes are queued in order. */
  readonly write: (line: string) => void;
}

/** Where Agent processes log: one rotating file per Agent. */
export class AgentLogs extends Context.Service<
  AgentLogs,
  {
    /** The Agent's log for the scope; closing the scope waits for queued writes. */
    readonly open: (agent: AgentId) => Effect.Effect<AgentLog, never, Scope.Scope>;
  }
>()('acp/AgentLogs') {}

const sizeOf = async (file: string): Promise<number> => {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
};

/** Agent logs in `dir`, as `<agent>.log` plus one older `<agent>.1.log`. */
export const layerAgentLogs = (dir: string) =>
  Layer.succeed(AgentLogs, {
    open: (agent) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const file = join(dir, `${agent}.log`);
          let pending: Promise<void> = mkdir(dir, { recursive: true }).then(() => undefined);
          const append = async (text: string): Promise<void> => {
            if ((await sizeOf(file)) + Buffer.byteLength(text) > MAX_LOG_BYTES) {
              await rename(file, join(dir, `${agent}.1.log`)).catch(() => undefined);
            }
            await appendFile(file, text);
          };
          const write = (line: string): void => {
            const text = `${new Date().toISOString()} ${line.replace(/\s+$/, '')}\n`;
            pending = pending
              .then(() => append(text))
              .catch((error: unknown) => {
                console.warn(`Cannot write the ${agent} Agent log`, error);
              });
          };
          return { write, flush: () => pending };
        }),
        (log) => Effect.promise(log.flush),
      ),
  });

const DEFAULT_LOG_DIR = () => join(app.getPath('userData'), 'spence', 'logs', 'agents');

/** Production: `<userData>/spence/logs/agents/`. */
export const layerAgentLogsUserData = Layer.suspend(() => layerAgentLogs(DEFAULT_LOG_DIR()));

/** Opens the Agent's log file in the OS default handler, logging any failure without failing the RPC. */
export const openAgentLog = Effect.fnUntraced(function* (agent: AgentId) {
  const path = join(DEFAULT_LOG_DIR(), `${agent}.log`);
  const failure = yield* Effect.tryPromise(() => shell.openPath(path)).pipe(
    Effect.catch((cause) => Effect.succeed(cause instanceof Error ? cause.message : String(cause))),
  );
  if (failure !== '') yield* Effect.logWarning(`Cannot open Agent log: ${failure}`);
});
