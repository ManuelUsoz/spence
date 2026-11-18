# Worker and Session messaging qualification (#166)

Status: **not qualified against a real Agent.** No authenticated Codex or Antigravity adapter was available when this was built, so only the fake-Agent probes ran. Nothing here claims provider behavior.

What ran: `electron/sessions/sessions.spec.ts` ("Session messaging within a delegation tree") drives Spence's real Sessions, Agent lifetime, ACP client, delegation server and Store with the fake ACP Agent over real loopback MCP calls. Two Spence-owned Workers under one Parent list each other, message each other, queue behind a busy target, start an idle one, hit the hop and rate limits and are rejected when foreign, stale or revoked. The fake Agent itself calls `send_message` over MCP in the ping-pong probe, so the tool path is exercised from inside an Agent process, but its decisions are scripted.

To qualify a real Agent, run the opt-in probe `sends a message between two owned Workers` the same way as the delegation probe in [workers-owned-codex-2.6.0.md](workers-owned-codex-2.6.0.md) (`SPENCE_CODEX_ACP_BIN` or `SPENCE_ANTIGRAVITY_ACP_BIN`, then `npx vitest run electron/sessions/sessions.spec.ts -t 'between two owned Workers'`). It asks a Parent to create Worker B, then Worker A, whose Agent must discover B through `list_sessions` and message it with `send_message`; it passes only if B's persisted Transcript holds A's message attributed to A. Record the adapter version and date here when it passes.

Native limitations are separate and unchanged: provider-native children stay read-only and are never reachable (see the native Worker records in this folder). Reachability only includes the delegation tree's root Session and its Spence-owned Workers.

## Across Projects (#167)

Status: **not qualified against a real Agent**, same reason as above. `electron/sessions/sessions.spec.ts` ("Session messaging across Projects") drives two real Projects with real Spence Sessions, the delegation server over loopback MCP and the fake ACP Agent: the first contact raises a Permission request in the sender Session (Allow once / Always allow / Deny), Always allow is stored per Project pair in Settings, the receiver gets an attributed message through its ordinary Queue, and removing a Project revokes its allowances. No real Agent has called `list_sessions` with a `projectId` or `send_message` across Projects.
