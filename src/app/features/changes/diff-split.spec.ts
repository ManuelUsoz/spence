import { describe, expect, it } from 'vitest';
import type { DiffLine } from '../../../shared/source-control/source-control.rpc';
import { toSplitRows } from './diff-split';

const ctx = (text: string, n: number): DiffLine => ({
  kind: 'context',
  oldLine: n,
  newLine: n,
  text,
});
const del = (text: string, n: number): DiffLine => ({ kind: 'delete', oldLine: n, text });
const add = (text: string, n: number): DiffLine => ({ kind: 'add', newLine: n, text });

describe('toSplitRows', () => {
  it('shows context on both sides', () => {
    const line = ctx('same', 1);
    expect(toSplitRows([line])).toEqual([{ left: line, right: line }]);
  });

  it('pairs a run of deletions with the run of additions after it', () => {
    const rows = toSplitRows([del('a', 1), del('b', 2), add('A', 1), add('B', 2)]);
    expect(rows.map((row) => [row.left?.text, row.right?.text])).toEqual([
      ['a', 'A'],
      ['b', 'B'],
    ]);
  });

  it('leaves gaps when one run is longer', () => {
    const rows = toSplitRows([del('a', 1), add('A', 1), add('B', 2)]);
    expect(rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      ['a', 'A'],
      [null, 'B'],
    ]);
  });

  it('puts a lone addition on the right and a lone deletion on the left', () => {
    expect(toSplitRows([add('x', 1)])).toEqual([{ left: null, right: add('x', 1) }]);
    expect(toSplitRows([del('y', 1)])).toEqual([{ left: del('y', 1), right: null }]);
  });

  it('keeps order across context lines', () => {
    const rows = toSplitRows([ctx('a', 1), del('b', 2), add('B', 2), ctx('c', 3)]);
    expect(rows.map((row) => row.left?.text ?? row.right?.text)).toEqual(['a', 'b', 'c']);
    expect(rows).toHaveLength(3);
  });
});
