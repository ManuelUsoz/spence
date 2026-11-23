// Fast local Playwright runner: hidden Electron windows by default, parallel workers, en-only dev build.
//
//   node scripts/e2e/run-local.mjs --smoke
//   node scripts/e2e/run-local.mjs --affected
//   node scripts/e2e/run-local.mjs --smoke --no-build --visible
import { spawnSync } from 'node:child_process';
import { changedFiles, plan } from './affected.mjs';

const args = new Set(process.argv.slice(2));
const mode = args.has('--smoke') ? 'smoke' : args.has('--affected') ? 'affected' : null;

if (mode === null) {
  console.error(
    'Usage: node scripts/e2e/run-local.mjs <--smoke|--affected> [--no-build] [--visible]',
  );
  process.exit(2);
}

const noBuild = args.has('--no-build');
const visible = args.has('--visible');

const SMOKE_SPECS = ['e2e/smoke/app-info.spec.ts', 'e2e/projects/', 'e2e/browser/browser.spec.ts'];

let specs = SMOKE_SPECS;
let needsEs = false;

if (mode === 'affected') {
  const result = plan(changedFiles('origin/main', { workingTree: true }));
  if (result.mode === 'none') {
    console.log('e2e:affected: no affected E2E specs for current changes.');
    process.exit(0);
  }
  specs = result.specs;
  needsEs = result.es;
}

const run = (cmd, cmdArgs, extraEnv = {}) => {
  const res = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
};

if (!noBuild) {
  run('npm', ['run', needsEs ? 'build' : 'build:e2e']);
}

const pwArgs = [
  'playwright',
  'test',
  '--ignore-snapshots',
  '--pass-with-no-tests',
  '--project=en',
  ...(needsEs ? ['--project=es'] : []),
  ...specs,
];

const env = visible ? { SPENCE_E2E_VISIBLE: '1', SPENCE_E2E_WORKERS: '1' } : {};
run('npx', pwArgs, env);
