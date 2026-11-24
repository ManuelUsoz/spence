import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Logger, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { layerStore } from '../store/store';
import { layerPathSources, MergedPath, PathSources } from './merged-path';
import { AgentRuntime, MANAGED_NODE_VERSION, RuntimeArchiveError } from './runtime';
import { killTree, spawnAgent } from './spawn';

let bin = '';

beforeEach(async () => {
  bin = await mkdtemp(join(tmpdir(), 'spence-spawn-'));
});

afterEach(async () => {
  await rm(bin, { recursive: true, force: true });
});

/** A fake adapter shaped like an npm install: a shim runs node, which starts a grandchild, like the real adapter. */
const installFakeAgent = Effect.fnUntraced(function* () {
  const script = join(bin, 'fake-agent.js');
  yield* Effect.promise(() =>
    writeFile(
      script,
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(`${process.pid} ${child.pid} ${process.argv.slice(2).join(',')}\\n`);",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    ),
  );
  if (process.platform === 'win32') {
    yield* Effect.promise(() =>
      writeFile(join(bin, 'fake-agent.cmd'), `@"${process.execPath}" "${script}" %*\r\n`),
    );
  } else {
    yield* Effect.promise(() =>
      writeFile(
        join(bin, 'fake-agent'),
        `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        {
          mode: 0o755,
        },
      ),
    );
  }
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const firstLine = (stream: NodeJS.ReadableStream) =>
  Effect.callback<string>((resume) => {
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const end = buffer.indexOf('\n');
      if (end >= 0) resume(Effect.succeed(buffer.slice(0, end).trim()));
    });
  });

const layerPath = () =>
  Layer.merge(Layer.succeed(MergedPath, { get: Effect.succeed(bin) }), layerPathSources);

/** PathSources for `platform`, with `env` in place of the process environment. */
const layerSources = (platform: NodeJS.Platform, env: Record<string, string>) =>
  Layer.succeed(PathSources, {
    platform,
    env,
    readRegistryPath: () => Effect.succeed(Option.none()),
    readLoginShellPath: Effect.succeed(Option.none()),
  });

/** A node process that prints `ready` once running and ignores SIGTERM. */
const startStubborn = (): ChildProcessWithoutNullStreams =>
  spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
    { stdio: 'pipe', detached: process.platform !== 'win32' },
  );

/** Collects warnings and resolves `first` on the first one. */
const captureWarnings = () => {
  const warnings: Array<string> = [];
  let resolveFirst = (): void => undefined;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const layer = Logger.layer([
    Logger.make((options) => {
      if (options.logLevel !== 'Warn') return;
      warnings.push(String(options.message));
      resolveFirst();
    }),
  ]);
  return { warnings, first, layer };
};

describe('spawnAgent', () => {
  it.effect(
    'starts the resolved adapter with its constant args and kills its whole tree on release',
    () =>
      Effect.gen(function* () {
        yield* installFakeAgent();
        const pids = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawnAgent({ binary: 'fake-agent', args: ['--acp', 'x=1'] });
            const [agent, grandchild, args] = (yield* firstLine(child.stdout)).split(' ');
            expect(args).toBe('--acp,x=1');
            const running = [Number(agent), Number(grandchild)];
            expect(running.every(isAlive)).toBe(true);
            return running;
          }),
        );
        expect(pids.filter(isAlive)).toEqual([]);
      }).pipe(Effect.provide(layerPath())),
  );

  it.effect('fails as not installed when the binary is not on the merged PATH', () =>
    Effect.gen(function* () {
      const error = yield* Effect.scoped(spawnAgent({ binary: 'fake-agent', args: [] })).pipe(
        Effect.flip,
      );
      expect(error.reason).toBe('NotInstalled');
    }).pipe(Effect.provide(layerPath())),
  );

  it.effect(
    'launches packaged npm Agents exclusively via managed node, preserves Merged PATH, and strips AppImage vars',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), 'spence-spawn-managed-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        // Put a decoy binary on MergedPath that must be ignored for npm Agents.
        yield* installFakeAgent();

        const claudeId = AgentId.make('claude');
        const pkg = '@agentclientprotocol/claude-agent-acp';
        const pkgDir = join(root, 'agents', claudeId, 'node_modules', ...pkg.split('/'));
        yield* Effect.promise(() => mkdir(join(pkgDir, 'bin'), { recursive: true }));
        const entryScript = join(pkgDir, 'bin', 'claude-agent-acp.js');
        yield* Effect.promise(() =>
          writeFile(
            entryScript,
            [
              '#!/usr/bin/env node',
              'process.stdout.write(JSON.stringify({',
              '  execPath: process.execPath,',
              '  path: process.env.PATH,',
              '  appimage: process.env.APPIMAGE,',
              '  appdir: process.env.APPDIR,',
              '  ld: process.env.LD_LIBRARY_PATH,',
              '}) + "\\n");',
              'setInterval(() => {}, 1000);',
            ].join('\n'),
          ),
        );
        yield* Effect.promise(() =>
          writeFile(
            join(pkgDir, 'package.json'),
            JSON.stringify({
              name: pkg,
              version: '0.106.0',
              bin: { 'claude-agent-acp': './bin/claude-agent-acp.js' },
            }),
          ),
        );

        const managedEnv: Record<string, string> = {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          APPIMAGE: '/tmp/Spence.AppImage',
          APPDIR: '/tmp/.mount_SpenceXYZ',
          LD_LIBRARY_PATH: '/tmp/.mount_SpenceXYZ/usr/lib:/user/lib',
        };
        const managedLayer = Layer.mergeAll(
          Layer.succeed(MergedPath, { get: Effect.succeed(bin) }),
          layerSources(process.platform, managedEnv),
          layerStore(root),
          Layer.succeed(AgentRuntime, {
            inspect: Effect.succeed(
              Option.some({
                version: MANAGED_NODE_VERSION,
                dir: join(root, 'runtime'),
                node: process.execPath,
                npmCli: join(root, 'runtime', 'npm-cli.js'),
              }),
            ),
            ensure: Effect.fail(
              new RuntimeArchiveError({ reason: 'DownloadFailed', detail: 'unused' }),
            ),
          }),
        );

        const output = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawnAgent({
              id: claudeId,
              installKind: 'npm',
              package: pkg,
              binary: 'claude-agent-acp',
              args: [],
            });
            return yield* firstLine(child.stdout);
          }),
        ).pipe(Effect.provide(managedLayer));

        const parsed = JSON.parse(output) as {
          execPath: string;
          path: string;
          appimage?: string;
          appdir?: string;
          ld?: string;
        };
        expect(parsed.execPath).toBe(process.execPath);
        expect(parsed.path).toBe(bin);
        expect(parsed.appimage).toBeUndefined();
        expect(parsed.appdir).toBeUndefined();
        expect(parsed.ld).toBe('/user/lib');
      }),
  );

  it.effect(
    'fails as NotInstalled when packaged npm Agent is only on MergedPath and absent from managed dir',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), 'spence-spawn-empty-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        yield* Effect.promise(() =>
          writeFile(
            join(bin, process.platform === 'win32' ? 'claude-agent-acp.cmd' : 'claude-agent-acp'),
            '',
            { mode: 0o755 },
          ),
        );
        const managedLayer = Layer.mergeAll(
          Layer.succeed(MergedPath, { get: Effect.succeed(bin) }),
          layerSources(process.platform, {}),
          layerStore(root),
          Layer.succeed(AgentRuntime, {
            inspect: Effect.succeed(
              Option.some({
                version: MANAGED_NODE_VERSION,
                dir: join(root, 'runtime'),
                node: process.execPath,
                npmCli: join(root, 'runtime', 'npm-cli.js'),
              }),
            ),
            ensure: Effect.fail(
              new RuntimeArchiveError({ reason: 'DownloadFailed', detail: 'unused' }),
            ),
          }),
        );
        const error = yield* Effect.scoped(
          spawnAgent({
            id: AgentId.make('claude'),
            installKind: 'npm',
            package: '@agentclientprotocol/claude-agent-acp',
            binary: 'claude-agent-acp',
            args: [],
          }),
        ).pipe(Effect.flip, Effect.provide(managedLayer));
        expect(error.reason).toBe('NotInstalled');
      }),
  );
});

describe('killTree', () => {
  it.effect('returns false when taskkill fails and exit is not confirmed within timeout', () => {
    const child = startStubborn();
    const logs = captureWarnings();
    return Effect.gen(function* () {
      yield* firstLine(child.stdout);
      const kill = yield* Effect.forkChild(killTree(child));
      yield* Effect.promise(() => logs.first);
      expect(logs.warnings.join(' ')).toContain('taskkill');
      yield* TestClock.adjust('1 minute');
      const confirmed = yield* Fiber.join(kill);
      expect(confirmed).toBe(false);
    }).pipe(
      Effect.provide(layerSources('win32', { SystemRoot: join(bin, 'no-windows') })),
      Effect.provide(logs.layer),
      Effect.ensuring(Effect.sync(() => child.kill('SIGKILL'))),
    );
  });

  it.live('returns true when the process tree exits', () => {
    const child = startStubborn();
    return Effect.gen(function* () {
      yield* firstLine(child.stdout);
      const confirmed = yield* killTree(child);
      expect(confirmed).toBe(true);
    }).pipe(
      Effect.provide(layerPathSources),
      Effect.ensuring(Effect.sync(() => child.kill('SIGKILL'))),
    );
  });
});

describe.runIf(process.platform !== 'win32')('killTree on POSIX', () => {
  it.effect('follows SIGTERM with SIGKILL when the group ignores it', () => {
    const child = startStubborn();
    return Effect.gen(function* () {
      yield* firstLine(child.stdout);
      const kill = yield* Effect.forkChild(killTree(child));
      yield* Effect.yieldNow;
      yield* TestClock.adjust('1 minute');
      yield* Fiber.join(kill);
      // Virtual time also ran out the exit timeout, so killTree may return before the real exit event arrives.
      if (child.exitCode === null && child.signalCode === null)
        yield* Effect.promise(() => once(child, 'exit'));
      expect(child.signalCode).toBe('SIGKILL');
    }).pipe(
      Effect.provide(layerSources(process.platform, {})),
      Effect.ensuring(Effect.sync(() => child.kill('SIGKILL'))),
    );
  });
});
