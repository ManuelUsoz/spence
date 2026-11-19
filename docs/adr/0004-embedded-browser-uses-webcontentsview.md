# 0004. Embedded Browser uses WebContentsView behind a BrowserHost seam

Status: accepted

## Context

Sessions often need a live web preview or web app alongside the conversation—to inspect a local dev server, test flows, or let an Agent interact with a running page without switching out of Spence. The embedded browser must stay isolated from Spence's privileged `DesktopApi` bridge, avoid crashing or blocking Angular's renderer, support Electron 45's native view layout, and remain testable in Vitest without launching Chromium.

## Decision

- Each open Page in a Session's embedded **Browser** is backed by an Electron `WebContentsView` attached to the main `BrowserWindow.contentView` (keeping `BrowserWindow` rather than switching to `BaseWindow`), positioned and resized from bounds synced by the renderer's split-pane slot.
- All Pages share a single `persist:spence-browser` Electron session partition with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and **no preload script**, ensuring untrusted web content never gains `window.desktop` or Node access. Hardware/origin permission requests and checks on `persist:spence-browser` are denied by default, popups (`setWindowOpenHandler`) always return `{ action: 'deny' }` (with allowed `http:`/`https:` popups routed into Spence), and unsafe schemes are blocked on `will-navigate`.
- Main-process Browser domain logic (`BrowserService`) never imports Electron directly; it operates behind a thin `BrowserHost` Effect service (`electron/browser/browser-host.ts`) implemented for production in `electron/browser/electron-browser-host.ts` and swapped for `makeFakeBrowserHost` in unit tests.
- Agent access to a local Session's embedded Browser runs over a dedicated localhost HTTP MCP server (`spence-browser`) on `127.0.0.1:0` with per-Session Bearer tokens, matching `delegation-server.ts`, rather than exposing Browser controls through the ACP stdio channel.

## Consequences

- `BrowserService`, RPC handlers, and security policies can be tested deterministically in Vitest with `makeFakeBrowserHost` and no Electron binary.
- Electron 45 `WebContentsView` quirks—using `webContents.navigationHistory`, closing views via `webContents.close({ waitForBeforeUnload: false })`, rounding integer bounds, and bridging Electron callbacks via `Queue.unbounded` + `Queue.offerUnsafe`—are encapsulated inside `electron-browser-host.ts`.
- Native `WebContentsView` layers sit above HTML DOM elements inside their bounds, requiring an explicit occlusion signal when modals, sheets, menus, toasts, or full-page views cover the Browser pane.

## Considered Options

- **HTML `<iframe>`**: blocked by `X-Frame-Options` and `Content-Security-Policy: frame-ancestors` on most external sites and many local setups, and lacks isolated Chromium navigation history, devtools, and screenshot/element hooks.
- **Electron `<webview>` tag**: deprecated in Electron security guidance, lives inside the renderer DOM tree, and couples lifecycle to Angular template teardown instead of main-process Session state.
- **Putting Electron calls directly inside `BrowserService`**: couples all state, bounds, and policy tests to Electron mocks instead of a clean Effect service seam.
