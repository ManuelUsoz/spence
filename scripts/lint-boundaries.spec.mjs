/**
 * The network boundary in eslint.config.js: only electron/lan/** and electron/devices/** may import ws,
 * bonjour-service or node:tls. Lints a probe import as if it sat in each zone's existing files.
 */
import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Only the import rule, without the type-aware program: the boundary needs no types and stays fast.
const eslint = new ESLint({
  cwd: root,
  ruleFilter: ({ ruleId }) => ruleId === 'no-restricted-imports',
  overrideConfig: { languageOptions: { parserOptions: { project: null } } },
});

const restricted = async (file, source) => {
  const [result] = await eslint.lintText(`${source}\nexport {};\n`, {
    filePath: path.join(root, file),
  });
  return result.messages
    .filter((message) => message.ruleId === 'no-restricted-imports')
    .map((message) => message.message);
};

const probes = ["import 'ws';", "import 'bonjour-service';", "import 'node:tls';"];

describe('network imports', () => {
  for (const file of [
    'src/app/core/tabs.ts',
    'src/app/features/app-info/app-info.ts',
    'src/shared/devices/devices.rpc.ts',
    'electron/main.ts',
    'electron/rpc/devices.ts',
  ]) {
    it(`are refused in ${file}`, async () => {
      for (const probe of probes) {
        const messages = await restricted(file, probe);
        expect(messages.length, probe).toBeGreaterThan(0);
      }
    });
  }

  for (const file of ['electron/lan/server.ts', 'electron/devices/certificate.ts']) {
    it(`are allowed in ${file}`, async () => {
      for (const probe of probes) expect(await restricted(file, probe), probe).toEqual([]);
    });
  }
});
