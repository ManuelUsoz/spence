import { Effect } from 'effect';
import type {
  PermissionRequest,
  TranscriptEvent,
  TranscriptItem,
  TurnId,
} from '../../src/shared/sessions/sessions.rpc';
import type { AcpError } from '../acp/acpErrors';
import type { AcpSession, AcpSessionId } from '../acp/acpSession';
import type { AcpSessionManager } from '../acp/acpSessionManager';

// Reopening a kept Session (spec 4.4): how it gets an ACP session again, and what the Transcript says about a Turn an
// earlier run never ended.

/** An ACP session for a kept Session, and whether the Agent's memory of the Session was lost on the way. */
export interface Reopened {
  readonly session: AcpSession;
  readonly lost: boolean;
}

/**
 * `session/resume` with the last ACP session id; if the Agent lacks it or refuses, `session/load` (its replay is
 * dropped); if that fails too, `session/new`, and the Agent's memory of the Session is lost. Fails only when even
 * `session/new` does.
 */
export const reopenAcpSession = (
  manager: AcpSessionManager,
  last: AcpSessionId | undefined,
  cwd: string,
): Effect.Effect<Reopened, AcpError> => {
  const fresh = manager
    .newSession(cwd)
    .pipe(Effect.map((session): Reopened => ({ session, lost: true })));
  if (last === undefined) return fresh;
  return manager.resumeSession(last, cwd).pipe(
    Effect.catch(() => manager.loadSession(last, cwd)),
    Effect.map((session): Reopened => ({ session, lost: false })),
    Effect.catch(() => fresh),
  );
};

/**
 * What closes a Turn an earlier run started and never ended: its pending Permission requests become `cancelled`,
 * and the Turn ends `failed { reason: interrupted }`. Nothing when every Turn ended.
 */
export const closeInterrupted = (
  events: ReadonlyArray<TranscriptEvent>,
): ReadonlyArray<TranscriptItem> => {
  let open: TurnId | undefined;
  const requests = new Map<PermissionRequest['id'], PermissionRequest>();
  for (const { item } of events) {
    if (item._tag === 'TurnStarted') open = item.turnId;
    if (item._tag === 'TurnEnded' && item.turnId === open) open = undefined;
    if (item._tag === 'PermissionRequest') requests.set(item.id, item);
  }
  if (open === undefined) return [];
  const turnId = open;
  const cancelled = [...requests.values()].flatMap((request): ReadonlyArray<TranscriptItem> =>
    request.turnId === turnId && request.state._tag === 'pending'
      ? [{ ...request, state: { _tag: 'cancelled' } }]
      : [],
  );
  return [
    ...cancelled,
    {
      _tag: 'TurnEnded',
      turnId,
      outcome: {
        _tag: 'failed',
        reason: 'interrupted',
        detail: 'Spence closed while the Turn was running',
      },
    },
  ];
};
