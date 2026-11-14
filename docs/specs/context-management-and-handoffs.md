# Spec: context management, Agent switching and Session forks

Status: implementation-ready specification (planning only; no runtime implementation or live provider certification is claimed here).

Source: [Wayfinder: context management, Agent switching and Session forks](https://github.com/ManuelUsoz/spence/issues/55) and its resolved child tickets, linked by name in each section. Extends and selectively supersedes [calm-session-view-v1.md](./calm-session-view-v1.md).

Words in **bold** are defined in [GLOSSARY.md](../../GLOSSARY.md). Architectural rules live in [AGENTS.md](../../AGENTS.md), [CODING_STANDARDS.md](../../CODING_STANDARDS.md), and [ADR 0002](../adr/0002-agents-speak-acp-only-behind-an-adapter-in-main.md) (including its native-ACP and qualified-launch-path amendments).

## 1. Supersessions and conflicts with the v1 baseline

Where this specification and [calm-session-view-v1.md](./calm-session-view-v1.md) disagree, this specification wins:

| Area                                   | v1 baseline (`calm-session-view-v1.md`)                                                  | This specification                                                                                                                                                                                                                          | Authoritative decision                                                                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents per **Session** & creation      | One **Agent** (`Claude`) for the Session's whole life; no Agent picker (§1, §3.1, §12)   | Multi-Agent **Catalog** (`Claude`, `Codex`, `Antigravity`); **Settings** **Default Agent**; draft Agent switch before first **Turn**; **Summary handoff** to switch Agents                                                                  | [#58](https://github.com/ManuelUsoz/spence/issues/58), [#59](https://github.com/ManuelUsoz/spence/issues/59), [#66](https://github.com/ManuelUsoz/spence/issues/66) |
| Launch paths & install                 | `@agentclientprotocol/*` npm adapters only; `npm install -g` offer (§3.1–§3.2)           | Packaged adapters for `Claude` and `Codex`; native `agy acp` for `Antigravity`; missing `agy` shows official install instructions + re-scan                                                                                                 | [#58](https://github.com/ManuelUsoz/spence/issues/58), [#63](https://github.com/ManuelUsoz/spence/issues/63)                                                        |
| Version checks                         | Unchecked on PATH beyond `protocolVersion === 1` (§3.1, §3.4)                            | Pin qualified candidate versions; **Unverified version** notice + upgrade command when `initialize` (`protocolVersion: 1`) succeeds; hard-block only on incompatibility                                                                     | [#63](https://github.com/ManuelUsoz/spence/issues/63)                                                                                                               |
| **Permission mode**                    | Both **Ask** and **Auto** always offered (§5.3, §8)                                      | **Auto** is required and default; **Ask** is optional (hidden or disabled with explanation when unsupported)                                                                                                                                | [#58](https://github.com/ManuelUsoz/spence/issues/58), [#63](https://github.com/ManuelUsoz/spence/issues/63)                                                        |
| Context measurement                    | `usage_update` dropped; context meter out of scope (§4.3, §12)                           | Reported-only **Context usage** mapped in main from `usage_update`, distinct from cumulative **Usage**, shown in a hover/focus Composer ring                                                                                                | [#62](https://github.com/ManuelUsoz/spence/issues/62), [#60](https://github.com/ManuelUsoz/spence/issues/60)                                                        |
| Reopen memory loss                     | Silent `session/new` + `ContextCleared { reason: 'lost' }` (§4.4)                        | Preserve **Transcript**, append `ContextCleared { reason: 'lost' }` + notice, and gate Send behind explicit **Prepare summary handoff** or **Start with empty context**                                                                     | [#61](https://github.com/ManuelUsoz/spence/issues/61), [#63](https://github.com/ManuelUsoz/spence/issues/63), [#66](https://github.com/ManuelUsoz/spence/issues/66) |
| Context actions & `Mod+K`              | `Clear` and optional `Compact` in Composer `/` menu; `Mod+K` = Session search (§5.3, §9) | `Mod+K` remains **Session search**; quiet **Session action picker** (`Mod+Shift+K`) is canonical home for `Compact`, `Clear`, `Switch Agent`, `Fork`; `/` stays for Agent **Commands** while intercepting `/clear` and supported `/compact` | [#60](https://github.com/ManuelUsoz/spence/issues/60), [#66](https://github.com/ManuelUsoz/spence/issues/66)                                                        |
| Cancel stall & process exit            | 2 s tree kill only at app quit (§3.3)                                                    | `5 s` cancel grace (`CANCEL_GRACE`) surfaces **Stop Agent**; single confirm if other Sessions on the same Agent are working; switch/**Fork**/retry gated on observed `'exit'`                                                               | [#63](https://github.com/ManuelUsoz/spence/issues/63)                                                                                                               |
| **Session** storage & **Model** change | Flat `agentId` and `acpSessionIds`; immediate `Session.setOption` (§2.4, §4.1, §5.3)     | Per-**Turn** immutable `agentId` + requested/actual **Model**; **Agent context**-scoped ACP IDs; `HandoffAttempt` + `ForkLineage`; fresh-context handoff gate when Model change drops memory                                                | [#61](https://github.com/ManuelUsoz/spence/issues/61), [#66](https://github.com/ManuelUsoz/spence/issues/66)                                                        |

## 2. Domain and contract deltas

All ACP types, vendor IDs, `usage_update` payloads, launch arguments, and permission translations remain strictly inside `electron/`. Contracts in `src/shared/` expose only Spence-owned schemas and errors through `DesktopApi`.

### 2.1 Agent admission, launch, qualification, and capabilities

([Decide Agent admission policy and capability-dependent behavior](https://github.com/ManuelUsoz/spence/issues/58), [Decide Agent qualification checks and compatibility evidence](https://github.com/ManuelUsoz/spence/issues/63))

- **Initial Windows x64 candidate baseline** (candidate versions to certify, not claims of existing certification):
  - **Claude** (packaged adapter): `@agentclientprotocol/claude-agent-acp@0.106.0` (`claude-agent-acp`, requires Node `>= 22`). External login: Claude account login via `authMethods` / terminal login on `-32000`.
  - **Codex** (packaged adapter): `@agentclientprotocol/codex-acp@2.6.0` (`codex-acp`, bundling `@openai/codex`). External login: Codex ChatGPT login on `-32000`. Custom `CODEX_PATH` overrides are outside the supported baseline.
  - **Antigravity** (native ACP): `agy acp` (minimum qualified `agy` CLI `1.2+` established during live qualification). External login: Antigravity Google login on `-32000`. When `agy` is missing on the **Merged PATH**, Spence surfaces Google's official install instructions and a **Re-scan** action instead of `npm install -g`.
  - API keys, enterprise auth, custom gateways, and additional OS/architecture targets require separate qualification before promotion to **Qualified**.
- **Version inspection and unverified installs**:
  - `Agents.list` keeps cheap PATH `stat` discovery without spawning Agent processes at startup.
  - Packaged adapters inspect the resolved package's `package.json` statically when available and verify `initialize.agentInfo.version` on connect. Native `agy` verifies `initialize.agentInfo.version` on connect (falling back to `agy --version` only on launch/explicit check, cached per binary path + mtime).
  - Installed versions that do not match a qualified version run with a visible **Unverified version** notice and the qualified install/upgrade command if `initialize` (`protocolVersion: 1`) succeeds. Only actual launch/handshake incompatibility (`protocolVersion !== 1`, missing `acp` subcommand, startup failure) hard-blocks as **Can't start** / unsupported. Existing working `Claude` setups are preserved during transition.
- **`AgentCapabilities` contract** (`src/shared/agents/`):
  - **Required admission gates** (missing/failing = unsupported / `Can't start`): `initialize` at `protocolVersion: 1` (Spence claims no `fs` or `terminal` client capabilities); reliable text **Turn** + incremental streaming; tested **Auto** **Permission mode** (native auto mode with exceptional vendor confirmations surfaced in the **Dock**, or Spence `autoAllow: true` answering `allowOnce` only while requests lacking `allowOnce` still reach the user — never silently broadening permissions); `-32000` `Needs login` detection; working `session/cancel` and **Stop Agent** termination.
  - **Optional capabilities** (missing = supported with visible limitation):
    - `models`: expose only Models verified usable by a `spence`-identified client (excluding ineligible third-party Antigravity Models with a limitation note; never spoofing another client or silently substituting an explicitly selected/pinned Model).
    - `effort`: expose only `low | medium | high | max` levels backed by verified `session/set_config_option` mappings; omit/disable unmapped levels.
    - `images`: gate on `promptCapabilities.image === true` + per-Agent `ImageLimits`; block pre-send when unsupported and never silently drop **Images**.
    - `askMode`: hide or disable **Ask** with explanation when an Agent supports **Auto** only.
    - `resume`: `session/resume` / `session/load`; absence or failure preserves the **Transcript** and triggers the `memoryLost` gate.
    - `contextUsage`: optional reported-only signal (§2.3).
    - `supportsCompaction`: whether user-triggered `Session.compact` is available (§2.4).
    - `supportsIsolatedSummary`: whether main may draft a handoff summary via an isolated, tool-disabled ACP call (§2.5).
    - `modelChangePreservesContext`: whether changing **Model** keeps conversational memory (`true`) or requires a fresh-context **Summary handoff** (`false`).

### 2.2 Cancellation grace, Stop Agent, and termination confirmation

([Decide Agent qualification checks and compatibility evidence](https://github.com/ManuelUsoz/spence/issues/63))

- Calling `Session.cancel` sends ACP `session/cancel` and starts a **5-second** grace period (`CANCEL_GRACE = 5s`). If the **Turn** (or **Compaction**) has not settled after `5s`, Spence surfaces **Stop Agent** in the cancel slot.
- Because `AgentLifetime` shares one process per **Agent** across open **Sessions**:
  - If no other Session on that Agent has active work, **Stop Agent** kills the process tree immediately (`taskkill /T /F` on Windows; `SIGTERM -> 2s -> SIGKILL` on POSIX process groups).
  - If `N >= 1` other Sessions on that Agent have active work, **Stop Agent** requires one confirmation (`"Stopping ‹Agent› will also interrupt ‹N› other working Sessions"`) before killing the process tree.
- Active Turns on the stopped process end as `failed { reason: 'interrupted' }`; idle open **ACP sessions** drop cleanly and reconnect on next prompt or **Tab** activation.
- **Termination gate**: switching Agents, starting a **Fork**, or retrying an interrupted **Handoff attempt** requires an observed process `'exit'` event (or clean `PromptEnded` on normal cancel), never proceeding on a kill timeout alone. If exit is not confirmed within the kill timeout, handoffs stay blocked with an error showing the unconfirmed PID/process state, while recorded Transcript items and partial on-disk **Project** files remain intact.

### 2.3 Reported-only Context usage semantics

([Decide reported and estimated context measurement semantics](https://github.com/ManuelUsoz/spence/issues/62))

- **Context usage** represents current conversational memory only, distinct from cumulative/billing **Usage**. Spence performs no local token estimation, visible-Transcript counting, range guessing, or Model-capacity catalog lookup.
- Main maps ACP `usage_update` (`used`, `size`) into a Spence `ContextUsage` contract tied to the current **Agent context** and **Model**:
  - **Availability & validation**: `used` must be finite and nonnegative (`>= 0`). `capacity` must be finite and positive (`> 0`) to compute a percentage; missing, zero, negative, or nonfinite `size` yields `countOnly` (`capacity` unknown, no percentage). Invalid payloads never overwrite a historical reading with a fabricated current value. Absence of reports yields `unavailable`.
  - **Over-capacity preservation**: preserve percentages above `100%` without clamping (`used / capacity * 100`, formatted to two decimal places alongside abbreviated counts and exact integers in details).
  - **Freshness & invalidation**: retain the latest valid report during work labelled as the latest reported value (never extrapolate live increments). Reopening marks any saved reading `historical` until the Agent reports again, even when context restores. **Clear**, Agent switch, **Fork**, lost memory, and **Model** changes invalidate the preceding reading immediately (`unavailable` / awaiting new report, never transferring source readings or assuming zero tokens). **Compaction** marks the prior reading `historical` and enters `awaiting` until a new report arrives; failed or cancelled operations manufacture no new measurement.

### 2.4 Durable Agent ownership, Compaction, Model changes, and reopen

([Decide durable Agent ownership, context boundaries and fork lineage](https://github.com/ManuelUsoz/spence/issues/61), [Decide final specification structure and acceptance coverage](https://github.com/ManuelUsoz/spence/issues/66))

- **Per-Turn identity & Agent contexts**:
  - Every **Turn** permanently records its own `agentId`, requested `model`, and Agent-reported actual `model` when available. Subsequent switches never relabel historical Turns, and unverified choices are never shown as verified.
  - Saved `acpSessionIds` belong to their owning **Agent context** and **Agent**. Only the current active Agent context may attempt restoration on reopen; retired contexts (after Switch or **Clear**) are never resurrected.
  - Existing single-Agent v1 Sessions retain known `agentId`, recorded Turn Model snapshots, and Clear/lost markers without inventing missing historical Models or boundaries.
- **Clear & Compaction**:
  - **Clear** keeps the current Agent and selected Model, opens a fresh empty context without carrying a summary automatically, preserves the **Transcript**, and writes `ContextCleared { reason: 'cleared' }`.
  - **Compaction** stays within the current **Agent context**. User-triggered compaction uses `Session.compact({ sessionId })`, gated by `supportsCompaction` (`Busy` while a Turn or compaction runs), streams `Compaction { id, status: 'running' | 'done' | 'failed' | 'cancelled', summary }`, and supports cancellation (`CANCEL_GRACE = 5s` + **Stop Agent**). Failed or cancelled compaction leaves the current Agent context intact and prior **Context usage** `historical`.
- **Model-change gate**:
  - When `modelChangePreservesContext` is `true`, `Session.setOption` updates Model immediately and invalidates `ContextUsage`.
  - When `modelChangePreservesContext` is `false` on a non-draft Session, changing Model requires no Turn running and transitions into the reviewed **Summary handoff** flow (same-Agent switch targeting the new Model) rather than silently discarding context.
- **Reopen & Archive**:
  - Closing/reopening a **Tab** keeps a live context intact. After restart or process loss, Spence attempts restoration (`session/resume`, then `session/load` with replayed updates discarded) only for the current **Agent context**. Success preserves memory without adding a false boundary.
  - If restoration is unsupported or fails, Spence preserves the Transcript, appends `ContextCleared { reason: 'lost' }` + an informational notice that earlier **Messages** have not been sent to the fresh context, and locks Send behind the `memoryLost` gate (§3.4). Unfinished Turns on crash close `failed { reason: 'interrupted' }` with pending **Permission requests** `cancelled` and are never auto-replayed.
  - **Archive** preserves Agent, Transcript, boundaries, and context; only sending a Message unarchives a Session (reading or preparing a handoff does not).

### 2.5 Summary handoff, commitment, and Handoff attempts

([Decide summary handoff and provider-agnostic fork semantics](https://github.com/ManuelUsoz/spence/issues/59), [Decide durable Agent ownership, context boundaries and fork lineage](https://github.com/ManuelUsoz/spence/issues/61))

- **Summary generation & contents**:
  - Prepared by Spence from the recorded Transcript (goal, decisions, constraints, relevant files, completed and outstanding work, verification results, explicit missing information; private **Thoughts** excluded; tool outputs condensed; relevant **Images** described while originals stay selectable separately).
  - If the outgoing Agent has qualified `supportsIsolatedSummary === true` and can run, Spence may draft the summary in an isolated ACP session with tools disabled (`fs`/`terminal` off). Otherwise (and whenever the outgoing Agent is unavailable, unauthenticated, or crashed), Spence deterministically builds a structured Transcript extract for user editing so Switch and **Fork** are never blocked by a broken outgoing Agent.
- **Source binding & startup commitment**:
  - Both Switch and Fork require no active Turn on the source Session and bind preparation to the source's latest settled Turn (including `cancelled`). If another Message advances the source before confirmation, require regeneration or explicit review against the new endpoint.
  - Startup sends the approved summary + selected compatible Images with an explicit instruction to acknowledge and wait for the user's next instruction, recorded as a visible setup Turn.
  - Commitment occurs **only after successful destination acknowledgement**:
    - Committed Switch updates the Session's current Agent/Model and active **Agent context**, retaining the boundary and inspectable summary.
    - Committed Fork creates the new durable Session in the same **Project** (sharing the Project folder; no file rollback).
    - **Failure & crash recovery**: if the destination acts (unexpected tool steps/edits) instead of merely acknowledging, fail the handoff, cancel and offer **Stop Agent** if needed, require confirmed `'exit'` before retrying, and persist a **Handoff attempt** (`failed` / `interrupted`) inspectable from the source without mutating the source's current Agent or creating a permanent Fork. Any on-disk changes remain visible. Cancelling preparation leaves the source unchanged; failed startup retains the approved summary for edit/retry after capability/endpoint/budget revalidation.

### 2.6 Durable Fork lineage and deletion

([Decide summary handoff and provider-agnostic fork semantics](https://github.com/ManuelUsoz/spence/issues/59), [Decide durable Agent ownership, context boundaries and fork lineage](https://github.com/ManuelUsoz/spence/issues/61))

- Each committed Fork stores an independent copy of its approved summary, selected Images, destination Agent/Model, setup Turn, and `ForkLineage` (`sourceSessionId`, `sourceTurnId`), while recording a reciprocal link on the source Session at `sourceTurnId`.
- Deleting a Session removes its Transcript, summaries, owned transferred content, and Handoff attempts, and queues/executes provider cleanup for its own `acpSessionIds` without affecting other Sessions.
- Forks are **not** cascade-deleted when their source is deleted: surviving Forks keep their saved summary and Images and display `"Source deleted"` at their origin marker. Deleting a Fork removes its reciprocal link from the source. Deletion never touches shared Project working files.

## 3. UI and interaction flows

([Prototype context visibility and management controls](https://github.com/ManuelUsoz/spence/issues/60), [Decide final specification structure and acceptance coverage](https://github.com/ManuelUsoz/spence/issues/66))

### 3.1 Context ring beside the Composer

- A small circular context-usage indicator sits quietly beside the **Composer** (`@ui/*` primitives + Tailwind tokens in `src/styles.css`; no permanently visible numeric shelf or side panel).
- Hovering or focusing the ring reveals details: status/label (`24.00k / 200.00k · 12.00%`, `24.00k · capacity unknown`, `Context usage unavailable`, `Historical · ...`, `Awaiting context report`, or un-clamped over-capacity `210.00k / 200.00k · 105.00%`), exact reported integers, `"Reported by ‹Agent›"` provenance, and freshness note (`"Latest report; not a live counter."` vs `"Historical reading; waiting for a new report."`).
- Measured current states (`reported`, `over`, capped visually at a full arc for `>100%`) draw a progress arc; `count`, `unavailable`, `historical`, and `waiting` draw a neutral dotted ring without implying measured occupancy.
- The state model below is trimmed from the approved throwaway prototype (`prototype/context-ring-and-session-commands`, commit `72ef6a0`, `context.prototype.ts`):

```ts
type Reading = 'reported' | 'count' | 'unavailable' | 'historical' | 'waiting' | 'over';
type Operation = 'Compact' | 'Clear' | 'Switch Agent' | 'Fork';
type HandoffPhase = 'review' | 'starting' | 'failed' | 'success';
```

### 3.2 Session action picker vs Composer `/` Commands

- A quiet launcher button beside the Composer or `Mod+Shift+K` opens the searchable **Session action picker** for `Compact`, `Clear`, `Switch Agent`, and `Fork` (`Mod+K` stays bound to sidebar **Session search**).
- Users can click actions directly or filter by typing, move with `↑`/`↓`, invoke with `Enter`, and dismiss with `Esc` (returning focus to the launcher/Composer).
- While any Turn runs (including waiting on a **Permission request**), all four actions are disabled with an explanation that the Turn must finish or be cancelled.
- `Compact` always remains visible in the picker; when `supportsCompaction` is false, it stays disabled with a clear limitation explanation.
- Composer `/` remains strictly for Agent-offered **Commands** sent as Message text, except `/clear` (always) and `/compact` (when `supportsCompaction` is true) intercept cleanly into Spence's own `Clear` / `Compact` boundaries.

### 3.3 Draft Agent choice and Settings defaults

- **Settings** adds a **Default Agent** setting (`Last used` or a pinned qualified Agent, defaulting to `Claude` until changed).
- An unsent **draft** Session starts with the resolved Default Agent and allows changing its Agent directly from the draft Composer controls without a Summary handoff. Once the first Turn starts, changing Agents requires **Switch Agent** (or **Fork**).

### 3.4 `memoryLost` Composer notice bar

- When a reopened Session falls into `memoryLost`, a one-line notice bar above the Composer keeps the Transcript readable and the Composer typable while disabling Send until the user chooses **Prepare summary handoff** (opens reviewed handoff targeting the same Agent) or **Start with empty context** (dismisses the gate so the next prompt starts on the fresh context).

### 3.5 Summary review and destination selection

- **Switch Agent** and **Fork** open the review flow showing: destination Agent, Model (prefilled current choice where valid else configured default; never silently substituted), Effort and Permission mode compatibility/required adjustments, editable summary text, token budget indicator (`min(10% destination capacity, 8,000)` when capacity is known, else provisional `4,000` estimated cap) with explicit overflow warning blocking confirmation without silent truncation, and separately selectable original Images (blocking Images unsupported by destination).
- Retrying after startup failure revalidates source endpoint, capabilities, `'exit'` confirmation, and budget.

### 3.6 Fork and reciprocal thread markers

- The sidebar Session list stays flat and chronological (no tree nesting).
- A Fork renders a top handoff-boundary marker in its thread: `Forked from ‹Source› · Turn N` with a clickable redirect that opens/focuses the source Session's **Tab** and scrolls to `Turn N` in its Transcript when the source exists, or `Source deleted` when the source has been deleted, alongside the expandable approved summary.
- The source Session renders a quiet inline marker after `Turn N`: `Forked to ‹Fork›` linking to the Fork's Tab (removed if the Fork is deleted).

## 4. Two-tier acceptance coverage

### Test seams (highest existing seams preferred)

1. **Main-process / domain seam**: `Sessions`, `Agents`, `Projects`, `Settings`, and `Store` wired to `layerAcpClientWithFakeAgent` / `fakeAgent.mjs` (plus `MessageChannel` RPC round-trip specs in `electron/rpc/`), extending the fake agent to emit `usage_update`, capability/version combinations, isolated summary and compaction flows, stalled cancel (`5 s`) + exit timing, `-32000` auth errors, and unexpected tool calls during handoff acknowledgement.
2. **Renderer seam**: Angular feature specs wired exclusively through `makeDesktopTestLayer` (`DesktopApi` RPC boundary), with zero module mocks or internal service stubs.
3. **End-to-end UI seam**: Playwright Electron specs (`en` + `es` locales and visual baselines) against the fake/test Agent for critical flows (context ring hover/focus, `Mod+Shift+K` picker, `memoryLost` gate, summary review, `Stop Agent` recovery, and Fork/source transcript redirects).
4. **Live qualification seam (outside automated CI)**: Checked-in qualification records per OS/architecture, exact integration version, and runtime dependencies (`Claude`, `Codex`, `Antigravity` on Windows x64 first).

### Tier 1 — Automated contract acceptance scenarios

- **Admission, versions & capabilities (`Claude`, `Codex`, `Antigravity`)**:
  - `protocolVersion !== 1` or missing required gate (`Auto`, text Turn, streaming, cancel, `-32000` login) marks Agent unsupported (`Can't start`).
  - Unverified installed version with valid `protocolVersion: 1` runs with visible **Unverified version** notice and upgrade command without breaking existing `Claude` setups.
  - Missing `agy` surfaces Google install instructions + re-scan instead of `npm install -g`.
  - Optional capability limits: ineligible third-party Models excluded with notice and no silent substitution; unmapped Effort levels omitted/disabled; unsupported Images blocked pre-send; optional **Ask** hidden/disabled with explanation; unsupported `Compact` disabled with explanation in picker; missing `supportsIsolatedSummary` or crashed outgoing Agent falls back to Transcript extract; `modelChangePreservesContext: false` opens reviewed Summary handoff instead of direct `setOption`.
- **Context measurement & presentation**:
  - Cumulative `Usage` never populates `Context usage`; valid `used` + `size` renders two-decimal percentage + abbreviated counts (`24.00k / 200.00k · 12.00%`) and exact values on hover/focus with `Reported by ‹Agent›`.
  - Missing/non-positive capacity renders `countOnly` (`capacity unknown`) with dotted ring; `unavailable`, `historical` (reopen, post-compaction failed/cancelled), and `awaiting` (post-compaction) render dotted rings; `>100%` preserves un-clamped percentage in details with full arc.
  - Clear, Switch, Fork, `memoryLost`, and Model changes invalidate `Context usage` immediately.
- **Cancellation, handoffs, reopen & Fork durability**:
  - `Session.cancel` stalled past `5 s` surfaces **Stop Agent**; shared-process confirm appears iff other Sessions on that Agent are active; Switch/Fork/retry remain blocked with unconfirmed PID error until process `'exit'` is observed.
  - Reopen `session/resume` -> `session/load` -> `memoryLost` preserves Transcript, marks boundary, and blocks Send until explicit user choice; interrupted crash Turns never auto-replay.
  - Unexpected destination tool calls/edits during handoff acknowledgement fail the handoff, preserve inspectable `HandoffAttempt` and disk changes on source, leave source Agent unchanged, and create no permanent Fork.
  - Source deletion leaves Forks intact with `"Source deleted"` and preserved summary/Images; Fork deletion removes the reciprocal `Forked to ‹Fork›` marker; `Archive` preserves context and unarchives only on prompt send.

### Tier 2 — Live per-OS/architecture qualification matrix (non-CI)

Before promoting any integration version or OS/architecture to **Qualified** in the Catalog, record checked-in live pass/limitation results for: external login (`Claude` account, `Codex` ChatGPT, `Antigravity` Google), `initialize` version/capabilities, text Turn + streaming, **Auto** + exceptional confirmation, `session/cancel` + **Stop Agent** `'exit'` confirmation, Model eligibility, Effort `set_config_option` round-trip, Image attachment limits, `session/resume` / `session/load`, isolated tool-free summary check, compaction behavior, and captured `usage_update` signals.

## 5. Out of scope

- Implementing or shipping runtime code or certifying live providers inside this specification.
- Spence-side token estimators, visible-Transcript token counting, or static Model-capacity catalogs.
- Custom Antigravity ACP bridges, API key / enterprise auth / custom gateway flows, and `CODEX_PATH` overrides.
- Concurrent Agents in one Session, cross-Project or cross-worktree handoffs, file rollback on Fork, edit/retry/undo, pinned context, and per-Turn cost/time accounting.

## 6. Authoritative Wayfinder decisions

- [Research ACP launch and capability support for Codex and Antigravity](https://github.com/ManuelUsoz/spence/issues/56)
- [Research context signals and summary handoff mechanisms across ACP Agents](https://github.com/ManuelUsoz/spence/issues/57)
- [Decide Agent admission policy and capability-dependent behavior](https://github.com/ManuelUsoz/spence/issues/58)
- [Decide summary handoff and provider-agnostic fork semantics](https://github.com/ManuelUsoz/spence/issues/59)
- [Prototype context visibility and management controls](https://github.com/ManuelUsoz/spence/issues/60)
- [Decide durable Agent ownership, context boundaries and fork lineage](https://github.com/ManuelUsoz/spence/issues/61)
- [Decide reported and estimated context measurement semantics](https://github.com/ManuelUsoz/spence/issues/62)
- [Decide Agent qualification checks and compatibility evidence](https://github.com/ManuelUsoz/spence/issues/63)
- [Decide final specification structure and acceptance coverage](https://github.com/ManuelUsoz/spence/issues/66)
