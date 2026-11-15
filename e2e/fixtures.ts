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
const packagedExecutable = process.env['SPENCE_E2E_EXECUTABLE'];
const electronPath: string =
  packagedExecutable ?? createRequire(path.join(root, 'package.json'))('electron');
const fakeAgent = path.join(root, 'electron', 'acp', 'fakeAgent.mjs');

/**
 * Puts a `fake-agent` shim (like an npm install) for the fake ACP Agent into `bin`; main runs Sessions with it when
 * `SPENCE_E2E_AGENT_BIN` points there.
 */
const installFakeAgent = (bin: string) => {
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    writeFileSync(
      path.join(bin, 'fake-agent.cmd'),
      `@"${process.execPath}" "${fakeAgent}" %*
`,
    );
  } else {
    writeFileSync(
      path.join(bin, 'fake-agent'),
      `#!/bin/sh
exec "${process.execPath}" "${fakeAgent}" "$@"
`,
      { mode: 0o755 },
    );
  }
};

export type SpenceLocale = 'en' | 'es';

export interface SpenceOptions {
  spenceLocale: SpenceLocale;
  spenceSettings: Record<string, unknown>;
  spencePauseWorktreeCreate: boolean;
}

/** Helpers shared by every spec. */
export class Spence {
  constructor(
    readonly app: ElectronApplication,
    readonly page: Page,
    /** The app data directory of this run. */
    readonly userData: string,
    /** The folder the stubbed folder picker answers with (`SPENCE_E2E_PICK_FOLDER`), named `demo-project`. */
    readonly pickFolder: string,
    /** The renderer locale pinned for this run (`SPENCE_LOCALE`). */
    readonly locale: SpenceLocale,
  ) {}

  /** Picks the string or value for the active renderer locale. */
  t<T>(byLocale: Readonly<Record<SpenceLocale, T>>): T {
    return byLocale[this.locale];
  }

  /** Screenshot filename for the active locale (`name-es.png` in Spanish, `name.png` in English). */
  shotFile(name: string): string {
    return this.locale === 'es' ? `${name}-es.png` : `${name}.png`;
  }

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

  /** Creates a folder named `name` and makes the stubbed folder picker answer with it from now on. */
  async pickNext(name: string): Promise<string> {
    const folder = path.join(path.dirname(this.pickFolder), name);
    mkdirSync(folder, { recursive: true });
    await this.app.evaluate((_electron, value) => {
      process.env['SPENCE_E2E_PICK_FOLDER'] = value;
    }, folder);
    return folder;
  }

  /** Screenshot of the window; baselines live next to the spec (see CLAUDE.md). */
  async shot(name: string, options: { mask?: ReturnType<Page['locator']>[] } = {}) {
    await expect(this.page).toHaveScreenshot(this.shotFile(name), options);
  }
}

export const test = base.extend<{
  spence: Spence;
  spenceLocale: SpenceLocale;
  spenceSettings: Record<string, unknown>;
  spencePauseWorktreeCreate: boolean;
}>({
  /** The renderer build to open (`SPENCE_LOCALE`); pinned so the OS language never decides the screenshots. */
  spenceLocale: ['en', { option: true }],
  /**
   * The `settings.json` a run starts with. Dark by default, so the OS appearance never decides the screenshots.
   */
  spenceSettings: [{ theme: 'dark' }, { option: true }],
  spencePauseWorktreeCreate: [false, { option: true }],
  spence: async ({ spenceLocale, spenceSettings, spencePauseWorktreeCreate }, use) => {
    const userData = mkdtempSync(path.join(tmpdir(), 'spence-e2e-'));
    const pickFolder = path.join(userData, 'folders', 'demo-project');
    mkdirSync(pickFolder, { recursive: true });
    mkdirSync(path.join(userData, 'spence'));
    const agentBin = path.join(userData, 'bin');
    installFakeAgent(agentBin);
    writeFileSync(
      path.join(userData, 'spence', 'settings.json'),
      JSON.stringify({ version: 1, ...spenceSettings }),
    );
    const app = await electron.launch({
      executablePath: electronPath,
      args: packagedExecutable === undefined ? [root] : [],
      // No emulation: the Theme Setting (nativeTheme in main) must decide prefers-color-scheme, as in production.
      colorScheme: null,
      env: {
        ...process.env,
        SPENCE_E2E: '1',
        SPENCE_USER_DATA: userData,
        SPENCE_LOCALE: spenceLocale,
        SPENCE_E2E_PICK_FOLDER: pickFolder,
        SPENCE_E2E_AGENT_BIN: agentBin,
        ...(spencePauseWorktreeCreate
          ? {
              SPENCE_E2E_WORKTREE_PAUSE: path.join(userData, 'worktree-paused.json'),
              SPENCE_E2E_WORKTREE_TRACE: path.join(userData, 'worktree-requests.txt'),
            }
          : {}),
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await use(new Spence(app, page, userData, pickFolder, spenceLocale));
    await app.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  },
});

export { expect };
