import { Exit } from 'effect';

/** A read that is still going, failed, or answered. */
export type Load<A> =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'loaded'; readonly value: A };

export const LOADING: Load<never> = { status: 'loading' };

/** What an answered read holds, or null while it is loading or failed. */
export const valueOf = <A>(state: Load<A>): A | null =>
  state.status === 'loaded' ? state.value : null;

/** The end of a read: its value, or `failed`. */
export const fromExit = <A, E>(exit: Exit.Exit<A, E>): Load<A> =>
  Exit.isSuccess(exit) ? { status: 'loaded', value: exit.value } : { status: 'failed' };
