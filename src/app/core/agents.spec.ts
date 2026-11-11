import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { AgentId, AgentsRpcs, type Agent } from '../../shared/agents/agents.rpc';
import { DesktopApi } from './desktop-api';
import { makeDesktopTestLayer } from './desktop-layers';

const claude: Agent = {
  id: AgentId.make('claude'),
  name: 'Claude',
  package: '@agentclientprotocol/claude-agent-acp',
  installed: false,
  imageLimits: { maxBase64Bytes: 5_242_880, maxDimensionPx: 8000, maxPerMessage: 20 },
};

const handlers = AgentsRpcs.toLayer({ 'Agents.list': () => Effect.succeed([claude]) });

describe('DesktopApi Agents', () => {
  it.effect(
    'serves Agents.list through the real contract with only the Agents handlers given',
    () =>
      Effect.gen(function* () {
        const api = yield* DesktopApi;
        expect(yield* api['Agents.list']()).toEqual([claude]);
      }).pipe(Effect.provide(makeDesktopTestLayer(handlers))),
  );
});
