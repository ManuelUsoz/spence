# ACP today: SDK, session updates, models, modes, load, auth

Research for issue #2 (map #1). Answers: what does the Agent Client Protocol offer a client like Spence right now?

## Sources and versions

Everything below was read on 2026-11-11 from primary sources:

- **Spec repo** `agentclientprotocol/agent-client-protocol`, commit `f3ed0fca` (2026-11-10), schema release **1.17.0**.
  The docs site agentclientprotocol.com is built from `docs/` in this repo.
  - Stable v1 schema: `schema/v1/schema.json`, method list `schema/v1/meta.json`.
  - Unstable v1 additions: `schema/v1/schema.unstable.json`, `meta.unstable.json`.
  - Spec pages: `docs/protocol/v1/*.mdx` (cited below as `v1/<page>`), at
    `https://agentclientprotocol.com/protocol/v1/<page>`.
- **Wire protocol version: `1`** (`protocolVersion` in `initialize`, an integer that only changes on breaking
  changes). ACP **v2 is a Draft** (announced 2026-07-20, `docs/announcements/acp-v2-draft.mdx`): "various pieces can,
  and will, change before stabilization"; implementers must gate it behind version negotiation and feature flags and
  keep supporting v1.
- **TypeScript SDK** `@agentclientprotocol/sdk` **2.6.0** (npm `latest`, published 2026-11-10), repo
  `agentclientprotocol/typescript-sdk`. Read from the published tarball (`README.md`, `MIGRATION_STABLE_UNSTABLE.md`,
  `dist/v1/stable/acp.d.ts`) and `src/examples/client.ts` on `main`.

"Stable" below means present in `schema/v1/schema.json`. "Unstable" means only in `schema.unstable.json`: it may change
or vanish in any release.

## 1. The TypeScript SDK

**Package and maturity.** `@agentclientprotocol/sdk`, Apache-2.0, authored by Zed Industries. Reached 1.0.0 on
2026-06-24 (`announcements/sdk-1-0-releases.mdx`). 2.0.0 on 2026-10-19 was a breaking split; since then it has shipped
2.0.1 through 2.6.0 in three weeks. It moves fast: pin an exact version, as we do for Effect.

**Entrypoints** (README, package.json `exports`):

| Import | Surface |
| --- | --- |
| `@agentclientprotocol/sdk` | Stable ACP v1 (default) |
| `@agentclientprotocol/sdk/unstable` | v1 plus unstable features |
| `@agentclientprotocol/sdk/experimental/v2` | Stable feature set of the v2 draft (v2 itself is experimental) |
| `@agentclientprotocol/sdk/experimental/v2/unstable` | Full v2 draft |

Use one entrypoint consistently. The stable entrypoint's request parsing **strips unstable fields**
(MIGRATION_STABLE_UNSTABLE.md), so a stable-only client silently never sees unstable payloads.

**Dependencies.** No runtime `dependencies`; `zod` (`^3.25.76 || ^4.0.0`) is a required peer and is imported at runtime
as `zod/v4` (`dist/core/schema-deserialize.js`) to validate every message. `@modelcontextprotocol/server` is an optional
peer. ESM only (`"type": "module"`).

**Client API** (`dist/v1/stable/acp.d.ts`):

- `client({ name })` returns a `ClientApp`. Register handlers with `onRequest(methods.client.session.requestPermission, ...)`
  and `onNotification(methods.client.session.update, ...)`, then `connect(stream)` (long-lived `ClientConnection` with
  `agent: ClientContext`, `signal`, `closed`, `close()`) or `connectWith(stream, async (ctx) => ...)` (scoped).
- `ctx.request(methods.agent.session.new, params)` and friends are typed by method literal; `SendRequestOptions` takes
  an abort signal.
- `ctx.buildSession(cwd).start()` returns an `ActiveSession` that queues that session's `session/update`s in arrival
  order (`nextUpdate()`, `prompt()`, `dispose()`).
- Note from the docs: `onNotification` handlers "can run concurrently" if they await; to keep update order, serialize
  per session yourself (or use `ActiveSession`).
- `RequestError` for JSON-RPC errors; `PROTOCOL_VERSION`, `AGENT_METHODS`, `CLIENT_METHODS` constants.

**stdio transport.** The SDK does not spawn processes. You spawn the Agent with `node:child_process` and adapt its pipes
with `acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout))` (`src/examples/client.ts`). The spec
transport (`v1/transports`): newline-delimited JSON-RPC 2.0, UTF-8, no embedded newlines, stdout is protocol only, stderr
is free-form logging the client may capture. No JSON-RPC batches (a batch gets `-32600`). Streamable HTTP/WebSocket is
an RFD, not spec; the SDK ships it under `/experimental/*`.

**Fit with Effect.** The SDK is Promise and Web-Streams based. Two options:

- *Wrap it* (recommended): one `electron/` service owns the `ChildProcess` and the `ClientConnection`
  (`Effect.acquireRelease`: spawn + connect / `close()` + kill). Outgoing calls become `Effect.tryPromise` with the
  fiber's `AbortSignal` passed in `SendRequestOptions`. `session/update` notifications are pushed into a per-session
  `Queue`/`PubSub` and exposed as a `Stream`; `session/request_permission` handlers return a Promise that resolves from a
  `Deferred` the UI completes. Errors map at the boundary to our `Schema.TaggedError`s; ACP types never leave the
  adapter (standing decision in #1). We get schema validation, method typing and capability-correct parsing for free.
- *Hand-roll JSON-RPC*: Effect's `RpcServer`/`RpcClient` speak their own protocol, not JSON-RPC 2.0, so we would write
  framing, id correlation, bidirectional requests, `$/cancel_request` and schemas ourselves (the JSON schema is
  exported at `@agentclientprotocol/sdk/schema/v1/schema.json` for generating Effect Schemas). Only worth it if the
  SDK's churn or zod dependency becomes a problem.

## 2. `session/update` kinds

Notification `session/update` with `{ sessionId, update: { sessionUpdate: <kind>, ... } }` (`v1/prompt-turn`,
`SessionUpdate` in schema). Updates may arrive outside a prompt turn (e.g. commands after `session/new`, replay during
`session/load`).

**Stable (14):**

| Kind | Payload |
| --- | --- |
| `user_message_chunk` | `content: ContentBlock`, optional `messageId` |
| `agent_message_chunk` | same; chunks with the same `messageId` form one message, a new id starts a new message |
| `agent_thought_chunk` | same, for reasoning |
| `tool_call` | `toolCallId` (req), `title` (req), `name?`, `kind?` (`read edit delete move search execute think fetch switch_mode other`), `status?` (`pending` default, `in_progress`, `completed`, `failed`), `content?: ToolCallContent[]`, `locations?: {path, line?}[]`, `rawInput?`, `rawOutput?` |
| `tool_call_update` | `toolCallId` plus any of the above fields; only changed fields are sent (patch) |
| `plan` | `entries: {content, priority: high/medium/low, status: pending/in_progress/completed}[]`; always the full list, client replaces |
| `available_commands_update` | `availableCommands: {name, description, input?: {hint}}[]`; commands run by sending `/name args` as prompt text |
| `current_mode_update` | `currentModeId` (legacy modes API) |
| `config_option_update` | `configOptions`: the complete config state |
| `session_info_update` | `title?`, `updatedAt?` |
| `usage_update` | `used`, `size` (context tokens), `cost?: {amount, currency}` |
| `notice` | `severity` (`info warning error`, open enum), `title`, `description?`; live only, not replayed. Only if client advertises `session.notices` |
| `compaction_update` | `compactionId`, `status` (`in_progress completed failed cancelled`), `summary?`, `error?`; only if client advertises `session.compaction` |
| `compaction_summary_chunk` | `compactionId`, `content` |

`ToolCallContent` (`v1/tool-calls`) is one of:

- `{ type: "content", content: ContentBlock }`
- `{ type: "diff", path, oldText?, newText }` (whole-file old/new text; `oldText` null for a new file)
- `{ type: "terminal", terminalId }` (only meaningful with the client `terminal` capability, which Spence won't offer)

**Unstable additions (v1):** `plan_update`, `plan_removed` (ID-based plans), `subagent_update`, `session_message`,
`session_message_chunk`; `usage` on the `session/prompt` response.

**v2 draft (not usable yet):** prompt response returns the user `messageId` instead of ending a turn, an idle state,
patch semantics for messages and streaming tool call content, structured diffs (add/delete/modify/move/copy +
`git_patch`) replacing `oldText`/`newText`.

## 3. Models, modes, effort

**Session Config Options are the mechanism** (stable since 2026-02-04, `v1/session-config-options`). `session/new`,
`session/load` and `session/resume` responses may carry `configOptions: SessionConfigOption[]`:

- `{ id, name, description?, category?, type: "select", currentValue, options }` where `options` is a flat list of
  `{value, name, description?}` or groups `{group, name, options}`.
- `type: "boolean"` only if the client advertises `clientCapabilities.session.configOptions.boolean: {}`.
- Unknown `type`: client ignores the option; the Agent keeps its `currentValue`.
- Array order is the Agent's priority; clients should keep it.
- `category` (UX hint only, never needed for correctness): `mode`, `model`, `model_config` (e.g. context size,
  speed/quality; stabilized 2026-06-24), `thought_level`, `_custom` names.

Changing a value: `session/set_config_option { sessionId, configId, value }` (plus `type: "boolean"` for booleans),
allowed at any time, including mid-turn. The response is the **complete** option list (changing the model can change the
other options). The Agent can change values itself and send `config_option_update` with the full list.

**Models:** a `select` option with `category: "model"`. The old unstable `session/set_model` and `models` response
fields were **removed** on 2026-06-01 (`rfds/updates.mdx`). There is no list of models outside a session.

**Effort:** no dedicated field. It is a config option with `category: "thought_level"`; values and labels are the
Agent's. Our "effort" control is whatever the Agent exposes under that category, if anything.

**Modes:** legacy `modes: { currentModeId, availableModes: {id, name, description?}[] }` in session responses,
`session/set_mode { sessionId, modeId }`, and `current_mode_update`. Still stable but deprecated: "Modes will be removed
in a future version". If an Agent sends both, clients that support config options use `configOptions` and ignore
`modes`. Agents are told to send both during the transition, so older Agents may only send `modes`.

**Unstable:** `configOptions` (initial values) on the `session/new` request and `session/options` (added 1.17.0, 2026-11-10).

## 4. `session/request_permission`

Agent-to-client request (`v1/tool-calls#requesting-permission`):

```json
{ "sessionId": "...", "toolCall": { "toolCallId": "call_001", "...": "ToolCallUpdate fields" },
  "options": [ { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" } ] }
```

- `toolCall` is a `ToolCallUpdate` (patch for an existing tool call; may carry title, kind, content, locations).
- `options[]`: `optionId`, `name` (shown to user), `kind`: `allow_once`, `allow_always`, `reject_once`, `reject_always`.
- Response: `{ outcome: { outcome: "selected", optionId } }` or `{ outcome: { outcome: "cancelled" } }`.
- The **Agent** owns remembered decisions (`*_always`): it stores the scope and stops asking. `kind` is a UI hint;
  `name` describes the scope.
- Security guidance: describe the operation from `kind`, `locations` and content, show commands and paths in full,
  treat `title` as Agent-authored text, don't auto-approve on `title`/`name` alone.
- After `session/cancel`, the client **MUST** answer every pending permission request with `cancelled`.
- v2 draft: permission requests get their own `title`/`description` and an extensible `subject` (e.g. `command`).

## 5. `session/load` and other resume options

| Method | Capability flag | Replays history? | Status |
| --- | --- | --- | --- |
| `session/load { sessionId, cwd, mcpServers, additionalDirectories?, systemPrompt? }` | `agentCapabilities.loadSession: true` | **Yes**: the Agent MUST replay the entire conversation as `session/update` (user/agent chunks, tool calls, compactions), then respond | Stable |
| `session/resume { sessionId, cwd, mcpServers, ... }` | `agentCapabilities.sessionCapabilities.resume: {}` | **No**: MUST NOT replay; restores context, returns when ready | Stable since 2026-04-22 |
| `session/list` | `sessionCapabilities.list` | n/a: lists `{sessionId, cwd, title?, updatedAt?}` | Stable |
| `session/close` | `sessionCapabilities.close` | n/a: cancels work and frees resources; idempotent | Stable |
| `session/delete` | `sessionCapabilities.delete` | n/a | Stable |
| `session/fork`, `session/archive`, `session/status`, `session/set_title` | various | | Unstable |

- Clients MUST NOT call a method whose capability is absent. `session/load` stays on the top-level `loadSession` flag
  ("will be unified in future versions").
- Load and resume responses may include `modes` and `configOptions`.
- `cwd` on resume must match the session's `cwd`. `mcpServers` and `additionalDirectories` must be resent in full.
- Notices are not replayed. Message ids in replay are optional.
- For Spence (we keep our own transcript): `session/resume` restores Agent context without a replay we'd have to
  dedupe; with only `loadSession`, we must swallow or reconcile the replayed updates.

## 6. `initialize`, prompt capabilities, auth

**Client sends** `{ protocolVersion: 1, clientCapabilities, clientInfo: {name, title?, version} }`. The Agent answers
with the same version or its latest; if the client can't speak it, it should close and tell the user. Omitted
capabilities mean unsupported.

Client capabilities (stable): `fs.readTextFile`, `fs.writeTextFile`, `terminal`, `auth.terminal`, `elicitation`
(`form`/`url`), `session.configOptions.boolean`, `session.compaction`, `session.notices`. Spence plans `fs`/`terminal`
off; the rest are cheap opt-ins for display.

**Agent replies** `{ protocolVersion, agentCapabilities, authMethods, agentInfo }`, with `agentCapabilities`:

- `loadSession` (bool)
- `promptCapabilities`: `image`, `audio`, `embeddedContext` (all default false). Baseline every Agent MUST accept:
  `text` and `resource_link`. Clients MUST restrict prompt content to what's advertised. **Image support is per Agent
  (per connection), not per model.**
- `mcpCapabilities`: `http`, `sse` (stdio MCP is mandatory)
- `sessionCapabilities`: `list`, `delete`, `additionalDirectories`, `systemPrompt`, `resume`, `close`
- `auth.logout`

`ContentBlock` (`v1/content`): `text`, `image` (base64 `data`, `mimeType`), `audio`, `resource_link` (`uri`, `name`, ...),
`resource` (embedded `TextResourceContents` or `BlobResourceContents`).

**Authentication** (`v1/authentication`): `authMethods[]` in the initialize response, each `{id, name, description?}`
plus a `type`:

- `agent` (default when `type` is missing): client calls `authenticate { methodId }`, gets `{}`.
- `terminal` (`args`, `env`): only if the client advertised `auth.terminal: true`. The client runs the *same* Agent
  command in an interactive terminal with the extra args/env, waits for exit code 0, then reconnects and
  re-initializes. Never `authenticate` with a terminal method. Launch-safety rules: no shell, don't apply risky env
  (`PATH`, `NODE_OPTIONS`, proxies...) without approval, show args/env first.
- Unauthenticated `session/new` fails with error **`-32000` (auth required)**. `logout` exists if `auth.logout` is
  advertised.
- Unstable: `auth/status` method and `auth/status_update` notification.

## 7. `session/cancel`

- A **notification** `{ sessionId }` (no response) (`v1/prompt-turn#cancellation`).
- Client SHOULD mark unfinished tool calls of the turn `cancelled` locally right away and MUST answer pending permission
  requests with `cancelled`.
- Agent SHOULD stop model and tool work ASAP, MAY still send updates, then MUST answer the original `session/prompt`
  with `stopReason: "cancelled"` (not an error). Client should still accept updates after cancel.
- Separate generic mechanism: `$/cancel_request { requestId }` (stable) cancels any request; the
  receiver answers normally or with error `-32800`.
- Stop reasons: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.
- v2 draft: `session/cancel` only cancels foreground work (background work continues).

## Unstable parts, in one list

- All of ACP v2 and the SDK's `/experimental/*` entrypoints.
- v1 unstable: `session/fork`, `session/archive`/`unarchive`, `session/status`, `session/options`, `session/set_title`,
  `configOptions` on `session/new` requests, `providers/*`, `auth/status`, `mcp/message`, `proxy/*`, subagent updates,
  `plan_update`/`plan_removed`, `session_message*`, turn `usage` on the prompt response.
- Deprecated but stable: session modes (`modes`, `session/set_mode`, `current_mode_update`).
- Removed: `session/set_model` and session model state.
