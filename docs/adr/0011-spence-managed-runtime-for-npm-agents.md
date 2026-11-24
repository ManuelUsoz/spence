# 0011. Spence-managed Node runtime and isolated adapters for npm Agents

Status: accepted

Packaged ACP **Agents** (`claude-agent-acp`, `codex-acp`) previously relied on `npm install -g` against the user's **Merged PATH** (#13, #31). On machines without Node/`npm` on the login-shell `PATH` or with multiple Node versions (`nvm`, `fnm`, `asdf`, `mise`), adapters installed under a non-default Node version are invisible to `$SHELL -ilc`, `npm install -g` fails or installs into the wrong global prefix, and `#!/usr/bin/env node` executes against whatever `node` sits on `Merged PATH`.

We provision an isolated, Spence-managed portable Node LTS runtime under `<userData>/spence/runtime/` (downloaded on demand and verified via official SHA-256 checksums, shared across packaged **Agents**) and install each `npm`-kind **Catalog** adapter into its own prefix under `<userData>/spence/agents/<agentId>/` pinned to its qualified version. Packaged `npm` Agents resolve and launch exclusively from this managed environment—ignoring global `Merged PATH` installations—while stripping inherited `NPM_CONFIG_PREFIX` during installation and Linux AppImage runtime variables on child spawn, and preserving the user's **Merged PATH** for Session tools and terminals. **Native** Agents (such as `agy`) remain on **Merged PATH** (with cache-invalidating **Re-scan** and an optional per-Agent binary path override in **Settings**), as does the E2E test Agent shim (`SPENCE_E2E=1`).

## Considered Options

- **Scan version-manager directories on `Merged PATH` and pair each binary with its sibling `node`**: Fragile across managers (`nvm`, `fnm`, `mise`, `volta`, `asdf`), still fails on machines without Node/npm, and cannot guarantee the qualified adapter version.
- **Use Electron's embedded Node (`ELECTRON_RUN_AS_NODE=1`) without downloading Node**: Electron does not ship `npm` CLI, and native/ABI mismatches or lifecycle scripts break without a standard Node + npm toolchain.

## Consequences

- Supersedes the global `npm install -g`, no-version-pinning, and no-update-offers policy from #13/#31 (and amends `ADR 0002`'s `Merged PATH` discovery for packaged `npm` adapters).
- One-click **Set up** and **Update** work identically on **Local** and paired **Remote devices** without requiring Node.js or `npm` on the user's system.
- Users who previously installed `claude-agent-acp` or `codex-acp` globally via `npm install -g` will run Spence's one-click **Set up** once so Spence owns a deterministic, version-qualified copy.
