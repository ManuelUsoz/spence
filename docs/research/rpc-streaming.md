# Research: streaming session events from main to renderer over Effect RPC

Ticket: #4 (map #1). Question: how does Effect 4.1.3 RPC stream results, and does it work over Spence's
MessagePort protocol with `layerSchemaBinary`? Covers backpressure, interruption from the renderer, reconnect
after a renderer reload, and testing with `makeDesktopTestLayer`.

Sources: the installed `effect@4.1.3` source (`node_modules/effect/src/rpc/*`, `PubSub.ts`, `Stream.ts`), this
repo's transport (`src/shared/rpc/message-port-protocol.ts`, `electron/rpc/ipc-server.ts`,
`src/app/core/desktop-layers.ts`), the Electron `MessagePortMain` docs, and a spike that runs on this branch:
`electron/rpc/streaming.spike.spec.ts` (`npx vitest run electron/rpc/streaming.spike.spec.ts`, 6/6 passing).
The spike wires the real `layerIpcServer` and `layerClientProtocol` together over a Node `MessageChannel`.

## Answer in one paragraph

Yes. `Rpc.make(tag, { success, error, stream: true })` declares a streaming RPC. The handler returns a `Stream`
(or an `Effect` of a `Queue.Dequeue`), and the client call returns a `Stream` (or a scoped `Queue` with
`asQueue: true`). Spence's transport handles it with no changes to the server, because both sides set
`supportsAck: true`: every chunk waits for the client's `Ack`, which gives end-to-end backpressure. Interrupting
the consumer sends `Interrupt`, and the handler fiber in main is interrupted. A reload binds a new port, which
disconnects the old client and interrupts its streams. Nothing resumes on its own: the renderer must subscribe
again, and replay has to come from Spence (its transcript plus a sequence number). The spike found one bug in
`makeClientProtocol`: it hardcodes client id `0` (see "Latent bug" below).

## 1. Declaring and serving a stream

- `Rpc.make` with `stream: true` wraps `success`/`error` in `RpcSchema.Stream(success, error)` and sets the RPC's
  own `errorSchema` to `Schema.Never`. Typed failures therefore become stream failures, which still reach the
  client as typed errors. Source: `effect/src/rpc/Rpc.ts` `make` (around lines 960-1025),
  `RpcSchema.ts` `Stream`.
- Handler result type (`Rpc.ResultFrom`, `Rpc.ts` around line 790): `Stream<A, E | middleware errors>` or
  `Effect<Queue.Dequeue<A, E | Cause.Done>, E, Scope>`.
- Client result type (`RpcClient.ts` `RpcClient.Result`, lines 160-195): a `Stream<A, E | RpcClientError>` by
  default. With `{ asQueue: true }` it is `Effect<Queue.Dequeue<…>, never, Scope>`. The options are
  `streamBufferSize` (default **16**) and `headers`. `discard` is not available for streams.
- Wire messages (`RpcMessage.ts`): `Request` → repeated `Chunk { requestId, values: NonEmptyArray }` → `Exit`.
  The client sends an `Ack` after each chunk and an `Interrupt` if it stops early.
- Encoding: the server encodes each chunk with `codecFor(Schema.NonEmptyArray(streamSuccessSchema))`
  (`RpcServer.ts` around line 549), and the client decodes with the same codec (`RpcClient.ts` around line 846).
  `layerSchemaBinary` uses `SchemaBinary.toCodecDirect`, and with `includesFraming: true` one port message is
  one frame. Default max frame size is **16 MiB** (`RpcSerialization.ts` around line 586). A chunk is one frame,
  so very large batched chunks are the only way to hit the limit.
- Verified in the spike: 50 `Schema.Class` events with a `Schema.DateTimeUtc` field round-trip through
  `layerSchemaBinary` and decode back into class instances. A typed `SpikeError` raised after 3 elements arrives as
  3 elements followed by the typed failure (`catchTag`-able).

## 2. Backpressure

- Server (`RpcServer.ts` `streamEffect`, around lines 457-511): with acks enabled, each request gets a `Latch`.
  `Stream.runForEachArray` writes one chunk, holding **whatever the upstream already has ready**, then closes the
  latch and waits until the client's `Ack` opens it again. Only one un-acked chunk is ever in flight per stream.
- Client (`RpcClient.ts` `write`, case `"Chunk"`, around lines 565-580): `Queue.offerAll` into a
  `Queue.bounded(streamBufferSize)` runs first, and the `Ack` is sent only after the offer completes. A full
  buffer therefore suspends the offer, holds back the ack, and stalls the server-side pull.
- Both of Spence's protocol halves declare `supportsAck: true` (`message-port-protocol.ts`, `ipc-server.ts`), so
  this behaviour is on.
- Measured in the spike: with an unread `asQueue` stream and `streamBufferSize: 4`, an infinite producer in main
  stops after exactly **5** elements (4 buffered + 1 chunk waiting for its ack). It resumes once the renderer
  takes an element.
- **Design consequence:** backpressure reaches only the `Stream` the handler returns. If that stream reads from
  a session hub (`PubSub`), the hub's strategy decides what a slow or stuck renderer does to the ACP adapter.
  `PubSub.bounded` (backpressure) would block the publisher, and so the Agent pipeline. `dropping`/`sliding`
  lose events. `unbounded` grows memory. For session events, use an unbounded (or generously sized sliding) hub
  per Session and keep the ACP read loop independent of renderer consumption. Recovery should use the transcript
  and sequence numbers, not lossless delivery. `PubSub.unbounded({ replay?: n })` also offers a replay window
  for late subscribers (`PubSub.ts` around line 520).
- Cost: one port round trip per chunk. Because the chunk is "everything ready", bursts are batched
  automatically, so this cost is negligible for chat-sized event rates.

## 3. Interruption from the renderer (stop, tab close)

- The client registers a scope finalizer per stream request (`RpcClient.ts` `onStreamRequest`, around lines
  455-470). When the consuming fiber ends early (interrupted, `Stream.take`, scope closed), it shuts the queue down
  and sends `Interrupt` (`sendInterrupt`, which gives up after 1 s).
- The server interrupts the handler fiber, annotated with `RpcSchema.ClientAbort` (`RpcServer.ts` `write`, case
  `"Interrupt"`, around line 223). Finalizers in the handler stream (`Stream.onExit`, `ensuring`, scoped
  `PubSub.subscribe`) run.
- Verified in the spike: interrupting a `Stream.runDrain` fiber and ending with `Stream.take(3)` both interrupt
  the infinite producer in main within 1 s.
- In Angular: run the subscription with `EffectRuntime.run(Stream.runForEach(api['Session.events'](…), e =>
  Effect.sync(() => signal.update(…))), { signal })`. Abort the `AbortController` in `DestroyRef.onDestroy`, when
  a tab closes, or when the user leaves. `run` already accepts `signal` (`effect-runtime.ts`).
- **"Stop" (cancelling the Agent's turn) is not the same as unsubscribing.** Interrupting the events stream must
  only detach the viewer. The session hub and the ACP session live in a main-side service, not in the handler
  fiber. Stop should be a separate RPC (for example `Session.cancel`) that maps to ACP `session/cancel`.

## 4. Reconnect after a renderer reload

- Main: on reload the renderer calls `desktop.connect()` again. `RpcPortHandoff.bind` replaces the current port,
  closes it, and offers the old client id to `disconnects` (`ipc-server.ts` `bindPort`). A destroyed
  `webContents` also fires the `MessagePortMain` `'close'` event, which does the same thing
  (https://www.electronjs.org/docs/latest/api/message-port-main#event-close). `RpcServer.make` consumes
  `disconnects` and calls `server.disconnect(clientId)`, which interrupts every fiber of that client, streams
  included (`RpcServer.ts` `disconnect` around line 183 and the loop around line 774).
- Verified in the spike: binding a second port interrupts the first client's infinite stream within 1 s, and
  the new client can subscribe and receive events immediately.
- Renderer: a reload discards the JS realm, the `ManagedRuntime` and all client state. There is no RPC-level
  resume. After reload, the feature subscribes again. To avoid gaps or duplicates, the contract should carry a
  per-Session monotonic `seq`:
  `Session.events({ sessionId, afterSeq? })` → `Stream<SessionEvent>`. The handler subscribes to the hub
  **first** (scoped `PubSub.subscribe`), then reads the transcript after `afterSeq`, emits it, then emits live
  events and drops any with `seq` already emitted. Subscribing after reading the snapshot loses the events
  published in between.
- Caveat (spike): if main ever replaces the port while the old renderer realm is still alive, the old client
  is never told. Spence's `makeClientProtocol` does not listen for port close, so the old client's streams hang
  forever. That does not happen today, because a reload kills the old realm. If the renderer ever reconnects
  without a reload, it must also rebuild the client (dispose the runtime) or end in-flight requests with a
  `ClientProtocolError`.

## 5. Latent bug found by the spike: client id hardcoded to 0

`makeClientProtocol` calls `writeResponse(0, response)`. `RpcClient.make` takes its id from a module-global
`clientIdCounter++` (`RpcClient.ts` lines 626 and 659). Only the first `RpcClient` created in a JS realm is id
0. Any later client over this protocol (a second runtime, a re-created layer, or a test that builds two clients)
sends requests that main answers, but the responses are routed to a non-existent client id and every call
hangs. Production works today only because the renderer builds exactly one client per page load. The spike
reproduced this: every test after the first one timed out until it was fixed.

Fix (applied on this branch, as Effect's own socket protocol does): record the ids seen in `send` and deliver
each response to them.

```ts
const clientIds = new Set<number>();
// onMessage: for (const clientId of clientIds) Effect.runFork(writeResponse(clientId, response));
// send: (clientId, request) => Effect.sync(() => { clientIds.add(clientId); … })
```

This should land on main as its own small change, whatever the session-view decisions are.

## 6. Testing streaming RPCs

- `makeDesktopTestLayer(handlers)` uses `RpcTest.makeClient`, which wires `RpcServer.makeNoSerialization` to
  `RpcClient.makeNoSerialization` with `supportsAck: true` (`RpcTest.ts`). Streams, acks, interrupts and typed
  stream errors behave as in production, so a renderer spec can do:

  ```ts
  it.effect('shows events', () =>
    Effect.gen(function* () {
      const api = yield* DesktopApi;
      const events = yield* Stream.runCollect(api['Session.events']({ sessionId }).pipe(Stream.take(2)));
      expect(events.map((e) => e.seq)).toEqual([1, 2]);
    }).pipe(Effect.provide(makeDesktopTestLayer(handlers))));
  ```

  Handlers for the test can be `SessionRpcs.toLayer({ 'Session.events': () => Stream.make(e1, e2) })`, or a
  stream built from a `PubSub` that the test publishes into to simulate live events.
- Limitation: `RpcTest` **skips serialization**, so it never checks that `SessionEvent` survives
  `layerSchemaBinary`. Add one electron-side spec per streaming contract that goes through `layerIpcServer` +
  `layerClientProtocol` over a `MessageChannel`, as the spike does (round trip, typed error, interruption).
- Infinite streams in tests: end them with `Stream.take(n)`. Use `it.live` (or drive `TestClock`) when timing is
  involved. Under `it.effect` the `TestClock` does not advance `Effect.sleep`. Using `Effect.provide(layer)` to
  give a client its protocol layer closes the port as soon as `RpcClient.make` returns, so build the protocol
  layer into the outer scope (`Layer.build`), as the spike does.
- The spike also needs `Layer.build(...)` + `Context` lookup to get `RpcPortHandoff`. Production does the same
  through `MainRuntime`.

## Decision-relevant summary

1. `stream: true` RPCs work unchanged over Spence's MessagePort protocol + `layerSchemaBinary` (spike: 6/6).
2. Typed stream errors arrive after the elements emitted before them, and are matchable by tag.
3. Backpressure is end to end: one un-acked chunk per stream, plus a client buffer (`streamBufferSize`,
   default 16). An unread stream parks the handler in main.
4. Therefore decouple the ACP read loop from viewers: a per-Session hub (unbounded/sliding `PubSub`) in a
   main-side service. Never use a backpressuring hub, which would let a stuck renderer stall the Agent.
5. Unsubscribing (tab close or leaving) = interrupt the client fiber → `Interrupt` → handler interrupted. "Stop"
   the Agent must be a separate RPC, not a stream interrupt.
6. Reload = new port → old client disconnected → its streams interrupted in main. No automatic resume: the
   renderer subscribes again with `afterSeq`, and main replays from its transcript before going live
   (subscribe to the hub before reading the snapshot).
7. Bug to fix on main: `makeClientProtocol` hardcodes client id 0 (fix on this branch).
8. Tests: `makeDesktopTestLayer` covers stream semantics but not serialization. Add one electron-side
   MessageChannel round-trip spec per streaming contract.
