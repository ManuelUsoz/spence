import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { inspectManagedPrefix, isWithin } from './managed';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'spence-managed-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('isWithin', () => {
  it('accepts descendants even when process.cwd() is inside parent', () => {
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      expect(isWithin(root, join(root, 'node_modules', 'pkg', 'bin.js'))).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('rejects self, parent traversal, sibling prefixes, and cross-root paths', () => {
    expect(isWithin(root, root)).toBe(false);
    expect(isWithin(root, join(root, '..', 'outside.js'))).toBe(false);
    expect(isWithin(join(root, 'agent'), join(root, 'agent-2', 'bin.js'))).toBe(false);
    if (process.platform === 'win32') {
      expect(isWithin('C:\\spence\\agent', 'D:\\evil\\bin.js')).toBe(false);
    }
  });
});

describe('inspectManagedPrefix', () => {
  const entry = {
    package: '@agentclientprotocol/claude-agent-acp',
    binary: 'claude-agent-acp',
  };

  const writePackage = async (prefixDir: string, binPath: string) => {
    const pkgDir = join(prefixDir, 'node_modules', '@agentclientprotocol', 'claude-agent-acp');
    await mkdir(join(pkgDir, 'bin'), { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: entry.package,
        version: '0.106.0',
        bin: { [entry.binary]: binPath },
      }),
    );
    return pkgDir;
  };

  it.effect(
    'returns the adapter when bin resolves inside the prefix, even if cwd is prefixDir',
    () =>
      Effect.gen(function* () {
        const prefixDir = join(root, 'prefix');
        const pkgDir = yield* Effect.promise(async () => {
          const dir = await writePackage(prefixDir, './bin/claude-agent-acp.js');
          await writeFile(join(dir, 'bin', 'claude-agent-acp.js'), '#!/usr/bin/env node\n');
          return dir;
        });

        const originalCwd = process.cwd();
        process.chdir(prefixDir);
        try {
          const result = yield* inspectManagedPrefix(prefixDir, entry);
          expect(Option.getOrUndefined(result)).toEqual({
            kind: 'node',
            entrypoint: resolve(pkgDir, 'bin', 'claude-agent-acp.js'),
            version: '0.106.0',
          });
        } finally {
          process.chdir(originalCwd);
        }
      }),
  );

  it.effect('rejects bin fields that traverse or point outside the prefix directory', () =>
    Effect.gen(function* () {
      const prefixDir = join(root, 'prefix');
      const outside = join(root, 'outside.js');
      yield* Effect.promise(async () => {
        await writeFile(outside, '#!/usr/bin/env node\n');
        await writePackage(prefixDir, '../../../../outside.js');
      });
      expect(Option.isNone(yield* inspectManagedPrefix(prefixDir, entry))).toBe(true);

      yield* Effect.promise(() => writePackage(prefixDir, outside));
      expect(Option.isNone(yield* inspectManagedPrefix(prefixDir, entry))).toBe(true);
    }),
  );
});
