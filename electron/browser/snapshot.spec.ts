import { describe, expect, it } from 'vitest';
import { buildAccessibilitySnapshot, type CdpAxNode } from './snapshot';

describe('buildAccessibilitySnapshot', () => {
  it('formats an AXTree into a compact outline with deterministic refs mapped to backendDOMNodeId', () => {
    const nodes: ReadonlyArray<CdpAxNode> = [
      {
        nodeId: '1',
        role: { type: 'role', value: 'RootWebArea' },
        name: { type: 'computedString', value: 'Sign In' },
        childIds: ['2', '3', '4', '5', '6'],
      },
      {
        nodeId: '2',
        parentId: '1',
        role: { type: 'role', value: 'heading' },
        name: { type: 'computedString', value: 'Welcome' },
        properties: [{ name: 'level', value: { type: 'integer', value: 1 } }],
        backendDOMNodeId: 101,
        childIds: ['2a'],
      },
      {
        nodeId: '2a',
        parentId: '2',
        role: { type: 'role', value: 'StaticText' },
        name: { type: 'computedString', value: 'Welcome' },
      },
      {
        nodeId: '3',
        parentId: '1',
        ignored: true,
        role: { type: 'role', value: 'generic' },
        childIds: ['3a'],
      },
      {
        nodeId: '3a',
        parentId: '3',
        role: { type: 'role', value: 'textbox' },
        name: { type: 'computedString', value: 'Email' },
        value: { type: 'string', value: 'alice@example.com' },
        properties: [{ name: 'focused', value: { type: 'boolean', value: true } }],
        backendDOMNodeId: 202,
      },
      {
        nodeId: '4',
        parentId: '1',
        role: { type: 'role', value: 'checkbox' },
        name: { type: 'computedString', value: 'Remember me' },
        properties: [{ name: 'checked', value: { type: 'tristate', value: 'true' } }],
        backendDOMNodeId: 303,
      },
      {
        nodeId: '5',
        parentId: '1',
        role: { type: 'role', value: 'button' },
        name: { type: 'computedString', value: 'Submit' },
        backendDOMNodeId: 404,
        childIds: ['5a'],
      },
      {
        nodeId: '5a',
        parentId: '5',
        role: { type: 'role', value: 'StaticText' },
        name: { type: 'computedString', value: 'Submit' },
      },
      {
        nodeId: '6',
        parentId: '1',
        role: { type: 'role', value: 'paragraph' },
        name: { type: 'computedString', value: '' },
        childIds: ['6a'],
      },
      {
        nodeId: '6a',
        parentId: '6',
        role: { type: 'role', value: 'StaticText' },
        name: { type: 'computedString', value: 'Helper note' },
      },
    ];

    const result = buildAccessibilitySnapshot(nodes);

    expect(result.refs.get('e1')).toBe(202);
    expect(result.refs.get('e2')).toBe(303);
    expect(result.refs.get('e3')).toBe(404);
    expect(result.refs.size).toBe(3);

    expect(result.outline).toBe(
      [
        '- RootWebArea "Sign In"',
        '  - heading "Welcome" [level=1]',
        '  - textbox "Email" [ref=e1] [value="alice@example.com"] [focused]',
        '  - checkbox "Remember me" [ref=e2] [checked=true]',
        '  - button "Submit" [ref=e3]',
        '  - paragraph',
        '    - text "Helper note"',
      ].join('\n'),
    );
  });

  it('handles empty AXTree gracefully', () => {
    const result = buildAccessibilitySnapshot([]);
    expect(result.outline).toBe('(empty page)');
    expect(result.refs.size).toBe(0);
  });
});
