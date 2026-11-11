// Guardrail for the project's mechanical rules (see AGENTS.md / CODING_STANDARDS.md).
// Not a style pass: only the rules below are on. Every message states what to use instead,
// so an agent can fix a violation from the lint output alone (`npm run lint`, `npm run verify`).
const fs = require('node:fs');
const path = require('node:path');
const tseslint = require('typescript-eslint');

const TESTS = ['**/*.spec.ts', '**/*-fakes.ts'];

// Edge files that may run effects with the global `Effect.run*` functions.
const RUNTIME_EDGE = ['src/app/core/effect-runtime.ts', 'electron/rpc/runtime.ts'];

// Intentional composition roots, not re-export barrels.
const MERGE_POINTS = ['electron/ipc/index.ts', 'electron/rpc/index.ts'];

// ---------------------------------------------------------------------------
// Syntax rules
// ---------------------------------------------------------------------------
const syntax = {
  newError: {
    selector: "NewExpression[callee.name='Error']",
    message: 'Define a Schema.TaggedError with `reason` + `detail`, or turn a non-actionable failure into a defect (Effect.die / toWireDefect).',
  },
  throwStatement: {
    selector: 'ThrowStatement',
    message: 'Fail with a Schema.TaggedError (`return yield* new XError(...)`) or Effect.die; wrap throwing APIs in Effect.try / Effect.tryPromise.',
  },
  tagProbe: {
    selector: "BinaryExpression[operator='in'][left.value='_tag']",
    message: 'Match errors by tag with Effect.catchTag / Effect.catchTags (or Predicate.isTagged for a known tag).',
  },
  sendSync: {
    selector: "MemberExpression[property.name='sendSync']",
    message: 'Synchronous IPC blocks the renderer. Use the RPC MessagePort (DesktopApi).',
  },
  messageField: {
    selector:
      "CallExpression[callee.callee.object.name='Schema'][callee.callee.property.name='TaggedError'] > ObjectExpression > Property[key.name='message']",
    message: 'Name the field `detail` (and categorise with `reason`): `message` shadows Error.prototype.message and breaks Equal/Hash.',
  },
  arrowGen: {
    selector: "ArrowFunctionExpression > CallExpression.body[callee.object.name='Effect'][callee.property.name='gen']",
    message: 'Use Effect.fn("Domain.method")(function* (...) {}) or Effect.fnUntraced(function* (...) {}) instead of an arrow returning Effect.gen.',
  },
  barrel: {
    selector: 'Program',
    message: 'No barrel index.ts files: import from the defining module.',
  },
  // Dependency injection: the renderer reaches the desktop shell only through the DesktopApi service.
  ipcRenderer: {
    selector: "MemberExpression[object.name='ipcRenderer']",
    message: 'The renderer never uses ipcRenderer. Depend on DesktopApi (src/app/core/desktop-api.ts).',
  },
  injectDesktopPort: {
    selector: "CallExpression[callee.name='inject'] > Identifier[name=/^(RpcClient|MessagePort)$/]",
    message: 'Do not inject transport pieces. Depend on DesktopApi through an Effect (`yield* DesktopApi`) run by EffectRuntime.',
  },
};

const v3Names = [
  { object: 'Context', property: 'Tag', message: 'Effect 4: use Context.Service.' },
  { object: 'Effect', property: 'Service', message: 'Effect 4: use Context.Service.' },
  { object: 'Schema', property: 'TaggedErrorClass', message: 'Effect 4: use Schema.TaggedError.' },
  { object: 'Layer', property: 'scoped', message: 'Effect 4: use Layer.effect(Tag, effect).' },
  { object: 'Layer', property: 'unwrapScoped', message: 'Effect 4: use Layer.unwrap.' },
  { object: 'Effect', property: 'catchAll', message: 'Effect 4: use Effect.catch.' },
  { object: 'Effect', property: 'either', message: 'Effect 4: use Effect.result.' },
];

const runAtEdge = 'Run effects at the edge: EffectRuntime.run in Angular, MainRuntime in main, it.effect in tests.';
const effectRuns = ['runPromise', 'runPromiseExit', 'runSync', 'runSyncExit', 'runFork', 'runCallback'].map((property) => ({
  object: 'Effect',
  property,
  message: runAtEdge,
}));

const windowDesktop = {
  object: 'window',
  property: 'desktop',
  message: 'Depend on DesktopApi; only src/app/core/desktop-port.ts touches window.desktop.',
};

// ---------------------------------------------------------------------------
// Import boundaries
//
// `no-restricted-imports` options replace each other when blocks overlap, so every zone is
// built here from the same base and the blocks below never overlap (specs re-apply last).
// ---------------------------------------------------------------------------
const effectPaths = [
  { name: 'effect', importNames: ['ServiceMap'], message: 'Effect 4: use Context.Service.' },
  { name: 'effect', importNames: ['Mailbox'], message: 'Effect 4: use Queue.' },
];
const effectPatterns = [
  {
    group: ['@effect/*', '!@effect/vitest'],
    message: 'Import from `effect`, `effect/rpc` or `effect/reactivity` (FileSystem / Path come from `effect`). Only @effect/vitest is allowed.',
  },
  { group: ['effect/unstable/*'], message: 'effect/unstable is a different API line. Import from `effect`, `effect/rpc` or `effect/reactivity`.' },
  { group: ['@effect-atom/*'], message: 'Use `effect/reactivity`.' },
];

const SPARTAN_MSG =
  'Spartan and the Angular CDK are used only inside src/app/ui (the helm components). Import the component from its alias instead, e.g. `@ui/button`; to add one run `ng g @spartan-ng/cli:ui <name>`.';
const uiLibs = { group: ['@spartan-ng/*', '@angular/cdk', '@angular/cdk/*'], message: SPARTAN_MSG };
const uiInternals = {
  group: ['@ui/*/src/*', '**/ui/*/src/*', '**/ui/*/src/**'],
  message: 'Import a UI component only through its alias (`@ui/<component>`), never its internals.',
};
const noElectronInRenderer = {
  group: ['electron', 'electron/*', '**/electron/**', 'node:*'],
  message: 'The renderer is untrusted and has no Node or Electron. Reach main through DesktopApi (src/app/core/desktop-api.ts).',
};
const noRendererInMain = {
  group: ['@angular/*', '@spartan-ng/*', '@ui/*', '**/src/app/**', '**/app/**'],
  message: 'electron/ must not depend on the renderer. Share wire contracts through src/shared.',
};
const sharedIsPure = {
  group: ['electron', 'electron/*', '@angular/*', '@spartan-ng/*', '@ui/*', 'rxjs', 'rxjs/*', '**/electron/**', '**/app/**', 'node:*'],
  message: 'src/shared holds wire contracts only: schemas, errors, RpcGroups. No Electron, Angular, Node or renderer code.',
};
const featureWireInternals = {
  group: ['**/shared/rpc/*', 'effect/rpc'],
  message: 'RPC transport is internal to src/app/core. Features use DesktopApi and the domain contract in src/shared/<domain>.',
};
const featureCoreInternals = {
  group: ['**/core/desktop-port', '**/core/desktop-layers', '**/core/desktop-error'],
  message: 'Features get the desktop shell by depending on DesktopApi and running effects with EffectRuntime; layers and ports are wired in core.',
};
const uiIsLeaf = {
  group: ['**/features/**', '**/core/**', '**/shared/**', '../../shared/**', 'effect', 'effect/*'],
  message: 'src/app/ui is presentational: no features, core services, wire contracts or Effect. Pass data in through inputs and out through outputs.',
};

const imports = (...extra) => ['error', { paths: effectPaths, patterns: [...effectPatterns, ...extra] }];

// One block per feature folder: a feature never imports a sibling feature.
const featuresDir = path.join(__dirname, 'src/app/features');
const featureNames = fs.existsSync(featuresDir)
  ? fs.readdirSync(featuresDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];
const featureBlocks = featureNames.map((name) => {
  const siblings = featureNames.filter((n) => n !== name);
  return {
    files: [`src/app/features/${name}/**/*.ts`],
    ignores: TESTS,
    rules: {
      'no-restricted-imports': imports(
        noElectronInRenderer,
        uiLibs,
        uiInternals,
        featureWireInternals,
        featureCoreInternals,
        ...(siblings.length > 0
          ? [
              {
                group: siblings.flatMap((s) => [`**/features/${s}`, `**/features/${s}/**`, `../${s}`, `../${s}/**`, `../../${s}/**`]),
                message: 'A feature never imports another feature. Move what is shared into src/app/core (services) or src/app/ui (presentation).',
              },
            ]
          : []),
      ),
    },
  };
});

const appSyntax = [syntax.newError, syntax.throwStatement, syntax.tagProbe, syntax.sendSync, syntax.messageField, syntax.arrowGen];
const rendererSyntax = [...appSyntax, syntax.ipcRenderer, syntax.injectDesktopPort];
const testSyntax = [syntax.tagProbe, syntax.sendSync, syntax.messageField];

// ---------------------------------------------------------------------------
// Type-aware TypeScript rules (the "strict TypeScript" loop)
// ---------------------------------------------------------------------------
const typeRules = {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-non-null-assertion': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/switch-exhaustiveness-check': 'error',
  '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
  '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description' }],
  '@typescript-eslint/no-unnecessary-type-assertion': 'error',
  eqeqeq: ['error', 'always'],
  'no-console': ['error', { allow: ['warn', 'error'] }],
};

module.exports = tseslint.config(
  // Only application code is linted: src/ and electron/.
  { ignores: ['**/*', '!src/', '!src/**', '!electron/', '!electron/**'] },
  {
    files: ['src/**/*.ts', 'electron/**/*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: ['./tsconfig.electron.json', './tsconfig.app.json', './tsconfig.spec.json'], tsconfigRootDir: __dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      ...typeRules,
      'no-restricted-syntax': ['error', ...appSyntax],
      'no-restricted-properties': ['error', ...v3Names, ...effectRuns],
      'no-restricted-imports': imports(),
    },
  },
  {
    files: TESTS,
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-syntax': ['error', ...testSyntax],
      'no-restricted-properties': ['error', ...v3Names],
    },
  },
  {
    files: RUNTIME_EDGE,
    rules: { 'no-restricted-properties': ['error', ...v3Names] },
  },
  {
    files: ['src/**/index.ts', 'electron/**/index.ts'],
    ignores: [...MERGE_POINTS, 'src/app/ui/**'],
    rules: { 'no-restricted-syntax': ['error', ...appSyntax, syntax.barrel] },
  },

  // --- zones ---------------------------------------------------------------
  {
    // Wire contracts: pure.
    files: ['src/shared/**/*.ts'],
    rules: { 'no-restricted-imports': imports(sharedIsPure) },
  },
  {
    // Main: never the renderer.
    files: ['electron/**/*.ts'],
    rules: { 'no-restricted-imports': imports(noRendererInMain) },
  },
  {
    // Renderer: no Electron or Node; the desktop shell is DesktopApi.
    files: ['src/app/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...rendererSyntax],
      'no-restricted-properties': ['error', ...v3Names, ...effectRuns, windowDesktop],
      'no-restricted-imports': imports(noElectronInRenderer),
    },
  },
  {
    // core owns the transport; it may use Electron-free wire internals but not Spartan.
    files: ['src/app/core/**/*.ts'],
    rules: { 'no-restricted-imports': imports(noElectronInRenderer, uiLibs, uiInternals) },
  },
  ...featureBlocks,
  {
    // The Spartan helm components: the only place that may import Spartan and the CDK.
    files: ['src/app/ui/**/*.ts'],
    // Generated helm files carry `eslint-disable @angular-eslint/component-selector`; angular-eslint is not
    // installed, so register that rule as a no-op so the directive resolves instead of failing lint.
    plugins: {
      '@angular-eslint': { rules: { 'component-selector': { meta: { schema: false }, create: () => ({}) } } },
    },
    rules: {
      'no-restricted-imports': imports(noElectronInRenderer, uiIsLeaf),
      // Vendored by the Spartan CLI and regenerated by it: held to the boundary rules only.
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    // Re-apply the test and edge exemptions on top of the renderer blocks above.
    files: ['src/**/*.spec.ts', 'src/**/*-fakes.ts', 'src/app/core/effect-runtime.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...testSyntax],
      'no-restricted-properties': ['error', ...v3Names, { object: 'window', property: 'desktop', message: 'Depend on DesktopApi.' }],
      'no-restricted-imports': imports(noElectronInRenderer),
    },
  },
  {
    // The one file that touches window.desktop.
    files: ['src/app/core/desktop-port.ts'],
    rules: { 'no-restricted-properties': ['error', ...v3Names, ...effectRuns] },
  },
);
