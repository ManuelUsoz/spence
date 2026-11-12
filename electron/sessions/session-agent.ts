import { Context, Layer } from 'effect';
import type { CatalogEntry } from '../agents/catalog';
import { claude } from '../agents/claude/claude';
import { e2eBin, e2eFakeAgent } from '../agents/e2e-agent';

/** The Agent new Sessions run with: Claude in v1, the fake Agent under e2e. */
export class SessionAgent extends Context.Service<SessionAgent, CatalogEntry>()(
  'sessions/SessionAgent',
) {}

/** The Agent new Sessions run with: Claude, or under e2e the fake Agent. */
export const layerSessionAgentLive = Layer.succeed(
  SessionAgent,
  e2eBin === undefined ? claude : e2eFakeAgent,
);
