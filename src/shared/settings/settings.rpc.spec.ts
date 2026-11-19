import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { RpcSerialization } from 'effect/rpc';
import { AgentId } from '../agents/agents.rpc';
import { layerPortSerialization } from '../rpc/message-port-protocol';
import { Settings, SettingsPatch } from './settings.rpc';

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

const claude = AgentId.make('claude');
const other = AgentId.make('other');

const settings: Settings = {
  language: 'es',
  theme: 'dark',
  notifications: false,
  projectOrder: { by: 'name', direction: 'asc' },
  defaultPermissionMode: 'ask',
  defaultAgent: 'lastUsed',
  autoArchiveDays: 30,
  crossProjectAccess: [],
  filesTreeWidth: 288,
  agents: {
    [claude]: { model: 'opus', effort: 'high', models: [{ id: 'opus', name: 'Opus' }], ran: true },
    [other]: { model: 'lastUsed', effort: 'lastUsed', models: [], ran: false },
  },
};

describe('Settings contract over the wire', () => {
  it('rejects tree widths outside the supported range', () => {
    const decode = Schema.decodeUnknownSync(SettingsPatch);
    expect(() => decode({ filesTreeWidth: 159 })).toThrow();
    expect(() => decode({ filesTreeWidth: 481 })).toThrow();
    expect(() => decode({ filesTreeWidth: 200.5 })).toThrow();
    expect(decode({ filesTreeWidth: 160 })).toEqual({ filesTreeWidth: 160 });
    expect(decode({ filesTreeWidth: 480 })).toEqual({ filesTreeWidth: 480 });
  });
  it.effect('round-trips resolved Settings, Last used and pinned defaults alike', () =>
    Effect.gen(function* () {
      expect(yield* roundTrip(Settings, settings)).toEqual(settings);
      const pinned: Settings = { ...settings, defaultAgent: 'codex' };
      expect(yield* roundTrip(Settings, pinned)).toEqual(pinned);
    }),
  );

  it.effect('round-trips a patch that pins or unpins an Agent default or Default Agent', () =>
    Effect.gen(function* () {
      const pin: SettingsPatch = { agents: { [claude]: { model: 'sonnet' } } };
      const unpin: SettingsPatch = { agents: { [claude]: { model: 'lastUsed', effort: 'max' } } };
      const defaultAgentPatch: SettingsPatch = { defaultAgent: 'lastUsed' };
      expect(yield* roundTrip(SettingsPatch, pin)).toEqual(pin);
      expect(yield* roundTrip(SettingsPatch, unpin)).toEqual(unpin);
      expect(yield* roundTrip(SettingsPatch, defaultAgentPatch)).toEqual(defaultAgentPatch);
    }),
  );
});
