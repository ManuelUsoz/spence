import { describe, expect, it, vi } from 'vitest';
import {
  buildMacMenuTemplate,
  isBlockedProdKey,
  isProductionKeysDisabled,
  type KeyInput,
} from './menu';

const keyDown = (overrides: Partial<KeyInput>): KeyInput => ({
  type: 'keyDown',
  key: '',
  code: '',
  control: false,
  meta: false,
  shift: false,
  alt: false,
  ...overrides,
});

describe('isProductionKeysDisabled', () => {
  it('disables dev/reload keys in packaged builds even if env vars are set', () => {
    expect(isProductionKeysDisabled(true, { ELECTRON_RENDERER_URL: 'http://localhost:4200' })).toBe(
      true,
    );
    expect(isProductionKeysDisabled(true, { SPENCE_E2E: '1' })).toBe(true);
  });

  it('keeps dev/reload keys enabled for dev server and e2e when unpackaged', () => {
    expect(
      isProductionKeysDisabled(false, { ELECTRON_RENDERER_URL: 'http://localhost:4200' }),
    ).toBe(false);
    expect(isProductionKeysDisabled(false, { SPENCE_E2E: '1' })).toBe(false);
  });

  it('disables dev/reload keys for unpackaged production preview without dev server or e2e', () => {
    expect(isProductionKeysDisabled(false, {})).toBe(true);
  });
});

describe('isBlockedProdKey', () => {
  it('blocks reload keys Mod+R, Mod+Shift+R, and F5 on Windows/Linux and macOS', () => {
    expect(isBlockedProdKey(keyDown({ key: 'r', code: 'KeyR', control: true }), 'win32')).toBe(
      true,
    );
    expect(
      isBlockedProdKey(keyDown({ key: 'R', code: 'KeyR', control: true, shift: true }), 'linux'),
    ).toBe(true);
    expect(isBlockedProdKey(keyDown({ key: 'r', code: 'KeyR', meta: true }), 'darwin')).toBe(true);
    expect(
      isBlockedProdKey(keyDown({ key: 'R', code: 'KeyR', meta: true, shift: true }), 'darwin'),
    ).toBe(true);
    expect(isBlockedProdKey(keyDown({ key: 'F5', code: 'F5' }), 'win32')).toBe(true);
    expect(isBlockedProdKey(keyDown({ key: 'F5', code: 'F5' }), 'darwin')).toBe(true);
  });

  it('blocks DevTools keys Mod+Shift+I, Mod+Alt+I, and F12 (including macOS dead-key Option+I)', () => {
    expect(
      isBlockedProdKey(keyDown({ key: 'I', code: 'KeyI', control: true, shift: true }), 'win32'),
    ).toBe(true);
    expect(
      isBlockedProdKey(keyDown({ key: 'i', code: 'KeyI', control: true, alt: true }), 'linux'),
    ).toBe(true);
    expect(
      isBlockedProdKey(keyDown({ key: 'I', code: 'KeyI', meta: true, shift: true }), 'darwin'),
    ).toBe(true);
    expect(
      isBlockedProdKey(keyDown({ key: 'ˆ', code: 'KeyI', meta: true, alt: true }), 'darwin'),
    ).toBe(true);
    expect(isBlockedProdKey(keyDown({ key: 'F12', code: 'F12' }), 'win32')).toBe(true);
  });

  it('allows normal shortcuts, keyUp events, and non-matching modifier keys', () => {
    expect(isBlockedProdKey(keyDown({ key: 'n', code: 'KeyN', control: true }), 'win32')).toBe(
      false,
    );
    expect(isBlockedProdKey(keyDown({ key: ',', code: 'Comma', meta: true }), 'darwin')).toBe(
      false,
    );
    expect(isBlockedProdKey(keyDown({ key: 'r', code: 'KeyR', meta: true }), 'win32')).toBe(false);
    expect(isBlockedProdKey(keyDown({ key: 'r', code: 'KeyR', control: true }), 'darwin')).toBe(
      false,
    );
    expect(isBlockedProdKey(keyDown({ key: 'F2', code: 'F2' }), 'win32')).toBe(false);
    expect(
      isBlockedProdKey({ ...keyDown({ key: 'F5', code: 'F5' }), type: 'keyUp' }, 'win32'),
    ).toBe(false);
  });
});

describe('buildMacMenuTemplate', () => {
  it('builds a minimal App, Edit, Window menu without Reload or DevTools in production', () => {
    const onSettings = vi.fn();
    const template = buildMacMenuTemplate({
      appName: 'Spence',
      locale: 'en',
      includeDevItems: false,
      onSettings,
    });

    expect(template.map((item) => item.label ?? item.role)).toEqual([
      'Spence',
      'editMenu',
      'windowMenu',
    ]);

    const appSubmenu = template[0]?.submenu;
    expect(Array.isArray(appSubmenu)).toBe(true);
    if (!Array.isArray(appSubmenu)) return;

    const roles = appSubmenu.map((item) => item.role);
    expect(roles).toContain('about');
    expect(roles).toContain('quit');
    expect(roles).not.toContain('reload');
    expect(roles).not.toContain('toggleDevTools');

    const settings = appSubmenu.find((item) => item.label === 'Settings…');
    expect(settings?.accelerator).toBe('Command+,');
    settings?.click?.({} as never, undefined, {});
    expect(onSettings).toHaveBeenCalledOnce();
  });

  it('localizes Settings… to Spanish and includes View dev items only when includeDevItems is true', () => {
    const template = buildMacMenuTemplate({
      appName: 'Spence',
      locale: 'es',
      includeDevItems: true,
      onSettings: vi.fn(),
    });

    expect(template.map((item) => item.label ?? item.role)).toEqual([
      'Spence',
      'editMenu',
      'viewMenu',
      'windowMenu',
    ]);

    const appSubmenu = template[0]?.submenu;
    expect(Array.isArray(appSubmenu)).toBe(true);
    if (!Array.isArray(appSubmenu)) return;
    expect(appSubmenu.some((item) => item.label === 'Configuración…')).toBe(true);

    const viewSubmenu = template[2]?.submenu;
    expect(Array.isArray(viewSubmenu)).toBe(true);
    if (!Array.isArray(viewSubmenu)) return;
    expect(viewSubmenu.map((item) => item.role)).toEqual([
      'reload',
      'forceReload',
      'toggleDevTools',
    ]);
  });
});
