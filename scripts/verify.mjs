// Deterministic verification loop: `npm run verify`.
//
// Runs every gate in a fixed order and prints one line per step plus the tail of any failure,
// so a human or an agent can loop "change -> verify -> fix" without reading full logs.
//
//   node scripts/verify.mjs              all steps, stops at the first failure (fail fast)
//   node scripts/verify.mjs --all        run every step even after a failure
//   node scripts/verify.mjs lint test    only the named steps, in the given order
//   node scripts/verify.mjs --json       also write .verify/last.json (machine-readable result)
//   node scripts/verify.mjs --list       print the step names
//
// Exit code: 0 when every selected step passed, 1 otherwise.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

/** Cheapest and most informative first, so the loop fails fast. */
const STEPS = [
  { name: 'format', cmd: 'npm run --silent format:check' },
  { name: 'typecheck-electron', cmd: 'npm run --silent typecheck:electron' },
  { name: 'typecheck-app', cmd: 'npm run --silent typecheck:app' },
  { name: 'typecheck-spec', cmd: 'npm run --silent typecheck:spec' },
  { name: 'lint', cmd: 'npm run --silent lint' },
  { name: 'test-renderer', cmd: 'npm run --silent test' },
  { name: 'test-electron', cmd: 'npm run --silent test:electron' },
  { name: 'i18n', cmd: 'npm run --silent i18n:check' },
];

const TAIL_LINES = 40;

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const names = args.filter((a) => !a.startsWith('--'));

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
const results = [];

for (const step of selected) {
  const started = Date.now();
  const run = spawnSync(step.cmd, {
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
  });
  const ms = Date.now() - started;
  const ok = run.status === 0;
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trimEnd();
  results.push({
    name: step.name,
    ok,
    ms,
    ...(ok ? {} : { tail: output.split('\n').slice(-TAIL_LINES).join('\n') }),
  });

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step.name}  (${(ms / 1000).toFixed(1)}s)`);
  if (!ok) {
    console.log(results.at(-1).tail.replace(/^/gm, '      '));
    if (!flags.has('--all')) break;
  }
}

const failed = results.filter((r) => !r.ok);
const skipped = selected.length - results.length;
console.log(
  failed.length === 0
    ? `\nverify: OK (${results.length} steps)`
    : `\nverify: FAILED at ${failed.map((r) => r.name).join(', ')}${skipped > 0 ? ` (${skipped} not run; use --all)` : ''}`,
);

if (flags.has('--json')) {
  mkdirSync('.verify', { recursive: true });
  writeFileSync(
    '.verify/last.json',
    `${JSON.stringify({ ok: failed.length === 0, results }, null, 2)}\n`,
  );
}

process.exit(failed.length === 0 ? 0 : 1);
