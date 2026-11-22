# Git hosts and Pull requests

Status: accepted for implementation on 2026-11-22 after explicit confirmation of shared understanding. This document specifies planned behavior; it does not describe a shipped feature.

## Destination and decision record

Integrate external **Git hosts** through a provider-agnostic ports-and-adapters domain model (with **GitHub** as the first concrete adapter in v1) so users can discover, inspect, create, draft with an ephemeral **Agent**, edit, review, comment on, and merge **Pull requests** per **Project** and **Worktree**/branch, and bring Pull request context into **Sessions** via the **Composer**. Preserve the approved Variant D dedicated Pull requests page, the three-tier multi-threaded execution model, and the existing renderer/main security architecture.

The canonical planning index is [Wayfinder: Git host integration, Pull requests and Composer PR context](https://github.com/ManuelUsoz/spence/issues/194). Product rationale remains in its resolved decisions; this document integrates their requirements into an implementation handoff. Architecture is resolved in [Define Git host and Pull request architecture and implementation spec](https://github.com/ManuelUsoz/spence/issues/245).

| Decision | Source |
| --- | --- |
| GitHub authentication, APIs, rate limits, and transport research | [Research GitHub auth, APIs, and npm packages for Electron PR integration](https://github.com/ManuelUsoz/spence/issues/195) |
| Domain model, ports-and-adapters seams, capabilities, read tiers, and error taxonomy | [Define the Git host and Pull request domain model (ports and adapters)](https://github.com/ManuelUsoz/spence/issues/196) |
| OAuth Device Flow / PAT / `gh` import, `safeStorage`, `HttpClient` over `net.fetch`, and GraphQL + REST split | [Decide GitHub authentication, token storage, and SDK/transport strategy](https://github.com/ManuelUsoz/spence/issues/197) |
| Variant D dedicated PR page, sidebar entry, and lower Composer strip indicator | [Prototype the PR surfaces across Project, Worktree/branch, and Composer](https://github.com/ManuelUsoz/spence/issues/198) |
| Create, ephemeral Agent drafting, edit with conflict resolution, pending reviews, and merge + local base update | [Define PR creation, editing, reviewing, commenting, and merge behavior](https://github.com/ManuelUsoz/spence/issues/199) |
| Per-Message Composer attachments, `@` picker, Start Session with lazy PR Worktrees, snapshots, and handoffs | [Define Composer and Session integration for Pull requests](https://github.com/ManuelUsoz/spence/issues/200) |
| Discovery scope, `#number` pins, ETag-gated focused polling, `Store` caching/eviction, and degraded/offline UX | [Define PR discovery, sync, caching, rate limits, and offline behavior](https://github.com/ManuelUsoz/spence/issues/210) |
| Process/thread placement, shared RPC seams, `Store` schemas, delivery stages, and verification matrix | [Define Git host and Pull request architecture and implementation spec](https://github.com/ManuelUsoz/spence/issues/245) |

Out of scope: production implementation during wayfinding, non-GitHub adapters in v1 (GitLab, Bitbucket, Azure DevOps), multiple connected accounts per Git host, self-hosted / GitHub Enterprise Server instances in v1, and cross-device / Remote device Pull request proxying.

## Existing code and required changes

- `SecretStorage` in `electron/devices/secret-storage.ts` and `electron/devices/secret-storage-electron.ts` already seals and opens secrets via Electron's asynchronous `safeStorage` API, refuses Linux `basic_text` fallback, and supports `SPENCE_E2E_SECRET_STORAGE` (`fake` / `unavailable`) under Playwright e2e. Reuse this module for `HostAuth` token sealing rather than creating a second encryption wrapper.
- `DesktopRpcs` (`src/shared/rpc/desktop-rpcs.ts`) and `DeviceScopedRpcs` / `RemoteRpcs` (`src/shared/rpc/remote-rpcs.ts`) separate Local-only RPC groups from Device-scoped groups served to Paired devices. Merge `PullRequestsRpcs` into `DesktopRpcs` as a **Local-only** group (never in `DeviceScopedRpcs` or `RemoteRpcs`).
- `Worktrees` (`src/shared/worktrees/worktrees.rpc.ts`, `electron/worktrees/worktrees.ts`, `electron/worktrees/worktrees-core.ts`) currently creates Worktrees from a local base branch without recording the origin branch. Record `createdFromBranch` when Spence creates a Worktree, and extend draft Worktree preparation to support lazy `refs/pull/<number>/head` fetch and checkout using the Settings-configured branch pattern.
- `runToolFreePrompt` in `electron/sessions/session-handoff.ts` already runs an isolated, tool-disabled ACP prompt (`CLIENT_CAPABILITIES` has no `fs` or `terminal`) that cancels immediately on any `tool_call`, `tool_call_update`, or `PermissionRequest`. Promote `runToolFreePrompt` to `electron/acp/` so both Summary handoffs and ephemeral Pull request creation drafting share one implementation.
- `Sessions` (`src/shared/sessions/sessions.rpc.ts`, `electron/acp/acpMappers.ts`, `src/shared/sessions/handoff.ts`) defines `MessagePart`, `ComposerDraft`, `toAcpPrompt`, and `buildStructuredTranscriptExtract`. Extend these contracts for per-Message Pull request attachments and immutable send-time snapshots.
- `Projects.remove` (`electron/projects/`) retains a tombstone in `projects.json` so re-adding a folder restores its Sessions. Add a cache-eviction hook so removing a Project immediately purges `pull-requests/projects/<projectId>/` from `Store` and memory.

## Three-tier execution and multi-threading model

Keep the Electron main thread thin and auditable while keeping the Angular renderer responsive at 60 fps by splitting work across three execution tiers:

| Tier | Runtime & location | Responsibilities | Security & CSP invariants |
| --- | --- | --- | --- |
| **1. Thin Main Thread** | Electron main process (`electron/git-hosts/`, `electron/rpc/pull-requests.ts`) | `SecretStorage` token sealing/opening and Linux `basic_text` check; raw HTTP execution through Effect `HttpClient` backed by Electron `net.fetch`; per-host `Semaphore(4)`, in-flight read coalescing, REST `If-None-Match` (`304`) ETag table, and rate-limit/auth state transitions; `BrowserWindow` focus/blur polling lifecycle; `shell.openExternal` for Device Flow and external links; atomic `Store` reads/writes; `AcpClient` stdio for ephemeral PR drafting. | Tokens never leave main memory or `SecretStorage`. Raw network calls use `net.fetch` in main so Chromium's OS proxy (PAC/WPAD/NTLM) and OS certificate stores apply. |
| **2. Backend Worker & Source-Control Worker** | Node `worker_threads` (`electron/git-hosts/pr-worker.ts`, bundled to `dist-electron/pr-worker.js`) + source-control worker (`electron/source-control/`) | **PR worker thread**: CPU-bound parsing of multi-file raw unified diffs (`parseUnifiedDiff` with per-file and total byte/line caps), normalization of large GraphQL `statusCheckRollup` and `reviewThreads` payloads into domain schemas, and assembly/truncation of bounded send-time Composer PR snapshots (`~8 KB` body, `~24 KB` patches, 25 unresolved threads, 20 failing/pending checks). **Source-control worker**: all local Git subprocesses (`git remote -v`, `base..HEAD` commit log/diff for drafting, `pull_request_template.md` read, `git push` for **Push & create**, `git fetch refs/pull/<n>/head` + `git worktree add` for **Start Session**, and post-merge base-branch fast-forward). | Receives only structured-cloneable payloads from main (never raw tokens or Electron handles). Bundled explicitly in `scripts/build-electron.mjs`. |
| **3. Renderer Web Worker** | Browser module Web Worker (`src/app/features/pull-requests/pr-render.worker.ts`) | Offloads CPU-heavy UI preparation off the Angular UI thread: **Shiki** syntax highlighting and word-level diff decoration across up to 100 changed files, anchoring inline **Review thread** line ranges (`oldLine` / `newLine`) onto diff hunks, and **Remark** (`unified` / `remark-parse` / `remark-gfm`) Markdown parsing for PR descriptions, review comments, and 16 KB check summaries. | Bundled by Angular CLI as a same-origin `.js` chunk (`new Worker(new URL('./pr-render.worker', import.meta.url), { type: 'module' })`), satisfying `script-src 'self'` in `src/index.html` with no CSP relaxation and no access to `window.desktop`. |

## Domain ownership and interfaces

| Owner | Shared contract and main handler | Responsibility |
| --- | --- | --- |
| Pull requests & Git hosts | `src/shared/pull-requests/pull-requests.rpc.ts`, `electron/rpc/pull-requests.ts` | Local-device `HostAuth` account lifecycle (Device Flow, PAT, `gh` import, verify, disconnect), Project → Remote repository resolution, PR discovery/detail/diff, `#number` pinning, ephemeral Agent drafting, PR mutations (create, edit, comment, review, resolve thread, merge, post-merge base update), and live `PullRequests.changes` stream |
| Settings | `src/shared/settings/settings.rpc.ts`, `electron/rpc/settings.ts` | Global `PullRequestSettings` (`draftingEnabled`, `draftingAgent`, `draftingModel`, `autoUpdateBaseBranchAfterMerge`, `worktreeBranchPattern`) under Local `Settings` |
| Projects | `src/shared/projects/projects.rpc.ts`, `electron/rpc/projects.ts` | Per-Project `ProjectSettings.targetRemote` override (`upstream` / `origin` / explicit remote name) and immediate PR cache purge on `Projects.remove` |
| Worktrees | `src/shared/worktrees/worktrees.rpc.ts`, `electron/rpc/worktrees.ts` | Persisting `createdFromBranch` on Worktree creation and lazy `refs/pull/<number>/head` fetch + Worktree checkout when preparing a draft Session started from a Pull request |
| Sessions | `src/shared/sessions/sessions.rpc.ts`, `electron/rpc/sessions.ts` | `PullRequestPart` in `MessagePart`, `pullRequests` in `ComposerDraft` (max 5, deduplicated), send-time PR snapshotting with offline cached fallback, ACP `text` block serialization in `toAcpPrompt`, and `Pull requests referenced` in `buildStructuredTranscriptExtract` |

### Deep internal seams (`electron/git-hosts/`)

Behind `electron/rpc/pull-requests.ts`, two deep modules sit behind `GitHostRegistry` (which dispatches by `GitHostKind`, `'github'` in v1):

1. **`HostAuth` (`electron/git-hosts/host-auth.ts`)**:
   - Owns authentication ceremony lifecycles, token persistence via `SecretStorage`, Linux `basic_text` session-only fallback, scope validation, and `HostAccount` state (`connected` | `needs-reconnect`).
   - Exposes `getAccount(host)`, `startDeviceFlow(host)`, `pollDeviceFlow(host, flowId)`, `cancelDeviceFlow(host, flowId)`, `connectWithPat(host, token, persistMode)`, `importFromGhCli(host, persistMode)`, `verify(host)`, `markNeedsReconnect(host, detail)`, `disconnect(host)`, and internal `withToken(host, use)` for adapters.
   - `withToken` is package-internal to `electron/git-hosts/`; raw tokens never cross into RPC schemas, logs, worker threads, or the renderer.

2. **`GitHost` (`electron/git-hosts/git-host.ts` & `electron/git-hosts/github/github-adapter.ts`)**:
   - Owns remote URL parsing (`parseRemoteUrl`), static `HostCapabilities` (`supportsDraft`, `supportsThreadResolution`, `supportsAutoMerge`, `supportsPendingReviews`, `supportsMilestones`, `supportedMergeMethods`), PR reads (`listForRepo`, `getSummaryByNumber`, `getDetail`, `getDiff`), and PR mutations (`create`, `update`, `addComment`, `editComment`, `deleteComment`, `submitReview`, `deletePendingReview`, `resolveThread`, `unresolveThread`, `merge`, `setAutoMerge`).
   - Hides GraphQL vs REST routing, pagination, `If-None-Match` ETag maps, per-host `Semaphore(4)`, identical in-flight read coalescing, rate-limit reset tracking (`Retry-After` / `x-ratelimit-reset`), and worker-thread offloading behind its interface.
   - Normalizes all failures at the seam into `GitHostError`:
     ```ts
     export class GitHostError extends Schema.TaggedError<GitHostError>()('GitHostError', {
       reason: Schema.Literals([
         'NotAuthenticated',
         'TokenExpired',
         'Forbidden',
         'NotFound',
         'ValidationFailed',
         'Conflict',
         'RateLimited',
         'UnsupportedCapability',
         'NetworkUnavailable',
         'HostError',
       ]),
       detail: Schema.String,
       retryAfterSeconds: Schema.optionalKey(Schema.Number),
       resetAt: Schema.optionalKey(Timestamp),
       conflictingFields: Schema.optionalKey(Schema.Array(Schema.String)),
     }) {}
     ```

### Shared RPC contract (`src/shared/pull-requests/pull-requests.rpc.ts`)

- **Branded IDs & refs**:
  - `GitHostKind = Schema.Literals(['github'])`
  - `PullRequestNumber = Schema.Int.pipe(Schema.brand('PullRequestNumber'))`
  - `RemoteRepoRef = Schema.Struct({ host: GitHostKind, canonicalPath: Schema.String })` (normalized lowercase `owner/repo` on GitHub)
  - `PullRequestRef = Schema.Struct({ repo: RemoteRepoRef, number: PullRequestNumber })`
  - `ReviewId`, `ReviewThreadId`, `CommentId`, `CheckRunId`, `DeviceFlowId` branded with `Schema.brand`.
- **Three-tier read schemas**:
  - `PullRequestSummary`: `ref`, `title`, `state` (`'open' | 'draft' | 'merged' | 'closed'`), `author`, `headRef`, `headSha`, `headRepo: Schema.NullOr(RemoteRepoRef)`, `baseRef`, `updatedAt: Timestamp`, `url`, `checkRollup` (`'pending' | 'passing' | 'failing' | 'none'`), `reviewDecision` (`'approved' | 'changesRequested' | 'reviewRequired' | 'none'`), `commentCount`, `unresolvedThreadCount: Schema.NullOr(Schema.Number)`, `viewerRoles: Schema.Array(Schema.Literals(['author', 'reviewer', 'assignee']))`, `isCrossRepo: Schema.Boolean`, `isPinned: Schema.optionalKey(Schema.Boolean)`.
  - `PullRequestDetail`: extends `PullRequestSummary` with `body`, `mergeState` (`'clean' | 'blocked' | 'behind' | 'dirty' | 'unstable' | 'draft' | 'unknown'`), `mergeStateReason: Schema.optionalKey(Schema.String)`, `autoMergeEnabled: Schema.Boolean`, `labels: Schema.Array(PullRequestLabel)`, `reviewers: Schema.Array(HostActor)`, `assignees: Schema.Array(HostActor)`, `milestone: Schema.NullOr(PullRequestMilestone)`, `repoLabels: Schema.Array(PullRequestLabel)`, `repoMilestones: Schema.Array(PullRequestMilestone)`, `collaborators: Schema.Array(HostActor)`, `checks: Schema.Array(CheckRun)`, `reviews: Schema.Array(Review)`, `reviewThreads: Schema.Array(ReviewThread)`, `comments: Schema.Array(PullRequestComment)`, `actions: PullRequestActions`, and `revision: PullRequestRevision` (`{ headSha, updatedAt }`).
  - `PullRequestDiff`: `ref`, `headSha`, `baseSha`, `files: Schema.Array(PullRequestDiffFile)` (`path`, `previousPath`, `status`, `additions`, `deletions`, `hunks: Schema.Array(DiffHunk)`, `truncated: Schema.Boolean`, `noPreviewReason: Schema.optionalKey(...)`).
- **Project PR state & degraded sync status**:
  - `ProjectPullRequestsState` (returned by `PullRequests.getProjectState` and streamed on `PullRequests.changes`):
    - `Unavailable`: `{ reason: 'NonGit' | 'NoSupportedRemote' | 'MissingGit' | 'FolderMissing', detail }`
    - `Available`: `{ projectId, repo: RemoteRepoRef, targetRemoteName, headRemoteName, capabilities: HostCapabilities, accountStatus: 'disconnected' | 'connected' | 'needs-reconnect', syncStatus: SyncStatus, lastSyncedAt: Schema.NullOr(Timestamp), summaries: Schema.Array(PullRequestSummary), worktreeLinks: Schema.Record(Schema.String, WorktreePullRequestLink) }`
    - `SyncStatus`: `'idle' | 'syncing' | 'offline' | 'rate-limited' | 'needs-reconnect'`, carrying `resetAt?: Timestamp` and `detail?: string`.
- **RPC methods in `PullRequestsRpcs`**:
  - Auth: `HostAuth.getAccounts`, `HostAuth.startDeviceFlow`, `HostAuth.pollDeviceFlow`, `HostAuth.cancelDeviceFlow`, `HostAuth.connectPat`, `HostAuth.checkGhCli`, `HostAuth.importGhCli`, `HostAuth.verify`, `HostAuth.disconnect`.
  - Discovery & reads: `PullRequests.changes` (stream), `PullRequests.setActiveView` (tells main which Project is active, whether the Variant D PR page is open, and which `PullRequestNumber` detail is open so focused polling uses the right cadence), `PullRequests.getProjectState`, `PullRequests.refreshProject`, `PullRequests.lookupByNumber` (fetches `#number` on demand and pins it for the session), `PullRequests.unpinNumber`, `PullRequests.getDetail`, `PullRequests.getDiff`.
  - Creation & drafting: `PullRequests.prepareCreate` (inspects the Worktree/branch: `createdFromBranch` or repo default branch, ahead/behind counts, unpushed commits requiring **Push & create**, dirty working-tree note, existing open PR blocker, and vendor `pull_request_template.md`), `PullRequests.draftCreate` (scoped tool-free Agent run returning `{ title, body }`), `PullRequests.create` (executes normal `git push` first when `pushFirst: true` and not yet pushed, then `GitHost.create`).
  - Mutations: `PullRequests.update` (takes `revision: PullRequestRevision` and patch fields; checks remote fields on `revision` mismatch and returns field-level `Conflict` only when the same edited field changed remotely), `PullRequests.addComment` (general comment, immediate inline comment, or pending-review thread comment), `PullRequests.editComment`, `PullRequests.deleteComment`, `PullRequests.submitReview` (Comment / Approve / Request changes), `PullRequests.resolveThread`, `PullRequests.unresolveThread`, `PullRequests.merge` (requires `expectedHeadSha`, `method`, optional `commitTitle`/`commitMessage`), `PullRequests.setAutoMerge`, `PullRequests.updateLocalBaseBranch`, `PullRequests.switchToBaseBranch`.

## Discovery, ETag-gated polling, `Store` layout, and eviction

### Remote resolution & branch matching

- **Project → Remote repository**: Parse `git remote -v` URLs through registered `GitHost` adapters. When both `upstream` and `origin` parse to different repositories on the same `GitHostKind`, select `upstream` as the target `Remote repository` and retain `origin` as the head/push remote (fork workflow). Otherwise prefer `origin`, else the first supported remote. If `ProjectSettings.targetRemote` is set, use that remote as target.
- **Worktree → Pull request**: Match strictly by head branch (`headRef === worktree.branch`, plus `headRepo` matching `origin` in a fork workflow), never by base branch. Detached `HEAD` and unpushed local branches have no linked PR. Prefer open PRs (most recently updated primary; expose `openCount` and sibling refs if `> 1` open PR shares the branch). Fall back to the most recent merged/closed PR only when no open PR exists and `pr.headSha === worktree.headSha`; once the user commits new work ahead of `pr.headSha`, transition the link back to "no open PR" (**Create PR**).

### Focused polling & REST `If-None-Match` (`304`) gating

- **Scope & focus**: Poll only the **currently active Project** in the focused window. Pause all background timers when the window is blurred or minimized; on window `focus`, run a refresh if at least **30s** have elapsed since `lastSyncedAt`.
- **Cadences**:
  - **60s** summary poll while the active Project's Variant D PR page is open.
  - **3m** summary poll while in Session view (keeping the lower Composer `+a −d` PR pill current).
  - **20s** detail poll while a PR detail is open on the PR page and its `checkRollup === 'pending'`.
- **ETag gate**:
  - Background summary polls send `GET /repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc&per_page=30` with `If-None-Match`. On `304 Not Modified` (0 rate-limit cost), skip GraphQL hydration.
  - Background open-detail polls send `GET /repos/{owner}/{repo}/pulls/{number}` (and `GET /repos/{owner}/{repo}/commits/{headSha}/check-runs` while checks are `pending`) with `If-None-Match`; re-run GraphQL `getDetail` only when an ETag changes.
  - Explicit manual **Refresh**, opening a PR detail from the list, post-mutation refreshes, and post-push refreshes bypass the ETag gate so GraphQL-only state changes (such as resolving a **Review thread**) appear immediately.
  - At **Turn** end in an active Worktree, run a debounced ETag-gated summary check so Agent-run `gh pr create` or `git push` commands reflect in the strip at 0 quota cost on `304`.

### Versioned `Store` layout and eviction

Under `<userData>/spence/`:

```text
git-hosts/accounts.json
worktrees/branch-origins.json
pull-requests/projects/<projectId>/summaries.json
pull-requests/projects/<projectId>/details-lru.json
```

- `git-hosts/accounts.json` (`VersionedFile`, `version: 1`): per-`GitHostKind` record holding `account: HostAccount` (`host`, `handle`, `displayName`, `avatarUrl`, `authMethod: 'device-flow' | 'pat' | 'gh-cli'`, `scopes`, `status: 'connected' | 'needs-reconnect'`, `statusDetail`, `updatedAt`) and optional `sealedToken: string` (base64 ciphertext from `SecretStorage.seal`; omitted when the user opted into session-only memory storage on Linux `basic_text`).
- `worktrees/branch-origins.json` (`VersionedFile`, `version: 1`): maps normalized `(worktreeRealPath, branch)` → `{ createdFromBranch: string, recordedAt: Timestamp }`.
- `pull-requests/projects/<projectId>/summaries.json` (`VersionedFile`, `version: 1`): `{ repo: RemoteRepoRef, targetRemoteName: string, headRemoteName: string, lastSyncedAt: Timestamp, summaries: PullRequestSummary[], worktreeLinks: Record<string, WorktreePullRequestLink> }`. On-demand `#number` pins are held in memory for the current app session only and stripped before writing `summaries.json`.
- `pull-requests/projects/<projectId>/details-lru.json` (`VersionedFile`, `version: 1`): `{ entries: PullRequestDetail[] }` capped at the **20 most recently viewed** PR details for that Project. `PullRequestDiff` file patches are never written to disk; they live in a bounded in-memory LRU (max 15 diffs).
- **Mandatory eviction hooks**:
  - `Projects.remove(projectId)` calls `store.removeDir('pull-requests/projects/<projectId>')` and clears all in-memory PR state, ETag entries, pins, and cached diffs for `projectId`.
  - `HostAuth.disconnect(host)` (or reconnecting as a different `HostAccount.handle`) removes the account from `git-hosts/accounts.json`, calls `store.removeDir('pull-requests')`, and clears all in-memory PR state, ETag entries, pins, and diffs across all Projects.

## Lifecycle mutations, ephemeral Agent drafting, and post-merge automation

### Create & ephemeral Agent drafting

- **Prerequisites**: Unpushed commits switch the primary action to **Push & create** (running normal Git push to `headRemoteName` before `GitHost.create`; if push succeeds and PR creation fails, retry skips the push). A dirty working tree shows a non-blocking note linking to Changes. Hard blockers (disabling Create with an explicit reason): detached `HEAD`, 0 commits ahead of the selected base branch, an open PR already existing for `headRef`, or no connected `HostAccount`.
- **Base branch & template**: When opened from a Session, default `baseRef` to the Worktree's `createdFromBranch` (falling back to the remote repository's default branch); when opened from the sidebar PR page without a Session context, default to the repository's default branch. Initialize the body from the checkout's `pull_request_template.md` (checking `.github/pull_request_template.md`, `pull_request_template.md`, and `docs/pull_request_template.md` case-insensitively).
- **Ephemeral Agent drafting (`PullRequests.draftCreate`)**:
  - Configured globally in **Settings → Pull requests** (`draftingEnabled`, `draftingAgent`, `draftingModel`).
  - When enabled, opening the Create PR form automatically invokes `PullRequests.draftCreate` inside an `Effect.scoped` call.
  - Main resolves the configured Agent and Model, gathers bounded input from the source-control worker (`base..HEAD` commit log, diffstat, unified diff truncated at 24 KB, and the PR template), and invokes `runToolFreePrompt` in `electron/acp/`.
  - If the user has not typed in title/body when drafting completes, fill them directly; if the user has started typing, show an **Apply draft** banner. Clicking **Redraft** confirms before replacing user-edited text. Closing the Create form cancels the RPC call, interrupting the fiber and closing the isolated ACP session. Any failure surfaces as a quiet inline `"Couldn't draft"`.

### Edit, comment, review & merge

- **Field-level conflict detection on Edit**: `PullRequests.update` compares the caller's `revision` (`headSha` + `updatedAt`) against a fresh fetch when `updatedAt` has advanced. If a field the user edited (e.g. `body` or `title`) differs from the value at the user's `revision`, fail with `GitHostError({ reason: 'Conflict', conflictingFields })` and return the latest `PullRequestDetail` so the UI displays `"Changed on GitHub"` with **Keep mine** / **Use theirs**. If only unrelated fields changed remotely, apply the user's patch without error.
- **Comments & pending Reviews**: General conversation comments post immediately. Inline diff comments (single lines, multi-line ranges, and deleted-side lines) join the viewer's pending **Review** by default when `capabilities.supportsPendingReviews` is true, with a secondary **Comment now** action for immediate single comments. **Finish review** submits the pending Review with optional summary text and `Comment`, `Approve` (disabled on viewer's own PR), or `Request changes` (disabled on viewer's own PR; requires non-empty body or inline comments). Thread resolution toggles in one click via `PullRequests.resolveThread` / `PullRequests.unresolveThread`.
- **Gated Merge & post-merge local base update**:
  - Merge is enabled only when `actions.canMerge` is true and `mergeState` is mergeable; no admin bypass is offered. One confirmation step displays the merge method (`allowedMergeMethods`, defaulting to repo preference else `squash`), target base branch, and short `headSha`. `PullRequests.merge` passes `expectedHeadSha`; if the remote head advanced, GitHub rejects the SHA mismatch and Spence surfaces `Conflict` requiring a fresh review.
  - When `Settings.pullRequests.autoUpdateBaseBranchAfterMerge` is `true` (the default), a successful merge immediately triggers `updateLocalBaseBranch` through the source-control coordinator:
    - If `<baseRef>` is checked out in a Worktree that is **clean** and has **all Sessions idle**, run `git pull --ff-only` in that Worktree.
    - If `<baseRef>` is not checked out in any Worktree, run `git fetch <targetRemoteName> <baseRef>:<baseRef>` to fast-forward the local branch ref without touching any working tree.
    - If a precondition fails (dirty Worktree, running Turn, or non-fast-forward divergence), touch nothing and display the Merged strip's **Update `<baseRef>`** action disabled with the exact reason.
  - **Switch to `<baseRef>`** is offered as a separate explicit action on the merged Worktree when it is clean, all its Sessions are idle, and `<baseRef>` is not checked out in another Worktree.

## Composer and Session integration

### Per-Message attachments, `@` picker & Dedicated PR page actions

- **Clean Composer & attachment pills**: The Composer shows no permanent PR chip above the input. PR context is a per-Message attachment (`ComposerPullRequestAttachment`, max **5** per Message, deduplicated by target), rendered as a removable pill inside the Composer while attached, persisted in `ComposerDraft.pullRequests` across window reloads, and cleared on send.
- **Composer `@` picker**: Typing `@` at the start of the Composer input or after whitespace opens a floating popover (`↑`/`↓` navigate, `Enter`/`Tab` attach, `Esc` dismiss). It ranks the active Worktree's linked PR first, filters cached Project PRs by `#number`, title, branch, or author, and supports typing `@#<number>` to trigger `PullRequests.lookupByNumber` on demand. Selecting an item removes the `@query` token from the text and adds the attachment pill without sending.
- **Reference in Session**: Clicking **Reference in Session** on a PR header, **Review thread**, or failing **Check run** on the Variant D PR page attaches that target to the Project's active editable Session Tab (excluding read-only/native **Workers**), falling back to the Project's most recently active open Session Tab or a new draft Session in the Project's current checkout, and focuses the Composer without auto-sending.
- **Start Session from a PR**:
  - Clicking **Start Session** on a PR opens a new draft Session with that PR pre-attached in `ComposerDraft.pullRequests`.
  - If an existing Worktree already has the PR's head branch checked out (matching `headRef` + `headRepo`), the draft binds to that Worktree.
  - Otherwise, the draft's Worktree selector is pre-set to create a dedicated PR Worktree lazily on first send (switchable back to **Current checkout**).
  - The branch name is computed from `Settings.pullRequests.worktreeBranchPattern`: for same-repo PRs where `{headRef}` does not collide with an existing local branch, use `{headRef}` by default; for fork (`isCrossRepo`) PRs or colliding branch names, apply the pattern (default `pr/{number}`, disambiguating collisions with `pr/{number}-{headRef}`, supporting `{number}`, `{headRef}`, `{author}`). On first send, `Worktrees.prepareDraft` fetches `refs/pull/<number>/head` from the target remote and creates the Worktree before starting the Turn. If a closed/merged PR's head ref is unfetchable, disable new PR Worktree creation with a reason and keep the draft on **Current checkout**.

### Send-time snapshotting, ACP prompt serialization & Summary handoffs

- **Immutable send-time snapshot**: When `Session.prompt`, `Session.enqueue`, or `Session.steer` runs with PR attachments, main refreshes the target PR detail (pinned to `headSha` + `updatedAt`), formats the bounded snapshot on the PR worker thread, and stores it as a `PullRequestPart` on the user `Message` in the **Transcript**:
  - **Whole PR**: metadata (`#number`, title, state, URL, author, `headRepo:headRef → baseRef`, `headSha`, `mergeState`, `reviewDecision`, labels, and whether the Session's Worktree `HEAD === headSha` cleanly), PR body capped at **8 KB** (`[truncated]`), `checkRollup` + counts + details for **failing and pending** checks only (capped at **20**), all **unresolved** `ReviewThread`s (file path, line/range, comments in order, capped at **25** threads) + resolved thread count + up to **15** most recent general comments, and file-level diff summary (up to **100** files, `+a −d`). Inline unified patch hunks (capped at **24 KB** total, omitting generated/oversized files marked `truncated: true`) are included **only when** the Session's Worktree is not cleanly at `headSha`.
  - **Targeted Review thread**: minimal PR header + file path, line/range, diff hunk context, all thread comments in order, and resolution state.
  - **Targeted failing Check run**: minimal PR header + `checkRollup` + check `name`, `status`, `conclusion`, `url`, and `summary` excerpt capped at **16 KB**.
- **Offline fallback**: If send-time refresh fails due to network/rate-limit/auth loss and a cached `PullRequestDetail` exists in `Store` (`details-lru.json`) or memory, main uses the cached record prefixed with `[cached snapshot · fetched at <ISO-time>; offline/unreachable]`. If no cached detail exists, fail before starting the Turn with an actionable error so the Composer keeps its draft text and attachments intact.
- **ACP serialization & Thread pills**: `toAcpPrompt` serializes each `PullRequestPart` into an ACP `text` `ContentBlock` wrapped in clear `<pull_request_context>` tags so every Catalog Agent (`Claude`, `Codex`, `Antigravity`) receives it reliably. In the Thread and Queue UI, `PullRequestPart` renders as a compact clickable pill (`PR #198 · <title>`, `Review thread · <path>:<line>`, `Check · <name>`) with a `<shortSha> · <state>` tooltip that opens the Variant D PR page to that target when clicked.
- **Summary handoffs & Forks**: `buildStructuredTranscriptExtract` in `src/shared/sessions/handoff.ts` scans `PullRequestPart` items across the Transcript and appends a `Pull requests referenced:` line summarizing each referenced PR/thread/check (`PR #<n> (<title>, <headSha>)`).

## Approved UI, typography, and accessibility

Follow the [reviewed Variant D prototype](https://github.com/ManuelUsoz/spence/tree/a4d609b8ad758ee981b47fc58ef677f36ff98d36/src/app/features/session/pr-surfaces-prototype) and `AGENTS.md` typography rules:

- **Two entry points**:
  1. **Left sidebar**: A quiet `Pull requests` row under the Project selector (above the intact Sessions list), showing an open count badge when available.
  2. **Lower Composer strip**: A compact pill directly beside the `+a −d` diff count below the Composer showing `#<number>` + check rollup dot when the active Worktree's branch has a linked PR (clicking opens the dedicated PR page to that PR's detail), or **Create PR** when it has no linked PR (clicking opens the dedicated PR page to the Create PR form).
- **Variant D dedicated PR page (`src/app/features/pull-requests/`)**:
  - Opens in the main content area (matching Settings and Changes).
  - The primary detail canvas (or Create PR form) sits directly beside the app's left sidebar—never rendering a second left sidebar—while the repository's filterable PR list sits in a floating rounded container on the right (`All`, `Mine`, `Review requested`, `#number` lookup/pin).
  - Displays a single quiet status strip at the top of the PR page when degraded (`Offline · cached <age>`, `GitHub rate limit reached · resets at <time> · cached`, or `Reconnect GitHub in Settings · cached`) with a **Retry** or **Reconnect** button, keeping cached summaries and details readable and disabling write actions.
- **Typography & Spartan helm**:
  - **Goeist** (`font-sans`) for all prose, titles, comments, buttons, filters, and status labels; `tabular-nums` for PR numbers, check counts, and `+a −d` diff stats.
  - **Goeist Mono** (`font-mono`, regular weight, `text-xs` beside `text-sm`) for branch names (`headRef → baseRef`), commit SHAs, file paths, unified diff lines, check identifiers, and keyboard shortcuts.
  - **The voice** (`font-display`) at `text-xl` or larger only on quiet empty states (e.g., `"No Pull requests in ‹Project› yet."` or `"Connect GitHub to view Pull requests."`).
  - Use Spartan helm wrappers in `src/app/ui` (`@ui/*`) and theme tokens in `src/styles.css`.

## Incremental delivery and acceptance

Stages may merge independently behind clean feature seams. These are implementation stages, not additional wayfinder decision tickets.

| Stage | Work and dependencies | Exit criteria |
| --- | --- | --- |
| 1. Contracts, `HostAuth`, and GitHub transport | `src/shared/pull-requests/pull-requests.rpc.ts` (Local-only in `DesktopRpcs`), `Settings` and `ProjectSettings` extensions, `HostAuth` over `SecretStorage` (Device Flow, PAT paste, `gh auth token` import, Linux `basic_text` session-only guard), `Settings → Git hosts` and `Settings → Pull requests` UI, `GitHostRegistry`, and GitHub `HttpClient` over `net.fetch` (`Semaphore(4)`, read coalescing, `GitHostError`) | Device Flow, PAT, and `gh` import connect/verify/disconnect cleanly; Linux `basic_text` refuses silent disk persistence and runs session-only; `401` / missing scopes transition to `needs-reconnect` without clearing account context; tokens never cross IPC |
| 2. Discovery, ETag sync, `Store` cache, and workers | Remote resolution (`upstream` → `origin` + `ProjectSettings.targetRemote`), Worktree head-branch matching, hybrid GraphQL + REST `listForRepo`/`getDetail`/`getDiff`, `electron/git-hosts/pr-worker.ts` (`node:worker_threads`), focused active-Project polling with `If-None-Match` (`304`) gating, `Store` `summaries.json` + 20-entry `details-lru.json`, and eviction hooks on `Projects.remove` and `HostAuth.disconnect` | Unchanged background polls short-circuit on `304` with 0 GraphQL calls; inactive Projects and unfocused windows do not poll; `#number` lookup pins for the session; `Projects.remove` and `HostAuth.disconnect` purge `Store` and memory caches immediately |
| 3. Variant D read surfaces and Renderer Web Worker | Left sidebar `Pull requests` entry, lower Composer `+a −d` PR pill, Variant D dedicated PR page with floating right PR list container, `pr-render.worker.ts` (Shiki syntax highlighting, word-diff decoration, Review thread line anchoring, Remark GFM parsing), and degraded/offline cached banner | Variant D layout matches approved prototype; 100-file diffs and long Markdown threads render off the UI thread via Web Worker under existing CSP; cached PRs remain readable offline/rate-limited |
| 4. Create, ephemeral Agent drafting, edit, review, and merge | Worktree `createdFromBranch` persistence, template loading, **Push & create**, shared `runToolFreePrompt` in `electron/acp/` for scoped Agent drafting, metadata/milestone editing with field-level `revision` conflict UI, comments, pending reviews, **Finish review**, thread resolution, gated merge with `expectedHeadSha`, auto-merge, and post-merge local base-branch fast-forward + **Switch to `<base>`** | Ephemeral drafting cancels on tool attempt or form close; stale edits on the same field offer **Keep mine** / **Use theirs** while unrelated remote edits succeed; merge pins reviewed `headSha`; post-merge fast-forwards clean idle base Worktree or ref via fetch and refuses dirty/busy ones with a clear reason |
| 5. Composer `@` picker, Session snapshots, and lazy PR Worktrees | Composer `@` picker, **Reference in Session** (PR, thread, failing check), **Start Session** with `worktreeBranchPattern` and lazy `refs/pull/<n>/head` checkout in `Worktrees.prepareDraft`, send-time snapshotting (`PullRequestPart` on `Message`, offline cached fallback, `toAcpPrompt` serialization), Thread/Queue clickable pills, and `buildStructuredTranscriptExtract` updates | `@` picker and PR page attach up to 5 deduplicated items in `ComposerDraft`; first send on a PR draft fetches `refs/pull/<n>/head` and creates the Worktree; `PullRequestPart` omits diff patches when `HEAD === headSha` cleanly and falls back to cached snapshot when offline; handoffs include `Pull requests referenced` |

### Required verification matrix

- **Auth & secret storage (`electron/git-hosts/host-auth.spec.ts`)**: Device Flow polling schedule (`authorization_pending`, `slow_down`, `expired_token`, `access_denied`, cancellation), Classic PAT scope verification (`x-oauth-scopes` requiring `repo` and `read:org`), `gh auth token` import via merged PATH, Linux `basic_text` storage refusal + session-only memory mode, and `401` → `needs-reconnect` transition.
- **Transport, ETag gating & rate limits (`electron/git-hosts/github-adapter.spec.ts`)**: Fake `HttpClient` + controllable Effect `TestClock` verifying `If-None-Match` `304` short-circuiting on summary and pending-check detail polls, ETag bypass on manual refresh/mutation/detail open, `Semaphore(4)` concurrency cap, identical in-flight read coalescing, `403`/`429` `Retry-After` / `x-ratelimit-reset` polling suspension, and 30s window-focus cooldown.
- **Worker thread & snapshot bounding (`electron/git-hosts/pr-worker.spec.ts`)**: Multi-file unified diff parsing (`parseUnifiedDiff`), binary/oversized file truncation, Check Run + legacy Commit Status rollup normalization (`neutral`/`skipped` non-blocking), and Composer snapshot bounding (`8 KB` body cap, `24 KB` patch cap, patch omission when `HEAD === headSha` cleanly, 25 unresolved threads, 20 failing/pending checks, `16 KB` targeted check summary).
- **Local Git, fork remotes & post-merge (`electron/worktrees/` & `electron/source-control/` specs with real local Git repositories)**: `upstream` + `origin` fork detection and `ProjectSettings.targetRemote` override; `createdFromBranch` persistence; **Push & create** partial-failure retry (push not repeated after succeeding); lazy `git fetch <remote> refs/pull/<n>/head` Worktree creation with `{headRef}` vs `pr/{number}` collision disambiguation; post-merge fast-forward when base is checked out clean & idle vs checked out nowhere vs dirty/busy refusal.
- **Cache persistence & eviction (`electron/git-hosts/pr-store.spec.ts`)**: `summaries.json` and 20-item `details-lru.json` persistence across restart, stripping session-only `#number` pins on save, immediate directory removal on `Projects.remove`, and full `pull-requests/` wipe on `HostAuth.disconnect` or account change.
- **Renderer unit & Playwright e2e (`src/app/features/pull-requests/`, `e2e/`)**: Renderer tests using `makeDesktopTestLayer`; Playwright e2e covering connecting GitHub via fake `SecretStorage` and local mock GitHub server, Variant D dedicated PR page navigation from sidebar and lower Composer `+a −d` pill, creating/drafting/reviewing/merging a PR, attaching PR/thread/check context via `@` picker and **Reference in Session**, starting a Session from a PR, and verifying visual snapshots. Final repository gate is `npm run verify`.
