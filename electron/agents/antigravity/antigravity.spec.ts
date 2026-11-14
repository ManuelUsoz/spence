import { describe, expect, it } from 'vitest';
import { qualifyVersion } from '../version';
import { ANTIGRAVITY_QUALIFIED_VERSION, antigravity } from './antigravity';

describe('antigravity catalog entry', () => {
  it('uses native agy acp launch with official Google install and login instructions', () => {
    expect(antigravity.installKind).toBe('native');
    expect(antigravity.package).toBe('');
    expect(antigravity.binary).toBe('agy');
    expect(antigravity.args).toEqual(['acp']);
    expect(antigravity.installInstructions).toContain('antigravity.google');
    expect(antigravity.installInstructions).toContain('Re-scan');
    expect(antigravity.loginInstructions).toContain('Google account');
  });

  it('qualifies agy 1.2.0+ and marks earlier or unknown versions unverified', () => {
    expect(ANTIGRAVITY_QUALIFIED_VERSION).toBe('1.2.0');
    expect(qualifyVersion('1.2.0', antigravity.qualification)).toBe('qualified');
    expect(qualifyVersion('1.3.1', antigravity.qualification)).toBe('qualified');
    expect(qualifyVersion('1.1.9', antigravity.qualification)).toBe('unverified');
    expect(qualifyVersion(undefined, antigravity.qualification)).toBe('unverified');
  });

  it('excludes ineligible third-party models for a spence client with a limitation note', () => {
    const filter = antigravity.filterModels;
    expect(filter).toBeDefined();
    if (filter === undefined) return;

    const onlyEligible = filter([
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    ]);
    expect(onlyEligible.models.map((m) => m.id)).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
    expect(onlyEligible.excludedNote).toBeUndefined();

    const mixed = filter([
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'Claude-Sonnet-4', name: 'Claude Sonnet 4' },
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'o1-preview', name: 'o1 Preview' },
      { id: 'o3-mini', name: 'o3-mini' },
      { id: 'o4-mini', name: 'o4-mini' },
    ]);
    expect(mixed.models.map((m) => m.id)).toEqual(['gemini-2.5-pro']);
    expect(mixed.excludedNote).toContain('Third-party models');
  });
});
