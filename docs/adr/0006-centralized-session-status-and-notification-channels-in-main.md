# 0006. Centralize Session status and multi-channel notification routing in main

Status: accepted

## Context

Previously, a Session exposed separate `attention?: 'needsAnswer' | 'error'` and `running?: boolean` flags that the renderer re-combined into activity states, and main's `Notifier` emitted only OS notifications when the window was unfocused and a Session entered `Attention`. Adding a unified **Session status** (`idle | working | blocked | error`), notifying on clean **Turn finished** events alongside **Blocked** and **Error**, and introducing **in-app toast notifications** (with future channels such as **voice** planned) required choosing whether the renderer or main owns status transitions, visibility suppression, and channel routing.

## Decision

- **Single `SessionStatus` in main**: main derives each Session's mutually-exclusive `status: 'idle' | 'working' | 'blocked' | 'error'` from its Transcript and live state (`'blocked'` for a pending Permission request, pending browser handoff, or unanswered `asksUser` Cross-Session message; `'error'` for a failed last Turn or stopped Agent; `'working'` for an active Turn, Compaction, or Summary handoff; `'idle'` otherwise) and publishes it on `LiveState`, `SessionSummary`, and `SessionChange`, alongside the last settled Turn's `turnId` and `outcome` tag (`done | cancelled | refused | cutShort | failed`).
- **Centralized notification eligibility in main**: `Notifier` (for Local Sessions) and `RemoteNotifier` (for connected Paired devices) evaluate transitions once in main. Notifications fire only on transition into `'blocked'`, transition into `'error'`, or a new settled Turn with outcome `done`, `refused`, or `cutShort`. Main suppresses notifications centrally when `settings.notifications` is off, when the Session is archived, when a Turn was cancelled by the user, when a **Worker** Session finishes a Turn normally (`'turnFinished'`), or when the Spence window is focused and the Session is visible in an open Pane of the active Tab (tracked via `Sessions.setTabs`).
- **Pluggable notification channels driven from main**: main dispatches eligible notification events (`'blocked' | 'turnFinished' | 'error'`) to registered channels:
  - **OS channel**: displays a silent OS notification when the main window is unfocused (flashing the taskbar / badging the dock on `'blocked'`), activating the Session's Tab on click.
  - **In-app toast channel**: streams notification events over RPC to the renderer when the main window is focused and the Session is not visible in the active Tab; the renderer displays an auto-dismissing toast with an **Open** action that activates the Session's Tab/Pane.
  - **Future channels (e.g., Voice)**: subscribe to the same main-process notification dispatcher without duplicating status or visibility rules in the renderer.

## Consequences

- Every process and future notification channel consumes one authoritative `SessionStatus` and one notification event stream from main, preventing duplicate or divergent alerts across OS banners, in-app toasts, and future voice output.
- In-app Session event toasts are driven by an RPC stream from main rather than computed locally in the renderer from UI state changes.

## Considered Options

- **Renderer-driven in-app toasts and status derivation**: rejected because it splits notification eligibility, Worker suppression, and focus/visibility checks across main and renderer, requiring every future channel (such as voice in main) to re-implement or synchronize those rules.
- **Inferring `'turnFinished'` from `status: 'working' -> 'idle'` alone**: rejected because user-cancelled Turns and finished Compactions also transition from `'working'` to `'idle'`; carrying the last settled Turn's identity and outcome tag on `LiveState` makes Turn-completion detection deterministic across both Local and Remote Sessions.
