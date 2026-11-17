# CLAUDE.md

Electron desktop app: Angular renderer, Effect 4.1.3 domain logic, Spartan UI (helm styles) on Tailwind 4.
Mandatory rules live in `AGENTS.md`, mechanical ones are enforced by `npm run lint`, review standards are in
`CODING_STANDARDS.md`. This file is only the map, the loop and the Effect usage; it does not repeat the rules.

## The loop

Work in this loop, never "looks right":

1. Make the change.
2. `npm run verify` (fail fast) or `node scripts/verify.mjs <step...>` for just the steps you need.
3. Read the first `FAIL` block, fix it, go to 2. Lint messages say what to use instead.
4. Done only when `npm run verify` prints `verify: OK`. For UI changes also `npm run e2e`.

`npm run verify -- --all` runs every step despite failures; `--json` writes `.verify/last.json`;
`--list` prints the steps (format, typecheck-electron, typecheck-app, typecheck-spec, lint, test-renderer, test-electron, i18n).
`npm run lint:fix` and `npm run format` fix what is mechanical.

## Structure

```
src/shared/<domain>/<domain>.rpc.ts   RPC contract per domain (Rpc.make + RpcGroup): pure, no Electron/Angular
src/shared/rpc/
  desktop-rpcs.ts                     DesktopRpcs: the single merge point of all groups
  handshake.ts                        RPC_CONNECT_CHANNEL, RPC_PORT_MESSAGE, DesktopBridge
  wire-error.ts                       wire error pattern + toWireDefect
  message-port-protocol.ts            client protocol over a MessagePortAdapter
electron/main.ts                      windows + lifecycle only
electron/preload.ts                   constant size: exposes only desktop.connect()
electron/ipc/handshake.ts             the only ipcMain handler: hands a MessagePort to the renderer
electron/rpc/<domain>.ts              handler layers per domain
electron/rpc/index.ts                 layerDesktopHandlers (merge of all handler layers)
electron/rpc/ipc-server.ts            IpcServerPort, RpcPortHandoff, layerIpcServer
electron/rpc/runtime.ts               MainRuntime (ManagedRuntime) running the RpcServer for the app lifetime
electron/<domain>/                    main-only services per domain
src/app/core/                         DesktopApi, layerDesktop, desktop-port, EffectRuntime (the only place that knows the transport)
src/app/features/<feature>/           one folder per feature; features never import each other
src/app/ui/                           Spartan helm components (generated); the only place that imports Spartan / CDK
```

## Data flow

renderer -> `DesktopApi` (RpcClient) -> MessagePort -> RpcServer in main (`MainRuntime`) -> handler layer.
The renderer gets `DesktopApi` by dependency injection (`EffectRuntime` provides `layerDesktop`); tests swap it
for `makeDesktopTestLayer`. Nothing else may touch `window.desktop`, `ipcRenderer` or `electron`.

## Adding a domain

1. `src/shared/<domain>/<domain>.rpc.ts`: schemas, errors, `RpcGroup`.
2. Merge the group into `DesktopRpcs` (`src/shared/rpc/desktop-rpcs.ts`).
3. `electron/rpc/<domain>.ts`: `layerXHandlers = XRpcs.toLayer({...})`.
4. Merge it in `electron/rpc/index.ts`.
5. Add a `layerXUnused` in `src/app/core/desktop-layers.ts` (handlers that `Effect.die`) and merge it into
   `makeDesktopTestLayer`, so tests of one domain can still build `DesktopRpcs`.
6. Test via `makeDesktopTestLayer` in a spec next to the consumer.

## Adding a feature

Copy `src/app/features/app-info/`: a standalone `OnPush` component, an Effect that `yield* DesktopApi`, run with
`EffectRuntime.run`, the `Exit` written into signals with distinct loading / failed / loaded states.

## Adding a UI component

`npx ng g @spartan-ng/cli:ui <name> --defaults --no-interactive` (config in `components.json`: helm style `mira`,
generated into `src/app/ui`, alias `@ui`). Import it in features as `@ui/<name>`, never from `@spartan-ng/*` or
`@angular/cdk`. `src/app/ui` is in `.prettierignore` because the CLI owns its formatting.

## Effect cheat-sheet

```ts
// contract
export const NotesRpcs = RpcGroup.make(
  Rpc.make('Notes.list', { success: Schema.Array(Note), error: NotesError }),
);
// handlers (main)
export const layerNotesHandlers = NotesRpcs.toLayer({
  'Notes.list': () => Effect.succeed([]),
});
// service
class Notes extends Context.Service<Notes, Shape>()('domain/Notes') {}
const layerNotes = Layer.effect(
  Notes,
  Effect.gen(function* () {
    /* ... */
  }),
);
// error: reason + detail, never `message`, never `cause`
class NotesError extends Schema.TaggedError<NotesError>()('NotesError', {
  reason: Schema.Literals(['NotFound']),
  detail: Schema.String,
}) {}
// functions
const load = Effect.fn('Notes.load')(function* (id: string) {
  /* ... */
});
const quick = Effect.fnUntraced(function* (id: string) {
  /* ... */
});
// non-actionable failure at a service boundary -> defect
effect.pipe(toWireDefect);
// renderer edge: run returns an Exit; write it into signals.
// The client is keyed by the full RPC tag: api['AppInfo.get'](), not api.AppInfo.get().
const exit = await runtime.run(
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    return yield* api['AppInfo.get']();
  }),
);
// tests (@effect/vitest)
it.effect('gets app info', () =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    expect(yield* api['AppInfo.get']()).toEqual(info);
  }).pipe(Effect.provide(makeDesktopTestLayer(handlers))),
);
```

## Notes

- Effect is pinned to an exact version (`effect` and `@effect/vitest`, 4.1.3) with an `overrides` entry: bump both together.
- Serialization is `RpcSerialization.layerSchemaBinary` (`layerPortSerialization` in `message-port-protocol.ts`).
- `ng test` runs the renderer specs (`src/**`); the electron specs (`electron/**/*.spec.ts`) run with `npm run test:electron`.
  Do not use `--include=src/app/core/**`: it treats non-spec files as suites.
- Sandboxed preload cannot pass ports through contextBridge; the port arrives via `window.postMessage(RPC_PORT_MESSAGE)`.
  Check origin on receipt.
- The production build must keep `optimization.styles.inlineCritical: false` (angular.json): the inline `onload` it
  injects is blocked by the CSP and leaves the app unstyled.
- `ng g @spartan-ng/cli:*` prompts interactively unless given `--defaults --no-interactive` and an existing `components.json`.
- No Python on the dev machine: use Node scripts.
- i18n is `@angular/localize`, English source + Spanish (`es`). Mark every UI string (`i18n`, `i18n-<attr>`,
  `$localize`; helm labels through their inputs, e.g. `closeLabel="Close" i18n-closeLabel`), then
  `npm run i18n:merge` and translate the units it flags `state="new"` in `src/locale/messages.es.xlf`.
  Never pass Agent output through i18n. `ng build` writes `dist/renderer/en/` and `dist/renderer/es/`; main picks
  one in `electron/i18n/` (stored override, else system languages, else `en`). e2e pins it with `SPENCE_LOCALE`.
  Exception: main has no `$localize`, so its few native strings (the quit confirm, `electron/i18n/quit-confirm.ts`)
  are hand-written en/es tables in `electron/i18n/`; keep them there and add both languages.

## E2E and visual regression

`@playwright/test` drives the real Electron app with `SPENCE_E2E=1`, which gives each run its own data directory.
Config: `playwright.config.ts`. Fixture: `e2e/fixtures.ts` (`Spence`, `spence.shot(name)`).
Specs live in `e2e/<area>/<name>.spec.ts`; baselines in `__screenshots__/` next to them (committed).

- Add a spec per user-visible flow; call `spence.shot('<flow>-<state>')` for each visual state.
- After an intentional UI change run `npm run e2e:update`, then review the PNG diffs in git.
- Failures: `e2e-output/report/index.html`. Baselines are machine dependent; generate them on the OS that runs the suite.

## Commands

- `npm run verify`: the loop (all gates); `npm run check` is an alias
- `npm run dev`: renderer (ng serve :4200) + electron
- `npm run build`: renderer + electron; `build:renderer`, `build:electron` separately
- `npm run lint` / `lint:fix`, `npm run format` / `format:check`
- `npm run typecheck` (all three) or `typecheck:electron|app|spec`
- `npm test` (renderer), `npm run test:electron`
- `npm run e2e` (build + Playwright), `e2e:fast`, `e2e:update`
- `npm run dev:es`: like `dev`, with the renderer in Spanish (the dev server serves one locale)
- `npm run i18n:merge`: extract messages and merge new ids into `messages.es.xlf` (keeps translations, flags new ones)
- `npm run i18n:check`: the `i18n` verify step; fails on a message with no Spanish translation
- `npm run package`: build + electron-builder

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues for `ManuelUsoz/spence`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repo uses a single-context domain layout. See `docs/agents/domain.md`.
