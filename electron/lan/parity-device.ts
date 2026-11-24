/**
 * The harness behind the cross-device parity matrix (`parity-matrix.ts`): two in-process Devices over real loopback
 * `wss://` (`test-peer.ts`), Paired both ways, each serving every Device-scoped domain for real over its own Store
 * and an Agent, with the cross-device tools attached and Agents allowed from the other Device.
 *
 * A case runs against a `ParitySide`: the window of the viewer working on its own Device (`Local`), or on the other
 * Device through the LAN (`Remote`). Each side gets a fresh pair, so nothing one run leaves behind is seen by the
 * other, and the observations are normalized so that only what a person would call a difference remains.
 */
import { Cause, Effect, Exit, Layer, Option, Scope, Stream } from 'effect';
import { RpcClient } from 'effect/rpc';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DEVICE_SCOPE_HEADER, type DeviceId } from '../../src/shared/devices/devices.rpc';
import type { MessagingRpcs } from '../../src/shared/messaging/messaging.rpc';
import type { DeviceScopedRpcs } from '../../src/shared/rpc/remote-rpcs';
import type {
  MessagePart,
  PermissionRequest,
  SessionId,
  SessionStreamItem,
  TranscriptItem,
} from '../../src/shared/sessions/sessions.rpc';
import { fakeEntry, installFakeAgent } from '../acp/acpFakes';
import { layerAgents } from '../agents/agents';
import type { CatalogEntry } from '../agents/catalog';
import { layerAgentInstall } from '../agents/install';
import { layerPathSources, MergedPath } from '../agents/merged-path';
import { makeTestDevice, pairDevices, tempDataDir, type TestDevice } from '../devices/test-peer';
import { layerFiles } from '../files/files';
import { attachAgentTools } from '../messaging/agent-tools';
import { layerInbox } from '../messaging/inbox';
import { DeviceIdentity } from '../devices/identity';
import { DeviceConnections } from './connections';
import { layerAgentsHandlersWith } from '../rpc/agents';
import { layerAssetsHandlers } from '../rpc/assets';
import { layerFilesHandlersWith } from '../rpc/files';
import { layerFoldersHandlers } from '../rpc/folders';
import { layerProjectsHandlersWith } from '../rpc/projects';
import { layerSessionsHandlersWith } from '../rpc/sessions';
import { layerExecutionSettingsHandlersWith } from '../rpc/settings';
import { layerSourceControlHandlersWith } from '../rpc/source-control';
import { layerWorktreesHandlersWith } from '../rpc/worktrees';
import { AgentCatalog, makeAgentCatalog } from '../sessions/session-agent';
import { layerSessionsWithFakeAgent } from '../sessions/sessions-fakes';
import {
  layerSessionFoldersLive,
  layerSourceControl,
  RecoveryRoot,
} from '../source-control/source-control';
import { layerStore } from '../store/store';
import { layerWorktrees } from '../worktrees/worktrees';

/** Where a case runs: on the viewer's own Device, or on the other Device through the LAN. */
export type Where = 'Local' | 'Remote';

/**
 * How a case makes the Agent do something. The fake Agent follows scripted prompts; a real Agent (live probes) gets
 * plain instructions, and what it cannot be asked for reliably is `undefined`, which leaves the row Unproven.
 */
export interface AgentScript {
  /** The Agent answers exactly `text`. */
  readonly reply: (text: string) => string | undefined;
  /** The Agent calls the Spence MCP tool `name` with `args` once and answers with its raw result. */
  readonly tool: (name: string, args: Readonly<Record<string, unknown>>) => string | undefined;
  /** The Agent asks a Permission request (Allow once, Always allow, Deny) and then names the answer. */
  readonly permission: string | undefined;
  /** The Agent thinks, plans, reads and edits a file, and runs a command. */
  readonly work: string | undefined;
  /** The Agent works until its Turn is cancelled. */
  readonly hold: string | undefined;
  /** The Agent works until it is steered, then ends its Turn. */
  readonly steerable: string | undefined;
  /** The Agent answers with an image. */
  readonly image: string | undefined;
}

/** The fake Agent's scripted prompts (`fakeAgent.mjs`). */
export const fakeScript: AgentScript = {
  reply: (text) => `echo:${text}`,
  tool: (name, args) => `mcp:${name}:${JSON.stringify(args)}`,
  permission: 'permit',
  work: 'work',
  hold: 'hold',
  steerable: 'steer-done',
  image: 'image:reply',
};

/**
 * Plain instructions for a real Agent (live probes). Only what a model can be asked for reliably is scripted: the
 * rest is `undefined`, so those rows are recorded Unproven rather than guessed.
 */
export const liveScript: AgentScript = {
  reply: (said) => `Reply with exactly this text and nothing else, without quotes: ${said}`,
  tool: (name, args) =>
    `Call the Spence MCP tool "${name}" exactly once with these JSON arguments: ${JSON.stringify(args)}. Then reply with only the tool's raw text result, verbatim, with nothing before or after it.`,
  permission:
    'Run the shell command "node --version" with your terminal tool, then reply with its output only.',
  work: undefined,
  hold: undefined,
  steerable: undefined,
  image: undefined,
};

/** The Agent both Devices run: the fake one in CI, a real adapter in a live probe. */
export interface ParityAgent {
  readonly catalog: ReadonlyArray<CatalogEntry>;
  /** Prepended to the merged PATH, where the real adapter is found; the fake Agent needs none. */
  readonly path?: string;
  readonly script: AgentScript;
}

export const fakeAgent: ParityAgent = { catalog: [fakeEntry()], script: fakeScript };

/** A row the script cannot drive with this Agent: reported as Unproven, never as a pass or a failure. */
export class Unproven extends Error {
  readonly _tag = 'Unproven';
}

/** A Device whose every Device-scoped domain is real, over its own Store, with the Agent of `agent`. */
const makeParityDevice = Effect.fnUntraced(function* (agent: ParityAgent) {
  const root = yield* tempDataDir;
  const install = yield* installFakeAgent;
  const mergedPath =
    agent.path === undefined ? install.bin : `${agent.path}${path.delimiter}${install.bin}`;
  const sessions = yield* Layer.build(
    layerSessionsWithFakeAgent({
      root,
      install,
      projectFolder: process.cwd(),
      catalog: agent.catalog,
      path: mergedPath,
    }).pipe(Layer.provideMerge(Layer.succeed(AgentCatalog, makeAgentCatalog(agent.catalog)))),
  );
  const withSessions = Layer.succeedContext(sessions);
  const pathLayers = Layer.mergeAll(
    Layer.succeed(MergedPath, { get: Effect.succeed(mergedPath) }),
    layerPathSources,
  );
  const sourceControl = layerSourceControl.pipe(
    Layer.provide(layerSessionFoldersLive),
    Layer.provide(Layer.succeed(RecoveryRoot, { folder: path.join(root, 'discarded') })),
  );
  const serve = Layer.mergeAll(
    layerSessionsHandlersWith,
    layerProjectsHandlersWith,
    layerExecutionSettingsHandlersWith,
    layerFoldersHandlers,
    layerAssetsHandlers,
    layerFilesHandlersWith.pipe(Layer.provide(layerFiles)),
    layerSourceControlHandlersWith.pipe(Layer.provide(sourceControl)),
    layerWorktreesHandlersWith.pipe(Layer.provide(layerWorktrees)),
    layerAgentsHandlersWith.pipe(
      Layer.provide(layerAgentInstall.pipe(Layer.provideMerge(layerAgents))),
      Layer.provide(layerStore(root)),
      Layer.provide(pathLayers),
    ),
  ).pipe(Layer.provide(withSessions));
  const inbox = layerInbox.pipe(Layer.provide(withSessions));
  const device = yield* makeTestDevice({ serve, inbox });
  const tools = attachAgentTools.pipe(
    Effect.provide(sessions),
    Effect.provideService(DeviceIdentity, device.deviceIdentity),
    Effect.provideService(DeviceConnections, device.deviceConnections),
  );
  return { device, tools, dataDir: root };
});

/** The viewer's window working on one Device of the pair. */
export interface ParityView {
  /** The viewer's window calling this Device: its own (Local), or the other one (Remote). */
  readonly call: <A, E, R>(
    use: (api: RpcClient.FromGroup<typeof DeviceScopedRpcs>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** This Device, as the window names it: absent for the Local device. */
  readonly device: DeviceId | undefined;
  readonly script: AgentScript;
  /** The prompt `pick` gives this Agent, or the row is Unproven for it. */
  readonly say: (pick: (script: AgentScript) => string | undefined) => Effect.Effect<string>;
  /** A new folder for a Project, removed with the run; a git repository with one commit when `git` is set. */
  readonly folder: (options?: { readonly git?: boolean }) => Effect.Effect<string>;
}

/** The viewer's window, and the Device a case works on in this run. */
export interface ParitySide extends ParityView {
  readonly where: Where;
  /** The other Device of the pair, as the same window reaches it. */
  readonly away: ParityView;
  /** The viewer's Send to another Session (`MessagingRpcs`), always Local. */
  readonly messaging: RpcClient.FromGroup<typeof MessagingRpcs>;
  /** The other Device stops allowing Agents from this one (Settings > Devices there). */
  readonly forbid: Effect.Effect<void>;
}

/** Two Devices Paired both ways and connected, each allowing the other's Agents, with the cross-device tools. */
const makeParityPair = Effect.fnUntraced(function* (agent: ParityAgent) {
  const host = yield* makeParityDevice(agent);
  const viewer = yield* makeParityDevice(agent);
  // The viewer hosts too, so the host learns where to reach it back when they pair.
  yield* viewer.device.setHosting(true);
  yield* pairDevices(host.device, viewer.device);
  const hostId = (yield* host.device.identity).id;
  const viewerId = (yield* viewer.device.identity).id;
  yield* viewer.device.awaitConnection(hostId, 'Online');
  yield* host.device.connect(viewerId);
  yield* host.device.awaitConnection(viewerId, 'Online');
  yield* host.device.setAllowAgents(viewerId, true);
  yield* viewer.device.setAllowAgents(hostId, true);
  yield* host.tools;
  yield* viewer.tools;
  return { host, viewer, hostId, viewerId };
});

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.callback<void>((resume) => {
    execFile('git', [...args], { cwd }, (error) =>
      resume(error === null ? Effect.void : Effect.die(error)),
    );
  });

const makeFolder = Effect.fnUntraced(function* (options?: { readonly git?: boolean }) {
  const dir = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-parity-'))),
    (folder) =>
      Effect.promise(() =>
        rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      ),
  );
  yield* Effect.promise(() => writeFile(path.join(dir, 'README.md'), '# Parity\n'));
  if (options?.git === true) {
    yield* git(dir, ['init', '--quiet', '--initial-branch=main']);
    yield* git(dir, ['config', 'user.email', 'parity@spence.test']);
    yield* git(dir, ['config', 'user.name', 'Parity']);
    yield* git(dir, ['config', 'commit.gpgsign', 'false']);
    yield* git(dir, ['add', '.']);
    yield* git(dir, ['commit', '--quiet', '-m', 'First commit']);
  }
  return dir;
});

/**
 * What a case observed. `outcome` is what a person acts on (results, outcomes, states) and is all a live probe
 * compares, since a real Agent words its answers differently each run; `transcript` is compared with the fake Agent.
 */
export interface Observation {
  readonly outcome: unknown;
  readonly transcript?: unknown;
}

export type ParityCase = (side: ParitySide) => Effect.Effect<Observation, unknown>;

/** Runs `parityCase` on a fresh pair, as `where`, and returns its normalized Observation. */
export const runParityCase = (
  parityCase: ParityCase,
  where: Where,
  agent: ParityAgent = fakeAgent,
): Effect.Effect<Observation, unknown> =>
  Effect.gen(function* () {
    const { host, viewer, hostId, viewerId } = yield* makeParityPair(agent);
    const scope = yield* Effect.scope;
    const folders: Array<string> = [];
    const view = (device: DeviceId | undefined): ParityView => ({
      call: (use) =>
        device === undefined
          ? use(viewer.device.desktop)
          : RpcClient.withHeaders(use(viewer.device.desktop), { [DEVICE_SCOPE_HEADER]: device }),
      device,
      script: agent.script,
      say: (pick) => {
        const said = pick(agent.script);
        return said === undefined
          ? Effect.die(new Unproven('This Agent cannot be asked for this'))
          : Effect.succeed(said);
      },
      folder: (options) =>
        makeFolder(options).pipe(
          Effect.tap((folder) => Effect.sync(() => folders.push(folder))),
          Effect.provideService(Scope.Scope, scope),
        ),
    });
    const local = where === 'Local';
    const side: ParitySide = {
      ...view(local ? undefined : hostId),
      where,
      away: view(local ? hostId : undefined),
      messaging: viewer.device.messaging,
      forbid: local
        ? host.device.setAllowAgents(viewerId, false).pipe(Effect.orDie)
        : viewer.device.setAllowAgents(hostId, false).pipe(Effect.orDie),
    };
    const observed = yield* parityCase(side);
    const home = local ? viewer : host;
    return normalize(observed, [
      ...folders.map((folder, index) => [folder, `<folder:${index + 1}>`] as const),
      ...folders.map(
        (folder, index) => [path.basename(folder), `<folder-name:${index + 1}>`] as const,
      ),
      [home.dataDir, '<data>'],
      [process.cwd(), '<cwd>'],
    ]) as Observation;
  }).pipe(Effect.scoped);

/** Keys whose values stand for an entity: compared by identity within one run, never by value across runs. */
const isIdKey = (key: string): boolean =>
  key === 'id' ||
  key.endsWith('Id') ||
  key.endsWith('Ids') ||
  key === 'handle' ||
  key === 'receipt' ||
  key === 'session' ||
  key === 'token' ||
  key === 'sha' ||
  key === 'shortSha' ||
  key === 'contextId' ||
  key === 'pid';

/** Keys of times and durations: when something happened differs between two runs. */
const isTimeKey = (key: string): boolean =>
  key === 'at' ||
  key.endsWith('At') ||
  key.endsWith('Ms') ||
  key.endsWith('Seconds') ||
  key === 'date';

/** Keys of folders named after when they were made (a discarded change's recovery copy). */
const isStampedKey = (key: string): boolean => key === 'recoveryFolder';

/** Provenance: the one thing allowed to differ between a Local and a Remote Transcript. */
const PROVENANCE_KEYS = new Set(['from']);

/** Ids and handles that appear inside text (a tool's raw result): UUIDs and cross-device handles. */
const ID_IN_TEXT =
  /(?<![A-Za-z0-9_-])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:session|project|result)-[A-Za-z0-9_-]{16})(?![A-Za-z0-9_-])/g;

/**
 * The Observation with every id replaced by its order of first appearance, times and durations blanked, Provenance
 * dropped and the run's own folders named. Two runs that did the same thing normalize to equal values.
 */
export const normalize = (
  value: unknown,
  literals: ReadonlyArray<readonly [string, string]>,
): unknown => {
  const ids = new Map<string, string>();
  const idOf = (raw: string): string => {
    const known = ids.get(raw);
    if (known !== undefined) return known;
    const next = `<id:${ids.size + 1}>`;
    ids.set(raw, next);
    return next;
  };
  const text = (raw: string): string =>
    literals
      .reduce((acc, [from, to]) => acc.split(from).join(to), raw)
      .split(path.sep)
      .join('/')
      .replace(ID_IN_TEXT, idOf);
  const walk = (current: unknown, key: string | undefined): unknown => {
    if (key !== undefined && isTimeKey(key) && current !== undefined) return '<time>';
    if (key !== undefined && isStampedKey(key) && current !== undefined) return '<stamped>';
    if (typeof current === 'number' && key !== undefined && isIdKey(key))
      return idOf(String(current));
    if (typeof current === 'string')
      return key !== undefined && isIdKey(key) ? idOf(current) : text(current);
    if (Array.isArray(current)) return current.map((item) => walk(item, key));
    if (typeof current === 'object' && current !== null) {
      return Object.fromEntries(
        // Sorted: a value decoded off the wire lists its keys in schema order, not in the order they were set.
        Object.entries(current)
          .filter(([name]) => !PROVENANCE_KEYS.has(name))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, item]) => [name, walk(item, name)]),
      );
    }
    return current;
  };
  return walk(value, undefined);
};

// Helpers the cases share.

/** A new Project on the side's Device in a fresh folder, and a Session in it. */
export const newSession = Effect.fnUntraced(function* (
  side: ParityView,
  options?: { readonly git?: boolean },
) {
  const folder = yield* side.folder(options);
  const project = yield* side.call((api) => api['Projects.addFolder']({ path: folder }));
  const sessionId = yield* side.call((api) => api['Session.create']({ projectId: project.id }));
  return { projectId: project.id, sessionId, folder };
});

export const text = (value: string): ReadonlyArray<MessagePart> => [{ _tag: 'text', text: value }];

/** Starts a Turn with the prompt `pick` gives this Agent. */
export const prompt = Effect.fnUntraced(function* (
  side: ParityView,
  sessionId: SessionId,
  pick: (script: AgentScript) => string | undefined,
) {
  const said = yield* side.say(pick);
  return yield* side.call((api) => api['Session.prompt']({ sessionId, parts: text(said) }));
});

const isTurnEnd = (item: SessionStreamItem) =>
  item._tag === 'Transcript' && item.event.item._tag === 'TurnEnded';

/**
 * The Session's Transcript as the window shows it, up to the end of its `turns`-th Turn: Remote assets fetched on
 * demand (`Assets.read`) and put back in place, as the window does when a part renders.
 */
export const transcript = Effect.fnUntraced(function* (
  side: ParityView,
  sessionId: SessionId,
  turns: number,
) {
  const items = yield* side.call((api) =>
    api['Session.events']({ sessionId }).pipe(
      Stream.filter((item) => item._tag === 'Transcript'),
      Stream.mapAccum(
        () => 0,
        (ended, item) => {
          const next = isTurnEnd(item) ? ended + 1 : ended;
          return [next, [{ item, ended: next }]] as const;
        },
      ),
      Stream.takeUntil(({ ended }) => ended >= turns),
      Stream.map(({ item }) => item),
      Stream.runCollect,
    ),
  );
  const events = items.flatMap((item) => (item._tag === 'Transcript' ? [item.event.item] : []));
  return yield* Effect.forEach(events, (item) => withAssets(side, item));
});

const withAssets = (side: ParityView, item: TranscriptItem): Effect.Effect<TranscriptItem> => {
  if (item._tag !== 'Message') return Effect.succeed(item);
  return Effect.map(
    Effect.forEach(item.parts, (part): Effect.Effect<MessagePart> => {
      if ((part._tag === 'image' || part._tag === 'audio') && part.asset?.handle !== undefined) {
        const handle = part.asset.handle;
        return side
          .call((api) => api['Assets.read']({ handle }))
          .pipe(
            Effect.orDie,
            Effect.map(({ data }) => ({ _tag: part._tag, mimeType: part.mimeType, data })),
          );
      }
      return Effect.succeed(part);
    }),
    (parts) => ({ ...item, parts }),
  );
};

/** The Agent's text in a Transcript's Messages, Turn by Turn. */
export const agentReplies = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<string> => {
  const byTurn = new Map<string, string>();
  const turnOf = new Map<string, string>();
  for (const item of items) {
    if (item._tag === 'Message' && item.role === 'agent') {
      turnOf.set(item.id, item.turnId);
      const said = item.parts.flatMap((part) => (part._tag === 'text' ? [part.text] : [])).join('');
      byTurn.set(item.turnId, (byTurn.get(item.turnId) ?? '') + said);
    }
    if (item._tag === 'MessageDelta') {
      const turn = turnOf.get(item.id);
      if (turn !== undefined) byTurn.set(turn, (byTurn.get(turn) ?? '') + item.text);
    }
  }
  return [...byTurn.values()];
};

/** How each Turn of a Transcript ended. */
export const outcomes = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<string> =>
  items.flatMap((item) => (item._tag === 'TurnEnded' ? [item.outcome._tag] : []));

/** The kinds of the Transcript's items, in order, without the streamed deltas. */
export const kinds = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<string> =>
  items.flatMap((item) =>
    item._tag === 'MessageDelta' || item._tag === 'ThoughtDelta' || item._tag === 'StepDelta'
      ? []
      : [item._tag],
  );

/** The next pending Permission request in the Session other than those in `seen`, as the window sees it. */
export const nextPermission = (
  side: ParityView,
  sessionId: SessionId,
  seen: ReadonlySet<string> = new Set(),
) =>
  side.call((api) =>
    api['Session.events']({ sessionId }).pipe(
      Stream.map((item): PermissionRequest | undefined =>
        item._tag === 'Transcript' &&
        item.event.item._tag === 'PermissionRequest' &&
        item.event.item.state._tag === 'pending' &&
        !seen.has(item.event.item.id)
          ? item.event.item
          : undefined,
      ),
      Stream.filter((request): request is PermissionRequest => request !== undefined),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    ),
  );

/** The Session's live state once `ready` holds, as the window sees it. */
export const liveWhen = (
  side: ParityView,
  sessionId: SessionId,
  ready: (state: Extract<SessionStreamItem, { readonly _tag: 'Live' }>['state']) => boolean = () =>
    true,
) =>
  side.call((api) =>
    api['Session.events']({ sessionId }).pipe(
      Stream.filter(
        (item): item is Extract<SessionStreamItem, { readonly _tag: 'Live' }> =>
          item._tag === 'Live' && ready(item.state),
      ),
      Stream.runHead,
      Effect.map((item) => Option.getOrThrow(item).state),
    ),
  );

/** A call's result or its typed failure, as the window gets it: the same on both sides, either way. */
export const settle = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) =>
    Exit.isSuccess(exit)
      ? { ok: exit.value }
      : { failed: Option.getOrUndefined(Cause.findErrorOption(exit.cause)) ?? 'defect' },
  );

export type { TestDevice };
