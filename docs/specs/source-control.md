# In-app source control

Status: accepted for implementation on 2026-11-15 after explicit confirmation of shared understanding. This document specifies planned behavior; it does not describe a shipped feature.

## Destination and decision record

Implement Session Worktrees, live files and changes, durable Turn observations, selected/all-file commits, remote operations, reviewed destructive actions, and complete Session rewind. Preserve the approved calm Session interface and the existing renderer/main security model.

The canonical planning index is [Wayfinder: worktrees, source control and change history](https://github.com/ManuelUsoz/spence/issues/79). Product rationale remains in its resolved decisions; this document integrates their requirements into an implementation handoff. Architecture is resolved in [Define source-control architecture and implementation plan](https://github.com/ManuelUsoz/spence/issues/94).

| Decision | Source |
| --- | --- |
| Projects, Worktrees, shared Sessions and lifetime | [Define Session worktree ownership and lifecycle](https://github.com/ManuelUsoz/spence/issues/80) |
| Current changes, Turn observations and attribution | [Define Git-based Session and Turn change history](https://github.com/ManuelUsoz/spence/issues/81) |
| File operations and collision recovery | [Define file operations within and between worktrees](https://github.com/ManuelUsoz/spence/issues/83) |
| Commit selection, hooks, remote operations and integration | [Define selected-file and all-file commit and push behavior](https://github.com/ManuelUsoz/spence/issues/84) |
| Discard, historical Restore and Revert | [Define discard and revert with worktree history](https://github.com/ManuelUsoz/spence/issues/85) |
| Calm right inspector and action placement | [Prototype the worktree, changes and file-management surfaces](https://github.com/ManuelUsoz/spence/issues/82) |
| Complete rewind and failure semantics | [Define complete Session rewind checkpoints and failure semantics](https://github.com/ManuelUsoz/spence/issues/93) |
| Retention, budgets and bounded capture | [Define history retention, storage budgets and capture limits](https://github.com/ManuelUsoz/spence/issues/86) |

Out of scope: production implementation during wayfinding, PR management, arbitrary branch management, hunk selection, unconditional force push, merge-commit reversal, aggregate multi-repository Projects and an in-app text editor.

## Existing code and required changes

- `SessionMeta` in `electron/sessions/session-store.ts` already separates `projectId` and `cwd`, but current Sessions use the Project folder. Add explicit Worktree binding without inferring it from the displayed branch.
- `Sessions.prompt` and `endTurn` in `electron/sessions/sessions.ts` are the observation lifecycle edges. Track capture reservations separately from the existing running flag, including during Agent startup and after a Turn stops.
- `SessionStore` batches events for 250 ms, caches metadata and sequence numbers, and serializes access with a semaphore. Rewind must quiesce those writers and replace their caches, not just truncate a file.
- `Session.events` and its readers assume append-only sequences. Add generation-aware reset and replay before enabling rewind.
- `Store` has versioned JSON, atomic replacement, JSONL and blobs, but no cross-file transaction or operation journal. Extend it for durable publication and recovery; existing filesystem defects are insufficient for actionable storage failures.
- `MainRuntime` already shares memoized app-lifetime layers. The coordinator, utility-process lifetime, observation publication and recovery scanner must share those same instances across Sessions and RPC handlers.
- The current path normalization in `electron/projects/folder-key.ts` does not establish repository identity or prevent escapes through linked directories.

## Domain ownership and interfaces

| Owner | Shared contract and main handler | Responsibility |
| --- | --- | --- |
| Worktrees | `src/shared/worktrees/worktrees.rpc.ts`, `electron/rpc/worktrees.ts` | Repository discovery, stable Worktree identity, creation, explicit selection support, locating and removal |
| Files | `src/shared/files/files.rpc.ts`, `electron/rpc/files.ts` | Live tree, bounded saved-file previews, external opening, reviewed create/rename/delete/copy/move |
| Source control | `src/shared/source-control/source-control.rpc.ts`, `electron/rpc/source-control.ts` | Status, Git history, commit, fetch/push/pull, integration Continue/Abort, discard and commit Revert |
| History | `src/shared/history/history.rpc.ts`, `electron/rpc/history.ts` | Retained observations and comparisons, checkpoint availability, retention, protected content and historical file Restore |
| Sessions | Existing Sessions contract and handler | Worktree binding and handoff, Turn lifecycle, complete rewind, Transcript generation and fresh Agent contexts |

These are planned paths. Register groups in `DesktopRpcs` and handlers in `layerDesktopHandlers`. Domain Effects own behavior; RPC handlers decode requests and delegate. History Restore delegates live file/index mutation to the same coordinator and executor used by Source control rather than maintaining a second mutation implementation.

Expose intent-specific read and review methods, plus typed execute/progress/recovery operations per owning domain. A review returns an opaque ReviewId, expiry, affected targets, warnings, current blockers and a server-held fingerprint. Execute accepts the ReviewId and the reviewed choices; never accept arbitrary Git arguments, commands or trusted absolute filesystem paths from the renderer. An OperationId identifies durable work independently of any renderer connection. Repeated execution with the same request identity returns that operation rather than duplicating commits or mutations. Conflicting reuse is rejected.

Brand RepositoryId, WorktreeId, ReviewId, OperationId, ObservationId, CheckpointId and TranscriptGeneration in their owning shared modules. Reuse existing SessionId and ProjectId. Cross-domain references carry IDs and schemas, not runtime objects. Use tagged errors with PascalCase reasons and serializable details: missing/unavailable targets, unsupported state, stale review, busy target, conflict, capacity, capture failure, authentication, hook failure, lease rejection, worker exit and recovery required. Results distinguish success, partial success and unresolved state; a transport disconnect is not evidence of failure or permission to retry a mutation.

Renderer features use `DesktopApi` through `EffectRuntime.run`, with `makeDesktopTestLayer` in tests. Keep UI orchestration in the existing Session feature or core; sibling features do not import each other. Helm wrappers remain presentational. No feature imports RPC clients, Electron, Node, CDK or Spartan internals directly.

## Execution and privilege

One app-lifetime utility process performs Git execution, traversal, hashing, comparison and capture. Main owns validation, operation coordination, Store manifests/journals, publication and user-visible progress. Worker data moves in bounded chunks with backpressure; main writes immutable chunks without doing large hashing or tree walks itself. The worker cannot choose arbitrary Store destinations. Chunk publication verifies the expected digest off the main thread before main publishes its manifest. No direct renderer-to-worker channel is exposed.

Backend: the user's installed Git, resolved from the merged PATH, launched with argument arrays and no shell interpolation. Git handles its normal repository configuration, hooks and credential helpers. Missing Git disables Git actions with an actionable explanation; local files and non-Git rewind remain available. Never install Git, change identity/remotes/credentials or bypass hooks silently. Capability checks must gate unsupported repository states before mutation, with an explanation rather than a guessed fallback. Package and restart the utility entrypoint explicitly in the Electron build.

On worker exit, preserve the journal and classify the outcome as unknown until reconciliation. Restarting a worker does not automatically replay a mutating command. App shutdown stops accepting work, cancels optional capture, and drains or records active operations at recoverable boundaries. Renderer reload does not cancel durable mutations. No privileged window loads remote content; keep the existing CSP and preload handshake unchanged.

## Identity, paths and migration

A Git Project covers one repository and its registered Worktrees. Resolve repository identity through Git's common administrative location and canonical filesystem identity, not branch name or a lowercased string. Persist a Store-owned RepositoryId and WorktreeId registry with validated canonical location and Git registration identity. Rediscovery reconciles aliases; a replacement directory at the same text path is not silently adopted. Locating a moved checkout verifies repository identity and requires explicit rebinding if identity cannot be established. Non-Git folders have validated folder bindings and use the same operation coordination without invented Git identities.

Treat the Git inventory as authoritative for selectable Worktrees. Refresh when opening the picker, after completed Steps and at Turn end. A new Session defaults to the existing checkout; creation defaults to a new branch from the current checkout HEAD with editable name/destination. Dirty files stay in the source. Creation never silently switches a Session and survives closing a draft. Switch only while that Session is idle, retain its Transcript, and start a fresh Agent context through a reviewed Summary handoff. Fork defaults to the current Worktree and transfers context without restoring files.

Validate relative paths and source/destination identities in main and again at the mutation edge. Protect Git administrative files, disallow nested repository traversal as part of the parent Project, and reject paths escaping the selected root through symlinks, junctions or renamed parents. Copy links as links without following targets. Reject destinations inside the source and unsupported special files. Required restore/capture must preserve eligible file bytes, executable/type information and link targets; inability to round-trip required state makes that target unavailable before mutation. Never dereference a link to widen capture scope.

Migrate Session metadata forward from v1, preserving existing cwd, Transcript and ACP data. Add a binding state that can be undiscovered, resolved or missing; discovery may resolve an old cwd later without silently changing it. Assign the initial Transcript generation to existing events and preserve sequence numbers. Historical checkpoints begin at first real capture; do not fabricate past baselines. Newer-format files remain untouched and unsupported Sessions are visibly unavailable. Version repository registry, observation manifests, journals and Transcript heads independently.

Project Locate must reconcile each binding, not relocate every Worktree to the Project root. Close/archive/delete Session and Remove Project preserve checkout lifetime. Worktree removal through Git preserves its branch; explicit folder deletion is distinct and then cleans stale registration. Both show affected Sessions, refuse active Turns and require extra dirty/untracked confirmation. Git worktree removal cannot remove the primary checkout. Missing paths retain readable Transcripts and disable Send until located or explicitly replaced.

## Coordination and stale reviews

Use one app-lifetime coordinator keyed by repository, Worktree/folder and affected branch references. Acquire multiple target reservations in deterministic ID order. It tracks active Turns, captures, mutations and unresolved recovery, and rechecks conditions immediately before execution. Do not hold SessionStore's global semaphore during filesystem or Git work. Reserve the targets first, then use short Store critical sections for state publication.

| Operation | Active Turns in affected Worktrees | Coordination |
| --- | --- | --- |
| Browse, preview, current changes | Allowed | Bounded reads; surface detected instability |
| Concurrent Turns | Allowed | Register overlapping observations; no per-Worktree Turn queue |
| File mutations and transfers | Allowed | Serialize conflicting Spence path mutations and recheck both ends |
| Commit | Allowed | Reserve index and branch mutation; commit reviewed saved contents |
| Fetch / Push | Allowed | Coordinate shared refs and remote destination; no file integration |
| Session switch | Own Session must be idle | Freeze its binding and context handoff |
| Pull / Revert / Discard / historical Restore | All affected Turns idle | Reserve affected Worktree/index/refs; block incompatible integrations |
| Remove Worktree | All attached Turns idle | Reserve registration and folder |
| Complete rewind | All affected Turns idle | Reserve all affected Worktrees, branches, bindings and Session histories |

Read-only operations may show blocked targets. Execution rejects unmet idle conditions and identifies Sessions; never stop Turns automatically. Once an idle-only operation is reserved, prevent new affected Turns until it reaches a safe release point. Other Worktrees remain usable unless shared branch/reference effects require their inclusion. Unresolved rewind blocks affected Sessions until recovery; narrower partial file operations retain precise unresolved targets without pretending every Session must stop.

Fingerprints cover target identities, branch/HEAD/ref state, index entries and relevant saved-file bytes/types, collision destinations, integration state and affected Session bindings. Rewind fingerprints also cover every affected Worktree, required baselines, branch consequences and Transcript generation/boundary. Remote rewriting pins the reviewed remote ref value explicitly; Fetch cannot refresh its approval. Metadata timestamps alone do not establish unchanged contents.

External writers do not obey Spence reservations. Revalidate reviewed inputs and use conditional ref/index updates and filesystem identity checks where available. An observed change invalidates review; request a fresh preview/confirmation. Detected races after mutation starts produce accurate partial/unknown results and recovery. Do not claim an atomic snapshot or immunity to all external races. Recheck postconditions before publishing success.

## Observations, checkpoints and Store layout

Suggested versioned layout under `<userData>/spence/`:

```text
worktrees/registry.json
history/observations/<observationId>.json
history/checkpoints/<checkpointId>.json
history/comparisons/<sessionId>/<turnId>.json
history/blobs/<sha256>
operations/<operationId>/journal.json
operations/<operationId>/recovery.json
recovery/blobs/<sha256>
sessions/<sessionId>/session.json
sessions/<sessionId>/transcript-head.json
sessions/<sessionId>/transcripts/<generation>.jsonl
```

Names are internal; all path segments are validated. History and recovery blob pools have independent budget accounting. Deduplicate within each pool; shared references count once, and content serving both purposes must remain protected for as long as either reference requires it. Record IDs, schema version, capture boundaries/times, source identity, Git state, content/type manifests, omissions, completeness and overlap. Git state includes branch/detached HEAD, referenced commits and exact staging, with durable object data/pins outside the user's checkout so Git garbage collection cannot invalidate a promised rewind. Capture Git object format and required index representation, including split-index dependencies when supported; otherwise refuse complete recovery before mutation.

Store before/after net observations around a Turn in Git Projects. Current changes include staged, unstaged and eligible untracked changes from every writer. Preserve branch/commit/index state separately from working-file differences. An undone edit has no net change; commits and branch switches can change Git state without proving authorship. Renames may be inferred, otherwise show add/delete. Session history is ordered Turn comparisons per Worktree, not a cumulative Session diff. Git commit history is separately browsable.

Before-message rewind checkpoints are taken before sending the Message; after-reply checkpoints after the Turn ends. Capture baselines before a Session first uses another Worktree after a target. Reserve binding transitions so no Turn or file operation attributed to that transition starts before its baseline attempt. A missing/incomplete baseline disables the dependent complete rewind; it need not prevent ordinary work. Non-Git Projects get file/conversation checkpoints but no invented Git Turn-comparison history.

Optional capture has a 2-second pre-start and 5-second post-Turn wait by default, configurable. A missed deadline marks capture incomplete and permits work to continue. Cancel and join the capture attempt at the boundary so a late scan cannot masquerade as a before-state. Save partial results only as explicitly incomplete. Capture failures never become evidence that there were no changes. A crash retains the starting observation and marks the end unavailable; reopening does not invent the crash-time files.

Optional history defaults: 50 MiB per file, 500 MiB of new content per checkpoint, 5 GiB total. Text and binary are eligible; ignored files are excluded. Record each omission and its reason. Retry unstable files within the deadline, then disclose instability. A complete checkpoint means all required data within the agreed scope was retained and passed consistency validation; it is not proof of globally atomic external-writer exclusion.

Retention defaults: no age expiry, budget cleanup enabled, oldest unprotected content first. Settings allow budget, cleanup enablement, age retention, per-Session protection and usage inspection. Preserve comparison metadata after content eviction, explicitly mark missing contents and disable every dependent complete-rewind target. Removing a live Worktree does not erase retained history; deleting a Session preserves shared references.

Publish immutable blobs before manifests; publish availability only after all references verify. Cleanup uses a consistent reference inventory plus in-flight reservations, durable operation roots and protected Session roots. Quarantine/defer deletion while reference publication is unresolved. Recompute availability when content is evicted. Crash recovery cleans abandoned temporary chunks only after journal/reference reconciliation. Capture reservations account for concurrent growth; budget ceilings do not reserve disk space and ENOSPC remains actionable.

Required recovery has a separate configurable 5 GiB default ceiling. It has no optional per-file, per-checkpoint or timeout limit. Capture every affected eligible file, exact staging and, for rewind, branch pointers and all required Worktrees before mutation. Refuse if any required content cannot be preserved; no partial-backup bypass. Offer cancellation during preparation. Protect unresolved journals and recovery regardless of budget or age. Successful Discard/Restore/Abort recovery lasts 30 days by default, configurable. Successful rewind deletes its temporary failure recovery only after durable completion; it has no Undo.

## Git and file operation semantics

Commit selection is whole-file saved content, not existing staging and not authorship. Commit selected includes only reviewed paths; Commit all reviews tracked changes and non-ignored untracked files. Review entries identify paths and the Session context for the existing diff and saved-file preview contracts; content need not be embedded in the review response. Those reads are previews, and execution must revalidate the server-held fingerprint. Preserve every unselected index entry. Implement commit preparation with an isolated reviewed tree/index and conditional reconciliation of the real index/ref, using normal hooks; never blindly stage all files or replace the real index with the temporary one. Prove unselected-index preservation and normal hook behavior in real repositories before enabling Commit. Hook-modified content outside the review must return to review, never silently broaden a commit. Preserve message/selection and report hook output on failure. Unresolved conflicts block ordinary commits. Missing identity is actionable without changing config.

Push displays its upstream, or requires explicit remote/branch when absent. Detached HEAD requires branch selection. Push includes every pending branch commit, including external commits. Commit & push attempts normal Push only; a successful commit survives push failure and retry does not recommit. Force push is separate, explicitly reviewed and uses a pinned expected remote ref lease. Refuse a changed remote and require review again. Never escalate automatically or rely on a moving remote-tracking ref as approval.

Fetch defaults to the upstream remote, asks when ambiguous, changes remote-tracking information only and does not prune automatically. Pull requires all shared Turns idle and a clean tree/index; use fast-forward by default. Divergence requires explicit Merge or Rebase. Never automatically stash. Record integration baseline/progress durably. Conflicts expose affected paths and external editing plus Continue/Abort; ordinary commit/push and conflicting destructive actions remain unavailable. Abort restores the operation baseline after preserving conflict-resolution edits in required recovery. Revert creates a new ordinary-commit reversal with explicit editable message, clean tree/index and normal hooks; Push is separate. Merge-commit reversal is unavailable.

Files update live, with bounded rescan after watcher overflow/reconnect and refresh at focus/operation completion. The viewer is read-only saved contents. Preview limit defaults to 2 MiB with explicit truncation; binary/unsupported files offer external opening. Preview and optional-history limits do not limit transfers or required recovery. Show ignored files is a Project visibility setting, off by default; transfer Include ignored files is independent. Folder moves leave excluded contents at the source.

Copy/move chooses an explicit destination in the same repository's Worktrees. File collisions require skip/keep both/replace; folder collision modal offers Replace completely or Merge, and dismissal cancels. Complete replacement lists destination-only deletions. Deleted/overwritten file-operation contents go to OS trash; if unavailable, stop and offer a separately confirmed permanent operation. Do not substitute this exception for required Store recovery on Discard/Restore/Abort/rewind. File operations do not touch staging. Remove a move source only after destination success and an unchanged-source recheck. Report results per path; preserve completed copies and never silently roll back or retry overwrites.

Discard resets reviewed selected files and their staging to current HEAD; untracked deletion must be explicit. Historical Restore replaces selected files with available saved contents (including deletion), clears selected staging and leaves changes unstaged; branch/commit pointers and unselected staging remain unchanged. Default destination is the original Worktree; another same-repository destination must be explicit. Both require idle shared Turns, fresh review and complete required recovery. A partial failure stops further writes and offers reviewed recovery with completed/failed/untouched paths. Active Merge/Rebase/Revert blocks starting these actions or another Revert.

## Durable operation and rewind protocol

Every mutation has an operation identity and observable progress. For operations requiring recovery, persist the recovery manifest and prepared journal before the first mutation. Journal phases include Prepared, Applying, NeedsRecovery, LocalRestored, TranscriptFinalizing and Completed, with per-target before/desired fingerprints and recorded outcomes. Persist intent before each irreversible step and inspect actual state on restart when completion is uncertain. Durable publication requires explicit flush/sync ordering for critical records, blobs and atomic head replacement; atomic rename alone is not a cross-file transaction. State the supported crash guarantees and verify them on packaged target platforms.

Rewind follows these steps:

1. Resolve the selected user-Message boundary (before send) or completed-reply boundary (after its Turn, including failed/cancelled outcomes). A reply still generating is not a target.
2. Resolve the Session's target Worktree selection and all subsequently used Worktrees: restore the target checkpoint in A, and each later B to its pre-use baseline. Require all necessary content and locate missing targets. No partial rewind presented as complete.
3. Review affected files, index, commits, branches, Worktrees and Sessions, including unrelated/external work that will be overwritten. Ignored files stay untouched. Block active integrations and any branch restoration affecting an unreviewed checkout. Require all affected Sessions idle.
4. Reserve targets and revalidate review, including Transcript generation. Preserve complete pre-operation recovery and durable progress. Cancellation is available before mutation.
5. Restore local files, staging and branch/HEAD state with per-target journal progress and postcondition checks. After mutation begins, cancellation stops only at a recoverable boundary. If any restoration fails, retain the original Transcript and recovery, block affected Sessions, and expose Retry or Restore pre-rewind state.
6. Once all Worktrees are durably restored, finalize the retained Transcript generation and fresh-context requirement. Preserve other Sessions' Transcripts/bindings, but invalidate their old Agent contexts before they can continue. This finalization is restartable; do not expose a completed rewind while required context invalidation remains uncommitted.
7. Publish Completed, reset all subscribed readers, then release reservations and remove successful rewind's temporary failure recovery. Remote rewriting is a later separate reviewed, lease-protected operation. Declining/failing it leaves local rewind complete and explicitly reports remote history still retained.

Transcript finalization flushes/quiesces pending appends, writes the retained prefix to a new generation, and atomically replaces a versioned Transcript head. The journal makes cross-file head, binding and context updates restartable. Readers carry `(generation, afterSeq)`; a mismatch returns an explicit reset and authoritative replay. Never combine events from different generations or suppress new events using an old high cursor. Preserve retained sequence values within the new generation; new appends continue from its last retained event. Invalidate late ACP events by context generation, not only by dropping an in-memory pointer. Retire old Transcript generations and unreferenced Message blobs after durable completion; they are temporary failure recovery, not user-visible Undo.

Store a durable context-generation requirement separate from historical ACP IDs. Reopen must not resume/load any context from an earlier generation. The source Session starts fresh from retained conversation only, using Summary handoff if necessary; shared Sessions retain their full conversation but also start fresh. Journal recovery must run before Agent auto-start, prompt or background capture on affected targets. Retry and Restore pre-rewind state both recheck actual files/refs and require fresh confirmation when intervening edits would be overwritten. Recovery can fail and remains explicitly unresolved rather than being marked successful.

## Approved UI and accessibility

Use the [reviewed right-inspector prototype](https://github.com/ManuelUsoz/spence/tree/f999b1908e3dece96f0a7803a8b5b038a26b7ab3/src/app/features/session/source-control-prototype) and local `docs/Spence — Vista de chat (calma).html` reference. Conversation remains central. Worktree/branch control sits below Composer; Changes shows compact rows and inline diffs; Files shows a collapsible tree and plain contents. Commit message and Commit/Push remain at the panel bottom; secondary actions use contextual menus. Turn comparisons open from Receipts and identify observed overlap; Step diffs remain Agent-reported. Repository history is secondary, not a competing top-level Session-history tab.

Use concise dialog titles, at most one short explanatory subtitle, affected-target lists and explicit buttons. Present loading, restrictions and errors when relevant. Preserve keyboard navigation, focus restoration, meaningful action names, live progress announcements and readable conflict/partial-result states. Apply theme tokens and the prescribed sans/mono typography. Keep transport, journaling and hashing details out of product copy.

## Incremental delivery and acceptance

Stages may merge independently behind disabled capabilities. Do not expose an action before its safety/recovery prerequisites and acceptance checks are complete. These are implementation stages, not additional wayfinder decision tickets.

| Stage | Work and dependencies | Exit criteria |
| --- | --- | --- |
| 1. Worktree foundations | Shared IDs/contracts, utility packaging/lifetime, Git capability discovery, registry and metadata migration, coordinator, durable operation foundation, explicit create/select/locate/remove | Existing Sessions preserve cwd/history; shared concurrent Turns work; switching refreshes context; aliases/missing paths and primary-checkout removal are handled; restart does not duplicate mutations |
| 2. Observations and files | Store manifests/blobs/reference cleanup, capture lifecycle/baselines, availability and Settings budgets, live tree/viewer, file operations and OS recovery | Honest bounded observations survive restart/removal; incomplete/non-Git distinctions hold; safe collisions/transfers preserve index and source under races; file preview/capture limits remain separate |
| 3. Commit and remotes | Reviewed whole-file commit, index preservation/hooks, remote selection, Push/Fetch, lease-protected force push, Pull divergence and integration Continue/Abort with required recovery | Real Git fixtures verify exact selection, hooks and unselected index, explicit remote lease, commit/push partial success, clean/idle Pull, conflict/Abort and restart behavior |
| 4. Destructive actions and rewind | Required recovery and reviewed restore, Discard/Restore/Revert, Transcript generations and context invalidation, multi-Worktree rewind and remote follow-up | Complete recovery refusal, stale review, all partial/restart phases, shared branch effects, original Transcript on restoration failure and fresh contexts are verified end to end |

Each stage updates schemas, migrations, meaningful tests, localization and documentation together. Use real temporary repositories for Git behavior and disposable local remotes for network-history semantics; do not use a mock Git implementation as evidence of index or lease correctness. Test the coordinator through its interface with controllable clocks/executors and renderer behavior through `makeDesktopTestLayer`. Test fault injection at durable boundaries, not snapshots that merely mirror implementation. Final repository gate is `npm run verify`; packaged Electron e2e additionally covers the utility entrypoint and real operation lifecycle.

Required verification matrix:

- Identity/migration: v1 and newer-version fixtures, missing checkout, aliases/case/junctions, registered external Worktrees, branch switch without Session reassignment, Project Locate, non-Git Sessions, draft-created Worktree lifetime and preserved Fork semantics.
- Paths/files: traversal and linked-parent escapes, Git metadata, nested repositories, source-descendant destinations, link copy without traversal, unsupported special files, ignored inclusion versus visibility, Replace completely versus Merge, trash failure, locked/changed source and partial move.
- Commit/index: unselected staged entries byte/semantic equivalence as required, selected staged-plus-newer-working content, deletions/untracked files, active Turn changes, detached HEAD, unborn branch where supported, hook failure/modification, identity failure and no silent hook bypass. Unsupported index/repository forms must fail before mutation.
- Remote/integration: all pending commits, explicit no-upstream destination, fetch without prune/integration, divergence selection, clean/idle restrictions, Continue/Abort recovery, explicit expected lease after intervening fetch/push and successful commit with failed Push.
- Capture/retention: overlap and net-zero edits, Git-only state changes, crash missing end, unstable and omitted files, exact budget boundaries with concurrent reservations, binary/preview separation, protected content, shared references, cleanup racing publication, eviction disabling cross-Worktree rewind and Store exhaustion.
- Destructive/recovery: selected-only staging consequences, required capture beyond optional limits, capacity refusal before writes, partial results, changed-after-review refusal, reviewed recovery over intervening edits and unresolved recovery protected across restart.
- Rewind: before-message and after-reply targets, A→B→A baselines, external commits/branch switches, shared idle Sessions, branch checked out elsewhere, ignored-file exclusion, expired/missing target refusal, crash/worker death after every journal step, transcript-head publication failure, subscriber reset, late ACP events, context invalidation surviving restart, non-Git rewind and independently failing/declined remote rewrite.

## Documentation and map completion

The architecture resolution must link this final spec and record confirmed choices on its issue. Reconcile the glossary with the already agreed domain terms and refine ADR 0003: user-authorized Git/file operations may modify Project/Worktree contents, while Spence metadata remains in Store; Transcript replacement is allowed only by complete rewind under its recovery protocol. Do not imply either capability already exists in production.

After explicit confirmation of shared understanding, mark this spec accepted for implementation, post the architecture resolution, close that decision, and append one gist/link to the map. Query child issues and dependencies again for concurrent changes. Close the map only when no open decisions or in-scope fog remain, linking this handoff. If review exposes a sharp unanswered question, create and wire a child decision instead of declaring the map complete. Implementation then proceeds as a separate effort.
