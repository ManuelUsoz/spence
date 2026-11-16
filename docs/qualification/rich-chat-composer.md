# Rich chat and Composer qualification

Status: **automated acceptance complete; live Tier 2 pending.** No live Claude, Codex or Antigravity pass is claimed for
this feature. Unsupported or unproven paths are listed explicitly and must not be reported as passing.

Source: [Implement rich chat and Composer](https://github.com/ManuelUsoz/spence/issues/144) and
[Qualify rich chat and Composer across Agents](https://github.com/ManuelUsoz/spence/issues/150).

## Environment

| Item | Value |
| --- | --- |
| OS | Windows 11 (10.0.26200), x64 |
| CPU | Intel Core i7-10750H, 6 cores / 12 threads @ 2.60 GHz |
| Node.js | 24.22.0 |
| Electron | 45.3.0 |
| Angular | 22.2.x |
| Agent used for automated runs | Spence fake ACP Agent (`electron/acp/fakeAgent.mjs`); no live provider |

## Automated evidence

- `npm run verify` — passed all 8 steps: format, typecheck (electron/app/spec), lint, renderer tests, Electron tests and
  i18n.
- `npm run build` — passed; renderer bundle 1.80 MB raw (budget raised for the Markdown parser, see below).
- Playwright session/shell/projects/i18n/smoke suites — passed (70 tests), including the existing image, reopen and
  handoff flows.
- `e2e/session/rich-markdown.spec.ts` — passed in English and Spanish:
  - streamed a 120-section Markdown reply in real Electron, selected text during the stream, and asserted the same
    selection after settling;
  - asserted the scroll position did not move;
  - copied the first fenced block to the Electron clipboard and asserted the exact content without fences or labels;
  - rendered a structured 1600 × 1200 PNG as a reduced-size `blob:` thumbnail and decoded the full source only on
    lightbox open.

### Measured performance

Recorded from `e2e/session/rich-markdown.spec.ts` annotations on the environment above:

| Scenario | Observation |
| --- | --- |
| Long Markdown stream (120 sections, 160-character chunks, 40 ms cadence) | 8.0–8.7 s to settle; JS heap +20.8 MB; selection and scroll preserved |
| Structured image 1600 × 1200 | Thumbnail is a `blob:` downscale; JS heap ≈ 13.8 MB before, ≈ 11.9 MB after thumbnail (GC), ≈ 19.1 MB with the full-size lightbox open; decoded size reports 1600 × 1200 |

The renderer-only parser is fast enough for this workload; no worker was needed. The observation is a single-machine
sample, not a cross-device benchmark.

## Live Agent matrix

| Path | Status | Evidence |
| --- | --- | --- |
| Claude Skills/Commands advertisement | **Unproven** | No live Claude run in this environment; automated mapper/tests only |
| Codex `$name` invocation routing | **Unproven** | The contract supports an adapter-pinned invocation through `_meta.invocation`; no live Codex run |
| Codex Skill advertisement / classification | **Unproven** | Only explicit `_meta.kind: "skill"` is classified as a Skill; no live payload verified |
| Antigravity native Skill metadata | **Unproven** | No live Antigravity run or native payload captured |
| Claude/Codex/Antigravity structured image output | **Unproven** | Automated PNG path used the fake Agent; no live image output verified |
| Project/global/plugin Skills, hidden/model-only configuration, arguments, resume, mid-session catalog changes | **Unproven** | Not exercised live |

## Policy changes

- Initial renderer bundle budget raised from 800 kB warning / 1.75 MB error to 1.9 MB warning / 2.25 MB error to admit
  `remark-parse`, `remark-gfm` and `unified`. This is a build-budget policy change, not an image-policy change.
- Image display limits remain the specified 10 MiB decoded payload, 8,192 px side, 32,000,000 px area and 20 displayed
  images per Message. No policy change was required by the measurements.
