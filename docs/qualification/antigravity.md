# Live Qualification Record: Antigravity (`agy acp`)

> **Status:** Unqualified — template only. No live-provider run is recorded here, and no runtime certification is claimed. Live qualification runs are performed manually outside automated CI.

## Environment & Versions

| Field | Value |
| --- | --- |
| Target OS / Architecture | Windows x64 (`win32` / `x64`) |
| Catalog Entry | `antigravity` (`agy acp`, `installKind: 'native'`) |
| Baseline Minimum Version | `1.2.0` (`ANTIGRAVITY_QUALIFIED_VERSION`) |
| Observed `agy --version` | _TBD_ |
| Observed `initialize.agentInfo.version` | _TBD_ |
| Observed `initialize.protocolVersion` | _TBD (expected `1`)_ |
| Spence Version / Commit | _TBD_ |
| Qualification Date | _TBD_ |
| Operator | _TBD_ |

## Tier 2 Qualification Matrix

Record `PASS`, `FAIL`, or `LIMITATION` with exact observed behavior and notes for each check in [context-management-and-handoffs.md](../specs/context-management-and-handoffs.md) §4 (Tier 2):

| Check | Expected Behavior | Result | Observed Notes |
| --- | --- | --- | --- |
| Binary discovery (`MergedPath`) | `agy` resolves on Merged PATH without spawning at startup; missing `agy` shows Google install instructions + **Re-scan** (never `npm install -g`) | _TBD_ | |
| Version inspection | `initialize.agentInfo.version` inspected on connect; falls back to `agy --version` cached per `(binaryPath, mtimeMs)` | _TBD_ | |
| Unverified version / incompatibility | `< 1.2.0` with `protocolVersion: 1` runs with **Unverified version** notice; missing `acp` subcommand or `protocolVersion !== 1` surfaces **Can't start** | _TBD_ | |
| External Google login (`-32000`) | `-32000` maps to **Needs login** with Google account login instructions; sign-in restores **Ready** | _TBD_ | |
| `initialize` capabilities | `protocolVersion === 1`; `clientInfo.name === 'spence'`; no `fs`/`terminal` client capabilities claimed | _TBD_ | |
| Text **Turn** & streaming | Prompt streams incremental `MessageDelta` / `ThoughtDelta` / `Step` updates and settles `TurnEnded` | _TBD_ | |
| **Auto** Permission mode | Required **Auto** gate passes; exceptional vendor confirmations surface in **Dock**; `askMode: false` disables **Ask** | _TBD_ | |
| `session/cancel` & **Stop Agent** | `session/cancel` settles within `5 s` or surfaces **Stop Agent**; process `'exit'` observed before switch/Fork/retry | _TBD_ | |
| **Model** eligibility (`spence` client) | Only Models usable by `spence` are exposed; ineligible third-party Models (`claude-*`, `gpt-*`, `o1*`, `o3*`, `o4*`) excluded with visible limitation note, never spoofed or silently substituted | _TBD_ | |
| **Effort** (`session/set_config_option`) | `low \| medium \| high \| max` levels backed by verified `set_config_option` mappings; unmapped levels omitted/disabled | _TBD_ | |
| **Images** attachment limits | `promptCapabilities.image` + `ImageLimits` enforced; unsupported Images blocked pre-send | _TBD_ | |
| `session/resume` / `session/load` | Context restores across reopen when supported; failure/absence preserves **Transcript** and triggers `memoryLost` gate | _TBD_ | |
| Isolated tool-free summary | Verify whether `supportsIsolatedSummary` can run tool-free or remains `false` (Transcript extract fallback) | _TBD_ | |
| Compaction behavior | Verify whether `supportsCompaction` is supported or remains `false` (disabled in picker with explanation) | _TBD_ | |
| `usage_update` signals | Captured `used` / `size` payloads map to reported-only `ContextUsage` without local estimation | _TBD_ | |
