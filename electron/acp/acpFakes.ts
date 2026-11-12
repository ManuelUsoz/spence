import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Layer } from 'effect';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import type { CatalogEntry } from '../agents/catalog';
import { fakePermissionModes } from '../agents/e2e-agent';
import { layerPathSources, MergedPath } from '../agents/merged-path';
import { layerAgentLogs } from './acpAgentLog';
import { layerAcpClient } from './acpSessionManager';

const FAKE_AGENT = fileURLToPath(new URL('./fakeAgent.mjs', import.meta.url));

/** The fake Agent as a Catalog entry; `args` are its launch arguments (see `fakeAgent.mjs`). */
export const fakeEntry = (args: ReadonlyArray<string> = []): CatalogEntry => ({
  id: AgentId.make('fake'),
  name: 'Fake',
  package: '@spence/fake-agent',
  binary: 'fake-agent',
  args,
  registryId: 'fake',
  imageLimits: { maxBase64Bytes: 1024, maxDimensionPx: 100, maxPerMessage: 1 },
  effort: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
  permissionModes: fakePermissionModes,
});

/** A temp folder holding a `fake-agent` shim (like an npm install) and the Agent logs, removed with the scope. */
export const installFakeAgent = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await mkdtemp(join(tmpdir(), 'spence-acp-'));
    const bin = join(root, 'bin');
    await mkdir(bin, { recursive: true });
    if (process.platform === 'win32') {
      await writeFile(join(bin, 'fake-agent.cmd'), `@"${process.execPath}" "${FAKE_AGENT}" %*\r\n`);
    } else {
      await writeFile(
        join(bin, 'fake-agent'),
        `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGENT}" "$@"\n`,
        { mode: 0o755 },
      );
    }
    return { bin, logs: join(root, 'logs') };
  }),
  ({ bin }) => Effect.promise(() => rm(join(bin, '..'), { recursive: true, force: true })),
);

/** The production `AcpClient` with the fake Agent on the merged PATH and the logs in a temp folder. */
export const layerAcpClientWithFakeAgent = (install: {
  readonly bin: string;
  readonly logs: string;
}) =>
  layerAcpClient.pipe(
    Layer.provide(layerAgentLogs(install.logs)),
    Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed(install.bin) })),
    Layer.provide(layerPathSources),
  );
