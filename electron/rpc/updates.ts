import { app } from 'electron';
import { makeUpdatesHandlers } from '../updates/handlers';

/**
 * The window's updater handlers. Installing is a Local operation: a Paired device never updates this machine.
 * Restarting asks main to quit; quitting stops the Agents and honours the existing confirm first.
 */
export const layerUpdatesHandlers = makeUpdatesHandlers(() => app.quit());
