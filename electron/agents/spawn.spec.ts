import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { MergedPath } from './merged-path';
import { spawnAgent } from './spawn';

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

const layerPath = () => Layer.succeed(MergedPath, { get: Effect.succeed(bin) });

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
});
