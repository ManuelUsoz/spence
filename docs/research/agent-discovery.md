# Research: finding and launching known ACP Agents on PATH

Ticket: #3 (map #1). Researched 2026-11-11 on Windows 11, Node 24.22, Electron 45.3.0 (embeds Node 24.22.2).
Question: how is each catalog Agent launched in ACP mode, how does Spence find it on PATH (Windows shims, PATHEXT,
GUI vs terminal PATH; macOS/Linux GUI PATH), and how does Electron main spawn it safely.

## 1. How each Agent is launched in ACP mode

| Agent | Speaks ACP natively? | Command on PATH | Args | Package / install |
| --- | --- | --- | --- | --- |
| Claude Code | No (CLI has no ACP subcommand) | `claude-agent-acp` | none | npm `@agentclientprotocol/claude-agent-acp` (bin `claude-agent-acp`), or standalone release archive |
| Codex | No | `codex-acp` | none | npm `@agentclientprotocol/codex-acp` (bin `codex-acp`) |
| Gemini CLI | Yes | `gemini` | `--acp` | npm `@google/gemini-cli` (bin `gemini`) |
| Qwen Code | Yes | `qwen` | `--acp` (registry adds `--experimental-skills`) | npm `@qwen-code/qwen-code` |
| GitHub Copilot CLI | Yes | `copilot` | `--acp` | npm `@github/copilot` |
| OpenCode | Yes | `opencode` | `acp` | native binary |
| goose | Yes | `goose` | `acp` | native binary |
| Cursor | Yes | `cursor-agent` | `acp` | binary archive; on Windows the entry point is `cursor-agent.cmd` |

Facts behind the table:

- **Claude Code needs an adapter.** The ACP agents list names "Claude Agent (via Zed's SDK adapter)" pointing at
  `claude-agent-acp` ([agentclientprotocol.com/overview/agents](https://agentclientprotocol.com/overview/agents)).
  `claude --help` on this machine (Claude Code 2.1.322) lists no ACP command.
- **The Claude adapter was renamed twice.** `npm view` (2026-11-11):
  `@zed-industries/claude-code-acp` (bin `claude-code-acp`, last 0.16.2) and `@zed-industries/claude-agent-acp`
  (last 0.23.1) are both deprecated: "renamed to @agentclientprotocol/claude-agent-acp". Current:
  `@agentclientprotocol/claude-agent-acp@0.106.0`, bin `claude-agent-acp`, `engines.node >=22`.
  The catalog should probe `claude-agent-acp` first and may fall back to the legacy `claude-code-acp`.
- **The Claude adapter brings its own Claude CLI.** It depends on `@anthropic-ai/claude-agent-sdk`, which ships
  per-platform optional packages (`...-win32-x64`, `...-darwin-arm64`, ...). Its standalone archives "need no Node.js
  install" and contain "`claude-agent-acp`, and the Claude CLI (`claude`) it runs"; "To use a Claude CLI you already
  have instead, set `CLAUDE_CODE_EXECUTABLE`" ([agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)).
  So `claude` on PATH does not mean Claude is usable over ACP; `claude-agent-acp` on PATH does.
- **Codex needs an adapter, which bundles Codex.** `@zed-industries/codex-acp` is deprecated ("replaced by
  @agentclientprotocol/codex-acp"); the zed repo is archived. Current `@agentclientprotocol/codex-acp@2.6.0`, bin
  `codex-acp`, depends on `@openai/codex` and `cross-spawn`. README: "The npm package includes a compatible
  `@openai/codex` dependency"; it "starts the Codex App Server"; `CODEX_PATH` runs a different Codex binary; auth via
  `CODEX_API_KEY` / `OPENAI_API_KEY` or ChatGPT login ([agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)).
- **Gemini CLI: `gemini --acp`.** "To start Gemini CLI in ACP mode, use the `--acp` flag"
  ([geminicli.com/docs/cli/acp-mode](https://geminicli.com/docs/cli/acp-mode/)). Older docs/integrations use
  `--experimental-acp`. The same page notes Gemini CLI "was replaced by Antigravity CLI on June 18th, 2026" for unpaid
  and Google One users: worth confirming Gemini still belongs in the default catalog.
- **The official ACP Registry already encodes all of this.** `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
  (fetched 2026-11-11, 45 agents) has per-agent `distribution` of type `npx` (`package`, `args`), `binary`
  (per-platform archive + `cmd` + `args`) or `uvx`. Entries: `claude-acp` -> npx `@agentclientprotocol/claude-agent-acp@0.106.0`
  or binary `./claude-agent-acp.exe`; `codex-acp` -> npx `@agentclientprotocol/codex-acp@2.6.0`; `gemini` -> npx
  `@google/gemini-cli@0.68.0` args `["--acp"]`; `github-copilot-cli` -> `@github/copilot` `["--acp"]`; `opencode` ->
  `./opencode.exe acp`; `goose` -> `goose.exe acp`; `cursor` -> `cursor-agent.cmd acp` on Windows. RFC:
  [agentclientprotocol.com/rfds/acp-agent-registry](https://agentclientprotocol.com/rfds/acp-agent-registry).
  The map's decision is a built-in catalog of commands found on PATH; the registry is a good source to derive the
  catalog's names/args from, and a possible later "install" feature, but launching through `npx` means network
  access and download latency at Session start.

## 2. What is on PATH on Windows, and in what shape

Observed on this machine (read-only, `where.exe`):

- `claude` -> `C:\Users\<u>\.local\bin\claude.exe` (native installer, a real `.exe`).
- `opencode`, `node`, `npx` -> `.exe` files in a Node version manager's `.nodejs` folder (this manager writes `.exe`
  launchers; its install dir also holds the classic npm `opencode.cmd` / `opencode.ps1` / `opencode` (sh) trio).
- `claude-agent-acp`, `codex-acp`, `gemini`, `codex`, `qwen`, `goose` are not installed here.
- `PATHEXT=.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL`.

Shapes Spence must handle on Windows:

- **npm global installs are `.cmd` shims** (plus `.ps1` and an extensionless sh script). npm's `cmd-shim` writes a
  batch file whose last line runs `"%_prog%" <args> "%dp0%\<target>" %*`, where `_prog` is `%dp0%\node.exe` if it
  exists, else `node` ([npm/cmd-shim lib/index.js](https://github.com/npm/cmd-shim/blob/main/lib/index.js)). Every
  npm-installed Agent (`claude-agent-acp`, `codex-acp`, `gemini`, `qwen`, `copilot`) is therefore a `.cmd` on Windows
  unless the user's Node manager rewrites shims as `.exe` (as on this machine).
- **Native installers give `.exe`** (`claude.exe`, `opencode.exe`, `goose.exe`). The standalone
  `claude-agent-acp.exe` archive is the only `.exe` route for the Claude adapter.

## 3. Node's spawn on Windows: the rules that bite

- **Node ignores PATHEXT and only tries `.com` and `.exe`.** libuv's `search_path`: it follows cmd.exe semantics
  "with this exception that PATHEXT environment variable isn't used. Since CreateProcess can start only .com and .exe
  files, only those extensions are tried" ([libuv src/win/process.c](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c)).
  cross-spawn's README lists the same: Node "ignores PATHEXT" ([moxystudio/node-cross-spawn](https://github.com/moxystudio/node-cross-spawn)).
- **Spawning a `.cmd`/`.bat` without a shell throws `EINVAL` (CVE-2024-27980, "BatBadBut").** Node advisory,
  2024-04-10: "Node.js will now error with `EINVAL` if a `.bat` or `.cmd` file is passed to `child_process.spawn` and
  `child_process.spawnSync` without the `shell` option set" ([nodejs.org april-2024-security-releases-2](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2)).
  Root cause: `CreateProcess` silently runs batch files through `cmd.exe`, whose parsing differs from the runtime's
  argument escaping, so arguments can inject commands; mitigations: "always specify the file extension of the
  command", avoid batch files, or escape manually ([Flatt Security, BatBadBut](https://flatt.tech/research/posts/batbadbut-you-cant-securely-execute-commands-on-windows/)).
- **`shell: true` with an `args` array is deprecated at runtime in Node 24 (DEP0190).** "the values are not escaped,
  only space-separated, which can lead to shell injection" ([Node deprecations DEP0190](https://nodejs.org/api/deprecations.html#dep0190-passing-args-to-nodechild_process-execfilespawn-with-shell-option)).
  Electron 45 embeds Node 24.22.2 (checked with `ELECTRON_RUN_AS_NODE=1 electron -p process.versions`), so this warns.
- **The documented way to run a `.cmd`**: "spawning `cmd.exe` and passing the `.bat` or `.cmd` file as an argument
  (which is what `child_process.exec()` does internally)"; "if the script filename contains spaces, it needs to be
  quoted" ([Node child_process](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)).
  `windowsVerbatimArguments` disables Node's quoting; `windowsHide` hides the console window a GUI parent would
  otherwise pop up.
- **PATH lookup uses `options.env.PATH` if `env` is given**, else `process.env.PATH`; Windows env keys are
  case-insensitive and Node passes only the first lexicographic match, so `PATH` and `Path` in one object conflict
  (same page).

Verified locally with Node 24.22 (script in scratch, not committed):

```
spawn("fakeagent")                       -> ENOENT   (fakeagent.cmd on PATH: PATHEXT ignored)
spawn("<dir>\\fakeagent.cmd")            -> EINVAL   (CVE-2024-27980)
spawn("cmd.exe", ["/d","/s","/c","\"<dir>\\fakeagent.cmd --acp\""], {windowsVerbatimArguments:true}) -> runs, args intact
spawn("claude", ["--version"])           -> runs     (claude.exe)
```

## 4. Why the PATH differs between terminal, Start menu and dev mode

- **Windows.** A process inherits its parent's environment block ([Microsoft Learn: Environment Variables](https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables)).
  A Start-menu launch inherits Explorer's environment, built from `HKCU\Environment` and
  `HKLM\System\CurrentControlSet\Control\Session Manager\Environment`; installers that edit those keys broadcast
  `WM_SETTINGCHANGE` "Environment" so the shell picks it up (same page). Consequences:
  - A terminal opened before an install has a stale PATH; Explorer usually has the new one.
  - Anything added only by a shell profile (PowerShell `$PROFILE`, e.g. `fnm env`, conda activate) is invisible to
    Spence when launched from the Start menu.
  - `npm run dev` inherits the developer's terminal PATH, which hides both problems during development.
  - A long-running Spence never sees PATH changes made after it started. Re-reading the two registry keys (expanding
    `REG_EXPAND_SZ` values like `%USERPROFILE%`) when the Agent list is refreshed fixes that.
- **macOS/Linux.** "GUI apps on macOS doesn't inherit the environment variables defined in your dotfiles"; Finder/Dock
  launches get a minimal PATH (`/usr/bin:...`), so Homebrew, nvm, `~/.local/bin` are missing
  ([sindresorhus/shell-env](https://github.com/sindresorhus/shell-env), [sindresorhus/fix-path](https://github.com/sindresorhus/fix-path)).
  - `shell-env` runs the user's `$SHELL` with `-ilc` (interactive login) and `command env` between delimiters, parses
    the output, sets `ZSH_TMUX_AUTOSTART=false` and disables oh-my-zsh auto-update; on `win32` it just returns
    `process.env`; it sets no timeout ([shell-env index.js](https://github.com/sindresorhus/shell-env/blob/main/index.js)).
  - `fix-path` applies that PATH to `process.env.PATH`; its README warns packaged apps launched from Finder may not
    quit properly because of child processes spawned at startup.
  - VS Code does the same ("resolve" the shell environment by running your profile files) with a timeout
    (`application.shellEnvironmentResolutionTimeout`, default 10 s) and falls back to launching without it
    ([VS Code FAQ](https://code.visualstudio.com/docs/supporting/faq)). A timeout is mandatory: a slow or interactive
    profile must not block discovery.

## 5. Implications for Spence (proposal, not decided)

1. **Catalog entries carry candidate commands, not one.** e.g. Claude: `claude-agent-acp` then `claude-code-acp`;
   Codex: `codex-acp`; Gemini: `gemini --acp`. Args are compile-time constants matching `^[A-Za-z0-9._=-]+$`, never
   user input; the Project folder goes in `cwd` and in ACP `session/new`, never on the command line.
2. **Spence resolves the executable itself**, instead of relying on spawn's lookup: compute the effective PATH,
   walk its directories, try the bare name then `.exe`, `.cmd`, `.bat` (Windows; ignore `.ps1`, `.js`, `.vbs` even if in
   PATHEXT), return an absolute path. This gives the UI an exact "found at" path and lets discovery be tested with a
   fake filesystem. `where.exe`/`which` are an alternative but cost a process each.
3. **Effective PATH**: Windows = `process.env.PATH` merged with freshly read user + machine registry PATH (dedupe,
   keep order). macOS/Linux = login-shell PATH resolved once at startup with a timeout (shell-env style, ESM, or ~30
   lines of our own), falling back to `process.env.PATH`. Pass it explicitly as `env.PATH` to the spawned Agent, so the
   Agent's own children (e.g. `codex-acp` launching Codex, Claude launching `git`) see the same PATH.
4. **Spawn by resolved type, never `shell: true` with args:**
   - `.exe` / POSIX executable: `spawn(absPath, args, { cwd, env, stdio: 'pipe', windowsHide: true })`.
   - `.cmd` / `.bat`: `spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', '"' + quoted command line + '"'],
     { windowsVerbatimArguments: true, windowsHide: true, ... })`, allowed only because args are validated constants
     (no `% ^ & | < > " ( ) !` or newlines). `/d` skips AutoRun registry commands.
   - Optional refinement: parse an npm `cmd-shim` `.cmd` to its `node <script.js>` target and spawn `node.exe`
     directly, avoiding cmd.exe entirely (and the extra process in the tree when killing). Fall back to cmd.exe when the
     shim is not recognised.
   - Killing: with the cmd.exe route the Agent is a grandchild; `child.kill()` only kills cmd.exe. Use `taskkill /T /F
     /PID` (or closing stdin and letting the Agent exit) on Windows.
5. **Do not run Agents with Electron's own Node** (`ELECTRON_RUN_AS_NODE` / `utilityProcess.fork`): adapters require
   Node >= 22 with their own native optional deps, and the user's installed `node` is what the shim targets.
6. **Spawning happens in `electron/` only** (process model rules), off the window lifecycle; discovery results cross
   to the renderer as plain schema data (name, found path, version if probed).
7. **Open items for the spec tickets**: whether Gemini stays in the default catalog (Antigravity replacement);
   whether to offer `npx`-based launch from the ACP Registry as a later "Connect another"/install path; whether to
   probe versions (`--version`) at discovery time or lazily; how often to refresh discovery.

## Sources

- ACP agents list: https://agentclientprotocol.com/overview/agents
- ACP Registry RFC: https://agentclientprotocol.com/rfds/acp-agent-registry ; data: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- claude-agent-acp: https://github.com/agentclientprotocol/claude-agent-acp ; npm `@agentclientprotocol/claude-agent-acp`
- codex-acp: https://github.com/agentclientprotocol/codex-acp ; archived https://github.com/zed-industries/codex-acp
- Gemini CLI ACP mode: https://geminicli.com/docs/cli/acp-mode/
- npm registry metadata via `npm view <pkg> bin deprecated dependencies optionalDependencies` (2026-11-11)
- Node child_process: https://nodejs.org/api/child_process.html
- Node DEP0190: https://nodejs.org/api/deprecations.html#dep0190-passing-args-to-nodechild_process-execfilespawn-with-shell-option
- Node CVE-2024-27980 advisory: https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2
- BatBadBut write-up: https://flatt.tech/research/posts/batbadbut-you-cant-securely-execute-commands-on-windows/
- libuv Windows search_path: https://github.com/libuv/libuv/blob/v1.x/src/win/process.c
- npm cmd-shim: https://github.com/npm/cmd-shim/blob/main/lib/index.js
- cross-spawn: https://github.com/moxystudio/node-cross-spawn
- Microsoft Learn, Environment Variables: https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables
- shell-env: https://github.com/sindresorhus/shell-env ; fix-path: https://github.com/sindresorhus/fix-path
- VS Code FAQ (resolving shell environment): https://code.visualstudio.com/docs/supporting/faq
