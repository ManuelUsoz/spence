# Research: Effect 4 RPC WebSocket transport, LAN mDNS discovery, and Electron TLS/credential primitives

Ticket: #88 (map #87). Question: for Spence's pinned dependencies (`effect@4.1.3` `effect/rpc`, `electron@^45.3.0`, Node `>=20` / Electron 45's Node `v24.22.0`), what primary-source APIs and platform constraints govern:

1. Running `RpcServer.layer(DesktopRpcs)` over a second WebSocket (`wss://`) transport alongside `MessagePort` (`electron/rpc/runtime.ts`), plus `RpcClient` over `ws`/`wss` in `electron/` with stream resumption and reconnect.
2. Cross-platform LAN mDNS/DNS-SD discovery (`_spence._tcp`) on Windows, macOS, and Linux from Electron's main process without native C++ addons.
3. Generating and pinning self-signed X.509 TLS certificates in Node/Electron (`node:crypto`, `node:https`, `ws`) for TOFU cert pinning, and storing pairing credentials via Electron `safeStorage`.

No product or UX decisions are made here. Unverified on-device / multi-OS runtime behaviors are explicitly marked.

---

## Summary of findings

1. **Dual `RpcServer` + `RpcClient` over `wss://` (`effect@4.1.3`):**
   - `RpcServer.layer(DesktopRpcs)` returns `Layer<never, never, RpcServer.Protocol | Rpc.ToHandler<DesktopRpcs> | ...>` and uses `Layer.effectDiscard` (`RpcServer.ts`). Two separate `RpcServer.layer(DesktopRpcs)` calls (one provided `layerIpcServer`, one provided a `wss://` `RpcServer.Protocol`) can run concurrently inside `MainRuntime` and share the **same** memoized `layerDesktopHandlers`, `layerSettingsMain`, and `layerAgentLifetimeMain` instances, provided `layerDesktopHandlers` is the same `Layer` object reference (`Layer.ts` `MemoMapImpl`). Reusing a single stored `const server = RpcServer.layer(DesktopRpcs)` reference across two `Layer.provide` branches would instead deduplicate them unless wrapped in `Layer.fresh`.
   - `effect@4.1.3` does **not** ship `@effect/platform-node` (`NodeHttpServer` / `NodeSocket` / `NodeWS`). Either `@effect/platform-node` (`4.1+`, Node `>=22.19.0`) is added, or `electron/` implements a small `RpcServer.Protocol` / `Socket.Socket` directly over `node:https` + `ws` (`WebSocketServer({ noServer: true })` + `handleUpgrade`), matching the pattern already used in `electron/rpc/ipc-server.ts`.
   - `RpcSerialization.layerSchemaBinary()` (`src/shared/rpc/message-port-protocol.ts`) frames discrete binary messages (`Uint8Array`, 16 MiB default max frame size) and works directly over WebSocket binary frames.
   - `RpcClient.makeProtocolSocket` (`RpcClient.ts`) reconnects automatically using `defaultRetryPolicy` (exponential 500 ms × 1.5 capped at 5 s) and sends application-level `Ping` frames every 5 s (`pingTimeout` defaults to `pingInterval`, reset by any decoded server frame). **Critical constraint:** on socket drop or ping timeout (`SocketCloseError` / `SocketReadError`), `makeProtocolSocket` calls `broadcastError`, which fails all in-flight RPCs and active streams with `RpcClientError` and deletes their entries in `RpcClient.make`. Streams do **not** auto-resume; application code must re-subscribe on reconnect (e.g. via `RpcClient.ConnectionHooks.onConnect` or stream retry) using Spence's existing `Session.events({ sessionId, afterSeq })` cursor (`electron/sessions/sessions.ts`).
2. **Pure-JS LAN mDNS/DNS-SD (`_spence._tcp`):**
   - Native C++ mDNS packages (`mdns` / `node_mdns`) require Apple Bonjour SDK (Windows) or Avahi headers (Linux) plus `electron-rebuild`. Pure-JS packages avoid native builds: `bonjour-service@1.4.4` (wraps `multicast-dns@7.2.5`, advertises and browses), `multicast-dns@7.2.5` (low-level RFC 6762 packets only), and `@homebridge/ciao@1.4.0` (RFC 6762/6763 responder/advertiser only; does **not** implement general client/browser discovery).
   - Running mDNS from Electron's main process (`dgram` UDP port `5353`, multicast `224.0.0.251` / `ff02::fb`) requires `reuseAddr: true` (`SO_REUSEADDR`) to coexist with OS responders (Windows native mDNS, macOS `mDNSResponder`, Linux `avahi-daemon`), and faces platform gates: Windows Defender Firewall inbound UDP `5353` prompts/blocks (re-triggered when binary name changes from `electron.exe` to packaged `.exe`), macOS Local Network Privacy permission prompt (silent drop if denied) and notarization/App Sandbox entitlements, Linux `avahi-daemon` port-sharing (`SO_REUSEADDR` vs `SO_REUSEPORT` quirks) and `ufw`/`firewalld` blocking `224.0.0.251:5353`, plus multi-NIC / VPN / WSL adapter selection.
3. **Self-signed X.509 TOFU pinning + `safeStorage`:**
   - Electron `45.3.0` embeds Node.js `v24.22.0` (`@types/node@^24.9.0`). Built-in `node:crypto` `X509Certificate` only **parses, inspects, and verifies** certificates (`fingerprint256`, `verify`, `checkHost`, `checkIP`); it still **cannot** generate or sign X.509 certificates. Pure-JS generation requires `@peculiar/x509` (WebCrypto-backed, no `node-forge`), `selfsigned` `v5+` (rewritten atop `@peculiar/x509` + WebCrypto, async-only), or `node-forge`.
   - For `wss://` TOFU pinning in `electron/`: Node `tls.connect` / `https.request` / `ws` (`new WebSocket(url, options)`) verify against `ca: [pinnedCertPem]` (with `rejectUnauthorized: true`) and then invoke `checkServerIdentity(servername, cert)`. Because LAN IPs/hostnames can change, a custom `checkServerIdentity` must compare `cert.fingerprint256` (or SHA-256 of `cert.raw`) against the pinned leaf rather than relying on hostname matching; note that `rejectUnauthorized: false` skips `checkServerIdentity` altogether, while `tlsSocket.getPeerCertificate(true)` exposes `fingerprint256` and `raw` while the TLS socket is open. Node's global `globalThis.WebSocket` (Undici) does **not** accept `ws`-style top-level TLS options in `new WebSocket(url, opts)` (it requires an Undici `Agent` `dispatcher`), whereas `ws` accepts `ca`, `rejectUnauthorized`, `checkServerIdentity`, and `headers` directly and implements `.pause()`/`.resume()` for `Socket.fromWebSocket` backpressure.
   - Electron `45.3.0` (`node_modules/electron/electron.d.ts`) **deprecates** synchronous `safeStorage` methods (`isEncryptionAvailable`, `encryptString`, `decryptString`; scheduled for removal in Electron 46). Code must use `safeStorage.isAsyncEncryptionAvailable()`, `safeStorage.encryptStringAsync(plainText)`, and `safeStorage.decryptStringAsync(encrypted)` (which returns `{ result, shouldReEncrypt }`) after `app.whenReady()`. On Linux without a keyring (`basic_text`), `safeStorage` does not encrypt with an OS keyring unless `setUsePlainTextEncryption(true)` is opted into (a no-op on Windows DPAPI and macOS Keychain).

---

## 1. Effect 4.1.3 RPC over `wss://` alongside `MessagePort`

### 1.1 Running a second `RpcServer.layer(DesktopRpcs)` in `MainRuntime`

- **Contract and current setup:**
  - `DesktopRpcs` (`src/shared/rpc/desktop-rpcs.ts`) merges `AppInfoRpcs`, `AgentsRpcs`, `ProjectsRpcs`, `SessionsRpcs`, `SettingsRpcs`, and `TabsRpcs`.
  - `electron/rpc/runtime.ts` builds `MainRuntime = ManagedRuntime.make(layerRpcServer)` from:
    ```ts
    const layerRpcServer = RpcServer.layer(DesktopRpcs).pipe(
      Layer.provideMerge(layerIpcServer),
      Layer.provide(layerDesktopHandlers),
      Layer.provideMerge(layerSettingsMain),
      Layer.provideMerge(layerAgentLifetimeMain),
    );
    ```
- **Server signature and memoization (`node_modules/effect/src/rpc/RpcServer.ts` lines 1059–1076, `Layer.ts` lines 408–468, 1549–1550, 1691–1697, 1951–1970):**
  - `RpcServer.layer(group, options)` returns `Layer.Layer<never, never, RpcServer.Protocol | Rpc.ToHandler<Rpcs> | Rpc.Middleware<Rpcs> | Rpc.ServicesServer<Rpcs>>`, implemented as `Layer.effectDiscard(Effect.forkScoped(make(group, options)))`.
  - `Layer.effectDiscard` wraps `Layer.effectContext`, which uses `fromBuildMemo`: Effect 4 memoizes each `Layer` **object reference** in `MemoMapImpl.map`.
  - Consequence:
    1. Calling `RpcServer.layer(DesktopRpcs)` **twice** creates two distinct `Layer` objects, so `Layer.mergeAll(ipcServerLayer, wssServerLayer)` forks two independent server loops—one bound to `layerIpcServer`'s `RpcServer.Protocol`, the other bound to the `wss://` `RpcServer.Protocol`.
    2. Because `layerDesktopHandlers` (`electron/rpc/index.ts`), `layerSettingsMain` (`electron/settings/window.ts`), and `layerAgentLifetimeMain` (`electron/acp/acpMain.ts`) are module-level `const` `Layer` references, providing them to both server layers builds each underlying stateful service (e.g. `Sessions`, `AgentLifetime`, `AcpClient`, `Settings`) **once** and shares them across `MessagePort` and `wss://`.
    3. Conversely, storing `const base = RpcServer.layer(DesktopRpcs)` once and reusing `base` in two `Layer.provide` branches would cause `MemoMap` to treat `base` as the same layer if its inputs matched, or require `Layer.fresh(base)` to run twice. Calling `RpcServer.layer(DesktopRpcs)` separately per transport avoids this.
- **No built-in handler isolation between transports:**
  - `RpcServer.make` (`RpcServer.ts` lines 703–1049) dispatches every tag in `group.requests` identically for any client connected through `Protocol`. If the LAN transport serves the full `DesktopRpcs` via `RpcServer.layer(DesktopRpcs)`, a connected LAN peer can invoke every RPC in `DesktopRpcs` (`Settings.*`, `Projects.*`, `Agents.*`, `Tabs.*`, `Sessions.*`) unless restricted via a smaller `RpcGroup` or gated by `RpcMiddleware` / `onRequest` / protocol-level filtering.
  - `RpcServer.make` passes request `headers` (including HTTP upgrade headers concatenated in `makeSocketProtocol` at `RpcServer.ts` lines 1823–1825) and `client: Rpc.ServerClient` (`{ id }`) into handlers and `RpcMiddleware` (`RpcMiddleware.ts` lines 51–62).

### 1.2 Server-side `wss://` `Protocol` options in `effect@4.1.3`

- **What `effect@4.1.3` includes and omits (`node_modules/effect/package.json`):**
  - `effect@4.1.3` exports `effect/rpc`, `effect/socket`, `effect/http`, `effect/net`, etc.
  - `effect/rpc` (`RpcServer.ts`) provides:
    - `RpcServer.layerProtocolSocketServer` (requires `SocketServer.SocketServer`, lines 1175–1195)
    - `RpcServer.layerProtocolWebsocket({ path })` / `makeProtocolWithHttpEffectWebsocket` (requires `HttpRouter` + `HttpServerRequest.upgrade`, lines 1205–1269)
  - However, `effect@4.1.3` does **not** include Node platform implementations (`NodeHttpServer`, `NodeSocket`, `NodeWS`, or a `SocketServer` layer); its own `ai-docs/src/51_http-server/10_basics.ts` imports those from `@effect/platform-node`.
- **Two primary ways to host the `wss://` server in `electron/`:**
  1. **Direct `node:https` + `ws` adapter implementing `RpcServer.Protocol`** (or adapting each `ws` socket to `Socket.fromWebSocket` and feeding `makeSocketProtocol`):
     - `package.json` already builds `electron/` with `esbuild` (`scripts/build-electron.mjs`, `platform: 'node'`, `format: 'cjs'`, `target: 'node22'`) and already writes a custom `RpcServer.Protocol` in `electron/rpc/ipc-server.ts`.
     - Using `node:https` (`https.createServer(tlsOptions)`) + `ws` (`new WebSocketServer({ noServer: true })` + `wss.handleUpgrade(...)` on the `'upgrade'` event) lets `electron/` enforce pairing/auth headers and TLS options during the HTTP upgrade before handing the upgraded `ws` socket to the RPC protocol.
     - Note on `esbuild` + `ws`: `ws` lists `bufferutil` and `utf-8-validate` as `optionalDependencies` loaded via `try { require(...) }`. With `esbuild` (`bundle: true`), those must either be installed or listed in `external` in `scripts/build-electron.mjs` (alongside `'electron'`, `'node-pty'`) to avoid build resolution errors (`websockets/ws` + `esbuild` behavior).
  2. **Adding `@effect/platform-node` (`4.1+`):**
     - Per Effect 4.1 release notes, `@effect/platform-node` 4.1+ requires Node `>=22.19.0` (Electron `45.3.0` embeds Node `v24.22.0`), provides `NodeHttpServer.layer(https.createServer, ...)` (HTTP/1.1 or TLS HTTP/2 with `allowHTTP1: true` required for WebSocket upgrades), and splits `ws` server support into `NodeWS`.
     - Whether `@effect/platform-node`'s `NodeHttpServer` + `NodeWS` exposes per-upgrade auth rejection cleanly before `HttpRouter` upgrade vs writing a ~60–100 line `ws` + `node:https` `RpcServer.Protocol` (like `electron/rpc/ipc-server.ts`) is an implementation choice; no `RpcServer` contract changes are needed either way.
- **Serialization (`node_modules/effect/src/rpc/RpcSerialization.ts` lines 586–701, `src/shared/rpc/message-port-protocol.ts`):**
  - `layerPortSerialization` (`RpcSerialization.layerSchemaBinary()`) sets `includesFraming: true`, encodes `Uint8Array` frames (default `maxFrameSize`: `16 * 1024 * 1024` = 16 MiB), and supports `Schema.Class` / `DateTimeUtc` / binary fields natively.
  - WebSocket already preserves message boundaries (`includesFraming: true`), so `layerSchemaBinary()` works without NDJSON framing overhead.
  - Both `makeSocketProtocol` (`RpcServer.ts` line 1789) and `RpcClient.makeProtocolSocket` (`RpcClient.ts` line 1272) create one parser instance per socket connection (`serialization.makeUnsafe()`), preventing a malformed frame on one peer connection from corrupting other connections. If `MaxBufferSizeExceeded` is thrown on decode, `makeSocketProtocol` closes the socket with WebSocket code `1009` (`RpcServer.ts` line 1832).
  - Both `makeSocketProtocol` (`RpcServer.ts` line 1866) and `makeProtocolSocket` (`RpcClient.ts` line 1419) set `supportsAck: true`, preserving the per-chunk `Ack` / `Latch` stream backpressure already verified for `MessagePort` in `Session.events`.

### 1.3 `RpcClient` over `ws`/`wss` in `electron/`: reconnect, keepalive, and stream resumption

- **Constructing the `Socket` (`node_modules/effect/src/socket/Socket.ts` lines 813–1208, 1251–1259):**
  - `Socket.layerWebSocket(url, options)` / `Socket.makeWebSocket(url, options)` acquires a `WebSocketLike` from `Socket.WebSocketConstructor` on every `socket.reader` acquisition (`openTimeout` defaults to `10000` ms).
  - `Socket.fromWebSocket` detects `"pause" in ws && typeof ws.pause === "function"` (`isPausable`, line 949) and pauses the underlying `ws` stream when buffered unread frames reach `highWaterMark` (default `64 * 1024` bytes = 64 KiB), resuming when `pull` drains them.
  - `Socket.WebSocketConstructor` (`(url: string, options?: WebSocketConstructorOptions) => WebSocketLike`) only accepts `protocols` and `headers` (`WebSocketClientOptions`, lines 838–852)—not TLS options. In `electron/`, a custom `Layer.succeed(Socket.WebSocketConstructor, (url, opts) => new WebSocket(url, { ...opts, ...tlsPinningOptions }))` using the `ws` package passes `ca`, `rejectUnauthorized`, `checkServerIdentity`, and handshake `headers` into `ws`.
  - **Global `WebSocket` caveat in Node 24:** Electron `45.3.0` / Node `v24.22.0` has a global `WebSocket` (Undici), which `Socket.layerWebSocketConstructorGlobal` uses (`Socket.ts` line 900). However, `layerWebSocketConstructorGlobal` explicitly throws a `TypeError` if `options` is an object (e.g. `{ headers }`, lines 902–904), and Undici's `WebSocket` does not accept `ws`-style top-level TLS pinning options (`ca` / `checkServerIdentity`)—it requires an Undici `Agent` passed as `{ dispatcher }`. Thus `ws` is simpler and more direct for TLS-pinned client sockets in `electron/`.
- **Keepalive, disconnect detection, and reconnect (`node_modules/effect/src/rpc/RpcClient.ts` lines 1239–1462):**
  - `RpcClient.layerProtocolSocket(options)` runs a background fiber (`Effect.forkScoped`) that loops over `Effect.scoped(socket.reader ... pull)`.
  - **Ping/Pong:** `makePinger` sends `RpcMessage.constPing` every `pingInterval` (default `5 seconds`). `pingTimeout` (default equal to `pingInterval`) checks elapsed time since the **last decoded server frame** (`pinger.onFrame()` runs on any non-empty decoded batch, line 1301). `RpcServer.make` answers `"Ping"` with `constPong` (`RpcServer.ts` line 1024). If no server frame arrives within `pingTimeout`, `makeProtocolSocket` invokes `options.onPingTimeout`, runs `ConnectionHooks.onDisconnect`, and fails the read loop with `SocketReadError("ping timeout")`.
  - **Retry behavior:**
    - When `socket.reader` fails, `makeProtocolSocket` retries using `options.retryPolicy ?? defaultRetryPolicy`, where `defaultRetryPolicy = Schedule.min([Schedule.exponential(500, 1.5), Schedule.spaced(5000)])` (indefinite retry capped at 5 s).
    - If `options.retryTransientErrors === true` and the error is `SocketOpenError` (initial connect failure), `makeProtocolSocket` calls `onTransientError` **without** calling `broadcastError`, so callers wait for the retry to connect.
    - For any other error (`SocketCloseError`, `SocketReadError`, ping timeout, or when `retryTransientErrors` is falsy), `makeProtocolSocket` sets `currentError = rpcError` and calls `broadcastError(rpcError)`. Any new `send()` while `currentError !== undefined` immediately fails with `currentError` (`RpcClient.ts` lines 1411–1413) until the next `socket.reader` acquisition succeeds (`currentError = undefined`, line 1341) and invokes `ConnectionHooks.onConnect`.
- **Stream resumption behavior (`RpcClient.ts` lines 432–507, 798–807; `electron/sessions/sessions.ts` lines 723–751):**
  - `broadcastError` sends `{ _tag: "ClientProtocolError", error }` to `RpcClient.make`, which deletes all pending `entries` and ends every active stream `Queue` with `RpcClientError` (`RpcClient.ts` lines 798–807).
  - **Effect RPC does NOT automatically resume or replay streams across socket reconnects.**
  - On the server, `Sessions.events(id, afterSeq = 0)` (`electron/sessions/sessions.ts` lines 723–751) already supports gapless cursor resumption: it subscribes to `session.hub` (`PubSub`) *before* calling `store.replay(id, afterSeq)`, emits `{ _tag: 'Live', state }` + persisted `Transcript` events with `seq > afterSeq`, and filters live items where `item.event.seq <= lastSeq`.
  - Therefore, a remote client consumer in `electron/` achieves stream resumption by tracking the highest received `TranscriptEvent.seq` and re-invoking `client['Session.events']({ sessionId, afterSeq: lastSeq })` after reconnect (driven by stream retry on `RpcClientError` and/or `ConnectionHooks.onConnect`), updating its live state from the fresh `{ _tag: 'Live', state }` snapshot.
  - **Multi-peer client scoping note:** Each `makeProtocolSocket` binds to a single `Socket` service instance (`yield* Socket.Socket` at `RpcClient.ts` line 1265). Managing connections to N Remote devices requires building one `Socket` + `RpcClient.layerProtocolSocket` + `RpcClient.make(DesktopRpcs)` per Remote device inside its own `Scope` (or `Layer.fresh`), rather than sharing one `Protocol` layer globally.

---

## 2. Cross-platform LAN mDNS/DNS-SD discovery (`_spence._tcp`) from Electron main

### 2.1 Pure-JS package comparison (no native C++ addons)

Native bindings (`mdns` / `node_mdns`) wrap Apple's Bonjour SDK on Windows, `libavahi-compat-libdnssd` on Linux, and `dns_sd.h` on macOS, requiring `electron-rebuild` and external OS SDKs/daemons (notably Apple's Bonjour Print Services is not preinstalled on stock Windows). Pure-JS packages communicate directly over Node's `node:dgram` UDP sockets from Electron's main process:

| Package | Latest version (verified) | Role | Dependencies | Electron main-process notes |
| --- | --- | --- | --- | --- |
| `bonjour-service` (`onlxltd/bonjour-service`) | `1.4.4` | High-level DNS-SD (RFC 6763) **advertiser + browser** (`publish`, `find`) | `multicast-dns` (`^7.2.5`), `fast-deep-equal` (`^3.1.3`) | TypeScript, pure JS. Passes socket options (`reuseAddr`, `interface`, `multicast`) to `multicast-dns`. Must supply error callback and call `.destroy()` on shutdown/restart. |
| `multicast-dns` (`mafintosh/multicast-dns`) | `7.2.5` | Low-level mDNS (RFC 6762) **packet encoder/decoder & socket** | `dns-packet`, `thunky` | Pure JS over `node:dgram`. No built-in DNS-SD PTR/SRV/TXT state machine or conflict probing; gives direct control over interfaces/sockets if `bonjour-service` defaults misbehave. |
| `@homebridge/ciao` (`homebridge/ciao`) | `1.4.0` | RFC 6762/6763 **responder/advertiser only** | Pure TS/JS (requires Node `>=22`, satisfied by Electron 45's Node `24.22.0`) | Built for resilient advertising/probing/conflict resolution, **but does not provide general service browsing/discovery** (unicast response handling per RFC 6762 §15.1 is out of scope). Would still need `bonjour-service` or `multicast-dns` to browse. |

### 2.2 Process placement and `node:dgram` requirements

- **Main process only:** Electron renderers with `sandbox: true` and `nodeIntegration: false` (`electron/main.ts` lines 60–66) have no `node:dgram` access; mDNS must run in `electron/` (matching ADR 0001).
- **Port `5353` and `reuseAddr: true`:** RFC 6762 §5.2 requires mDNS responders/queriers to bind UDP port `5353` on multicast `224.0.0.251` (IPv4) / `ff02::fb` (IPv6). Because OS services and other apps also bind port `5353`, `reuseAddr: true` (`SO_REUSEADDR`) is mandatory on the `dgram` socket (passed through `bonjour-service` options to `multicast-dns`), otherwise `bind(5353)` fails with `EADDRINUSE`.
- **Uncaught socket errors:** Both `multicast-dns` and `bonjour-service` emit `'error'` events on UDP socket failures (e.g. `EADDRINUSE`, interface down); an error handler callback must be attached to avoid crashing Electron's main process.

### 2.3 Cross-platform OS, firewall, and network caveats

| Platform | Known primary-source / documented caveats | Verification status |
| --- | --- | --- |
| **Windows 10/11** | • Windows 10 (1803+) and 11 run a native OS mDNS resolver on UDP `5353`, making `reuseAddr: true` required.<br>• **Windows Defender Firewall** often blocks **inbound** UDP `5353` / multicast `224.0.0.251` packets for Electron apps or triggers a Private/Public network prompt. If dismissed or on a "Public" network profile, outbound queries leave but inbound multicast replies are silently dropped.<br>• **Dev vs packaged binary trap:** Windows Defender ties rules to the executable path/signature (`electron.exe` in dev vs `Spence.exe` in `electron-builder` output); rebuilding/updating an unsigned binary invalidates or re-prompts firewall rules. | **Unverified on-device** across multiple Windows machines and Private/Public network profiles; needs runtime spike. |
| **macOS** | • macOS runs `mDNSResponder` on UDP `5353` (`reuseAddr: true` required).<br>• **Local Network Privacy (macOS Sequoia+):** Apps performing local multicast/LAN discovery trigger a macOS system prompt ("find and connect to devices on your local network"). If denied, UDP multicast and local LAN connections fail silently at the kernel level.<br>• **App Sandbox / Hardened Runtime:** Sandboxed/notarized builds require network client/server entitlements (and multicast entitlements if sandboxed; `NSLocalNetworkUsageDescription` in `Info.plist`). Code signing identity must remain consistent across updates so permissions persist. | **Unverified on-device** (authoring environment is Windows; macOS Local Network Privacy & entitlements unverified). |
| **Linux** | • Most desktop distros run `avahi-daemon` on UDP `5353`. Node's `dgram` supports `reuseAddr: true` (`SO_REUSEADDR`); on Linux kernels, multicast `SO_REUSEADDR` allows sharing port `5353` in many cases, though `SO_REUSEPORT` vs `SO_REUSEADDR` interactions and multiple instances can still cause bind or packet-delivery quirks.<br>• Host firewalls (`ufw`, `firewalld`) frequently drop incoming multicast UDP `5353` (`224.0.0.251`) by default unless explicitly permitted. | **Unverified on-device** (not tested against `avahi-daemon` or `ufw`/`firewalld`). |
| **All OSes (NICs & Wi-Fi)** | • Hosts with multiple interfaces (Docker bridges, WSL virtual switches, VPNs, Ethernet + Wi-Fi) can cause mDNS responders/queriers to bind or advertise wrong/unreachable virtual IPs unless interfaces are filtered or explicitly enumerated.<br>• Home routers with AP/client isolation or IGMP/multicast snooping issues can drop mDNS packets even on the same SSID (requiring manual `host:port` fallback).<br>• **Suspend / sleep / network change:** `bonjour-service` sockets bound to disappearing interfaces need teardown (`destroy()`) and re-initialization on network/power resume. | **Unverified on-device** (multi-NIC / sleep-wake behavior unverified). |

---

## 3. Self-signed X.509 TLS pinning & Electron `safeStorage`

### 3.1 Generating self-signed X.509 certificates in Node/Electron

- **Runtime baseline:** Electron `45.3.0` (`node_modules/electron/electron.d.ts`, Electron 45 release notes) ships **Node.js `v24.22.0`**.
- **Built-in `node:crypto` limitation (`node_modules/@types/node/crypto.d.ts` lines 2466–2642, 3052–3220; Node.js v24 docs):**
  - `node:crypto` generates asymmetric key pairs (`generateKeyPair` / `generateKeyPairSync` for EC `prime256v1`, `ed25519`, `rsa`, etc.) and provides `new crypto.X509Certificate(pemOrDer)` to **parse, inspect, and verify** existing certificates (`fingerprint256`, `raw`, `publicKey`, `verify(publicKey)`, `checkHost`, `checkIP`, `validFromDate`, `validToDate`).
  - `node:crypto` does **not** have an API to construct or sign an X.509 certificate.
- **Pure-JS / WebCrypto certificate generation options (no external `openssl` binary):**
  1. **`@peculiar/x509`:** TypeScript library built on `@peculiar/asn1-schema` and `globalThis.crypto.subtle` (WebCrypto is built into Node `24.22.0`). Supports ECDSA (`P-256`) and RSA keys, `X509CertificateGenerator.createSelfSigned(...)`, custom extensions (`BasicConstraintsExtension`, `KeyUsageExtension`, `SubjectAlternativeNameExtension` with DNS/IP SANs), and PEM export (`certificate.toString("pem")`). No `node-forge` dependency.
  2. **`selfsigned` (`v5+`):** Refactored in `v5.0` to drop `node-forge` and use `@peculiar/x509` + native Node WebCrypto internally (async-only API). Lighter wrapper if only basic self-signed leaf generation is needed.
  3. **`node-forge`:** Pure-JS PKI/TLS implementation (older, larger, synchronous RSA generation); unnecessary in Node 24 now that WebCrypto + `@peculiar/x509` work natively.

### 3.2 `node:https` + `ws` server TLS and client TOFU certificate pinning

- **Server (`node:https` + `ws`):**
  - `https.createServer({ key, cert })` (Node `node:https` / `node:tls`) serves TLS using the device's generated self-signed private key and certificate PEM.
  - `new WebSocketServer({ noServer: true })` attaches to `httpsServer.on('upgrade', (req, socket, head) => ...)` and upgrades authenticated requests via `wss.handleUpgrade(req, socket, head, (ws) => ...)`.
  - Note: TLS socket metadata is available during upgrade via `(req.socket as tls.TLSSocket)` if needed (e.g., if mutual TLS `requestCert: true` is ever used, `tlsSocket.getPeerCertificate(true)` reads the client cert while open).
- **Client TOFU pinning (`ws` + `node:tls`, `node_modules/@types/node/tls.d.ts` lines 34–130, 632–661, 953–1055):**
  - By default, `new WebSocket('wss://...')` in `ws` sets `rejectUnauthorized: true` against the system/Node root CA store, which rejects self-signed certificates (`DEPTH_ZERO_SELF_SIGNED_CERT`).
  - **Crucial Node `tls` behavior for pinned self-signed certs (`tls.d.ts` line 965):**
    - `options.checkServerIdentity(servername, cert)` is **only called if the certificate passes CA/chain verification first** (or if `ca` trusts the self-signed cert).
    - If `rejectUnauthorized: false` is set, Node skips CA verification **and does not call `checkServerIdentity`**.
  - **Two distinct TLS modes apply to TOFU:**
    1. **Pinned connection (after pairing):** Pass `ca: [pinnedServerCertPem]` and `rejectUnauthorized: true` plus a custom `checkServerIdentity(hostname, cert)` on `new WebSocket(url, { ca: [pinnedPem], rejectUnauthorized: true, checkServerIdentity })`:
       - Node/OpenSSL cryptographically verifies the server proved possession of the private key matching `pinnedPem` and checks validity dates (`notBefore`/`notAfter`).
       - `checkServerIdentity` receives `cert: tls.PeerCertificate`, where `cert.fingerprint256` (colon-separated SHA-256 hex of DER) and `cert.raw` (DER `Buffer`) can be compared (e.g. constant-time comparison via `crypto.timingSafeEqual` over normalized SHA-256 bytes) against the pinned certificate fingerprint. Returning `undefined` accepts; returning `new Error(...)` aborts the TLS handshake.
       - Overriding `checkServerIdentity` avoids brittle hostname/IP SAN failures when a peer's LAN IP changes via DHCP or when dialing by mDNS IPv4/IPv6 address, while still enforcing full cryptographic proof of the pinned certificate.
    2. **Unpinned initial TOFU probe / pairing handshake (before cert is pinned):**
       - To inspect an unknown peer's certificate during pairing, `tls.connect({ host, port, rejectUnauthorized: false })` (or `ws` with `rejectUnauthorized: false` + reading `(ws as any)._socket.getPeerCertificate(true)`) allows the TLS handshake to complete so the client can read `cert.raw` / `cert.fingerprint256` (or `new crypto.X509Certificate(cert.raw)`) and bind the pairing verification (e.g., user-confirmed fingerprint/code or out-of-band pairing proof) to that exact certificate. Using `rejectUnauthorized: false` **without** verifying the cert fingerprint against a pairing secret/confirmation would leave the connection vulnerable to active MITM during pairing.
  - **Cert rotation / expiry:** Self-signed certs have `validFrom` / `validTo` (`notAfter`). If `ca: [pinnedPem]` + `rejectUnauthorized: true` is used, an expired pinned cert will fail OpenSSL's date check (`CERT_HAS_EXPIRED`).

### 3.3 Storing pairing credentials via Electron `safeStorage`

- **Installed Electron `45.3.0` API (`node_modules/electron/electron.d.ts` lines 12773–12862; Electron 45 release notes):**
  - **Synchronous methods are deprecated in Electron 45 and scheduled for removal in Electron 46** (Chromium removed the synchronous OSCrypt backend):
    - Deprecated: `safeStorage.isEncryptionAvailable()`, `safeStorage.encryptString(plainText)`, `safeStorage.decryptString(encrypted)`.
    - Required async API:
      - `safeStorage.isAsyncEncryptionAvailable(): Promise<boolean>`
      - `safeStorage.encryptStringAsync(plainText: string): Promise<Buffer>`
      - `safeStorage.decryptStringAsync(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>`
  - **Lifecycle constraint (`electron.d.ts` lines 12838–12840):** The asynchronous encryptor initializes lazily on first call **after `app` emits `'ready'`**. `MainRuntime` (`electron/rpc/runtime.ts`) is imported at module load in `electron/main.ts` line 8 *before* `app.whenReady()` (line 114); therefore any service reading/writing `safeStorage` must defer `safeStorage.*Async` calls until after `app.whenReady()` (or lazily on first RPC/LAN startup) rather than inside top-level eager layer construction before `ready`.
  - **Key rotation (`shouldReEncrypt`):** When `decryptStringAsync` resolves with `shouldReEncrypt: true`, the caller should re-encrypt `result` with `encryptStringAsync(result)` and persist the updated ciphertext (`electron.d.ts` lines 12791–12795).
  - **OS backend behavior & threat-model limits (Electron `safeStorage` docs & `electron.d.ts` lines 12813–12862):**
    - **Windows (DPAPI):** Encrypts per Windows user account; protects against offline disk reads and other OS users, **not** against other processes running as the same Windows user.
    - **macOS (Keychain):** Stores encryption key in macOS Keychain; protects against other users and other apps (may prompt for Keychain access if binary code-signing changes across updates).
    - **Linux (`gnome_libsecret` / `kwallet` / `kwallet5` / `kwallet6` / `basic_text`):** `safeStorage.getSelectedStorageBackend()` reports the active backend (`'unknown'` before `app` ready). In desktop environments without Secret Service or KWallet (or headless sessions), backend falls back to `basic_text`, and `encryptStringAsync` throws unless `safeStorage.setUsePlainTextEncryption(true)` was called (which uses an in-memory password, not an OS keyring; no-op on Windows/macOS). **Unverified on-device** across Linux desktop environments and headless CI.
    - **Blob storage:** `safeStorage` encrypts/decrypts small strings (e.g. pairing tokens, private keys, or a master secret) into opaque `Buffer`s; Electron does not manage persistence, so encrypted `Buffer`s (e.g. base64-encoded inside `<userData>/spence/`) must be stored by Spence's own Store/file layer (`electron/store/`).

---

## Primary sources cited

- Repo source files:
  - `package.json` (`effect@4.1.3`, `electron@^45.3.0`, `@types/node@^26.6.6`, `engines.node: >=20`)
  - `scripts/build-electron.mjs` (`esbuild` CJS bundle config for `electron/main.ts`)
  - `electron/main.ts` (`app.whenReady()`, `BrowserWindow` `sandbox: true` / `nodeIntegration: false`)
  - `electron/rpc/runtime.ts`, `electron/rpc/index.ts`, `electron/rpc/ipc-server.ts`, `electron/rpc/sessions.ts`
  - `electron/acp/acpMain.ts`, `electron/settings/window.ts`, `electron/sessions/sessions.ts` (`Sessions.events(id, afterSeq)`)
  - `src/shared/rpc/desktop-rpcs.ts`, `src/shared/rpc/message-port-protocol.ts`, `src/shared/sessions/sessions.rpc.ts`
- Installed `effect@4.1.3` (`C:\Users\miuso\workspace\nxy\spence\node_modules\effect\`):
  - `package.json`, `src/Layer.ts`, `src/rpc/RpcServer.ts`, `src/rpc/RpcClient.ts`, `src/rpc/RpcMiddleware.ts`, `src/rpc/RpcSerialization.ts`, `src/socket/Socket.ts`, `src/socket/SocketServer.ts`, `ai-docs/src/51_http-server/10_basics.ts`
- Installed `electron@45.3.0` & `@types/node` (`C:\Users\miuso\workspace\nxy\spence\node_modules\`):
  - `electron/package.json`, `electron/electron.d.ts` (`SafeStorage`)
  - `@types/node/crypto.d.ts` (`generateKeyPair`, `generateKeyPairSync`, `X509Certificate`)
  - `@types/node/tls.d.ts` (`PeerCertificate`, `ConnectionOptions`, `checkServerIdentity`, `TLSSocket`)
- External primary documentation & package sources:
  - Electron 45 release notes & `safeStorage` API documentation (`electronjs.org`)
  - Node.js `node:tls`, `node:crypto`, and global `WebSocket` / `undici` documentation (`nodejs.org`)
  - `@effect/platform-node` v4.1+ release notes & HTTP/WebSocket docs (`effect.website` / `Effect-TS/effect`)
  - `websockets/ws` (`ws` v8.x) API documentation (`github.com/websockets/ws`)
  - `onlxltd/bonjour-service` (`1.4.4`), `mafintosh/multicast-dns` (`7.2.5`), `homebridge/ciao` (`1.4.0`) package manifests & documentation (`github.com` / `npmjs.com`), RFC 6762 & RFC 6763
  - `@peculiar/x509` & `jfromaniello/selfsigned` (v5+) documentation (`github.com` / `npmjs.com`)
