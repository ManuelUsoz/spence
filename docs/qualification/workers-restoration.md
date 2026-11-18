# Worker restoration after restart or connection loss

Issue #124. This records what Spence restores itself and what depends on an adapter. It was verified with the repository's fake ACP Agent over temporary Stores (`electron/sessions/reopen.spec.ts`, "Restoring Workers after a restart"); no live provider run is claimed.

## Durable (Spence-owned, adapter independent)

- A Worker Session, its Transcript and its immediate Parent link (`parentSessionId`, `workerKind`) live in the Store and survive restart, including nested Workers. Stores from before `workerActive` existed keep working: a native Worker with no recorded activity counts as previously active only if its Transcript ends mid-Turn.
- A re-announced native child resolves to the existing Session through `(parent, nativeWorkerId, parent context)`, so Sessions, Transcript content, Parent return links and open Worker Tabs keep the same identity.
- A Spence-owned Worker has its own ACP Session in a process that ends with the app. After restart it is known not to be running, so it is not listed as active; its Session stays open and writable.

## Activity reconciliation

- Native Workers last known working (running or waiting for Permission) are listed on the reopened Parent as `unknown`, shown as "Reconnecting", and excluded from the confirmed-running count and spinner. The Composer control stays visible with a "Reconnecting" label while only unknown Workers exist.
- Losing the Parent's Agent connection turns its running native Workers to `unknown`; owned Workers are unaffected because they use their own connection.
- State becomes confirmed only from the adapter: a `subagent_update` announcement with `running`, `requires_action` or `idle`. It never comes from the Parent Turn. `idle` leaves the active list; `running` re-enters the count.

## Adapter limits

- Reconciliation needs the adapter to announce its children again after `session/load` or `session/resume`, or to keep reporting them. Claude ACP 0.106.0 has restoration code paths (see [the native Worker record](workers-claude-0.106.0.md)) that were not verified live; Codex 2.6.0 and Antigravity 1.5.7 are covered by their own records. When an adapter never re-announces a child, it stays "Reconnecting" rather than being guessed idle or running. It remains reachable read-only with its Transcript.
