import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { Agents, layerAgents } from './agents';
import { MergedPath } from './merged-path';

let bin = '';

beforeEach(async () => {
  bin = await mkdtemp(join(tmpdir(), 'spence-agents-'));
});

afterEach(async () => {
  await rm(bin, { recursive: true, force: true });
});

const shim = process.platform === 'win32' ? '.cmd' : '';

const install = (file: string) =>
  Effect.promise(() => writeFile(join(bin, file), '', { mode: 0o755 }));

const layerTest = () =>
  layerAgents.pipe(Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed(bin) })));

const claudeInstalled = Agents.use((agents) => agents.list).pipe(
  Effect.map((list) => list.find((agent) => agent.id === 'claude')?.installed),
);

describe('Agents.list', () => {
  it.effect('lists Claude as not installed when its adapter is not on PATH', () =>
    Effect.gen(function* () {
      const list = yield* Agents.use((agents) => agents.list);
      expect(list).toEqual([
        {
          id: 'claude',
          name: 'Claude',
          package: '@agentclientprotocol/claude-agent-acp',
          installed: false,
          imageLimits: { maxBase64Bytes: 5_242_880, maxDimensionPx: 8000, maxPerMessage: 20 },
        },
      ]);
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect(
    'reports Claude installed once claude-agent-acp is on PATH, re-resolving on every call',
    () =>
      Effect.gen(function* () {
        expect(yield* claudeInstalled).toBe(false);
        yield* install(`claude-agent-acp${shim}`);
        expect(yield* claudeInstalled).toBe(true);
      }).pipe(Effect.provide(layerTest())),
  );

  it.effect('never counts the vendor CLI', () =>
    Effect.gen(function* () {
      yield* install(process.platform === 'win32' ? 'claude.exe' : 'claude');
      expect(yield* claudeInstalled).toBe(false);
    }).pipe(Effect.provide(layerTest())),
  );
});
