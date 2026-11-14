import { describe, expect, it } from '@effect/vitest';
import { join } from 'node:path';
import { Deferred, Effect, Fiber, Layer, Option, Schedule, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { layerAgentLogs } from './acpAgentLog';
import { MergedPath, PathSources } from '../agents/merged-path';
import { fakeEntry, installFakeAgent, layerAcpClientWithFakeAgent } from './acpFakes';
import { AgentLifetime, layerAgentLifetime } from './acpLifetime';
import { AcpClient, layerAcpClient } from './acpSessionManager';

/** Runs `program` against the production lifetime and client with the fake Agent installed. */
const withFakeAgent = <A, E>(program: Effect.Effect<A, E, AgentLifetime | AcpClient>) =>
  Effect.gen(function* () {
    const install = yield* installFakeAgent;
    return yield* program.pipe(
      Effect.provide(
        layerAgentLifetime.pipe(Layer.provideMerge(layerAcpClientWithFakeAgent(install))),
      ),
    );
  }).pipe(Effect.scoped);

/** How a Session opens its ACP session here: a new one on the fake Agent. */
const openOn = (client: AcpClient['Service']) =>
  client
    .connect(fakeEntry())
    .pipe(
      Effect.flatMap((manager) =>
        Effect.map(manager.newSession(process.cwd()), (session) => ({ manager, session })),
      ),
    );

const first = SessionId.make('session-1');
const second = SessionId.make('session-2');
const third = SessionId.make('session-3');

/** Waits real time, whatever the test clock says: long enough for a stopping Agent to be gone. */
const realPause = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 500)));

/** Whether `exited` completes within a real pause. */
const exitsSoon = (exited: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(exited);
    yield* realPause;
    return fiber.pollUnsafe() !== undefined;
  });

/** Spawning node through a shim and a real ACP handshake take longer than the default 5 s on a cold machine. */
const TIMEOUT = 30_000;

describe('AgentLifetime', () => {
  it.live(
    'connects a restored Tab only when it is first activated, and only once',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const lifetime = yield* AgentLifetime;
          const client = yield* AcpClient;
          let opens = 0;
          const counted = Effect.suspend(() => {
            opens += 1;
            return openOn(client);
          });
          yield* lifetime.tabOpened(first);
          expect(opens).toBe(0);
          const session = yield* lifetime.tabActivated(first, counted);
          expect(yield* lifetime.tabActivated(first, counted)).toBe(session);
          expect(opens).toBe(1);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'closes the ACP session when its last Tab closes and no Turn runs',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const lifetime = yield* AgentLifetime;
          const session = yield* lifetime.tabActivated(first, openOn(yield* AcpClient));
          yield* lifetime.tabClosed(first);
          // A closed session's events end.
          yield* session.events.pipe(Stream.runDrain);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'keeps the ACP session open while a Turn runs after its Tab closed, and closes it when the Turn ends',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const lifetime = yield* AgentLifetime;
          const client = yield* AcpClient;
          yield* lifetime.tabActivated(first, openOn(client));
          const session = yield* lifetime.turnStarted(first, openOn(client));
          const turn = yield* Effect.forkChild(session.prompt([{ type: 'text', text: 'ask' }]));

          yield* lifetime.tabClosed(first);

          // Still open: the running Turn's Permission request arrives.
          const permission = yield* session.events.pipe(
            Stream.filter((event) => event._tag === 'PermissionRequest'),
            Stream.runHead,
          );
          expect(Option.isSome(permission)).toBe(true);
          yield* session.cancel;
          expect((yield* Fiber.join(turn)).stopReason).toBe('cancelled');

          yield* lifetime.turnEnded(first);
          yield* session.events.pipe(Stream.runDrain);
        }),
      ),
    TIMEOUT,
  );

  it.effect(
    'stops the Agent process after 5 minutes with zero ACP sessions, and not before',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const lifetime = yield* AgentLifetime;
          const client = yield* AcpClient;
          const agent = yield* client.connect(fakeEntry());
          yield* lifetime.tabActivated(first, openOn(client));
          yield* lifetime.tabClosed(first);

          yield* TestClock.adjust('299 seconds');
          expect(yield* exitsSoon(agent.exited)).toBe(false);
          expect(yield* client.connect(fakeEntry())).toBe(agent);

          yield* TestClock.adjust('1 second');
          yield* agent.exited;
          expect(yield* client.connect(fakeEntry())).not.toBe(agent);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'does not restart a crashed Agent; the next Turn opens a new ACP session on a new process',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const lifetime = yield* AgentLifetime;
          const client = yield* AcpClient;
          let opens = 0;
          const counted = Effect.suspend(() => {
            opens += 1;
            return openOn(client);
          });
          yield* lifetime.tabActivated(first, counted);
          const session = yield* lifetime.turnStarted(first, counted);
          const crash = yield* session.prompt([{ type: 'text', text: 'crash' }]).pipe(Effect.flip);
          expect(crash.reason).toBe('Exited');
          yield* lifetime.turnEnded(first);
          expect(opens).toBe(1);

          const again = yield* lifetime.turnStarted(first, counted).pipe(
            Effect.repeat({
              until: (next) => next !== session,
              schedule: Schedule.spaced('20 millis'),
            }),
          );
          expect(opens).toBe(2);
          expect((yield* again.prompt([{ type: 'text', text: 'echo:back' }])).stopReason).toBe(
            'end_turn',
          );
          yield* lifetime.turnEnded(first);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'on quit counts the working Sessions, cancels their Turns and stops the Agent',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const lifetime = yield* AgentLifetime;
          const client = yield* AcpClient;
          const agent = yield* client.connect(fakeEntry());
          yield* lifetime.tabActivated(first, openOn(client));
          yield* lifetime.tabActivated(second, openOn(client));
          expect(yield* lifetime.working).toBe(0);

          const session = yield* lifetime.turnStarted(first, openOn(client));
          const turn = yield* Effect.forkChild(session.prompt([{ type: 'text', text: 'ask' }]));
          const permission = yield* session.events.pipe(
            Stream.filter((event) => event._tag === 'PermissionRequest'),
            Stream.runHead,
          );
          expect(yield* lifetime.working).toBe(1);

          yield* lifetime.quit;

          if (Option.isSome(permission)) {
            expect(yield* Deferred.await(permission.value.answer)).toEqual({
              outcome: 'cancelled',
            });
          }
          yield* Fiber.await(turn);
          yield* agent.exited;
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'otherWorking counts other active Sessions on the same Agent, and killAgent terminates the shared process so idle Sessions reconnect',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const lifetime = yield* AgentLifetime;
          const client = yield* AcpClient;
          const entry = fakeEntry();
          const manager1 = yield* client.connect(entry);

          const s1 = yield* lifetime.turnStarted(first, openOn(client), entry.id);
          const s2 = yield* lifetime.turnStarted(second, openOn(client), entry.id);
          const s3 = yield* lifetime.tabActivated(third, openOn(client), entry.id);

          yield* Effect.forkChild(s1.prompt([{ type: 'text', text: 'stall' }]));
          yield* Effect.forkChild(s2.prompt([{ type: 'text', text: 'busy' }]));

          // first sees second as otherWorking (third is idle).
          expect(yield* lifetime.otherWorking(first, entry.id)).toEqual([second]);
          // third (idle) sees both first and second.
          expect(yield* lifetime.otherWorking(third, entry.id)).toEqual([first, second]);

          const kill = yield* lifetime.killAgent(entry.id);
          expect(kill.exitConfirmed).toBe(true);
          expect(kill.pid).toBe(manager1.pid);
          yield* manager1.exited;

          yield* lifetime.turnEnded(first);
          yield* lifetime.turnEnded(second);

          // Idle session's stale events stream drains cleanly; next activation reconnects on a new process.
          yield* s3.events.pipe(Stream.runDrain, Effect.ignore);
          const s3Reconnected = yield* lifetime.tabActivated(third, openOn(client), entry.id);
          expect(s3Reconnected).not.toBe(s3);
          const manager2 = yield* client.connect(entry);
          expect(manager2).not.toBe(manager1);
          expect(
            (yield* s3Reconnected.prompt([{ type: 'text', text: 'echo:ok' }])).stopReason,
          ).toBe('end_turn');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'exitGateState tracks cancelPending until settled or process exit',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const lifetime = yield* AgentLifetime;
          const client = yield* AcpClient;
          const entry = fakeEntry();
          const manager = yield* client.connect(entry);
          yield* lifetime.turnStarted(first, openOn(client), entry.id);

          expect(yield* lifetime.exitGateState({ agentId: entry.id, sessionId: first })).toEqual({
            clear: true,
          });

          yield* lifetime.markCancelPending(first, entry.id);
          const pending = yield* lifetime.exitGateState({ agentId: entry.id, sessionId: first });
          expect(pending.clear).toBe(false);
          if (!pending.clear) {
            expect(pending.state).toBe('cancelPending');
            expect(pending.pid).toBe(manager.pid);
            expect(pending.detail).toContain(String(manager.pid));
          }

          yield* lifetime.markCancelSettled(first);
          expect(yield* lifetime.exitGateState({ agentId: entry.id, sessionId: first })).toEqual({
            clear: true,
          });
        }),
      ),
    TIMEOUT,
  );
});

describe.runIf(process.platform === 'win32')('AgentLifetime exit gate on kill timeout', () => {
  it.effect(
    'blocks with unconfirmed PID and killTimedOut state until process exit is observed',
    () =>
      Effect.gen(function* () {
        const install = yield* installFakeAgent;
        const missingSystem = Layer.succeed(PathSources, {
          platform: 'win32',
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
            ComSpec:
              process.env['ComSpec'] ?? process.env['COMSPEC'] ?? 'C:\\Windows\\System32\\cmd.exe',
            SystemRoot: join(install.bin, 'no-windows'),
          },
          readRegistryPath: () => Effect.succeed(Option.none()),
          readLoginShellPath: Effect.succeed(Option.none()),
        });
        const acpClient = layerAcpClient.pipe(
          Layer.provide(layerAgentLogs(install.logs)),
          Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed(install.bin) })),
          Layer.provide(missingSystem),
        );
        const layer = layerAgentLifetime.pipe(Layer.provideMerge(acpClient));
        yield* Effect.gen(function* () {
          const lifetime = yield* AgentLifetime;
          const client = yield* AcpClient;
          const entry = fakeEntry(['--delay-exit=800']);
          const manager = yield* client.connect(entry);
          const s1 = yield* lifetime.turnStarted(first, openOn(client), entry.id);
          yield* Effect.forkChild(s1.prompt([{ type: 'text', text: 'stall' }]));

          const confirmedSub = yield* lifetime.subscribeExitConfirmed;
          const confirmedFiber = yield* Stream.runHead(confirmedSub).pipe(Effect.forkChild);

          const killFiber = yield* Effect.forkChild(lifetime.killAgent(entry.id));
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));
          yield* TestClock.adjust('5 seconds');
          const result = yield* Fiber.join(killFiber);
          expect(result.exitConfirmed).toBe(false);

          const gate = yield* lifetime.exitGateState({ agentId: entry.id, sessionId: first });
          expect(gate.clear).toBe(false);
          if (!gate.clear) {
            expect(gate.state).toBe('killTimedOut');
            expect(gate.pid).toBe(manager.pid);
            expect(gate.detail).toContain(String(manager.pid));
            expect(gate.detail).toContain('killTimedOut');
          }

          yield* Fiber.join(confirmedFiber);
          expect(yield* lifetime.exitGateState({ agentId: entry.id, sessionId: first })).toEqual({
            clear: true,
          });
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});
