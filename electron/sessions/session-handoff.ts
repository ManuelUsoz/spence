import { Deferred, Effect, Exit, Fiber, type Scope, Stream } from 'effect';
import { randomUUID } from 'node:crypto';
import type { AgentCapabilities, Effort, Model } from '../../src/shared/agents/agents.rpc';
import { type Locale } from '../i18n/locale';
import { sessionCopy } from '../i18n/session-copy';
import {
  buildHandoffAcknowledgementPrompt,
  buildIsolatedSummaryPrompt,
  checkImageCompatibility,
} from '../../src/shared/sessions/handoff';
import {
  type ContextUsage,
  type HandoffCompatibility,
  type HandoffDraftSource,
  type HandoffImage,
  type Message,
  MessageId,
  type MessagePart,
  type Step,
  TurnId,
} from '../../src/shared/sessions/sessions.rpc';
import type { PermissionMode } from '../../src/shared/projects/projects.rpc';
import {
  cancelledOutcome,
  foldUpdate,
  openTurn,
  promptOutcome,
  toAcpPrompt,
} from '../acp/acpMappers';
import { type AcpSession } from '../acp/acpSession';
import { AcpClient, type AcpSessionManager } from '../acp/acpSessionManager';
import type { CatalogEntry } from '../agents/catalog';
import type { AgentMemory } from '../settings/remembered';
import { foldOptions } from './session-options';

const isEffort = (value: string | undefined): value is Effort =>
  value === 'low' || value === 'medium' || value === 'high' || value === 'max';

export interface IsolatedSummaryResult {
  readonly summary: string;
  readonly draftSource: HandoffDraftSource;
  readonly fallbackReason?: string;
}

/** Runs one tool-free ACP prompt and collects text replies while cancelling on any tool call or permission request. */
const runToolFreePrompt = Effect.fnUntraced(function* (
  acp: AcpSession,
  turnId: TurnId,
  cwd: string,
  parts: ReadonlyArray<MessagePart>,
  scope: Scope.Scope,
) {
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
 * Drafts a summary in an isolated tool-free ACP session (`fs` off in `CLIENT_CAPABILITIES`, and any unexpected
 * `tool_call` / `PermissionRequest` cancels immediately) when `supportsIsolatedSummary` is true and the outgoing
 * Agent can run; otherwise falls back to `fallbackSummary`.
 */
export const draftSummaryWithFallback = Effect.fn('Sessions.draftSummaryWithFallback')(function* (
  outgoing: CatalogEntry,
  canRunOutgoing: boolean,
  cwd: string,
  fallbackSummary: string,
  locale: Locale = 'en',
) {
  const copy = sessionCopy(locale).handoff;
  if (!outgoing.capabilities.supportsIsolatedSummary) {
    return {
      summary: fallbackSummary,
      draftSource: 'transcriptExtract',
      fallbackReason: copy.isolatedUnsupported(outgoing.name),
    } satisfies IsolatedSummaryResult;
  }
  if (!canRunOutgoing) {
    return {
      summary: fallbackSummary,
      draftSource: 'transcriptExtract',
      fallbackReason: copy.isolatedUnavailable(outgoing.name),
    } satisfies IsolatedSummaryResult;
  }

  const acpClient = yield* AcpClient;

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const manager = yield* acpClient.connect(outgoing);
      const session = yield* manager.newSession(cwd);
      const turnId = TurnId.make(`isolated-${randomUUID()}`);

      const result = yield* Effect.ensuring(
        runToolFreePrompt(
          session,
          turnId,
          cwd,
          [{ _tag: 'text', text: buildIsolatedSummaryPrompt(fallbackSummary) }],
          scope,
        ),
        session.close.pipe(Effect.ignore),
      );

      if (result.unexpectedAction) {
        return {
          summary: fallbackSummary,
          draftSource: 'transcriptExtract',
          fallbackReason: copy.isolatedToolCall(outgoing.name),
        } satisfies IsolatedSummaryResult;
      }

      if (Exit.isFailure(result.promptExit)) {
        return {
          summary: fallbackSummary,
          draftSource: 'transcriptExtract',
          fallbackReason: copy.isolatedFailed(outgoing.name),
        } satisfies IsolatedSummaryResult;
      }

      if (result.replyText.length === 0) {
        return {
          summary: fallbackSummary,
          draftSource: 'transcriptExtract',
          fallbackReason: copy.isolatedEmpty(outgoing.name),
        } satisfies IsolatedSummaryResult;
      }

      return {
        summary: result.replyText,
        draftSource: 'isolatedSummary',
      } satisfies IsolatedSummaryResult;
    }),
  ).pipe(
    Effect.catch(() =>
      Effect.succeed({
        summary: fallbackSummary,
        draftSource: 'transcriptExtract',
        fallbackReason: copy.isolatedFailed(outgoing.name),
      } satisfies IsolatedSummaryResult),
    ),
  );
});

export interface CompatibilityInput {
  readonly target: CatalogEntry;
  readonly installed: boolean;
  readonly unconfirmedExit:
    | { readonly pid?: number; readonly state: 'stopping' | 'killTimedOut' | 'cancelPending' }
    | undefined;
  readonly memory: AgentMemory;
  readonly defaultModel?: string;
  readonly defaultEffort?: string;
  readonly liveCapabilities?: AgentCapabilities;
  readonly liveModels?: ReadonlyArray<Model>;
  readonly sourceAgentId: CatalogEntry['id'];
  readonly sourceModel?: string;
  readonly sourceEffort?: string;
  readonly sourcePermissionMode: PermissionMode;
  readonly sourceContextUsage?: ContextUsage;
  readonly requestedModel?: string;
  readonly images: ReadonlyArray<HandoffImage>;
  readonly selectedImageIds?: ReadonlyArray<string>;
  readonly locale?: Locale;
}

/** Computes destination compatibility, Model/Effort/Permission resolution, and blocked Images without silent substitution. */
export const resolveHandoffCompatibility = (input: CompatibilityInput): HandoffCompatibility => {
  const copy = sessionCopy(input.locale ?? 'en').handoff;
  const { target, installed, unconfirmedExit, memory } = input;
  const capabilities = input.liveCapabilities ?? target.capabilities;
  const rawModels = input.liveModels ?? memory.models ?? [];
  const filteredModels =
    target.filterModels === undefined ? rawModels : target.filterModels(rawModels).models;
  const canRun = installed && unconfirmedExit === undefined;

  const desiredModel = input.requestedModel ?? input.sourceModel;
  const configuredDefault =
    input.defaultModel === 'lastUsed' || input.defaultModel === undefined
      ? memory.lastModel
      : input.defaultModel;

  let resolvedModel: string | undefined;
  let modelMismatchNote: string | undefined;

  if (filteredModels.length > 0) {
    const hasModel = (id: string | undefined): id is string =>
      id !== undefined && filteredModels.some((model) => model.id === id);

    if (hasModel(desiredModel)) {
      resolvedModel = desiredModel;
    } else if (input.requestedModel !== undefined) {
      modelMismatchNote = copy.modelNotOffered(input.requestedModel, target.name);
    } else if (hasModel(configuredDefault)) {
      resolvedModel = configuredDefault;
      if (desiredModel !== undefined) {
        modelMismatchNote = copy.modelPrefilledDefault(
          target.name,
          desiredModel,
          configuredDefault,
        );
      }
    } else if (desiredModel !== undefined) {
      modelMismatchNote = copy.modelNoValidDefault(target.name, desiredModel);
    }
  } else if (desiredModel !== undefined && input.target.id === input.sourceAgentId) {
    resolvedModel = desiredModel;
  } else if (configuredDefault !== undefined) {
    resolvedModel = configuredDefault;
  }

  let effortNote: string | undefined;
  let resolvedEffort = isEffort(input.sourceEffort) ? input.sourceEffort : undefined;
  if (!capabilities.effort) {
    resolvedEffort = undefined;
    effortNote = copy.effortUnavailable(target.name);
  } else if (resolvedEffort === undefined && isEffort(memory.lastEffort)) {
    resolvedEffort = memory.lastEffort;
  }

  let permissionNote: string | undefined;
  let resolvedPermissionMode: PermissionMode = input.sourcePermissionMode;
  if (input.sourcePermissionMode === 'ask' && !capabilities.askMode) {
    resolvedPermissionMode = 'auto';
    permissionNote = copy.askModeUnavailable(target.name);
  }

  let destinationCapacity: number | undefined;
  if (
    target.id === input.sourceAgentId &&
    resolvedModel === input.sourceModel &&
    input.sourceContextUsage !== undefined &&
    (input.sourceContextUsage._tag === 'reported' || input.sourceContextUsage._tag === 'historical')
  ) {
    destinationCapacity = input.sourceContextUsage.capacity;
  }

  const blockedImages = checkImageCompatibility(
    input.images,
    capabilities,
    target.imageLimits,
    input.selectedImageIds,
  );

  return {
    agentId: target.id,
    agentName: target.name,
    installed,
    canRun,
    ...(unconfirmedExit === undefined ? {} : { unconfirmedExit }),
    capabilities,
    imageLimits: target.imageLimits,
    availableModels: filteredModels,
    ...(resolvedModel === undefined ? {} : { resolvedModel }),
    ...(modelMismatchNote === undefined ? {} : { modelMismatchNote }),
    ...(resolvedEffort === undefined ? {} : { resolvedEffort }),
    ...(effortNote === undefined ? {} : { effortNote }),
    resolvedPermissionMode,
    ...(permissionNote === undefined ? {} : { permissionNote }),
    ...(destinationCapacity === undefined ? {} : { destinationCapacity }),
    blockedImages,
  };
};

export type AcknowledgementOutcome =
  | {
      readonly ok: true;
      readonly manager: AcpSessionManager;
      readonly acp: AcpSession;
      readonly config: AcpSession['configOptions'];
      readonly userMessage: Message;
      readonly agentMessage: Message;
      readonly turnId: TurnId;
    }
  | {
      readonly ok: false;
      readonly status: 'failed' | 'interrupted';
      readonly messages: ReadonlyArray<Message>;
      readonly steps: ReadonlyArray<Step>;
      readonly diskStateNote?: string;
      readonly failureReason: string;
    };

/**
 * Runs the destination startup acknowledgement Turn on a fresh ACP session without touching the source Transcript.
 * Commits only if the destination replies with `end_turn` and zero unexpected steps/permission requests.
 */
export const runDestinationAcknowledgement = Effect.fn('Sessions.runDestinationAcknowledgement')(
  function* (input: {
    readonly manager: AcpSessionManager;
    readonly target: CatalogEntry;
    readonly cwd: string;
    readonly summary: string;
    readonly selectedImages: ReadonlyArray<HandoffImage>;
    readonly targetModel?: string;
    readonly targetEffort?: string;
    readonly permissionMode: PermissionMode;
    readonly onSessionOpened: (acp: AcpSession) => void;
    readonly isCancelled: () => boolean;
    readonly scope: Scope.Scope;
    readonly mcpServers?: Parameters<AcpSessionManager['newSession']>[1];
    readonly locale?: Locale;
  }) {
    const copy = sessionCopy(input.locale ?? 'en').handoff;
    const opened = yield* input.manager.newSession(input.cwd, input.mcpServers).pipe(
      Effect.map((acp) => ({ _tag: 'ok' as const, acp })),
      Effect.catch((error) => Effect.succeed({ _tag: 'err' as const, detail: error.detail })),
    );
    if (opened._tag === 'err') {
      return {
        ok: false,
        status: 'interrupted',
        messages: [],
        steps: [],
        failureReason: opened.detail,
      } satisfies AcknowledgementOutcome;
    }
    const acp = opened.acp;
    input.onSessionOpened(acp);

    let config = acp.configOptions;
    const applyConfig = Effect.fnUntraced(function* (option: 'model' | 'effort', value: string) {
      const folded = foldOptions(config, input.target.effort, input.permissionMode);
      const current = option === 'model' ? folded.model?.value : folded.effort?.value;
      if (current === value) return;
      const targetChoice = config.find((opt) =>
        option === 'model'
          ? opt.category === 'model' || opt.id.toLowerCase() === 'model'
          : opt.type === 'select' && opt.category === 'thought_level',
      );
      if (targetChoice === undefined) return;
      config = yield* acp
        .setConfigOption(targetChoice.id, value)
        .pipe(Effect.catch(() => Effect.succeed(config)));
    });

    if (input.targetModel !== undefined) yield* applyConfig('model', input.targetModel);
    if (input.targetEffort !== undefined) yield* applyConfig('effort', input.targetEffort);

    const modeMapping =
      input.permissionMode === 'ask'
        ? input.target.permissionModes.ask
        : input.target.permissionModes.auto;
    if (modeMapping !== undefined && acp.modes !== null) {
      yield* acp.setMode(modeMapping.agentMode).pipe(Effect.ignore);
    }

    const turnId = TurnId.make(`handoff-${randomUUID()}`);
    const promptText = buildHandoffAcknowledgementPrompt(input.summary, input.selectedImages);
    const promptParts: ReadonlyArray<MessagePart> = [
      { _tag: 'text', text: promptText },
      ...input.selectedImages.map((img): MessagePart => ({
        _tag: 'image',
        mimeType: img.mimeType,
        data: img.data,
      })),
    ];
    const userMessage: Message = {
      _tag: 'Message',
      id: MessageId.make(`msg-${randomUUID()}`),
      turnId,
      role: 'user',
      parts: promptParts,
    };

    const { promptExit, replyText, steps, unexpectedAction, unexpectedPermission } =
      yield* runToolFreePrompt(acp, turnId, input.cwd, promptParts, input.scope);

    const outcome = promptOutcome(promptExit);
    const agentReplyMessage: ReadonlyArray<Message> =
      replyText.length > 0
        ? [
            {
              _tag: 'Message',
              id: MessageId.make(`msg-${randomUUID()}`),
              turnId,
              role: 'agent',
              parts: [{ _tag: 'text', text: replyText }],
            },
          ]
        : [];
    const allMessages: ReadonlyArray<Message> = [userMessage, ...agentReplyMessage];

    const hasEditOrDiff = steps.some((step) => step.kind === 'edit' || step.diffs.length > 0);
    const diskStateNote = hasEditOrDiff ? copy.diskStateEdits : undefined;

    if (
      Exit.isSuccess(promptExit) &&
      outcome._tag === 'done' &&
      !unexpectedAction &&
      steps.length === 0 &&
      !input.isCancelled()
    ) {
      const finalAgentMessage: Message =
        agentReplyMessage[0] ??
        ({
          _tag: 'Message',
          id: MessageId.make(`msg-${randomUUID()}`),
          turnId,
          role: 'agent',
          parts: [{ _tag: 'text', text: copy.acknowledged }],
        } satisfies Message);

      return {
        ok: true,
        manager: input.manager,
        acp,
        config,
        userMessage,
        agentMessage: finalAgentMessage,
        turnId,
      } satisfies AcknowledgementOutcome;
    }

    yield* acp.close.pipe(Effect.ignore);

    const isInterrupted =
      input.isCancelled() ||
      outcome._tag === 'cancelled' ||
      (outcome._tag === 'failed' &&
        (outcome.reason === 'agentStopped' || outcome.reason === 'interrupted'));

    const failureReason = unexpectedPermission
      ? copy.requestedPermission(input.target.name)
      : unexpectedAction || steps.length > 0
        ? copy.ranUnexpectedSteps(input.target.name)
        : outcome._tag === 'failed'
          ? outcome.detail
          : input.isCancelled() || outcome._tag === 'cancelled'
            ? copy.startupCancelled
            : copy.didNotAcknowledge(input.target.name);

    return {
      ok: false,
      status: isInterrupted ? 'interrupted' : 'failed',
      messages: allMessages,
      steps,
      ...(diskStateNote === undefined ? {} : { diskStateNote }),
      failureReason,
    } satisfies AcknowledgementOutcome;
  },
);
