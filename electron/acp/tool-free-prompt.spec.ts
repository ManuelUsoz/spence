import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Exit, Queue, Stream } from 'effect';
import { TurnId } from '../../src/shared/sessions/sessions.rpc';
import type { AcpSessionEvent } from './acpClientDispatcher';
import { AcpSessionId, type AcpSession } from './acpSession';
import { TOOL_FREE_CLIENT_CAPABILITIES } from './acpSessionManager';
import { runToolFreePrompt } from './tool-free-prompt';

const makeFakeSession = (
  eventsToEmit: ReadonlyArray<AcpSessionEvent>,
  onCancel: () => void,
): Effect.Effect<AcpSession> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<AcpSessionEvent>();
    return {
      sessionId: AcpSessionId.make('fake-acp-session'),
      modes: null,
      configOptions: [],
      events: Stream.fromQueue(queue),
      attachWorker: () => Effect.die('unused'),
      prompt: () =>
        Effect.gen(function* () {
          for (const ev of eventsToEmit) {
            yield* Queue.offer(queue, ev);
          }
          yield* Queue.offer(queue, {
            _tag: 'PromptEnded',
            result: Exit.succeed({ stopReason: 'end_turn' as const }),
          });
          return { stopReason: 'end_turn' as const };
        }),
      compact: Effect.void,
      cancel: Effect.sync(onCancel),
      flushTerminals: Effect.void,
      cancelTerminals: Effect.void,
      steering: undefined,
      setMode: () => Effect.void,
      setConfigOption: () => Effect.succeed([]),
      steer: () => Effect.succeed('notRunning' as const),
      steerNative: () => Effect.void,
      close: Effect.void,
    };
  });

describe('runToolFreePrompt', () => {
  it('exposes TOOL_FREE_CLIENT_CAPABILITIES without fs or terminal', () => {
    expect(TOOL_FREE_CLIENT_CAPABILITIES.fs).toBeUndefined();
    expect(TOOL_FREE_CLIENT_CAPABILITIES.terminal).toBeUndefined();
  });

  it.effect('collects agent text replies when no tool call or permission occurs', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        let cancelled = false;
        const session = yield* makeFakeSession(
          [
            {
              _tag: 'Update',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Hello ' },
              },
            },
            {
              _tag: 'Update',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'world' },
              },
            },
          ],
          () => {
            cancelled = true;
          },
        );

        const result = yield* runToolFreePrompt(
          session,
          TurnId.make('turn-1'),
          '/tmp',
          [{ _tag: 'text', text: 'Draft a PR' }],
          scope,
        );

        expect(cancelled).toBe(false);
        expect(result.unexpectedAction).toBe(false);
        expect(result.unexpectedPermission).toBe(false);
        expect(result.replyText).toBe('Hello world');
      }),
    ),
  );

  it.effect('cancels immediately on tool_call or tool_call_update', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        let cancelCount = 0;
        const session = yield* makeFakeSession(
          [
            {
              _tag: 'Update',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-1',
                title: 'Read file',
                status: 'pending',
              },
            },
          ],
          () => {
            cancelCount += 1;
          },
        );

        const result = yield* runToolFreePrompt(
          session,
          TurnId.make('turn-2'),
          '/tmp',
          [{ _tag: 'text', text: 'Draft a PR' }],
          scope,
        );

        expect(cancelCount).toBe(1);
        expect(result.unexpectedAction).toBe(true);
        expect(result.unexpectedPermission).toBe(false);
      }),
    ),
  );

  it.effect('cancels immediately and rejects on PermissionRequest', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        let cancelCount = 0;
        const answer = yield* Deferred.make<{ outcome: 'cancelled' }>();
        const session = yield* makeFakeSession(
          [
            {
              _tag: 'PermissionRequest',
              request: {
                sessionId: 'fake-acp-session',
                toolCall: { toolCallId: 'tc-2', title: 'Run bash' },
                options: [],
              },
              answer: answer as never,
            },
          ],
          () => {
            cancelCount += 1;
          },
        );

        const result = yield* runToolFreePrompt(
          session,
          TurnId.make('turn-3'),
          '/tmp',
          [{ _tag: 'text', text: 'Draft a PR' }],
          scope,
        );

        expect(cancelCount).toBe(1);
        expect(result.unexpectedAction).toBe(true);
        expect(result.unexpectedPermission).toBe(true);
        const outcome = yield* Deferred.await(answer);
        expect(outcome).toEqual({ outcome: 'cancelled' });
      }),
    ),
  );
});
