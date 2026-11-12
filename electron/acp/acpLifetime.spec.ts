import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Option, Stream } from 'effect';
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
});
