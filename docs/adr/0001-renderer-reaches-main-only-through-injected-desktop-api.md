# 0001. The renderer reaches main only through an injected DesktopApi

Status: accepted

## Context

Spence grows fast and is worked on by people and agents. Without a single seam between renderer and main, features start
touching `ipcRenderer`, `window.desktop` or Spartan internals directly, and every change ripples.

## Decision

- One RPC contract (`DesktopRpcs`) over a `MessagePort`; the renderer gets it as the `DesktopApi` service, provided by
  `layerDesktop` and swapped by `makeDesktopTestLayer` in tests.
- Spartan helm components are generated into `src/app/ui` and imported as `@ui/<name>`; only that folder imports Spartan and the CDK.
- Zones (`shared`, `electron`, `core`, `features`, `ui`) and their allowed imports are enforced by ESLint (`eslint.config.js`),
  so `npm run verify` fails the moment a boundary is crossed.

## Consequences

- Swapping the transport or the component library touches `core` or `ui` only.
- Features are testable without Electron.
- Adding a domain has a fixed recipe (see CLAUDE.md).
