# Worker adapter qualification: Codex ACP 2.6.0

Issue #122 requires direct messages to the actual native child, while working and after it finishes. This is a live limitation, not a qualification of writable Workers.

## Live probe

On 2026-11-16 on Windows x64, Node 24.22.0 ran a temporary npm installation of `@agentclientprotocol/codex-acp@2.6.0` with its installed `@openai/codex@0.166.0`, using the existing ChatGPT login and no `CODEX_PATH` override. `initialize` with `clientCapabilities.subagents: {}` returned protocol 1, adapter 2.6.0, and `sessionCapabilities.subagents: {}`. A parent prompt spawned a real native child. The parent received a `subagent_update` with a child session ID, `running`, and later `idle` / `end_turn`; streamed child message chunks addressed to that ID contained `CHILD_INITIAL_MARKER`. The parent completed with `end_turn`.

A `session/prompt` to the exact announced child ID both immediately after announcement and after its idle update returned JSON-RPC `-32600`, `Invalid request: Subagent sessions do not permit client-initiated mutations`. No response to either direct message was produced. The result was reproduced with `scripts/qualify-codex-workers.mjs`, which prints sanitized results and exits successfully when it observed all phases, even if the adapter rejected the prompts. To repeat, install the pinned package in a temporary directory and pass the absolute path to its `dist/index.js` to that script. The probe uses real provider resources and is not a CI test.

## Interpretation and next steps

The published adapter explicitly rejects restricted child mutations at its request boundary. Removing the guard alone is not evidence that prompting reaches the underlying child: the adapter also maintains separate child associations and normal session state, and busy steering, idle reactivation, permissions, restoration, nesting and cancellation need their own end-to-end verification. An adapter/SDK change must address the actual native child and be repeated against a real provider before exposing writable Workers. The observed lifecycle and child transcript routing are useful but do not satisfy direct messaging. Stable identity across restart, duplicate announcements, nested workers, cancellation, permission routing and reconciliation were not tested here.

`agy` was not available on PATH, so Antigravity was not tested. Claude 0.106.0 remains blocked by the rate limit described in [its qualification record](workers-claude-0.106.0.md). The HTML reference exists in git history at commit `3fc5578`, path `docs/Spence — Vista de chat (calma).html`.
