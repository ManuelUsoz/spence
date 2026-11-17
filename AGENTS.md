# Project rules

Electron desktop app: Angular renderer, Effect 4.1.3 for domain logic, Spartan UI (helm) for components.
`npm run lint` enforces the mechanical rules below; `npm run verify` is the gate; reviewers apply `CODING_STANDARDS.md`.

## Dependency boundaries (enforced by lint)

| Zone                   | May import                                                                    | Must not import                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared`           | `effect`, other `src/shared`                                                  | Electron, Angular, Node, rxjs, `electron/`, `src/app`                                                                                                    |
| `electron/`            | `src/shared`, Electron, Node                                                  | Angular, Spartan, `@ui/*`, `src/app`                                                                                                                     |
| `src/app/core`         | `src/shared`, Angular, `effect`, `effect/rpc`                                 | Electron, Node, Spartan, CDK                                                                                                                             |
| `src/app/features/<f>` | `@ui/*`, `src/shared/<domain>`, core services (`DesktopApi`, `EffectRuntime`) | Electron, Node, `@spartan-ng/*`, `@angular/cdk`, `@ui/*/src/*`, `effect/rpc`, `shared/rpc/*`, `core/desktop-port`, `core/desktop-layers`, other features |
| `src/app/ui`           | Spartan, CDK, Angular                                                         | features, core, `src/shared`, `effect`                                                                                                                   |

## Dependency injection between renderer and main

- The renderer reaches the desktop shell only through the `DesktopApi` service (`src/app/core/desktop-api.ts`).
  It never touches `window.desktop`, `ipcRenderer`, `electron`, a `MessagePort` or an `RpcClient`.
- Only `src/app/core/desktop-port.ts` reads `window.desktop`; only `src/app/core/desktop-layers.ts` builds the client.
- Features run effects with `EffectRuntime.run`; tests provide `makeDesktopTestLayer(handlers)` instead of mocking modules.
- Domain services return effects and never inject `EffectRuntime`.

## UI components

- Components come from Spartan helm, generated into `src/app/ui` and imported as `@ui/<component>`.
  Features never import `@spartan-ng/*` or `@angular/cdk` directly; if something is missing, generate it
  (`npx ng g @spartan-ng/cli:ui <name> --defaults --no-interactive`) or wrap it in `src/app/ui`.
- `src/app/ui` is presentational: inputs and outputs only, no services, no Effect.
- Do not hand-edit generated helm files beyond theming; regenerate with `--force` instead.
- Style with Tailwind utilities and the theme variables in `src/styles.css` (`bg-background`, `text-muted-foreground`, ...),
  no hard-coded colors.

## Typography

Two families, one job each, plus a voice made from the sans. Use them only through the tokens in `src/styles.css`:
the Tailwind utilities `font-sans`, `font-mono` and `font-display`, or `var(--font-sans)` / `var(--font-mono)`.
Never name a family anywhere else.

- **Goeist** (`font-sans`, the default) sets everything people read or click: Messages, the Composer, the
  sidebar, Tabs, menus, buttons, dialogs, Settings, toasts. If in doubt, it is Goeist. Use `tabular-nums`
  for numbers that tick (elapsed time, counts, `+a −d`).
- **Goeist Mono** (`font-mono`) sets what the machine reads or the user would copy: code blocks and inline code
  (`hlmCode`), diffs, file paths and names, commands, the Ticker's target, stderr and log tails, keyboard hints
  (`kbd`), and ids. Never use it for prose or labels. Inside a sans line, use it one size smaller (`text-xs` next to
  `text-sm`) so both look the same height. Keep it at regular weight: never bold it. Ligatures are off in the token so
  `=>` stays two characters; do not turn them back on.
- **The voice** (`font-display`) is Goeist itself, set quiet: regular weight, letter-spacing −0.03em (both
  in the utility). Titles go lighter and tighter, never bolder. Use it rarely: one heading per screen at most, and
  only on quiet screens (empty states like "No Sessions in ‹name› yet.", the first-run or no-Project screen, the
  Settings dialog title). Only at `text-xl` (20px) or larger, sentence case, never uppercase; add no weight or
  tracking of your own, except `font-normal` to beat a helm's default weight. Never in the thread, the Composer,
  the sidebar list, Tabs, buttons, or anything that updates while a Turn runs.
- Never mix families inside one word or one control. The Agent's own text is Goeist; any code inside it is
  Goeist Mono.
- Spartan `typography` (`@ui/typography`) keeps its defaults, except that headings that follow the voice rule get
  `font-display` in the feature, never in the helm file.

## TypeScript

- `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` are on. No `any`, no non-null `!`,
  no unexplained `@ts-expect-error`, no floating promises, exhaustive `switch`, `===` only, `import type` for types.
- No `console.log` (`warn` / `error` only). Fix the cause of a lint error; do not disable the rule.
  An `eslint-disable` needs a `-- reason` and an unused one is an error.

## Electron security and process model

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`; strict CSP in `src/index.html`
  (no inline scripts). Leave these as they are.
- The renderer is untrusted, main is privileged: keep main thin and auditable (privileged APIs, windows, lifecycle).
- Preload exposes only the constant-size `desktop.connect()` handshake through `contextBridge`; `electron/ipc/` holds only that handshake.
- All renderer to main calls go through the `DesktopRpcs` RpcGroup (`src/shared/rpc/desktop-rpcs.ts`) over a `MessagePort`,
  a fresh port per renderer load. Domain handlers live in `electron/rpc/<domain>.ts`; contracts in `src/shared`.
- Only structured-cloneable data crosses IPC: schemas, tagged errors with serializable fields. No effects, streams,
  runtimes, class instances or JS `cause`.
- Open external links with `shell.openExternal`; block navigation away from the app origin; load no remote content
  into a window with preload access.
- Move heavy work off the main thread (utility process, worker, or renderer).

## Effect mental model

`Effect<Success, Error, Requirements>` describes a program. Services are tags in `Requirements`, `Layer`s provide them,
a runtime executes the program at the edge.

- Domain code returns effects. The edges run them: Angular via `EffectRuntime` (`src/app/core/effect-runtime.ts`),
  main via `MainRuntime` (`electron/rpc/runtime.ts`), tests via `it.effect`.
- App-lifetime services (RPC server, watchers, subscriptions) live in a `ManagedRuntime`; a bare `Effect.runPromise`
  closes the scope and kills them.
- Imports come from `effect`, `effect/rpc`, `effect/reactivity`; `FileSystem` / `Path` come from `effect`.
  Keep exactly one `effect` version in the tree.

## Effect 4 idioms

Examples from other repos are often v3 or v4-beta; lint flags the renamed APIs. Beyond those:

- Service: `class X extends Context.Service<X, Shape>()("domain/X") {}`; consumers `yield* X` or `X.use(...)`.
- Layers: `Layer.effect(Tag, effect)` / `Layer.succeed(Tag, value)`; name them `layerX`, test doubles `makeXTestLayer` / `layerXTest`.
- Errors: `Schema.TaggedError` with `reason: Schema.Literals([...])` (PascalCase) and `detail: Schema.String`;
  match with `Effect.catchTag` / `Effect.catchTags`.
- Functions: `Effect.fn("Domain.method")(function* ...)` when a span helps, `Effect.fnUntraced` otherwise.
- Inside generators `yield*` services and effects directly; outside, call `.asEffect()` before piping.
- Brand entity IDs with `Schema.brand` in the owning module; build them with `.make` / `makeUnsafe`, never `as`.
- The RPC client is keyed by the full tag: `api['Domain.method'](...)`.
