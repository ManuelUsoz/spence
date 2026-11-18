import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it } from 'vitest';
import type { EffortMap } from '../agents/catalog';
import { agentValue, chooseStart, foldOptions, toCommands } from './session-options';

/** Claude-like: Spence's levels named the Agent's way. */
const effortMap: EffortMap = { low: 'low', medium: 'medium', high: 'high', max: 'max' };

const model = (currentValue: string): SessionConfigOption => ({
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue,
  options: [
    { value: 'sonnet', name: 'Sonnet', description: 'Everyday' },
    { value: 'opus', name: 'Opus' },
  ],
});

const thought = (currentValue: string, values: ReadonlyArray<string>): SessionConfigOption => ({
  id: 'effort',
  name: 'Effort',
  category: 'thought_level',
  type: 'select',
  currentValue,
  options: values.map((value) => ({ value, name: value.toUpperCase() })),
});

describe('foldOptions', () => {
  it('names the Models as the Agent does and hides every other option', () => {
    const options = foldOptions(
      [
        model('opus'),
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'x',
          options: [],
        },
      ],
      effortMap,
      'auto',
    );
    expect(options).toEqual({
      model: {
        value: 'opus',
        choices: [
          { id: 'sonnet', name: 'Sonnet', description: 'Everyday' },
          { id: 'opus', name: 'Opus' },
        ],
      },
      permissionMode: 'auto',
    });
  });

  it('reads the Agent effort value as a Spence level, offering only the levels the Agent has', () => {
    const options = foldOptions([thought('high', ['low', 'high'])], effortMap, 'ask');
    expect(options.effort).toEqual({ value: 'high', choices: ['low', 'high'] });
    expect(options.model).toBeUndefined();
  });

  it('flattens grouped Model choices', () => {
    const grouped: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'b',
      options: [
        {
          group: 'g',
          name: 'G',
          options: [
            { value: 'a', name: 'A' },
            { value: 'b', name: 'B' },
          ],
        },
      ],
    };
    expect(foldOptions([grouped], effortMap, 'auto').model?.choices.map((c) => c.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('has no Effort when the Agent has no thought level, or none of its values maps', () => {
    expect(foldOptions([], effortMap, 'auto').effort).toBeUndefined();
    expect(foldOptions([thought('turbo', ['turbo'])], effortMap, 'auto').effort).toBeUndefined();
  });
});

describe('agentValue', () => {
  it('maps a Spence level to the option and value the Agent knows', () => {
    const map: EffortMap = { low: 'minimal', medium: 'normal', high: 'deep', max: 'deepest' };
    expect(
      agentValue([thought('normal', ['minimal', 'normal', 'deep'])], map, 'effort', 'high'),
    ).toEqual({ configId: 'effort', value: 'deep' });
  });

  it('refuses a level or Model the Agent does not offer', () => {
    expect(agentValue([thought('low', ['low'])], effortMap, 'effort', 'max')).toBeUndefined();
    expect(agentValue([model('opus')], effortMap, 'model', 'haiku')).toBeUndefined();
    expect(agentValue([model('opus')], effortMap, 'model', 'sonnet')).toEqual({
      configId: 'model',
      value: 'sonnet',
    });
  });
});

describe('chooseStart', () => {
  const offered = ['sonnet', 'opus'];

  it('starts on the pin, else on the last used, else on the Agent default', () => {
    expect(chooseStart({ pinned: 'opus', last: 'sonnet', offered })).toBe('opus');
    expect(chooseStart({ last: 'opus', offered })).toBe('opus');
    expect(chooseStart({ offered })).toBeUndefined();
  });

  it('starts a pin the Agent no longer offers on the Agent default, not on the last used', () => {
    expect(chooseStart({ pinned: 'haiku', last: 'opus', offered })).toBeUndefined();
  });

  it('starts on the Agent default when the last used is no longer offered', () => {
    expect(chooseStart({ last: 'haiku', offered })).toBeUndefined();
  });
});

describe('toCommands', () => {
  it('maps names, descriptions, hints, owner and invocation; keeps Agent clear for the renderer to reserve', () => {
    expect(
      toCommands(
        [
          { name: 'clear', description: 'Clear' },
          { name: 'compact', description: 'Compact the context' },
          { name: 'review', description: 'Review', input: { hint: 'what to review' } },
        ],
        'Claude',
      ),
    ).toEqual([
      {
        id: 'Claude:clear',
        name: 'clear',
        invocation: '/clear',
        owner: { kind: 'agent', name: 'Claude' },
        kind: 'command',
        description: 'Clear',
      },
      {
        id: 'Claude:compact',
        name: 'compact',
        invocation: '/compact',
        owner: { kind: 'agent', name: 'Claude' },
        kind: 'command',
        description: 'Compact the context',
      },
      {
        id: 'Claude:review',
        name: 'review',
        invocation: '/review',
        owner: { kind: 'agent', name: 'Claude' },
        kind: 'command',
        description: 'Review',
        hint: 'what to review',
      },
    ]);
  });

  it('uses only explicit adapter evidence for a Skill and an exact invocation', () => {
    expect(
      toCommands(
        [
          {
            name: 'review',
            description: 'Review',
            _meta: { kind: 'skill', invocation: '/review' },
          },
          {
            name: '$explain',
            description: 'Explain',
            _meta: { kind: 'command', invocation: '$explain' },
          },
        ],
        'Codex',
      ),
    ).toEqual([
      {
        id: 'Codex:review',
        name: 'review',
        invocation: '/review',
        owner: { kind: 'agent', name: 'Codex' },
        kind: 'skill',
        description: 'Review',
      },
      {
        id: 'Codex:$explain',
        name: 'explain',
        invocation: '$explain',
        owner: { kind: 'agent', name: 'Codex' },
        kind: 'command',
        description: 'Explain',
      },
    ]);
  });
});
