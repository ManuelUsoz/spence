import type {
  CompactionStatus,
  ContentBlock,
  PermissionOptionKind,
  PromptResponse,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk/unstable';
import { Cause, Exit, Option } from 'effect';
import path from 'node:path';
import { capOutputTail, MAX_STEP_OUTPUT_BYTES } from '../../src/shared/sessions/output-tail';
import {
  type Compaction,
  CompactionId,
  type ContextUsage,
  type Diff,
  MessageId,
  type Notice,
  type PlanEntry,
  type Step,
  StepId,
  type StepKind,
  type StepStatus,
  ThoughtId,
  type MessagePart,
  type PermissionOption,
  type PermissionRequest,
  type PermissionRequestId,
  type TranscriptItem,
  type TurnId,
  type TurnOutcome,
} from '../../src/shared/sessions/sessions.rpc';
import type { AcpError } from './acpErrors';

// ACP -> Spence contract. Main folds ACP's partial updates into whole Transcript items; only Message and Thought text
// stream, as deltas appended to the item the Turn has open.

/**
 * What a running Turn has open: the agent Message or the Thought the next text chunk appends to, and every Step and
 * Compaction so far, by the Agent's id, so an update can be merged into the whole item.
 */
export interface TurnFold {
  readonly turnId: TurnId;
  /** The Project folder: Step files are made relative to it. */
  readonly cwd: string;
  readonly message?: MessageId;
  readonly thought?: ThoughtId;
  readonly steps: ReadonlyMap<string, Step>;
  readonly compactions: ReadonlyMap<string, Compaction>;
  /** Terminal IDs bound to each Step (in attachment order), via `content: [{ type: 'terminal', terminalId }]`. */
  readonly stepTerminals: ReadonlyMap<StepId, ReadonlyArray<string>>;
  /** Steps that have streamed terminal output via `StepDelta`, so later updates never overwrite it. */
  readonly streamedSteps: ReadonlySet<StepId>;
}

export const openTurn = (turnId: TurnId, cwd: string): TurnFold => ({
  turnId,
  cwd,
  steps: new Map(),
  compactions: new Map(),
  stepTerminals: new Map(),
  streamedSteps: new Set(),
});

/** The fold with no Message or Thought open: the next text starts a new one. */
const closeText = ({ message: _message, thought: _thought, ...fold }: TurnFold): TurnFold => fold;

const stepKind = (kind: ToolKind | null | undefined): StepKind => {
  switch (kind) {
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
    case 'search':
    case 'execute':
    case 'fetch':
    case 'other':
      return kind;
    case 'think':
    case 'switch_mode':
    case null:
    case undefined:
      return 'other';
  }
};

const stepStatus = (status: ToolCallStatus): StepStatus => {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
  }
};

const MAX_INPUT_BYTES = 16_384;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTerminalStepStatus = (status: StepStatus): boolean =>
  status === 'done' || status === 'failed' || status === 'cancelled';

/** Keeps the leading `maxBytes` of `text` on valid UTF-8 boundaries when an input payload is oversized. */
const capInputHead = (text: string, maxBytes = MAX_INPUT_BYTES): string => {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  const suffix = '\n… (truncated)';
  let end = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8') + suffix;
};

/** A path the Agent gave, relative to the Project (with `/`) when it is inside it, else as given. */
const inProject = (cwd: string, file: string): string => {
  if (cwd === '') return file;
  const relative = path.relative(cwd, file);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative)
    ? file
    : relative.split(path.sep).join('/');
};

/** The diffs and text output of a tool call's content; terminals are left to terminal streaming. */
const contentOf = (cwd: string, content: ReadonlyArray<ToolCallContent>) => ({
  diffs: content.flatMap((part): ReadonlyArray<Diff> => {
    if (part.type !== 'diff') return [];
    const before = part.oldText ?? undefined;
    return [
      {
        path: inProject(cwd, part.path),
        ...(before === undefined ? {} : { before }),
        after: part.newText,
      },
    ];
  }),
  output: content
    .flatMap((part) =>
      part.type === 'content' && part.content.type === 'text' ? [part.content.text] : [],
    )
    .join('\n'),
});

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)];

const terminalIdsOf = (
  content: ReadonlyArray<ToolCallContent> | null | undefined,
): ReadonlyArray<string> =>
  content === undefined || content === null
    ? []
    : unique(content.flatMap((part) => (part.type === 'terminal' ? [part.terminalId] : [])));

/** Records any `terminal` content IDs attached to `stepId` onto the Turn fold. */
export const bindStepTerminals = (
  fold: TurnFold,
  stepId: StepId,
  content: ReadonlyArray<ToolCallContent> | null | undefined,
): TurnFold => {
  const attached = terminalIdsOf(content);
  if (attached.length === 0) return fold;
  const existing = fold.stepTerminals.get(stepId) ?? [];
  const merged = unique([...existing, ...attached]);
  if (merged.length === existing.length) return fold;
  return { ...fold, stepTerminals: new Map(fold.stepTerminals).set(stepId, merged) };
};

/** Marks a Step as having received streamed `StepDelta` output so later updates do not wipe it. */
export const markStepStreamed = (fold: TurnFold, stepId: StepId): TurnFold => {
  if (fold.streamedSteps.has(stepId)) return fold;
  const streamedSteps = new Set(fold.streamedSteps);
  streamedSteps.add(stepId);
  return { ...fold, streamedSteps };
};

/** Looks up the Step bound to `terminalId`, if any. */
export const stepIdForTerminal = (fold: TurnFold, terminalId: string): StepId | undefined => {
  for (const [stepId, ids] of fold.stepTerminals) {
    if (ids.includes(terminalId)) return stepId;
  }
  return undefined;
};

/** Applies an authoritative hosted terminal exit code to its bound Step, returning the updated Step when changed. */
export const applyTerminalExit = (
  fold: TurnFold,
  terminalId: string,
  exitCode: number | null,
): readonly [TurnFold, Step | undefined] => {
  if (exitCode === null) return [fold, undefined];
  const stepId = stepIdForTerminal(fold, terminalId);
  if (stepId === undefined) return [fold, undefined];
  for (const [toolCallId, step] of fold.steps) {
    if (step.id !== stepId) continue;
    if (step.exitCode === exitCode) return [fold, undefined];
    const updated: Step = { ...step, exitCode };
    return [{ ...fold, steps: new Map(fold.steps).set(toolCallId, updated) }, updated];
  }
  return [fold, undefined];
};

const stringArray = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;

const extractCwd = (rawInput: unknown): string | undefined => {
  if (!isRecord(rawInput)) return undefined;
  const cwd = rawInput['cwd'];
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined;
};

const extractInput = (rawInput: unknown, kind: StepKind): string | undefined => {
  if (rawInput === undefined || rawInput === null) return undefined;
  if (typeof rawInput === 'string') return rawInput === '' ? undefined : capInputHead(rawInput);
  if (isRecord(rawInput)) {
    if (Object.keys(rawInput).length === 0) return undefined;
    if (kind === 'execute') {
      const command = rawInput['command'];
      if (typeof command === 'string' && command !== '') {
        const args = stringArray(rawInput['args']);
        const text = args !== undefined && args.length > 0 ? [command, ...args].join(' ') : command;
        return capInputHead(text);
      }
      const cmd = rawInput['cmd'];
      if (typeof cmd === 'string' && cmd !== '') return capInputHead(cmd);
      const cmdParts = stringArray(cmd);
      if (cmdParts !== undefined && cmdParts.length > 0) return capInputHead(cmdParts.join(' '));
    }
    try {
      return capInputHead(JSON.stringify(rawInput, null, 2));
    } catch {
      return capInputHead(String(rawInput));
    }
  }
  try {
    return capInputHead(JSON.stringify(rawInput));
  } catch {
    return capInputHead(String(rawInput));
  }
};

const rawInputPath = (rawInput: Record<string, unknown>): string | undefined => {
  for (const key of ['file_path', 'path', 'file', 'target_file'] as const) {
    const value = rawInput[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
};

const MOVE_PATH_KEYS = [
  'old_path',
  'new_path',
  'oldPath',
  'newPath',
  'source',
  'destination',
  'from',
  'to',
] as const;

const rawInputFiles = (cwd: string, rawInput: unknown, kind: StepKind): ReadonlyArray<string> => {
  if (!isRecord(rawInput)) return [];
  const files: string[] = [];
  const primary = rawInputPath(rawInput);
  if (primary !== undefined) files.push(inProject(cwd, primary));
  if (kind === 'move') {
    for (const key of MOVE_PATH_KEYS) {
      const value = rawInput[key];
      if (typeof value === 'string' && value.trim() !== '') files.push(inProject(cwd, value));
    }
  }
  return unique(files);
};

const extractRawInputDiffs = (
  cwd: string,
  rawInput: unknown,
  fallbackPath: string | undefined,
): ReadonlyArray<Diff> => {
  if (!isRecord(rawInput)) return [];
  const target = rawInputPath(rawInput) ?? fallbackPath;
  if (target === undefined) return [];
  const filePath = inProject(cwd, target);
  const after =
    typeof rawInput['new_string'] === 'string'
      ? rawInput['new_string']
      : typeof rawInput['newText'] === 'string'
        ? rawInput['newText']
        : typeof rawInput['new_text'] === 'string'
          ? rawInput['new_text']
          : undefined;
  if (after !== undefined) {
    const before =
      typeof rawInput['old_string'] === 'string'
        ? rawInput['old_string']
        : typeof rawInput['oldText'] === 'string'
          ? rawInput['oldText']
          : typeof rawInput['old_text'] === 'string'
            ? rawInput['old_text']
            : undefined;
    return [{ path: filePath, ...(before === undefined ? {} : { before }), after }];
  }
  if (typeof rawInput['content'] === 'string') {
    return [{ path: filePath, after: rawInput['content'] }];
  }
  return [];
};

const extractExitCode = (rawOutput: unknown): number | undefined => {
  if (!isRecord(rawOutput)) return undefined;
  const nested = isRecord(rawOutput['exitStatus'])
    ? rawOutput['exitStatus']['exitCode']
    : undefined;
  for (const candidate of [
    rawOutput['exitCode'],
    rawOutput['exit_code'],
    rawOutput['code'],
    nested,
  ]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate;
  }
  return undefined;
};

const extractRawOutputText = (rawOutput: unknown): string | undefined => {
  if (rawOutput === undefined || rawOutput === null) return undefined;
  if (typeof rawOutput === 'string') return rawOutput === '' ? undefined : rawOutput;
  if (!isRecord(rawOutput)) return String(rawOutput);
  const stdout = typeof rawOutput['stdout'] === 'string' ? rawOutput['stdout'] : '';
  const stderr = typeof rawOutput['stderr'] === 'string' ? rawOutput['stderr'] : '';
  if (stdout !== '' || stderr !== '') {
    return [stdout, stderr].filter((part) => part !== '').join('\n');
  }
  for (const key of ['output', 'text', 'error', 'message'] as const) {
    const value = rawOutput[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  const rest = Object.fromEntries(
    Object.entries(rawOutput).filter(
      ([key]) =>
        key !== 'exitCode' && key !== 'exit_code' && key !== 'code' && key !== 'exitStatus',
    ),
  );
  if (Object.keys(rest).length === 0) return undefined;
  try {
    return JSON.stringify(rest, null, 2);
  } catch {
    return String(rawOutput);
  }
};

const combineOutput = (
  contentText: string,
  rawOutputText: string | undefined,
): string | undefined => {
  if (contentText !== '' && rawOutputText !== undefined) {
    if (rawOutputText === contentText || contentText.includes(rawOutputText)) return contentText;
    if (rawOutputText.includes(contentText)) return rawOutputText;
    return `${contentText}\n${rawOutputText}`;
  }
  return contentText !== '' ? contentText : rawOutputText;
};

type ToolCallFields = Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>;

/** Merges ACP tool call / update fields onto a base `Step`, stamping authoritative timestamps and capping payloads. */
const applyToolCallFields = (
  base: Step,
  update: ToolCallFields | ToolCallUpdate,
  cwd: string,
  now: number,
  options: { readonly hasBoundTerminal?: boolean; readonly streamed?: boolean } = {},
): Step => {
  const kind =
    update.kind === undefined || update.kind === null ? base.kind : stepKind(update.kind);
  const status =
    update.status === undefined || update.status === null ? base.status : stepStatus(update.status);
  const content =
    update.content === undefined || update.content === null
      ? { diffs: base.diffs, output: '' }
      : contentOf(cwd, update.content);
  const located =
    update.locations === undefined || update.locations === null || update.locations.length === 0
      ? base.files
      : unique([
          ...base.files,
          ...update.locations.map((location) => inProject(cwd, location.path)),
        ]);
  const rawInputFile = rawInputFiles(cwd, update.rawInput, kind);
  const rawInputDiffs =
    update.content !== undefined && update.content !== null && content.diffs.length > 0
      ? content.diffs
      : extractRawInputDiffs(cwd, update.rawInput, located[0]);
  const diffs =
    content.diffs.length > 0
      ? content.diffs
      : rawInputDiffs.length > 0
        ? rawInputDiffs
        : base.diffs;
  const hasBoundTerminal =
    options.hasBoundTerminal === true || terminalIdsOf(update.content).length > 0;
  const preserveStreamedOutput =
    options.streamed === true || (hasBoundTerminal && content.output === '');
  const rawOutputText = preserveStreamedOutput ? undefined : extractRawOutputText(update.rawOutput);
  const mergedOutput = preserveStreamedOutput
    ? undefined
    : combineOutput(content.output, rawOutputText);
  const cappedOutput =
    mergedOutput === undefined ? undefined : capOutputTail(mergedOutput, MAX_STEP_OUTPUT_BYTES);
  const nextCwd = extractCwd(update.rawInput) ?? base.cwd;
  const nextInput = extractInput(update.rawInput, kind) ?? base.input;
  const nextExitCode = hasBoundTerminal
    ? (base.exitCode ?? extractExitCode(update.rawOutput))
    : (extractExitCode(update.rawOutput) ?? base.exitCode);
  const startedAt =
    base.startedAt ?? (status === 'running' || isTerminalStepStatus(status) ? now : undefined);
  const endedAt = isTerminalStepStatus(status) ? (base.endedAt ?? now) : base.endedAt;
  const output = cappedOutput === undefined ? base.output : cappedOutput.text;
  const outputTruncated =
    cappedOutput === undefined ? base.outputTruncated : cappedOutput.truncated ? true : undefined;

  return {
    _tag: 'Step',
    id: base.id,
    turnId: base.turnId,
    title: update.title ?? base.title,
    kind,
    status,
    files: unique([...located, ...rawInputFile, ...diffs.map((diff) => diff.path)]),
    diffs,
    output,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(nextCwd === undefined ? {} : { cwd: nextCwd }),
    ...(nextInput === undefined ? {} : { input: nextInput }),
    ...(nextExitCode === undefined ? {} : { exitCode: nextExitCode }),
    ...(outputTruncated === undefined ? {} : { outputTruncated }),
  };
};

/**
 * A tool call or its update, merged into the Step with the same id: what the update leaves out is kept.
 * Captures timing, cwd, size-capped input, 32 KB rolling output tail, exitCode, and normalized diffs.
 */
const mergeStep = (
  fold: TurnFold,
  update: ToolCallFields,
  newId: () => string,
  now: number,
): readonly [TurnFold, ReadonlyArray<TranscriptItem>] => {
  const known = fold.steps.get(update.toolCallId);
  const base: Step = known ?? {
    _tag: 'Step',
    id: StepId.make(newId()),
    turnId: fold.turnId,
    title: '',
    kind: 'other',
    status: 'pending',
    files: [],
    diffs: [],
    output: '',
  };
  const bound = (fold.stepTerminals.get(base.id)?.length ?? 0) > 0;
  const step = applyToolCallFields(base, update, fold.cwd, now, {
    hasBoundTerminal: bound,
    streamed: fold.streamedSteps.has(base.id),
  });
  const boundFold = bindStepTerminals(fold, step.id, update.content);
  return [
    { ...closeText(boundFold), steps: new Map(boundFold.steps).set(update.toolCallId, step) },
    [step],
  ];
};

/** The Turn's Steps that had not finished, now cancelled: a Step never runs on after its Turn ended. */
export const cancelSteps = (fold: TurnFold, now = Date.now()): ReadonlyArray<Step> =>
  [...fold.steps.values()]
    .filter((step) => step.status === 'pending' || step.status === 'running')
    .map((step) => ({
      ...step,
      status: 'cancelled',
      startedAt: step.startedAt ?? now,
      endedAt: now,
    }));

const planEntryStatus = (status: 'pending' | 'in_progress' | 'completed'): PlanEntry['status'] =>
  status === 'in_progress' ? 'inProgress' : status;

const noticeSeverity = (severity: string): Notice['severity'] =>
  severity === 'warning' || severity === 'error' ? severity : 'info';

const compactionStatus = (status: CompactionStatus): Compaction['status'] => {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
    case 'cancelled':
      return status;
    default:
      return 'running';
  }
};

const textOfBlocks = (blocks: ReadonlyArray<ContentBlock>): string =>
  blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');

/** Compaction-related ACP session update variants. */
export type CompactionUpdate = Extract<
  SessionUpdate,
  { readonly sessionUpdate: 'compaction_update' | 'compaction_summary_chunk' }
>;

/** Applies one Compaction update onto a compaction map keyed by ACP compactionId. */
export const applyCompactionUpdate = (
  compactions: ReadonlyMap<string, Compaction>,
  update: CompactionUpdate,
  newId: () => string,
): readonly [ReadonlyMap<string, Compaction>, Compaction] => {
  const base: Compaction = compactions.get(update.compactionId) ?? {
    _tag: 'Compaction',
    id: CompactionId.make(newId()),
    status: 'running',
    summary: '',
  };
  const compaction: Compaction =
    update.sessionUpdate === 'compaction_update'
      ? {
          ...base,
          status: compactionStatus(update.status),
          summary:
            update.summary === undefined || update.summary === null
              ? base.summary
              : textOfBlocks(update.summary),
        }
      : {
          ...base,
          summary: base.summary + textOfBlocks([update.content]),
        };
  return [new Map(compactions).set(update.compactionId, compaction), compaction];
};

/** A Compaction update merged into the whole item with the same id. */
const mergeCompaction = (
  fold: TurnFold,
  update: CompactionUpdate,
  newId: () => string,
): readonly [TurnFold, ReadonlyArray<TranscriptItem>] => {
  const [compactions, compaction] = applyCompactionUpdate(fold.compactions, update, newId);
  return [{ ...fold, compactions }, [compaction]];
};

/**
 * Folds one `session/update` into the Turn: the items it adds to the Transcript, and what the Turn has open after it.
 * A Thought interrupts the Message (and the other way round), and so does a Step, so text after it starts a new item.
 * `user_message_chunk` (the Agent's echo of what we sent) and what the thread does not show are dropped.
 */
export const foldUpdate = (
  fold: TurnFold,
  update: SessionUpdate,
  newId: () => string,
  now = Date.now(),
): readonly [TurnFold, ReadonlyArray<TranscriptItem>] => {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      if (update.content.type === 'image') {
        const id = MessageId.make(newId());
        return [
          { ...closeText(fold), message: id },
          [
            {
              _tag: 'Message',
              id,
              turnId: fold.turnId,
              role: 'agent',
              parts: [
                { _tag: 'image', mimeType: update.content.mimeType, data: update.content.data },
              ],
            },
          ],
        ];
      }
      if (update.content.type !== 'text') return [fold, []];
      const { text } = update.content;
      if (fold.message !== undefined) {
        return [fold, [{ _tag: 'MessageDelta', id: fold.message, text }]];
      }
      const id = MessageId.make(newId());
      return [
        { ...closeText(fold), message: id },
        [
          {
            _tag: 'Message',
            id,
            turnId: fold.turnId,
            role: 'agent',
            parts: [{ _tag: 'text', text }],
          },
        ],
      ];
    }
    case 'agent_thought_chunk': {
      if (update.content.type !== 'text') return [fold, []];
      const { text } = update.content;
      if (fold.thought !== undefined) {
        return [fold, [{ _tag: 'ThoughtDelta', id: fold.thought, text }]];
      }
      const id = ThoughtId.make(newId());
      return [
        { ...closeText(fold), thought: id },
        [{ _tag: 'Thought', id, turnId: fold.turnId, text }],
      ];
    }
    case 'tool_call':
    case 'tool_call_update':
      return mergeStep(fold, update, newId, now);
    case 'plan':
      return [
        fold,
        [
          {
            _tag: 'Plan',
            entries: update.entries.map((entry) => ({
              content: entry.content,
              priority: entry.priority,
              status: planEntryStatus(entry.status),
            })),
          },
        ],
      ];
    case 'notice':
      return [
        fold,
        [
          {
            _tag: 'Notice',
            severity: noticeSeverity(update.severity),
            title: update.title,
            ...(update.description === undefined || update.description === null
              ? {}
              : { description: update.description }),
          },
        ],
      ];
    case 'compaction_update':
    case 'compaction_summary_chunk':
      return mergeCompaction(fold, update, newId);
    // The echo of what we sent, and what the thread does not show (or other domains fold).
    case 'user_message_chunk':
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'usage_update':
    case 'subagent_update':
    case 'plan_update':
    case 'plan_removed':
    case 'session_message':
    case 'session_message_chunk':
      return [fold, []];
  }
};

/** The outcome of a Turn the Agent ended with `stopReason`. */
export const outcomeOf = (stopReason: StopReason): TurnOutcome => {
  switch (stopReason) {
    case 'end_turn':
      return { _tag: 'done' };
    case 'cancelled':
      return { _tag: 'cancelled' };
    case 'refusal':
      return { _tag: 'refused' };
    case 'max_tokens':
      return { _tag: 'cutShort', limit: 'maxTokens' };
    case 'max_turn_requests':
      return { _tag: 'cutShort', limit: 'maxTurnRequests' };
  }
};

/** The outcome of a Turn whose prompt failed. */
export const failedOutcome = (error: AcpError): TurnOutcome => {
  switch (error.reason) {
    case 'Exited':
      return { _tag: 'failed', reason: 'agentStopped', detail: error.detail };
    case 'AuthRequired':
      return { _tag: 'failed', reason: 'needsLogin', detail: error.detail };
    case 'ProtocolVersion':
    case 'Unsupported':
    case 'Refused':
      return { _tag: 'failed', reason: 'agentError', detail: error.detail };
  }
};

/** How a `session/prompt` ended, as a Turn outcome: its stop reason, or why it failed. */
export const promptOutcome = (result: Exit.Exit<PromptResponse, AcpError>): TurnOutcome =>
  Exit.isSuccess(result)
    ? outcomeOf(result.value.stopReason)
    : Option.match(Cause.findErrorOption(result.cause), {
        onSome: failedOutcome,
        onNone: () => ({
          _tag: 'failed' as const,
          reason: 'agentError' as const,
          detail: Cause.pretty(result.cause),
        }),
      });

/** The Step a Permission request asks about, from the tool call it carries, when the Turn has not seen it yet. */
export const stepOfToolCall = (
  toolCall: ToolCallUpdate,
  turnId: TurnId,
  id: StepId,
  cwd = '',
  now = Date.now(),
): Step =>
  applyToolCallFields(
    {
      _tag: 'Step',
      id,
      turnId,
      title: '',
      kind: 'other',
      status: 'pending',
      files: [],
      diffs: [],
      output: '',
    },
    toolCall,
    cwd,
    now,
  );

/** Enriches an already-seen `Step` with fields carried by a `session/request_permission` tool call. */
export const mergeToolCallStep = (
  base: Step,
  toolCall: ToolCallUpdate,
  cwd = '',
  now = Date.now(),
): Step => applyToolCallFields(base, toolCall, cwd, now);

const optionKindOf = (kind: PermissionOptionKind): PermissionOption['kind'] => {
  switch (kind) {
    case 'allow_once':
      return 'allowOnce';
    case 'allow_always':
      return 'allowAlways';
    case 'reject_once':
      return 'rejectOnce';
    case 'reject_always':
      return 'rejectAlways';
  }
};

/** A `session/request_permission` as a pending Permission request about the Step `stepId`; options in the Agent's order. */
export const toPermissionRequest = (
  request: RequestPermissionRequest,
  ids: { readonly id: PermissionRequestId; readonly turnId: TurnId; readonly stepId: StepId },
): PermissionRequest => ({
  _tag: 'PermissionRequest',
  ...ids,
  options: request.options.map((option) => ({
    id: option.optionId,
    label: option.name,
    kind: optionKindOf(option.kind),
  })),
  state: { _tag: 'pending' },
});

/** The ACP answer for the option picked. */
export const selectedOutcome = (optionId: string): RequestPermissionOutcome => ({
  outcome: 'selected',
  optionId,
});

/** The ACP answer for a request nobody will answer: the Turn was cancelled or ended. */
export const cancelledOutcome: RequestPermissionOutcome = { outcome: 'cancelled' };

const toBlock = (part: MessagePart): ContentBlock => {
  switch (part._tag) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image':
      return { type: 'image', mimeType: part.mimeType, data: part.data };
    case 'audio':
      return { type: 'audio', mimeType: part.mimeType, data: part.data };
    case 'link':
      return {
        type: 'resource_link',
        uri: part.uri,
        name: part.name,
        ...(part.title === undefined ? {} : { title: part.title }),
        ...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }),
        ...(part.size === undefined ? {} : { size: part.size }),
      };
    case 'resource': {
      const mimeType = part.mimeType === undefined ? {} : { mimeType: part.mimeType };
      return {
        type: 'resource',
        resource:
          part.contents._tag === 'text'
            ? { uri: part.uri, ...mimeType, text: part.contents.text }
            : { uri: part.uri, ...mimeType, blob: part.contents.blob },
      };
    }
  }
};

/** A user Message's parts as an ACP prompt, in order. */
export const toAcpPrompt = (parts: ReadonlyArray<MessagePart>): Array<ContentBlock> =>
  parts.map(toBlock);

/**
 * Maps an ACP `usage_update` payload into a Spence `ContextUsage` reading (spec 2.3).
 * Invalid `used` returns `undefined` so a prior/historical reading is never overwritten with fabricated values;
 * missing/non-positive/non-finite `size` yields `countOnly` (`capacity` unknown).
 */
export const toContextUsage = (update: {
  readonly used?: unknown;
  readonly size?: unknown;
}): Extract<ContextUsage, { readonly _tag: 'reported' | 'countOnly' }> | undefined => {
  if (typeof update.used !== 'number' || !Number.isFinite(update.used) || update.used < 0) {
    return undefined;
  }
  if (typeof update.size === 'number' && Number.isFinite(update.size) && update.size > 0) {
    return { _tag: 'reported', used: update.used, capacity: update.size };
  }
  return { _tag: 'countOnly', used: update.used };
};
