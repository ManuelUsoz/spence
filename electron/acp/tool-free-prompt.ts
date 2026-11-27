import type { PromptResponse } from '@agentclientprotocol/sdk';
import { Deferred, Effect, type Exit, Fiber, type Scope, Stream } from 'effect';
import { randomUUID } from 'node:crypto';
import type { MessagePart, Step, TurnId } from '../../src/shared/sessions/sessions.rpc';
import type { CatalogEntry } from '../agents/catalog';
import type { AcpError } from './acpErrors';
import { cancelledOutcome, foldUpdate, openTurn, toAcpPrompt } from './acpMappers';
import type { AcpSession } from './acpSession';
import { AcpClient, TOOL_FREE_CLIENT_CAPABILITIES } from './acpSessionManager';

export interface ToolFreePromptResult {
  readonly promptExit: Exit.Exit<PromptResponse, AcpError>;
  readonly replyText: string;
  readonly steps: ReadonlyArray<Step>;
  readonly unexpectedAction: boolean;
  readonly unexpectedPermission: boolean;
}

/**
 * Runs one tool-free ACP prompt and collects text replies while cancelling immediately
 * on any `tool_call`, `tool_call_update`, or `PermissionRequest`.
 */
export const runToolFreePrompt = Effect.fnUntraced(function* (
  acp: AcpSession,
  turnId: TurnId,
  cwd: string,
  parts: ReadonlyArray<MessagePart>,
  scope: Scope.Scope,
): Effect.fn.Return<ToolFreePromptResult> {
  let fold = openTurn(turnId, cwd);
  let unexpectedAction = false;
  let unexpectedPermission = false;
  const replyChunks: string[] = [];

  const reader = yield* acp.events.pipe(
    Stream.takeUntil((event) => event._tag === 'PromptEnded'),
    Stream.runForEach(
      Effect.fnUntraced(function* (event) {
        if (event._tag === 'PermissionRequest') {
          unexpectedPermission = true;
          unexpectedAction = true;
          yield* Deferred.succeed(event.answer, cancelledOutcome);
          yield* acp.cancel.pipe(Effect.ignore);
          return;
        }
        if (event._tag === 'Update') {
          if (
            event.update.sessionUpdate === 'tool_call' ||
            event.update.sessionUpdate === 'tool_call_update'
          ) {
            unexpectedAction = true;
            const [nextFold] = foldUpdate(fold, event.update, randomUUID);
            fold = nextFold;
            yield* acp.cancel.pipe(Effect.ignore);
            return;
          }
          const [nextFold, items] = foldUpdate(fold, event.update, randomUUID);
          fold = nextFold;
          for (const item of items) {
            if (item._tag === 'Message' && item.role === 'agent') {
              for (const part of item.parts) {
                if (part._tag === 'text') replyChunks.push(part.text);
              }
            } else if (item._tag === 'MessageDelta') {
              replyChunks.push(item.text);
            }
          }
        }
      }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  const promptExit = yield* Effect.exit(acp.prompt(toAcpPrompt(parts)));
  yield* Fiber.await(reader);

  return {
    promptExit,
    replyText: replyChunks.join('').trim(),
    steps: [...fold.steps.values()],
    unexpectedAction,
    unexpectedPermission,
  };
});

/**
 * Opens an isolated tool-free ACP session (`TOOL_FREE_CLIENT_CAPABILITIES`, no `fs` or `terminal`),
 * runs `runToolFreePrompt`, and ensures the session and connection close when the scope closes.
 */
export const runIsolatedToolFreePrompt = Effect.fn('Acp.runIsolatedToolFreePrompt')(function* (
  entry: CatalogEntry,
  turnId: TurnId,
  cwd: string,
  parts: ReadonlyArray<MessagePart>,
  options?: { readonly model?: string },
) {
  const acpClient = yield* AcpClient;

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const manager =
        acpClient.connectIsolated !== undefined
          ? yield* acpClient.connectIsolated(entry, TOOL_FREE_CLIENT_CAPABILITIES)
          : yield* acpClient.connect(entry);
      const session = yield* manager.newSession(cwd);
      if (
        options?.model !== undefined &&
        options.model.trim().length > 0 &&
        options.model !== 'lastUsed'
      ) {
        yield* session.setConfigOption('model', options.model).pipe(Effect.ignore);
      }

      return yield* Effect.ensuring(
        runToolFreePrompt(session, turnId, cwd, parts, scope),
        session.close.pipe(Effect.ignore),
      );
    }),
  );
});
