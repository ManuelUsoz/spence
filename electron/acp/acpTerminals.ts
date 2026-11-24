import {
  RequestError,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type TerminalExitStatus,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk/unstable';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Deferred, Effect, Option } from 'effect';
import { capOutputTail, MAX_STEP_OUTPUT_BYTES } from '../../src/shared/sessions/output-tail';
import { system32, type Env } from '../agents/exec';
import { killChildProcessTree } from '../agents/spawn';
import { AcpSessionId } from './acpSession';

const TERMINAL_DELTA_THROTTLE_MS = 100;

/** Events emitted by hosted ACP terminals toward their owning Session's event stream. */
export type TerminalStreamEvent =
  | {
      readonly _tag: 'TerminalOutput';
      readonly terminalId: string;
      readonly output: string;
      readonly truncated: boolean;
    }
  | {
      readonly _tag: 'TerminalExited';
      readonly terminalId: string;
      readonly exitCode: number | null;
      readonly signal: string | null;
    };

export interface TerminalHostEnv {
  readonly platform: NodeJS.Platform;
  readonly env: Env;
}

const normalizeForCompare = (value: string, platform: NodeJS.Platform): string => {
  const normalized = platform === 'win32' ? path.win32.normalize(value) : path.normalize(value);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
};

/** True when `candidate` is `root` itself or inside `root` (case-insensitive on Windows). */
export const isWithinRoot = (
  root: string,
  candidate: string,
  platform: NodeJS.Platform,
): boolean => {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const relative = pathApi.relative(
    normalizeForCompare(root, platform),
    normalizeForCompare(candidate, platform),
  );
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative))
  );
};

const resolveContainedCwd = Effect.fnUntraced(function* (
  sessionRoot: string,
  requestedCwd: string | null | undefined,
  platform: NodeJS.Platform,
): Effect.fn.Return<string, RequestError> {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const rootReal = yield* Effect.tryPromise(() => realpath(sessionRoot)).pipe(
    Effect.orElseSucceed(() => pathApi.resolve(sessionRoot)),
  );
  if (requestedCwd === undefined || requestedCwd === null || requestedCwd === '') {
    return rootReal;
  }
  if (!pathApi.isAbsolute(requestedCwd)) {
    return yield* Effect.fail(
      RequestError.invalidParams(undefined, 'Terminal cwd must be an absolute path'),
    );
  }
  const targetReal = yield* Effect.tryPromise(() => realpath(requestedCwd)).pipe(Effect.option);
  if (Option.isNone(targetReal)) {
    return yield* Effect.fail(
      RequestError.invalidParams(undefined, `Terminal cwd does not exist: ${requestedCwd}`),
    );
  }
  const info = yield* Effect.tryPromise(() => stat(targetReal.value)).pipe(Effect.option);
  if (Option.isNone(info) || !info.value.isDirectory()) {
    return yield* Effect.fail(
      RequestError.invalidParams(undefined, 'Terminal cwd is not a directory'),
    );
  }
  if (!isWithinRoot(rootReal, targetReal.value, platform)) {
    return yield* Effect.fail(
      RequestError.invalidParams(
        undefined,
        `Terminal cwd is outside the Session folder: ${requestedCwd}`,
      ),
    );
  }
  return targetReal.value;
});

const decodeTailBuffer = (buf: Buffer): string => {
  let start = 0;
  while (start < buf.byteLength && ((buf[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString('utf8');
};

const resolveByteLimit = (
  requested: number | null | undefined,
): Effect.Effect<number, RequestError> => {
  if (requested === undefined || requested === null) {
    return Effect.succeed(MAX_STEP_OUTPUT_BYTES);
  }
  if (!Number.isFinite(requested) || requested < 0) {
    return Effect.fail(
      RequestError.invalidParams(undefined, 'Terminal outputByteLimit must be non-negative'),
    );
  }
  return Effect.succeed(Math.min(Math.floor(requested), MAX_STEP_OUTPUT_BYTES));
};

const buildEnv = (
  baseEnv: Env,
  overrides: CreateTerminalRequest['env'] | undefined,
): NodeJS.ProcessEnv => {
  const merged: NodeJS.ProcessEnv = { ...baseEnv };
  if (overrides !== undefined) {
    for (const entry of overrides) {
      merged[entry.name] = entry.value;
    }
  }
  return merged;
};

const spawnTerminalChild = (
  command: string,
  args: ReadonlyArray<string> | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Effect.Effect<ChildProcess, RequestError> =>
  Effect.callback<ChildProcess, RequestError>((resume) => {
    const child =
      args !== undefined && args.length > 0
        ? spawn(command, [...args], {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
            detached: platform !== 'win32',
          })
        : platform === 'win32'
          ? spawn(
              env['ComSpec'] ?? env['COMSPEC'] ?? system32(env, 'cmd.exe'),
              ['/d', '/s', '/c', `"${command}"`],
              {
                cwd,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: false,
                windowsHide: true,
                windowsVerbatimArguments: true,
              },
            )
          : spawn('/bin/sh', ['-c', command], {
              cwd,
              env,
              stdio: ['ignore', 'pipe', 'pipe'],
              shell: false,
              windowsHide: true,
              detached: true,
            });
    const onSpawn = (): void => {
      child.off('error', onError);
      resume(Effect.succeed(child));
    };
    const onError = (error: Error): void => {
      child.off('spawn', onSpawn);
      resume(
        Effect.fail(
          RequestError.internalError(undefined, `Failed to spawn terminal: ${error.message}`),
        ),
      );
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
    return Effect.sync(() => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    });
  });

interface ManagedTerminal {
  readonly id: string;
  readonly sessionId: AcpSessionId;
  readonly child: ChildProcess;
  readonly byteLimit: number;
  readonly decoder: StringDecoder;
  readonly exitDeferred: Deferred.Deferred<TerminalExitStatus>;
  tailBuf: Buffer;
  tailTruncated: boolean;
  reportedTruncated: boolean;
  pendingDelta: string;
  pendingTruncated: boolean;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  exitStatus: TerminalExitStatus | undefined;
  closed: boolean;
  released: boolean;
}

export interface TerminalRegistry {
  readonly create: (
    params: CreateTerminalRequest,
  ) => Effect.Effect<CreateTerminalResponse, RequestError>;
  readonly output: (
    params: TerminalOutputRequest,
  ) => Effect.Effect<TerminalOutputResponse, RequestError>;
  readonly waitForExit: (
    params: WaitForTerminalExitRequest,
  ) => Effect.Effect<WaitForTerminalExitResponse, RequestError>;
  readonly kill: (params: KillTerminalRequest) => Effect.Effect<KillTerminalResponse, RequestError>;
  readonly release: (
    params: ReleaseTerminalRequest,
  ) => Effect.Effect<ReleaseTerminalResponse, RequestError>;
  readonly flushSession: (sessionId: AcpSessionId) => Effect.Effect<void>;
  readonly releaseSession: (sessionId: AcpSessionId) => Effect.Effect<void>;
  readonly releaseAll: Effect.Effect<void>;
}

/**
 * Manages client-hosted ACP terminal child processes per Session, enforcing `cwd` containment,
 * combined stdout/stderr 32 KB rolling UTF-8 tails, throttled ~100 ms delta emission, and cleanup.
 */
export const makeTerminalRegistry = (
  getRoot: (sessionId: AcpSessionId) => string | undefined,
  isDetached: (sessionId: AcpSessionId) => boolean,
  emit: (sessionId: AcpSessionId, event: TerminalStreamEvent) => void,
  host: TerminalHostEnv = { platform: process.platform, env: process.env },
): TerminalRegistry => {
  const terminals = new Map<string, ManagedTerminal>();

  const requireTerminal = (
    sessionIdRaw: string,
    terminalId: string,
  ): Effect.Effect<ManagedTerminal, RequestError> =>
    Effect.suspend(() => {
      const sessionId = AcpSessionId.make(sessionIdRaw);
      const terminal = terminals.get(terminalId);
      if (terminal === undefined || terminal.released || terminal.sessionId !== sessionId) {
        return Effect.fail(
          RequestError.invalidParams(undefined, `Unknown terminal: ${terminalId}`),
        );
      }
      return Effect.succeed(terminal);
    });

  const clearTimer = (terminal: ManagedTerminal): void => {
    if (terminal.flushTimer !== undefined) {
      clearTimeout(terminal.flushTimer);
      terminal.flushTimer = undefined;
    }
  };

  const flushPending = (terminal: ManagedTerminal): void => {
    clearTimer(terminal);
    if (terminal.released) return;
    const output = terminal.pendingDelta;
    const truncated =
      terminal.pendingTruncated || (terminal.tailTruncated && !terminal.reportedTruncated);
    terminal.pendingDelta = '';
    terminal.pendingTruncated = false;
    if (output === '' && !truncated) return;
    if (truncated) terminal.reportedTruncated = true;
    emit(terminal.sessionId, {
      _tag: 'TerminalOutput',
      terminalId: terminal.id,
      output,
      truncated,
    });
  };

  const scheduleFlush = (terminal: ManagedTerminal): void => {
    if (terminal.flushTimer !== undefined || terminal.released || terminal.closed) return;
    terminal.flushTimer = setTimeout(() => {
      terminal.flushTimer = undefined;
      flushPending(terminal);
    }, TERMINAL_DELTA_THROTTLE_MS);
  };

  const appendChunk = (terminal: ManagedTerminal, chunk: Buffer): void => {
    if (terminal.released) return;
    if (terminal.byteLimit === 0) {
      if (chunk.byteLength > 0) {
        terminal.tailTruncated = true;
        terminal.pendingTruncated = true;
        scheduleFlush(terminal);
      }
      return;
    }
    const combined =
      terminal.tailBuf.byteLength === 0 ? chunk : Buffer.concat([terminal.tailBuf, chunk]);
    if (combined.byteLength > terminal.byteLimit) {
      terminal.tailBuf = Buffer.from(combined.subarray(combined.byteLength - terminal.byteLimit));
      terminal.tailTruncated = true;
    } else {
      terminal.tailBuf = combined;
    }

    const decoded = terminal.decoder.write(chunk);
    if (decoded !== '') {
      const capped = capOutputTail(terminal.pendingDelta + decoded, terminal.byteLimit);
      terminal.pendingDelta = capped.text;
      if (capped.truncated || terminal.tailTruncated) {
        terminal.pendingTruncated = true;
      }
    } else if (terminal.tailTruncated && !terminal.reportedTruncated) {
      terminal.pendingTruncated = true;
    }
    if (terminal.pendingDelta !== '' || terminal.pendingTruncated) {
      scheduleFlush(terminal);
    }
  };

  const finalizeClose = (terminal: ManagedTerminal, status: TerminalExitStatus): void => {
    if (terminal.closed) return;
    terminal.closed = true;
    terminal.exitStatus ??= status;
    const remaining = terminal.decoder.end();
    if (remaining !== '' && terminal.byteLimit > 0) {
      const capped = capOutputTail(terminal.pendingDelta + remaining, terminal.byteLimit);
      terminal.pendingDelta = capped.text;
      if (capped.truncated || terminal.tailTruncated) {
        terminal.pendingTruncated = true;
      }
    }
    flushPending(terminal);
    const resolved = terminal.exitStatus;
    if (!terminal.released) {
      emit(terminal.sessionId, {
        _tag: 'TerminalExited',
        terminalId: terminal.id,
        exitCode: resolved.exitCode ?? null,
        signal: resolved.signal ?? null,
      });
    }
    Deferred.doneUnsafe(terminal.exitDeferred, Effect.succeed(resolved));
  };

  const terminateAndRelease = Effect.fnUntraced(function* (terminal: ManagedTerminal) {
    if (terminal.released) return;
    terminal.released = true;
    terminals.delete(terminal.id);
    clearTimer(terminal);
    if (!terminal.closed) {
      yield* killChildProcessTree(terminal.child, host.platform, host.env, 'Terminal');
    }
    yield* Deferred.succeed(
      terminal.exitDeferred,
      terminal.exitStatus ?? { exitCode: null, signal: null },
    );
  });

  const create = Effect.fnUntraced(function* (
    params: CreateTerminalRequest,
  ): Effect.fn.Return<CreateTerminalResponse, RequestError> {
    const sessionId = AcpSessionId.make(params.sessionId);
    if (isDetached(sessionId)) {
      return yield* Effect.fail(
        RequestError.invalidParams(undefined, `Session ${params.sessionId} is detached`),
      );
    }
    const root = getRoot(sessionId);
    if (root === undefined) {
      return yield* Effect.fail(
        RequestError.invalidParams(
          undefined,
          `Session ${params.sessionId} has no registered working folder`,
        ),
      );
    }
    if (params.command.trim() === '') {
      return yield* Effect.fail(
        RequestError.invalidParams(undefined, 'Terminal command must not be empty'),
      );
    }
    const byteLimit = yield* resolveByteLimit(params.outputByteLimit);
    const cwd = yield* resolveContainedCwd(root, params.cwd, host.platform);
    const env = buildEnv(host.env, params.env);
    const child = yield* spawnTerminalChild(params.command, params.args, cwd, env, host.platform);
    const exitDeferred = yield* Deferred.make<TerminalExitStatus>();
    const terminalId = `term-${randomUUID()}`;
    const terminal: ManagedTerminal = {
      id: terminalId,
      sessionId,
      child,
      byteLimit,
      decoder: new StringDecoder('utf8'),
      exitDeferred,
      tailBuf: Buffer.alloc(0),
      tailTruncated: false,
      reportedTruncated: false,
      pendingDelta: '',
      pendingTruncated: false,
      flushTimer: undefined,
      exitStatus: undefined,
      closed: false,
      released: false,
    };
    terminals.set(terminalId, terminal);

    child.stdout?.on('data', (chunk: Buffer) => appendChunk(terminal, chunk));
    child.stderr?.on('data', (chunk: Buffer) => appendChunk(terminal, chunk));
    child.once('exit', (code, signal) => {
      terminal.exitStatus = { exitCode: code ?? null, signal: signal ?? null };
    });
    child.once('close', (code, signal) => {
      finalizeClose(terminal, { exitCode: code ?? null, signal: signal ?? null });
    });
    child.once('error', () => {
      finalizeClose(terminal, terminal.exitStatus ?? { exitCode: null, signal: null });
    });

    if (isDetached(sessionId)) {
      yield* terminateAndRelease(terminal);
      return yield* Effect.fail(
        RequestError.invalidParams(undefined, `Session ${params.sessionId} is detached`),
      );
    }

    return { terminalId };
  });

  const output = Effect.fnUntraced(function* (
    params: TerminalOutputRequest,
  ): Effect.fn.Return<TerminalOutputResponse, RequestError> {
    const terminal = yield* requireTerminal(params.sessionId, params.terminalId);
    return {
      output: decodeTailBuffer(terminal.tailBuf),
      truncated: terminal.tailTruncated,
      ...(terminal.exitStatus === undefined ? {} : { exitStatus: terminal.exitStatus }),
    };
  });

  const waitForExit = Effect.fnUntraced(function* (
    params: WaitForTerminalExitRequest,
  ): Effect.fn.Return<WaitForTerminalExitResponse, RequestError> {
    const terminal = yield* requireTerminal(params.sessionId, params.terminalId);
    if (terminal.closed && terminal.exitStatus !== undefined) {
      return terminal.exitStatus;
    }
    return yield* Deferred.await(terminal.exitDeferred);
  });

  const kill = Effect.fnUntraced(function* (
    params: KillTerminalRequest,
  ): Effect.fn.Return<KillTerminalResponse, RequestError> {
    const terminal = yield* requireTerminal(params.sessionId, params.terminalId);
    if (!terminal.closed) {
      yield* killChildProcessTree(terminal.child, host.platform, host.env, 'Terminal');
    }
    return {};
  });

  const release = Effect.fnUntraced(function* (
    params: ReleaseTerminalRequest,
  ): Effect.fn.Return<ReleaseTerminalResponse, RequestError> {
    const terminal = yield* requireTerminal(params.sessionId, params.terminalId);
    yield* terminateAndRelease(terminal);
    return {};
  });

  const flushSession = (sessionId: AcpSessionId) =>
    Effect.sync(() => {
      for (const terminal of terminals.values()) {
        if (terminal.sessionId === sessionId) flushPending(terminal);
      }
    });

  const releaseSession = (sessionId: AcpSessionId) =>
    Effect.suspend(() =>
      Effect.forEach(
        [...terminals.values()].filter((terminal) => terminal.sessionId === sessionId),
        terminateAndRelease,
        { discard: true },
      ),
    );

  const releaseAll = Effect.suspend(() =>
    Effect.forEach([...terminals.values()], terminateAndRelease, { discard: true }),
  );

  return {
    create,
    output,
    waitForExit,
    kill,
    release,
    flushSession,
    releaseSession,
    releaseAll,
  };
};
