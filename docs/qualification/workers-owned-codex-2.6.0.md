# Spence-owned Worker qualification: Codex ACP 2.6.0

On 2026-11-16, Windows x64, baseline `31db1eb`, the opt-in Session service probe passed using an existing authenticated Codex account, `@agentclientprotocol/codex-acp@2.6.0` and its bundled `@openai/codex@0.166.0`. No credentials or provider transcript are recorded here.

The probe runs Spence's real Sessions, Agent lifetime, ACP client, delegation server and Store over a temporary Project and Store. It asks the parent to use the Spence delegate tool. Exactly one persisted child had the parent relationship and `owned` kind; the child's transcript contained an invented eight-digit result that also appeared in the parent's reply; and a subsequent prompt through Sessions to that child produced the follow-up marker. Creating that child through this path demonstrates the Agent reached the registered delegation tool; the test does not independently record the MCP discovery exchange. It does not qualify cancellation, restart, nesting, permissions, or other providers. The parent and child use separate ACP Sessions; this is not direct input to a native Codex subagent, whose limitation is documented in [the native Worker record](workers-codex-2.6.0.md).

To repeat with an authenticated account, install the pinned adapter in a temporary directory, then point the probe at its executable directory. It makes real provider requests and is deliberately excluded from ordinary runs. On Windows PowerShell, for example:

```powershell
npm install --prefix <temporary-directory> @agentclientprotocol/codex-acp@2.6.0
$env:SPENCE_CODEX_ACP_BIN = '<temporary-directory>\node_modules\.bin'
npx vitest run electron/sessions/sessions.spec.ts -t 'discovers delegation'
```

The directory must be absolute. The adapter uses the existing login and normal environment; do not place credentials in the command or output. Model behavior and service availability can make this live probe nondeterministic.
