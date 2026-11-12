import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Option, Schedule, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { fakeEntry, installFakeAgent, layerAcpClientWithFakeAgent } from './acpFakes';
import { AgentLifetime, layerAgentLifetime } from './acpLifetime';
import { AcpClient } from './acpSessionManager';

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

          const again = yield* lifetime
            .turnStarted(first, counted)
            .pipe(
              Effect.repeat({ until: (next) => next !== session, schedule: Schedule.spaced('20 millis') }),
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
});
