// Deterministic verification loop: `npm run verify`.
//
// Runs every gate concurrently and prints one line per step plus the tail of any failure,
// so a human or an agent can loop "change -> verify -> fix" without reading full logs.
//
//   node scripts/verify.mjs              all steps concurrently, kills the rest on the first failure
//   node scripts/verify.mjs --all        run every step even after a failure
//   node scripts/verify.mjs lint test    only the named steps
//   node scripts/verify.mjs --jobs=3     limit concurrency (default: one per 3 cores, at least 2)
//   node scripts/verify.mjs --json       also write .verify/last.json (machine-readable result)
//   node scripts/verify.mjs --list       print the step names
//
// Steps share no output, so order only matters for fail-fast: the slow ones start first so the
// wall time is the slowest step, not the sum. Exit code: 0 when every selected step passed.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

/** Slowest first: with a concurrency cap the long steps must not start last. */
const STEPS = [
  { name: 'test-electron', cmd: 'npm run --silent test:electron' },
  { name: 'test-renderer', cmd: 'npm run --silent test' },
  { name: 'lint', cmd: 'npm run --silent lint' },
  { name: 'i18n', cmd: 'npm run --silent i18n:check' },
  { name: 'typecheck-spec', cmd: 'npm run --silent typecheck:spec' },
  { name: 'typecheck-electron', cmd: 'npm run --silent typecheck:electron' },
  { name: 'typecheck-app', cmd: 'npm run --silent typecheck:app' },
  { name: 'format', cmd: 'npm run --silent format:check' },
];

const TAIL_LINES = 40;

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--') && !a.includes('=')));
const names = args.filter((a) => !a.startsWith('--'));
const jobsArg = args.find((a) => a.startsWith('--jobs='));

if (flags.has('--list')) {
  console.log(STEPS.map((s) => s.name).join('\n'));
  process.exit(0);
}

const unknown = names.filter((n) => !STEPS.some((s) => s.name === n));
if (unknown.length > 0) {
  console.error(
    `Unknown step(s): ${unknown.join(', ')}. Known: ${STEPS.map((s) => s.name).join(', ')}`,
  );
  process.exit(2);
}

const selected = names.length > 0 ? names.map((n) => STEPS.find((s) => s.name === n)) : STEPS;
const failFast = !flags.has('--all');
// About one step per 3 cores: the git-heavy electron specs time out when every step fights for the CPU.
const jobs = Math.max(
  1,
  jobsArg
    ? Number(jobsArg.slice('--jobs='.length))
    : Math.min(selected.length, Math.max(2, Math.floor(availableParallelism() / 3))),
);

/** Kills a step and its children: `shell: true` makes the pid a wrapper, not the real worker. */
function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

const results = new Map();
const running = new Set();
let aborted = false;

function runStep(step) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(step.cmd, {
      shell: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
    });
    const entry = { child, cancelled: false };
    running.add(entry);
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => {
      running.delete(entry);
      const ms = Date.now() - started;
      if (entry.cancelled) return resolve();
      const ok = code === 0;
      const result = {
        name: step.name,
        ok,
        ms,
        ...(ok ? {} : { tail: output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n') }),
      };
      results.set(step.name, result);
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${step.name}  (${(ms / 1000).toFixed(1)}s)`);
      if (!ok) {
        console.log(result.tail.replace(/^/gm, '      '));
        if (failFast && !aborted) {
          aborted = true;
          for (const other of running) {
            other.cancelled = true;
            killTree(other.child);
          }
        }
      }
      resolve();
    });
  });
}

const started = Date.now();
const queue = [...selected];
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (!aborted && queue.length > 0) await runStep(queue.shift());
  }),
);
const wall = Date.now() - started;

// Report in step order, whatever order they finished in.
const ordered = selected.map((s) => results.get(s.name)).filter(Boolean);
const failed = ordered.filter((r) => !r.ok);
const skipped = selected.length - ordered.length;
const sum = ordered.reduce((total, r) => total + r.ms, 0);
console.log(
  failed.length === 0
    ? `\nverify: OK (${ordered.length} steps, ${(wall / 1000).toFixed(1)}s wall, ${(sum / 1000).toFixed(1)}s serial-equivalent)`
    : `\nverify: FAILED at ${failed.map((r) => r.name).join(', ')}${skipped > 0 ? ` (${skipped} not finished; use --all)` : ''}`,
);

if (flags.has('--json')) {
  mkdirSync('.verify', { recursive: true });
  writeFileSync(
    '.verify/last.json',
    `${JSON.stringify({ ok: failed.length === 0, wallMs: wall, results: ordered }, null, 2)}\n`,
  );
}

process.exit(failed.length === 0 ? 0 : 1);
