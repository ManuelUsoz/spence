import { describe, expect, it } from 'vitest';
import { afterLastWindow, onWindowClose, showsTray } from './resident';

describe('resident mode', () => {
  it('hosting off keeps today’s behaviour: closing the window quits on Windows and Linux', () => {
    expect(onWindowClose({ platform: 'win32', hosting: false })).toBe('quit');
    expect(onWindowClose({ platform: 'linux', hosting: false })).toBe('quit');
    expect(afterLastWindow({ platform: 'win32', hosting: false })).toBe('quit');
    expect(onWindowClose({ platform: 'darwin', hosting: false })).toBe('close');
    expect(afterLastWindow({ platform: 'darwin', hosting: false })).toBe('stay');
  });

  it('hosting on: closing the window never asks and the process stays, on every OS', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(onWindowClose({ platform, hosting: true })).toBe('close');
      expect(afterLastWindow({ platform, hosting: true })).toBe('stay');
    }
  });

  it('shows the tray only while hosting with no window open', () => {
    expect(showsTray({ hosting: true, windows: 0 })).toBe(true);
    expect(showsTray({ hosting: true, windows: 1 })).toBe(false);
    expect(showsTray({ hosting: false, windows: 0 })).toBe(false);
  });
});
