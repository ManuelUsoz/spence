import { describe, expect, it } from 'vitest';
import { sessionCopy } from './session-copy';

describe('sessionCopy', () => {
  it('provides English memoryLost and handoff copy', () => {
    const en = sessionCopy('en');
    expect(en.memoryLostNoticeTitle).toBe("Earlier Messages weren't sent to this fresh context");
    expect(en.handoff.acknowledged).toBe('Handoff acknowledged.');
    expect(en.handoff.effortUnavailable('Codex')).toBe('Effort unavailable on Codex.');
  });

  it('provides Spanish memoryLost and handoff copy', () => {
    const es = sessionCopy('es');
    expect(es.memoryLostNoticeTitle).toBe(
      'Los Mensajes anteriores no se enviaron a este contexto nuevo',
    );
    expect(es.handoff.acknowledged).toBe('Transferencia confirmada.');
    expect(es.handoff.effortUnavailable('Codex')).toBe('Esfuerzo no disponible en Codex.');
    expect(es.handoff.askModeUnavailable('Antigravity')).toContain('Preguntar');
    expect(es.handoff.diskStateEdits).toContain('archivos');
  });
});
