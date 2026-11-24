import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@effect/vitest';
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Scope,
  Stream,
  Context,
} from 'effect';
import { RpcTest } from 'effect/rpc';
import { AgentId, AgentsRpcs } from '../../src/shared/agents/agents.rpc';
import { layerAgentsHandlersWith } from '../rpc/agents';
import { layerStore } from '../store/store';
import { Agents, layerAgents } from './agents';
import { AgentInstall, layerAgentInstall } from './install';
import { makeMergedPathTestLayer, PathSources } from './merged-path';
import {
  AgentRuntime,
  layerAgentRuntime,
  MANAGED_NODE_VERSION,
  type RuntimeArchiveError,
  RuntimeArchiveSource,
  runtimeSpecFor,
} from './runtime';
import { spawnAgent } from './spawn';

let fixtures = '';
let archivePath = '';
let archiveSha256 = '';
let specFilename = '';

const isWindows = process.platform === 'win32';

/**
 * Builds a single local Node runtime fixture archive containing a real launchable `node` binary
 * (POSIX shell wrapper or Windows node.exe) and an `npm-cli.js` stub controlled via `SPENCE_STUB_NPM_MODE`.
 */
beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), 'spence-install-fix-'));
  const spec = runtimeSpecFor(MANAGED_NODE_VERSION, process.platform, process.arch);
  if (spec === undefined)
    throw new Error(`Unsupported test host: ${process.platform}/${process.arch}`);
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
    "process.stdout.write(`args: ${args.join(' ')}\\n`);",
    "process.stdout.write(`env_npm_prefix: ${String(process.env.NPM_CONFIG_PREFIX ?? '')}\\n`);",
    "process.stdout.write(`env_npm_lc: ${String(process.env.npm_config_prefix ?? '')}\\n`);",
    "process.stdout.write(`env_appimage: ${String(process.env.APPIMAGE ?? '')}\\n`);",
    "process.stdout.write(`env_path: ${String(process.env.PATH ?? '')}\\n`);",
    "const mode = process.env.SPENCE_STUB_NPM_MODE ?? 'succeed';",
    "if (mode === 'eacces') {",
    "  process.stderr.write('npm error code EACCES\\n');",
    "  process.stderr.write('npm error syscall mkdir\\n');",
    '  process.stderr.write("npm error Error: EACCES: permission denied, mkdir \'/spence/agents\'\\n");',
    '  process.exit(243);',
    '}',
    "if (mode === 'e404') {",
    "  process.stderr.write('npm error code E404\\n');",
    "  process.stderr.write('npm error 404 Not Found - GET https://registry.npmjs.org/x\\n');",
    '  process.exit(1);',
    '}',
    "if (mode === 'hang') {",
    "  process.stdout.write('STUB_NPM_READY\\n');",
    '  setInterval(() => {}, 1000);',
    "} else if (mode === 'gate') {",
    '  const gateFile = process.env.SPENCE_STUB_NPM_GATE_FILE;',
    "  process.stdout.write('STUB_NPM_READY\\n');",
    '  const timer = setInterval(() => {',
    '    if (gateFile && fs.existsSync(gateFile)) {',
    '      clearInterval(timer);',
    "      const binName = pkgName.includes('codex') ? 'codex-acp' : 'claude-agent-acp';",
    "      const pkgDir = path.join(prefix, 'node_modules', ...pkgName.split('/'));",
    "      fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });",
    "      const scriptPath = path.join(pkgDir, 'bin', `${binName}.js`);",
    '      fs.writeFileSync(scriptPath, `#!/usr/bin/env node\\nconsole.log("ok");\\n`);',
    '      fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: pkgName, version: pkgVersion, bin: { [binName]: `./bin/${binName}.js` } }));',
    "      process.stdout.write('added 1 package\\n');",
    '      process.exit(0);',
    '    }',
    '  }, 20);',
    '} else if (mode === "no-bin") {',
    "  process.stdout.write('added 1 package\\n');",
    '} else {',
    "  const binName = pkgName.includes('codex') ? 'codex-acp' : 'claude-agent-acp';",
    "  const pkgDir = path.join(prefix, 'node_modules', ...pkgName.split('/'));",
    "  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });",
    "  const scriptPath = path.join(pkgDir, 'bin', `${binName}.js`);",
    '  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\\nconsole.log(JSON.stringify({ execPath: process.execPath, path: process.env.PATH }));\\nsetInterval(() => {}, 1000);\\n`);',
    '  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: pkgName, version: pkgVersion, bin: { [binName]: `./bin/${binName}.js` } }));',
    "  process.stdout.write('added 1 package\\n');",
    '}',
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

let bin = '';
let root = '';

beforeEach(async () => {
  bin = await mkdtemp(join(tmpdir(), 'spence-install-bin-'));
  root = await mkdtemp(join(tmpdir(), 'spence-install-root-'));
});

afterEach(async () => {
  await rm(bin, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

const claude = AgentId.make('claude');
const codex = AgentId.make('codex');
const antigravity = AgentId.make('antigravity');

interface TestLayerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchOverride?: (
    destPath: string,
  ) => Effect.Effect<{ readonly shasumsText: string }, RuntimeArchiveError>;
  readonly onFetch?: () => void;
}

const makeTestLayers = (options?: TestLayerOptions) => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...(options?.env ?? {}),
  };
  const pathSources = Layer.succeed(PathSources, {
    platform: process.platform,
    env,
    readRegistryPath: () => Effect.succeed(Option.none()),
    readLoginShellPath: Effect.succeed(Option.none()),
  });
  const mergedPath = makeMergedPathTestLayer(bin);
  const store = layerStore(root);
  const archiveSource = Layer.succeed(RuntimeArchiveSource, {
    fetch: (_spec, destPath) =>
      options?.fetchOverride !== undefined
        ? options.fetchOverride(destPath)
        : Effect.promise(async () => {
            options?.onFetch?.();
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
  return { install, agents, runtime, store, mergedPath, pathSources };
};

const logFile = () => join(root, 'logs', 'agents', 'install.log');
const readLog = () => Effect.promise(() => readFile(logFile(), 'utf8'));

const collectInstall = (agentId: AgentId) =>
  AgentInstall.use((install) =>
    Stream.runCollect(install.install(agentId)).pipe(Effect.map((events) => Array.from(events))),
  );

const waitForLog = (needle: string) =>
  Effect.promise(async () => {
    for (let i = 0; i < 200; i += 1) {
      const content = await readFile(logFile(), 'utf8').catch(() => '');
      if (content.includes(needle)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Timed out waiting for ${needle} in install.log`);
  });

describe('AgentInstall.install (managed runtime & isolated prefixes)', () => {
  it.effect(
    'downloads runtime on cold setup, installs pinned adapter into isolated prefix, and spawns via managed node',
    () =>
      Effect.gen(function* () {
        let fetches = 0;
        const layers = makeTestLayers({
          onFetch: () => {
            fetches += 1;
          },
        });
        const combined = Layer.mergeAll(
          layers.install,
          layers.agents,
          layers.runtime,
          layers.store,
          layers.mergedPath,
          layers.pathSources,
        );

        yield* Effect.gen(function* () {
          const events = yield* collectInstall(claude);
          expect(events.map((e) => e._tag)).toEqual([
            'downloadingRuntime',
            'installingAdapter',
            'succeeded',
          ]);
          expect(fetches).toBe(1);

          const log = yield* readLog();
          expect(log).toContain('@agentclientprotocol/claude-agent-acp@0.106.0');
          expect(log).toContain('added 1 package');

          const listed = yield* Agents.use((a) => a.list);
          const claudeInfo = listed.find((a) => a.id === claude);
          expect(claudeInfo).toMatchObject({
            id: claude,
            installed: true,
            installedVersion: '0.106.0',
            versionQualification: 'qualified',
          });

          // Subsequent install skips downloadingRuntime when runtime is already cached.
          const codexEvents = yield* collectInstall(codex);
          expect(codexEvents.map((e) => e._tag)).toEqual(['installingAdapter', 'succeeded']);
          expect(fetches).toBe(1);
          const codexInfo = (yield* Agents.use((a) => a.list)).find((a) => a.id === codex);
          expect(codexInfo).toMatchObject({
            id: codex,
            installed: true,
            installedVersion: '2.6.0',
            versionQualification: 'qualified',
          });

          // Installed adapter launches via managed node and sees user's Merged PATH.
          const runtimePaths = Option.getOrThrow(yield* AgentRuntime.use((r) => r.inspect));
          const output = yield* Effect.scoped(
            Effect.gen(function* () {
              const child = yield* spawnAgent({
                id: claude,
                installKind: 'npm',
                package: '@agentclientprotocol/claude-agent-acp',
                binary: 'claude-agent-acp',
                args: [],
              });
              return yield* Effect.callback<string>((resume) => {
                let buf = '';
                child.stdout.on('data', (chunk: Buffer) => {
                  buf += chunk.toString('utf8');
                  const nl = buf.indexOf('\n');
                  if (nl >= 0) resume(Effect.succeed(buf.slice(0, nl)));
                });
              });
            }),
          );
          const spawned = JSON.parse(output) as { execPath: string; path: string };
          expect(spawned.execPath).toBe(runtimePaths.node);
          expect(spawned.path).toBe(bin);
        }).pipe(Effect.provide(combined));
      }),
    30_000,
  );

  it.effect(
    'strips inherited NPM_CONFIG_PREFIX, npm_* and AppImage vars while keeping Merged PATH',
    () =>
      Effect.gen(function* () {
        const layers = makeTestLayers({
          env: {
            NPM_CONFIG_PREFIX: '/bad/global/prefix',
            npm_config_prefix: '/bad/nvm/prefix',
            APPIMAGE: '/tmp/Spence.AppImage',
            APPDIR: '/tmp/.mount_Spence',
          },
        });
        yield* collectInstall(claude).pipe(Effect.provide(layers.install));
        const log = yield* readLog();
        expect(log).toContain('env_npm_prefix: \n');
        expect(log).toContain('env_npm_lc: \n');
        expect(log).toContain('env_appimage: \n');
        expect(log).toContain(`env_path: `);
        expect(log).toContain(bin);
      }),
  );

  it.effect('deduplicates runtime download across concurrent Claude and Codex installs', () =>
    Effect.gen(function* () {
      let fetches = 0;
      const gate = Deferred.makeUnsafe<void>();
      const fetchStarted = Deferred.makeUnsafe<void>();
      const layers = makeTestLayers({
        fetchOverride: (destPath) =>
          Effect.gen(function* () {
            fetches += 1;
            yield* Deferred.succeed(fetchStarted, undefined);
            yield* Deferred.await(gate);
            yield* Effect.promise(() => copyFile(archivePath, destPath));
            return { shasumsText: `${archiveSha256}  ${specFilename}\n` };
          }),
      });
      const combined = Layer.mergeAll(layers.install, layers.agents);

      yield* Effect.gen(function* () {
        const f1 = yield* Effect.forkChild(collectInstall(claude));
        const f2 = yield* Effect.forkChild(collectInstall(codex));
        yield* Deferred.await(fetchStarted);
        yield* Deferred.succeed(gate, undefined);
        const [e1, e2] = yield* Effect.all([Fiber.join(f1), Fiber.join(f2)]);
        expect(e1.at(-1)?._tag).toBe('succeeded');
        expect(e2.at(-1)?._tag).toBe('succeeded');
        expect(fetches).toBe(1);
      }).pipe(Effect.provide(combined));
    }),
  );

  it.effect(
    'fails with ChecksumMismatch and writes log without leaving runtime or agent files',
    () =>
      Effect.gen(function* () {
        const layers = makeTestLayers({
          fetchOverride: (destPath) =>
            Effect.promise(async () => {
              await copyFile(archivePath, destPath);
              return { shasumsText: `${'f'.repeat(64)}  ${specFilename}\n` };
            }),
        });
        const events = yield* collectInstall(claude).pipe(Effect.provide(layers.install));
        expect(events.map((e) => e._tag)).toEqual(['downloadingRuntime', 'failed']);
        expect(events[1]).toMatchObject({
          _tag: 'failed',
          reason: 'ChecksumMismatch',
          logPath: logFile(),
        });
        expect(yield* readLog()).toContain('SHA-256');
        const agentsEntries = yield* Effect.promise(() =>
          readdir(join(root, 'agents')).catch(() => []),
        );
        expect(agentsEntries).toEqual([]);
      }),
  );

  it.effect(
    'recognises EACCES and NpmFailed and cleans adapter staging without leaving partial install',
    () =>
      Effect.gen(function* () {
        const layersEacces = makeTestLayers({ env: { SPENCE_STUB_NPM_MODE: 'eacces' } });
        const eaccesEvents = yield* collectInstall(claude).pipe(
          Effect.provide(layersEacces.install),
        );
        expect(eaccesEvents).toEqual([
          { _tag: 'downloadingRuntime', startedAt: expect.any(Number) },
          { _tag: 'installingAdapter', startedAt: expect.any(Number) },
          {
            _tag: 'failed',
            reason: 'PermissionDenied',
            detail: "Error: EACCES: permission denied, mkdir '/spence/agents'",
            logPath: logFile(),
          },
        ]);

        const layersE404 = makeTestLayers({ env: { SPENCE_STUB_NPM_MODE: 'e404' } });
        const e404Events = yield* collectInstall(codex).pipe(Effect.provide(layersE404.install));
        expect(e404Events.at(-1)).toEqual({
          _tag: 'failed',
          reason: 'NpmFailed',
          detail: '404 Not Found - GET https://registry.npmjs.org/x',
          logPath: logFile(),
        });

        const agentsEntries = yield* Effect.promise(() =>
          readdir(join(root, 'agents')).catch(() => []),
        );
        expect(agentsEntries).toEqual([]);
      }),
  );

  it.effect(
    'keeps setup running when stream disconnects and reattaches with live phase and original startedAt',
    () =>
      Effect.gen(function* () {
        const gateFile = join(root, 'npm.gate');
        const layers = makeTestLayers({
          env: { SPENCE_STUB_NPM_MODE: 'gate', SPENCE_STUB_NPM_GATE_FILE: gateFile },
        });
        const handlers = layerAgentsHandlersWith.pipe(
          Layer.provide(layers.install),
          Layer.provide(layers.agents),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(AgentsRpcs);
            const firstEvents: Array<unknown> = [];
            const firstFiber = yield* client['Agents.install']({ agentId: claude }).pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  firstEvents.push(event);
                }),
              ),
              Effect.forkChild,
            );
            yield* waitForLog('STUB_NPM_READY');

            // Unmount / disconnect from the first RPC stream mid-install.
            yield* Fiber.interrupt(firstFiber);

            const status = yield* client['Agents.installStatus']({ agentId: claude });
            expect(status).toEqual({
              _tag: 'installing',
              phase: 'installingAdapter',
              startedAt: expect.any(Number),
            });
            const originalStartedAt = status._tag === 'installing' ? status.startedAt : -1;

            // Re-attach from a new stream, then unblock stub npm.
            const reattachedQueue = yield* Queue.unbounded<unknown>();
            const reattachFiber = yield* client['Agents.install']({ agentId: claude }).pipe(
              Stream.runForEach((event) => Queue.offer(reattachedQueue, event)),
              Effect.forkChild,
            );
            const replayed = yield* Queue.take(reattachedQueue);
            expect(replayed).toEqual({
              _tag: 'installingAdapter',
              startedAt: originalStartedAt,
            });

            yield* Effect.promise(() => writeFile(gateFile, 'go'));
            const terminal = yield* Queue.take(reattachedQueue);
            expect(terminal).toEqual({ _tag: 'succeeded' });
            yield* Fiber.join(reattachFiber);

            expect(yield* client['Agents.installStatus']({ agentId: claude })).toEqual({
              _tag: 'idle',
            });
            const after = yield* client['Agents.list']();
            expect(after.find((a) => a.id === claude)?.installed).toBe(true);
            expect(firstEvents.map((e) => (e as { _tag: string })._tag)).toContain(
              'installingAdapter',
            );
          }).pipe(Effect.provide(handlers)),
        );
      }),
    30_000,
  );

  it.effect(
    'explicit Agents.cancelInstall aborts active npm, cleans staging, preserves prior install, and emits cancelled',
    () =>
      Effect.gen(function* () {
        // First, complete an intact managed install for claude.
        const initialLayers = makeTestLayers();
        yield* collectInstall(claude).pipe(Effect.provide(initialLayers.install));

        // Now start a hanging update/re-install for claude and explicitly cancel it.
        const layers = makeTestLayers({ env: { SPENCE_STUB_NPM_MODE: 'hang' } });
        const handlers = layerAgentsHandlersWith.pipe(
          Layer.provide(layers.install),
          Layer.provide(layers.agents),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(AgentsRpcs);
            const received = yield* Queue.unbounded<{ readonly _tag: string }>();
            const fiber = yield* client['Agents.install']({ agentId: claude }).pipe(
              Stream.runForEach((event) => Queue.offer(received, event)),
              Effect.forkChild,
            );
            yield* waitForLog('STUB_NPM_READY');

            yield* client['Agents.cancelInstall']({ agentId: claude });
            yield* Fiber.join(fiber);

            const events: Array<{ readonly _tag: string }> = [];
            while (true) {
              const next = yield* Queue.poll(received);
              if (Option.isNone(next)) break;
              events.push(next.value);
            }
            expect(events.at(-1)).toEqual({ _tag: 'cancelled' });
            expect(yield* client['Agents.installStatus']({ agentId: claude })).toEqual({
              _tag: 'idle',
            });

            // Temp staging was removed while the prior intact managed install remains intact.
            const agentsEntries = yield* Effect.promise(() => readdir(join(root, 'agents')));
            expect(agentsEntries).toEqual(['claude']);
            const listed = yield* client['Agents.list']();
            expect(listed.find((a) => a.id === claude)?.installed).toBe(true);
          }).pipe(Effect.provide(handlers)),
        );
      }),
    30_000,
  );

  it.effect(
    'explicit cancel during downloadingRuntime aborts fetch and cleans runtime staging',
    () =>
      Effect.gen(function* () {
        const fetchStarted = Deferred.makeUnsafe<void>();
        let aborted = false;
        const layers = makeTestLayers({
          fetchOverride: (destPath) =>
            Effect.promise(() => writeFile(destPath, 'partial')).pipe(
              Effect.andThen(Deferred.succeed(fetchStarted, undefined)),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  aborted = true;
                }),
              ),
            ),
        });
        const handlers = layerAgentsHandlersWith.pipe(
          Layer.provide(layers.install),
          Layer.provide(layers.agents),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(AgentsRpcs);
            const fiber = yield* client['Agents.install']({ agentId: claude }).pipe(
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* Deferred.await(fetchStarted);
            expect(yield* client['Agents.installStatus']({ agentId: claude })).toEqual({
              _tag: 'installing',
              phase: 'downloadingRuntime',
              startedAt: expect.any(Number),
            });

            yield* client['Agents.cancelInstall']({ agentId: claude });
            const events = yield* Fiber.join(fiber);
            expect(Array.from(events).map((e) => e._tag)).toEqual([
              'downloadingRuntime',
              'cancelled',
            ]);
            expect(aborted).toBe(true);

            const runtimeEntries = yield* Effect.promise(() =>
              readdir(join(root, 'runtime')).catch(() => []),
            );
            expect(runtimeEntries).toEqual([]);
          }).pipe(Effect.provide(handlers)),
        );
      }),
    30_000,
  );

  it.effect(
    'cancelling one concurrent install keeps shared runtime download alive for the other agent',
    () =>
      Effect.gen(function* () {
        const fetchStarted = Deferred.makeUnsafe<void>();
        const gate = Deferred.makeUnsafe<void>();
        let fetches = 0;
        const layers = makeTestLayers({
          fetchOverride: (destPath) =>
            Effect.gen(function* () {
              fetches += 1;
              yield* Deferred.succeed(fetchStarted, undefined);
              yield* Deferred.await(gate);
              yield* Effect.promise(() => copyFile(archivePath, destPath));
              return { shasumsText: `${archiveSha256}  ${specFilename}\n` };
            }),
        });
        const handlers = layerAgentsHandlersWith.pipe(
          Layer.provide(layers.install),
          Layer.provide(layers.agents),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(AgentsRpcs);
            const claudeFiber = yield* client['Agents.install']({ agentId: claude }).pipe(
              Stream.runCollect,
              Effect.forkChild,
            );
            const codexFiber = yield* client['Agents.install']({ agentId: codex }).pipe(
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* Deferred.await(fetchStarted);

            yield* client['Agents.cancelInstall']({ agentId: claude });
            const claudeEvents = yield* Fiber.join(claudeFiber);
            expect(Array.from(claudeEvents).at(-1)).toEqual({ _tag: 'cancelled' });

            yield* Deferred.succeed(gate, undefined);
            const codexEvents = yield* Fiber.join(codexFiber);
            expect(Array.from(codexEvents).at(-1)).toEqual({ _tag: 'succeeded' });
            expect(fetches).toBe(1);
          }).pipe(Effect.provide(handlers)),
        );
      }),
    30_000,
  );

  it.effect(
    'disposing AgentInstall scope (app quit) cancels active setup jobs and cleans staging',
    () =>
      Effect.gen(function* () {
        const layers = makeTestLayers({ env: { SPENCE_STUB_NPM_MODE: 'hang' } });
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(layers.install, scope);
        const installService = Context.get(context, AgentInstall);

        const fiber = yield* installService
          .install(claude)
          .pipe(Stream.runCollect, Effect.forkChild);
        yield* waitForLog('STUB_NPM_READY');
        const duringEntries = yield* Effect.promise(() =>
          readdir(join(root, 'agents')).catch(() => []),
        );
        expect(duringEntries.some((name) => name.startsWith('.staging-claude-'))).toBe(true);

        // Simulate MainRuntime.dispose() on before-quit.
        yield* Scope.close(scope, Exit.void);
        const events = yield* Fiber.join(fiber);
        expect(Array.from(events).at(-1)?._tag).toBe('cancelled');

        const afterEntries = yield* Effect.promise(() =>
          readdir(join(root, 'agents')).catch(() => []),
        );
        expect(afterEntries).toEqual([]);
      }),
    30_000,
  );

  it.effect('never acquires runtime or runs npm for native Agents like Antigravity', () =>
    Effect.gen(function* () {
      let fetches = 0;
      const layers = makeTestLayers({
        onFetch: () => {
          fetches += 1;
        },
      });
      const events = yield* collectInstall(antigravity).pipe(Effect.provide(layers.install));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ _tag: 'failed', reason: 'NotOnPath' });
      expect(fetches).toBe(0);
    }),
  );

  it.effect(
    'serves Agents.list and Agents.install end-to-end through AgentsRpcs',
    () =>
      Effect.gen(function* () {
        const layers = makeTestLayers();
        const handlers = layerAgentsHandlersWith.pipe(
          Layer.provide(layers.install),
          Layer.provide(layers.agents),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(AgentsRpcs);
            const before = yield* client['Agents.list']();
            expect(before.find((a) => a.id === claude)?.installed).toBe(false);

            const events = yield* client['Agents.install']({ agentId: claude }).pipe(
              Stream.runCollect,
            );
            expect(Array.from(events).map((e) => e._tag)).toEqual([
              'downloadingRuntime',
              'installingAdapter',
              'succeeded',
            ]);

            const after = yield* client['Agents.list']();
            expect(after.find((a) => a.id === claude)).toMatchObject({
              installed: true,
              installedVersion: '0.106.0',
              versionQualification: 'qualified',
            });
          }).pipe(Effect.provide(handlers)),
        );
      }),
    30_000,
  );

  it.effect(
    'keeps outdated managed adapter runnable as unverified and atomically updates to qualified version',
    () =>
      Effect.gen(function* () {
        let fetches = 0;
        const layers = makeTestLayers({
          onFetch: () => {
            fetches += 1;
          },
        });
        const combined = Layer.mergeAll(
          layers.install,
          layers.agents,
          layers.runtime,
          layers.store,
          layers.mergedPath,
          layers.pathSources,
        );

        yield* Effect.gen(function* () {
          // Ensure runtime once, then seed an outdated 0.105.0 managed Claude adapter.
          yield* AgentRuntime.use((r) => r.ensure);
          const fetchesBefore = fetches;
          const claudeDir = join(root, 'agents', 'claude');
          const pkgDir = join(
            claudeDir,
            'node_modules',
            '@agentclientprotocol',
            'claude-agent-acp',
          );
          yield* Effect.promise(async () => {
            await mkdir(join(pkgDir, 'bin'), { recursive: true });
            await writeFile(
              join(pkgDir, 'bin', 'claude-agent-acp.js'),
              "#!/usr/bin/env node\nconsole.log(JSON.stringify({ version: '0.105.0' }));\nsetInterval(() => {}, 1000);\n",
            );
            await writeFile(
              join(pkgDir, 'package.json'),
              JSON.stringify({
                name: '@agentclientprotocol/claude-agent-acp',
                version: '0.105.0',
                bin: { 'claude-agent-acp': './bin/claude-agent-acp.js' },
              }),
            );
            await writeFile(join(claudeDir, 'stale-marker.txt'), 'old');
          });

          const before = (yield* Agents.use((a) => a.list)).find((a) => a.id === claude);
          expect(before).toMatchObject({
            installed: true,
            installedVersion: '0.105.0',
            versionQualification: 'unverified',
          });

          // Outdated managed adapter stays runnable via spawnAgent.
          const oldOutput = yield* Effect.scoped(
            Effect.gen(function* () {
              const child = yield* spawnAgent({
                id: claude,
                installKind: 'npm',
                package: '@agentclientprotocol/claude-agent-acp',
                binary: 'claude-agent-acp',
                args: [],
              });
              return yield* Effect.callback<string>((resume) => {
                let buf = '';
                child.stdout.on('data', (chunk: Buffer) => {
                  buf += chunk.toString('utf8');
                  const nl = buf.indexOf('\n');
                  if (nl >= 0) resume(Effect.succeed(buf.slice(0, nl)));
                });
              });
            }),
          );
          expect(JSON.parse(oldOutput)).toEqual({ version: '0.105.0' });

          // Update swaps atomically to qualified 0.106.0 without re-downloading runtime.
          const events = yield* collectInstall(claude);
          expect(events.map((e) => e._tag)).toEqual(['installingAdapter', 'succeeded']);
          expect(fetches).toBe(fetchesBefore);

          const after = (yield* Agents.use((a) => a.list)).find((a) => a.id === claude);
          expect(after).toMatchObject({
            installed: true,
            installedVersion: '0.106.0',
            versionQualification: 'qualified',
          });
          const entries = yield* Effect.promise(() => readdir(claudeDir));
          expect(entries).not.toContain('stale-marker.txt');
        }).pipe(Effect.provide(combined));
      }),
    30_000,
  );

  it.effect(
    'preserves prior working managed adapter untouched when update fails or is cancelled',
    () =>
      Effect.gen(function* () {
        const seedLayers = makeTestLayers();
        const claudeDir = join(root, 'agents', 'claude');
        const pkgDir = join(claudeDir, 'node_modules', '@agentclientprotocol', 'claude-agent-acp');
        yield* Effect.gen(function* () {
          yield* AgentRuntime.use((r) => r.ensure);
          yield* Effect.promise(async () => {
            await mkdir(join(pkgDir, 'bin'), { recursive: true });
            await writeFile(
              join(pkgDir, 'bin', 'claude-agent-acp.js'),
              "#!/usr/bin/env node\nconsole.log('OLD_STILL_WORKS');\nsetInterval(() => {}, 1000);\n",
            );
            await writeFile(
              join(pkgDir, 'package.json'),
              JSON.stringify({
                name: '@agentclientprotocol/claude-agent-acp',
                version: '0.105.0',
                bin: { 'claude-agent-acp': './bin/claude-agent-acp.js' },
              }),
            );
          });
        }).pipe(Effect.provide(seedLayers.runtime));

        // 1. Failed update (e404) leaves 0.105.0 intact and cleans staging.
        const failLayers = makeTestLayers({ env: { SPENCE_STUB_NPM_MODE: 'e404' } });
        const failEvents = yield* collectInstall(claude).pipe(Effect.provide(failLayers.install));
        expect(failEvents.at(-1)).toMatchObject({ _tag: 'failed', reason: 'NpmFailed' });
        const afterFail = (yield* Agents.use((a) => a.list).pipe(
          Effect.provide(failLayers.agents),
        )).find((a) => a.id === claude);
        expect(afterFail).toMatchObject({
          installed: true,
          installedVersion: '0.105.0',
          versionQualification: 'unverified',
        });

        // 2. Cancelled update (hang -> explicit cancel) leaves 0.105.0 intact, cleans staging, and keeps it runnable.
        const hangLayers = makeTestLayers({ env: { SPENCE_STUB_NPM_MODE: 'hang' } });
        const combined = Layer.mergeAll(
          hangLayers.install,
          hangLayers.agents,
          hangLayers.runtime,
          hangLayers.store,
          hangLayers.mergedPath,
          hangLayers.pathSources,
        );
        yield* Effect.gen(function* () {
          const fiber = yield* AgentInstall.use((install) =>
            install.install(claude).pipe(Stream.runDrain, Effect.forkChild),
          );
          yield* Effect.promise(async () => {
            for (let i = 0; i < 100; i += 1) {
              const content = await readFile(logFile(), 'utf8').catch(() => '');
              if (content.includes('STUB_NPM_READY')) return;
              await new Promise((r) => setTimeout(r, 50));
            }
            throw new Error('stub npm did not start in time');
          });
          yield* AgentInstall.use((install) => install.cancel(claude));
          yield* Fiber.join(fiber);

          const agentsEntries = yield* Effect.promise(() => readdir(join(root, 'agents')));
          expect(agentsEntries).toEqual(['claude']);
          const afterCancel = (yield* Agents.use((a) => a.list)).find((a) => a.id === claude);
          expect(afterCancel).toMatchObject({
            installed: true,
            installedVersion: '0.105.0',
            versionQualification: 'unverified',
          });
          const out = yield* Effect.scoped(
            Effect.gen(function* () {
              const child = yield* spawnAgent({
                id: claude,
                installKind: 'npm',
                package: '@agentclientprotocol/claude-agent-acp',
                binary: 'claude-agent-acp',
                args: [],
              });
              return yield* Effect.callback<string>((resume) => {
                let buf = '';
                child.stdout.on('data', (chunk: Buffer) => {
                  buf += chunk.toString('utf8');
                  const nl = buf.indexOf('\n');
                  if (nl >= 0) resume(Effect.succeed(buf.slice(0, nl)));
                });
              });
            }),
          );
          expect(out).toBe('OLD_STILL_WORKS');
        }).pipe(Effect.provide(combined));
      }),
    30_000,
  );
});
