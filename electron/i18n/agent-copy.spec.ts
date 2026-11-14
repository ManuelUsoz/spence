import { describe, expect, it } from 'vitest';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { agentCopy } from './agent-copy';

describe('agentCopy', () => {
  it('returns English copy for Antigravity and Codex', () => {
    const agy = agentCopy('en', AgentId.make('antigravity'));
    expect(agy?.installInstructions).toContain('antigravity.google');
    expect(agy?.loginInstructions).toContain('Google account');
    expect(agy?.excludedNote).toContain('Third-party models');

    const codex = agentCopy('en', AgentId.make('codex'));
    expect(codex?.loginInstructions).toContain('ChatGPT');
  });

  it('returns Spanish copy for Antigravity and Codex', () => {
    const agy = agentCopy('es', AgentId.make('antigravity'));
    expect(agy?.upgradeCommand).toContain('Actualiza Google Antigravity');
    expect(agy?.installInstructions).toContain('Volver a buscar');
    expect(agy?.loginInstructions).toContain('cuenta de Google');
    expect(agy?.excludedNote).toContain('modelos de terceros');

    const codex = agentCopy('es', AgentId.make('codex'));
    expect(codex?.loginInstructions).toContain('cuenta de ChatGPT');
  });

  it('returns undefined for agents without localized catalog copy', () => {
    expect(agentCopy('es', AgentId.make('claude'))).toBeUndefined();
  });
});
