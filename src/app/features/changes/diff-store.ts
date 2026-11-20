import { Injectable, inject, signal } from '@angular/core';
import type { Effect } from 'effect';
import type { DiffResult } from '../../../shared/source-control/source-control.rpc';
import type { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { LOADING, fromExit, type Load } from './load';

/**
 * The diffs the page has read, by key: a path for the working tree, `sha:path` for a commit. One store serves the
 * Changes and History tabs, so both render the same viewer from the same cache. `reset` drops everything and makes
 * answers to reads that started before it be ignored; a newer read of a key wins over an older one that ends later.
 */
@Injectable()
export class DiffStore {
  private readonly runtime = inject(EffectRuntime);
  private generation = 0;
  /** The newest read started for each key. */
  private readonly latest = new Map<string, number>();
  private reads = 0;
  private readonly entries = signal<ReadonlyMap<string, Load<DiffResult>>>(new Map());

  /** The state of one diff; `loading` until it has been asked for and answered. */
  state(key: string): Load<DiffResult> {
    return this.entries().get(key) ?? LOADING;
  }

  has(key: string): boolean {
    return this.entries().has(key);
  }

  /** Reads a diff unless it is already known. `force` reads it again, keeping the old one on screen meanwhile. */
  load<E>(
    key: string,
    read: Effect.Effect<DiffResult, E, DesktopApi>,
    options?: { readonly force?: boolean },
  ): void {
    if (this.has(key) && options?.force !== true) return;
    const generation = this.generation;
    const ticket = ++this.reads;
    this.latest.set(key, ticket);
    if (!this.has(key)) this.entries.update((map) => new Map(map).set(key, LOADING));
    void this.runtime.run(read).then((exit) => {
      if (generation !== this.generation || this.latest.get(key) !== ticket) return;
      this.entries.update((map) => new Map(map).set(key, fromExit(exit)));
    });
  }

  /** Forgets every diff; reads already on their way are ignored. */
  reset(): void {
    this.generation += 1;
    this.latest.clear();
    this.entries.set(new Map());
  }
}
