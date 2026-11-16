# Spec: rich chat and Composer

Status: planning complete; ready for implementation. Source: [Wayfinder: rich content in the chat and Composer](https://github.com/ManuelUsoz/spence/issues/133).

This is a delta to [calm session view v1](./calm-session-view-v1.md), alongside
[context management and handoffs](./context-management-and-handoffs.md). Existing behavior carries forward unless
explicitly replaced here. This document specifies roadmap items 8, 9 and 10; it does not claim they are implemented.
Domain terms follow [the glossary](../../GLOSSARY.md); dependency and process rules follow `AGENTS.md` and the ADRs.

## 1. Scope and presentation

Only the thread and Composer change. Preserve the calm session view, existing attachment picker, strip, lightbox,
handoff transfer and Agent lifecycle behavior. Use thread prototype A (continuous prose) and Composer prototype B
(grouped by owner). Avoid added section cards, dividers or columns around ordinary Agent prose.

Use Spartan Helm components wherever applicable: Code Block for fenced code and copy controls, typography for
prose and inline code, table, Command groups/items, textarea/input, badges, buttons and keyboard hints. Generate
missing components into `src/app/ui`; features import `@ui/*`. Keep wrappers presentational and respect the rules
for generated Helm. The standalone prototypes establish layout, not production component code.

Use theme variables and existing typography tokens: sans for prose and controls, normal-weight mono for code,
paths, IDs and keyboard hints, one size smaller when embedded in a sans line. Never use display typography in
the thread. App labels are localized; Agent output never passes through i18n.

## 2. Agent Markdown

Decision: [Decide the Markdown rendering architecture and supported subset](https://github.com/ManuelUsoz/spence/issues/136).

- Parse with `remark-parse` and `remark-gfm` into a typed tree; render through static Angular components/templates.
  Do not dynamically compile Agent text or use a sanitized `innerHTML` pipeline.
- Support headings, emphasis, strikethrough, ordered/unordered lists, tables, links, blockquotes, inline code,
  fenced code with language hints and read-only task lists. Preserve nesting and standard parser semantics.
- Show raw inline and block HTML literally, including tags and contents. Do not execute it or silently discard it.
  HTML inside fences remains code. Preserve canonical accumulated Message text independently of rendered nodes.
- Markdown images initially show alt text without fetching their targets. They are distinct from structured image parts.
- Render while streaming. Batch visual updates and parse accumulated active-message text, never concatenate independently
  parsed deltas. Finalize with a whole-message parse on settle; cache settled results. Syntax may change as delimiters
  arrive. Reconcile nodes to preserve selection, scroll position and code controls.
- Show a language label and Copy button on code blocks. Copy the code content exactly, without fences or labels.
  Treat the fence language as a hint; absent/unknown hints use plain text. Defer syntax highlighting.
- Only absolute HTTPS destinations are clickable. Open through `shell.openExternal`, never navigate the app.
  Reject credentials-bearing URLs. Relative paths, fragments and all other schemes remain text. Validate destinations
  again in main; renderer intents use DesktopApi when RPC is needed. Cover keyboard, modifier/middle click and
  new-window paths. Preserve strict CSP and exact app-origin/navigation restrictions.
- Keep parsing in the renderer, using a worker if profiling requires it; heavy parsing never belongs in Electron main.

Presentation evidence: [Prototype the chat Markdown renderer](https://github.com/ManuelUsoz/spence/issues/140).
The captured mockup uses prepared blocks; real parser security, streaming and performance remain acceptance work.

## 3. Image deltas

Decision: [Decide image-support deltas beyond v1](https://github.com/ManuelUsoz/spence/issues/137).

### Composer input

Accept clipboard images while the Composer has focus and image files dropped from the OS onto the Composer.
Show a drop target. Both routes add to the existing strip, never auto-send, and preserve ordinary text paste.
Picker, paste and drop share PNG/JPEG/GIF/WebP validation, Agent `canAttach`, size, dimensions and count gates.
Existing input limits remain authoritative. Reject rather than resize. In mixed batches, attach accepted images
and explain refusals. Preserve attachment order and existing handoff behavior.

### Agent output

Display structured Agent image payloads using thumbnails and the existing lightbox. Never fetch arbitrary URLs
or read local paths from Agent text. Unsupported, malformed, oversized and excess images show placeholders.
Use independent app display limits rather than Agent input limits:

| Limit | Initial policy |
| --- | --- |
| Binary payload after base64 decoding | 10 MiB per image (10 × 1,024 × 1,024 bytes) |
| Maximum side | 8,192 pixels |
| Maximum area | 32 megapixels (32,000,000 pixels) |
| Displayed images | 20 per Message |

All limits apply together. Validate size, type and dimensions before rendering. Full-size pixel decoding happens
only when opening the lightbox; thumbnails must not eagerly decode all full-size sources. Bound concurrent work
and release temporary resources. These are initial policy values, subject to real memory validation; a necessary
policy change must be recorded explicitly rather than silently changing the limits.

## 4. Skills and Commands

Decision: [Define Skill in Spence's vocabulary and its Composer surfacing](https://github.com/ManuelUsoz/spence/issues/138).

A Skill is a named instruction pack an Agent can apply automatically or through explicit invocation. A Command
is an explicit Composer action owned by Spence or the Agent's vendor; invoking a Skill may be such an action.
Invocation for a Message does not enable a Skill for the Session.

- Use one `/` palette, grouped by owner (prototype B). Show explicit Spence or actual Agent/vendor ownership for
  every entry, independently of Skill/Command type. Do not imply that a vendor action belongs to the app.
- Show Agent-advertised entries. Classify as Skill only with reliable integration evidence; otherwise retain Command.
  Do not scan folders or infer a universal kind from name prefixes. Unlisted does not mean unavailable to the Agent.
- Search names and descriptions. Show supplied argument hints as helper text, never insert literal placeholder words.
- Selection inserts the exact integration invocation and trailing space for editing; it never sends automatically.
  Send uses ordinary Message text for Agent entries. Preserve app handling for Spence commands.
- Reserve `/clear` and `/compact` for Spence. On a collision, show only the explicitly Spence-owned entry. Preserve
  existing availability rules. Other matching display names retain separate identities and owner attribution.
- Preserve arrows, Tab insertion and Esc dismissal. Keep focus and accessible selection coherent with the Composer.
- Replace the catalog when the Agent reports updates, preserving the draft. Distinguish discovery loading,
  known-empty and populated states; show a quiet empty/no-match state.
- No Skill enable/disable controls in this effort.

Evidence: [Research how ACP Agents expose skills and commands](https://github.com/ManuelUsoz/spence/issues/135)
and [Prototype skills and commands in the Composer](https://github.com/ManuelUsoz/spence/issues/139).
Claude/Codex adapter evidence does not establish universal ACP metadata. Antigravity's exact payload and Codex
skill invocation routing require live qualification; never manufacture metadata or promise unverified support.

## 5. Contracts and boundaries

Keep Markdown a rendering interpretation of text, not a new transport HTML part. Structured image parts retain
their existing meaning and storage. Keep ACP and adapter-specific interpretation in main/domain mappers.

Extend the Composer entry contract to separate stable identity, display name, exact invocation, owner and kind,
with optional descriptions/hints and explicit discovery state. Preserve reliable classification evidence at the
mapping boundary; absent metadata falls back to Command. Extension paths are not permission to read files.
All IPC data must remain schema-validated and structured-cloneable. Features use DesktopApi and EffectRuntime;
UI wrappers have inputs/outputs only. No renderer filesystem or raw ACP access.

## 6. Acceptance

Both tiers are required for shipping. Prototype approval settles presentation only. Pending execution of acceptance
checks is implementation work, not evidence that they have already passed.

### Tier 1: automated and app checks

| Area | Required evidence |
| --- | --- |
| Markdown | Supported subset and nesting; literal inline/block HTML including script-like text; malformed/incomplete syntax; final render equals full parse after varied delta chunking |
| Links | HTTPS external routing and privileged revalidation; rejected schemes/credentials; relative/fragment text; keyboard, middle/modifier and new-window activation cannot navigate app |
| Code and typography | Exact copy, unknown language fallback, read-only task status, theme tokens, normal-weight mono and sans roles, no thread display font |
| Images | Picker/paste/drop gate parity; no automatic send/resize; mixed refusals; incapable Agent; boundary values for every output limit; malformed data/placeholders; no URL/path reads |
| Composer | Owner/type distinction, owner grouping, name/description search, hints, exact insertion, no auto-send, reserved collisions, distinct identities, arrows/Tab/Esc, loading/empty/update draft preservation |
| Regression | Existing transcript/storage, reopen, attachment and handoff behavior; English/Spanish labels; keyboard accessibility and focus; dependency boundaries and strict CSP |

Run `npm run verify` for implementation changes. Add meaningful integration/behavior tests, using the repository's
Desktop test layers. Exercise actual production rendering rather than merely asserting mockup markup.

### Tier 2: live qualification and performance

Record exact Agent/adapter/runtime versions, target OS/architecture, capabilities, relevant wire traces and observed
results in the existing qualification notes for Claude, Codex and Antigravity. Each advertised supported path must
pass; unavailable paths are documented as unsupported/unproven, not reported as passing.

- Cover a project Skill, global/plugin Skill where supported, builtin Command, hidden/model-only configuration,
  arguments, resume, mid-session catalog changes and empty-list replacement. Verify real invocation text, especially
  Codex `$name` routing and native Antigravity advertisement. Confirm visible ownership and fallback kind.
- Verify image input capabilities and actual structured Agent image output where supported, including reopening and handoff.
- Exercise real streamed Markdown and final rendering in Electron, clipboard code copy and external link activation.
- Profile long streamed Messages and large supported images. Record workload, hardware, timing and memory evidence;
  verify responsive input, no unexpected scroll jumps, preserved selection and bounded decode work. Confirm full-size
  decoding is deferred to lightbox and temporary resources are released. No performance benchmark is established by
  the prototypes. Resolve measured failures before shipping, recording any policy changes.

## 7. Out of scope

- Implementing/shipping features as part of the planning map; this spec hands off implementation.
- Sidebar, Settings, Ticker, Turn cost/time, source control and all non-thread/Composer surfaces.
- Non-image attachments beyond existing behavior; dragging from an in-app file browser.
- Raw HTML execution or sanitized rendering; syntax highlighting; arbitrary image URL fetching or local-path reads.
- Automatic image resizing, zoom/pan, download and editing controls.
- Skill Session enable/disable controls, folder discovery and universal metadata inference.
- Merging research/prototype branches: preserve their linked immutable artifacts as context only.

## 8. Decision trail

The [wayfinder map](https://github.com/ManuelUsoz/spence/issues/133) indexes the canonical decision tickets.
Its research and prototype resolutions link immutable assets. The final structure and acceptance decision is
[Decide final specification structure and acceptance coverage](https://github.com/ManuelUsoz/spence/issues/141).
This delta reconciles those decisions into the implementation handoff; later deliberate changes must identify
which policy they supersede.
