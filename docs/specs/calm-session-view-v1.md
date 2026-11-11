# Spec: calm session view v1

Status: ready to split into implementation tickets. Source: the map
[Wayfinder: calm session view v1](https://github.com/ManuelUsoz/spence/issues/1) and its closed tickets, linked by name
in each section. Where a ticket and this spec disagree, the later ticket wins and this spec says so.

Words in **bold** are defined in `GLOSSARY.md`. Rules for code are in `AGENTS.md`, `CODING_STANDARDS.md` and the ADRs
in `docs/adr/`. This spec does not repeat them.

## 1. What v1 is

Spence is a calm desktop client for coding Agents. A **Project** is a local folder. It holds many **Sessions**. Each
Session is one conversation with one **Agent**, for its whole life. The user works in one window, with one **Tab** per
open Session, from any Project. Spence ships in English and Spanish.

Noise reduction is the product. When in doubt, fold, hide or summarize.

v1 has one Agent, **Claude**, run through `@agentclientprotocol/claude-agent-acp`.

Design reference: [Spence session view prototype](https://claude.ai/artifact/5F9zYQVQpzXAdySinaxf1m) (the `Main`
board's session surface only), plus the prototype branches `prototype/calm-thread` (variant B) and
`prototype/project-sidebar` (variants C and B).

## 2. Architecture

### 2.1 Process and layering

- ACP lives only in `electron/`. The renderer never sees an ACP type
  ([ADR 0002](../adr/0002-agents-speak-acp-only-behind-an-adapter-in-main.md)).
- ACP is spoken through `@agentclientprotocol/sdk`, stable v1 import only (not `/unstable`, not v2), with an exact
  version pinned. It is wrapped in one Effect service. No hand-rolled JSON-RPC.
  ([ACP today](https://github.com/ManuelUsoz/spence/issues/2))
- Code layout, gemini-cli style with camelCase file names:

  ```
  electron/acp/acpStdioTransport.ts     spawn + ndJsonStream; the seam for a utility process later
  electron/acp/acpClientDispatcher.ts   client-side ACP requests (permission, ...)
  electron/acp/acpSessionManager.ts     ACP sessions per Agent connection
  electron/acp/acpSession.ts            one ACP session
  electron/acp/acpMappers.ts            ACP -> Spence contract
  electron/acp/acpErrors.ts
  electron/agents/<agent>/              what differs per Agent: Catalog entry, Effort map, Permission mode map, limits
  ```

- The renderer reaches main only through `DesktopApi` (ADR 0001).

### 2.2 RPC domains

Five groups in `src/shared/`, merged into `DesktopRpcs`: `projects`, `agents`, `sessions`, `settings`, `shell`.
Every id in a contract is Spence's own branded UUID (`ProjectId`, `SessionId`, `TurnId`, `StepId`, ...). ACP ids stay
in main.

### 2.3 Streaming

([Streaming session events](https://github.com/ManuelUsoz/spence/issues/4))

- `stream: true` RPCs work over the existing MessagePort protocol and `layerSchemaBinary` unchanged.
- Transport backpressure reaches main. So each Session has a **non-blocking event hub** in main (unbounded or sliding
  `PubSub`). A stuck renderer must never stall an Agent's read loop.
- Unsubscribing interrupts the handler. Stopping a Turn is a separate RPC, never a stream interrupt.
- A renderer reload drops all streams. The renderer resubscribes with `afterSeq`.
- Prerequisite bug: "A second RpcClient in a page never receives responses" must be fixed first (the fix is on the
  `research/rpc-streaming` branch).
- Tests: `makeDesktopTestLayer` covers streams. Add one electron-side MessageChannel round-trip spec per streaming
  contract.

### 2.4 Storage

([Storing transcripts and reopening Sessions](https://github.com/ManuelUsoz/spence/issues/9),
[ADR 0003](../adr/0003-spence-keeps-its-own-transcripts-as-jsonl-under-userdata.md))

Everything lives in `<userData>/spence/`. Spence never writes into a Project folder. Main is the only writer, guarded
by the single-instance lock. A second launch focuses the first window.

```
<userData>/spence/
  projects.json          { version, projects: [{ id, name, path, addedAt, lastUsedAt, removedAt?, settings? }] }
  settings.json          { version, ...keys }  sparse, only changed keys
  state.json             { version, agents: { [agentId]: { lastModel?, lastEffort?, models? } } }
  agent-deletes.json     { version, items: [{ agentId, acpSessionId, queuedAt, attempts }] }
  sessions/<sessionId>/
    session.json         see below
    transcript.jsonl     append-only, seq-numbered events (Effect Schema)
    blobs/<sha256>       image, audio and blob resource parts
  logs/agents/<agent>.log   rotating stderr + lifecycle per Agent
  logs/agents/install.log   npm output of installs (beside the Agent logs)
```

- `session.json`: `id`, `projectId`, `cwd` (the Project folder in v1), `agentId`, `userTitle?`, `autoTitle?`,
  `autoTitleIsPlaceholder`, `createdAt`, `lastActivityAt`, `archivedAt?`, `acpSessionIds` (every ACP session id the
  Session ever had, newest last), and the last chosen option values plus the Permission mode.
- Transcript writes are batched about every 250 ms and at Turn end. Main inlines blobs again when sending to the
  renderer, so the contract carries data, not hashes.
- Every file has a `version`. Migrations are forward-only and run on first read. A file from a newer version is
  refused, never overwritten. `settings.json` is decoded key by key: an invalid key falls back to its default with a
  log line and never blocks startup. Unknown keys are dropped.

## 3. Agents

### 3.1 Catalog and discovery

([What the Agent catalog lists](https://github.com/ManuelUsoz/spence/issues/13),
[Finding and launching known ACP Agents](https://github.com/ManuelUsoz/spence/issues/3))

- The **Catalog** is hand-written in main. v1 holds only Claude (`@agentclientprotocol/claude-agent-acp`, binary
  `claude-agent-acp`). Each entry also holds its registry id (reference only), Effort map, Permission mode map and
  image limits.
- Only `@agentclientprotocol/*` adapters count. Vendor CLIs (`claude`) and native-ACP CLIs are never probed or used.
- **Installed** = the adapter resolves on the merged PATH. It is re-scanned each time a new Session is about to start,
  and again at every spawn.
- Merged PATH, computed once per run:
  - Windows: `process.env.PATH` merged with a fresh read of the HKCU and HKLM `Environment` registry keys.
  - macOS / Linux: `$SHELL -ilc` with a timeout, falling back to `process.env.PATH`. Passed to the Agent as `env.PATH`.
- Resolution: walk PATH, trying the bare name, then `.exe`, `.cmd`, `.bat`. Spence spawns the absolute path.
  - `.exe`: spawn directly.
  - `.cmd` / `.bat`: `cmd.exe /d /s /c "<abs path> <constant args>"` with `windowsVerbatimArguments` and
    `windowsHide`. Arguments are validated constants only. Never `shell: true`.
- The process starts in the user's home folder. The Project folder goes only in `session/new`'s `cwd`.
- No Agent picker in v1. Every Session still stores its `agentId`.

### 3.2 Install offer

- When Claude is not installed, at new Session and in Settings' Agents group: "Claude isn't installed. Install it?"
  with **Install** and **Show command**. Install first shows the exact `npm install -g
@agentclientprotocol/claude-agent-acp`.
- No `npm` on PATH: no button, only the command and a note that Node.js is needed.
- The install runs in main with the npm from the merged PATH. The UI shows an indeterminate bar "Installing Claude…",
  with elapsed time after about 10 s. Success re-scans and continues straight into the new Session. Failure shows a
  one-line reason, the command to copy and a link to the log. Nothing is persisted; the offer comes back next time.
- No update offers in v1.

### 3.3 Process lifetime

([Where Agent processes run](https://github.com/ManuelUsoz/spence/issues/6))

- One process per Agent, spawned from main under `MainRuntime`, shared by all its Sessions across Projects. Spawning is
  memoized per Agent. `initialize` and auth happen once per process.
- Spence advertises no `fs` or `terminal` capability. It advertises `auth.terminal`, `session.compaction` and
  `session.notices`. `protocolVersion` must be 1.
- **Start**: lazily, when a Tab activates. A new Session starts the process (if needed) and runs `session/new` at once,
  so the Composer controls fill. At app start only the active restored Tab connects. Reading a Session without a Tab
  starts nothing.
- **ACP session open** while its Session has an open Tab **or** a running Turn. When neither, `session/close` (or just
  forget it if the Agent lacks close).
- **Process exit**: after 5 minutes with zero ACP sessions.
- **Crash**: no automatic restart. The process restarts on the next prompt.
- **Quit**: if any Turn is running or waiting on a Permission request, confirm "N Sessions are still working. Quit
  anyway?". Then `session/cancel` the running ones, close each Agent's stdin, and kill the process tree after about
  2 s (`taskkill /T` on Windows). Closing the last window quits on Windows and Linux; on macOS the app and its Agents
  stay alive. No tray in v1.
- **Logs**: stderr and lifecycle (spawn command, exit code, signal) to `logs/agents/<agent>.log`. Never in the thread.

### 3.4 Agent status and problems

([Agent missing, logged out, or crashed](https://github.com/ManuelUsoz/spence/issues/10), amended by
[The calm thread](https://github.com/ManuelUsoz/spence/issues/12))

**Agent status**: ready · starting · not installed · needs login · can't start · stopped. "Not running" is normal and
never shown.

- Agent-level problems show in the **Agent bar**: a one-line notice docked on top of the Composer, with one action.
  The Composer always stays and the user can type. Send is disabled until the Agent is ready.
  - Not installed: the install offer (3.2). Also when an installed adapter vanished from PATH.
  - Can't start (spawn error, exit during `initialize`): **Try again** and **Open log**. Retried only on user action
    (Try again, new Session, prompt). No timer, no backoff.
  - `protocolVersion` ≠ 1: "Claude's adapter isn't compatible with this Spence" plus the
    `npm install -g …@latest` command to copy. No button.
  - Needs login: see below.
- Turn-level problems end the Turn `failed` in the thread. The thread never records the Agent's health.
- **Needs login** is detected only from error `-32000`, at any point. That Turn fails `needsLogin` and every Session of
  that Agent shows the bar. **Log in** runs the first `authMethods` entry headless from main (Claude's opens the
  browser). The bar shows "Finish logging in in your browser…", **Cancel**, "Other ways" (the other methods by the
  Agent's names) and the command to copy. Exit 0 restarts the Agent and the status becomes ready. Nothing is sent
  automatically.
  - To verify during implementation: whether `--cli auth login --claudeai` runs without a TTY. If not, open it in a
    real console window (`cmd.exe /c start`). The user-facing flow stays the same.
- **Crash**: Sessions with a running Turn get `failed { reason: agentStopped }` and Attention. Idle Sessions show
  nothing; their next prompt restarts the Agent and resumes. The failed Turn reads "Claude stopped unexpectedly", with
  the stderr tail and **Open log** folded.
- **Agent error during a Turn** (`-32603` and others): `failed { reason: agentError, detail }`, the Agent's text
  verbatim, never translated. No `errorKind` mapping. The duplicate copy the adapter also streams is dropped (last
  Message part equal to `detail`). Status stays ready.
- After any failed Turn, the failed Message (with its Images) goes back into the Composer if the Composer is empty.
  No Retry button.

## 4. The `sessions` contract

([Session contract the renderer sees](https://github.com/ManuelUsoz/spence/issues/7), amended by
[Model, effort and permission controls](https://github.com/ManuelUsoz/spence/issues/8),
[Agent missing, logged out, or crashed](https://github.com/ManuelUsoz/spence/issues/10) and
[Where a Session's title comes from](https://github.com/ManuelUsoz/spence/issues/22))

### 4.1 RPCs

| RPC                                                            | Behaviour                                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Session.create({ projectId })`                                | Starts a draft: Tab, process, `session/new`. Not persisted until the first prompt.                                |
| `Session.prompt({ sessionId, parts })`                         | Returns `turnId` once accepted. `Busy` while a Turn runs.                                                         |
| `Session.cancel({ sessionId })`                                | ACP `session/cancel`. No-op when nothing runs.                                                                    |
| `Session.answerPermission({ sessionId, requestId, optionId })` | No-op if no longer pending.                                                                                       |
| `Session.setOption({ sessionId, option, value })`              | `model`, `effort` or `permissionMode`. The new state arrives on the stream.                                       |
| `Session.clearContext({ sessionId })`                          | Closes the ACP session, opens a fresh one, writes `ContextCleared { reason: cleared }`. `Busy` while a Turn runs. |
| `Session.rename({ sessionId, title })`                         | User title; empty restores the automatic title. Never sent to the Agent.                                          |
| `Session.archive` / `unarchive` / `delete` (`{ sessionIds }`)  | Bulk-capable, per Project (section 7).                                                                            |
| `Session.events({ sessionId, afterSeq? })`                     | Stream: live-state snapshot, then transcript events after `afterSeq`, then live. Dedup by `seq`.                  |

`Session.create`, `rename`, `archive`, `unarchive` and `delete` are implied by later tickets; their exact shapes are
for the implementation tickets.

Errors: one `SessionError { reason: NotFound | Busy | AgentUnavailable, detail }`, with `AgentUnavailable` carrying
`NotInstalled | NeedsLogin | CantStart`. Everything else is a defect. A crash is a stream event, never an RPC error.

### 4.2 Live state (snapshot plus changes, not persisted)

- `agentStatus` (3.4).
- `title`: `{ user?, auto?, autoIsPlaceholder }`. The renderer shows user ?? auto ?? "New Session".
- `options`: `{ model?, effort?, permissionMode }` in Spence's vocabulary, each with the choices the Agent offers.
- `commands: { name, description, hint? }[]`, replaced whole.
- `canAttachImages` and the Agent's image limits.
- "Turn running" is derived from the transcript (a Turn started and not ended), not stored.

### 4.3 Transcript items

Main folds ACP's partial updates into whole items, keyed by id. Only Message and Thought text stream, as append-only
deltas. Only transcript events carry `seq` and are persisted.

- **Turn**: started (with a snapshot of Model, Effort and Permission mode), then ended with outcome `done`,
  `cancelled`, `refused`, `cutShort { limit }` or `failed { reason, detail }`. Failure reasons: `agentError`,
  `agentStopped`, `needsLogin`, `interrupted`.
- **Message** (user | agent): ordered parts: `text`, `link { uri, name, title?, mimeType?, size? }`,
  `image { mimeType, data }`, `audio { mimeType, data }`, `resource { uri, mimeType?, text | blob }`. A text delta
  appends to the last text part. ACP `user_message_chunk` is ignored.
- **Thought**: reasoning text, apart from the Message.
- **Step** (from `tool_call` + `tool_call_update`): `id`, `title`, `kind: read | edit | delete | move | search |
execute | fetch | other`, `status: pending | running | done | failed | cancelled`, `files` (relative to the
  Project), `diffs { path, before?, after }`, `output` (text). Dropped: `rawInput`, `rawOutput`, terminal content.
  Main cancels unfinished Steps when a Turn is cancelled.
- **Plan**: replaced whole.
- **Permission request**: `{ id, stepId, options: { id, label, kind: allowOnce | allowAlways | rejectOnce |
rejectAlways }[], state: pending | answered { optionId, by: user | policy } | cancelled }`. Main answers pending
  requests `cancelled` toward ACP on cancel or Turn end.
- **Compaction**: `{ id, status: running | done | failed | cancelled, summary }`.
- **Notice**: `{ severity: info | warning | error, title, description? }`.
- **ContextCleared** `{ reason: cleared | lost }`.

Dropped in v1: `usage_update`, `session/load` replay.

### 4.4 Reopening a Session

On first Tab activation after a restart:

1. `session/resume` with the last ACP session id. If unsupported or it fails:
2. `session/load`, replayed updates discarded by the adapter. If unsupported or it fails:
3. `session/new`. Nothing from the old Transcript is sent. Append `ContextCleared { reason: lost }`.

Then re-apply the stored Model and Effort with `set_config_option` if still offered (dropped silently otherwise) and
always the Permission mode. A Turn that started and never ended is closed `failed { reason: interrupted }`, and its
pending Permission request becomes `cancelled`.

## 5. The Session view

### 5.1 The thread

([The calm thread](https://github.com/ManuelUsoz/spence/issues/12), variant B, prototype commit `0e5ec0f`)

- **While a Turn runs**: one **Ticker** line under the user's Message, never a list of Steps. A fixed spinner, a kind
  icon (read, edit, search, execute, ..., thinking, writing), then only the target (file name, command, search text),
  and the elapsed time on the right. No state words; the word lives only in the tooltip and accessible name. While the
  Agent thinks, the Ticker shows the end of the Thought in muted italics. Agent text streams above the Ticker.
- **When a Turn ends**, its work folds into a **Receipt** under the reply: changed-file chips `name +a −d` (a chip
  opens that file's diff inline), then "N steps" (opens the Step list: kind icon, target, auto / rejected marks,
  failed ✕) and "Thought Ns" (opens the Thought). Total time on the right.
- **Outcomes**: `done` shows nothing. Stopped, declined (`refused`) and cut short are one muted line. `failed` is a red
  block: `agentError` text verbatim; `agentStopped` with folded stderr tail and Open log.
- Notices and Compactions stay in the thread in order. Context cleared is a divider.
- Message parts: Images as a row of fixed-height thumbnails above the text (click opens a lightbox: Spartan dialog,
  Esc closes, ←/→ move within that Message). Links are clickable through `Shell.openLink` (5.5).
- A Turn's options snapshot is never shown in the thread.
- Background Tabs keep their live state and loaded transcript; nothing is unloaded in v1.

The Spartan `trace` component (`@ui/trace`) is the base for the Ticker and the Receipt's Step list.

### 5.2 The Dock

Just above the Composer; empty when no Turn runs.

- A pending **Permission request** takes the Dock: the Step's title (e.g. the command) and all the Agent's options as
  buttons, allow-once first and primary, keys 1–4. The Ticker then says "Waiting for you below" with the amber
  Attention dot.
- Otherwise, if the Turn has a **Plan**: "Plan 2 of 4 · ‹current entry›" with a segmented bar. Click expands the list.
  The Plan is not shown in the thread.
- Requests answered by policy never reach the Dock; they show as "auto" on their Step in the Receipt.

### 5.3 The Composer

([Model, effort and permission controls](https://github.com/ManuelUsoz/spence/issues/8),
[Images in the composer](https://github.com/ManuelUsoz/spence/issues/18),
[What Settings holds](https://github.com/ManuelUsoz/spence/issues/20))

The Composer always stays, with the Agent bar (3.4) as a notice on top when needed.

**Controls**

- **Model**: the Agent's list, named as the Agent names it. Hidden if the Agent offers none.
- **Effort**: always low / medium / high / max. Each Agent has a `Record` in `electron/agents/<agent>/` mapping levels
  to its values. Levels the Agent lacks are disabled with the tooltip "this Agent doesn't offer it". Hidden if the
  Agent has no effort option.
- **Permission mode**: always Ask / Auto, always shown.
  - Ask: the Agent's mode that asks the most. Nothing auto-answered.
  - Auto: the Agent's own auto mode (Claude has one); requests it still sends go to the user. For an Agent without
    one, the map entry is `{ agentMode, autoAllow: true }` and main answers every request `allow_once`, recorded
    `by: policy`.
  - Main's automatic answers are only ever "once".
  - If the Agent switches itself to a mode outside the map (e.g. plan mode), Spence leaves it alone and keeps showing
    Ask or Auto. It re-applies its mapping on the next user change or new ACP session.
- Every other Agent option is hidden.
- Controls fill when the Tab opens, with a quiet loading state while the Agent starts. They stay enabled during a Turn.
- New Session values: Permission mode = Project setting ?? global Setting (Auto out of the box). Model and Effort =
  pinned in Settings ?? last used with that Agent ?? Agent default. A pin the Agent no longer offers starts on the
  Agent default; the control shows what's real and the pin stays saved.

**Commands**

- `/` as the first character of an empty Composer lists the Agent's Commands (name, hint), filtered as the user types.
  ↑/↓ move, Enter/Tab picks, Esc closes.
- Spence adds **Clear** (`Session.clearContext`), which replaces the Agent's `/clear`. **Compact** appears only when the
  Agent offers `/compact`. An unknown `/word` is sent as text. A Command is sent as `/name args` prompt text.

**Images**

- Attach by the paperclip (file picker), paste into the Composer, or drop anywhere on the Session view (outline while
  dragging). No new RPC.
- PNG, JPEG, GIF, WebP only. Anything else: toast "Only images can be attached".
- Refuse, never resize. Over-limit images and images past the per-Message count are refused with a toast saying why.
  Claude: 5 MB base64, 8000 px per side, 20 per Message.
- Thumbnails above the text (× on hover, click previews). In `parts`, Images come before text.
- Agent ready and `canAttachImages` false: paperclip disabled with tooltip "‹Agent› can't take images"; pasted or
  dropped images refused with the same toast. Images attached before the Agent was ready: warning outline, one-line
  notice "‹Agent› can't take images. Remove them to send.", Send disabled until removed.
- Main writes `blobs/<sha256>` only when a prompt is sent.

**Unsent text and Images** live in main per open Session while its Tab is open, so they survive a language reload,
and are gone when the Tab closes. ([What Settings holds](https://github.com/ManuelUsoz/spence/issues/20) put Composer
text in main; [Images in the composer](https://github.com/ManuelUsoz/spence/issues/18) said Images behave exactly like
text, so they live there too.)

### 5.4 Titles

([Where a Session's title comes from](https://github.com/ManuelUsoz/spence/issues/22))

- Untitled: muted "New Session" (translated) in the row and the Tab.
- Every `session_info_update { title }` replaces the automatic title, at any time.
- If the first Turn ends untitled: the first Message's first line, whitespace collapsed; Image-only Messages become
  "Image" / "N Images".
- No Spence-side summary; Spence makes no model calls.
- A user Rename wins for good. Empty restores the automatic title.
- Title changes are quiet: no Transcript item, toast or Attention. Tab label = title, ellipsized by CSS, full title in
  a tooltip.

### 5.5 Links (`shell` domain)

`Shell.openLink({ uri, projectId })`. Main re-checks the scheme. `http(s)` opens in the system browser. `file://` or a
bare path opens in VS Code via `code --goto path[:line]`, falling back to revealing the file in the file manager. Other
schemes are not clickable. Never `shell.openPath`. The editor is hard-coded in v1.

## 6. Tabs, background work and Attention

([Tabs and Sessions running in the background](https://github.com/ManuelUsoz/spence/issues/11))

- One Tab per open Session, from any Project, in one window. No cap; the strip scrolls horizontally. Closing a Tab
  does not stop the Session or its Agent.
- A Turn always runs to its end, whatever its Tab does. No concurrency cap, no queue; one Turn at a time per Session.
- A pending Permission request waits forever (except what the Permission mode answers itself).
- **Attention** has two causes only, derived from the transcript plus live state, never stored:
  - **Needs answer**: a pending Permission request. Clears when answered or cancelled.
  - **Error**: the last Turn ended `failed`, or the Session's Agent stopped. Clears at the next Turn or Clear.
  - No seen/unread tracking anywhere. Archived Sessions never have Attention.
- In-app marks are icons only: Attention on the Tab, the Session row and the Project (distinct icons per cause).
  Running is a static, non-animated mark on the Tab and row only, never on the Project.
- **Notifier** in main: each time a Session gains Attention it emits `{ sessionId, projectId, cause, title }` to its
  channels, each a layer. v1 channel: OS notification, only when the window is unfocused and the Notifications
  Setting is on. Click focuses the window and opens the Session's Tab. Needs-answer also flashes the taskbar or sets
  the dock badge. No sound.

## 7. Projects and the sidebar

### 7.1 Projects

([Adding, renaming and removing a Project](https://github.com/ManuelUsoz/spence/issues/16))

- **Add Project** opens the OS folder picker (`dialog.showOpenDialog` in main). Any folder; git not required. No
  drag-and-drop.
- Adding an active Project's folder (real path, case-insensitive on Windows) fails with the toast "This folder is
  already in Spence as ‹name›." Adding a removed Project's folder revives it silently, same id and Sessions.
- Name defaults to the folder basename. Rename inline; blank falls back to the basename; names need not be unique.
- **Remove** = forget: tombstone `removedAt`, Sessions kept. Confirm only if a Turn is running in it; then cancel those
  Turns and close its Tabs.
- **Folder missing**: checked (`stat`) at launch, on Tab activation and before a new Session. Sessions stay readable;
  the Composer stays, Send waits behind a bar "Folder not found" with **Locate…**. Locate rewrites the Project path and
  every Session `cwd` equal to the old path. Not an Attention cause.
- `lastUsedAt` is set on add and when a Turn starts in any of its Sessions.
- **Project order** (global Setting): `{ by: name | lastUsed, direction: asc | desc }`, default lastUsed desc. Name
  sort uses the UI locale's collation, case-insensitive, numeric.
- Toasts (Spartan `sonner`) are only for results of user actions, never for Agent events.

### 7.2 Sidebar

([Sidebar inside a Project](https://github.com/ManuelUsoz/spence/issues/19), prototype commit `706e7a0`)

**One Project** (default layout)

- Top: Project switcher with name and path ("Folder missing" in red instead of the path), and a dot when another
  Project has Attention. Its menu lists Projects in Project order, each with Attention dot, running mark and
  folder-missing icon, then "Add Project".
- The current Project follows the active Tab's Session; picking another Project in the switcher shows that one.
- **New Session** button and a search icon that searches this Project's titles only.
- List: Attention Sessions pinned on top under **Needs you**, the rest under Today, Yesterday, Previous 7 days,
  Previous 30 days, then month and year. Two-line rows: title and marks, then a muted meta line ("active 2h · waiting
  for your answer · open in a Tab").
- Empty: "No Sessions in ‹name› yet."; no match: "No Sessions match."

**All Projects** (Setting)

- Filter field always on top, matching Session titles and Project names.
- Projects as headings (name, folder-missing mark, "+" New Session). Each shows its 5 most recent Sessions with a short
  age (running / Attention marks replace it), then "Show N more" / "Show less". Attention Sessions and the open Session
  stay visible past the cap. Filtering shows everything.

**Both layouts**

- Sessions always by last activity (last Turn started, else created), newest first.
- A draft shows as an italic "New Session" placeholder row at the top of its Project; closing its Tab removes it.
- **Archived (n)** fold, collapsed, at the end of each Project's list; archived rows muted.
- Multi-select: Ctrl/Cmd-click toggles, Shift-click ranges, Esc clears. Selected rows: tinted primary background with
  an inset ring; the active row: accent background, medium weight.
- Actions only in Spartan's `context-menu`; no hover kebabs. Right-clicking inside a selection acts on it.
  - Session: Open, Rename, — Archive (or Unarchive), Delete…; with several selected: Archive N / Delete N… only.
  - Project: New Session, Locate folder… (when missing), — Rename, Project settings, — Archive all (n), Delete all
    (n)…, Remove Project.
  - Archived fold: Unarchive all (n), Delete all (n)….
  - Tab: the Session's menu.
- A gear at the bottom opens Settings.

### 7.3 Archive and Delete

([Deleting or archiving a Session](https://github.com/ManuelUsoz/spence/issues/17))

- **Archive** is Spence-only (`archivedAt`). Immediate, toast "Archived ‹title›" with **Undo**. If a Turn is running,
  confirm first; then cancel it (a pending request becomes `cancelled`). Its Tab closes. An archived Session opens and
  reads normally; sending a Message unarchives it.
- **Delete** is permanent. Spartan `alert-dialog` promising "removed from Spence" (never "erased from the Agent"), and
  saying a running Turn will be stopped. Removes `sessions/<id>/`. Sends ACP `session/delete` for every id in
  `acpSessionIds`: at once if the Agent runs and advertises `sessionCapabilities.delete`, else queued in
  `agent-deletes.json`. The queue drains after the Agent's next `initialize` (Spence never starts an Agent just to
  delete). Agent errors count as done; transport failures retry up to 3 times, then drop with a log line. Nothing is
  shown.
- **Bulk**, within one Project: one confirm per batch (Delete always; Archive only when Turns run, naming how many), one
  toast with one Undo for bulk Archive. A failing Session doesn't stop the rest; an error toast counts failures.
- **Auto-archive** (global Setting, off; 30 days since `lastActivityAt` when on, editable): main checks at launch and
  hourly, archives silently, skips Sessions with an open Tab, a running Turn or a pending request. Never deletes.

## 8. Settings

([What Settings holds](https://github.com/ManuelUsoz/spence/issues/20))

One Spartan `dialog` from the sidebar gear (Mod+,). Every change applies at once; no Save button.

| Group    | Key                                      | Values (default first)                                                        |
| -------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| General  | Language                                 | System default · English · Español                                            |
|          | Theme                                    | System default · Light · Dark                                                 |
|          | Notifications                            | on · off ("Notify me when a Session needs me"; mutes only the OS channel)     |
|          | Sidebar layout                           | One Project · All Projects                                                    |
|          | Project order                            | lastUsed desc · `{ by, direction }` (also from a sort control in the sidebar) |
| Sessions | Default permission mode                  | Auto · Ask                                                                    |
|          | Auto-archive                             | off · N days (30 when turned on)                                              |
| Agents   | per Catalog Agent, with its Agent status | Model: Last used · a pinned Model; Effort: Last used · a pinned level         |

- Only Default permission mode is overridable per Project, from a "Project settings" `sheet` in the Project's menu
  (inherited value greyed until overridden).
- An Agent never run shows only "Last used" and the hint "Start a Session to see its Models". `state.json` keeps the
  last Model list so pins work without starting the Agent.
- Contract: `Settings.get()` → fully resolved object; `Settings.update(patch)` → the new resolved object. No change
  stream. Project overrides: `Projects.setSettings(projectId, patch)` (`null` clears a key).
- Language: reload the window into the other locale build at once. Turns keep running in main, the renderer replays
  with `events({ afterSeq })`, open Tabs, the active Tab and unsent Composer content are restored.
- Theme: main sets `nativeTheme.themeSource`; the renderer follows `prefers-color-scheme`, replacing the hard-coded
  `class="dark"`, applied before first paint.

## 9. Keyboard

([Keyboard model](https://github.com/ManuelUsoz/spence/issues/21))

One keymap service in `src/app/core`; features register actions and never add `document` keydown listeners. No
shortcut crosses RPC. On macOS main sets a minimal standard-roles menu (App with Settings…/Quit, Edit, Window);
Windows has no menu bar. In production, reload and DevTools keys are disabled.

| Action                                   | Key                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------- |
| New Session (current Project, draft Tab) | Mod+N (no Project: folder picker)                                    |
| Close Tab                                | Mod+W (a draft closes silently; the last Tab leaves the empty state) |
| Next / previous Tab                      | Ctrl+Tab / Ctrl+Shift+Tab (Ctrl on macOS too)                        |
| Tab 1–8 / last Tab                       | Mod+1…8 / Mod+9                                                      |
| Focus the Composer                       | Mod+L                                                                |
| Model / Effort picker                    | Mod+Shift+M                                                          |
| Toggle Permission mode                   | Mod+Shift+A                                                          |
| Session search                           | Mod+K                                                                |
| Project switcher / All Projects filter   | Mod+P                                                                |
| Settings                                 | Mod+,                                                                |
| Send / new line                          | Enter / Shift+Enter                                                  |
| Stop the running Turn                    | Esc, last layer                                                      |

- **Esc layers**: menu/popover → dialog/lightbox → Commands list → inline rename → multi-select → stop the running
  Turn (single press, no confirm, outcome `cancelled`).
- **Dock 1–4** answer only when focus is outside text fields, or in an empty Composer. The Dock never steals focus.
- **Type to focus**: a printable key in the thread or nowhere moves focus to the Composer (not digits while a request
  is pending; not in the sidebar).
- **Sidebar**: one tab stop, roving focus. ↑/↓ move, Enter opens, Shift+↑/↓ extends, Mod+A selects all in the Project,
  Space toggles, F2 renames, Shift+F10 / Menu opens the context menu, Delete archives (Undo toast).
- Match on `event.key` (works on Spanish layouts); digits and Tab jumps on `event.code`.
- Opening, switching or creating a Tab focuses its Composer with unsent text and caret restored. Closing a dialog or
  menu returns focus to its opener. Focus rings on `:focus-visible` only. While a dialog is open only its own keys
  work.
- Hints in tooltips and menu items (Spartan `kbd`), per OS. Mod+F stays free.

## 10. Internationalization

([Angular built-in i18n inside Electron](https://github.com/ManuelUsoz/spence/issues/5))

- `@angular/localize`, English and standard Spanish. Agent output is never translated.
- `localize: true` builds `dist/renderer/en/` and `dist/renderer/es/`, each with `baseHref: ""` (and
  `sourceLocale: { code: "en", baseHref: "" }`). Main loads `<locale>/index.html`.
- Locale: stored override, else `app.getPreferredSystemLanguages()` (`es*` → `es`), else `en`. Switching saves the
  override and calls `loadFile`. No CSP change.
- `i18nMissingTranslation: "error"`, and a new `i18n` step in `npm run verify`. `messages.es.xlf` is kept by hand or a
  Node merge script; keep generated ids.
- `ng serve` stays English; an `es` serve config covers Spanish. e2e pins the locale; Spanish baselines get their own
  shots.

## 11. Visual foundation

- Spartan helm components only, from `@ui/*`. v1 needs at least: `typography`, `trace`, `sonner`, `context-menu`,
  `alert-dialog`, `dialog`, `sheet`, `tooltip`, `kbd`, plus the existing set.
- Typography follows `AGENTS.md > Typography`: **Manrope** for the interface, **JetBrains Mono** for anything
  code-like (paths, commands, diffs, Ticker targets, stderr, `kbd`), **Reckless** only for rare large headings on
  quiet screens.
- Colors are the existing tokens in `src/styles.css`; no brand hue.

## 12. Out of scope

From the map: worktrees, the Changes panel, PRs and CI, parallel Workers · several Agents in one Session · multiple
windows · MCP servers in `session/new` · client `fs` / `terminal` capabilities · notification channels beyond OS
notifications · Agents other than Claude and custom Agent commands · bulk actions across Projects, per-Project
auto-archive · the context usage meter · attaching non-image files · choosing the editor · rebinding shortcuts and a
cheat sheet.

## 13. Open points for implementation

Small things the tickets left implicit. Each is to be settled in its implementation ticket, not by a new map.

- Exact shapes of `Session.create`, `rename`, `archive`, `unarchive`, `delete`, the `projects` and `agents` groups.
- Whether Claude's login command runs without a TTY (3.4).
- The Keyboard model ticket says Esc ends the Turn "stopped"; the contract's outcome is `cancelled`, shown as
  "Stopped". This spec uses `cancelled`.
- The Reckless font files: the family is wired as `--font-display`, but no font files are bundled yet.

## 14. Suggested slices

A starting order for implementation tickets, each a thin vertical slice that ends with `npm run verify` and, for UI,
`npm run e2e`.

1. Foundations: fix "A second RpcClient in a page never receives responses"; storage root and versioned files;
   typography tokens.
2. Agent discovery: merged PATH, resolution, safe spawn, Catalog, Agent status in Settings.
3. ACP service and one Session end to end: `Session.create`, `prompt`, `events` with text deltas only, transcript
   write and replay.
4. Steps, Thought, Plan, Ticker and Receipt (with `@ui/trace`).
5. Permission requests and the Dock; Permission mode with its map.
6. Model and Effort controls; `/` Commands, Clear and Compact.
7. Projects: add, rename, remove, folder missing; sidebar One Project layout.
8. Tabs, background Turns, Attention and the Notifier.
9. Reopening: resume → load → new, interrupted Turns, Agent process lifetime and quit.
10. Agent problems: install offer, can't start, needs login, crash.
11. Images.
12. Titles and Rename.
13. Archive, Delete, bulk, auto-archive, the delete queue.
14. Settings dialog, theme, Project settings, All Projects layout.
15. Keyboard model.
16. i18n builds, Spanish messages, the verify step, Spanish e2e baselines.
