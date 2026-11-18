# Worker adapter qualification: Antigravity CLI ACP 1.5.7

This is a limitation record for #121 / #122, not a qualification of Worker discovery or direct messaging.

## Environment and official guidance

On 2026-11-16, Windows x64, integration baseline `390ef66`, `agy` was absent from the process PATH, but `C:\Users\miuso\AppData\Local\agy\bin\agy.exe` existed and reported `1.5.7`. Its `acp --help` confirmed the native stdio server. No installation or login was required for the live turns. Google documents the [Windows CLI installation location](https://antigravity.google/docs/getting-started?tab=cli), [`agy acp` setup and cached login](https://antigravity.google/docs/cli/acp), and [subagent invocation and direct messages in the CLI UI](https://antigravity.google/docs/subagents?tab=cli). The latter does not establish an ACP child-input interface. The project's `agy acp` catalog entry still requires its merged PATH to find the executable; presence in the default directory alone did not establish Spence discovery.

The [ACP registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json) also lists a distinct Google-distributed standalone server; this probe used the installed CLI, not that binary. Google's [ACP guide](https://antigravity.google/docs/ide/extensions/acp) describes steering a running session, but does not document applying it to a parent-owned child.

## Live observations

A temporary JSON-RPC client started the executable with `acp`, identified itself as `spence`, and sent `clientCapabilities.subagents: {}`. `initialize` returned protocol 1 and `agentInfo` `Antigravity ACP Server` version `1.5.7`; it did not advertise `sessionCapabilities.subagents`. A parent session used the existing authenticated account and ended normally. In two separate turns the stream showed `invoke_subagent` tool calls but no `subagent_update` announcement. In the second turn the parent linked a `conversation://` identifier and reported that its research child had read `AGENTS.md` and returned `CHILD_INITIAL_MARKER`. This is a parent report, not a separately observed child transcript.

After the parent turn completed, `session/prompt` directed to the identifier extracted from that link returned JSON-RPC `-32602`, `Session not found`. This was an attempt using a conversation identifier, not an ACP-announced session ID. It does not prove that every possible native child input mechanism is unavailable, or test an active child. No direct message or child response was observed. The `invoke_subagent` tool event alone lacks the established ACP child lifecycle and transcript stream, and parsing model-generated links is not a reliable identity contract.

To repeat the diagnostic from the repository root, run `node scripts/qualify-antigravity-workers.mjs "C:\Users\<user>\AppData\Local\agy\bin\agy.exe"` with an existing authorized login. It launches a real provider turn, asks for read-only work, cancels permission requests, and reports sanitized observations. A subsequent run of the checked-in script observed `invoke_subagent` and zero announcements, but the parent returned no link or marker; it therefore made no direct-prompt attempt. Model behavior is nondeterministic; failure to produce a link is inconclusive. The diagnostic tries only post-parent prompting of a linked conversation ID; it does not qualify busy prompting or idle reactivation.

## Remaining work

Find a supported Antigravity ACP or vendor interface that announces the actual child identity, lifecycle, and transcript, and accepts direct input to that same child. Verify both while active and after completion, plus identity stability, nesting, cancellation, permission routing and reconnection, with the exact version shipped. A parent-mediated message, an unrelated session, or Google CLI UI support alone does not satisfy #122. Until then keep Antigravity Worker discovery and writable messaging unqualified.
