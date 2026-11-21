# Workflow comparison

Recorded on November 21, 2026 with Codex ACP 2.6.0. Each method received the same request and a fresh Worktree with the same staged `solution.json`. The request was to clamp `[-5, 7, 15]` to the inclusive range 0–10. An independent check parsed the result, compared it with `[0, 7, 10]`, and checked for unexpected files. It also required the root Turn to complete successfully.

The single Session, Coordinator, Planner, and Verifiers used `gpt-6.2-sol`. The Coordinator's Worker, Task Breaker, and Implementer used `gpt-6.1-terra`. Wall time starts after the root Agent is ready and the model is selected. It includes workflow preflight and all workflow stages. Other local tests ran during the measurement.

| Method | Reported cost | Wall time | Cumulative tokens | Prompted Sessions | Accepted |
| --- | --- | ---: | ---: | ---: | --- |
| Single Session | Unavailable | 31.46 s | 84,697 | 1 | Yes |
| `/coordinate` | Unavailable | 70.07 s | 247,651 | 3 | Yes |
| `/divide-and-conquer` | Unavailable | 90.08 s | 265,339 | 4 | Yes |

The test sums the final cumulative token counter for each prompted Session when all Sessions report it. It records cost only when every prompted Session reports a currency and amount. One small fixture cannot establish typical speed, cost, or implementation quality.

## Reproduce

With an authenticated Codex ACP installation on Windows, run from the repository root. Omit `SPENCE_BENCH_TASK` to run both the `clamp` and `slug` fixtures. The opt-in run uses provider tokens.

```powershell
$env:SPENCE_CODEX_ACP_BIN = Split-Path -Parent (Get-Command codex-acp.cmd).Source
$env:SPENCE_WORKFLOW_BENCHMARK = '1'
$env:SPENCE_BENCH_TASK = 'clamp'
$env:SPENCE_BENCH_REPORT = Join-Path ([IO.Path]::GetTempPath()) ('spence-workflow-benchmark-' + [guid]::NewGuid().ToString('N') + '.jsonl')
node node_modules/vitest/vitest.mjs run --dir electron electron/sessions/sessions.spec.ts -t 'compares matched Worktrees'
Get-Content -LiteralPath $env:SPENCE_BENCH_REPORT
```
