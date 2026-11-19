/**
 * Live probes of the cross-device parity matrix: the same cases as `parity.spec.ts`, with a real Agent on both
 * Devices, each once Local and once Remote. Opt-in, one Agent per variable, never part of `npm run verify` or CI:
 *
 *   SPENCE_CLAUDE_ACP_BIN / SPENCE_CODEX_ACP_BIN / SPENCE_ANTIGRAVITY_ACP_BIN = the folder holding the adapter
 *   SPENCE_QUALIFICATION_OUT = a folder to write `cross-device-<agent>.md` rows into (optional)
 *
 * A row passes when both runs succeed with the same outcome (a real Agent words its answers differently each run, so
 * only outcomes are compared), fails otherwise, and is Unproven when the Agent cannot be asked for it reliably. Copy
 * the rows into `docs/qualification/cross-device-<agent>.md` with the exact adapter version.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { antigravity } from '../agents/antigravity/antigravity';
import type { CatalogEntry } from '../agents/catalog';
import { claude } from '../agents/claude/claude';
import { codex } from '../agents/codex/codex';
import { liveScript, type ParityAgent, runParityCase, Unproven } from './parity-device';
import { parityMatrix } from './parity-matrix';

type Status = 'Pass' | 'Fail' | 'Unproven';

const probes: ReadonlyArray<{ readonly entry: CatalogEntry; readonly bin: string | undefined }> = [
  { entry: claude, bin: process.env['SPENCE_CLAUDE_ACP_BIN'] },
  { entry: codex, bin: process.env['SPENCE_CODEX_ACP_BIN'] },
  { entry: antigravity, bin: process.env['SPENCE_ANTIGRAVITY_ACP_BIN'] },
];

/** The adapter version the Device finds on its PATH, as Settings > Agents shows it. */
const versionOf = (agent: ParityAgent, entry: CatalogEntry) =>
  runParityCase(
    (side) =>
      Effect.map(
        side.call((api) => api['Agents.list']()),
        (agents) => ({
          outcome: agents.find((listed) => listed.id === entry.id)?.installedVersion ?? 'unknown',
        }),
      ),
    'Local',
    agent,
  ).pipe(Effect.map(({ outcome }) => String(outcome)));

const statusOf = (exit: Exit.Exit<unknown, unknown>): Status | 'Ok' => {
  if (Exit.isSuccess(exit)) return 'Ok';
  return exit.cause.reasons.some(
    (reason) => reason._tag === 'Die' && reason.defect instanceof Unproven,
  )
    ? 'Unproven'
    : 'Fail';
};

for (const { entry, bin } of probes) {
  describe.runIf(bin !== undefined)(`Cross-device parity with real ${entry.name} ACP`, () => {
    it.live(
      'runs every row once Local and once Remote and records Pass, Fail or Unproven',
      () =>
        Effect.gen(function* () {
          const agent: ParityAgent = {
            catalog: [entry],
            ...(bin === undefined ? {} : { path: bin }),
            script: liveScript,
          };
          const version = yield* versionOf(agent, entry);
          const rows: Array<{
            readonly id: string;
            readonly title: string;
            readonly status: Status;
          }> = [];
          for (const row of parityMatrix) {
            const parityCase = row.case;
            if (parityCase === undefined) continue;
            const local = yield* Effect.exit(runParityCase(parityCase, 'Local', agent));
            const remote = yield* Effect.exit(runParityCase(parityCase, 'Remote', agent));
            const statuses = [statusOf(local), statusOf(remote)];
            const status: Status = statuses.includes('Unproven')
              ? 'Unproven'
              : statuses.includes('Fail') ||
                  !Exit.isSuccess(local) ||
                  !Exit.isSuccess(remote) ||
                  JSON.stringify(local.value.outcome) !== JSON.stringify(remote.value.outcome)
                ? 'Fail'
                : 'Pass';
            rows.push({ id: row.id, title: row.title, status });
          }
          const record = [
            `Adapter: \`${entry.package || entry.binary}\` ${version}, ${new Date().toISOString().slice(0, 10)}`,
            '',
            '| Row | Case | Status |',
            '| --- | --- | --- |',
            ...rows.map((row) => `| \`${row.id}\` | ${row.title} | ${row.status} |`),
            '',
          ].join('\n');
          const out = process.env['SPENCE_QUALIFICATION_OUT'];
          if (out !== undefined)
            yield* Effect.promise(() =>
              writeFile(path.join(out, `cross-device-${entry.id}.md`), record),
            );
          else console.warn(record);
          expect(rows.filter((row) => row.status === 'Fail')).toEqual([]);
        }),
      3_600_000,
    );
  });
}
