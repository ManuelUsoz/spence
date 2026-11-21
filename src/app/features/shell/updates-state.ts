import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Effect, Schedule, Stream } from 'effect';
import type { UpdateState } from '../../../shared/updates/updates.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';

const followUpdates = (onChange: (state: UpdateState) => void) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    yield* api['Updates.watch']().pipe(
      Stream.runForEach((state) => Effect.sync(() => onChange(state))),
    );
  }).pipe(Effect.retry(Schedule.spaced('1 second')));

const check = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return yield* api['Updates.check']();
});

const download = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return yield* api['Updates.download']();
});

const restart = Effect.gen(function* () {
  const api = yield* DesktopApi;
  yield* api['Updates.restart']();
});

const openRelease = Effect.fnUntraced(function* (url: string) {
  const api = yield* DesktopApi;
  yield* api['Links.openExternal']({ url });
});

/** The detail of a tagged error from main; a broken connection gets a plain sentence. */
const detailOf = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'detail' in error) {
    const detail = (error as { readonly detail?: unknown }).detail;
    if (typeof detail === 'string' && detail !== '') return detail;
  }
  return $localize`Could not reach the updater.`;
};

/**
 * The updater as the window sees it: main checks at startup and every 24 hours, this follows what it reports.
 * Settings is only one view of it; the state survives the page closing and reopening. A failed check or
 * download is shown with its retry, and a verified update waits here until the user restarts.
 */
@Injectable({ providedIn: 'root' })
export class UpdatesState {
  private readonly runtime = inject(EffectRuntime);
  private readonly aborts = new AbortController();
  private readonly _state = signal<UpdateState>({ _tag: 'Idle' });
  private readonly _problem = signal<string | null>(null);

  readonly state = this._state.asReadonly();
  /** A restart or settings-time failure that never became a state: shown inline, cleared on the next action. */
  readonly problem = this._problem.asReadonly();
  readonly busy = computed(() => {
    const state = this._state();
    return state._tag === 'Checking' || state._tag === 'Downloading';
  });
  readonly ready = computed(() => this._state()._tag === 'Ready');

  constructor() {
    inject(DestroyRef).onDestroy(() => this.aborts.abort());
    void this.runtime.run(
      followUpdates((state) => {
        this._state.set(state);
        if (state._tag === 'Failed') this._problem.set(null);
      }),
      {
        signal: this.aborts.signal,
      },
    );
  }

  /** Checks now; startup and the 24-hour timer use the same path in main. */
  async check(): Promise<void> {
    this._problem.set(null);
    const exit = await this.run(check);
    if (exit !== null) this._state.set(exit);
  }

  async download(): Promise<void> {
    this._problem.set(null);
    const exit = await this.run(download);
    if (exit !== null) this._state.set(exit);
  }

  /** Asks main to quit and install; the existing quit confirm still has the last word. */
  async restart(): Promise<void> {
    this._problem.set(null);
    await this.run(restart);
  }

  async openRelease(url: string): Promise<void> {
    this._problem.set(null);
    await this.run(openRelease(url));
  }

  /**
   * Runs one updater call. `null` when it failed: an `UpdatesError` (nothing to install, a read-only AppImage)
   * is reported inline; anything else leaves the state stream to report it.
   */
  private async run<A>(effect: Effect.Effect<A, unknown, DesktopApi>): Promise<A | null> {
    const exit = await this.runtime.run(
      effect.pipe(
        Effect.catch((error: unknown) =>
          Effect.sync(() => {
            if (this._state()._tag !== 'Failed') this._problem.set(detailOf(error));
            return null;
          }),
        ),
      ),
      { signal: this.aborts.signal },
    );
    return exit._tag === 'Success' ? exit.value : null;
  }
}
