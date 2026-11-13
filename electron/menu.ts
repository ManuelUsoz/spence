import type { Input, MenuItemConstructorOptions } from 'electron';
import type { Locale } from './i18n/locale';
import { menuCopy } from './i18n/menu';

/** Subset of Electron's `Input` needed to decide whether a shortcut is blocked in production. */
export type KeyInput = Pick<Input, 'type' | 'key' | 'code' | 'control' | 'meta' | 'shift' | 'alt'>;

export interface MacMenuOptions {
  readonly appName: string;
  readonly locale: Locale;
  readonly includeDevItems: boolean;
  readonly onSettings: () => void;
}

/**
 * Production builds (packaged, or unpackaged without the Vite/Angular dev server and outside e2e) disable
 * browser reload and DevTools shortcuts.
 */
export const isProductionKeysDisabled = (
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
): boolean => isPackaged || (!env['ELECTRON_RENDERER_URL'] && env['SPENCE_E2E'] !== '1');

/**
 * Returns `true` for reload (`Mod+R`, `Mod+Shift+R`, `F5`) and DevTools (`Mod+Shift+I`, `Mod+Alt+I`, `F12`)
 * keyDown events on `platform`. Checks `code` alongside `key` so Option+I dead keys on macOS are caught.
 */
export const isBlockedProdKey = (input: KeyInput, platform: NodeJS.Platform): boolean => {
  if (input.type !== 'keyDown') return false;
  const mod = platform === 'darwin' ? input.meta : input.control;
  const key = input.key.toLowerCase();

  if (input.key === 'F5' || input.code === 'F5') return true;
  if (input.key === 'F12' || input.code === 'F12') return true;
  if (mod && !input.alt && (key === 'r' || input.code === 'KeyR')) return true;
  if (mod && (input.shift || input.alt) && (key === 'i' || input.code === 'KeyI')) return true;
  return false;
};

/**
 * Builds the minimal macOS application menu (`App`, `Edit`, `Window`, plus `View` dev items only when
 * `includeDevItems` is `true`). `Settings…` invokes `onSettings` without crossing RPC.
 */
export const buildMacMenuTemplate = ({
  appName,
  locale,
  includeDevItems,
  onSettings,
}: MacMenuOptions): MenuItemConstructorOptions[] => {
  const copy = menuCopy(locale);
  const template: MenuItemConstructorOptions[] = [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: copy.settings, accelerator: 'Command+,', click: onSettings },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    ...(includeDevItems
      ? [
          {
            role: 'viewMenu' as const,
            submenu: [
              { role: 'reload' as const },
              { role: 'forceReload' as const },
              { role: 'toggleDevTools' as const },
            ],
          },
        ]
      : []),
    { role: 'windowMenu' },
  ];
  return template;
};
