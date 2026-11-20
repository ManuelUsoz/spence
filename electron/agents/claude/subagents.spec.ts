import { describe, expect, it } from 'vitest';
import { AgentId } from '../../../src/shared/agents/agents.rpc';
import { sessionMetaFor } from '../catalog';
import { claudeSessionMeta } from './subagents';

describe('Claude session _meta for the Subagents Setting', () => {
  it('takes the built-in subagent tools away and points the Agent at delegate for Workers', () => {
    const meta = claudeSessionMeta('workers');
    expect(meta).toMatchObject({
      claudeCode: { options: { disallowedTools: ['Agent', 'Task'] } },
      systemPrompt: { append: expect.stringContaining('mcp__spence__delegate') },
    });
  });

  it('sends an empty restriction, not none, for native subagents', () => {
    expect(claudeSessionMeta('native')).toEqual({
      claudeCode: { options: { disallowedTools: [] } },
    });
  });

  it('gives only Claude a session _meta', () => {
    expect(sessionMetaFor(AgentId.make('claude'), 'workers')).toBeDefined();
    expect(sessionMetaFor(AgentId.make('codex'), 'workers')).toBeUndefined();
    expect(sessionMetaFor(AgentId.make('antigravity'), 'workers')).toBeUndefined();
  });
});
