import { describe, expect, it } from 'vitest';
import { MessageId, SessionId, TurnId } from '../../src/shared/sessions/sessions.rpc';
import {
  applyStatusFold,
  asksUser,
  createMutableStatusFold,
  deriveSessionStatus,
  snapshotStatusFold,
} from './status-fold';

describe('status-fold', () => {
  it('does not treat a coordinated cross-Project Message with exchangeId and without needsUser as asking the user', () => {
    const sender = {
      sessionId: SessionId.make('sender-1'),
      title: 'Coordinator',
      projectName: 'OtherProject',
      exchangeId: 'exchange-1',
    };
    expect(asksUser(sender)).toBe(false);

    const fold = createMutableStatusFold();
    applyStatusFold(fold, {
      _tag: 'Message',
      id: MessageId.make('m-1'),
      turnId: TurnId.make('t-1'),
      role: 'user',
      parts: [{ _tag: 'text', text: 'Run checks' }],
      from: sender,
    });
    const snapped = snapshotStatusFold(fold);
    expect(snapped.asked).toBe(false);
    expect(
      deriveSessionStatus({
        archived: false,
        fold: snapped,
        agentStatus: 'ready',
        working: true,
        openInRun: true,
      }),
    ).toBe('working');
    expect(
      deriveSessionStatus({
        archived: false,
        fold: snapped,
        agentStatus: 'ready',
        working: false,
        openInRun: true,
      }),
    ).toBe('idle');
  });

  it('treats needsUser: true or uncoordinated cross-Project non-person Messages as blocked', () => {
    expect(
      asksUser({
        sessionId: SessionId.make('sender-1'),
        title: 'Worker',
        projectName: 'OtherProject',
        exchangeId: 'exchange-1',
        needsUser: true,
      }),
    ).toBe(true);
    expect(
      asksUser({
        sessionId: SessionId.make('sender-2'),
        title: 'Peer',
        projectName: 'OtherProject',
      }),
    ).toBe(true);
    expect(
      asksUser({
        sessionId: SessionId.make('sender-3'),
        title: 'Person',
        projectName: 'OtherProject',
        by: 'person',
      }),
    ).toBe(false);
  });
});
