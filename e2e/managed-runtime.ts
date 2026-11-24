import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fakeAgentScript = path.resolve(__dirname, '..', 'electron', 'acp', 'fakeAgent.mjs');
const fakeAgentUrl = pathToFileURL(fakeAgentScript).href;

/**
 * Seeds `<userData>/spence/runtime/node-v22.14.0/` with a local Node wrapper and an `npm-cli.js`
 * stub that installs managed adapters (`@spence/fake-agent`, `@agentclientprotocol/*`) offline.
 */
export const seedManagedRuntime = (userData: string): void => {
  const runtimeDir = path.join(userData, 'spence', 'runtime', 'node-v22.14.0');
  const isWin = process.platform === 'win32';
  const npmBin = isWin
    ? path.join(runtimeDir, 'node_modules', 'npm', 'bin')
    : path.join(runtimeDir, 'lib', 'node_modules', 'npm', 'bin');
  mkdirSync(isWin ? runtimeDir : path.join(runtimeDir, 'bin'), { recursive: true });
  mkdirSync(npmBin, { recursive: true });
  if (isWin) {
    copyFileSync(process.execPath, path.join(runtimeDir, 'node.exe'));
  } else {
    writeFileSync(
      path.join(runtimeDir, 'bin', 'node'),
      `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  writeFileSync(
    path.join(npmBin, 'npm-cli.js'),
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'const args = process.argv.slice(2);',
      "const prefix = args[args.indexOf('--prefix') + 1];",
      "const pkgSpec = args[args.length - 1] ?? '@spence/fake-agent';",
      "const atIdx = pkgSpec.lastIndexOf('@');",
      'const pkgName = atIdx > 0 ? pkgSpec.slice(0, atIdx) : pkgSpec;',
      "const pkgVersion = atIdx > 0 ? pkgSpec.slice(atIdx + 1) : '1.0.0';",
      "const isFake = pkgName === '@spence/fake-agent';",
      "const binName = isFake ? 'fake-agent' : pkgName.includes('codex') ? 'codex-acp' : 'claude-agent-acp';",
      "const entryName = isFake ? 'fake-agent.mjs' : `${binName}.js`;",
      `const entryBody = isFake ? ${JSON.stringify(`await import(${JSON.stringify(fakeAgentUrl)});\n`)} : '#!/usr/bin/env node\\n';`,
      "const pkgDir = path.join(prefix, 'node_modules', ...pkgName.split('/'));",
      "fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });",
      "fs.writeFileSync(path.join(pkgDir, 'bin', entryName), entryBody);",
      'fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: pkgName, version: pkgVersion, bin: { [binName]: `./bin/${entryName}` } }));',
      "process.stdout.write('added 1 package\\n');",
    ].join('\n'),
  );
};

export interface SeedManagedAdapterOptions {
  readonly agentId: string;
  readonly packageName: string;
  readonly binaryName: string;
  readonly version: string;
  readonly entrypointFile?: string;
  readonly entrypointSource?: string;
}

/** Seeds an already-installed managed adapter under `<userData>/spence/agents/<agentId>/`. */
export const seedManagedAdapter = (userData: string, options: SeedManagedAdapterOptions): void => {
  const entrypointFile = options.entrypointFile ?? `${options.binaryName}.js`;
  const entrypointSource =
    options.entrypointSource ??
    (options.packageName === '@spence/fake-agent'
      ? `process.argv.splice(2, 0, '--version=${options.version}');\nawait import(${JSON.stringify(fakeAgentUrl)});\n`
      : '#!/usr/bin/env node\n');
  const pkgDir = path.join(
    userData,
    'spence',
    'agents',
    options.agentId,
    'node_modules',
    ...options.packageName.split('/'),
  );
  mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  writeFileSync(path.join(pkgDir, 'bin', entrypointFile), entrypointSource);
  writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({
      name: options.packageName,
      version: options.version,
      bin: { [options.binaryName]: `./bin/${entrypointFile}` },
    }),
  );
};
