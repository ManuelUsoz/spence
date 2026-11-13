import { Clock, Context, Effect, Layer, Schedule } from 'effect';
import { layerSessionsLive } from '../rpc/sessions';
import { Settings } from '../settings/settings';
import { layerSettingsMain } from '../settings/window';
import { layerSessionStoreLive, SessionStore } from './session-store';
import { Sessions } from './sessions';

export const DAY_MS = 86_400_000;
export const AUTO_ARCHIVE_INTERVAL = '1 hour' as const;

export interface AutoArchiveShape {
  /** Archives kept Sessions older than `autoArchiveDays`, skipping protected Sessions. */
  readonly sweep: Effect.Effect<void>;
}

/** Periodically archives idle Sessions according to the global `autoArchiveDays` Setting. */
export class AutoArchive extends Context.Service<AutoArchive, AutoArchiveShape>()(
  'sessions/AutoArchive',
) {}

export const layerAutoArchive = Layer.effect(
  AutoArchive,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const settings = yield* Settings;
    const store = yield* SessionStore;
    const sessions = yield* Sessions;

    const sweep = Effect.fn('AutoArchive.sweep')(function* () {
      const { autoArchiveDays } = yield* settings.get;
      if (autoArchiveDays === null) return;
      const now = yield* Clock.currentTimeMillis;
      const cutoff = now - autoArchiveDays * DAY_MS;
      const [all, protectedIds] = yield* Effect.all([
        store.listAll,
        sessions.protectedFromAutoArchive,
      ]);
      for (const meta of all) {
        if (meta.archivedAt !== undefined) continue;
        if (protectedIds.has(meta.id)) continue;
        if (meta.lastActivityAt > cutoff) continue;
        yield* sessions
          .archive(meta.id)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(`Auto-archive skipped ${meta.id}: ${error.detail}`),
            ),
          );
      }
    })();

    yield* sweep.pipe(Effect.repeat(Schedule.spaced(AUTO_ARCHIVE_INTERVAL)), Effect.forkIn(scope));

    return AutoArchive.of({ sweep });
  }),
);

export const layerAutoArchiveLive = layerAutoArchive.pipe(
  Layer.provide(Layer.mergeAll(layerSettingsMain, layerSessionStoreLive, layerSessionsLive)),
);
