import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const electronPath: string = createRequire(path.join(root, 'package.json'))('electron');

/** Helpers shared by every spec. */
export class Spence {
  constructor(
    readonly app: ElectronApplication,
    readonly page: Page,
    /** The app data directory of this run. */
    readonly userData: string,
  ) {}

  /**
   * Changes Settings through main's e2e hook (`electron/settings/e2e-hook.ts`), exactly as `Settings.update` does,
   * for flows whose UI does not exist yet.
   */
  async updateSettings(patch: Record<string, unknown>) {
    await this.app.evaluate(async (_electron, value) => {
      const hook = (globalThis as { spenceE2E?: { updateSettings: (p: unknown) => Promise<void> } })
        .spenceE2E;
      if (!hook) throw new Error('the e2e hook is not installed (SPENCE_E2E=1?)');
      await hook.updateSettings(value);
    }, patch);
  }

  /** Screenshot of the window; baselines live next to the spec (see CLAUDE.md). */
  async shot(name: string, options: { mask?: ReturnType<Page['locator']>[] } = {}) {
    await expect(this.page).toHaveScreenshot(`${name}.png`, options);
  }
}

export const test = base.extend<{
  spence: Spence;
  spenceLocale: 'en' | 'es';
  spenceSettings: Record<string, unknown>;
}>({
  /** The renderer build to open (`SPENCE_LOCALE`); pinned so the OS language never decides the screenshots. */
  spenceLocale: ['en', { option: true }],
  /**
   * The `settings.json` a run starts with. Dark by default, so the OS appearance never decides the screenshots.
   */
  spenceSettings: [{ theme: 'dark' }, { option: true }],
  spence: async ({ spenceLocale, spenceSettings }, use) => {
    const userData = mkdtempSync(path.join(tmpdir(), 'spence-e2e-'));
    mkdirSync(path.join(userData, 'spence'));
    writeFileSync(
      path.join(userData, 'spence', 'settings.json'),
      JSON.stringify({ version: 1, ...spenceSettings }),
    );
    const app = await electron.launch({
      executablePath: electronPath,
      args: [root],
      // No emulation: the Theme Setting (nativeTheme in main) must decide prefers-color-scheme, as in production.
      colorScheme: null,
      env: {
        ...process.env,
        SPENCE_E2E: '1',
        SPENCE_USER_DATA: userData,
        SPENCE_LOCALE: spenceLocale,
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await use(new Spence(app, page, userData));
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  },
});

export { expect };
