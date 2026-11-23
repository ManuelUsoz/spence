import { Effect, Fiber, Layer, Option, Result, Stream } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type AgentId } from '../../src/shared/agents/agents.rpc';
import { type ProjectId } from '../../src/shared/projects/projects.rpc';
import {
  type SessionId,
  type LiveState,
  type SessionStreamItem,
  type TranscriptItem,
} from '../../src/shared/sessions/sessions.rpc';
import { PaneId, PanelId, TabId, type WorkspaceState } from '../../src/shared/tabs/tabs.rpc';
import { EMPTY_WORKSPACE, openSessionTab } from '../../src/shared/tabs/workspace-layout';
import type { AcpSessionEvent } from '../acp/acpClientDispatcher';
import type { AcpSession } from '../acp/acpSession';
import { layerAgentLogs } from '../acp/acpAgentLog';
import { fakeEntry, installFakeAgent, layerAcpClientWithFakeAgent } from '../acp/acpFakes';
import { type AgentLifetime, layerAgentLifetime } from '../acp/acpLifetime';
import { AcpClient, layerAcpClient, type AcpSessionManager } from '../acp/acpSessionManager';
import { layerAgents } from '../agents/agents';
import type { CatalogEntry } from '../agents/catalog';
import { layerPathSources, MergedPath, type PathSources } from '../agents/merged-path';
import { makeFakeBrowserHost } from '../browser/browser-host-fake';
import { type BrowserService, layerBrowserService } from '../browser/browser-service';
import { FolderPicker, Folders } from '../projects/folders';
import { layerProjects, Projects } from '../projects/projects';
import { layerRemembered, type Remembered } from '../settings/remembered';
import { layerSettings, type Settings, WindowSettings } from '../settings/settings';
import { layerStore, makeStore, Store, type StoreShape } from '../store/store';
import { layerDeleteQueue } from './delete-queue';
import { layerSessionStore, SessionStore } from './session-store';
import { AgentCatalog, makeAgentCatalog } from './session-agent';
import { layerSessions, Sessions } from './sessions';

/** Spawning node through a shim and a real ACP handshake take longer than the default 5 s on a cold machine. */
export const TIMEOUT = 30_000;

export const PROJECT_FOLDER = process.cwd();

export const observeAcpClient = (observe: (id: string, event: AcpSessionEvent) => void) =>
  Layer.effect(
    AcpClient,
    Effect.gen(function* () {
      const client = yield* AcpClient;
      const managers = new WeakMap<AcpSessionManager, AcpSessionManager>();
      const observeSession = (session: AcpSession): AcpSession => ({
        ...session,
        events: session.events.pipe(
          Stream.tap((event) => Effect.sync(() => observe(session.sessionId, event))),
        ),
      });
      const wrap = (manager: AcpSessionManager): AcpSessionManager => {
        const known = managers.get(manager);
        if (known !== undefined) return known;
        const wrapped: AcpSessionManager = {
          ...manager,
          newSession: (...args) => manager.newSession(...args).pipe(Effect.map(observeSession)),
          loadSession: (...args) => manager.loadSession(...args).pipe(Effect.map(observeSession)),
          resumeSession: (...args) =>
            manager.resumeSession(...args).pipe(Effect.map(observeSession)),
        };
        managers.set(manager, wrapped);
        return wrapped;
      };
      return { ...client, connect: (entry) => client.connect(entry).pipe(Effect.map(wrap)) };
    }),
  );

/** Sessions over a fresh store, one Project on `PROJECT_FOLDER`, and the fake Agent as the Sessions' Agent. */
export const withSessionsCustom = <A, E>(
  options: {
    readonly storeRoot?: string;
    readonly observeAcp?: (id: string, event: AcpSessionEvent) => void;
    readonly wrapStore?: (store: StoreShape) => StoreShape;
    readonly agentArgs?: ReadonlyArray<string>;
    readonly realAgentBin?: string;
    readonly pathSources?: (root: string) => Layer.Layer<PathSources>;
    readonly catalog?: ReadonlyArray<CatalogEntry>;
    readonly fallbackAgentId?: AgentId;
    readonly picker?: Effect.Effect<Option.Option<string>>;
  },
  body: (
    project: ProjectId,
    install: { readonly bin: string; readonly logs: string },
  ) => Effect.Effect<
    A,
    E,
    | Sessions
    | Projects
    | AgentLifetime
    | AcpClient
    | SessionStore
    | Store
    | Settings
    | Remembered
    | BrowserService
  >,
) =>
  Effect.gen(function* () {
    const root =
      options.storeRoot ??
      (yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-sessions-'))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
      ));
    const install = yield* installFakeAgent;
    const store =
      options.wrapStore === undefined
        ? layerStore(root)
        : Layer.succeed(Store, options.wrapStore(makeStore(root)));
    const sessionStore = layerSessionStore.pipe(Layer.provide(store));
    const projects = layerProjects.pipe(
      Layer.provide(sessionStore),
      Layer.provide(store),
      Layer.provide(
        Layer.succeed(Folders, {
          platform: process.platform,
          realPath: (folder) => Effect.succeed(Option.some(folder)),
          exists: () => Effect.succeed(true),
        }),
      ),
      Layer.provide(
        Layer.succeed(FolderPicker, {
          pick: options.picker ?? Effect.succeed(Option.some(PROJECT_FOLDER)),
        }),
      ),
    );
    const remembered = layerRemembered.pipe(Layer.provide(store));
    const settings = layerSettings.pipe(
      Layer.provide(remembered),
      Layer.provide(
        Layer.succeed(WindowSettings, {
          applyTheme: () => Effect.void,
          applyLanguage: () => Effect.void,
        }),
      ),
      Layer.provide(store),
    );
    const agentPath =
      options.realAgentBin === undefined
        ? install.bin
        : `${options.realAgentBin}${path.delimiter}${process.env['PATH'] ?? ''}`;
    const baseAcpClient =
      options.pathSources === undefined && options.realAgentBin === undefined
        ? layerAcpClientWithFakeAgent(install)
        : layerAcpClient.pipe(
            Layer.provide(layerAgentLogs(install.logs)),
            Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed(agentPath) })),
            Layer.provide(
              options.pathSources === undefined ? layerPathSources : options.pathSources(root),
            ),
          );
    const acpClient =
      options.observeAcp === undefined
        ? baseAcpClient
        : observeAcpClient(options.observeAcp).pipe(Layer.provide(baseAcpClient));
    const agentsLayer = layerAgents.pipe(
      Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed(agentPath) })),
      Layer.provide(
        options.pathSources === undefined ? layerPathSources : options.pathSources(root),
      ),
    );
    const deleteQueue = layerDeleteQueue.pipe(Layer.provide(Layer.mergeAll(store, acpClient)));
    const entries = options.catalog ?? [fakeEntry(options.agentArgs)];
    const fallbackId = options.fallbackAgentId ?? entries[0]?.id ?? fakeEntry().id;
    const layer = layerSessions.pipe(
      Layer.provideMerge(projects),
      Layer.provideMerge(sessionStore),
      Layer.provideMerge(remembered),
      Layer.provideMerge(deleteQueue),
      Layer.provideMerge(store),
      Layer.provideMerge(settings),
      Layer.provideMerge(agentsLayer),
      Layer.provideMerge(layerAgentLifetime.pipe(Layer.provideMerge(acpClient))),
      Layer.provideMerge(
        layerBrowserService.pipe(
          Layer.provide(makeFakeBrowserHost().layer),
          Layer.provide(settings),
        ),
      ),
      Layer.provide(Layer.succeed(AgentCatalog, makeAgentCatalog(entries, fallbackId))),
    );
    return yield* Effect.gen(function* () {
      const existing =
        options.storeRoot === undefined ? undefined : (yield* Projects.use((p) => p.list))[0];
      const project = existing ?? (yield* Projects.use((p) => p.add));
      if (project === null) return yield* Effect.die('the picker answered nothing');
      return yield* body(project.id, install);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);

export const withSessions = <A, E>(
  body: (
    project: ProjectId,
  ) => Effect.Effect<
    A,
    E,
    | Sessions
    | Projects
    | AgentLifetime
    | AcpClient
    | SessionStore
    | Store
    | Settings
    | BrowserService
  >,
  wrapStore?: (store: StoreShape) => StoreShape,
) => withSessionsCustom(wrapStore === undefined ? {} : { wrapStore }, (project) => body(project));

export const text = (value: string) => [{ _tag: 'text' as const, text: value }];

export const workspaceFor = (
  projectId: ProjectId,
  ids: ReadonlyArray<SessionId>,
  active?: SessionId,
): WorkspaceState => {
  let ws = EMPTY_WORKSPACE;
  for (const sessionId of ids) {
    ws = openSessionTab(ws, {
      projectId,
      sessionId,
      createIds: () => ({
        tabId: TabId.make(`tab-${sessionId}`),
        paneId: PaneId.make(`pane-${sessionId}`),
        panelId: PanelId.make(`panel-${sessionId}`),
      }),
    }).workspace;
  }
  if (active !== undefined) {
    ws = openSessionTab(ws, {
      projectId,
      sessionId: active,
      createIds: () => ({
        tabId: TabId.make(`tab-${active}`),
        paneId: PaneId.make(`pane-${active}`),
        panelId: PanelId.make(`panel-${active}`),
      }),
    }).workspace;
  }
  return ws;
};

export const waitForVerificationApproval = (id: SessionId, afterSeq = 0) =>
  events(id, afterSeq).pipe(
    Stream.filterMap((entry) =>
      entry._tag === 'Transcript' &&
      entry.event.item._tag === 'PermissionRequest' &&
      entry.event.item.state._tag === 'pending' &&
      entry.event.item.workflowSource?.role === 'Verifier'
        ? Result.succeed(entry.event.item.id)
        : Result.failVoid,
    ),
    Stream.runHead,
    Effect.timeout('10 seconds'),
    Effect.flatMap((request) =>
      Option.isSome(request) ? Effect.succeed(request.value) : Effect.die('No review approval'),
    ),
  );

export const isTurnEnd = (item: SessionStreamItem) =>
  item._tag === 'Transcript' && item.event.item._tag === 'TurnEnded';

/** The Transcript items of a stream, up to and including the first Turn end. */
export const untilTurnEnd = <E, R>(events: Stream.Stream<SessionStreamItem, E, R>) =>
  events.pipe(
    Stream.takeUntil(isTurnEnd),
    Stream.runCollect,
    Effect.map((items) => [...items]),
  );

export const transcript = (
  items: ReadonlyArray<SessionStreamItem>,
): ReadonlyArray<TranscriptItem> =>
  items.flatMap((item) => (item._tag === 'Transcript' ? [item.event.item] : []));

/** The agent's reply text in a list of Transcript items. */
export const agentReply = (items: ReadonlyArray<TranscriptItem>) =>
  items
    .map((item) => {
      if (item._tag === 'MessageDelta') return item.text;
      if (item._tag === 'Message' && item.role === 'agent') {
        return item.parts.map((part) => (part._tag === 'text' ? part.text : '')).join('');
      }
      return '';
    })
    .join('');

export const events = (id: SessionId, afterSeq?: number) =>
  Stream.unwrap(Sessions.use((s) => Effect.succeed(s.events(id, afterSeq))));

export const seqs = (items: ReadonlyArray<SessionStreamItem>) =>
  items.flatMap((item) => (item._tag === 'Transcript' ? [item.event.seq] : []));

/** Waits until the Agent's reply has started. */
export const agentAnswering = (id: SessionId, afterSeq?: number) =>
  events(id, afterSeq).pipe(
    Stream.filter(
      (item) =>
        item._tag === 'Transcript' &&
        item.event.item._tag === 'Message' &&
        item.event.item.role === 'agent',
    ),
    Stream.runHead,
  );

/** Waits until the Session's Agent status is `status`. */
export const agentStatus = (id: SessionId, status: LiveState['agentStatus']) =>
  events(id).pipe(
    Stream.filter((item) => item._tag === 'Live' && item.state.agentStatus === status),
    Stream.runHead,
  );

/** The first live state that satisfies `ready`. */
export const liveState = (id: SessionId, ready: (state: LiveState) => boolean) =>
  events(id).pipe(
    Stream.flatMap((item) =>
      item._tag === 'Live' && ready(item.state) ? Stream.make(item.state) : Stream.empty,
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

/** Two Projects on two folders, over one set of Sessions. */
export const withTwoProjects = <A, E>(
  body: (
    a: ProjectId,
    b: ProjectId,
  ) => Effect.Effect<
    A,
    E,
    | Sessions
    | Projects
    | AgentLifetime
    | AcpClient
    | SessionStore
    | Store
    | Settings
    | Remembered
    | BrowserService
  >,
) =>
  Effect.gen(function* () {
    const other = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-other-'))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );
    let folder = PROJECT_FOLDER;
    return yield* withSessionsCustom({ picker: Effect.sync(() => Option.some(folder)) }, (a) =>
      Effect.gen(function* () {
        folder = other;
        const added = yield* Projects.use((projects) => projects.add);
        if (added === null) return yield* Effect.die('the picker answered nothing');
        return yield* body(a, added.id);
      }),
    );
  }).pipe(Effect.scoped);

/** Session `a` of project A holding a live Turn, and an idle Session `b` of project B. */
export const crossProjectPair = (a: ProjectId, b: ProjectId, mode: 'ask' | 'auto' = 'ask') =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const sender = yield* sessions.create(a);
    yield* sessions.setOption({ sessionId: sender, option: 'permissionMode', value: mode });
    const senderServer = yield* holdingServer(sender);
    const target = yield* sessions.create(b);
    yield* turnReply(target, 'echo:ready');
    return { sender, senderServer, target };
  });

/** Waits for the Session's first Permission request in `state`. */
export const permissionRequest = (id: SessionId, state: 'pending' | 'answered' | 'cancelled') =>
  events(id).pipe(
    Stream.map((item) =>
      item._tag === 'Transcript' &&
      item.event.item._tag === 'PermissionRequest' &&
      item.event.item.state._tag === state
        ? item.event.item
        : undefined,
    ),
    Stream.filter((request) => request !== undefined),
    Stream.runHead,
    Effect.flatMap((head) =>
      Option.match(head, {
        onNone: () => Effect.die('the stream ended before the request'),
        onSome: Effect.succeed,
      }),
    ),
  );

export const permissionRequests = (items: ReadonlyArray<TranscriptItem>) =>
  items.filter((item) => item._tag === 'PermissionRequest');

export const messageText = (item: TranscriptItem): string =>
  item._tag === 'Message'
    ? item.parts.map((part) => (part._tag === 'text' ? part.text : '')).join('')
    : '';

export const userTexts = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<string> =>
  items.flatMap((item) =>
    item._tag === 'Message' && item.role === 'user' ? [messageText(item)] : [],
  );

export const steeredTexts = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<string> =>
  items.flatMap((item) =>
    item._tag === 'Message' && item.role === 'user' && item.steer === true
      ? [messageText(item)]
      : [],
  );

export const until = <E, R>(
  stream: Stream.Stream<SessionStreamItem, E, R>,
  predicate: (item: SessionStreamItem) => boolean,
) =>
  stream.pipe(
    Stream.takeUntil(predicate),
    Stream.runCollect,
    Effect.map((items) => [...items]),
  );

export const isSteerMessage = (text: string) => (item: SessionStreamItem) =>
  item._tag === 'Transcript' &&
  item.event.item._tag === 'Message' &&
  item.event.item.role === 'user' &&
  item.event.item.steer === true &&
  messageText(item.event.item) === text;

export const isPendingPermission = (item: SessionStreamItem) =>
  item._tag === 'Transcript' &&
  item.event.item._tag === 'PermissionRequest' &&
  item.event.item.state._tag === 'pending';

export interface McpServer {
  readonly url: string;
  readonly headers: ReadonlyArray<{ name: string; value: string }>;
}

/** One Turn on `id`: its reply text (the Agent streams it back). */
export const turnReply = (id: SessionId, prompt: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const store = yield* SessionStore;
    const after = (yield* store.replay(id)).at(-1)?.seq;
    yield* sessions.prompt(id, text(prompt));
    return agentReply(transcript(yield* untilTurnEnd(events(id, after))));
  });

/** Starts a Turn that reports its Spence MCP credential and then stays live, so the credential keeps working. */
export const holdingServer = (id: SessionId) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const store = yield* SessionStore;
    const after = (yield* store.replay(id)).at(-1)?.seq;
    yield* sessions.prompt(id, text('report-hold'));
    let reported = '';
    yield* events(id, after).pipe(
      Stream.takeUntil((item) => {
        if (item._tag === 'Transcript') {
          const entry = item.event.item;
          if (entry._tag === 'MessageDelta') reported += entry.text;
          else if (entry._tag === 'Message' && entry.role === 'agent')
            reported += agentReply([entry]);
        }
        try {
          JSON.parse(reported);
          return true;
        } catch {
          return false;
        }
      }),
      Stream.runDrain,
    );
    const server: McpServer | undefined = JSON.parse(reported)[0];
    return server === undefined ? yield* Effect.die('Spence MCP server missing') : server;
  });

/** One MCP `tools/call` over the wire, as an Agent would make it. */
export const callTool = (server: McpServer, name: string, args: Record<string, unknown>) =>
  Effect.promise(async () => {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const body = response.ok ? await response.json() : undefined;
    const content: string | undefined = body?.result?.content?.[0]?.text;
    let data: any;
    try {
      data = content === undefined ? undefined : JSON.parse(content);
    } catch {
      data = content;
    }
    return { status: response.status, isError: body?.result?.isError === true, data };
  });

/**
 * A Parent holding a live Turn with two owned Workers (`one`, `two`), each reachable over its own credential,
 * plus a Session of another tree that none of them may reach.
 */
export const messagingTree = (project: ProjectId) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const store = yield* SessionStore;
    const parent = yield* sessions.create(project);
    const parentServer = yield* holdingServer(parent);
    const spawn = (task: string) =>
      Effect.gen(function* () {
        const before = new Set((yield* store.listAll).map((meta) => meta.id));
        yield* callTool(parentServer, 'delegate', { task });
        const created = (yield* store.listAll).find((meta) => !before.has(meta.id));
        if (created === undefined) return yield* Effect.die('Worker missing');
        return created.id;
      });
    const one = yield* spawn('echo:one');
    const two = yield* spawn('echo:two');
    const oneServer = yield* holdingServer(one);
    const stranger = yield* sessions.create(project);
    return { parent, parentServer, one, oneServer, two, stranger };
  });

export const optionOfKind = (
  request: { readonly options: ReadonlyArray<{ readonly id: string; readonly kind: string }> },
  kind: string,
) => request.options.find((option) => option.kind === kind)?.id ?? 'missing-option';

/** The sender's call blocks on the user's answer to the Permission request it raised. */
export const sendAnswering = (
  pair: { readonly sender: SessionId; readonly senderServer: McpServer },
  args: Record<string, unknown>,
  kind: string,
) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const store = yield* SessionStore;
    const after = (yield* store.replay(pair.sender)).at(-1)?.seq;
    const call = yield* Effect.forkChild(callTool(pair.senderServer, 'send_message', args));
    const request = yield* events(pair.sender, after).pipe(
      Stream.map((item) =>
        item._tag === 'Transcript' &&
        item.event.item._tag === 'PermissionRequest' &&
        item.event.item.state._tag === 'pending'
          ? item.event.item
          : undefined,
      ),
      Stream.filter((found) => found !== undefined),
      Stream.runHead,
      Effect.flatMap((head) =>
        Option.match(head, {
          onNone: () => Effect.die('the stream ended before the request'),
          onSome: Effect.succeed,
        }),
      ),
    );
    yield* sessions.answerPermission(pair.sender, request.id, optionOfKind(request, kind));
    return { request, sent: yield* Fiber.join(call) };
  });
