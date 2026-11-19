// Decides which e2e specs a change can reach, so a PR does not run the whole suite for a one-file fix.
//
//   node scripts/e2e/affected.mjs                   diff against origin/main (merge-base), prints JSON
//   node scripts/e2e/affected.mjs --base=<ref>      diff against another ref
//   node scripts/e2e/affected.mjs --full            force the full suite (what `main` does)
//
// The answer is `{ mode, specs, es }`:
//   mode  'none'    nothing the e2e suite can see changed (docs, unit specs)
//         'subset'  run only `specs` (spec folders or files)
//         'full'    run everything
//   es    whether the Spanish project must run too (translations or locale code changed)
//   windows  whether the Windows shards must run too (main process, harness or a full run)
//
// Rule of thumb: when in doubt, run everything. A path the map does not know under src/ or electron/ is `full`.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const ALL = ['smoke', 'i18n', 'settings', 'projects', 'shell', 'session', 'changes', 'browser'].map(
  (d) => `e2e/${d}/`,
);

/** Paths that can change how every flow behaves: any of these runs the whole suite. */
const FULL = [
  /^e2e\/fixtures\.ts$/,
  /^playwright\.config\.ts$/,
  /^package(-lock)?\.json$/,
  /^angular\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^scripts\/build-electron\.mjs$/,
  /^scripts\/e2e\//,
  /^\.github\/(workflows|actions)\//,
  /^electron\/(main|preload)\.ts$/,
  /^electron\/ipc\//,
  /^electron\/store\//,
  /^electron\/rpc\/(index|runtime|ipc-server|[^/]*-transport)[^/]*\.ts$/,
  /^src\/shared\/rpc\//,
  /^src\/app\/core\//,
  /^src\/app\/ui\//,
  /^src\/app\/[^/]+\.(ts|html|css)$/,
  /^src\/(main|index|styles)[^/]*$/,
  /^src\/types\//,
];

/** Never reaches a running app. */
const IGNORED = [
  /\.md$/,
  /^docs\//,
  /^\.(claude|worktrees)\//,
  /^e2e\/.*__screenshots__\//, // handled by `screenshotSpec`
  /\.spec\.(ts|mjs)$/, // unit specs: their own steps cover them (e2e specs are matched first)
  /^scripts\/(verify|i18n)/,
  /^scripts\/qualify-/,
  /^\.verify\//,
];

/** Area prefix -> the spec folders that exercise it. First match wins; order is specific before general. */
const AREAS = [
  [/^(src\/app\/features\/app-info|electron\/rpc\/app-info|src\/shared\/app-info)/, ['smoke']],
  [
    /^(src\/app\/features\/browser|electron\/browser|electron\/rpc\/browser|src\/shared\/browser)/,
    ['browser', 'session', 'shell'],
  ],
  [
    /^(src\/app\/features\/changes|electron\/(source-control|worktrees|files)|electron\/rpc\/(source-control|worktrees|files)|src\/shared\/(source-control|worktrees|files))/,
    ['changes'],
  ],
  [
    /^(src\/app\/features\/agent-install|electron\/agents|electron\/rpc\/agents|src\/shared\/agents)/,
    ['session', 'settings'],
  ],
  [
    /^(src\/app\/features\/session|electron\/(sessions|acp)|electron\/rpc\/(sessions|tabs)|src\/shared\/(sessions|tabs|links))/,
    ['session', 'shell'],
  ],
  [
    /^(src\/app\/features\/shell|electron\/(projects|menu)|electron\/rpc\/projects|src\/shared\/projects)/,
    ['shell', 'projects'],
  ],
  [
    /^(electron\/settings|electron\/rpc\/settings|src\/shared\/settings)/,
    ['settings', 'i18n', 'shell'],
  ],
  [/^electron\/i18n\//, ['i18n', 'settings']],
  [/^src\/locale\//, ['i18n', 'settings']],
];

/** Changes that need the Spanish project (translations, locale selection). */
const ES = [/^src\/locale\//, /^electron\/i18n\//, /^e2e\/i18n\//];

const specOf = (file) => file.match(/^(e2e\/[^/]+\/[^/]+\.spec\.ts)$/)?.[1];
const screenshotSpec = (file) =>
  file
    .match(/^(e2e\/[^/]+)\/__screenshots__\/([^/]+\.spec\.ts)\//)
    ?.slice(1)
    .join('/');

/** Main-process and harness changes are where Windows and Linux differ (paths, shells, git, sandbox). */
const WINDOWS = [/^electron\//, /^e2e\//, /^scripts\/build-electron\.mjs$/];

/** @param {string[]} files repo-relative, forward slashes */
export function plan(files, { full = false } = {}) {
  const live = files.filter((f) => specOf(f) || !IGNORED.some((re) => re.test(f)));
  const windows = full || live.some((f) => WINDOWS.some((re) => re.test(f)));
  const es = full || files.some((f) => ES.some((re) => re.test(f)));
  if (full || files.some((f) => FULL.some((re) => re.test(f)))) {
    return { mode: 'full', specs: ALL, es: true, windows: true };
  }
  const specs = new Set();
  for (const file of files) {
    const direct = specOf(file) ?? screenshotSpec(file);
    if (direct) {
      specs.add(direct);
      continue;
    }
    if (IGNORED.some((re) => re.test(file))) continue;
    const area = AREAS.find(([re]) => re.test(file));
    if (area) {
      for (const dir of area[1]) specs.add(`e2e/${dir}/`);
      continue;
    }
    // Anything else the app could load (src/, electron/, e2e/ helpers): do not guess.
    if (/^(src|electron|e2e)\//.test(file))
      return { mode: 'full', specs: ALL, es: true, windows: true };
  }
  if (specs.size === 0) return { mode: 'none', specs: [], es, windows };
  return { mode: 'subset', specs: [...specs].sort(), es, windows };
}

/** The e2e job matrix: Linux shards always, Windows shards only when the plan asks for them. */
export function matrix({ windows }, shards = 2) {
  const oses = [
    { name: 'linux', runner: 'ubuntu-latest' },
    ...(windows ? [{ name: 'windows', runner: 'windows-latest' }] : []),
  ];
  return {
    include: oses.flatMap((os) =>
      Array.from({ length: shards }, (_, i) => ({
        'os-name': os.name,
        os: os.runner,
        shard: i + 1,
        shards,
      })),
    ),
  };
}

function changedFiles(base) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const from = git('merge-base', base, 'HEAD');
  return git('diff', '--name-only', from, 'HEAD').split('\n').filter(Boolean);
}

if (process.argv[1]?.endsWith('affected.mjs')) {
  const args = process.argv.slice(2);
  const base = args.find((a) => a.startsWith('--base='))?.slice('--base='.length) ?? 'origin/main';
  const result = plan(args.includes('--full') ? [] : changedFiles(base), {
    full: args.includes('--full'),
  });
  console.log(JSON.stringify(result));
  // GitHub Actions step outputs: `specs` is a space-separated filter for `playwright test`.
  if (process.env['GITHUB_OUTPUT']) {
    appendFileSync(
      process.env['GITHUB_OUTPUT'],
      [
        `mode=${result.mode}`,
        `specs=${result.specs.join(' ')}`,
        `es=${result.es}`,
        `windows=${result.windows}`,
        `matrix=${JSON.stringify(matrix(result))}`,
        '',
      ].join('\n'),
    );
  }
}
