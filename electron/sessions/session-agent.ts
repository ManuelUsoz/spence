import { Layer } from 'effect';
import { claude } from '../agents/claude/claude';
import { e2eBin, e2eFakeAgent } from '../agents/e2e-agent';
import { SessionAgent } from './sessions';

/** The Agent new Sessions run with: Claude, or under e2e the fake Agent. */
export const layerSessionAgentLive = Layer.succeed(
  SessionAgent,
  e2eBin === undefined ? claude : e2eFakeAgent,
);
