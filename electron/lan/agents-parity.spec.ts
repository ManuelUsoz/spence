/**
 * LAN parity for managed Agent Set up and Update over real loopback `wss://` (`TestDevice` + `RemoteRpcs` +
 * `DEVICE_SCOPE_HEADER`). Verifies that Set up and Update run on the target Remote device in its own
 * `<userData>/spence/` directory without touching the viewer's store, and that a failed Update preserves the
 * Remote device's prior working install.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option, Stream } from 'effect';
import { RpcClient } from 'effect/rpc';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { DEVICE_SCOPE_HEADER } from '../../src/shared/devices/devices.rpc';
import { layerAgents } from '../agents/agents';
import { layerAgentInstall } from '../agents/install';
import { makeMergedPathTestLayer, PathSources } from '../agents/merged-path';
import {
  layerAgentRuntime,
  MANAGED_NODE_VERSION,
  RuntimeArchiveSource,
  runtimeSpecFor,
} from '../agents/runtime';
import { makeTestDevice, pairDevices, tempDataDir } from '../devices/test-peer';
import { layerAgentsHandlersWith } from '../rpc/agents';
import { layerStore } from '../store/store';

const TIMEOUT = 60_000;
const isWindows = process.platform === 'win32';

const claude = AgentId.make('claude');
const codex = AgentId.make('codex');

let fixtures = '';
let archivePath = '';
let archiveSha256 = '';
let specFilename = '';

beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), 'spence-lan-agents-fix-'));
  const spec = runtimeSpecFor(MANAGED_NODE_VERSION, process.platform, process.arch);
  if (spec === undefined) {
    throw new Error(`Unsupported test host: ${process.platform}/${process.arch}`);
  }
  specFilename = spec.filename;
  const folderName = spec.filename.replace(/\.(tar\.gz|zip)$/, '');
  const stage = join(fixtures, 'src');
  const top = join(stage, folderName);
  const npmDir = isWindows
    ? join(top, 'node_modules', 'npm', 'bin')
    : join(top, 'lib', 'node_modules', 'npm', 'bin');
  await mkdir(join(top, isWindows ? '' : 'bin'), { recursive: true });
  await mkdir(npmDir, { recursive: true });

  if (isWindows) {
    await copyFile(process.execPath, join(top, 'node.exe'));
  } else {
    await writeFile(join(top, 'bin', 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, {
      mode: 0o755,
    });
  }

  const stubNpmCli = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const args = process.argv.slice(2);',
    "const prefixIdx = args.indexOf('--prefix');",
    "const prefix = prefixIdx >= 0 ? args[prefixIdx + 1] : '';",
    "const pkgSpec = args[args.length - 1] ?? '';",
    "const atIdx = pkgSpec.lastIndexOf('@');",
    'const pkgName = atIdx > 0 ? pkgSpec.slice(0, atIdx) : pkgSpec;',
    "const pkgVersion = atIdx > 0 ? pkgSpec.slice(atIdx + 1) : '1.0.0';",
    "if (process.env.SPENCE_LAN_STUB_NPM_FAIL === '1') {",
    "  process.stderr.write('npm error 404 Not Found - offline\\n');",
    '  process.exit(1);',
    '}',
    "const binName = pkgName.includes('codex') ? 'codex-acp' : 'claude-agent-acp';",
    "const pkgDir = path.join(prefix, 'node_modules', ...pkgName.split('/'));",
    "fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });",
    "fs.writeFileSync(path.join(pkgDir, 'bin', `${binName}.js`), '#!/usr/bin/env node\\n');",
    'fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: pkgName, version: pkgVersion, bin: { [binName]: `./bin/${binName}.js` } }));',
    "process.stdout.write('added 1 package\\n');",
  ].join('\n');
  await writeFile(join(npmDir, 'npm-cli.js'), stubNpmCli);

  archivePath = join(fixtures, spec.filename);
  const tarCmd = isWindows ? 'tar.exe' : 'tar';
  const tarArgs = isWindows
    ? [
        '--format=zip',
        '--options',
        'zip:compression=store',
        '-cf',
        archivePath,
        '-C',
        stage,
        folderName,
      ]
    : ['-czf', archivePath, '-C', stage, folderName];
  const res = spawnSync(tarCmd, tarArgs, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`tar fixture failed (${res.status}): ${res.stderr}`);
  }
  const bytes = await readFile(archivePath);
  archiveSha256 = createHash('sha256').update(bytes).digest('hex');
});

afterAll(async () => {
  await rm(fixtures, { recursive: true, force: true });
});

const makeAgentDevice = Effect.fnUntraced(function* (envOverride?: Record<string, string>) {
  const root = yield* tempDataDir;
  const store = layerStore(root);
  const pathSources = Layer.succeed(PathSources, {
    platform: process.platform,
    env: { ...process.env, ...(envOverride ?? {}) },
    readRegistryPath: () => Effect.succeed(Option.none()),
    readLoginShellPath: Effect.succeed(Option.none()),
  });
  const mergedPath = makeMergedPathTestLayer('');
  const archiveSource = Layer.succeed(RuntimeArchiveSource, {
    fetch: (_spec, destPath) =>
      Effect.promise(async () => {
        await copyFile(archivePath, destPath);
        return { shasumsText: `${archiveSha256}  ${specFilename}\n` };
      }),
  });
  const runtime = layerAgentRuntime.pipe(
    Layer.provideMerge(archiveSource),
    Layer.provideMerge(store),
    Layer.provideMerge(pathSources),
  );
  const agents = layerAgents.pipe(
    Layer.provideMerge(mergedPath),
    Layer.provideMerge(pathSources),
    Layer.provideMerge(store),
    Layer.provideMerge(runtime),
  );
  const install = layerAgentInstall.pipe(
    Layer.provideMerge(agents),
    Layer.provideMerge(runtime),
    Layer.provideMerge(store),
    Layer.provideMerge(mergedPath),
    Layer.provideMerge(pathSources),
  );
  const serve = layerAgentsHandlersWith.pipe(
    Layer.provide(install),
    Layer.provide(agents),
    Layer.provide(runtime),
    Layer.provide(store),
    Layer.provide(mergedPath),
    Layer.provide(pathSources),
  );
  const device = yield* makeTestDevice({ serve });
  return { device, root };
});

describe('Remote device Agent Set up and Update parity', () => {
  it.live(
    'runs Set up and Update on a Remote device inside its own store over RemoteRpcs without touching viewer store',
    () =>
      Effect.gen(function* () {
        const host = yield* makeAgentDevice();
        const viewer = yield* makeAgentDevice();
        yield* pairDevices(host.device, viewer.device);
        const hostId = (yield* host.device.identity).id;
        yield* viewer.device.awaitConnection(hostId, 'Online');

        // Seed outdated managed Codex (2.5.0) on host only.
        const codexPkgDir = join(
          host.root,
          'agents',
          'codex',
          'node_modules',
          '@agentclientprotocol',
          'codex-acp',
        );
        yield* Effect.promise(async () => {
          await mkdir(join(codexPkgDir, 'bin'), { recursive: true });
          await writeFile(join(codexPkgDir, 'bin', 'codex-acp.js'), '#!/usr/bin/env node\n');
          await writeFile(
            join(codexPkgDir, 'package.json'),
            JSON.stringify({
              name: '@agentclientprotocol/codex-acp',
              version: '2.5.0',
              bin: { 'codex-acp': './bin/codex-acp.js' },
            }),
          );
        });

        // 1. Set up Claude remotely on host (downloads runtime on host, installs 0.106.0).
        const initialRemote = yield* RpcClient.withHeaders(viewer.device.desktop['Agents.list'](), {
          [DEVICE_SCOPE_HEADER]: hostId,
        });
        expect(initialRemote.find((a) => a.id === claude)?.installed).toBe(false);

        const setupEvents = yield* RpcClient.withHeaders(
          viewer.device.desktop['Agents.install']({ agentId: claude }).pipe(Stream.runCollect),
          { [DEVICE_SCOPE_HEADER]: hostId },
        );
        expect(Array.from(setupEvents).map((e) => e._tag)).toEqual([
          'downloadingRuntime',
          'installingAdapter',
          'succeeded',
        ]);

        const afterSetupRemote = yield* RpcClient.withHeaders(
          viewer.device.desktop['Agents.list'](),
          { [DEVICE_SCOPE_HEADER]: hostId },
        );
        expect(afterSetupRemote.find((a) => a.id === claude)).toMatchObject({
          installed: true,
          installedVersion: '0.106.0',
          versionQualification: 'qualified',
        });
        expect(afterSetupRemote.find((a) => a.id === codex)).toMatchObject({
          installed: true,
          installedVersion: '2.5.0',
          versionQualification: 'unverified',
        });

        // Viewer's local store remains completely untouched.
        const localViewerAgents = yield* viewer.device.desktop['Agents.list']();
        expect(localViewerAgents.find((a) => a.id === claude)?.installed).toBe(false);
        expect(
          yield* Effect.promise(() => readdir(join(viewer.root, 'agents')).catch(() => [])),
        ).toEqual([]);

        // 2. Update outdated Codex (2.5.0 -> 2.6.0) remotely on host.
        const updateEvents = yield* RpcClient.withHeaders(
          viewer.device.desktop['Agents.install']({ agentId: codex }).pipe(Stream.runCollect),
          { [DEVICE_SCOPE_HEADER]: hostId },
        );
        expect(Array.from(updateEvents).map((e) => e._tag)).toEqual([
          'installingAdapter',
          'succeeded',
        ]);

        const afterUpdateRemote = yield* RpcClient.withHeaders(
          viewer.device.desktop['Agents.list'](),
          { [DEVICE_SCOPE_HEADER]: hostId },
        );
        expect(afterUpdateRemote.find((a) => a.id === codex)).toMatchObject({
          installed: true,
          installedVersion: '2.6.0',
          versionQualification: 'qualified',
        });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'preserves Remote device prior working install when remote Update fails',
    () =>
      Effect.gen(function* () {
        const host = yield* makeAgentDevice({ SPENCE_LAN_STUB_NPM_FAIL: '1' });
        const viewer = yield* makeAgentDevice();
        yield* pairDevices(host.device, viewer.device);
        const hostId = (yield* host.device.identity).id;
        yield* viewer.device.awaitConnection(hostId, 'Online');

        const claudePkgDir = join(
          host.root,
          'agents',
          'claude',
          'node_modules',
          '@agentclientprotocol',
          'claude-agent-acp',
        );
        yield* Effect.promise(async () => {
          await mkdir(join(claudePkgDir, 'bin'), { recursive: true });
          await writeFile(
            join(claudePkgDir, 'bin', 'claude-agent-acp.js'),
            '#!/usr/bin/env node\n',
          );
          await writeFile(
            join(claudePkgDir, 'package.json'),
            JSON.stringify({
              name: '@agentclientprotocol/claude-agent-acp',
              version: '0.105.0',
              bin: { 'claude-agent-acp': './bin/claude-agent-acp.js' },
            }),
          );
        });

        const events = yield* RpcClient.withHeaders(
          viewer.device.desktop['Agents.install']({ agentId: claude }).pipe(Stream.runCollect),
          { [DEVICE_SCOPE_HEADER]: hostId },
        );
        expect(Array.from(events).at(-1)).toMatchObject({
          _tag: 'failed',
          reason: 'NpmFailed',
        });

        const remoteAgents = yield* RpcClient.withHeaders(viewer.device.desktop['Agents.list'](), {
          [DEVICE_SCOPE_HEADER]: hostId,
        });
        expect(remoteAgents.find((a) => a.id === claude)).toMatchObject({
          installed: true,
          installedVersion: '0.105.0',
          versionQualification: 'unverified',
        });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});
