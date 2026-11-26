import { describe, expect, it } from 'vitest';
import {
  activeSlashToken,
  choosePopoverPlacement,
  removeSlashToken,
  replaceSlashToken,
  splitComposerSegments,
} from './composer-commands';

describe('composer-commands', () => {
  it('detects active slash tokens at start and in the middle of text, ignoring paths and trailing spaces', () => {
    expect(activeSlashToken('/', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(activeSlashToken('/rev', 4)).toEqual({ start: 0, end: 4, query: 'rev' });
    expect(activeSlashToken('Hola /rev', 9)).toEqual({ start: 5, end: 9, query: 'rev' });
    expect(activeSlashToken('Hola\n/rev mundo', 9)).toEqual({ start: 5, end: 9, query: 'rev' });

    expect(activeSlashToken('/review ', 8)).toBeNull();
    expect(activeSlashToken('/review algo', 12)).toBeNull();
    expect(activeSlashToken('src/app/core', 12)).toBeNull();
    expect(activeSlashToken('https://example.com/a', 21)).toBeNull();
    expect(activeSlashToken('/Users/miuso', 12)).toBeNull();
    expect(activeSlashToken('/rev', 1, 3)).toBeNull();
  });

  it('replaces and removes slash tokens cleanly in the middle of text', () => {
    const token = activeSlashToken('Hola /rev mundo', 9);
    expect(token).not.toBeNull();
    if (token === null) return;

    expect(replaceSlashToken('Hola /rev mundo', token, '/review')).toEqual({
      text: 'Hola /review mundo',
      caret: 13,
    });
    expect(replaceSlashToken('Hola /rev', { start: 5, end: 9, query: 'rev' }, '/review')).toEqual({
      text: 'Hola /review ',
      caret: 13,
    });
    expect(removeSlashToken('Hola /rev mundo', token)).toBe('Hola mundo');
    expect(removeSlashToken('/coord', { start: 0, end: 6, query: 'coord' })).toBe('');
  });

  it('splits composer text into plain and recognized command segments without altering characters', () => {
    const commands = new Set(['/clear', '/review', '$explain']);
    expect(splitComposerSegments('Hola /review y /clear luego', commands)).toEqual([
      { text: 'Hola ', isCommand: false },
      { text: '/review', isCommand: true },
      { text: ' y ', isCommand: false },
      { text: '/clear', isCommand: true },
      { text: ' luego', isCommand: false },
    ]);
    expect(splitComposerSegments('src/app/review /unknown', commands)).toEqual([
      { text: 'src/app/review /unknown', isCommand: false },
    ]);
  });

  it('picks popover placement toward the side with available viewport space', () => {
    const rect = (top: number, bottom: number, width = 400) => ({
      getBoundingClientRect: () => ({ top, bottom, width, height: bottom - top }) as DOMRect,
    });
    // Near bottom of viewport: opens upward even if downward was fallback.
    expect(choosePopoverPlacement(rect(680, 740), 800, 'down')).toBe('up');
    // In middle of viewport with room below: opens downward.
    expect(choosePopoverPlacement(rect(340, 400), 800, 'down')).toBe('down');
    // Near top of viewport: flips downward even if upward was fallback.
    expect(choosePopoverPlacement(rect(40, 80), 800, 'up')).toBe('down');
    // Zero-rect jsdom environment: uses fallback.
    expect(choosePopoverPlacement(rect(0, 0, 0), 800, 'up')).toBe('up');
  });
});
