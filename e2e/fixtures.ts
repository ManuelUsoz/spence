import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
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

  /** Screenshot of the window; baselines live next to the spec (see CLAUDE.md). */
  async shot(name: string, options: { mask?: ReturnType<Page['locator']>[] } = {}) {
    await expect(this.page).toHaveScreenshot(`${name}.png`, options);
  }
}

export const test = base.extend<{ spence: Spence }>({
  spence: async ({}, use) => {
    const userData = mkdtempSync(path.join(tmpdir(), 'spence-e2e-'));
    const app = await electron.launch({
      executablePath: electronPath,
      args: [root],
      env: { ...process.env, SPENCE_E2E: '1', SPENCE_USER_DATA: userData },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await use(new Spence(app, page, userData));
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  },
});

export { expect };
