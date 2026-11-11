import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { resolveExecutable } from './resolve';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'spence-resolve-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const dir = async (name: string, files: ReadonlyArray<string>): Promise<string> => {
  const path = join(root, name);
  await mkdir(path);
  for (const file of files) {
    await writeFile(join(path, file), '');
    await chmod(join(path, file), 0o755);
  }
  return path;
};

describe('resolveExecutable on Windows', () => {
  it.effect('prefers .exe over .cmd and .bat in the same folder', () =>
    Effect.gen(function* () {
      const bin = yield* Effect.promise(() => dir('bin', ['agent.bat', 'agent.cmd', 'agent.exe']));
      const found = yield* resolveExecutable('agent', bin, 'win32');
      expect(found).toEqual(Option.some(join(bin, 'agent.exe')));
    }),
  );

  it.effect('takes .cmd before .bat', () =>
    Effect.gen(function* () {
      const bin = yield* Effect.promise(() => dir('bin', ['agent.bat', 'agent.cmd']));
      expect(yield* resolveExecutable('agent', bin, 'win32')).toEqual(
        Option.some(join(bin, 'agent.cmd')),
      );
    }),
  );

  it.effect('walks PATH in order: an earlier folder wins over a better extension later', () =>
    Effect.gen(function* () {
      const first = yield* Effect.promise(() => dir('first', ['agent.cmd']));
      const second = yield* Effect.promise(() => dir('second', ['agent.exe']));
      expect(yield* resolveExecutable('agent', `${first};${second}`, 'win32')).toEqual(
        Option.some(join(first, 'agent.cmd')),
      );
    }),
  );

  it.effect('skips the extensionless sh shim npm writes next to the .cmd', () =>
    Effect.gen(function* () {
      const bin = yield* Effect.promise(() => dir('bin', ['agent', 'agent.ps1', 'agent.cmd']));
      expect(yield* resolveExecutable('agent', bin, 'win32')).toEqual(
        Option.some(join(bin, 'agent.cmd')),
      );
    }),
  );

  it.effect('ignores empty and quoted PATH entries gracefully', () =>
    Effect.gen(function* () {
      const bin = yield* Effect.promise(() => dir('with space', ['agent.exe']));
      expect(yield* resolveExecutable('agent', `;;"${bin}";`, 'win32')).toEqual(
        Option.some(join(bin, 'agent.exe')),
      );
    }),
  );

  it.effect('reports a missing binary as none', () =>
    Effect.gen(function* () {
      const bin = yield* Effect.promise(() => dir('bin', ['other.exe']));
      const missing = join(root, 'does-not-exist');
      expect(yield* resolveExecutable('agent', `${missing};${bin}`, 'win32')).toEqual(
        Option.none(),
      );
    }),
  );

  it.effect('does not take a folder named like the binary', () =>
    Effect.gen(function* () {
      const bin = yield* Effect.promise(() => dir('bin', []));
      yield* Effect.promise(() => mkdir(join(bin, 'agent.exe')));
      expect(yield* resolveExecutable('agent', bin, 'win32')).toEqual(Option.none());
    }),
  );
});

// POSIX paths split on ':', which a Windows drive letter would break.
describe.runIf(process.platform !== 'win32')('resolveExecutable on POSIX', () => {
  it.effect('takes the bare name only', () =>
    Effect.gen(function* () {
      const bin = yield* Effect.promise(() => dir('bin', ['agent.exe', 'agent']));
      expect(yield* resolveExecutable('agent', bin, 'linux')).toEqual(
        Option.some(join(bin, 'agent')),
      );
    }),
  );

  it.effect('splits PATH on colons', () =>
    Effect.gen(function* () {
      const bin = yield* Effect.promise(() => dir('bin', ['agent']));
      const missing = join(root, 'nope');
      expect(yield* resolveExecutable('agent', `${missing}:${bin}`, 'darwin')).toEqual(
        Option.some(join(bin, 'agent')),
      );
    }),
  );
});
