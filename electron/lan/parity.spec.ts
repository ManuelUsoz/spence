/**
 * The cross-device parity matrix (`parity-matrix.ts`): every regular-chat capability of the Local device against its
 * Remote counterpart. The table is diffed against the Local capability list, so a capability without a row fails here;
 * every row that has a case runs it once Local and once Remote, with the fake Agent, and the two must agree apart
 * from Provenance.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { RemoteRpcs } from '../../src/shared/rpc/remote-rpcs';
import { localCapabilities, parityMatrix, type Capability } from './parity-matrix';
import { runParityCase } from './parity-device';

/** Two Devices, two pairings, and the fake Agent on each side: longer than the default on a loaded machine. */
const TIMEOUT = 120_000;

const rpcTag = (capability: Capability): string | undefined =>
  capability.startsWith('rpc:') ? capability.slice('rpc:'.length) : undefined;

const covered = parityMatrix.flatMap((row) => row.covers);

describe('The cross-device parity matrix', () => {
  it('has a row for every Local capability, and no row for one that does not exist', () => {
    const local = new Set(localCapabilities());
    const missing = [...local].filter((capability) => !covered.includes(capability));
    const unknown = covered.filter((capability) => !local.has(capability));

    expect({ missing, unknown }).toEqual({ missing: [], unknown: [] });
  });

  it('covers each capability once', () => {
    const twice = covered.filter((capability, index) => covered.indexOf(capability) !== index);

    expect(twice).toEqual([]);
  });

  it('runs a case for every Same and Counterpart row, and only for them', () => {
    const wrong = parityMatrix.flatMap((row) => {
      const runs = row.parity._tag === 'Same' || row.parity._tag === 'Counterpart';
      return runs === (row.case !== undefined) ? [] : [row.id];
    });

    expect(wrong).toEqual([]);
  });

  it('serves a Paired device every call a Same row covers, and none a Local-only row covers', () => {
    const remote = new Set(RemoteRpcs.requests.keys());
    const unreachable = parityMatrix
      .filter((row) => row.parity._tag === 'Same' || row.parity._tag === 'Transport')
      .flatMap((row) => row.covers.flatMap((capability) => rpcTag(capability) ?? []))
      .filter((tag) => !remote.has(tag));
    const exposed = parityMatrix
      .filter((row) => row.parity._tag === 'LocalOnly')
      .flatMap((row) => row.covers.flatMap((capability) => rpcTag(capability) ?? []))
      .filter((tag) => remote.has(tag));

    expect({ unreachable, exposed }).toEqual({ unreachable: [], exposed: [] });
  });

  it('reaches a Counterpart only through calls a Paired device is served', () => {
    const remote = new Set(RemoteRpcs.requests.keys());
    const unserved = parityMatrix.flatMap((row) =>
      row.parity._tag === 'Counterpart'
        ? row.parity.remote.flatMap((capability) => {
            const tag = rpcTag(capability);
            return tag === undefined || remote.has(tag) ? [] : [tag];
          })
        : [],
    );

    expect(unserved).toEqual([]);
  });
});

describe('Local and Remote agree', () => {
  for (const row of parityMatrix) {
    const parityCase = row.case;
    if (parityCase === undefined) continue;
    it.live(
      row.title,
      () =>
        Effect.gen(function* () {
          const local = yield* runParityCase(parityCase, 'Local');
          const remote = yield* runParityCase(parityCase, 'Remote');

          expect(remote).toEqual(local);
        }),
      TIMEOUT,
    );
  }
});
