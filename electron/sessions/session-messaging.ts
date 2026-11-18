import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { isNativeWorker, type SessionMeta } from './session-store';

/** How a reachable Session relates to the caller. */
export type Relation = 'parent' | 'ancestor' | 'child' | 'descendant' | 'sibling' | 'relative';

export interface Reachable {
  readonly id: SessionId;
  readonly relation: Relation;
}

/** A message that has already travelled this many hops is not forwarded again (ping-pong guard). */
export const MAX_MESSAGE_HOPS = 4;
/**
 * Workers nest at most this deep: a Session that is itself this many Workers below its root cannot delegate.
 * The root is depth 0, its Workers 1, theirs 2, and 3 is the deepest Worker.
 */
export const MAX_DELEGATION_DEPTH = 3;
/** A Session may wait on at most this many delegated Workers at once; further calls fail until one finishes. */
export const MAX_ACTIVE_WORKERS_PER_PARENT = 8;
/** One delegation tree may send this many messages per window. */
export const MESSAGE_RATE_LIMIT = 30;
export const MESSAGE_RATE_WINDOW_MS = 60_000;

type Parentage = Pick<SessionMeta, 'id' | 'parentSessionId' | 'workerKind'>;

/**
 * The Sessions a caller may message: every other Session of its delegation tree (the root Session and its owned
 * Workers, at any depth), derived only from persisted parentage. Provider-native Workers are read-only, so never.
 */
export const reachableFrom = (
  callerId: SessionId,
  metas: ReadonlyArray<Parentage>,
): ReadonlyArray<Reachable> => {
  const byId = new Map(metas.map((meta) => [meta.id, meta] as const));
  const ancestorsOf = (id: SessionId): ReadonlyArray<SessionId> => {
    const chain: SessionId[] = [];
    const seen = new Set<SessionId>([id]);
    let next = byId.get(id)?.parentSessionId;
    while (next !== undefined && !seen.has(next)) {
      chain.push(next);
      seen.add(next);
      next = byId.get(next)?.parentSessionId;
    }
    return chain;
  };
  const rootOf = (id: SessionId): SessionId => ancestorsOf(id).at(-1) ?? id;
  const callerAncestors = ancestorsOf(callerId);
  const callerRoot = rootOf(callerId);
  const callerParent = byId.get(callerId)?.parentSessionId;
  const reachable: Reachable[] = [];
  for (const meta of metas) {
    if (meta.id === callerId || rootOf(meta.id) !== callerRoot) continue;
    if (isNativeWorker(meta)) continue;
    const relation: Relation =
      meta.id === callerParent
        ? 'parent'
        : callerAncestors.includes(meta.id)
          ? 'ancestor'
          : meta.parentSessionId === callerId
            ? 'child'
            : ancestorsOf(meta.id).includes(callerId)
              ? 'descendant'
              : callerParent !== undefined && meta.parentSessionId === callerParent
                ? 'sibling'
                : 'relative';
    reachable.push({ id: meta.id, relation });
  }
  return reachable;
};

/** A sliding-window rate limiter: `allow` records an attempt and says whether it is within the limit. */
export const makeRateLimiter = (limit: number, windowMs: number) => {
  const attempts = new Map<string, number[]>();
  return (key: string, now: number): boolean => {
    const recent = (attempts.get(key) ?? []).filter((at) => now - at < windowMs);
    if (recent.length >= limit) {
      attempts.set(key, recent);
      return false;
    }
    attempts.set(key, [...recent, now]);
    return true;
  };
};
