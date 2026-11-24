# Spence Roadmap

This document tracks the planned scope and delivery order for **`0.1.0`** (first stable release, planning immediately) and **`0.2.0`** (next major milestone, 1+ month out).

Domain terms follow [`GLOSSARY.md`](./GLOSSARY.md). Detailed implementation specs live in [`docs/specs/`](./docs/specs/); older post-v1 candidate notes live in [`docs/roadmap.md`](./docs/roadmap.md).

---

## `0.1.0` — Complete the daily-driver loop

**Goal:** Close the end-to-end development loop (Issue → Session → Code/Worktree → Pull request), give developers clear calm-by-default visibility into what Agents are doing and spending, and finish with Spotlight + Worktree polish for GA.

### Wave 1 — Pull requests, Issue trackers & Chat / Agent experience

#### 1. Git hosts & Pull requests (v1)

Spec: [`docs/specs/git-hosts-and-pull-requests.md`](./docs/specs/git-hosts-and-pull-requests.md)

- GitHub adapter behind `GitHostRegistry`, `HostAuth` (Device Flow, PAT, `gh` CLI import), dedicated Pull requests page, `@` Composer PR picker, ephemeral Agent PR drafting, review/comment/merge, and lazy PR Worktree checkout.

#### 2. Issue trackers & Composer Issue references (v1)

Spec: [`docs/specs/issue-trackers-and-composer-references.md`](./docs/specs/issue-trackers-and-composer-references.md)

- GitHub Issues and Azure DevOps Boards (read-only) behind `IssueTrackerRegistry`, dedicated Issues page, per-Project `TrackerBinding` / `TrackerScope`, and `!` Composer Issue picker sharing the attachment cap and snapshot pipeline with PRs.

#### 3. Agent visibility (calm-by-default, inspect-on-demand)

- **Expandable live Ticker**: keep the Ticker a single quiet line by default, clickable during a running Turn to inspect completed Steps, the active Step's elapsed timer, and files touched so far.
- **Live command output tail**: allow expanding an active or finished command Step to view its rolling stdout/stderr tail and exit code.
- **Per-Step inspection & duration in Receipts**: show per-Step duration (highlighting slow Steps) and let clicking a Step reveal its structured input/output.
- **Richer Permission request preview in the Dock**: show the exact working directory + full command (or compact diff preview for file edits) directly inside the approval card.
- **Sidebar & Tab micro-status**: show a subtle secondary line or hover tooltip with the current Step target for working/blocked Sessions (e.g., `running npm test · 14s`, `waiting for permission: git push`).

#### 4. Context & token management

- **Per-Turn Usage & duration on Receipts**: show elapsed duration alongside Agent-reported input/output/cached tokens and cost folded inside each Turn's **Receipt**, making it obvious which Turn grew context.
- **Context-threshold nudge**: when reported **Context usage** crosses a configurable threshold (e.g., 75–80%), surface a quiet action chip near the Composer offering **Compact** or **Summary handoff** to a fresh Session before quality degrades or auto-compaction fires.
- **Attachment context budget indicator**: show a compact size/cap indicator on Composer attachments (`@` PRs, `!` Issues, Images, files) before Send.

#### 5. Chat & Composer ergonomics

- **Lightweight Edit & Retry for the last Turn**: **Retry last Turn** on error or interruption, and **Edit & resend** when a failed Turn made no file changes (full checkpointed rewind moves to `0.2.0`).
- **Composer prompt history & file mentions**: up-arrow recall of previous Messages when the Composer is empty, plus a fast file-path mention picker backed by the existing `files` domain.

---

### Wave 2 — Spotlight, Worktrees & GA polish

#### 6. Spotlight (`Mod+K`) — unified search, shortcuts & actions

- Expand `Mod+K` beyond Session title search into a fast, keyboard-first Spotlight palette covering:
  - Full-text search across local JSONL **Transcripts** (filterable by Project, Agent, or date).
  - Quick-jump to **Projects**, **Sessions**, **Worktrees**, **Pull requests**, and **Issues**.
  - All Spence actions and navigation commands with their keyboard shortcuts displayed inline.

#### 7. Worktree lifecycle & ergonomics

- **Remove Worktree**: confirmation modal naming uncommitted changes, active Sessions using it, and an option to delete a merged local branch.
- **Prune stale Worktrees**: prune entries where Git reports `missing: true` (folders removed outside Spence), plus clear recovery UI when a Session's Worktree disappears.
- **Copy local untracked files on creation**: per-Project setting for files like `.env` / `.env.local` copied automatically alongside `setupCommand`.
- **Base branch selection, status & bulk cleanup**: choose the base branch/ref when creating a Worktree, display dirty / ahead / behind indicators, and offer a **"Clean up merged Worktrees"** modal.
- **Quick open**: open the active Worktree folder in the OS file manager or external editor.

#### 8. GA release-readiness polish

- First-run **Agent readiness checklist** (detecting `claude`, `codex`, `agy` and login status in one quiet screen).
- **Export / import Settings** (JSON backup of preferences, font preset, workflows, and Project settings).
- **Export sanitized debug bundle** in `Settings → About` (app/OS/Agent versions and redacted logs, never tokens or transcripts) for bug reports.

---

## `0.2.0` — Deeper autonomy, rewind & power workflows

**Goal:** Turn Spence from a calm multi-Agent workspace into a programmable, reversible engineering environment.

- **PR & Issue → Session triggers**
  - **"Review in a new Session"** button on Pull requests (opens a fresh Session on the PR's Worktree pre-loaded with PR context, unresolved review threads, or failing checks).
  - **"Start in a Session"** button on Issues (creates a Session—optionally on a fresh Worktree—pre-seeded with the Issue snapshot).
- **Embedded Browser v2 (100% loop)**
  - **Network / failed XHR capture** in the Human-to-Session Composer bridge alongside Screenshot, Element picker, and Console errors.
  - **Per-Project dev server / localhost launcher**: remember a Project's dev command and URL so opening the Browser pane can start or attach to `localhost:<port>` automatically.
- **Session rewind & Rewind checkpoints**
  - Snapshot Worktree state at Turn boundaries so users can **Edit & rewind** to any earlier Turn, with a confirmation modal listing the exact files and commits affected.
- **Custom Workflows**
  - Generalize `/coordinate` and `/divide-and-conquer` into user- and Project-defined **Workflows** (custom slash commands mapping roles to Agent, Model, Effort, and prompt templates).
- **Integrated Terminal**
  - A lightweight per-Worktree terminal drawer / Panel for running commands, watching dev servers, and sending selected terminal output directly into the Composer.
- **Agent visibility v2 (multi-Agent & live workspace)**
  - **Live Activity / Fleet view**: unified overlay showing all active Sessions and spawned Workers in a **Parent → Worker** tree with each one's live Ticker line, elapsed time, files touched, and `blocked` / `error` status.
  - **Live follow-along diff**: toggleable live diff / "Files touched this Turn" view updating mid-Turn so devs can watch edits land and use `Steer` early.
  - **Stall / loop detection hint**: quiet Ticker notice when an Agent produces no output past a threshold or repeats the same failing command, pairing with `Steer`, `Cancel`, and `Stop Agent`.
  - **Agent-to-Agent message trace**: collapsible hop/provenance trace for **Session-to-Session Messages** (local and across Paired Devices).
- **Context & token management v2**
  - **Auto-compact / handoff policy**: optional per-Settings or per-Project rule to trigger **Compaction** or prompt for a **Summary handoff** at a chosen context percentage.
  - **Session & Project cumulative Usage summary**: lightweight rollup of total Turns, time, tokens, and cost per Session (including spawned Workers) and per Project.

---

## Explicitly deferred (not in `0.1.0` or `0.2.0`)

- **Subscription quota** tracking (5-hour / weekly plan windows).
- Additional Git host adapters (GitLab, Bitbucket, Azure DevOps Repos) and Issue tracker adapters (Linear, Jira) beyond v1.
- Issue tracker write operations and Issue ↔ PR link hydration.
- Persistent per-Project Agent tool permission rules, additional Notification channels (voice / webhooks), and scheduled recurring Sessions.
