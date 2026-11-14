import { describe, expect, it } from '@effect/vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Deferred, Effect, Fiber, Option, Schedule, Stream } from 'effect';
import { fakeEntry, installFakeAgent, layerAcpClientWithFakeAgent } from './acpFakes';
import type { AcpSessionEvent } from './acpClientDispatcher';
import type { AcpError } from './acpErrors';
import { AcpSessionId } from './acpSession';
import { AcpClient } from './acpSessionManager';

/** Runs `program` against the production client with the fake Agent installed. */
const withFakeAgent = <A, E>(program: Effect.Effect<A, E, AcpClient>) =>
  Effect.gen(function* () {
    const install = yield* installFakeAgent;
    return yield* program.pipe(Effect.provide(layerAcpClientWithFakeAgent(install)));
  }).pipe(Effect.scoped);

/** The text of the first `n` agent message chunks a session streams. */
const agentText = (events: Stream.Stream<AcpSessionEvent, AcpError>, n: number) =>
  events.pipe(
    Stream.map((event) =>
      event._tag === 'Update' &&
      event.update.sessionUpdate === 'agent_message_chunk' &&
      event.update.content.type === 'text'
        ? event.update.content.text
        : undefined,
    ),
    Stream.filter((text): text is string => text !== undefined),
    Stream.take(n),
    Stream.runCollect,
    Effect.map((chunks) => chunks.join('')),
  );

const earlier = AcpSessionId.make('earlier');

/** Spawning node through a shim and a real ACP handshake take longer than the default 5 s on a cold machine. */
const TIMEOUT = 30_000;

describe('AcpClient against the fake Agent', () => {
  it.live(
    'initializes, opens a session and streams a prompt turn to its end',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const agent = yield* AcpClient.use((client) => client.connect(fakeEntry()));
          expect(agent.agentCapabilities.promptCapabilities?.image).toBe(true);
          expect(agent.authMethods.map((method) => method.id)).toEqual(['login']);

          const session = yield* agent.newSession(process.cwd());
          const response = yield* session.prompt([{ type: 'text', text: 'echo:Hello there' }]);

          expect(response.stopReason).toBe('end_turn');
          expect(yield* agentText(session.events, 3)).toBe('Hello there');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'cancel ends the turn cancelled and answers the pending Permission request cancelled',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const agent = yield* AcpClient.use((client) => client.connect(fakeEntry()));
          const session = yield* agent.newSession(process.cwd());
          const turn = yield* Effect.forkChild(session.prompt([{ type: 'text', text: 'ask' }]));
          const permission = yield* session.events.pipe(
            Stream.filter((event) => event._tag === 'PermissionRequest'),
            Stream.runHead,
          );
          expect(Option.map(permission, (event) => event.request.toolCall.toolCallId)).toEqual(
            Option.some('call-1'),
          );

          yield* session.cancel;

          expect((yield* Fiber.join(turn)).stopReason).toBe('cancelled');
          if (Option.isSome(permission)) {
            expect(yield* Deferred.await(permission.value.answer)).toEqual({
              outcome: 'cancelled',
            });
          }
          // The fake Agent reports the outcome it received.
          expect(yield* agentText(session.events, 1)).toBe('permission cancelled');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'refuses an Agent that answers initialize with protocol version 2',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const error = yield* AcpClient.use((client) =>
            client.connect(fakeEntry(['--protocol=2'])),
          ).pipe(Effect.flip);
          expect(error._tag === 'AcpError' && error.reason).toBe('ProtocolVersion');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'surfaces a crash of the Agent as an Exited failure and starts it again on the next connect',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const client = yield* AcpClient;
          const agent = yield* client.connect(fakeEntry());
          const session = yield* agent.newSession(process.cwd());

          const error = yield* session.prompt([{ type: 'text', text: 'crash' }]).pipe(Effect.flip);
          expect(error.reason).toBe('Exited');
          expect(error.detail).toContain('exit code 3');
          expect(error.detail).toMatch(/fake agent \d+ up/);
          const streamError = yield* session.events.pipe(Stream.runDrain, Effect.flip);
          expect(streamError.reason).toBe('Exited');
          expect(streamError.detail).toMatch(/fake agent \d+ up/);

          const restarted = yield* client.connect(fakeEntry()).pipe(
            // The dead connection is forgotten once its sessions have failed.
            Effect.repeat({
              until: (next) => next !== agent,
              schedule: Schedule.spaced('20 millis'),
            }),
          );
          const again = yield* restarted.newSession(process.cwd());
          expect((yield* again.prompt([{ type: 'text', text: 'echo:back' }])).stopReason).toBe(
            'end_turn',
          );
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'shares one connection per Agent',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const client = yield* AcpClient;
          const [first, second] = yield* Effect.all(
            [client.connect(fakeEntry()), client.connect(fakeEntry())],
            { concurrency: 'unbounded' },
          );
          expect(second).toBe(first);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'drops the replayed history of a loaded session: its events start with the next prompt',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const agent = yield* AcpClient.use((client) => client.connect(fakeEntry()));
          const session = yield* agent.loadSession(earlier, process.cwd());
          yield* session.prompt([{ type: 'text', text: 'echo:after' }]);
          expect(yield* agentText(session.events, 3)).toBe('after');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'calls only what the Agent advertises',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const agent = yield* AcpClient.use((client) => client.connect(fakeEntry(['--bare'])));
          const refused = yield* Effect.all([
            agent.loadSession(earlier, process.cwd()).pipe(Effect.flip),
            agent.resumeSession(earlier, process.cwd()).pipe(Effect.flip),
            agent.deleteSession(earlier).pipe(Effect.flip),
          ]);
          expect(refused.map((error) => error.reason)).toEqual([
            'Unsupported',
            'Unsupported',
            'Unsupported',
          ]);
          const session = yield* agent.newSession(process.cwd());
          const image = yield* session
            .prompt([{ type: 'image', mimeType: 'image/png', data: 'AA==' }])
            .pipe(Effect.flip);
          expect(image.reason).toBe('Unsupported');
          // Without `session/close` the session is simply forgotten.
          yield* session.close;
          yield* session.events.pipe(Stream.runDrain);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'sets a config option and gets the complete list back',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const agent = yield* AcpClient.use((client) => client.connect(fakeEntry()));
          const session = yield* agent.newSession(process.cwd());
          const options = yield* session.setConfigOption('model', 'large');
          expect(
            options
              .filter((option) => option.type === 'select')
              .map((option) => [option.id, option.currentValue]),
          ).toEqual([
            ['model', 'large'],
            ['effort', 'medium'],
            ['permission', 'ask'],
          ]);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'reports initialize.agentInfo.version and allows --version overrides',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const agent = yield* AcpClient.use((client) =>
            client.connect(fakeEntry(['--version=0.9.0'])),
          );
          expect(agent.agentInfo?.version).toBe('0.9.0');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'refuses an Agent missing required admission gates or ACP support',
    () =>
      withFakeAgent(
        Effect.gen(function* () {
          const client = yield* AcpClient;
          const noAuto = yield* client.connect(fakeEntry(['--no-auto'])).pipe(Effect.flip);
          expect(noAuto._tag === 'AcpError' && noAuto.reason).toBe('Unsupported');
          const noCancel = yield* client.connect(fakeEntry(['--no-cancel'])).pipe(Effect.flip);
          expect(noCancel._tag === 'AcpError' && noCancel.reason).toBe('Unsupported');
          const noAuth = yield* client
            .connect(fakeEntry(['--no-auth-detection']))
            .pipe(Effect.flip);
          expect(noAuth._tag === 'AcpError' && noAuth.reason).toBe('Unsupported');
          const noAcp = yield* client.connect(fakeEntry(['--no-acp'])).pipe(Effect.flip);
          expect(noAcp._tag === 'AcpError' && noAcp.reason).toBe('Exited');
        }),
      ),
    TIMEOUT,
  );
});

describe('Agent log', () => {
  it.live(
    'records the spawn command, stderr and the exit code',
    () =>
      Effect.gen(function* () {
        const install = yield* installFakeAgent;
        yield* AcpClient.use((client) => client.connect(fakeEntry())).pipe(
          Effect.provide(layerAcpClientWithFakeAgent(install)),
        );
        const log = yield* Effect.promise(() => readFile(join(install.logs, 'fake.log'), 'utf8'));
        expect(log).toContain('spawned pid');
        expect(log).toContain('fake-agent');
        expect(log).toMatch(/stderr fake agent \d+ up/);
        expect(log).toMatch(/exited with (exit code \d+|signal \w+)/);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});
