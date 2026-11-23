import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProjectSetupCommand, runWorktreeSetupCommand } from './worktree-setup';

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spence-wt-setup-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('detectProjectSetupCommand', () => {
  it('detects pnpm, yarn, bun, npm, maven, gradle, cargo, go, uv, poetry, or returns null', async () => {
    const empty = await makeTempDir();
    expect(await detectProjectSetupCommand(empty)).toBeNull();

    const pnpmDir = await makeTempDir();
    await writeFile(path.join(pnpmDir, 'pnpm-lock.yaml'), '');
    await writeFile(path.join(pnpmDir, 'package.json'), '{}');
    expect(await detectProjectSetupCommand(pnpmDir)).toBe('pnpm install --frozen-lockfile');

    const npmDir = await makeTempDir();
    await writeFile(path.join(npmDir, 'package-lock.json'), '{}');
    await writeFile(path.join(npmDir, 'package.json'), '{}');
    expect(await detectProjectSetupCommand(npmDir)).toBe('npm ci');

    const mvnDir = await makeTempDir();
    await writeFile(path.join(mvnDir, 'pom.xml'), '<project/>');
    expect(await detectProjectSetupCommand(mvnDir, 'linux')).toBe('mvn -B test-compile');
    await writeFile(path.join(mvnDir, 'mvnw.cmd'), '');
    expect(await detectProjectSetupCommand(mvnDir, 'win32')).toBe('mvnw.cmd -B test-compile');

    const gradleDir = await makeTempDir();
    await writeFile(path.join(gradleDir, 'build.gradle.kts'), '');
    expect(await detectProjectSetupCommand(gradleDir, 'linux')).toBe('gradle classes');
    await writeFile(path.join(gradleDir, 'gradlew'), '');
    expect(await detectProjectSetupCommand(gradleDir, 'linux')).toBe('./gradlew classes');

    const cargoDir = await makeTempDir();
    await writeFile(path.join(cargoDir, 'Cargo.toml'), '');
    expect(await detectProjectSetupCommand(cargoDir)).toBe('cargo fetch');

    const goDir = await makeTempDir();
    await writeFile(path.join(goDir, 'go.mod'), '');
    expect(await detectProjectSetupCommand(goDir)).toBe('go mod download');

    const uvDir = await makeTempDir();
    await writeFile(path.join(uvDir, 'uv.lock'), '');
    expect(await detectProjectSetupCommand(uvDir)).toBe('uv sync');
  });
});

describe('runWorktreeSetupCommand', () => {
  it('runs a command, captures stdout/stderr, and reports exit status', async () => {
    const dir = await makeTempDir();
    const seen: string[] = [];

    const ok = await runWorktreeSetupCommand(dir, 'node -e "console.log(\'setup-ok\')"', (tail) =>
      seen.push(tail),
    );
    expect(ok.ok).toBe(true);
    expect(ok.exitCode).toBe(0);
    expect(ok.output).toContain('setup-ok');
    expect(seen.at(-1)).toContain('setup-ok');

    const failed = await runWorktreeSetupCommand(
      dir,
      'node -e "console.error(\'setup-bad\'); process.exit(2)"',
    );
    expect(failed.ok).toBe(false);
    expect(failed.exitCode).toBe(2);
    expect(failed.output).toContain('setup-bad');
  });
});
