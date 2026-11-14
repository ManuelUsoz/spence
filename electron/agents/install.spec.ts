import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Stream } from 'effect';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { layerStore } from '../store/store';
import { layerAgents } from './agents';
import { AgentInstall, layerAgentInstall } from './install';
import { layerPathSources, MergedPath } from './merged-path';

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
const antigravity = AgentId.make('antigravity');
const isWindows = process.platform === 'win32';
const COMMAND = 'npm install -g @agentclientprotocol/claude-agent-acp';

/** A launchable, empty file named like the adapter's npm shim. */
const adapterShim = () => join(bin, isWindows ? 'claude-agent-acp.cmd' : 'claude-agent-acp');

/**
 * A stub `npm` on the merged PATH, shaped like the real one (a shim that runs node). It never touches the network or
 * the real global folder: it echoes its arguments, then runs `body` (node code with `shim`, the adapter's shim path).
 */
const installStubNpm = (body: string) =>
  Effect.promise(async () => {
    const script = join(bin, 'stub-npm.js');
    await writeFile(
      script,
      [
        `const shim = ${JSON.stringify(adapterShim())};`,
        "const fs = require('node:fs');",
        "process.stdout.write(`args: ${process.argv.slice(2).join(' ')}\\n`);",
        body,
      ].join('\n'),
    );
    if (isWindows) {
      await writeFile(join(bin, 'npm.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
    } else {
      await writeFile(
        join(bin, 'npm'),
        `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        {
          mode: 0o755,
        },
      );
    }
  });

const SUCCEEDS =
  "fs.writeFileSync(shim, '', { mode: 0o755 }); process.stdout.write('added 1 package\\n');";

const layerTest = () => {
  const path = Layer.merge(
    Layer.succeed(MergedPath, { get: Effect.succeed(bin) }),
    layerPathSources,
  );
  return layerAgentInstall.pipe(
    Layer.provide(layerAgents),
    Layer.provide(layerStore(root)),
    Layer.provide(path),
  );
};

const logFile = () => join(root, 'logs', 'agents', 'install.log');

const runInstall = AgentInstall.use((install) =>
  Stream.runCollect(install.install(claude)).pipe(Effect.map((events) => Array.from(events))),
);

const readLog = () => Effect.promise(() => readFile(logFile(), 'utf8'));

describe('AgentInstall.command', () => {
  it.effect('gives the exact npm command and whether npm resolves on the merged PATH', () =>
    Effect.gen(function* () {
      const without = yield* AgentInstall.use((install) => install.command(claude));
      expect(without).toEqual({ command: COMMAND, npmFound: false });
      yield* installStubNpm(SUCCEEDS);
      const withNpm = yield* AgentInstall.use((install) => install.command(claude));
      expect(withNpm).toEqual({ command: COMMAND, npmFound: true });
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect('never runs npm for native Agents like Antigravity', () =>
    Effect.gen(function* () {
      yield* installStubNpm(SUCCEEDS);
      const cmd = yield* AgentInstall.use((install) => install.command(antigravity));
      expect(cmd.npmFound).toBe(false);
      expect(cmd.command).not.toContain('npm install');
      const events = yield* AgentInstall.use((install) =>
        Stream.runCollect(install.install(antigravity)).pipe(Effect.map((e) => Array.from(e))),
      );
      expect(events[1]).toMatchObject({ _tag: 'failed', reason: 'NotOnPath' });
    }).pipe(Effect.provide(layerTest())),
  );
});

describe('AgentInstall.install', () => {
  it.effect('runs npm from the merged PATH, re-scans, and succeeds once the adapter resolves', () =>
    Effect.gen(function* () {
      yield* installStubNpm(SUCCEEDS);
      expect(yield* runInstall).toEqual([{ _tag: 'started' }, { _tag: 'succeeded' }]);
      const log = yield* readLog();
      expect(log).toContain(COMMAND);
      expect(log).toContain('args: install -g @agentclientprotocol/claude-agent-acp');
      expect(log).toContain('added 1 package');
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect('recognises EACCES and fails with a one-line reason and the log path', () =>
    Effect.gen(function* () {
      yield* installStubNpm(
        [
          "process.stderr.write('npm error code EACCES\\n');",
          "process.stderr.write('npm error syscall mkdir\\n');",
          "process.stderr.write('npm error Error: EACCES: permission denied, mkdir \\'/usr/lib/node_modules\\'\\n');",
          "process.stderr.write('npm error A complete log of this run can be found in: /x.log\\n');",
          'process.exit(243);',
        ].join('\n'),
      );
      const events = yield* runInstall;
      expect(events).toEqual([
        { _tag: 'started' },
        {
          _tag: 'failed',
          reason: 'PermissionDenied',
          detail: "Error: EACCES: permission denied, mkdir '/usr/lib/node_modules'",
          logPath: logFile(),
        },
      ]);
      expect(yield* readLog()).toContain('npm error code EACCES');
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect('fails as NpmFailed with npm’s first error line when it exits non-zero', () =>
    Effect.gen(function* () {
      yield* installStubNpm(
        [
          "process.stderr.write('npm error code E404\\n');",
          "process.stderr.write('npm error 404 Not Found - GET https://registry.npmjs.org/x\\n');",
          'process.exit(1);',
        ].join('\n'),
      );
      const events = yield* runInstall;
      expect(events[1]).toEqual({
        _tag: 'failed',
        reason: 'NpmFailed',
        detail: '404 Not Found - GET https://registry.npmjs.org/x',
        logPath: logFile(),
      });
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect('fails as NotOnPath when npm succeeds but the re-scan does not find the adapter', () =>
    Effect.gen(function* () {
      yield* installStubNpm("process.stdout.write('added 1 package\\n');");
      const events = yield* runInstall;
      expect(events[1]).toMatchObject({ _tag: 'failed', reason: 'NotOnPath', logPath: logFile() });
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect('fails as NoNpm, with a log, when npm is not on the merged PATH', () =>
    Effect.gen(function* () {
      const events = yield* runInstall;
      expect(events).toEqual([
        { _tag: 'started' },
        {
          _tag: 'failed',
          reason: 'NoNpm',
          detail: 'npm is not on PATH',
          logPath: logFile(),
        },
      ]);
      expect(yield* readLog()).toContain('npm is not on PATH');
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect('never runs npm for native Agents like Antigravity', () =>
    Effect.gen(function* () {
      yield* installStubNpm(SUCCEEDS);
      const cmd = yield* AgentInstall.use((install) => install.command(antigravity));
      expect(cmd.npmFound).toBe(false);
      expect(cmd.command).not.toContain('npm install');
      const events = yield* AgentInstall.use((install) =>
        Stream.runCollect(install.install(antigravity)).pipe(Effect.map((e) => Array.from(e))),
      );
      expect(events[1]).toMatchObject({ _tag: 'failed', reason: 'NotOnPath' });
    }).pipe(Effect.provide(layerTest())),
  );
});
