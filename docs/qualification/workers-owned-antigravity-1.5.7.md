# Spence-owned Worker qualification: Antigravity ACP 1.5.7

On 2026-11-16, Windows x64, integration baseline `c40a6f7`, the opt-in Session service probe passed with the installed `agy` 1.5.7 and an existing authenticated account. No credentials or provider transcript are recorded here.

The probe runs Spence's real Sessions, Agent lifetime, ACP client, delegation server and Store with a temporary Store and the checkout as Project. The parent was instructed to use the Spence delegate MCP tool once, rather than native subagents. Exactly one persisted child had the parent relationship and `owned` kind. Its transcript contained a generated eight-digit result which also appeared in the parent's reply. A subsequent prompt through Sessions to that same child produced the follow-up marker. The owned child demonstrates use of the registered delegation tool; the probe does not independently capture the MCP discovery exchange. This is a separate ACP Session managed by Spence, not a writable native Antigravity child; see [the native Worker limitation](workers-antigravity-1.5.7.md). Cancellation, restart, nesting, permissions and other configurations remain unqualified.

To repeat on Windows with an existing authorized login, run from the repository root:

```powershell
$env:SPENCE_ANTIGRAVITY_ACP_BIN = "$env:LOCALAPPDATA\agy\bin"
npx vitest run electron/sessions/sessions.spec.ts -t 'discovers delegation'
```

The variable must name the absolute directory containing `agy.exe`. It is supplied to the probe's Merged PATH; this does not establish that a normal Spence launch finds an installation outside its Merged PATH. The probe makes real provider requests and is excluded from ordinary CI. Model behavior and service availability can make it nondeterministic.
