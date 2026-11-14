import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { Agents, layerAgents } from './agents';
import { layerPathSources, MergedPath } from './merged-path';

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

const installPackageJson = (pkg: string, version: string) =>
  Effect.promise(async () => {
    const dir = join(bin, 'node_modules', ...pkg.split('/'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: pkg, version }));
  });

const layerTest = () =>
  layerAgents.pipe(
    Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed(bin) })),
    Layer.provide(layerPathSources),
  );

const agentById = (id: string) =>
  Agents.use((agents) => agents.list).pipe(Effect.map((list) => list.find((a) => a.id === id)));

describe('Agents.list', () => {
  it.effect('lists Claude, Codex (npm) and Antigravity (native) as not installed when absent', () =>
    Effect.gen(function* () {
      const list = yield* Agents.use((agents) => agents.list);
      expect(
        list.map((a) => ({
          id: a.id,
          name: a.name,
          installKind: a.installKind,
          installed: a.installed,
        })),
      ).toEqual([
        { id: 'claude', name: 'Claude', installKind: 'npm', installed: false },
        { id: 'codex', name: 'Codex', installKind: 'npm', installed: false },
        { id: 'antigravity', name: 'Antigravity', installKind: 'native', installed: false },
      ]);
      const agy = list.find((a) => a.id === 'antigravity');
      expect(agy?.installInstructions).toContain('agy');
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect(
    'reports each Agent installed once its binary is on PATH and reads npm package.json statically',
    () =>
      Effect.gen(function* () {
        expect((yield* agentById('claude'))?.installed).toBe(false);
        yield* install(`claude-agent-acp${shim}`);
        yield* installPackageJson('@agentclientprotocol/claude-agent-acp', '0.106.0');
        const claude = yield* agentById('claude');
        expect(claude?.installed).toBe(true);
        expect(claude?.installedVersion).toBe('0.106.0');
        expect(claude?.versionQualification).toBe('qualified');

        yield* install(`codex-acp${shim}`);
        yield* installPackageJson('@agentclientprotocol/codex-acp', '2.5.0');
        const codex = yield* agentById('codex');
        expect(codex?.installed).toBe(true);
        expect(codex?.installedVersion).toBe('2.5.0');
        expect(codex?.versionQualification).toBe('unverified');
        expect(codex?.upgradeCommand).toContain('@agentclientprotocol/codex-acp@2.6.0');

        yield* install(`agy${shim}`);
        const agy = yield* agentById('antigravity');
        expect(agy?.installed).toBe(true);
        // Native discovery on Agents.list never spawns `agy --version` at startup.
        expect(agy?.installedVersion).toBeUndefined();
      }).pipe(Effect.provide(layerTest())),
  );

  it.effect('never counts the vendor CLI or CODEX_PATH override for packaged adapters', () =>
    Effect.gen(function* () {
      const priorCodexPath = process.env['CODEX_PATH'];
      const customCodex = join(
        bin,
        process.platform === 'win32' ? 'custom-codex.exe' : 'custom-codex',
      );
      yield* install(process.platform === 'win32' ? 'claude.exe' : 'claude');
      yield* install(process.platform === 'win32' ? 'codex.exe' : 'codex');
      yield* install(process.platform === 'win32' ? 'custom-codex.exe' : 'custom-codex');
      process.env['CODEX_PATH'] = customCodex;
      try {
        expect((yield* agentById('claude'))?.installed).toBe(false);
        expect((yield* agentById('codex'))?.installed).toBe(false);
      } finally {
        if (priorCodexPath === undefined) delete process.env['CODEX_PATH'];
        else process.env['CODEX_PATH'] = priorCodexPath;
      }
    }).pipe(Effect.provide(layerTest())),
  );
});
