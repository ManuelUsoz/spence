## Problem Statement

Spence runs on one computer, but people in one home use several. They want to open a Project running on another
computer in the house, drive its Sessions as if local, and let Sessions (and Agents) on different computers hand
work to each other, without a cloud service, an account, or giving up the rule that each computer owns its own data.

## Solution

Connect Spence **Devices** on the same home LAN. A Device can opt in to hosting; another Device **Pairs** with it once
and can then (1) use its Projects and Sessions from the local window (**Remote device access**) and (2) send
**Cross-device messages** and start Sessions on it (**P2P**), first by a person, later by Agents under Spence's
Permission model. A Remote Session is the same chat as a Local one; only Device indicators differ. Everything
networked lives in `electron/`; the renderer still talks only to `DesktopApi`.

Decisions are recorded on the tickets of the map [Wayfinder: same-house LAN device communication](https://github.com/ManuelUsoz/spence/issues/87);
each section below cites its ticket. Nothing here is implemented.

## User Stories

1. As a user, I want to turn hosting on in Settings > Devices, so that my other computers can reach this one only when I choose.
2. As a user, I want to pair two Devices with a 6-digit code once, so that I need no accounts or per-session setup.
3. As a user, I want pairing to trust both directions, so that either computer can be viewer or sender.
4. As a user, I want to see nearby Devices and also type `host:port`, so that pairing works when discovery does not.
5. As a user, I want to see a Remote device's Projects grouped by Device, so that I always know where a Session runs.
6. As a user, I want a Remote Session to look and behave like a Local one, so that I learn nothing new.
7. As a user, I want to add, locate, rename and remove Projects on a Remote device, so that I can set it up from my seat.
8. As a user, I want to change a Remote device's execution Settings and install its Agents, so that I need not walk over.
9. As a user, I want my own theme, language and layout to stay mine on every Device, so that the app feels the same.
10. As a user, I want closing a Remote Tab or quitting my Spence never to stop a Turn on the host, so that work survives my viewer.
11. As a user, I want a disconnected Remote Session to stay readable and say Offline/Reconnecting, so that I understand what happened.
12. As a user, I want it to resume without gaps when the Device returns, so that I miss nothing.
13. As a user, I want Remote Sessions that need me to surface Attention here, so that I am called back like for Local ones.
14. As a user, I want to send a Message to any Session on any Device from a Spence action, so that I can hand off work.
15. As a user, I want every Cross-device message to show where it came from, so that I know who said it.
16. As a user, I want Agents to send Messages and start Sessions on other Devices only if the receiver allows it and my Permission mode permits it, so that nothing runs by surprise.
17. As a user, I want loops between Agents rejected, so that two Agents cannot ping each other forever.
18. As a user, I want clear typed failures when a target is Offline, Busy or forbidden, so that nothing is silently queued.
19. As a user, I want images and files from a Remote Session to display on demand, so that nothing large is copied onto my disk.
20. As a user, I want a host that serves others to stay running after I close its window, and to ask before quitting, so that I do not drop someone's Turn.
21. As a user, I want a hosting Device to stay awake only while a Turn is running, so that idle hosting costs no battery.
22. As a user, I want either side to unpair, so that I can revoke trust at any time.

## Implementation Decisions

Vocabulary: **Device** (Local device / Remote device), **Pairing**, **Paired device**, **Provenance**, **Cross-device
message** and **Allow Agents from this Device** are in `GLOSSARY.md`. Avoid Node, Environment, Machine, Host, Peer.

### Ownership and access model ([Define Remote device access model and Project/Session ownership](https://github.com/ManuelUsoz/spence/issues/89))

- One Spence window shows the Local device and every connected Remote device. Every Project belongs to exactly one
  Device and is identified by `(deviceId, projectId)`; Projects are never merged across Devices by name or path.
- Project selector and All-Projects layout group Projects by Device: Local first, then connected Remote devices,
  ordered by `projectOrder` within each. Offline paired Devices show only an offline indicator plus any open Offline Tabs.
- UI presentation Settings (`language`, `theme`, `notifications`, `sidebarLayout`, `projectOrder`) belong to the viewing
  Device. `ProjectSettings`, global execution defaults (`defaultPermissionMode`, `autoArchiveDays`, per-Agent
  `model`/`effort`) and Agent lifecycle (`Agents.install`, status) belong to the host and are editable remotely
  through a Device selector in Settings.
- ADR 0003 holds: each Device owns its Store, Transcripts, blobs and ACP processes. Remote Transcripts and blobs are
  never persisted on the viewer. A Turn started from a Remote viewer runs and persists on the host; closing a Remote
  Tab, disconnecting or quitting the viewer never stops it. The viewer's quit confirmation counts only Local Turns.
- Several windows may view one Session with no exclusive lock: the host enforces `Busy` in `Session.prompt`; the first
  `Session.answerPermission` wins.
- On disconnect the Remote Tab stays, marked Offline, with loaded Thread content readable and the Composer disabled.
  Local `tabs.json` persists lightweight stubs `{ deviceId, sessionId, projectId, title }`, restored Offline until the
  Device connects; no Transcript is cached. A vanished Remote draft resets as a fresh draft.
- Connected, unarchived Remote Sessions raise Attention (Permission request, error) in the sidebar, Tab and, when
  enabled, OS notifications, exactly as Local ones.

### Discovery, pairing, trust ([Define LAN discovery, pairing ceremony, TLS trust, and credential revocation](https://github.com/ManuelUsoz/spence/issues/91))

- Identity is a random `deviceId` (UUID, first launch) plus one self-signed TLS certificate carrying it; the
  certificate fingerprint is the trust anchor, never the IP. Display name is user-editable (default OS hostname). A
  paired `deviceId` presenting another fingerprint is refused as "identity changed": unpair and re-pair, never re-trust silently.
- Hosting is off by default behind one Settings toggle ("Allow other Devices to connect"): off means no listener and no
  mDNS. On advertises `_spence._tcp` with TXT limited to `deviceId`, display name and `protocolVersion`. Browsing runs
  only while the Devices UI is open or a paired Device is offline.
- Pairing: the host opens a pairing window showing a 6-digit code (QR optional), single-use, 2 minute expiry, closing
  after 3 wrong attempts. The pairing endpoint is the only tokenless surface. The client proves
  `HMAC(code, hostCertFingerprint)`, anchoring first-connect trust against a man in the middle.
- One ceremony trusts both directions: each side stores the other's fingerprint and `deviceId` and issues a bearer
  token. Paired does not imply reachable.
- Tokens are 256-bit random, no expiry. The host stores only hashes; the client stores token and pinned fingerprint
  through async `safeStorage`. Without `safeStorage` (Linux without a keyring) pairing is refused with an explanation;
  no plaintext fallback. Either side can unpair (deletes the record, closes live sockets); the other side sees
  `Unauthorized`, marks "unpaired by the other side" and offers one-click removal.
- Manual `host:port` uses the same pairing; the address is only a hint, identity is still `deviceId` + fingerprint.
  Default port fixed, next free port if taken, actual port advertised.
- `protocolVersion` is one integer in the handshake. A mismatch is a typed `VersionMismatch` carrying both versions;
  the UI says which side to update and the Device stays paired as "needs update". No negotiation or shims.
- Reconnect: 500 ms x 1.5 capped at 5 s for the first minute, then every 30 s; immediate retry on an mDNS
  re-announcement of that `deviceId` or a network change; never gives up while paired.
- Host quit confirmation counts all active Turns including Remote-started ones and states how many Remote devices are
  connected. Strings go in the hand-written en/es tables in `electron/i18n/`.

### Hosting lifecycle ([Define host background hosting, sleep/wake, and hosting indicators](https://github.com/ManuelUsoz/spence/issues/176))

- With hosting on, the process stays resident after the last window closes on every OS. Hosting off keeps today's behaviour.
- A tray (Windows/Linux) or menu-bar (macOS) item exists only while hosting is on and no window is open: "Open Spence",
  a one-line "Serving N Remote devices" status, "Quit". No login item or autostart.
- Closing a window never prompts; only explicit Quit does (host quit confirmation above).
- `powerSaveBlocker` `prevent-app-suspension` is held only while at least one Turn runs on the host; the viewer holds none.
- On `powerMonitor` resume the host rebinds the listener, re-announces mDNS and re-evaluates interfaces; surviving
  Agent processes keep their Turns. No sleep signalling or new protocol. Viewers reset backoff to immediate retry on
  their own resume.
- Indicators are only: Settings > Devices (connected viewers by name with Disconnect and Unpair), the tray status
  line, and a subtle top-bar chip while a Remote device is connected. No toasts, OS notifications or dock badge.

### Routing architecture ([Define shared RPC and Electron routing architecture for Local and Remote devices](https://github.com/ManuelUsoz/spence/issues/177), [Research Effect 4 RPC WebSocket transport, LAN mDNS discovery, and Electron TLS/credential primitives](https://github.com/ManuelUsoz/spence/issues/88))

- `DesktopApi` and `DesktopRpcs` are unchanged and the renderer never sees a socket (ADR 0001). Device-scoped RPCs
  carry an optional `deviceId` (absent or `local` means Local). `sessionId`/`projectId` are always paired with
  `deviceId` in renderer state and Remote Tab stubs. A Local-only `Devices` group (list, connection state, pairing,
  unpair, events) is the only Device-aware group.
- The LAN `wss://` server serves a `RemoteRpcs` group selected from `DesktopRpcs`: Projects, Sessions, Files,
  Worktrees, SourceControl, execution-only Settings, Agents, Folders, Assets and the P2P calls. `Tabs`, `Links`,
  `Devices` and UI-preference Settings are never exposed. The allow-list is which groups the server is built from, not
  checks inside handlers.
- Both servers (MessagePort and `wss://`) run in `MainRuntime` over the same memoized handler layers. `effect@4.1.3`
  has no `@effect/platform-node`: either add it (4.1+, Node >= 22.19) or write a small `node:https` + `ws`
  `RpcServer.Protocol`; serialization stays `RpcSerialization.layerSchemaBinary()`. The client uses
  `RpcClient.makeProtocolSocket` with a `ws`-backed `Socket.WebSocketConstructor` for `ca`/`checkServerIdentity`.
- TLS: `@peculiar/x509` or `selfsigned` v5+ to generate certificates; pinning via `ws`/`node:tls` with a custom
  `checkServerIdentity` comparing `fingerprint256` (never `rejectUnauthorized: false`).
- Discovery uses pure-JS `bonjour-service` (`reuseAddr: true`, error callback, `destroy()` on shutdown/network change).
- Authorization: bearer token and `deviceId` are verified once at WebSocket upgrade. Handlers read a per-connection
  `RemotePeer` service for provenance, Allow Agents from this Device and hop-limit checks; the local port server
  provides none. No per-call tokens or per-group permissions in v1: paired means full allow-listed access.
- Outbound: a main-process `DeviceConnections` service owns one `RpcClient` per connected Remote device (pinning,
  backoff, `protocolVersion`) and exposes "call group G on Device D" and a connection-state stream. The router, a thin
  layer over it, keeps `afterSeq` and re-subscribes `Session.events` / `Session.changes`; the renderer sees one
  continuous stream that goes Offline/Reconnecting and resumes. `RpcClient` itself never resumes streams.
- Handles are host-minted random tokens, scoped to the issuing `RemotePeer` connection (assets) or the sender
  `deviceId` (P2P targets), in memory only, cleared with the connection or process; unknown or expired is typed `NotFound`.
- Layout: `electron/devices/` (identity, certificate, pairing, trust store, token hashes), `electron/lan/` (wss
  server, mDNS, `DeviceConnections`, router), `electron/hosting/` (resident mode, tray, power blocker, indicators),
  `electron/rpc/devices.ts` for handlers. Wired into `MainRuntime` only when hosting is on or a paired Device exists.
  `electron/main.ts` stays windows and lifecycle only; the `electron/rpc/<domain>.ts` pattern is unchanged.

### Folders, files and assets ([Define Remote folder browsing, file/diff visibility, and asset streaming](https://github.com/ManuelUsoz/spence/issues/95))

- New read-only `Folders.browse({ path })`, directories only, used by `Projects.add`/`Projects.locate` only when the
  target is a Remote device (Local keeps the native dialog). Starts at the host's home; drives (Windows) or `/` are
  roots; hidden folders behind a toggle; symlinks shown and resolved; failures are typed (`Missing`, `Unreadable`).
  No allow-list; it never reads file contents.
- `Files.list`, `Files.read`, `Session.changes`, `SourceControl.diff` and Step `Diff` items are unchanged; their caps
  (1 MiB text, 2,000 entries) are enforced on the host.
- Over the LAN the host replaces inline `ImagePart`, `AudioPart` and blob `ResourcePart` bytes with an opaque handle
  plus `mimeType` and `size`; the client fetches with new `Assets.read({ handle })` only when the part renders. Max
  10 MiB per asset (larger shows a "too large to preview" placeholder); client keeps a bounded in-memory LRU of about
  64 MiB and writes nothing to disk; missing assets or an Offline Device show a placeholder and retry on reconnect.
  The host Transcript is unchanged.

### Cross-device messaging ([Define P2P cross-device Session messaging and Agent delegation](https://github.com/ManuelUsoz/spence/issues/90))

- Only three primitives cross Devices: **send Message** to an existing Session; **start Session** in a Project with a
  first Message, optionally seeded by a Summary handoff; **observe** the outcome of the target's Turn. No file copy,
  Store sync or Transcript sharing.
- P2P is Session-to-Session with visible Provenance (sender Device, Project, Session), shown as a quiet "From
  <Session> on <Device>" label on the receiving Session. It is not a second way to type into a Remote Session.
- Two phases in one spec: Phase 1 human-initiated (any target Session/Project on any Device, including Local, from a
  Spence action); Phase 2 Agent-initiated on the same primitives and Provenance.
- Agent surface (ADR 0002): main exposes a Spence-owned tool set per Agent adapter: `list_targets`, `send_message`,
  `start_session`, `await_result`. Targets are opaque handles; Agents never see addresses, tokens or ACP.
- Two independent gates. Sender: `send_message`/`start_session` are Steps raising a Permission request under the
  sending Session's Permission mode. Receiver: Allow Agents from this Device, off by default; human-initiated Messages
  always pass. The receiving Session runs under its own Permission mode; `start_session` uses the host's default.
  The sender's mode never carries over.
- Loop safety: Provenance carries a hop count and the chain of Sessions; the receiver rejects when hops > 3, the
  target is already in the chain, or the target is the sender. Human-initiated Messages start at hop 0. No rate limiter in v1.
- Fail fast with typed errors (`Offline`, `Busy`, `NotFound`, `Forbidden`, loop rejection). No outbox. A Busy Session
  rejects an Agent-sent Message; a human send from the UI gets normal queue/steer behaviour.
- `send_message`/`start_session` return once the host accepts, with a target handle. `await_result(handle, timeout)`
  returns the Turn outcome and final Message text, or `Pending`. Nothing is pushed into the sender's Transcript.

### UI ([Prototype LAN Device discovery, pairing, and multi-device sidebar/switcher UI](https://github.com/ManuelUsoz/spence/issues/92))

Reference: the definitive calm design canvas, boards 13 to 19. Principle: a Remote Session is the same chat; only
Device indicators differ and behaviour is identical.

- Selector (13): groups Projects by Device (this computer, then each paired Device) with a status dot; a Device's
  "Needs you" shows only as the amber dot. No global cross-Device Needs-you list.
- Remote Session (14): selector subtitle shows the Device and its dot; top-bar Device chip; Composer placeholder
  "Message Claude on <Device>".
- Reconnecting / Offline (15, 16): transcript stays readable, rows dim, sending blocked with a one-line banner and Retry.
- Provenance (17): every Message from another Device carries a sender line ("From you · <Device>" or "From an Agent ·
  <Device> · asked under its <mode>"); replying is the user's call.
- Human P2P (18): top bar ⋯ > "Send to another Session…", targets grouped by Device, offline targets disabled,
  "Start a new Session in…", with a Provenance preview. An accepted exception to "⋯ is Session actions only".
- Settings > Devices (19): the only home for the hosting toggle, pairing code, paired Devices with Allow Agents from
  this Device and Unpair, nearby discovery with code entry, and manual address. No ambient discovery UI elsewhere.
- Renderer effects run through `EffectRuntime` and `DesktopApi`; Helm components, theme tokens and en/es i18n apply.

## Testing Decisions

Source: [Define verification strategy and per-Agent Qualification for cross-device features](https://github.com/ManuelUsoz/spence/issues/178).
Test externally observable behaviour, not internals; reuse existing boundaries.

- **Fake LAN.** Transport and integration specs under `electron/**` run two in-process Devices (two `MainRuntime`s,
  own temp `userData`, `bonjour` stubbed, real `wss://` on loopback ephemeral ports) through a shared helper
  `electron/devices/test-peer.ts`. A scripted raw `ws` client covers only protocol abuse a real peer cannot produce:
  malformed frames, bad `protocolVersion`, wrong fingerprint, stale token.
- **Faults, deterministically.** The test peer offers `dropConnection()` and `partition()/heal()`; backoff runs on
  Effect `TestClock`; suspend/resume is injected through the existing electron-fake seam, asserting re-bind,
  re-announce and immediate viewer reconnect, and `afterSeq` resumption without gaps or duplicates. Real-OS
  sleep/wake is a manual line in the qualification record, never CI.
- **e2e (`e2e/devices/`, one spec per flow, with screenshots).** A `spence.peer()` fixture in `e2e/fixtures.ts`
  launches a second Electron instance (own data dir, `SPENCE_E2E=1`, loopback, manual `host:port`, no mDNS). Flows:
  pairing via Settings > Devices; Remote Project grouping and Device chip; Offline/Reconnecting banners; Provenance on
  a Cross-device message; Send to another Session; a Remote Session run end to end with the fake Agent.
- **Transport-spec only:** token revocation edge cases, hop limit and cycle rejection, `Assets.read` cap and LRU,
  `Folders.browse`, protocol refusal, host quit-confirmation counting, allow-list (a `RemoteRpcs` peer cannot call
  `Tabs`, `Links`, `Devices` or UI Settings).
- **Gates.** No new verify step. Add `layerDevicesUnused` and `layerRemoteUnused` (handlers that `Effect.die`) to
  `makeDesktopTestLayer` in `src/app/core/desktop-layers.ts`. Add a lint rule: only `electron/lan/**` and
  `electron/devices/**` import `ws`, `bonjour-service` or `node:tls`; `src/**` never does. `npm run verify` stays
  loopback-only and opens no real multicast socket; a live `electron/lan/**` spec runs only with `SPENCE_LAN_LIVE=1`.
  `npm run e2e` includes `e2e/devices/`. i18n: every new string, including the main-process quit strings in en/es.
- **Per-Agent Qualification (parity matrix).** The bar is everything a regular chat offers, run in a Remote Session from
  the viewer: the existing Session/Worker tools, the four cross-device tools, Permission prompts (Allow once / Always
  allow / Deny), Queue and steer, images and assets, Skills and Commands, file and diff views. Each case asserts the
  same outcome as Local, except the decided Local-only items (UI preferences).
  - CI: the fake ACP Agent runs one shared case table, each case once Local and once Remote, asserting identical
    Transcripts apart from Provenance fields. A spec diffs the table against the local capability list, so a new
    regular-chat capability without a parity row fails.
  - Live: opt-in `SPENCE_*_ACP_BIN` probes run the same matrix per Agent. Results go in
    `docs/qualification/cross-device-<agent>.md`, one row per case (Pass / Fail / Unproven), in the format of
    `docs/qualification/rich-chat-composer.md`. "Qualified for cross-device" only when every row passes for an exact
    adapter version. Live runs are never a CI gate.
  - An Agent that cannot carry the tools is not blocked from Remote device access or human-initiated messaging. The
    four cross-device tools are withheld from its Sessions only when the adapter demonstrably cannot take MCP tools
    (no half-working state); the Agent picker notes "No cross-device tools" and its qualification doc records the
    limitation. A capable but unqualified Agent gets the tools, labelled "not qualified" in docs only: qualification
    status never changes behaviour.
- Run `npm run verify` and `npm run e2e` after implementation.

## Out of Scope

- WAN or internet connectivity (SSH tunnelling, Tailscale, Cloudflare tunnels, cloud relays).
- Phone, tablet or standalone web-browser clients.
- Multi-master Store or Transcript replication across Devices.
- Login items or autostart for the host; store-and-forward outboxes; rate limiters; per-call tokens or per-group permissions.
- Negotiated protocol versions or compatibility shims; an allow-list for Remote folder browsing.
- Global cross-Device "Needs you" list; completion toasts or dock badges for Remote activity.

## Further Notes

- No ADR was written: the decisions are reversible while unimplemented. Revisit if pairing tokens or the RPC
  allow-list ship and become costly to change.
- Unverified on-device caveats from the transport research (implementation must test them): Windows Defender
  Firewall prompts for UDP 5353 and binary-name resets between `electron.exe` and the packaged exe; macOS Local
  Network privacy prompt and notarization/entitlements; Linux `avahi-daemon` socket sharing and `ufw`/`firewalld`
  rules; multi-NIC, VPN and WSL adapter selection; Linux `safeStorage` without a keyring.
- Electron 45.3.0 deprecates synchronous `safeStorage`; use the async API after `app.whenReady()` and handle `shouldReEncrypt`.
- Roadmap item 3 (cross-session messaging between Projects) is the Local precursor of the P2P primitives.
- The first single-file HTML UI prototype was rejected; the accepted design is the calm canvas boards 13 to 19. The
  prototype branch `prototype/lan-devices-ui` is never merged.
