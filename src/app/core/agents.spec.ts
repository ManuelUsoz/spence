import { describe, expect, it } from '@effect/vitest';
import { Effect, Stream } from 'effect';
import { AgentId, AgentsRpcs, type Agent } from '../../shared/agents/agents.rpc';
import { DesktopApi } from './desktop-api';
import { makeDesktopTestLayer } from './desktop-layers';

const claude: Agent = {
  id: AgentId.make('claude'),
  name: 'Claude',
  installKind: 'npm',
  package: '@agentclientprotocol/claude-agent-acp',
  installed: false,
  qualifiedVersion: '0.106.0',
  imageLimits: { maxBase64Bytes: 5_242_880, maxDimensionPx: 8000, maxPerMessage: 20 },
  capabilities: {
    models: true,
    effort: true,
    images: true,
    askMode: true,
    resume: true,
    contextUsage: true,
    supportsCompaction: true,
    supportsIsolatedSummary: true,
    modelChangePreservesContext: true,
    crossDeviceTools: true,
  },
};

const handlers = AgentsRpcs.toLayer({
  'Agents.list': () => Effect.succeed([claude]),
  'Agents.rescan': () => Effect.succeed([{ ...claude, installed: true }]),
  'Agents.install': () =>
    Stream.make(
      { _tag: 'downloadingRuntime' } as const,
      { _tag: 'installingAdapter' } as const,
      { _tag: 'succeeded' } as const,
    ),
  'Agents.openInstallLog': () => Effect.void,
});

describe('DesktopApi Agents', () => {
  it.effect(
    'serves Agents.list and Agents.rescan through the real contract with only the Agents handlers given',
    () =>
      Effect.gen(function* () {
        const api = yield* DesktopApi;
        expect(yield* api['Agents.list']()).toEqual([claude]);
        expect(yield* api['Agents.rescan']()).toEqual([{ ...claude, installed: true }]);
      }).pipe(Effect.provide(makeDesktopTestLayer(handlers))),
  );

  it.effect('streams Agents.install events through the real contract', () =>
    Effect.gen(function* () {
      const api = yield* DesktopApi;
      const events = yield* Stream.runCollect(api['Agents.install']({ agentId: claude.id }));
      expect(Array.from(events)).toEqual([
        { _tag: 'downloadingRuntime' },
        { _tag: 'installingAdapter' },
        { _tag: 'succeeded' },
      ]);
    }).pipe(Effect.provide(makeDesktopTestLayer(handlers))),
  );
});
