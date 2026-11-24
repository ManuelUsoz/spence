import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { RpcSerialization } from 'effect/rpc';
import { layerPortSerialization } from '../rpc/message-port-protocol';
import { Agent, type AgentCapabilities, AgentId, InstallEvent } from './agents.rpc';

/** Encodes and decodes a value the way the wire does (`layerSchemaBinary`). */
const roundTrip = <
  S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
>(
  schema: S,
  value: S['Type'],
) =>
  Effect.gen(function* () {
    const serialization = yield* RpcSerialization.RpcSerialization;
    const codec = serialization.codecFor(schema);
    const encoded = yield* Schema.encodeEffect(codec)(value);
    return yield* Schema.decodeUnknownEffect(codec)(encoded);
  }).pipe(Effect.provide(layerPortSerialization));

const fullCapabilities: AgentCapabilities = {
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
};

describe('Agents contract over the wire', () => {
  it.effect(
    'round-trips npm and native Agent descriptors with capabilities and version qualification',
    () =>
      Effect.gen(function* () {
        const claude: Agent = {
          id: AgentId.make('claude'),
          name: 'Claude',
          installKind: 'npm',
          package: '@agentclientprotocol/claude-agent-acp',
          installed: true,
          imageLimits: { maxBase64Bytes: 5_242_880, maxDimensionPx: 8000, maxPerMessage: 20 },
          capabilities: fullCapabilities,
          qualifiedVersion: '0.106.0',
          installedVersion: '0.105.0',
          versionQualification: 'unverified',
          upgradeCommand: '@agentclientprotocol/claude-agent-acp@0.106.0',
        };
        const antigravity: Agent = {
          id: AgentId.make('antigravity'),
          name: 'Antigravity',
          installKind: 'native',
          package: '',
          installed: false,
          imageLimits: { maxBase64Bytes: 5_242_880, maxDimensionPx: 8000, maxPerMessage: 20 },
          capabilities: { ...fullCapabilities, askMode: false, supportsCompaction: false },
          qualifiedVersion: '1.2.0',
          installInstructions: 'Install Google Antigravity so `agy` is on your PATH.',
        };
        expect(yield* roundTrip(Agent, claude)).toEqual(claude);
        expect(yield* roundTrip(Agent, antigravity)).toEqual(antigravity);

        const events: ReadonlyArray<InstallEvent> = [
          { _tag: 'downloadingRuntime', startedAt: 1000 },
          { _tag: 'installingAdapter', startedAt: 2000 },
          { _tag: 'succeeded' },
          { _tag: 'cancelled' },
          {
            _tag: 'failed',
            reason: 'ChecksumMismatch',
            detail: 'SHA-256 mismatch',
            logPath: '/data/spence/logs/agents/install.log',
          },
        ];
        for (const event of events) {
          expect(yield* roundTrip(InstallEvent, event)).toEqual(event);
        }
      }),
  );
});
