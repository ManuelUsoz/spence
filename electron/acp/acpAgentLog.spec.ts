import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { AgentLogs, layerAgentLogs, MAX_LOG_BYTES } from './acpAgentLog';

const tempDir = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), 'spence-log-'))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);

describe('AgentLogs', () => {
  it.live('moves a full log to <agent>.1.log and starts a fresh one', () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const big = 'x'.repeat(MAX_LOG_BYTES / 2);
      yield* Effect.scoped(
        AgentLogs.use((logs) => logs.open(AgentId.make('claude'))).pipe(
          Effect.tap((log) =>
            Effect.sync(() => {
              log.write(`first ${big}`);
              log.write(`second ${big}`);
              log.write('third');
            }),
          ),
        ),
      ).pipe(Effect.provide(layerAgentLogs(dir)));

      const current = yield* Effect.promise(() => readFile(join(dir, 'claude.log'), 'utf8'));
      const older = yield* Effect.promise(() => readFile(join(dir, 'claude.1.log'), 'utf8'));
      expect(older).toContain('first');
      expect(current).toContain('second');
      expect(current).toContain('third');
      expect(current).not.toContain('first');
    }).pipe(Effect.scoped),
  );
});
