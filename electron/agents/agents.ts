import { Context, Effect, Layer, Option } from 'effect';
import type { Agent } from '../../src/shared/agents/agents.rpc';
import { catalog } from './catalog';
import { MergedPath } from './merged-path';
import { resolveExecutable } from './resolve';

/** The Catalog with each Agent's installed state. */
export class Agents extends Context.Service<
  Agents,
  {
    /** Re-resolves every adapter on each call: a few `stat`s, no process is started. */
    readonly list: Effect.Effect<ReadonlyArray<Agent>>;
  }
>()('agents/Agents') {}

export const layerAgents = Layer.effect(
  Agents,
  Effect.gen(function* () {
    const mergedPath = yield* MergedPath;
    const list = Effect.gen(function* () {
      const path = yield* mergedPath.get;
      return yield* Effect.forEach(catalog, (entry) =>
        resolveExecutable(entry.binary, path, process.platform).pipe(
          Effect.map((found): Agent => ({
            id: entry.id,
            name: entry.name,
            package: entry.package,
            installed: Option.isSome(found),
            imageLimits: entry.imageLimits,
          })),
        ),
      );
    });
    return { list };
  }),
);
