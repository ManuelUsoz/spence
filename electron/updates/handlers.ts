import { Effect, Stream } from 'effect';
import { UpdatesRpcs } from '../../src/shared/updates/updates.rpc';
import { Updates } from './updater';

/**
 * Builds the `UpdatesRpcs` handler layer around an injected `quit` edge, so RPC boundary tests
 * exercise the real contract without Electron's `app`.
 */
export const makeUpdatesHandlers = (quit: () => void) =>
  UpdatesRpcs.toLayer({
    'Updates.watch': () => Stream.unwrap(Updates.use((updates) => Effect.succeed(updates.watch))),
    'Updates.check': () => Updates.use((updates) => updates.check),
    'Updates.download': () => Updates.use((updates) => updates.download),
    'Updates.restart': () =>
      Updates.use((updates) => updates.restart.pipe(Effect.andThen(Effect.sync(quit)))),
  });
