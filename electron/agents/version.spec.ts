import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { inspectNpmPackageVersion, makeNativeVersionCache, qualifyVersion } from './version';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'spence-version-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('qualifyVersion', () => {
  it('qualifies exact versions and marks others unverified', () => {
    expect(qualifyVersion('0.106.0', { kind: 'exact', version: '0.106.0' })).toBe('qualified');
    expect(qualifyVersion('0.105.0', { kind: 'exact', version: '0.106.0' })).toBe('unverified');
    expect(qualifyVersion('0.107.0', { kind: 'exact', version: '0.106.0' })).toBe('unverified');
    expect(qualifyVersion(undefined, { kind: 'exact', version: '0.106.0' })).toBe('unverified');
  });

  it('qualifies minimum semver versions (e.g. 1.2+) and marks older versions unverified', () => {
    expect(qualifyVersion('1.2.0', { kind: 'min', version: '1.2.0' })).toBe('qualified');
    expect(qualifyVersion('1.2.5', { kind: 'min', version: '1.2.0' })).toBe('qualified');
    expect(qualifyVersion('1.3.0', { kind: 'min', version: '1.2.0' })).toBe('qualified');
    expect(qualifyVersion('2.0.0', { kind: 'min', version: '1.2.0' })).toBe('qualified');
    expect(qualifyVersion('1.1.9', { kind: 'min', version: '1.2.0' })).toBe('unverified');
    expect(qualifyVersion('0.9.0', { kind: 'min', version: '1.2.0' })).toBe('unverified');
  });
});

describe('inspectNpmPackageVersion', () => {
  it.effect('reads package.json statically from an npm global Windows shim layout', () =>
    Effect.gen(function* () {
      const bin = join(root, 'npm-global');
      const shim = join(bin, 'claude-agent-acp.cmd');
      const pkgDir = join(bin, 'node_modules', '@agentclientprotocol', 'claude-agent-acp');
      yield* Effect.promise(async () => {
        await mkdir(pkgDir, { recursive: true });
        await writeFile(shim, '@echo off\r\n');
        await writeFile(
          join(pkgDir, 'package.json'),
          JSON.stringify({ name: '@agentclientprotocol/claude-agent-acp', version: '0.106.0' }),
        );
      });

      const found = yield* inspectNpmPackageVersion(shim, '@agentclientprotocol/claude-agent-acp');
      expect(found).toBe('0.106.0');
    }),
  );

  it.effect('walks up from a resolved package entrypoint to read package.json', () =>
    Effect.gen(function* () {
      const pkgDir = join(root, 'lib', 'node_modules', '@agentclientprotocol', 'codex-acp');
      const binEntry = join(pkgDir, 'dist', 'index.js');
      yield* Effect.promise(async () => {
        await mkdir(join(pkgDir, 'dist'), { recursive: true });
        await writeFile(binEntry, '#!/usr/bin/env node\n');
        await writeFile(
          join(pkgDir, 'package.json'),
          JSON.stringify({ name: '@agentclientprotocol/codex-acp', version: '2.6.0' }),
        );
      });

      const found = yield* inspectNpmPackageVersion(binEntry, '@agentclientprotocol/codex-acp');
      expect(found).toBe('2.6.0');
    }),
  );

  it.effect('returns undefined when package.json is absent or names another package', () =>
    Effect.gen(function* () {
      const shim = join(root, 'claude-agent-acp.cmd');
      yield* Effect.promise(() => writeFile(shim, ''));
      expect(
        yield* inspectNpmPackageVersion(shim, '@agentclientprotocol/claude-agent-acp'),
      ).toBeUndefined();
    }),
  );
});

describe('NativeVersionCache', () => {
  it.live('caches inspected binary version by path + mtime and refreshes when mtime changes', () =>
    Effect.gen(function* () {
      const binary = join(root, process.platform === 'win32' ? 'agy.cmd' : 'agy');
      yield* Effect.promise(async () => {
        if (process.platform === 'win32') {
          await writeFile(binary, '@echo agy 1.2.3\r\n');
        } else {
          await writeFile(binary, '#!/bin/sh\necho "agy 1.2.3"\n', { mode: 0o755 });
        }
      });

      let spawns = 0;
      const cache = makeNativeVersionCache(() => {
        spawns += 1;
        return Effect.succeed(`1.2.${spawns}`);
      });

      expect(yield* cache.peek(binary)).toBeUndefined();
      expect(spawns).toBe(0);

      expect(yield* cache.inspect(binary)).toBe('1.2.1');
      expect(spawns).toBe(1);
      // Subsequent inspect and peek hit cache with zero additional spawns.
      expect(yield* cache.inspect(binary)).toBe('1.2.1');
      expect(yield* cache.peek(binary)).toBe('1.2.1');
      expect(spawns).toBe(1);

      // Updating mtime invalidates the cache entry.
      yield* Effect.promise(() =>
        utimes(binary, new Date(Date.now() + 5000), new Date(Date.now() + 5000)),
      );
      expect(yield* cache.peek(binary)).toBeUndefined();
      expect(yield* cache.inspect(binary)).toBe('1.2.2');
      expect(spawns).toBe(2);
    }),
  );
});
