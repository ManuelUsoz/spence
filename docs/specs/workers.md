## Problem Statement

Users cannot see or enter the parallel work an Agent spawns from a Session. They need to know what is actually working and intervene when necessary, without completed-work lists, event noise or automatic navigation.

## Solution

Show a quiet Worker count and spinner in the Composer while direct Workers are working. Clicking opens a right sidebar of those Workers. Selecting a row opens its regular, writable Session in the main view, with a persistent link back to its immediate Parent Session. Hide the Composer control at zero. Preserve relationships across restarts, reconcile actual activity, and keep completed Workers out of the active list.

## User Stories

1. As a user, I want to see how many direct Workers are working, so that I can understand current parallel activity.
2. As a user, I want a spinner while Workers are confirmed working, so that activity is visible quietly.
3. As a user, I want the control hidden at zero, so that idle Sessions stay calm.
4. As a user, I want to open the Worker sidebar from the Composer, so that details remain on demand.
5. As a user, I want concise Worker titles and states, so that I can choose which work to inspect.
6. As a user, I want completed Workers removed from the active list, so that it reflects current work.
7. As a user, I want an already-open sidebar to say “No workers running” when its last Worker finishes, so that it does not close unexpectedly.
8. As a user, I want a Worker row to open its Session in the main view and a regular Tab, so that I can read its Transcript normally.
9. As a user, I want Workers absent from the Project session list, so that delegated work does not crowd it.
10. As a user, I want to send Messages directly to a Worker, so that I can guide its actual conversation.
11. As a user, I want a busy Worker Composer to use regular Session send/queue behavior, so that messaging stays consistent.
12. As a user, I want a finished Worker chat to remain open and writable, so that completion does not interrupt inspection.
13. As a user, I want a new Message to make an idle Worker active again, so that its parent reflects renewed activity.
14. As a user, I want a persistent link to the immediate Parent Session, so that I can return easily.
15. As a user, I want each Session to count only its direct Workers, so that nested delegation stays understandable.
16. As a user, I want the right sidebar to follow the viewed Session, so that it never describes a different Session.
17. As a user, I want that sidebar closed when navigating to a Worker without active children, so that the view stays quiet.
18. As a user, I want Workers waiting for permission counted as working, so that blocked work remains visible.
19. As a user, I want “Needs permission” on the Worker row and normal Attention on its Tab, so that I can find requests.
20. As a user, I want to answer permissions inside the Worker chat, so that the decision has context.
21. As a user, I want no automatic navigation or extra Worker toasts, so that work does not interrupt me.
22. As a user, I want parent-child relationships restored after restart, so that navigation and ownership persist.
23. As a user, I want disconnected Workers shown as “Reconnecting” without a confirmed-running count or spinner, so that unknown activity is not misrepresented.
24. As a user, I want previously active Workers accessible during reconciliation, so that a disconnect does not remove my way to inspect them.
25. As a user, I want stopping a parent Turn to stop its working Workers and descendants, so that delegated work stops with it.
26. As a user, I want stopping a Worker to stop its work and descendants only, so that other branches can continue.
27. As a user, I want a warning that deleting a Parent Session deletes all Worker descendants, so that I understand the loss before confirming.
28. As a user, I want confirmed parent deletion to remove descendant Sessions and Transcripts, so that ownership has predictable consequences.
29. As a user, I want an independent Fork to survive parent deletion, so that I can deliberately preserve information.
30. As a user, I want activity driven by actual Worker lifecycle rather than the parent Turn, so that background Workers remain visible after the parent finishes.

## Implementation Decisions

- Use the glossary term Worker for an assistant spawned by an Agent, with its own writable Session and persistent immediate Parent Session relationship. Avoid “subagent” in product vocabulary.
- Worker parentage is distinct from Fork lineage and Summary handoff. Forks remain independent and survive cascading deletion.
- Extend the Session domain contract, durable storage and migration support to represent Worker identity, parentage and lifecycle. Keep durable relationship data distinct from reconciled live activity.
- Discover Workers and route child Transcript updates at the ACP adapter boundary in main. Normalize adapter data into Spence contracts; ACP types never reach shared contracts or the renderer.
- Qualify discovery, stable identity, lifecycle, nesting, restoration, cancellation, permission routing and direct child prompting against supported Agent integrations. Direct messaging is mandatory; creating an unrelated conversation is not a substitute. Extend adapter support if required.
- Count confirmed working direct children, including those waiting for Permission. Do not derive Worker state from whether the parent Turn is running.
- Preserve access to previously active Workers during reconnect as “Reconnecting”; exclude unknown states from confirmed activity counts and spinners until reconciled.
- Extend the existing Session view and shell navigation for the Composer control, right sidebar, Worker Tabs and Parent Session return link. Workers remain absent from the Project session list.
- Selecting a Worker changes the main view and sidebar context to that Session. Close the sidebar when the newly viewed Worker has no active children. Separately, leave an already-open sidebar visible with its empty state when its last Worker finishes.
- Child Sessions support ordinary messaging, including existing busy-Composer behavior. Finishing does not close their views or remove persistent parentage.
- Worker Permission requests are answered in their own chats, with row status and normal Tab Attention, without extra toasts or automatic navigation.
- Stop propagates down the selected branch. Parent Session deletion warns before confirmation and cascades through all Worker descendants, including idle descendants. Independent Forks survive.
- Renderer effects run through EffectRuntime and DesktopApi. Shared UI wrappers remain presentational; use Helm, theme tokens, existing typography rules and English/Spanish localization.

## Testing Decisions

- Test externally observable behavior rather than internal method calls or snapshots mirroring implementation. Reuse existing boundaries; do not introduce a Worker-specific testing framework.
- Test renderer behavior through DesktopApi with makeDesktopTestLayer, following existing Session view, Tab and shell feature specs. Cover count transitions, zero hiding, permission states, reconnect display, sidebar empty state versus navigation closure, writable chats, parent return links and Project list exclusion.
- Test Session service and persistence behavior through existing public service boundaries and temporary stores, following Session, reopen, deletion and handoff tests. Cover persistent parentage, nested direct-child counts, reactivation, cascading stop/deletion and independent Fork survival.
- Test ACP translation and routing through the existing adapter boundary and Session transport test patterns. Cover stable child IDs, discovery opt-in, duplicate/restored announcements, child Transcript routing, lifecycle independent of the parent Turn, permissions and cancellation.
- Verify actual child prompting against qualified Agent integrations. Mock renderer tests are insufficient evidence that a native child is writable. Adapter qualification is an implementation prerequisite, not an optional follow-up.
- Run the repository verify gate after implementation. No feature implementation is included in this specification task.

## Out of Scope

- Completed Worker history in the active sidebar or Composer control.
- Aggregate descendant counts in ancestor Composers.
- A separate Worker messaging or queue model.
- Completion toasts, automatic focus changes or a parallel activity feed.
- Promoting a native child into an unrelated conversation as a substitute for direct messaging.
- Changing existing Fork context-transfer semantics.

## Further Notes

The design and test seams were agreed in the design interview. The requested HTML reference is absent from this checkout; the existing calm-session specification supplies the quiet interaction principles.

Local inspection of globally installed Claude ACP adapter 0.107.0 found capability-gated native child announcements, child Transcript routing and cancellation. It did not establish ordinary prompting of native children. The repository qualifies 0.106.0, so that inspection establishes neither support in the qualified version nor support in other Agents. Verify exact integrations before committing to implementation details.
