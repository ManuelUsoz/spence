# Worker adapter qualification: Claude ACP 0.106.0

Issue #122 requires a real native child to accept a direct prompt before Workers can be delivered as writable Sessions. This record is an investigation, not a qualification or a claim that child prompting works.

## Probe on Windows x64

On 2026-11-16, a temporary installation of `@agentclientprotocol/claude-agent-acp@0.106.0` was started with Node 24.22.0. ACP `initialize` with `clientCapabilities.subagents: {}` returned protocol version 1 and adapter version 0.106.0. `session/new` succeeded. A parent `session/prompt` asking Claude to launch a background Agent failed with JSON-RPC `-32603`, `errorKind: rate_limit` (weekly limit). No native child was announced and no direct child prompt could be attempted. This is not evidence of a successful child interaction.

## Package inspection

Inspection of the published 0.106.0 package shows:

- `dist/acp-subagents.js` opts into the RFD form when `clientCapabilities.subagents` is an object. `dist/native-subagents.js` tracks children in the parent session's `nativeSubagentsByTaskId`, announces them, and routes updates to child IDs. Its RFD IDs use the SDK agent ID; restoration, nested parentage and lifecycle have code paths, but were not verified live.
- `dist/v1/acp-agent.js` implements `session/prompt` through `startTurn`, which looks up `this.sessions[params.sessionId]` and returns `sessionNotFound` when absent. `openGeneration` in `dist/native-subagents.js` registers the child in the parent's child map, not that session registry. This suggests an announced native child cannot be prompted through ordinary `session/prompt`; a live child probe is still needed to confirm the observable result.
- The package observes and routes Claude's own `SendMessage` and resume events. That does not establish a client API for injecting a message into the same native child, especially while busy or after completion. Creating or resuming a separate ordinary session would not establish that capability either.

Permission routing, cancellation, reconnect reconciliation, stable identity across restarts, and integrations other than Claude remain unqualified. The installed global adapter was 0.107.0 and was not used as evidence for the pinned baseline.

## Next qualification step

After provider access is available, launch a real child with 0.106.0 and send `session/prompt` to its announced ID while active and after completion. Capture sanitized ACP events and verify that replies come from the same child conversation. If unsupported, extend the actual adapter/SDK path to address that child and repeat the live probe before exposing writable Workers. Do not substitute a new unrelated conversation.
