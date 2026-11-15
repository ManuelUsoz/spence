# Throwaway source-control UI review

The revised A layout was approved in live review. This branch preserves the reviewed prototype, not production implementation. Remaining rewind semantics and implementation decisions are tracked separately on the map.

## Revision after live review

Action dialogs use concise titles, at most one short subtitle, descriptive confirmation buttons, and structured file/commit lists. User messages have a back-arrow to rewind to before that message; the reply action rewinds to after the reply. Both use the same reviewed rewind flow. Browser checks cover both user-message targets and removal of later fictional messages.

Files now opens a collapsible Project file tree, including unchanged files. Selecting a file opens its saved contents in a read-only viewer with a back-to-tree action; no diff is shown in Files. File mutations are in contextual menus. Changes retains inline diffs. These remain fictional fixtures.

The user selected A as the direction and rejected the density of the first draft. A now follows the supplied calm reference: inline file diffs, a small Changes/Files switch, commit message plus Commit/Push at the bottom, and secondary actions in contextual menus. Turn comparisons open from Receipts; there is no prominent Session history tab. B and C remain accessible by URL as superseded alternatives; their switcher is hidden.

The user explicitly expanded scope: Go back at a reply rewinds everything after that point, including later messages, file contents and Git commits. Overlapping edits from other writers may be overwritten after warning and confirmation. The preview lists affected files and commits and warns that the action is irreversible. Published history receives a separate remote rewrite confirmation with lease protection. The prototype only simulates this; coordination, partial failures, cross-Worktree histories, and exact checkpoint/index coverage still require decisions before an implementation-ready spec. Earlier no-rewind and no-whole-Session-restore exclusions must be reconciled on the map; this review does not mark the feature implemented.

Run `npm run prototype:source-control`, then open http://127.0.0.1:4317/?variant=A.

This decision prototype is for [Prototype the worktree, changes and file-management surfaces](https://github.com/ManuelUsoz/spence/issues/82), part of [Wayfinder: worktrees, source control and change history](https://github.com/ManuelUsoz/spence/issues/79). It uses fictional Session data and in-memory operations. It does not call Git, touch Project files, connect desktop RPCs, or enter the production build.

Three alternatives preserve the sidebar, conversation, Receipt and Composer context:

- **A — Right inspector:** current changes, files and history stay beside the conversation. Closest to the supplied calm Session reference.
- **B — Full-width workbench:** Source control replaces the conversation body while keeping the Session header. More room for reviewing diffs, less simultaneous conversation context.
- **C — Bottom tray:** the conversation stays above a horizontal file/diff/action workspace. More width for diffs, less vertical conversation space.

Use the floating arrows or keyboard arrows to switch; `?variant=A`, `B`, or `C` is reload-stable. The bar's State disclosure exposes fixture state. The scenario selector demonstrates active shared Turns, stale reviews, hook failures, committed/push-failed, divergence/conflicts, recovery refusal, partial results, missing folders, incomplete captures, loading/errors and non-Git folders. Numeric retention and preview limits remain undecided on the map.

Review paths:

1. Composer Worktree picker: creation, switching through a Summary handoff, missing paths and removal restrictions.
2. Current changes: select files, enter a message, review Commit selected/all or Commit & push. Unselected staged files stay staged.
3. Receipt → Session history: individual Turn comparisons; historical Restore chooses observation and same-repository destination. No cumulative Session diff or Restore entire Session.
4. Git history → Clean fixture → Revert: new reversal commit, external conflict editing, Continue/Abort.
5. Files: live read-only preview, external opening, creation/rename/delete, cross-Worktree copy/move, separate ignored-file visibility/inclusion, folder Merge versus Replace completely.
6. Fetch/Push/Force push/Pull: explicit destinations, lease review, clean/idle requirements, explicit divergence choices and conflict handling.
7. Discard/Restore → Simulate change after review → confirm: stale review refuses. Recovery scenario refuses required writes; partial-result scenario discloses completed/failed/untouched paths.

The interactive fixtures illustrate product decisions rather than implementing a complete Git or filesystem state machine. File/form inputs in secondary review dialogs are visual examples; only selection, commit message, main Worktree switch, layout and scenario controls drive fixture state. No numerical limits or new product semantics are approved by this prototype.

Pending live review: select a layout (or combine parts), refine interactions, then record the agreed resolution on the decision ticket. Do not close it without the user's review. Capture only prototype files on a throwaway branch after review; do not include unrelated workspace edits or the user's untracked reference HTML.
