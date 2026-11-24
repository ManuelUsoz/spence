# Spec: Agent visibility (calm-by-default, inspect-on-demand)

Status: design settled; ready for implementation. Implements **Wave 1 · Item 3** of [ROADMAP.md](../../ROADMAP.md), extending [calm-session-view-v1.md](./calm-session-view-v1.md) and amending its no-`terminal` boundary per [ADR 0010](../adr/0010-host-acp-terminals-in-main.md).

Words in **bold** follow [GLOSSARY.md](../../GLOSSARY.md). Architectural, TypeScript, Spartan Helm, and Effect rules follow [AGENTS.md](../../AGENTS.md) and [CODING_STANDARDS.md](../../CODING_STANDARDS.md).

---

## 1. Design principles

1. **Calm by default, inspect on demand.** Running **Turns**, finished **Receipts**, **Sidebar** rows, and **Tabs** stay compact and low-noise by default; rich telemetry (Step lists, live command output tails, structured inputs/outputs, durations, and hover tooltips) reveals only when the user clicks or hovers.
2. **ACP stays in main.** Client `terminal/*` handlers, `tool_call` / `rawInput` / `rawOutput` normalization, tail capping, and Step timing live strictly in `electron/`. `src/shared/` exposes only Spence schemas (`Step`, `StepDelta`, `SessionSummary`, `LiveState`).

---

## 2. Main process & ACP `terminal` capability (`electron/`)

### 2.1 ACP client `terminal` handlers (`ADR 0010`)

- Advertise `terminal: true` in `CLIENT_CAPABILITIES` (`electron/acp/acpSessionManager.ts`) alongside `auth.terminal`, `session.compaction`, and `session.notices` (`fs` remains disabled).
- Implement `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, and `terminal/release` on `makeClientDispatcher` (`electron/acp/acpClientDispatcher.ts`) backed by a per-Session terminal manager in `electron/acp/`:
  - **Command spawning**: when `args` is provided and non-empty, spawn directly with `windowsHide: true` (no shell). When `args` is omitted or empty, invoke via the OS shell (`cmd.exe /d /s /c` on Windows, `/bin/sh -c` on POSIX).
  - **`cwd` containment**: default omitted/null `cwd` to the Session's active folder (Project or Worktree); reject paths outside the Session's Project/Worktree root.
  - **Output retention**: retain a combined stdout/stderr rolling tail capped at `min(outputByteLimit ?? 32_768, 32_768)` bytes, truncating from the beginning on valid UTF-8 character boundaries and setting `truncated: true` when trimmed.
  - **Lifecycle cleanup**: terminate any unreleased terminal process tree and release its resources on **Turn** cancel (`Session.cancel`), **Stop Agent**, Session detach, or app quit.

### 2.2 Linking terminals and ACP `tool_call` payloads to `Step` (`electron/acp/acpMappers.ts`, `electron/sessions/sessions.ts`)

- **Terminal-to-Step binding**: `terminal/create` buffers output and exit status by `terminalId` immediately; once a `tool_call` / `tool_call_update` embeds `{ type: 'terminal', terminalId }` in `content`, main streams throttled (~100 ms coalesced) `StepDelta` chunks into that `Step` and sets `exitCode` when the process exits.
- **Fallback for non-terminal Agents/tools**: `mergeStep` and `stepOfToolCall` extract capped structured `input` (from `rawInput`, formatted as JSON or command text), `output` (from `content` text blocks and/or `rawOutput`), `exitCode` (when reported in `rawOutput`), `files`, and `diffs` so Agents that execute tools internally still populate the same `Step` contract.
- **Permission edit normalization**: `stepOfToolCall` and `mergeStep` normalize both ACP `diff` content blocks and common `rawInput` edit payloads (`old_string`/`new_string`, new-file `content`) into `Step.diffs` (alongside `files` and `input`) so edit previews work before `tool_call_update` arrives.
- **Authoritative Step timing**: main stamps `startedAt` (when a Step first enters `running`, or on creation if it completes immediately) and `endedAt` (when transitioning to `done`, `failed`, or `cancelled`) on `Step`.

---

## 3. Shared contract deltas (`src/shared/sessions/sessions.rpc.ts`)

- **`Step`**: extend with optional fields:
  - `startedAt?: number`, `endedAt?: number`
  - `cwd?: string` (for `execute` / terminal commands when distinct or captured)
  - `input?: string` (size-capped structured input / full command)
  - `exitCode?: number`
  - `outputTruncated?: boolean`
  - Keep `output: string` tail-capped at 32 KB.
- **`StepDelta`** (`TranscriptItem` member): `{ _tag: 'StepDelta', id: StepId, output: string, truncated?: boolean }` — streamed and appended to `Step.output` (enforcing the 32 KB rolling tail) so live stdout/stderr chunks never re-serialize full `Step` objects and survive reopen in `transcript.jsonl`.
- **`SessionSummary` & `SessionWorkerSummary`**: add optional live activity metadata (matching `WorkerInfo`'s existing `action` / `startedAt` shape):
  - `activity?: { kind: StepKind | 'thinking' | 'writing', target: string, startedAt: number }` (when working)
  - `blockedTarget?: string` (e.g., command or file target when waiting on a `PermissionRequest`)
  - Also expose the Session's current `activity` on `LiveState` if needed by `Tabs`.

---

## 4. Renderer surfaces (`src/app/`)

### 4.1 Expandable live **Ticker** (`src/app/features/session/ticker.ts`, `thread.ts`)

- **Default**: stays a single quiet line (`hlmTraceLine`) showing spinner, current icon, target (or trailing Thought italic), and Turn elapsed time.
- **Expanded (click-to-toggle)**: opens an inline drawer directly beneath the Ticker line showing:
  - Completed and active **Steps** in order (kind icon, target, status, and live/completed per-Step elapsed timer; no live Thought prose).
  - Clicking an `execute` Step (or any Step with output) toggles its live rolling command output tail (`StepDelta`) in `font-mono text-xs`.
  - A compact row of **files touched so far** (from `Step.files` / `Step.diffs`); clicking a file with diffs expands an inline `@ui/diff` (`DiffPatch`) preview.
- **Turn end**: expanded state automatically collapses when the Turn settles into its **Receipt**.

### 4.2 **Receipt** per-Step inspection & duration (`src/app/features/session/receipt.ts`)

- Keep `"N steps"` collapsed by default.
- Inside `"N steps"`, each Step row displays its authoritative duration (`endedAt - startedAt`) right-aligned in `tabular-nums`, highlighting **slow Steps** (`>= 10s`) visually.
- Clicking any Step row toggles an inline detail area directly below it showing (as available):
  - Structured **Input** (`font-mono text-xs`)
  - **Command output / Output tail** (`font-mono text-xs`, noting truncation if `outputTruncated`) + **Exit code** badge (`exitCode`)
  - Step **Diffs** (`@ui/diff`)

### 4.3 Unified **Dock** Permission preview (`src/app/features/session/dock.ts`, `session-view.ts`)

- Move the pending **Permission request** card out of `#threadScroller` and into `<app-dock>` directly above the Composer (taking precedence over the `Plan` progress bar while pending, keeping `1–4` approval buttons pinned and always visible).
- Resolve preview details from the linked `Step` and Session `cwd`:
  - **`execute`**: exact `cwd` (`step.cwd ?? sessionCwd`) and full command (`step.input ?? step.title`) in `font-mono`.
  - **`edit`**: relative file path(s) and a height-capped scrollable `@ui/diff` preview.
  - **`delete` / `move` / `read` / `fetch` / `other`**: affected `files` (if any) and capped structured `input` in `font-mono text-xs`.

### 4.4 Calm **Sidebar** & **Tab** marks + hover tooltips (`activity-mark`, `styles.css`, `session-list.ts`, `app-sidebar.ts`, `tab-strip.ts`)

- **Status colors**: define a calm `--working` token in `src/styles.css` alongside `--attention` (amber, waiting) and `--destructive` (red, error), wired into `ActivityMark` (`src/app/ui/activity-mark/index.ts`).
- **Sidebar rows & Tabs stay calm**:
  - **Tabs** stay single-line with the color-coded `ActivityMark` + title.
  - **Sidebar rows** show no running-command prose: color-coded `ActivityMark` only for `working` (single-line row), and at most a single-word status label (`Waiting` / `Error`) for Attention and `SidebarWorkerRow`.
- **Hover tooltips**: hovering a Sidebar row, Worker row, or Tab opens a tooltip (`@ui/tooltip`) showing the full title and live micro-status (`running npm test · 14s`, `thinking · 8s`, `waiting for permission: git push`, or error summary), ticking elapsed seconds locally in the renderer from `startedAt`.

---

## 5. Verification targets

- Main-process specs (`electron/acp/`, `electron/sessions/`): `terminal/*` handlers (direct vs shell spawn, `cwd` rejection, 32 KB rolling tail truncation, cleanup on cancel/detach/quit), `StepDelta` persistence + reopen, `stepOfToolCall` diff/input normalization, `SessionSummary` live activity fields, and `fakeAgent.mjs` terminal test coverage.
- Renderer specs (`makeDesktopTestLayer`): expandable Ticker + live tail toggle, Receipt per-Step durations + slow-Step highlight (`>= 10s`) + Step detail inspection, unified `<app-dock>` previews (`execute`, `edit`, `other`), and Sidebar/Tab `ActivityMark` colors + hover tooltips.
- Full gate: `npm run verify` (`en` + `es` i18n translations included).
