import { agent, type SessionNotification } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it } from '@effect/vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect, Exit, Queue, Scope } from 'effect';
import { makeClientDispatcher } from './acpClientDispatcher';
import { AcpSessionId } from './acpSession';

const said = (sessionId: AcpSessionId, text: string): SessionNotification => ({
  sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
});

const x = AcpSessionId.make('x');
const y = AcpSessionId.make('y');

/** Our dispatcher with an in-process Agent on the other end; `notify` sends `session/update` from the Agent. */
const connected = Effect.gen(function* () {
  const dispatcher = yield* makeClientDispatcher();
  const connection = yield* Effect.acquireRelease(
    Effect.sync(() => agent({ name: 'test-agent' }).connect(dispatcher.app)),
    (open) => Effect.sync(() => open.close()),
  );
  const notify = (update: SessionNotification) =>
    Effect.promise(() => connection.client.notify('session/update', update));
  /** Every notification sent before this one has been routed once `y` received it. */
  const settle = Effect.gen(function* () {
    const queue = yield* dispatcher.attach(y);
    yield* notify(said(y, 'sync'));
    yield* Queue.take(queue);
    yield* dispatcher.detach(y);
  });
  return { dispatcher, connection, notify, settle };
});

describe('ClientDispatcher', () => {
  it.live('delivers structured Worker announcements and the child stream', () =>
    Effect.gen(function* () {
      const { dispatcher, notify } = yield* connected;
      const parent = yield* dispatcher.attach(x);
      yield* notify({
        sessionId: x,
        update: {
          sessionUpdate: 'subagent_update',
          sessionId: y,
          title: 'Research',
          state: { state: 'running' },
        },
      });
      expect(yield* Queue.take(parent)).toEqual({
        _tag: 'Update',
        update: {
          sessionUpdate: 'subagent_update',
          sessionId: y,
          title: 'Research',
          state: { state: 'running' },
        },
      });
      yield* notify(said(y, 'child output'));
      const child = yield* dispatcher.attach(y);
      expect(yield* Queue.take(child)).toEqual({
        _tag: 'WorkerState',
        state: 'running',
        stopReason: null,
      });
      expect(yield* Queue.take(child)).toEqual({
        _tag: 'Update',
        update: said(y, 'child output').update,
      });
    }).pipe(Effect.scoped),
  );
  it.live('delivers updates that arrived before attach first', () =>
    Effect.gen(function* () {
      const { dispatcher, notify, settle } = yield* connected;
      yield* notify(said(x, 'early'));
      yield* settle;
      const queue = yield* dispatcher.attach(x);
      expect(yield* Queue.size(queue)).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.live('drops the updates buffered for a session that is detached before it is attached', () =>
    Effect.gen(function* () {
      const { dispatcher, notify, settle } = yield* connected;
      yield* notify(said(x, 'early'));
      yield* settle;
      yield* dispatcher.detach(x);
      const queue = yield* dispatcher.attach(x);
      expect(yield* Queue.size(queue)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.live('ignores updates for a session after it was detached', () =>
    Effect.gen(function* () {
      const { dispatcher, notify, settle } = yield* connected;
      yield* dispatcher.attach(x);
      yield* dispatcher.detach(x);
      yield* notify(said(x, 'late'));
      yield* settle;
      const queue = yield* dispatcher.attach(x);
      expect(yield* Queue.size(queue)).toBe(0);
    }).pipe(Effect.scoped),
  );
});

const withTempRoot = <A, E, R>(fn: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-term-'))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );
    return yield* fn(root);
  });

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('ClientDispatcher terminals', () => {
  it.live(
    'spawns directly when args are non-empty, via OS shell when args omitted/empty, and combines stdout+stderr',
    () =>
      withTempRoot((root) =>
        Effect.gen(function* () {
          const { dispatcher, connection } = yield* connected;
          yield* dispatcher.attach(x, root);

          // Non-empty args: direct spawn without shell (preserves spaces & literal $VAR)
          const direct = yield* Effect.promise(() =>
            connection.client.request('terminal/create', {
              sessionId: x,
              command: process.execPath,
              args: [
                '-e',
                'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.stderr.write("!");',
                'a b',
                '$LITERAL',
              ],
            }),
          );
          const directExit = yield* Effect.promise(() =>
            connection.client.request('terminal/wait_for_exit', {
              sessionId: x,
              terminalId: direct.terminalId,
            }),
          );
          expect(directExit.exitCode).toBe(0);
          const directOut = yield* Effect.promise(() =>
            connection.client.request('terminal/output', {
              sessionId: x,
              terminalId: direct.terminalId,
            }),
          );
          expect(directOut.output).toBe('["a b","$LITERAL"]!');
          expect(directOut.truncated).toBe(false);
          expect(directOut.exitStatus?.exitCode).toBe(0);
          yield* Effect.promise(() =>
            connection.client.request('terminal/release', {
              sessionId: x,
              terminalId: direct.terminalId,
            }),
          );

          // Omitted args: OS shell invocation
          const shellCmd =
            process.platform === 'win32'
              ? 'echo shell-one && echo shell-two'
              : 'echo shell-one && echo shell-two';
          const viaShell = yield* Effect.promise(() =>
            connection.client.request('terminal/create', {
              sessionId: x,
              command: shellCmd,
            }),
          );
          const shellExit = yield* Effect.promise(() =>
            connection.client.request('terminal/wait_for_exit', {
              sessionId: x,
              terminalId: viaShell.terminalId,
            }),
          );
          expect(shellExit.exitCode).toBe(0);
          const shellOut = yield* Effect.promise(() =>
            connection.client.request('terminal/output', {
              sessionId: x,
              terminalId: viaShell.terminalId,
            }),
          );
          expect(shellOut.output).toContain('shell-one');
          expect(shellOut.output).toContain('shell-two');
          yield* Effect.promise(() =>
            connection.client.request('terminal/release', {
              sessionId: x,
              terminalId: viaShell.terminalId,
            }),
          );
        }),
      ).pipe(Effect.scoped),
  );

  it.live('defaults cwd to Session root, allows subdirectories, and rejects cwd outside root', () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const sub = path.join(root, 'nested');
        const outside = path.dirname(root);
        yield* Effect.promise(() => mkdir(sub, { recursive: true }));

        const { dispatcher, connection } = yield* connected;
        yield* dispatcher.attach(x, root);

        const defaulted = yield* Effect.promise(() =>
          connection.client.request('terminal/create', {
            sessionId: x,
            command: process.execPath,
            args: ['-e', 'process.stdout.write(process.cwd())'],
          }),
        );
        yield* Effect.promise(() =>
          connection.client.request('terminal/wait_for_exit', {
            sessionId: x,
            terminalId: defaulted.terminalId,
          }),
        );
        const defaultedOut = yield* Effect.promise(() =>
          connection.client.request('terminal/output', {
            sessionId: x,
            terminalId: defaulted.terminalId,
          }),
        );
        expect(defaultedOut.output.toLowerCase()).toContain(path.basename(root).toLowerCase());

        const nested = yield* Effect.promise(() =>
          connection.client.request('terminal/create', {
            sessionId: x,
            command: process.execPath,
            args: ['-e', 'process.stdout.write(process.cwd())'],
            cwd: sub,
          }),
        );
        yield* Effect.promise(() =>
          connection.client.request('terminal/wait_for_exit', {
            sessionId: x,
            terminalId: nested.terminalId,
          }),
        );
        const nestedOut = yield* Effect.promise(() =>
          connection.client.request('terminal/output', {
            sessionId: x,
            terminalId: nested.terminalId,
          }),
        );
        expect(nestedOut.output.toLowerCase()).toContain('nested');

        const rejectedOutside = yield* Effect.tryPromise(() =>
          connection.client.request('terminal/create', {
            sessionId: x,
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            cwd: outside,
          }),
        ).pipe(Effect.flip);
        expect(rejectedOutside).toBeDefined();

        const rejectedRelative = yield* Effect.tryPromise(() =>
          connection.client.request('terminal/create', {
            sessionId: x,
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            cwd: 'nested',
          }),
        ).pipe(Effect.flip);
        expect(rejectedRelative).toBeDefined();
      }),
    ).pipe(Effect.scoped),
  );

  it.live(
    'caps rolling tail at min(outputByteLimit ?? 32_768, 32_768) on valid UTF-8 boundaries',
    () =>
      withTempRoot((root) =>
        Effect.gen(function* () {
          const { dispatcher, connection } = yield* connected;
          yield* dispatcher.attach(x, root);

          // Explicit small limit cutting through 4-byte UTF-8 emojis
          const limited = yield* Effect.promise(() =>
            connection.client.request('terminal/create', {
              sessionId: x,
              command: process.execPath,
              args: ['-e', 'process.stdout.write("A" + "😀".repeat(10))'],
              outputByteLimit: 14,
            }),
          );
          yield* Effect.promise(() =>
            connection.client.request('terminal/wait_for_exit', {
              sessionId: x,
              terminalId: limited.terminalId,
            }),
          );
          const limitedOut = yield* Effect.promise(() =>
            connection.client.request('terminal/output', {
              sessionId: x,
              terminalId: limited.terminalId,
            }),
          );
          expect(limitedOut.truncated).toBe(true);
          expect(Buffer.byteLength(limitedOut.output, 'utf8')).toBeLessThanOrEqual(14);
          expect(limitedOut.output).not.toContain('\uFFFD');
          expect(limitedOut.output).toBe('😀😀😀');

          // Limit larger than 32_768 is still clamped to 32_768
          const clamped = yield* Effect.promise(() =>
            connection.client.request('terminal/create', {
              sessionId: x,
              command: process.execPath,
              args: ['-e', 'process.stdout.write("😀".repeat(9_000))'],
              outputByteLimit: 100_000,
            }),
          );
          yield* Effect.promise(() =>
            connection.client.request('terminal/wait_for_exit', {
              sessionId: x,
              terminalId: clamped.terminalId,
            }),
          );
          const clampedOut = yield* Effect.promise(() =>
            connection.client.request('terminal/output', {
              sessionId: x,
              terminalId: clamped.terminalId,
            }),
          );
          expect(clampedOut.truncated).toBe(true);
          expect(Buffer.byteLength(clampedOut.output, 'utf8')).toBeLessThanOrEqual(32_768);
          expect(clampedOut.output).not.toContain('\uFFFD');
        }),
      ).pipe(Effect.scoped),
  );

  it.live(
    'supports kill without release, invalidates after release, and kills trees on cancel/detach/scope close',
    () =>
      withTempRoot((root) =>
        Effect.gen(function* () {
          const innerScope = yield* Scope.make();
          const dispatcher = yield* makeClientDispatcher().pipe(Scope.provide(innerScope));
          const connection = yield* Effect.acquireRelease(
            Effect.sync(() => agent({ name: 'test-agent' }).connect(dispatcher.app)),
            (open) => Effect.sync(() => open.close()),
          ).pipe(Scope.provide(innerScope));

          const queue = yield* dispatcher.attach(x, root);
          const spawnSleeper = () =>
            Effect.promise(async () => {
              const created = await connection.client.request('terminal/create', {
                sessionId: x,
                command: process.execPath,
                args: [
                  '-e',
                  'process.stdout.write(String(process.pid) + "\\n"); setInterval(() => {}, 1000);',
                ],
              });
              return created.terminalId;
            });

          const readPidFromQueue = Effect.gen(function* () {
            while (true) {
              const event = yield* Queue.take(queue);
              if (event._tag === 'TerminalOutput') {
                const pid = Number.parseInt(event.output.trim(), 10);
                if (Number.isInteger(pid) && pid > 0) return pid;
              }
            }
          });

          // 1. terminal/kill terminates without releasing
          const t1 = yield* spawnSleeper();
          const pid1 = yield* readPidFromQueue;
          expect(isPidAlive(pid1)).toBe(true);
          yield* Effect.promise(() =>
            connection.client.request('terminal/kill', { sessionId: x, terminalId: t1 }),
          );
          yield* Effect.promise(() =>
            connection.client.request('terminal/wait_for_exit', { sessionId: x, terminalId: t1 }),
          );
          const outAfterKill = yield* Effect.promise(() =>
            connection.client.request('terminal/output', { sessionId: x, terminalId: t1 }),
          );
          expect(outAfterKill.exitStatus).toBeDefined();
          expect(isPidAlive(pid1)).toBe(false);

          // release invalidates terminalId
          yield* Effect.promise(() =>
            connection.client.request('terminal/release', { sessionId: x, terminalId: t1 }),
          );
          const afterRelease = yield* Effect.tryPromise(() =>
            connection.client.request('terminal/output', { sessionId: x, terminalId: t1 }),
          ).pipe(Effect.flip);
          expect(afterRelease).toBeDefined();

          // 2. cancelTerminals kills unreleased process trees
          const t2 = yield* spawnSleeper();
          const pid2 = yield* readPidFromQueue;
          expect(isPidAlive(pid2)).toBe(true);
          yield* dispatcher.cancelTerminals(x);
          expect(isPidAlive(pid2)).toBe(false);
          const afterCancel = yield* Effect.tryPromise(() =>
            connection.client.request('terminal/output', { sessionId: x, terminalId: t2 }),
          ).pipe(Effect.flip);
          expect(afterCancel).toBeDefined();

          // 3. scope close (app quit / manager close) kills remaining unreleased process trees
          const t3 = yield* spawnSleeper();
          const pid3 = yield* readPidFromQueue;
          expect(isPidAlive(pid3)).toBe(true);
          yield* Scope.close(innerScope, Exit.void);
          expect(isPidAlive(pid3)).toBe(false);
          void t3;
        }),
      ).pipe(Effect.scoped),
  );
});
