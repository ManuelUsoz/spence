# Issue trackers and Composer Issue references

Status: accepted for implementation on 2026-11-23 after explicit confirmation of shared understanding. This document specifies planned behavior; it does not describe a shipped feature.

## Destination and decision record

Integrate external **Issue trackers** through a provider-agnostic ports-and-adapters domain model (with **GitHub Issues** and **Azure DevOps Boards** in v1, while leaving the seam open for Linear and Jira later) so users can connect a **Tracker account**, bind each **Project** to a **Tracker project** and **Tracker scope**, browse and search **Issues** on a dedicated Issues page reached from a new sidebar entry, and reference **Issues** in the **Composer** via `!` as bounded per-**Message** context.

The canonical planning index is [Wayfinder: Issue tracker integration and Composer Issue references](https://github.com/ManuelUsoz/spence/issues/260). Product rationale and architectural records live in its resolved decisions and ADRs [0008](file:///c:/Users/miuso/workspace/nxy/spence/docs/adr/0008-separate-issue-tracker-from-git-host.md) and [0009](file:///c:/Users/miuso/workspace/nxy/spence/docs/adr/0009-issue-tracker-worker-with-main-transport.md).

| Decision | Source |
| --- | --- |
| GitHub Issues read APIs, permissions, rate limits, and ETag behavior | [Research GitHub Issues API, auth reuse and rate limits for read-only Issue access](https://github.com/ManuelUsoz/spence/issues/261) |
| Azure DevOps Boards WIQL, batch hydration, relations, states, and throttling | [Research Azure DevOps Boards work items API, auth and URL shapes](https://github.com/ManuelUsoz/spence/issues/262) |
| Variant B dedicated Issues page, sidebar entry, filters, and Reference in Session | [Prototype the Issues page and its menu entry](https://github.com/ManuelUsoz/spence/issues/263) |
| Provider-agnostic Issue model, `IssueTracker` port, capabilities, and `IssueTrackerError` | [Define the Issue tracker domain model (ports and adapters)](https://github.com/ManuelUsoz/spence/issues/264) |
| GitHub `HostAuth` reuse, Azure PAT auth, per-Project binding/scope, and 5 states | [Decide Issue tracker accounts, auth sharing and per-Project binding](https://github.com/ManuelUsoz/spence/issues/265) |
| `!` picker, shared 5-attachment cap, `IssuePart`, `<issue_context>`, and Reference in Session | [Define Composer and Session integration for Issues](https://github.com/ManuelUsoz/spence/issues/266) |
| Focused polling, ETag/Azure delta sync, 200/30 `Store` cache, throttling, and degraded UX | [Decide Issue sync, caching, rate limits and offline behavior](https://github.com/ManuelUsoz/spence/issues/269) |
| Worker + main transport split, RPC contracts, `Store` layout, stages, and verification | [Define Issue tracker architecture and implementation spec](https://github.com/ManuelUsoz/spence/issues/270) |
| Ruling Issue ↔ Pull request linking display out of v1 scope | [Decide Issue to Pull request linking in v1](https://github.com/ManuelUsoz/spence/issues/271) |
| Glossary entries and ADRs 0008 and 0009 | [Settle glossary entries and ADRs for Issue trackers](https://github.com/ManuelUsoz/spence/issues/272) |

Out of scope in v1: Linear and Jira adapters (the seam must admit them; they are not built), write operations (creating issues, commenting, changing state or assignee, linking Issues to Pull requests), displaying Issue ↔ Pull request links (`linked: IssueLink[]` remains defined on `IssueDetail` and stays `[]`), multiple trackers per Project, multiple accounts per tracker, self-hosted GitHub Enterprise Server or on-prem Azure DevOps Server, and cross-device / Remote device proxying of Issues.

## Existing code and required changes

- `SecretStorage` (`electron/devices/secret-storage.ts` and `electron/devices/secret-storage-electron.ts`) seals and opens secrets via Electron's asynchronous `safeStorage` API, refuses Linux `basic_text` fallback, and supports fake/unavailable test doubles. Reuse it for Azure PAT sealing in `TrackerAuth` (GitHub delegates to `HostAuth`).
- `DesktopRpcs` (`src/shared/rpc/desktop-rpcs.ts`) and `DeviceScopedRpcs` / `RemoteRpcs` (`src/shared/rpc/remote-rpcs.ts`) separate Local-only RPC groups from Remote device groups. Merge `IssueTrackersRpcs` into `DesktopRpcs` as a **Local-only** group (never in `DeviceScopedRpcs` or `RemoteRpcs`).
- `scripts/build-electron.mjs` bundles Electron main and preload entry points. Add `electron/issue-trackers/issue-worker.ts` as an explicit bundle entry point (`dist-electron/issue-worker.js`).
- `Projects` (`src/shared/projects/projects.rpc.ts`, `electron/projects/projects.ts`) owns `ProjectSettings` and Project lifecycle. Add `issueTracker?: TrackerBinding` to `ProjectSettings` / `ProjectSettingsPatch`, and hook `Projects.remove` to drop the Project's binding and purge any unreferenced cache directory.
- `Sessions` (`src/shared/sessions/sessions.rpc.ts`, `electron/acp/acpMappers.ts`, `src/shared/sessions/handoff.ts`) defines `MessagePart`, `ComposerDraft`, `toAcpPrompt`, and `buildStructuredTranscriptExtract`. Extend them with `IssuePart`, `ComposerDraft.issues` (sharing the 5-attachment cap with `pullRequests`), `<issue_context>` serialization, and `Issues referenced:` handoff lines.
- `docs/specs/git-hosts-and-pull-requests.md` defines `HostAuth`, GitHub rate-limit tracking, and the Composer `@` picker. Reuse `HostAuth.withToken('github')`, the shared GitHub rate-limit budget guard, and the Composer picker machinery; coordinate GitHub disconnect confirmation to warn that both Pull request and Issue caches are wiped.

## Two-tier execution model (worker + main transport)

Per [ADR 0009](file:///c:/Users/miuso/workspace/nxy/spence/docs/adr/0009-issue-tracker-worker-with-main-transport.md), keep Electron main free for chat while keeping credentials and OS networking inside main:

| Tier | Runtime & location | Responsibilities | Security & proxy invariants |
| --- | --- | --- | --- |
| **1. Thin Main Thread** | Electron main (`electron/issue-trackers/`, `electron/rpc/issue-trackers.ts`) | `TrackerAuth` and `SecretStorage` PAT sealing/opening (Azure) and `HostAuth` delegation (GitHub); single `Transport.execute(requestSpec)` handler that attaches `Authorization`, executes Electron `net.fetch` (preserving OS proxy/PAC/NTLM and OS certificates), and returns `{ status, headers, body }`; atomic `Store` JSON writes; window focus/blur forwarding; `shell.openExternal`; proxying `IssueTrackersRpcs` to the worker over a `MessagePort`. | Raw tokens and Electron handles never cross IPC or enter the worker. |
| **2. Backend Issue Worker** | Node `worker_threads` (`electron/issue-trackers/issue-worker.ts`) | `IssueTrackerRegistry` and provider adapters (`github-issues`, `azure-boards`); remote URL parsing (`parseRemoteUrl`), project/scope discovery, request building, and pagination; per-tracker `Semaphore(4)` and in-flight read coalescing; ETag table and Azure `ChangedDate` delta tracking; shared GitHub 5,000/hr budget tracking and `SyncStatus` state; 60s focused Issues-page polling schedule; Azure HTML-to-Markdown conversion; normalization (`isClosed` mapping); `IssuePart` snapshot assembly and bounding; in-memory cache state and `Store` JSON assembly. | Communicates with main exclusively over a `MessagePort` using structured-cloneable payloads. |

Markdown rendering for Issue descriptions and comments in the renderer reuses the existing renderer Markdown pipeline; no source-control worker is used.

## Domain ownership and interfaces

| Owner | Shared contract and main handler | Responsibility |
| --- | --- | --- |
| Issue trackers | `src/shared/issue-trackers/issue-trackers.rpc.ts`, `electron/rpc/issue-trackers.ts` | Local-device `TrackerAuth` (Azure PAT connect/verify/disconnect; GitHub status delegated to `HostAuth`), Project binding suggestion/discovery/assignment, Issue list/search/detail/`!<n>` reads, `SyncStatus`, and `IssueTrackers.changes` stream |
| Projects | `src/shared/projects/projects.rpc.ts`, `electron/projects/projects.ts` | `ProjectSettings.issueTracker` persistence and immediate cache release on `Projects.remove` |
| Sessions | `src/shared/sessions/sessions.rpc.ts`, `electron/sessions/`, `electron/acp/acpMappers.ts`, `src/shared/sessions/handoff.ts` | `IssuePart` in `MessagePart`, `ComposerDraft.issues` (shared cap of 5 with PRs), send-time snapshot with offline cached fallback, `<issue_context>` ACP block, `Issues referenced:` handoff extraction, and draft attachment counts for rebind impact |
| Issues UI | `src/app/features/issues/` + Composer `!` picker + `Settings → Issue trackers` + `Project settings → Issue tracker` | Variant B dedicated Issues page, sidebar `Issues` entry (no count badge), `!` picker, Thread/Queue clickable Issue pills, and rebind confirmation modal |

### Deep internal seams (`electron/issue-trackers/`)

Per [ADR 0008](file:///c:/Users/miuso/workspace/nxy/spence/docs/adr/0008-separate-issue-tracker-from-git-host.md), **Issue tracker** is modeled independently of **Git host**:

1. **`TrackerAuth` (`electron/issue-trackers/tracker-auth.ts`)**:
   - Owns Azure DevOps PAT lifecycle (`connectAzurePat`, `verify`, `disconnect`) sealed via `SecretStorage` with the Linux `basic_text` session-only guard (requiring `Work Items: Read` and `Project and Team: read`, covering the bound organization).
   - For `'github-issues'`, `withToken(binding, use)` delegates internally to `HostAuth.withToken('github')`. A token missing **Issues: read** leaves the GitHub account connected and surfaces an Issues-only `Forbidden` error naming what permission to grant rather than forcing `needs-reconnect`.
2. **`IssueTracker` & `IssueTrackerRegistry` (`electron/issue-trackers/issue-tracker.ts`)**:
   - Dispatches by `IssueTrackerKind` (`'github-issues' | 'azure-boards'`), advertising static `IssueTrackerCapabilities` (`supportsTypes`, `supportsAssigneeFilter`, `supportsServerSideSearch`).
   - Exposes `parseRemoteUrl` (recognizing GitHub, `dev.azure.com/{org}/{project}/_git/{repo}`, and legacy `{org}.visualstudio.com`), `discoverProjects`, `discoverScopes`, `list`, `getSummaryByKey`, and `getDetail`.
   - Hides GraphQL vs REST vs WIQL + 200-ID batching, PR exclusion on GitHub's issues endpoint, pagination, Azure HTML-to-Markdown conversion, and Azure `stateCategory`-to-`isClosed` mapping (`Completed`/`Removed` → closed; `Proposed`/`In Progress`/`Resolved` → open; unresolved state defaults open so an Issue is never hidden).
   - Normalizes all failures at the seam into `IssueTrackerError` (separate from `GitHostError`):
     ```ts
     export class IssueTrackerError extends Schema.TaggedError<IssueTrackerError>()('IssueTrackerError', {
       reason: Schema.Literals([
         'NotAuthenticated',
         'TokenExpired',
         'Forbidden',
         'NotFound',
         'RateLimited',
         'UnsupportedCapability',
         'NetworkUnavailable',
         'TrackerUnavailable',
         'TrackerError',
       ]),
       detail: Schema.String,
       retryAfterSeconds: Schema.optionalKey(Schema.Number),
       resetAt: Schema.optionalKey(Timestamp),
     }) {}
     ```

### Shared RPC contract (`src/shared/issue-trackers/issue-trackers.rpc.ts`)

- **Branded IDs & binding types**:
  - `IssueTrackerKind = Schema.Literals(['github-issues', 'azure-boards'])`
  - `IssueKey = Schema.String.pipe(Schema.brand('IssueKey'))` (`"123"` in v1; strings keep Jira/Linear keys admissible)
  - `IssueRef = Schema.Struct({ projectId: ProjectId, key: IssueKey })` (provider-agnostic; main resolves the Project's binding)
  - `TrackerScope = Schema.Struct({ opaque: Schema.String, label: Schema.String })`
  - `TrackerBinding = Schema.Struct({ kind: IssueTrackerKind, canonicalPath: Schema.String, scope: TrackerScope })` (`canonicalPath` is lowercase `owner/repo` or `org/project`)
- **Provider-agnostic read schemas**:
  - `IssueSummary`: `ref`, `title`, `state: Schema.String` (free text, shown verbatim), `isClosed: Schema.Boolean` (used only for Open/Closed/All filter), `type: Schema.NullOr(Schema.String)` (free text), `author`, `assignees`, `labels` (`{ name, color? }`; GitHub labels and Azure tags), `updatedAt: Timestamp`, `url`, `commentCount`.
  - `IssueDetail`: extends `IssueSummary` with `body` (Markdown), `createdAt: Timestamp`, `closedAt: Schema.NullOr(Timestamp)`, `comments`, `milestone`, `linked: Schema.Array(IssueLink)` (defined on schema; empty `[]` in v1).
- **Availability & sync state (`ProjectIssuesState`, streamed on `IssueTrackers.changes`)**:
  - Five binding states: `'unbound' | 'disconnected' | 'needs-reconnect' | 'scope-missing' | 'available'`, plus `TrackerUnavailable` inline error handling when GitHub Issues or Azure Boards are disabled on the target project.
  - `SyncStatus`: `{ status: 'idle' | 'syncing' | 'offline' | 'rate-limited', lastSyncedAt: Schema.NullOr(Timestamp), resetAt?: Timestamp, detail?: string }`.
- **RPC methods in `IssueTrackersRpcs` (Local-only in `DesktopRpcs`)**:
  - Accounts: `TrackerAuth.getAccounts`, `TrackerAuth.connectAzurePat`, `TrackerAuth.verify`, `TrackerAuth.disconnect`.
  - Binding: `IssueTrackers.suggestBinding`, `IssueTrackers.discoverProjects`, `IssueTrackers.discoverScopes`, `IssueTrackers.setBinding`, `IssueTrackers.clearBinding`, `IssueTrackers.getBindingImpact` (queries Sessions for affected draft attachment counts).
  - Reads: `IssueTrackers.changes` (stream), `IssueTrackers.setActiveView` (tracks active Project and whether the Issues page is open), `IssueTrackers.refresh`, `IssueTrackers.loadMore`, `IssueTrackers.search`, `IssueTrackers.getDetail`, `IssueTrackers.lookupByKey` (in-memory session lookup only; never persisted to `Store`).

## Binding, sync, caching, and `Store` layout

### Binding & scope discovery

- **Settings & Project settings**: **Settings → Issue trackers** shows a GitHub row ("Uses your GitHub account from Git hosts", linking there) and an Azure DevOps row (PAT connect, verify, disconnect). **Project settings → Issue tracker** configures the Project's binding (`discoverProjects` flags any Git remote match as suggested; `discoverScopes` offers **Entire repo** / Label / Milestone on GitHub, and **Entire project** / Area Path / Saved query / Tag on Azure, with manual path entry fallback when discovery is unpermitted). Nothing is bound until the user confirms a scope.
- **Rebinding, unbinding, and disconnects**: First binding and connecting an account require no modal. Rebinding or unbinding confirms in a modal naming the Project, old and new bindings, and the count of affected drafts and Issue attachments (dropping those draft attachments on confirm while leaving sent Messages untouched). Disconnecting Azure wipes its sealed PAT and Issue caches and moves bound Projects to `disconnected` (keeping bindings). Disconnecting GitHub in Git hosts warns and wipes both Pull request and Issue caches.

### Sync, change detection, and throttling

- **Fetch & filters**: Initial list loads 100 most recently updated summaries (GitHub `per_page=100`; Azure WIQL top 100 IDs + batch hydrate), with **Load more** for additional pages. Open/Closed/All and All/Assigned to me are server-side queries cached per filter combination. Search filters cached summaries locally immediately and, at 2+ characters after a 400 ms debounce, merges a server search. Detail (including comments) is fetched on open, rendering cached data first.
- **Focused polling**: Polls only the active Project's binding while the window is focused: every **60 s** on the Issues page, and **no background poll in Session view**. Window focus refreshes after a **30 s** cooldown; opening the `!` picker triggers a refresh if the list is over **30 s** old. Manual refresh and opening an Issue bypass conditional gates.
- **Change detection**: GitHub gates list polls with `If-None-Match` (`304` is free). Azure runs incremental WIQL (`ChangedDate >= lastSyncedAt - 2 min`) and batch-hydrates up to 200 changed IDs (`Removed` sets `isClosed: true`); hard deletes reconcile on manual refresh or when opening the page with a cache older than 1 hour.
- **Rate limits & degraded reads**: Per-tracker `Semaphore(4)` and identical in-flight read coalescing. `RateLimited` suspends background polls until `Retry-After` / `resetAt` (at least 60 s with growing delays on GitHub secondary limits without headers); GitHub Issue background polls skip when shared remaining budget drops below **200** (manual reads still run). When degraded, a single quiet status strip (`Offline · cached 12m`, `Rate limit reached · resets 14:05 · cached`, `Azure DevOps throttled · retry in 40s · cached`) with **Retry** keeps cached lists, local search, and cached details readable while disabling **Load more** and server search (`Not available offline` for uncached details).

### Versioned `Store` layout and eviction (`<userData>/spence/`)

```text
issue-trackers/accounts.json
issue-trackers/<bindingHash>/summaries.json
issue-trackers/<bindingHash>/details-lru.json
```

- `accounts.json` (`VersionedFile`, `version: 1`): Azure DevOps account metadata and optional `sealedToken` (omitted in Linux `basic_text` session-only mode).
- `<bindingHash>/summaries.json` and `details-lru.json` (`bindingHash` derived from `(kind, canonicalPath, scope)`): shared across Projects with identical bindings; capped at **200 summaries** (by `updatedAt`) and **30 details** (with draft-attached details pinned), with no age expiry. Session-only `!<n>` lookups are never written to disk.
- Eviction drops a binding cache directory when no Project references it (via `Projects.remove`, rebind, or unbind), on Azure disconnect, or on GitHub disconnect via `HostAuth`.

## Issues UI, Composer `!` picker, and Session snapshots

- **Issues page (Variant B, `src/app/features/issues/`)**: Quiet `Issues` entry in the left sidebar (no count badge) opens the dedicated commit-history-style split layout (filterable Issue list on the left, selected Issue detail on the right, narrow-window list/detail navigation). Filters: search, `All` / `Assigned to me`, `Open` / `Closed` / `All`. Displays native `type` and `state` verbatim alongside key and title. Inline setup/error states (`Configure tracker`, `Open Settings`, `Choose scope`, inline `TrackerUnavailable` or `Forbidden` scope hint). **Reference in Session** creates a new Session titled with the Issue key and title, attaches the Issue to its Composer without sending, on the Project's current checkout (no branch or Worktree created).
- **Composer `!` picker**: Triggers on `!` at input start or after whitespace (`↑`/`↓`, `Enter`/`Tab`, `Esc`), listing Issues ranked by match then `updatedAt` (assigned-to-me first on empty query), with `!<n>` on-demand lookup. No kind badges; shares a **5-attachment cap** per Message with `@` PRs (`ComposerDraft.issues` + `ComposerDraft.pullRequests`). Shows a one-key switch hint if the typed number exists in the other kind's cache (`"Issue 123 exists: use !"` / `"PR #123 exists: use @"`), without extra network lookups. Typing `#123` in prose never auto-links.
- **Send-time `IssuePart`, ACP serialization, Thread pills, and handoffs**:
  - `Session.prompt`, `enqueue`, and `steer` refresh attached Issues (assembled in `issue-worker`, stored by main) into immutable `IssuePart` snapshots: `key`, `title`, `url`, `state`, `type`, `isClosed`, `author`, `assignees`, `labels`, `milestone`, `createdAt`, `updatedAt`, body capped at **8 KB**, up to **15** most recent comments capped at **2 KB** each (`[N older comments omitted]`, `[truncated]`, **~24 KB** total; no `linked` links or images).
  - On `NetworkUnavailable`, `RateLimited`, `TokenExpired`, `NotAuthenticated`, or `scope-missing`, fall back to cached `IssueDetail` prefixed `[cached snapshot · fetched at <ISO-time>; offline/unreachable]`; if uncached, or on `NotFound` / `TrackerUnavailable`, fail before starting the Turn and preserve the draft.
  - `toAcpPrompt` serializes `IssuePart` as an ACP `text` block wrapped in `<issue_context>` tags. Thread and Queue render clickable pills (`Issue #123 · <title>` or native type `Bug 4521 · <title>` with state tooltip) opening the Issues page to that Issue or `shell.openExternal` if the binding changed. `buildStructuredTranscriptExtract` appends `Issues referenced: #123 (<title>, <state>)`.

## Incremental delivery and verification matrix

Stages may merge independently behind the seams above:

| Stage | Work and dependencies | Exit criteria |
| --- | --- | --- |
| 1. Contracts, worker/transport, `TrackerAuth`, Settings | `src/shared/issue-trackers/issue-trackers.rpc.ts`, `issue-worker.ts` + `scripts/build-electron.mjs`, main `Transport.execute`, `TrackerAuth` (Azure PAT + GitHub `HostAuth` delegation), `Settings → Issue trackers` | Azure PAT connect/verify/disconnect works; Linux `basic_text` refuses disk persistence; GitHub token without `Issues: read` surfaces `Forbidden` while staying connected; worker never sees tokens; chat latency unaffected while worker is busy |
| 2. Binding, discovery, and `ProjectSettings` | `discoverProjects`/`discoverScopes`, `ProjectSettings.issueTracker`, **Project settings → Issue tracker**, rebind/unbind modal with impact counts, 5 binding states | Nothing binds until scope is confirmed; `scope-missing` preserves cache; rebind drops draft attachments and reports exact counts |
| 3. Reads, sync, and `Store` cache | GitHub ETag gating, Azure `ChangedDate` delta + 200-batch, 200/30 caches, 60 s focused polling, `Semaphore(4)`, coalescing, shared GitHub budget guard, eviction hooks | `304` skips work; no background poll in Session view; shared binding cache survives restart and evicts when unreferenced; GitHub budget under 200 skips polls |
| 4. Variant B Issues page & sidebar | Sidebar `Issues` entry, Variant B list/detail layout, filters, search, degraded status strip, inline setup/error states, **Reference in Session** | Matches prototype B; degraded mode preserves cached reads and disables **Load more** and server search |
| 5. `!` picker, `IssuePart`, and handoffs | `!` picker, `!<n>`, wrong-kind cache hint, shared 5-cap `ComposerDraft`, send-time `IssuePart` + offline fallback, `<issue_context>`, pills, `Issues referenced:` | Immutable snapshots; offline fallback prefixes cached snapshot; uncached failure aborts before Turn and keeps draft |

### Verification matrix (final gate `npm run verify`)

- **Auth**: Azure PAT seal/unseal/disconnect, Linux `basic_text` guard, GitHub `HostAuth` delegation, Issues-only `Forbidden`, and token absence in RPC schemas and worker messages.
- **Adapters (fake `HttpClient` + `TestClock`)**: GitHub PR exclusion, `304` ETag gating, Azure `ChangedDate` delta and 200-ID batching, `isClosed` mapping (unknown defaults open), `Retry-After`, `Semaphore(4)`, coalescing, and shared GitHub budget guard.
- **Worker**: Azure HTML-to-Markdown conversion, `IssuePart` snapshot caps, `SyncStatus` transitions, and `MessagePort` transport round-trip.
- **Store**: Restart persistence, shared `bindingHash` cache and reference-counted release, and eviction hooks (`Projects.remove`, rebind/unbind, Azure/GitHub disconnect).
- **Renderer (`makeDesktopTestLayer`)**: Binding/setup/degraded page states, `!` picker + wrong-kind hint, 5-attachment cap, and Thread/Queue pills.
- **E2E (Playwright with mock GitHub/Azure servers and fake `SecretStorage`)**: Connect, bind, browse, `!` attach, send, **Reference in Session**, and Composer responsiveness during a large list load.
