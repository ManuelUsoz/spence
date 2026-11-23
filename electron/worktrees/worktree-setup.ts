import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

const MAX_OUTPUT_BYTES = 16_384;
const OUTPUT_THROTTLE_MS = 150;
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

const fileExists = (target: string): Promise<boolean> =>
  access(target).then(
    () => true,
    () => false,
  );

/**
 * Inspects a project folder for common lockfiles / build manifests and suggests a default setup command
 * to run in a newly created worktree before the first turn starts.
 */
export const detectProjectSetupCommand = async (
  folder: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> => {
  const has = (name: string) => fileExists(path.join(folder, name));

  if (await has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
  if (await has('yarn.lock')) return 'yarn install --frozen-lockfile';
  if ((await has('bun.lockb')) || (await has('bun.lock'))) return 'bun install --frozen-lockfile';
  if (await has('package-lock.json')) return 'npm ci';
  if (await has('package.json')) return 'npm install';

  if (await has('pom.xml')) {
    if (platform === 'win32' && (await has('mvnw.cmd'))) return 'mvnw.cmd -B test-compile';
    if (platform !== 'win32' && (await has('mvnw'))) return './mvnw -B test-compile';
    return 'mvn -B test-compile';
  }

  if ((await has('build.gradle')) || (await has('build.gradle.kts'))) {
    if (platform === 'win32' && (await has('gradlew.bat'))) return 'gradlew.bat classes';
    if (platform !== 'win32' && (await has('gradlew'))) return './gradlew classes';
    return 'gradle classes';
  }

  if (await has('Cargo.toml')) return 'cargo fetch';
  if (await has('go.mod')) return 'go mod download';
  if (await has('uv.lock')) return 'uv sync';
  if (await has('poetry.lock')) return 'poetry install';

  return null;
};

export interface WorktreeSetupRunResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly output: string;
}

const appendTail = (current: string, chunk: string): string => {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, 'utf8') <= MAX_OUTPUT_BYTES) return combined;
  const buf = Buffer.from(combined, 'utf8');
  return buf.subarray(buf.length - MAX_OUTPUT_BYTES).toString('utf8');
};

/**
 * Executes a shell setup command inside a newly created worktree, capturing a rolling output tail
 * and reporting progress via `onOutput`.
 */
export const runWorktreeSetupCommand = (
  cwd: string,
  command: string,
  onOutput?: (tail: string) => void,
  signal?: AbortSignal,
): Promise<WorktreeSetupRunResult> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, exitCode: null, output: 'Aborted.' });
      return;
    }

    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
    });
    child.stdin?.end();

    let output = '';
    let settled = false;
    let lastEmitAt = 0;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;

    const flushOutput = () => {
      if (pendingTimer !== undefined) {
        clearTimeout(pendingTimer);
        pendingTimer = undefined;
      }
      lastEmitAt = Date.now();
      onOutput?.(output);
    };

    const scheduleEmit = () => {
      if (onOutput === undefined) return;
      const elapsed = Date.now() - lastEmitAt;
      if (elapsed >= OUTPUT_THROTTLE_MS) {
        flushOutput();
      } else if (pendingTimer === undefined) {
        pendingTimer = setTimeout(flushOutput, OUTPUT_THROTTLE_MS - elapsed);
      }
    };

    const onData = (chunk: Buffer) => {
      output = appendTail(output, chunk.toString('utf8'));
      scheduleEmit();
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const terminate = () => {
      if (!child.killed) child.kill();
    };

    const timeout = setTimeout(() => {
      output = appendTail(output, '\nSetup command timed out.\n');
      terminate();
    }, SETUP_TIMEOUT_MS);

    const onAbort = () => {
      output = appendTail(output, '\nSetup command cancelled.\n');
      terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (ok: boolean, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (pendingTimer !== undefined) clearTimeout(pendingTimer);
      onOutput?.(output);
      resolve({ ok, exitCode, output });
    };

    child.once('error', (err) => {
      output = appendTail(output, `\n${err.message}\n`);
      finish(false, null);
    });

    child.once('close', (code) => {
      finish(code === 0, code);
    });
  });
