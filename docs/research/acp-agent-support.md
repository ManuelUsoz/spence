# ACP Agent launch and capability support

Research for [#56](https://github.com/ManuelUsoz/spence/issues/56), part of [#55](https://github.com/ManuelUsoz/spence/issues/55). Checked 2026-11-13. Planning only; no adapters installed, credentials supplied, paid prompts run, or integration certification performed.

## Findings

Codex has an ACP-project-maintained adapter in the required namespace. Google Antigravity now has Google's own native ACP command. These are distinct integrations with different launch/authentication requirements. The older archived Zed Codex adapter and community Antigravity bridges should not define the implementation baseline. Native ACP launch is now permitted by the user's clarified requirement; ADR 0002 still needs its package-only wording amended. Its main-process translation boundary remains applicable.

Evidence levels below: **source** means an inspected implementation at the linked immutable revision; **docs** means a maintainer's documented behavior; **unknown** means this investigation did not establish it. Neither source nor documentation means a successful Spence runtime test.

## Identity, distribution and versions

| | Claude baseline | Codex candidate | Google Antigravity candidate |
| --- | --- | --- | --- |
| Product | Claude Agent SDK behind ACP-project adapter | OpenAI Codex App Server behind ACP-project adapter | Google Antigravity CLI's native ACP server, not Gemini CLI |
| Maintainer | `agentclientprotocol`; underlying SDK by Anthropic | `agentclientprotocol`; underlying Codex by OpenAI | Google |
| Package / command | `@agentclientprotocol/claude-agent-acp`; `claude-agent-acp`, no arguments | `@agentclientprotocol/codex-acp`; `codex-acp`, no arguments | No ACP-project npm package established; `agy acp` |
| Examined version | source/package 0.106.0, latest release 2026-11-10 | source/package 2.6.0, latest release 2026-11-08 | docs advertise CLI 1.2+; exact minimum ACP release unknown: check `agy acp --help` |
| Runtime dependencies | npm route Node >=22; Claude SDK 0.3.322; ACP SDK 2.6.0 | includes `@openai/codex` ^0.166.0; ACP SDK ~2.6.0; optional `CODEX_PATH` override | native CLI installation; no npm/Node dependency established |
| Platforms | release archives: Linux glibc/musl, macOS, Windows; x64/arm64; standalone pair includes Claude CLI | build scripts target Linux/macOS/Windows x64/arm64; target configuration is evidence, not testing on every platform | official CLI installers for macOS/Linux/Googlebook and Windows; architecture support not independently certified |

Claude evidence: [package](https://github.com/agentclientprotocol/claude-agent-acp/blob/4804917a6fa7050490d1d62c6689e78c231c752a/package.json), [README and standalone distribution](https://github.com/agentclientprotocol/claude-agent-acp/blob/4804917a6fa7050490d1d62c6689e78c231c752a/README.md), [release](https://github.com/agentclientprotocol/claude-agent-acp/releases/tag/v0.106.0). Codex evidence: [package/build targets](https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/package.json), [README](https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/README.md), [release](https://github.com/agentclientprotocol/codex-acp/releases/tag/v2.6.0). Antigravity: [quickstart/install](https://antigravity.google/docs/getting-started), [native CLI ACP](https://antigravity.google/docs/cli/acp/).

The reproducible npm installation choices are `npm install -g @agentclientprotocol/claude-agent-acp@0.106.0` and `npm install -g @agentclientprotocol/codex-acp@2.6.0`. Codex's README also offers `npx -y @agentclientprotocol/codex-acp`; a floating package is unsuitable as a compatibility baseline. Google's documented installers are `https://antigravity.google/cli/install.sh` (macOS/Linux) and `https://antigravity.google/cli/install.ps1` (PowerShell), placing `agy` under `~/.local/bin` or the user's local AppData `agy/bin`. These are installation facts, not instructions executed in this research. [Claude package](https://github.com/agentclientprotocol/claude-agent-acp/blob/4804917a6fa7050490d1d62c6689e78c231c752a/package.json), [Codex README](https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/README.md), [Google installation](https://antigravity.google/docs/getting-started).

OpenAI's official integration documentation describes App Server's persistent conversations, streaming, interruption and approvals. This establishes the underlying product surface, not ACP compatibility: the ACP project's bridge owns that translation. [Official OpenAI documentation](https://developers.openai.com/codex/app-server).

## Capability matrix

| Capability | Claude | Codex | Antigravity |
| --- | --- | --- | --- |
| Authentication | Source: terminal subscription/Console login methods appear only when client supports terminal auth; gateway methods separate | Docs: ChatGPT browser login, API keys (`CODEX_API_KEY`, fallback `OPENAI_API_KEY`), opt-in custom gateway; `NO_BROWSER` hides browser method | Docs: cached login; Google/Enterprise OAuth, Gemini key, Agent Platform ADC, conditional terminal login |
| Model and effort | Source: session config model/effort options; runtime offerings control validity | Docs/source: model/reasoning effort, fast mode, approval/sandbox/profile options | Docs: account models plus Low/Medium/High/Extra/Max thinking; third-party models restricted to named IDE clients |
| Permission requests | Source: client requests with cancellation; permission modes | Source/docs: approval, sandbox and configured profiles, requests routed to client | Docs: Allow/Deny and existing rules |
| Streaming | Source/docs: messages, tools/diffs, reasoning | Source/docs: text, reasoning, tools, terminal output, plans, usage | Docs: responses, tools/diffs |
| Cancellation | Source: interrupt and pending interaction cancellation; fallback timer for wedged SDK | Source: abort pending interactions and interrupt turn | Docs: stops tools and pending permissions |
| Images | Source: advertised `promptCapabilities.image`; README | Source: advertised image capability; README | Docs: images/resources |
| Load | Source: replay history | Source: replay history | Docs: supported |
| Resume | Source: restores existing session without load replay on v1 | Source: separate v1 resume; v2 resume can replay | Docs: supported without history replay |
| List / close | Source: both implemented | Source: both implemented | Docs: both supported |
| Delete | Source: delegates to session-index deletion | Source: closes local session then deletes thread through index/client | Unknown: docs promise close, not deletion |
| Native fork | Source: implemented; not required for Spence fork | Source: implemented; not required for Spence fork | Unknown; not required for Spence fork |
| Protocol | v1 plus draft v2; default auto negotiation, env can constrain | v1 plus experimental v2 routes | Docs: v1 |
| Context usage | Source has usage mapping; semantics belong in companion context research | README reports token-usage events; no claim every event equals current occupied context | Not established by inspected ACP docs |

Claude source: [v1 agent, initialize/load/resume/close/delete/cancel](https://github.com/agentclientprotocol/claude-agent-acp/blob/4804917a6fa7050490d1d62c6689e78c231c752a/src/v1/acp-agent.ts), [auth methods](https://github.com/agentclientprotocol/claude-agent-acp/blob/4804917a6fa7050490d1d62c6689e78c231c752a/src/auth-methods.ts), [config options](https://github.com/agentclientprotocol/claude-agent-acp/blob/4804917a6fa7050490d1d62c6689e78c231c752a/src/session-config-options.ts), [usage](https://github.com/agentclientprotocol/claude-agent-acp/blob/4804917a6fa7050490d1d62c6689e78c231c752a/src/session-usage.ts), [v2 documentation](https://github.com/agentclientprotocol/claude-agent-acp/blob/4804917a6fa7050490d1d62c6689e78c231c752a/README.md).

Codex source: [server initialize/lifecycle/cancel](https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/src/CodexAcpServer.ts), [v1/v2 routing](https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/src/AcpAgentRouter.ts), [connection version](https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/src/ACPSessionConnection.ts), [features/auth/runtime](https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/README.md).

Antigravity matrix cells are documentation claims: [Google ACP guide](https://antigravity.google/docs/ide/extensions/acp/). Spence is not among the clients eligible for third-party models; do not spoof a named client's identity. No shared image-size limit or exact model/effort IDs were demonstrated. Google authentication guidance also says direct Gemini-key CLI usage requires `modelProvider: gemini` alongside `GEMINI_API_KEY`; that differs from the ACP page's shorter environment-only example and needs a compatibility check. [Authentication](https://antigravity.google/docs/install?tab=cli).

## Spence implications and launch alternatives

Repository baseline at e21be55: the hand-written catalog contains Claude only; its image limits and low/medium/high/max mapping are Claude-specific. The ACP manager checks the negotiated protocol version, gates load/resume/delete on capabilities, and drops load replay because Spence owns the Transcript. Current dependency is SDK 2.6.0. These are existing code facts, not proof the newest external adapters work unchanged. [Catalog](../../electron/agents/catalog.ts), [Claude data](../../electron/agents/claude/claude.ts), [manager](../../electron/acp/acpSessionManager.ts), [package](../../package.json).

The original [ADR 0002](../adr/0002-agents-speak-acp-only-behind-an-adapter-in-main.md) requires every Agent to launch through `@agentclientprotocol/*`; native commands are explicitly excluded. Read literally, Claude and Codex qualify and Antigravity does not. Updated user direction permits native ACP and requires translation into Spence's own domain model. The ADR amendment is a later decision/documentation action, not performed here.

Decision-relevant alternatives:

1. **ACP-project packages plus vendor-native ACP allowlist**: Claude/Codex packages; Antigravity `agy acp`. Matches clarified scope. Keep separate distribution/install/version probes and per-Agent config mappings behind main's translation layer. Gate actual features on initialization and negotiated version.
2. **Retain package-only policy**: Claude and Codex eligible; Antigravity explicitly unsupported until an eligible package exists. This would require revisiting the clarified requirement rather than claiming no Google ACP server exists.
3. **Community bridge fallback**: only after a deliberate maintenance/security/compatibility decision if official native support proves unusable. Search found multiple similarly named projects, but none was needed to establish the vendor-supported route; no community adapter is certified by this report.

For the agreed workflow, use a new destination provider conversation plus a Spence-produced summary for either Agent switching or a Spence-owned fork. Provider load/resume/fork IDs refer to that provider's own history and cannot establish a cross-provider handoff. Switch retains Spence Session/Transcript; fork creates a new Session in the same Project with selected Agent/Model. Wait for Turn completion/cancellation before either. These are user requirements and architectural deductions, not claimed ACP guarantees. Do not equate `session/close`, provider deletion, Spence archival, and context Clear.

## Remaining acceptance questions

- Which exact adapter/CLI versions will implementation pin or admit, and how will future upgrades be qualified? Source revisions above are a research snapshot; `main` can include unreleased changes.
- Does the installed `agy` negotiate the expected capabilities and expose usable Gemini models to a Spence-identified client? Third-party model entitlement needs explicit Google confirmation.
- What is the product behavior when native history deletion is unavailable, summary generation fails, cancellation hangs, credentials expire, or destination startup/model selection fails? No handoff should be committed before destination readiness is known.
- How are provider-reported usage and Spence estimates represented separately when usage events are absent or semantics differ? The companion research owns the detailed accounting conclusion.
- Before implementation acceptance, exercise a real Windows setup plus other supported target platforms for launch/auth, streaming/images, deny/cancel, restart/load/resume, and capability absence. No runtime success claim is made here.
