/**
 * The cross-device parity matrix: every capability a regular chat has on the Local device, and what it is on a
 * Remote device. The Local capability list is read from the code (`localCapabilities`), never written by hand, so a
 * new RPC, Spence tool, Transcript item, Message part or action kind without a row here fails `parity.spec.ts`.
 *
 * A row is one of:
 * - `Same`: a Remote device offers it unchanged; its case runs once Local and once Remote, with the same outcome and
 *   Transcript apart from Provenance.
 * - `Counterpart`: a Remote device reaches it through other calls (an image's bytes through `Assets.read`); its case
 *   still runs both ways and must agree.
 * - `LocalOnly`: decided to belong to the viewing Device (UI preferences, the native folder picker, Tabs, Devices);
 *   a Paired device is never served it.
 * - `Gap`: a known difference not fixed yet; listed so it is a decision, not an accident.
 * - `Transport`: the protocol under every Remote call, not something a chat does.
 *
 * The same cases run with a real Agent in the opt-in live probes (`parity.live.spec.ts`), whose results go in the
 * per-Agent qualification records (`docs/qualification/cross-device-<agent>.md`).
 */
import { Effect, Fiber, Stream } from 'effect';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ActionKind, MessagePart, TranscriptItem } from '../../src/shared/sessions/sessions.rpc';
import { DesktopRpcs } from '../../src/shared/rpc/desktop-rpcs';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { SPENCE_TOOL_NAMES } from '../sessions/delegation-server';
import {
  agentReplies,
  kinds,
  liveWhen,
  newSession,
  nextPermission,
  outcomes,
  type ParityCase,
  type ParitySide,
  prompt,
  settle,
  text,
  transcript,
} from './parity-device';

/** One capability a regular chat has: an RPC the window calls, a Spence tool, a Transcript item, part or action. */
export type Capability =
  | `rpc:${string}`
  | `tool:${string}`
  | `transcript:${string}`
  | `part:${string}`
  | `action:${string}`;

export type Parity =
  | { readonly _tag: 'Same' }
  | {
      readonly _tag: 'Counterpart';
      /** How a Remote device reaches it instead. */
      readonly remote: ReadonlyArray<Capability>;
      readonly why: string;
    }
  | { readonly _tag: 'LocalOnly'; readonly why: string }
  | { readonly _tag: 'Gap'; readonly why: string }
  /** Not a chat capability: the protocol a Remote device speaks under every call. */
  | { readonly _tag: 'Transport'; readonly why: string };

export interface ParityRow {
  readonly id: string;
  /** What the row checks, as a test title. */
  readonly title: string;
  readonly covers: ReadonlyArray<Capability>;
  readonly parity: Parity;
  /** Run once Local and once Remote: required for `Same` and `Counterpart` rows, and only for them. */
  readonly case?: ParityCase;
}

const tagOf = (member: unknown): string => {
  const literal = (
    member as {
      readonly fields: { readonly _tag: { readonly ast: { readonly literal: unknown } } };
    }
  ).fields._tag.ast.literal;
  return String(literal);
};

/**
 * Everything a regular chat offers on the Local device, read from the contracts: every call the window makes, every
 * tool Spence gives an Agent, every kind of Transcript item and Message part, and every kind of action.
 */
export const localCapabilities = (): ReadonlyArray<Capability> => [
  ...[...DesktopRpcs.requests.keys()].map((tag): Capability => `rpc:${tag}`),
  ...SPENCE_TOOL_NAMES.map((name): Capability => `tool:${name}`),
  ...TranscriptItem.members.map((member): Capability => `transcript:${tagOf(member)}`),
  ...MessagePart.members.map((member): Capability => `part:${tagOf(member)}`),
  ...ActionKind.literals.map((kind): Capability => `action:${kind}`),
];

const messageText = (message: { readonly parts: ReadonlyArray<MessagePart> }): string =>
  message.parts.flatMap((part) => (part._tag === 'text' ? [part.text] : [])).join('');

const rpc = (...tags: ReadonlyArray<string>): ReadonlyArray<Capability> =>
  tags.map((tag): Capability => `rpc:${tag}`);

/** The Session's live state when the case ends, without what moves on its own (Context usage, timings). */
const settledLive = (side: ParitySide, sessionId: Parameters<typeof liveWhen>[1]) =>
  Effect.map(
    liveWhen(side, sessionId, (state) => state.runningTurn === undefined),
    ({ contextUsage: _usage, cancelGrace: _grace, ...state }) => state,
  );

// Cases.

const chatTurn: ParityCase = Effect.fnUntraced(function* (side) {
  const { projectId, sessionId } = yield* newSession(side);
  yield* prompt(side, sessionId, (script) => script.reply('hello there'));
  const items = yield* transcript(side, sessionId, 1);
  const listed = yield* side.call((api) => api['Session.list']({ projectId }));
  return {
    outcome: {
      replies: agentReplies(items),
      outcomes: outcomes(items),
      listed: listed.map((session) => session.title),
    },
    transcript: { items, live: yield* settledLive(side, sessionId) },
  };
});

const agentWork: ParityCase = Effect.fnUntraced(function* (side) {
  const { sessionId } = yield* newSession(side);
  const changes = yield* Effect.forkChild(
    side.call((api) =>
      api['Session.changes']().pipe(
        Stream.filter((change) => change.sessionId === sessionId),
        Stream.map((change) => change.state.runningTurn !== undefined),
        Stream.takeUntil((running) => !running),
        Stream.runCollect,
      ),
    ),
  );
  yield* prompt(side, sessionId, (script) => script.work);
  const items = yield* transcript(side, sessionId, 1);
  const seen = yield* Fiber.join(changes);
  return {
    outcome: { kinds: [...new Set(kinds(items))].sort(), outcomes: outcomes(items) },
    transcript: { items, sawRunningThenSettled: seen.includes(true) && seen.at(-1) === false },
  };
});

const permissions: ParityCase = Effect.fnUntraced(function* (side) {
  const { sessionId } = yield* newSession(side);
  yield* side.call((api) =>
    api['Session.setOption']({ sessionId, option: 'permissionMode', value: 'ask' }),
  );
  const answers: Array<unknown> = [];
  const seen = new Set<string>();
  let turns = 0;
  for (const kind of ['allowOnce', 'allowAlways', 'rejectOnce'] as const) {
    yield* prompt(side, sessionId, (script) => script.permission);
    const request = yield* nextPermission(side, sessionId, seen);
    seen.add(request.id);
    const attention = (yield* liveWhen(side, sessionId, (state) => state.attention !== undefined))
      .attention;
    const option = request.options.find((candidate) => candidate.kind === kind);
    if (option === undefined) return yield* Effect.die(`no ${kind} option`);
    yield* side.call((api) =>
      api['Session.answerPermission']({ sessionId, requestId: request.id, optionId: option.id }),
    );
    turns += 1;
    yield* transcript(side, sessionId, turns);
    answers.push({ kind, attention });
  }
  const items = yield* transcript(side, sessionId, 3);
  return {
    outcome: {
      answers,
      outcomes: outcomes(items),
      states: items.flatMap((item) =>
        item._tag === 'PermissionRequest' && item.state._tag === 'answered' ? [item.state.by] : [],
      ),
    },
    transcript: { items, live: yield* settledLive(side, sessionId) },
  };
});

/** Waits until the scripted Agent has emitted its first chunk and armed its cancel/steer waiters. */
const waitForAgentChunk = (side: ParitySide, sessionId: Parameters<typeof liveWhen>[1]) =>
  side.call((api) =>
    api['Session.events']({ sessionId }).pipe(
      Stream.filter(
        (item) =>
          item._tag === 'Transcript' &&
          item.event.item._tag === 'Message' &&
          item.event.item.role === 'agent',
      ),
      Stream.runHead,
    ),
  );

const cancelTurn: ParityCase = Effect.fnUntraced(function* (side) {
  const { sessionId } = yield* newSession(side);
  yield* prompt(side, sessionId, (script) => script.hold);
  yield* liveWhen(side, sessionId, (state) => state.runningTurn !== undefined);
  if (side.script.hold !== undefined) yield* waitForAgentChunk(side, sessionId);
  yield* side.call((api) => api['Session.cancel']({ sessionId }));
  const items = yield* transcript(side, sessionId, 1);
  return { outcome: { outcomes: outcomes(items) }, transcript: { items } };
});

const queueAndSteer: ParityCase = Effect.fnUntraced(function* (side) {
  const { sessionId } = yield* newSession(side);
  yield* prompt(side, sessionId, (script) => script.steerable);
  yield* liveWhen(side, sessionId, (state) => state.runningTurn !== undefined);
  if (side.script.steerable !== undefined) yield* waitForAgentChunk(side, sessionId);
  for (const value of ['first in line', 'second in line'])
    yield* side.call((api) =>
      api['Session.enqueue']({
        sessionId,
        parts: text(side.script.reply(value) ?? value),
      }),
    );
  const queued = (yield* liveWhen(side, sessionId, (state) => state.queue.length === 2)).queue;
  yield* side.call((api) => api['Session.setQueue']({ sessionId, queue: queued.slice(1) }));
  const reordered = (yield* liveWhen(side, sessionId, (state) => state.queue.length === 1)).queue;
  yield* side.call((api) =>
    api['Session.steer']({ sessionId, parts: text('Greet in Spanish instead.') }),
  );
  const items = yield* transcript(side, sessionId, 2);
  yield* side.call((api) => api['Session.clearQueue']({ sessionId }));
  const cleared = (yield* liveWhen(side, sessionId)).queue;
  // The steer and the Agent's answer to it race each other into the Transcript: compared as a set.
  const said = items
    .flatMap((item) =>
      item._tag === 'Message'
        ? [`${item.role}${item.steer === true ? ' (steer)' : ''}: ${messageText(item)}`]
        : [],
    )
    .sort();
  return {
    outcome: {
      queued: queued.length,
      kept: reordered.length,
      cleared: cleared.length,
      outcomes: outcomes(items),
    },
    transcript: { said },
  };
});

const composer: ParityCase = Effect.fnUntraced(function* (side) {
  const { sessionId } = yield* newSession(side);
  const empty = yield* side.call((api) => api['Session.getComposer']({ sessionId }));
  const draft = {
    text: 'Half a thought',
    images: [{ name: 'dot.png', mimeType: 'image/png', data: ONE_PIXEL_PNG }],
  };
  yield* side.call((api) => api['Session.setComposer']({ sessionId, draft }));
  const kept = yield* side.call((api) => api['Session.getComposer']({ sessionId }));
  return { outcome: { empty, kept } };
});

const sessionOptions: ParityCase = Effect.fnUntraced(function* (side) {
  const { sessionId } = yield* newSession(side);
  const agentId = (yield* liveWhen(side, sessionId, (state) => state.agentId !== undefined))
    .agentId;
  if (agentId === undefined) return yield* Effect.die('no Agent');
  const setAgent = yield* settle(
    side.call((api) => api['Session.setAgent']({ sessionId, agentId: AgentId.make(agentId) })),
  );
  const before = yield* liveWhen(side, sessionId, (state) => state.agentStatus === 'ready');
  const model = before.options.model?.choices.at(-1)?.id;
  const changes = [
    ...(model === undefined ? [] : [{ option: 'model', value: model }]),
    { option: 'effort', value: 'high' },
    { option: 'permissionMode', value: 'ask' },
  ] as const;
  const applied = yield* Effect.forEach(changes, (change) =>
    settle(
      side.call((api) =>
        api['Session.setOption']({ sessionId, ...change } as Parameters<
          (typeof api)['Session.setOption']
        >[0]),
      ),
    ),
  );
  const after = yield* liveWhen(side, sessionId, (state) => state.options.permissionMode === 'ask');
  return { outcome: { setAgent, applied, before: before.options, after: after.options } };
});

const sessionLifecycle: ParityCase = Effect.fnUntraced(function* (side) {
  const { projectId, sessionId } = yield* newSession(side);
  yield* prompt(side, sessionId, (script) => script.reply('keep me'));
  yield* transcript(side, sessionId, 1);
  const list = side.call((api) => api['Session.list']({ projectId }));
  yield* side.call((api) => api['Session.rename']({ sessionId, title: 'Renamed here' }));
  const renamed = yield* list;
  yield* side.call((api) => api['Session.archive']({ sessionId }));
  const archived = yield* list;
  yield* side.call((api) => api['Session.unarchive']({ sessionId }));
  const unarchived = yield* list;
  const workers = yield* side.call((api) => api['Session.countWorkers']({ sessionId }));
  yield* side.call((api) => api['Session.delete']({ sessionId }));
  const deleted = yield* list;
  const summary = (sessions: typeof renamed) =>
    sessions.map((session) => ({
      title: session.title,
      archived: session.archivedAt !== undefined,
    }));
  return {
    outcome: {
      renamed: summary(renamed),
      archived: summary(archived),
      unarchived: summary(unarchived),
      workers,
      deleted: summary(deleted),
    },
  };
});

const agentContext: ParityCase = Effect.fnUntraced(function* (side) {
  const { sessionId } = yield* newSession(side);
  yield* prompt(side, sessionId, (script) => script.reply('remember this'));
  yield* transcript(side, sessionId, 1);
  const compacted = yield* settle(side.call((api) => api['Session.compact']({ sessionId })));
  yield* liveWhen(side, sessionId, (state) => state.compacting !== true);
  const cleared = yield* settle(side.call((api) => api['Session.clearContext']({ sessionId })));
  const emptied = yield* settle(
    side.call((api) => api['Session.startEmptyContext']({ sessionId })),
  );
  const stopped = yield* settle(side.call((api) => api['Session.stopAgent']({ sessionId })));
  const retried = yield* settle(side.call((api) => api['Session.retryAgent']({ sessionId })));
  yield* liveWhen(side, sessionId, (state) => state.agentStatus === 'ready');
  yield* prompt(side, sessionId, (script) => script.reply('fresh start'));
  const items = yield* transcript(side, sessionId, 2);
  return {
    outcome: {
      compacted,
      cleared,
      emptied,
      stopped,
      retried,
      kinds: kinds(items).filter((kind) => kind === 'Compaction' || kind === 'ContextCleared'),
      replies: agentReplies(items),
    },
    transcript: { items },
  };
});

const sessionTools: ParityCase = Effect.fnUntraced(function* (side) {
  const parent = yield* newSession(side);
  yield* prompt(side, parent.sessionId, (script) =>
    script.tool('delegate', { task: side.script.reply('worker result') ?? 'worker result' }),
  );
  const delegated = yield* transcript(side, parent.sessionId, 1);
  yield* prompt(side, parent.sessionId, (script) => script.tool('list_sessions', {}));
  const listedItems = yield* transcript(side, parent.sessionId, 2);
  const listed = JSON.parse(agentReplies(listedItems).at(-1) ?? '{}') as {
    readonly sessions?: ReadonlyArray<{ readonly id: string }>;
  };
  const worker = listed.sessions?.[0]?.id ?? '';
  yield* prompt(side, parent.sessionId, (script) =>
    script.tool('send_message', { to: worker, text: side.script.reply('ping') ?? 'ping' }),
  );
  const items = yield* transcript(side, parent.sessionId, 3);
  // Another Project of the same Device: the first contact is asked for, and leaves a Notice.
  const other = yield* newSession(side);
  yield* prompt(side, other.sessionId, (script) => script.reply('other project'));
  yield* transcript(side, other.sessionId, 1);
  yield* side.call((api) =>
    api['Session.setOption']({
      sessionId: parent.sessionId,
      option: 'permissionMode',
      value: 'ask',
    }),
  );
  yield* prompt(side, parent.sessionId, (script) =>
    script.tool('send_message', { to: other.sessionId, text: 'echo:across Projects' }),
  );
  const ask = yield* nextPermission(side, parent.sessionId);
  const allow = ask.options.find((option) => option.kind === 'allowOnce');
  yield* side.call((api) =>
    api['Session.answerPermission']({
      sessionId: parent.sessionId,
      requestId: ask.id,
      optionId: allow?.id ?? '',
    }),
  );
  const across = yield* transcript(side, parent.sessionId, 4);
  return {
    outcome: {
      delegated: agentReplies(delegated),
      replies: agentReplies(items).slice(1),
      across: kinds(across).filter((kind) => kind === 'Notice'),
    },
    transcript: { items: across },
  };
});

const summaryHandoff: ParityCase = Effect.fnUntraced(function* (side) {
  const { sessionId } = yield* newSession(side);
  yield* prompt(side, sessionId, (script) => script.reply('Build the login page'));
  yield* transcript(side, sessionId, 1);
  const agentId = (yield* liveWhen(side, sessionId, (state) => state.agentId !== undefined))
    .agentId;
  if (agentId === undefined) return yield* Effect.die('no Agent');
  const target = AgentId.make(agentId);
  const prepared = yield* side.call((api) =>
    api['Session.prepareHandoff']({ sessionId, kind: 'fork', targetAgentId: target }),
  );
  const revalidated = yield* side.call((api) =>
    api['Session.revalidateHandoff']({
      sessionId,
      endpoint: prepared.endpoint,
      targetAgentId: target,
      summary: prepared.summary,
      selectedImageIds: [],
    }),
  );
  const executed = yield* side.call((api) =>
    api['Session.executeHandoff']({
      sessionId,
      kind: 'fork',
      endpoint: revalidated.currentEndpoint,
      targetAgentId: target,
      summary: prepared.summary,
      selectedImageIds: [],
    }),
  );
  const attempts = yield* side.call((api) => api['Session.listHandoffAttempts']({ sessionId }));
  const fork = executed._tag === 'committed' ? executed.forkSessionId : undefined;
  const forked = fork === undefined ? [] : yield* transcript(side, fork, 1);
  return {
    outcome: {
      draftSource: prepared.draftSource,
      endpointAdvanced: revalidated.endpointAdvanced,
      executed: executed._tag,
      attempts: attempts.length,
      forked: kinds(forked),
    },
    transcript: { forked },
  };
});

const imagesAndAssets: ParityCase = Effect.fnUntraced(function* (side) {
  const { sessionId } = yield* newSession(side);
  const sent = yield* settle(
    side.call((api) =>
      api['Session.prompt']({
        sessionId,
        parts: [
          ...text(side.script.reply('a picture') ?? 'a picture'),
          { _tag: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG },
          { _tag: 'link', uri: 'file:///README.md', name: 'README.md' },
          {
            _tag: 'resource',
            uri: 'file:///notes.txt',
            mimeType: 'text/plain',
            contents: { _tag: 'text', text: 'notes' },
          },
          { _tag: 'audio', mimeType: 'audio/wav', data: 'UklGRg==' },
        ],
      }),
    ),
  );
  const sentTurns = 'ok' in sent ? 1 : 0;
  if (sentTurns > 0) yield* transcript(side, sessionId, sentTurns);
  yield* prompt(side, sessionId, (script) => script.image);
  const items = yield* transcript(side, sessionId, sentTurns + 1);
  return {
    outcome: {
      sent: 'ok' in sent ? 'ok' : sent.failed,
      parts: items.flatMap((item) =>
        item._tag === 'Message' ? item.parts.map((part) => `${item.role}:${part._tag}`) : [],
      ),
    },
    transcript: { items },
  };
});

const commands: ParityCase = Effect.fnUntraced(function* (side) {
  const { sessionId } = yield* newSession(side);
  const live = yield* liveWhen(side, sessionId, (state) => state.commandsLoaded);
  return { outcome: { commands: live.commands } };
});

const files: ParityCase = Effect.fnUntraced(function* (side) {
  const { sessionId } = yield* newSession(side);
  const listing = yield* side.call((api) => api['Files.list']({ sessionId, path: '' }));
  const read = yield* side.call((api) => api['Files.read']({ sessionId, path: 'README.md' }));
  const missing = yield* settle(
    side.call((api) => api['Files.read']({ sessionId, path: 'nowhere.md' })),
  );
  return { outcome: { listing, read, missing } };
});

const projects: ParityCase = Effect.fnUntraced(function* (side) {
  const first = yield* side.folder();
  const moved = yield* side.folder();
  const browsed = yield* side.call((api) =>
    api['Folders.browse']({ path: path.dirname(first), hidden: false }),
  );
  const added = yield* side.call((api) => api['Projects.addFolder']({ path: first }));
  const renamed = yield* side.call((api) =>
    api['Projects.rename']({ id: added.id, name: 'Parity' }),
  );
  const configured = yield* side.call((api) =>
    api['Projects.setSettings']({ id: added.id, patch: { defaultPermissionMode: 'ask' } }),
  );
  const checked = yield* side.call((api) => api['Projects.check']({ id: added.id }));
  const located = yield* side.call((api) =>
    api['Projects.locateFolder']({ id: added.id, path: moved }),
  );
  const listed = yield* side.call((api) => api['Projects.list']());
  yield* side.call((api) => api['Projects.remove']({ id: added.id }));
  const remaining = yield* side.call((api) => api['Projects.list']());
  return {
    outcome: {
      browsed: browsed.entries.some((entry) => entry.path === first),
      added: added.name === path.basename(first),
      renamed: renamed.name,
      configured: configured.settings,
      checked: checked.folderMissing,
      located: located.path === moved,
      listed: listed.map((project) => project.name),
      remaining: remaining.map((project) => project.name),
    },
  };
});

const executionSettings: ParityCase = Effect.fnUntraced(function* (side) {
  const before = yield* side.call((api) => api['ExecutionSettings.get']());
  const after = yield* side.call((api) =>
    api['ExecutionSettings.update']({ patch: { defaultPermissionMode: 'ask' } }),
  );
  return { outcome: { before, after } };
});

const agentsSetup: ParityCase = Effect.fnUntraced(function* (side) {
  const listed = yield* side.call((api) => api['Agents.list']());
  const commandsOf = yield* Effect.forEach(listed, (agent) =>
    side.call((api) => api['Agents.installCommand']({ agentId: agent.id })),
  );
  // A native Agent that is not on PATH: the install says how, and runs nothing.
  const native = listed.find((agent) => agent.installKind === 'native');
  const installed =
    native === undefined
      ? []
      : yield* side.call((api) =>
          api['Agents.install']({ agentId: native.id }).pipe(Stream.runCollect),
        );
  return {
    outcome: {
      listed: listed.map((agent) => ({ id: agent.id, installed: agent.installed })),
      commands: commandsOf,
      installed,
    },
  };
});

const sourceControl: ParityCase = Effect.fnUntraced(function* (side) {
  const { sessionId, folder } = yield* newSession(side, { git: true });
  yield* Effect.promise(() => writeFile(path.join(folder, 'README.md'), '# Parity\n\nEdited.\n'));
  yield* Effect.promise(() => writeFile(path.join(folder, 'new.txt'), 'new\n'));
  const call = <A, E>(
    use: (api: Parameters<Parameters<ParitySide['call']>[0]>[0]) => Effect.Effect<A, E>,
  ) => settle(side.call(use));
  const changes = yield* call((api) => api['SourceControl.changes']({ sessionId }));
  const diff = yield* call((api) =>
    api['SourceControl.diff']({ sessionId, path: 'README.md', scope: 'combined' }),
  );
  const committed = yield* call((api) =>
    api['SourceControl.commit']({
      sessionId,
      message: 'Edit the README',
      files: [{ path: 'README.md' }],
      push: false,
    }),
  );
  const commits = yield* side.call((api) =>
    api['SourceControl.commits']({ sessionId, limit: 10, offset: 0 }),
  );
  const head = commits._tag === 'History' ? commits.commits[0]?.sha : undefined;
  const commitDetail =
    head === undefined
      ? 'no commit'
      : yield* call((api) => api['SourceControl.commitDetail']({ sessionId, sha: head }));
  const commitDiff =
    head === undefined
      ? 'no commit'
      : yield* call((api) =>
          api['SourceControl.commitDiff']({ sessionId, sha: head, path: 'README.md' }),
        );
  const reverted =
    head === undefined
      ? 'no commit'
      : yield* call((api) => api['SourceControl.revert']({ sessionId, sha: head }));
  const prepared = yield* side.call((api) =>
    api['SourceControl.prepareDiscard']({ sessionId, files: [{ path: 'new.txt' }] }),
  );
  const discarded =
    prepared._tag === 'Ready'
      ? yield* call((api) =>
          api['SourceControl.discard']({
            sessionId,
            files: [{ path: 'new.txt' }],
            token: prepared.token,
          }),
        )
      : prepared._tag;
  const branches = yield* call((api) => api['SourceControl.branches']({ sessionId }));
  const fetched = yield* call((api) => api['SourceControl.fetch']({ sessionId }));
  const pulled = yield* call((api) => api['SourceControl.pull']({ sessionId }));
  const pushed = yield* call((api) => api['SourceControl.push']({ sessionId }));
  return {
    outcome: {
      changes,
      diff,
      committed,
      commits,
      commitDetail,
      commitDiff,
      reverted,
      prepared: prepared._tag,
      discarded,
      branches,
      fetched,
      pulled,
      pushed,
    },
  };
});

const worktrees: ParityCase = Effect.fnUntraced(function* (side) {
  const { sessionId } = yield* newSession(side, { git: true });
  const before = yield* settle(side.call((api) => api['Worktrees.list']({ sessionId })));
  const prepared = yield* settle(
    side.call((api) => api['Worktrees.prepareDraft']({ sessionId, branch: 'parity/draft' })),
  );
  const streamed = yield* settle(
    side.call((api) =>
      api['Worktrees.prepareDraftStream']({
        sessionId,
        branch: 'parity/stream',
        setupCommand: null,
      }).pipe(Stream.runCollect),
    ),
  );
  const after = yield* settle(side.call((api) => api['Worktrees.list']({ sessionId })));
  return { outcome: { before, prepared, streamed, after } };
});

/** What `list_targets` answers, as far as a case reads it. */
interface ListedTargets {
  readonly devices: ReadonlyArray<{
    readonly online: boolean;
    readonly projects?: ReadonlyArray<{
      readonly handle: string;
      readonly name: string;
      readonly sessions: ReadonlyArray<{ readonly handle: string; readonly title: string }>;
    }>;
  }>;
}

/** Has the Session's Agent call a Spence tool in its `turn`-th Turn, and returns what the tool answered. */
const callTool = Effect.fnUntraced(function* (
  side: ParitySide,
  sessionId: Parameters<typeof transcript>[1],
  turn: number,
  tool: string,
  args: Readonly<Record<string, unknown>>,
) {
  yield* prompt(side, sessionId, (script) => script.tool(tool, args));
  const items = yield* transcript(side, sessionId, turn);
  return JSON.parse(agentReplies(items).at(-1) ?? 'null') as Record<string, unknown>;
});

const crossDeviceTools: ParityCase = Effect.fnUntraced(function* (side) {
  // A Session on the other Device to reach, and one to send from on this one.
  const target = yield* newSession(side.away);
  yield* prompt(side.away, target.sessionId, (script) => script.reply('ready'));
  yield* transcript(side.away, target.sessionId, 1);
  yield* side.away.call((api) =>
    api['ExecutionSettings.update']({ patch: { defaultPermissionMode: 'ask' } }),
  );
  const sender = yield* newSession(side);
  yield* prompt(side, sender.sessionId, (script) => script.reply('ready'));
  yield* transcript(side, sender.sessionId, 1);
  let turn = 1;
  const tool = (name: string, args: Readonly<Record<string, unknown>>) => {
    turn += 1;
    return callTool(side, sender.sessionId, turn, name, args);
  };

  const listed = (yield* tool('list_targets', {})) as unknown as ListedTargets;
  const device = listed.devices[0];
  const project = device?.projects?.[0];
  const handle = project?.sessions[0]?.handle ?? '';
  // Under Auto: sent at once, and its result awaited.
  const sent = yield* tool('send_message', { to: handle, text: 'echo:the answer is 42' });
  const done = yield* tool('await_result', { handle: sent['handle'], timeoutSeconds: 30 });
  // The Session there cannot send back along the chain its Turn came through: a loop.
  const relay = Effect.fnUntraced(function* (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) {
    const asked = yield* side.away.say((script) => script.tool(name, args));
    const relayed = yield* tool('send_message', { to: handle, text: asked });
    const result = yield* tool('await_result', {
      handle: relayed['handle'],
      timeoutSeconds: 30,
    });
    return JSON.parse(String(result['text'] ?? 'null')) as Record<string, unknown>;
  });
  const back = ((yield* relay('list_targets', {})) as unknown as ListedTargets).devices[0]
    ?.projects?.[0]?.sessions[0]?.handle;
  const loop = yield* relay('send_message', { to: back, text: 'echo:pong' });
  // Under Ask: Deny sends nothing, Allow once sends.
  yield* side.call((api) =>
    api['Session.setOption']({
      sessionId: sender.sessionId,
      option: 'permissionMode',
      value: 'ask',
    }),
  );
  const asked: Array<unknown> = [];
  const seen = new Set<string>();
  const hold = yield* side.away.say((script) => script.hold);
  for (const answer of ['rejectOnce', 'allowOnce'] as const) {
    turn += 1;
    const call = yield* Effect.forkChild(
      callTool(side, sender.sessionId, turn, 'send_message', {
        to: handle,
        text: hold,
      }),
    );
    const request = yield* nextPermission(side, sender.sessionId, seen);
    seen.add(request.id);
    const option = request.options.find((candidate) => candidate.kind === answer);
    yield* side.call((api) =>
      api['Session.answerPermission']({
        sessionId: sender.sessionId,
        requestId: request.id,
        optionId: option?.id ?? '',
      }),
    );
    asked.push(yield* Fiber.join(call));
  }
  yield* side.call((api) =>
    api['Session.setOption']({
      sessionId: sender.sessionId,
      option: 'permissionMode',
      value: 'auto',
    }),
  );
  const held = asked.at(-1) as Record<string, unknown> | undefined;
  const pending = yield* tool('await_result', { handle: held?.['handle'], timeoutSeconds: 0 });
  // A busy Session refuses an Agent's Message instead of queueing it.
  const busy = yield* tool('send_message', { to: handle, text: 'echo:are you there' });
  yield* side.away.call((api) => api['Session.cancel']({ sessionId: target.sessionId }));
  const cancelled = yield* tool('await_result', { handle: held?.['handle'], timeoutSeconds: 30 });
  // A new Session there, under that Device's own default Permission mode.
  const started = yield* tool('start_session', {
    project: project?.handle,
    text: 'echo:take it from here',
  });
  const startedResult = yield* tool('await_result', {
    handle: started['handle'],
    timeoutSeconds: 30,
  });
  const startedSessions = yield* side.away.call((api) =>
    api['Session.list']({ projectId: target.projectId }),
  );
  const created = startedSessions.find((session) => session.id !== target.sessionId);
  const createdMode =
    created === undefined
      ? undefined
      : (yield* liveWhen(side.away, created.id)).options.permissionMode;
  // Once the other Device stops allowing this one's Agents, it refuses.
  yield* side.forbid;
  const forbidden = yield* tool('send_message', { to: handle, text: 'echo:still there?' });
  const received = yield* transcript(side.away, target.sessionId, 5);
  return {
    outcome: {
      listed: { online: device?.online, projects: device?.projects?.length },
      sent: { accepted: sent['accepted'], delivery: sent['delivery'] },
      done,
      loop,
      asked,
      pending,
      busy,
      cancelled,
      started: { accepted: started['accepted'], result: startedResult, mode: createdMode },
      forbidden,
    },
    transcript: { received },
  };
});

const humanMessaging: ParityCase = Effect.fnUntraced(function* (side) {
  const from = yield* newSession(side);
  const target = yield* newSession(side);
  yield* prompt(side, target.sessionId, (script) => script.reply('ready'));
  yield* transcript(side, target.sessionId, 1);
  const sending = {
    sessionId: from.sessionId,
    title: 'Plan the release',
    projectName: 'Parity',
  };
  const delivery = yield* side.messaging['Messaging.send']({
    from: sending,
    ...(side.device === undefined ? {} : { device: side.device }),
    sessionId: target.sessionId,
    text: side.script.reply('handed over') ?? 'handed over',
  });
  const received = yield* transcript(side, target.sessionId, 2);
  const started = yield* side.messaging['Messaging.startSession']({
    from: sending,
    ...(side.device === undefined ? {} : { device: side.device }),
    projectId: target.projectId,
    text: side.script.reply('a new task') ?? 'a new task',
  });
  const fresh = yield* transcript(side, started, 1);
  return {
    outcome: { delivery, received: agentReplies(received), fresh: agentReplies(fresh) },
    transcript: { received, fresh },
  };
});

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// The matrix.

export const parityMatrix: ReadonlyArray<ParityRow> = [
  {
    id: 'turn',
    title: 'a Message and the Agent’s streamed answer',
    covers: [
      ...rpc('Session.create', 'Session.prompt', 'Session.events', 'Session.list'),
      'transcript:TurnStarted',
      'transcript:TurnEnded',
      'transcript:Message',
      'transcript:MessageDelta',
      'part:text',
    ],
    parity: { _tag: 'Same' },
    case: chatTurn,
  },
  {
    id: 'work',
    title: 'the Agent’s thoughts, Plan and Steps, and the sidebar following the Turn',
    covers: [
      ...rpc('Session.changes'),
      'transcript:Thought',
      'transcript:ThoughtDelta',
      'transcript:Plan',
      'transcript:Step',
    ],
    parity: { _tag: 'Same' },
    case: agentWork,
  },
  {
    id: 'permissions',
    title: 'Permission requests answered Allow once, Always allow and Deny, with Attention',
    covers: [...rpc('Session.answerPermission'), 'transcript:PermissionRequest'],
    parity: { _tag: 'Same' },
    case: permissions,
  },
  {
    id: 'cancel',
    title: 'Stop cancels the running Turn',
    covers: rpc('Session.cancel'),
    parity: { _tag: 'Same' },
    case: cancelTurn,
  },
  {
    id: 'queue-steer',
    title: 'Queue, reorder, clear and steer',
    covers: rpc('Session.enqueue', 'Session.setQueue', 'Session.clearQueue', 'Session.steer'),
    parity: { _tag: 'Same' },
    case: queueAndSteer,
  },
  {
    id: 'composer',
    title: 'the unsent Composer draft is kept where the Session runs',
    covers: rpc('Session.getComposer', 'Session.setComposer'),
    parity: { _tag: 'Same' },
    case: composer,
  },
  {
    id: 'options',
    title: 'Agent, Model, Effort and Permission mode of a Session',
    covers: rpc('Session.setAgent', 'Session.setOption'),
    parity: { _tag: 'Same' },
    case: sessionOptions,
  },
  {
    id: 'lifecycle',
    title: 'rename, archive, unarchive and delete a Session',
    covers: rpc(
      'Session.rename',
      'Session.archive',
      'Session.unarchive',
      'Session.delete',
      'Session.countWorkers',
    ),
    parity: { _tag: 'Same' },
    case: sessionLifecycle,
  },
  {
    id: 'context',
    title: 'compact and clear the Agent’s context, stop and restart the Agent',
    covers: [
      ...rpc(
        'Session.compact',
        'Session.clearContext',
        'Session.startEmptyContext',
        'Session.stopAgent',
        'Session.retryAgent',
      ),
      'transcript:Compaction',
      'transcript:ContextCleared',
    ],
    parity: { _tag: 'Same' },
    case: agentContext,
  },
  {
    id: 'session-tools',
    title: 'the Session and Worker tools: delegate, list_sessions and send_message',
    covers: ['tool:delegate', 'tool:list_sessions', 'tool:send_message', 'transcript:Notice'],
    parity: { _tag: 'Same' },
    case: sessionTools,
  },
  {
    id: 'handoff',
    title: 'a Summary handoff: prepare, review, fork',
    covers: [
      ...rpc(
        'Session.prepareHandoff',
        'Session.revalidateHandoff',
        'Session.executeHandoff',
        'Session.listHandoffAttempts',
      ),
      'transcript:HandoffBoundary',
    ],
    parity: { _tag: 'Same' },
    case: summaryHandoff,
  },
  {
    id: 'images',
    title: 'images, audio, links and resources, shown on demand from a Remote device',
    covers: ['part:image', 'part:audio', 'part:link', 'part:resource', ...rpc('Assets.read')],
    parity: {
      _tag: 'Counterpart',
      remote: rpc('Assets.read'),
      why: 'A Remote device sends a handle in place of the bytes; the window reads them when the part renders.',
    },
    case: imagesAndAssets,
  },
  {
    id: 'commands',
    title: 'the Agent’s Skills and Commands in the Composer',
    covers: ['action:skill', 'action:command'],
    parity: { _tag: 'Same' },
    case: commands,
  },
  {
    id: 'files',
    title: 'the Session’s files: list and preview',
    covers: rpc('Files.list', 'Files.read'),
    parity: { _tag: 'Same' },
    case: files,
  },
  {
    id: 'projects',
    title: 'add, rename, configure, check, locate and remove a Project by a browsed folder',
    covers: rpc(
      'Projects.list',
      'Projects.addFolder',
      'Projects.rename',
      'Projects.setSettings',
      'Projects.check',
      'Projects.locateFolder',
      'Projects.remove',
      'Folders.browse',
    ),
    parity: { _tag: 'Same' },
    case: projects,
  },
  {
    id: 'native-picker',
    title: 'the native folder picker',
    covers: rpc('Projects.add', 'Projects.locate'),
    parity: {
      _tag: 'LocalOnly',
      why: 'A dialog opens on the Device in front of the person; a Remote device’s Projects are added and located by a browsed folder (Projects.addFolder, Projects.locateFolder, Folders.browse).',
    },
  },
  {
    id: 'execution-settings',
    title: 'execution Settings: default Permission mode, auto-archive, per-Agent Model and Effort',
    covers: rpc('ExecutionSettings.get', 'ExecutionSettings.update'),
    parity: { _tag: 'Same' },
    case: executionSettings,
  },
  {
    id: 'agents',
    title: 'the Agents, their install command and install',
    covers: rpc('Agents.list', 'Agents.installCommand', 'Agents.install'),
    parity: { _tag: 'Same' },
    case: agentsSetup,
  },
  {
    id: 'source-control',
    title:
      'Source control: changes, diffs, commits, commit details, revert, discard, branches, fetch, pull and push',
    covers: rpc(
      'SourceControl.changes',
      'SourceControl.diff',
      'SourceControl.commits',
      'SourceControl.commitDetail',
      'SourceControl.commitDiff',
      'SourceControl.commit',
      'SourceControl.prepareDiscard',
      'SourceControl.discard',
      'SourceControl.revert',
      'SourceControl.branches',
      'SourceControl.fetch',
      'SourceControl.pull',
      'SourceControl.push',
    ),
    parity: { _tag: 'Same' },
    case: sourceControl,
  },
  {
    id: 'worktrees',
    title: 'Worktrees: list, and a draft Session moved into a new one',
    covers: rpc('Worktrees.list', 'Worktrees.prepareDraft', 'Worktrees.prepareDraftStream'),
    parity: { _tag: 'Same' },
    case: worktrees,
  },
  {
    id: 'cross-device-tools',
    title:
      'the cross-device tools: targets by handle, send under Auto and Ask, await_result, start_session, refusals',
    covers: ['tool:list_targets', 'tool:start_session', 'tool:await_result'],
    parity: { _tag: 'Same' },
    case: crossDeviceTools,
  },
  {
    id: 'human-messaging',
    title: 'Send to another Session and Start a new Session in, from a person',
    covers: rpc('Messaging.send', 'Messaging.startSession'),
    parity: {
      _tag: 'Counterpart',
      remote: rpc('Inbox.deliver', 'Inbox.start'),
      why: 'The window always sends from its own Device; a Remote device receives the Message through its Inbox.',
    },
    case: humanMessaging,
  },
  {
    id: 'agent-login',
    title: 'log the Agent in',
    covers: rpc('Session.loginAgent'),
    parity: {
      _tag: 'Gap',
      why: 'The login runs where the Agent runs: on a Remote Session it opens the browser or terminal on the host, out of sight of the viewer.',
    },
  },
  {
    id: 'logs',
    title: 'open the Agent and install logs',
    covers: rpc('Session.openAgentLog', 'Agents.openInstallLog'),
    parity: {
      _tag: 'Gap',
      why: 'The log opens in the system viewer of the Device that wrote it: on a Remote device, the host’s screen, not the viewer’s.',
    },
  },
  {
    id: 'ui-preferences',
    title: 'language, theme, notifications, sidebar layout, Project order and cross-Project access',
    covers: rpc('Settings.get', 'Settings.update'),
    parity: {
      _tag: 'LocalOnly',
      why: 'UI preferences belong to the viewing Device. The cross-Project allow-list is stored with them and stays Local for now.',
    },
  },
  {
    id: 'tabs',
    title: 'Tabs and their restore',
    covers: rpc('Tabs.activations', 'Tabs.restore', 'Tabs.update'),
    parity: {
      _tag: 'LocalOnly',
      why: 'Tabs are the viewing Device’s workspace; Remote Tabs are stubs in its own Tab store.',
    },
  },
  {
    id: 'shell',
    title: 'app info, updates and external links',
    covers: rpc('AppInfo.get', 'Update.check', 'Update.install', 'Links.openExternal'),
    parity: {
      _tag: 'LocalOnly',
      why: 'The app and the browser of the Device in front of the person.',
    },
  },
  {
    id: 'local-editor',
    title: 'open a Session folder in VS Code',
    covers: rpc('SourceControl.openEditor'),
    parity: {
      _tag: 'LocalOnly',
      why: 'Launching an editor belongs to the viewing Device and is not exposed to Paired devices.',
    },
  },
  {
    id: 'embedded-browser',
    title: 'embedded Browser pane and Agent Browser control',
    covers: rpc(
      'Browser.getState',
      'Browser.setOpen',
      'Browser.setActiveSession',
      'Browser.setBounds',
      'Browser.setWidth',
      'Browser.setOccluded',
      'Browser.navigate',
      'Browser.goBack',
      'Browser.goForward',
      'Browser.reload',
      'Browser.openExternal',
      'Browser.openDevTools',
      'Browser.createPage',
      'Browser.selectPage',
      'Browser.closePage',
      'Browser.captureScreenshot',
      'Browser.startElementPicker',
      'Browser.cancelElementPicker',
      'Browser.getConsoleErrors',
      'Browser.clearData',
      'Browser.takeOver',
      'Browser.continueAgent',
      'Browser.events',
    ),
    parity: {
      _tag: 'LocalOnly',
      why: 'The embedded WebContentsView attaches to the viewing Local window and drives localhost pages on that Device.',
    },
  },
  {
    id: 'devices',
    title: 'hosting, Pairing, Paired devices, their connections and connected viewers',
    covers: rpc(
      'Devices.local',
      'Devices.rename',
      'Devices.setHosting',
      'Devices.startPairing',
      'Devices.cancelPairing',
      'Devices.pair',
      'Devices.check',
      'Devices.unpair',
      'Devices.setAllowAgents',
      'Devices.watch',
      'Devices.nearby',
      'Devices.connections',
      'Devices.connect',
      'Devices.viewers',
      'Devices.disconnect',
    ),
    parity: {
      _tag: 'LocalOnly',
      why: 'Each Device decides its own trust; a Paired device never changes it.',
    },
  },
  {
    id: 'handshake',
    title: 'the Remote handshake',
    covers: rpc('Remote.hello'),
    parity: {
      _tag: 'Transport',
      why: 'How a Device introduces itself to a Paired device, under every Remote call; covered by the LAN transport spec.',
    },
  },
];
