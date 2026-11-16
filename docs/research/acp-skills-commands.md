# ACP skills and commands research

Research for [Research how ACP Agents expose skills and commands](https://github.com/ManuelUsoz/spence/issues/135), under [Wayfinder: rich content in the chat and Composer](https://github.com/ManuelUsoz/spence/issues/133). Inspected 2026-11-16. Planning evidence, not a definition of Skill. No agents were delegated recursively.

## Evidence and limits

Source inspection demonstrates mapping logic, not successful live execution on every installation. No authenticated agent session was exercised. Spence baseline is commit `463f1db`; qualified adapters are Claude 0.106.0, Codex 2.6.0, and native Antigravity minimum 1.2.0. Current upstream main was also inspected (Claude `0073280b977a69934fb56670943d1ef42e7b687e`, Codex `656765115f82253c79f87918abb77189c114a799`). Do not generalize native terminal behavior to ACP.

## Matrix

| Integration | Proven ACP-facing behavior | Metadata and distinction | Enablement / limits |
| --- | --- | --- | --- |
| Claude Agent ACP 0.106.0 | SDK commands, including user-invocable skills, map to the same command list; unsupported/terminal commands are filtered; MCP prompts renamed with `mcp:` | name, description, argumentHint mapped to input.hint. Skill kind and file path are conditional AIR extension metadata, not portable ACP fields | Adapter advertises SDK-visible commands; no portable per-session skill toggle is established. Hidden/model-only skills need not appear |
| Codex ACP 2.6.0 | Lists skills through Codex app-server and combines them with builtins in available commands | Skill name is `$name`; description prefers shortDescription, then description, then name; input null. AIR-only skillPath metadata. The mapper does not export scope or enablement | Native app-server metadata is richer than the advertised list; listing is not proof every returned item can execute. No ACP skill-management contract proven |
| Google Antigravity native `agy acp` | Google documents this JSON-RPC stdio server. No inspected primary source or wire trace establishes its exact skills advertisement payload | Native docs describe name/description skill discovery and interactive CLI slash conversion; these do not prove ACP metadata, separate skills channel, or command-kind markers | Local/global/plugin discovery is documented. Whether all discovered skills are advertised, refresh dynamically, or can be toggled over ACP remains unknown |
| Spence | available_commands_update replaces LiveState.commands through toCommands; filters agent clear | Preserves name, description, optional hint only; drops extension metadata; no Skill type | No enable/disable operation; an empty command array does not distinguish not-yet-reported from reported-empty |

Primary adapter evidence: [Claude tagged command mapper](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.106.0/src/slash-commands.ts), [Claude tagged session implementation](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.106.0/src/v1/acp-agent.ts), [Codex tagged commands](https://github.com/agentclientprotocol/codex-acp/blob/v2.6.0/src/CodexCommands.ts). Tags identify versions; upstream main SHAs above distinguish the moving latest code.

## Protocol versus native products

[ACP v1 slash commands](https://agentclientprotocol.com/protocol/v1/slash-commands) advertises commands with name, description and optional input hint. Invocation is ordinary prompt text. It does not establish a portable skill catalog, source/scope, enabled flag, trigger-description semantics, or skill-management RPC. Extension metadata must be negotiated/interpreted by convention; absence of a command is not evidence of absence of a model-invocable skill. Do not silently adopt the separately documented draft v2 contracts for this v1 client.

[Claude native skills documentation](https://code.claude.com/docs/en/skills) describes automatic and explicit invocation, user-invocable and disable-model-invocation controls, argument hints, and visibility settings. These are independent axes: installed, listed to the model, visible to users, and invoked are different states. A hidden command is not necessarily a disabled skill. Native controls do not prove a Spence-controllable ACP toggle.

[Codex adapter app-server SkillMetadata](https://github.com/agentclientprotocol/codex-acp/blob/v2.6.0/src/app-server/v2/SkillMetadata.ts) and [skills configuration request](https://github.com/agentclientprotocol/codex-acp/blob/v2.6.0/src/app-server/v2/SkillsConfigWriteParams.ts) are native backend contracts, not automatically client-accessible ACP RPCs. The public [skills entry page](https://developers.openai.com/codex/skills/) currently redirects to ChatGPT Learn; it is not used as proof of adapter behavior. Skill support is established by the adapter source instead.

[Google skills documentation](https://antigravity.google/docs/skills) describes SKILL.md bundles, description-based automatic discovery, local/global/plugin locations and automatic slash conversion inside the interactive CLI. [Google ACP documentation](https://antigravity.google/docs/cli/acp/) proves the native transport and shared CLI settings/authentication, but does not specify the command payload. Neither a third-party agy-acp wrapper nor Gemini CLI is evidence for Spence's native agy integration. No separate ACP skills surface was established for these integrations; this is absence of evidence, not proof none exists.

## Spence mappings and contract implications

Local evidence: [toCommands](https://github.com/ManuelUsoz/spence/blob/463f1db/electron/sessions/session-options.ts), [session updates](https://github.com/ManuelUsoz/spence/blob/463f1db/electron/sessions/sessions.ts), [Command and LiveState](https://github.com/ManuelUsoz/spence/blob/463f1db/src/shared/sessions/sessions.rpc.ts), [Composer palette](https://github.com/ManuelUsoz/spence/blob/463f1db/src/app/features/session/session-view.ts).

The palette prefixes advertised names with `/`, filters by name prefix, and inserts `/${command.name} `. Thus a Codex `$foo` entry is displayed/injected as `/$foo`; preserving a display label separately from invocation text would avoid binding a future skill UI to this representation. Live qualification should verify the adapter accepts this exact text before promising execution. Spence also owns clear and intercepts compact when supported.

Potential contract growth, conditional on the human decision: separate stable identity, display name and invocation text; optional kind with unknown fallback and evidence provenance; optional source/scope only when actually reported; discovery state (unknown/known-empty/known-populated); invocation visibility versus enablement capabilities; typed, validated adapter extension data rather than blindly trusting paths. Name prefixes and filesystem heuristics alone cannot provide a universal Skill discriminator. Keep discovery and execution at main/domain boundaries; no feature-level filesystem or raw ACP access.

## Remaining human decisions and qualification

The existing [Define Skill in Spence's vocabulary and its Composer surfacing](https://github.com/ManuelUsoz/spence/issues/138) already covers the sharp decisions: meaning of Skill, shared versus separate trigger, arguments/search, text versus structured invocation, per-session enablement, and Spence command coexistence. No duplicate ticket is needed. Decide whether unknown-kind entries remain ordinary commands, how unsupported toggles are represented, and whether semantic classification requires explicit adapter evidence. These are questions, not decisions made here; no glossary or ADR is changed.

Before implementation acceptance, capture wire traces for each qualified integration with one project skill, one global/plugin skill, a builtin command, hidden/model-only configuration, arguments, resume, mid-session changes and empty-list replacement. Record exact versions, initialization capabilities and invocation response. Especially verify Antigravity native payload and Codex `/$name` routing. These qualification cases fit existing skills/prototype/final-acceptance tickets; no newly discovered independent decision ticket is necessary. Skill-related fog is covered by the named definition ticket and Composer prototype, while image fog is unrelated and retained.
