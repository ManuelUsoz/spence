# Coding standards

Judgement-call rules, applied at review time. Mechanical rules are enforced by
`npm run lint` (`eslint.config.js`); implementation rules live in `AGENTS.md`.

## Writing effects

- `Effect.gen` for multi-step flows, combinators for single steps.
- Pipeable values use `.pipe(...)`; others use `pipe()` / `flow()`. Avoid nested calls like `f(g(x))`.
- `async`/`await` only at real Promise boundaries (DOM, third-party SDKs), wrapped in `Effect.tryPromise`; domain logic stays in Effect.
- Every effect is returned, yielded, forked into a managed scope, or run at the edge. No floating effects.
- Default to immutable values: `readonly` properties and `ReadonlyArray`.

## Error design

- Typed errors only for failures a caller can act on. Catch non-actionable failures at the service boundary and turn
  them into defects (`Effect.die`, `toWireDefect`); keep the error channel typed, never `unknown`.
- Reuse an existing tagged error when it fits. No generic `XFailed`, `InternalError` or `UnknownError`.

## Services and layers

- Consumers get services from the context; pass no service instances as function arguments.
- Compose with `Layer.provide` / `Layer.merge` and expose only what downstream needs. Keep the production
  constructor reusable so tests can swap dependencies.
- Layers are memoized per runtime: build them once, not per call.

## Structure and boundaries

- Colocate by domain, keep directories flat. Feature code lives with its feature, not in global `shared` modules.
- Wire contracts in `src/shared`, main-only code in `electron/`, renderer-only code in `src/app`.
- An RPC handler is a controller: validate input, delegate to a service, return serializable data.
  No business logic in handlers or the preload.
- Public contract schemas are named and annotated with `.annotate({ identifier: "Name" })`.
- Something two features need becomes a `core` service or a `ui` component, never a feature-to-feature import.

## Angular

- Standalone components, `ChangeDetectionStrategy.OnPush`, signals for state, `inject()` for DI.
- Run effects at UI boundaries through `EffectRuntime.run(...)` and write the result into signals; templates never see effects.
- Loading, failure, empty and success are distinct states. Never show a failure or a load as empty data.
- Tie long-lived streams and subscriptions to `DestroyRef`.

## Testing

- Tests use production composition. Mock only true external boundaries by swapping a layer, never by mocking modules.
- Prefer `@effect/vitest` (`it.effect`, `it.layer`). Time-dependent code uses `TestClock`. No arbitrary sleeps.
- Test behavior and contracts, not implementation. Every bug fix gets a regression test.
- Every user-visible flow gets an e2e spec with `spence.shot(...)` baselines.

## Review checklist

- `npm run verify` prints `verify: OK`.
- No boundary rule was disabled; no new dependency in a zone that the table in `AGENTS.md` forbids.
- New domain: contract, handlers, `DesktopRpcs` merge, `layerXUnused`, a spec through `makeDesktopTestLayer`.
- New UI: comes from `@ui/*`, uses theme variables, has loading / failed / empty / loaded states.
- Any question that gates an action is a modal (`@ui/alert-dialog`), not an inline panel, row, popover or toast;
  destructive confirms name the affected files/counts and the verb.
