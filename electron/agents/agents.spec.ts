import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { layerStore } from '../store/store';
import { Agents, layerAgents } from './agents';
import { layerPathSources, MergedPath, PathSources } from './merged-path';
import { AgentRuntime, MANAGED_NODE_VERSION, RuntimeArchiveError } from './runtime';

let bin = '';
let root = '';

beforeEach(async () => {
  bin = await mkdtemp(join(tmpdir(), 'spence-agents-bin-'));
  root = await mkdtemp(join(tmpdir(), 'spence-agents-root-'));
});

afterEach(async () => {
  await rm(bin, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

const shim = process.platform === 'win32' ? '.cmd' : '';

const installGlobal = (file: string) =>
  Effect.promise(() => writeFile(join(bin, file), '', { mode: 0o755 }));

const installGlobalPackageJson = (pkg: string, version: string) =>
  Effect.promise(async () => {
    const dir = join(bin, 'node_modules', ...pkg.split('/'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: pkg, version }));
  });

const installManagedAdapter = (agentId: string, pkg: string, binary: string, version: string) =>
  Effect.promise(async () => {
    const pkgDir = join(root, 'agents', agentId, 'node_modules', ...pkg.split('/'));
    await mkdir(join(pkgDir, 'bin'), { recursive: true });
    await writeFile(join(pkgDir, 'bin', `${binary}.js`), '#!/usr/bin/env node\n');
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: pkg, version, bin: { [binary]: `./bin/${binary}.js` } }),
    );
  });

const makeRuntimeLayer = (ready: boolean) =>
  Layer.succeed(AgentRuntime, {
    inspect: Effect.succeed(
      ready
        ? Option.some({
            version: MANAGED_NODE_VERSION,
            dir: join(root, 'runtime', `node-${MANAGED_NODE_VERSION}`),
            node: process.execPath,
            npmCli: join(root, 'runtime', 'npm-cli.js'),
          })
        : Option.none(),
    ),
    ensure: Effect.fail(
      new RuntimeArchiveError({ reason: 'DownloadFailed', detail: 'unused in Agents.list' }),
    ),
  });

const layerTest = (options?: {
  readonly runtimeReady?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}) =>
  layerAgents.pipe(
    Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed(bin) })),
    Layer.provide(
      options?.env === undefined
        ? layerPathSources
        : Layer.succeed(PathSources, {
            platform: process.platform,
            env: options.env,
            readRegistryPath: () => Effect.succeed(Option.none()),
            readLoginShellPath: Effect.succeed(Option.none()),
          }),
    ),
    Layer.provide(layerStore(root)),
    Layer.provide(makeRuntimeLayer(options?.runtimeReady ?? true)),
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
    'ignores global Merged PATH installs for packaged npm Agents and resolves exclusively from managed dir',
    () =>
      Effect.gen(function* () {
        yield* installGlobal(`claude-agent-acp${shim}`);
        yield* installGlobalPackageJson('@agentclientprotocol/claude-agent-acp', '0.106.0');
        yield* installGlobal(`codex-acp${shim}`);
        yield* installGlobalPackageJson('@agentclientprotocol/codex-acp', '2.6.0');

        expect((yield* agentById('claude'))?.installed).toBe(false);
        expect((yield* agentById('codex'))?.installed).toBe(false);

        yield* installManagedAdapter(
          'claude',
          '@agentclientprotocol/claude-agent-acp',
          'claude-agent-acp',
          '0.106.0',
        );
        const claude = yield* agentById('claude');
        expect(claude?.installed).toBe(true);
        expect(claude?.installedVersion).toBe('0.106.0');
        expect(claude?.versionQualification).toBe('qualified');
        expect(claude?.upgradeCommand).not.toContain('npm install -g');

        yield* installManagedAdapter(
          'codex',
          '@agentclientprotocol/codex-acp',
          'codex-acp',
          '2.5.0',
        );
        const codex = yield* agentById('codex');
        expect(codex?.installed).toBe(true);
        expect(codex?.installedVersion).toBe('2.5.0');
        expect(codex?.versionQualification).toBe('unverified');
        expect(codex?.upgradeCommand).toBe('@agentclientprotocol/codex-acp@2.6.0');

        yield* installGlobal(`agy${shim}`);
        const agy = yield* agentById('antigravity');
        expect(agy?.installed).toBe(true);
        // Native discovery on Agents.list never spawns `agy --version` at startup.
        expect(agy?.installedVersion).toBeUndefined();
      }).pipe(Effect.provide(layerTest())),
  );

  it.effect('marks packaged npm Agents not installed when managed runtime is absent', () =>
    Effect.gen(function* () {
      yield* installManagedAdapter(
        'claude',
        '@agentclientprotocol/claude-agent-acp',
        'claude-agent-acp',
        '0.106.0',
      );
      expect((yield* agentById('claude'))?.installed).toBe(false);
    }).pipe(Effect.provide(layerTest({ runtimeReady: false }))),
  );

  it.effect('honours SPENCE_E2E=1 fake/path override for npm Agents in E2E mode', () =>
    Effect.gen(function* () {
      yield* installGlobal(`claude-agent-acp${shim}`);
      yield* installGlobalPackageJson('@agentclientprotocol/claude-agent-acp', '0.105.0');
      const claude = yield* agentById('claude');
      expect(claude?.installed).toBe(true);
      expect(claude?.installedVersion).toBe('0.105.0');
      expect(claude?.versionQualification).toBe('unverified');
    }).pipe(
      Effect.provide(
        layerTest({
          runtimeReady: false,
          env: { ...process.env, SPENCE_E2E: '1', SPENCE_E2E_AGENT_BIN: bin },
        }),
      ),
    ),
  );

  it.effect('never counts the vendor CLI or CODEX_PATH override for packaged adapters', () =>
    Effect.gen(function* () {
      const priorCodexPath = process.env['CODEX_PATH'];
      const customCodex = join(
        bin,
        process.platform === 'win32' ? 'custom-codex.exe' : 'custom-codex',
      );
      yield* installGlobal(process.platform === 'win32' ? 'claude.exe' : 'claude');
      yield* installGlobal(process.platform === 'win32' ? 'codex.exe' : 'codex');
      yield* installGlobal(process.platform === 'win32' ? 'custom-codex.exe' : 'custom-codex');
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

  it.effect(
    'never exposes npm install -g in upgradeCommand for packaged npm Agents and keeps native Antigravity copy',
    () =>
      Effect.gen(function* () {
        const list = yield* Agents.use((agents) => agents.list);
        for (const agent of list) {
          if (agent.installKind === 'npm') {
            expect(agent.upgradeCommand ?? '').not.toContain('npm install -g');
          } else {
            expect(agent.upgradeCommand).toContain('Antigravity');
          }
        }
      }).pipe(Effect.provide(layerTest())),
  );
});
