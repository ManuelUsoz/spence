# Claude ACP Live Qualification Record (Template)

Status: **Template (pending live run — no live-provider execution or certification is claimed in CI)**

- **Agent**: `Claude` (`id: claude`)
- **Integration**: `@agentclientprotocol/claude-agent-acp` (pinned baseline `0.106.0`, binary `claude-agent-acp`)
- **Spec**: [context-management-and-handoffs.md](../specs/context-management-and-handoffs.md) (§2.1, §2.3, §4 Tier 2)
- **Baseline constraints**:
  - `claude-agent-acp` resolved on the **Merged PATH** (the `claude` CLI itself is never used).
  - External login via Anthropic account on `-32000`; API keys, enterprise auth, and custom gateways require separate qualification.
  - Automated CI exercises only fake ACP fixtures (`electron/acp/fakeAgent.mjs`), never live Anthropic/Claude endpoints.

## Per-OS / Architecture Target Matrix

| OS              | Architecture  | Adapter Package & Version                       | Node.js Version | Probe Date   | Operator | Outcome | Notes                  |
| --------------- | ------------- | ----------------------------------------------- | --------------- | ------------ | -------- | ------- | ---------------------- |
| Windows         | x64           | `@agentclientprotocol/claude-agent-acp@0.106.0` | _TBD_           | _YYYY-MM-DD_ | _TBD_    | Pending | Pinned baseline        |
| _macOS / Linux_ | _arm64 / x64_ | `@agentclientprotocol/claude-agent-acp@0.106.0` | _TBD_           | _YYYY-MM-DD_ | _TBD_    | Pending | Separate qualification |

## Live Probe Checklist (Windows x64)

Record observed pass/fail/limitation details for each probe before promoting `claude` on Windows x64 to **Qualified**:

1. **Discovery & install**
   - [ ] Missing `claude-agent-acp` on **Merged PATH** reports `installed: false` (even when `claude` CLI is present) and offers `npm install -g @agentclientprotocol/claude-agent-acp@0.106.0`.
   - [ ] `npm install -g @agentclientprotocol/claude-agent-acp@0.106.0` installs `claude-agent-acp` onto **Merged PATH** and static `package.json` inspection reports `0.106.0` (`qualified`).
2. **Handshake & version qualification**
   - [ ] `initialize` negotiates `protocolVersion: 1` with `fs` and `terminal` client capabilities disabled, and returns `agentInfo.version`.
   - [ ] An unverified `claude-agent-acp` version passing `protocolVersion: 1` runs with the **Unverified version** notice and pinned upgrade command (`npm install -g @agentclientprotocol/claude-agent-acp@0.106.0`).
   - [ ] An incompatible adapter (`protocolVersion !== 1` or failed spawn) surfaces cleanly as `Can't start`.
3. **External authentication (`-32000`)**
   - [ ] Unauthenticated session/prompt returning `-32000` transitions to `Needs login` with Anthropic external login instructions.
   - [ ] Completing Anthropic login allows retry/reconnect to `ready` without replaying failed Turns.
4. **Text Turn, streaming & cancellation**
   - [ ] `session/new` and text `session/prompt` stream incremental `agent_message_chunk` / `agent_thought_chunk` updates and finish with `end_turn`.
   - [ ] `session/cancel` settles cleanly; stalled cancellation past `5 s` (`CANCEL_GRACE`) surfaces **Stop Agent** and confirms process `'exit'` before switching/forking.
5. **Models, Effort & Images**
   - [ ] Exposed `Model` choices (`session/set_config_option`) succeed and `modelChangePreservesContext` behavior matches live adapter behavior.
   - [ ] Mapped `Effort` levels (`low`, `medium`, `high`, `max`) round-trip via `session/set_config_option`; unmapped levels are omitted/disabled.
   - [ ] `promptCapabilities.image` and `ImageLimits` (`5 MiB`, `8000 px`, `20` per message) match live attachment acceptance and pre-send gating.
6. **Permission modes (`Auto` & `Ask`)**
   - [ ] `Auto` maps to Claude `auto` mode; any permission requests still sent by the adapter surface in the **Dock**.
   - [ ] `Ask` maps to Claude `default` mode and routes permission requests to the user **Dock**.
7. **Reopen, summary, compaction & `usage_update`**
   - [ ] `session/resume` / `session/load` restoration succeeds across app restart (or falls back to `memoryLost` gate when unavailable).
   - [ ] Isolated tool-free summary check (`supportsIsolatedSummary`) produces a handoff draft without invoking tools, or falls back to deterministic Transcript extract on failure.
   - [ ] Compaction capability (`supportsCompaction`) matches live adapter support.
   - [ ] Captured `usage_update` (`used`, `size`) payloads map accurately to **Context usage** (`reported` / `countOnly` / `historical`), distinct from cumulative billing `Usage`.

## Captured Artifacts / Limitations

- `initialize` `agentInfo` & `agentCapabilities`: _paste sanitized JSON_
- `usage_update` sample payload: _paste sanitized JSON_
- Observed limitations / quirks: _none recorded yet_

## Rich chat and Composer

See [rich-chat-composer.md](./rich-chat-composer.md). Automated acceptance passed with the fake ACP Agent; live
Claude Skill/Command advertisement and structured image output remain **unproven** for this feature.
