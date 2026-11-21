import { app } from 'electron';
import { Effect, Stream } from 'effect';
import { UpdatesRpcs } from '../../src/shared/updates/updates.rpc';
import { Updates } from '../updates/updater';

/**
 * The window's updater handlers. Installing is a Local operation: a Paired device never updates this machine.
 * Restarting asks main to quit; quitting stops the Agents and honours the existing confirm first.
 */
export const layerUpdatesHandlers = UpdatesRpcs.toLayer({
  'Updates.watch': () => Stream.unwrap(Updates.use((updates) => Effect.succeed(updates.watch))),
  'Updates.check': () => Updates.use((updates) => updates.check),
  'Updates.download': () => Updates.use((updates) => updates.download),
  'Updates.restart': () =>
    Updates.use((updates) => updates.restart.pipe(Effect.andThen(Effect.sync(() => app.quit())))),
});
