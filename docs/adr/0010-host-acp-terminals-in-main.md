# 0010. Host ACP client terminals in main

Status: accepted

Spence's v1 baseline (`calm-session-view-v1.md` §3.3) and `context-management-and-handoffs.md` §2.1 claimed no `fs` or `terminal` ACP client capabilities, leaving Agents to execute commands internally and forcing Spence to guess command state from coarse `tool_call_update` titles and completion-only text blocks. Without client-hosted terminals, the UI cannot reliably stream live rolling stdout/stderr tails or display authoritative process exit codes for running and finished command **Steps**.

We advertise `terminal: true` in `CLIENT_CAPABILITIES` (`electron/acp/acpSessionManager.ts`) and implement the ACP `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, and `terminal/release` handlers in Electron main, bound to each **Session**'s lifecycle. Direct process spawning (`windowsHide: true`, no shell) is used when `args` is non-empty, OS shell invocation (`cmd.exe /d /s /c` on Windows, `/bin/sh -c` on POSIX) is used only when `args` is omitted, `cwd` defaults to the Session's active folder and rejects paths outside the **Project** or **Worktree**, output is capped at a 32 KB rolling tail streamed to the Step via throttled deltas, and unreleased terminal process trees are terminated on **Turn** cancel, **Stop Agent**, Session detach, or app quit.

This reverses the v1 "no client `terminal`" boundary (while keeping `fs` disabled) and requires main to own child process lifecycles and `cwd` containment; Agents or tools that bypass `terminal/create` still fall back to `tool_call` / `tool_call_update` payload mapping in `electron/acp/acpMappers.ts`.
