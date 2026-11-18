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
const fakeAgent = path.join(root, 'electron', 'acp', 'fakeAgent.mjs');

/**
 * Extra Electron switches for every launch. Linux CI runners ship no setuid `chrome-sandbox` (and newer Ubuntu
 * restricts user namespaces), so Electron aborts at startup unless the sandbox is off; the tests run throwaway data.
 */
export const sandboxArgs: string[] = process.platform === 'linux' ? ['--no-sandbox'] : [];

/**
 * Puts a `fake-agent` shim (like an npm install) for the fake ACP Agent into `bin`; main runs Sessions with it when
 * `SPENCE_E2E_AGENT_BIN` points there.
 */
const installFakeAgent = (bin: string, name = 'fake-agent') => {
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    writeFileSync(
      path.join(bin, `${name}.cmd`),
      `@"${process.execPath}" "${fakeAgent}" %*
`,
    );
  } else {
    writeFileSync(
      path.join(bin, name),
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
  spenceInstalledAgents: string[];
}>({
  /**
   * Catalog binaries (e.g. `claude-agent-acp`) that must count as installed. They are appended to PATH, so a real
   * install on a dev machine still wins and a clean CI runner gets the same Agents page.
   */
  spenceInstalledAgents: [[], { option: true }],
  /** The renderer build to open (`SPENCE_LOCALE`); pinned so the OS language never decides the screenshots. */
  spenceLocale: ['en', { option: true }],
  /**
   * The `settings.json` a run starts with. Dark by default, so the OS appearance never decides the screenshots.
   */
  spenceSettings: [{ theme: 'dark' }, { option: true }],
  spence: async ({ spenceLocale, spenceSettings, spenceInstalledAgents }, use) => {
    const userData = mkdtempSync(path.join(tmpdir(), 'spence-e2e-'));
    const pickFolder = path.join(userData, 'folders', 'demo-project');
    mkdirSync(pickFolder, { recursive: true });
    mkdirSync(path.join(userData, 'spence'));
    const agentBin = path.join(userData, 'bin');
    installFakeAgent(agentBin);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (spenceInstalledAgents.length > 0) {
      const pathBin = path.join(userData, 'path-bin');
      for (const name of spenceInstalledAgents) installFakeAgent(pathBin, name);
      // Windows spells it `Path`; keep whichever key the environment already uses.
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
      env[pathKey] = [env[pathKey], pathBin].filter(Boolean).join(path.delimiter);
    }
    writeFileSync(
      path.join(userData, 'spence', 'settings.json'),
      JSON.stringify({ version: 1, ...spenceSettings }),
    );
    const app = await electron.launch({
      executablePath: electronPath,
      args: [root, ...sandboxArgs],
      // No emulation: the Theme Setting (nativeTheme in main) must decide prefers-color-scheme, as in production.
      colorScheme: null,
      env: {
        ...env,
        SPENCE_E2E: '1',
        SPENCE_USER_DATA: userData,
        SPENCE_LOCALE: spenceLocale,
        SPENCE_E2E_PICK_FOLDER: pickFolder,
        SPENCE_E2E_AGENT_BIN: agentBin,
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await use(new Spence(app, page, userData, pickFolder, spenceLocale));
    // A clean close can stall (e.g. main's quit confirmation while an Agent still works, which nobody answers): after
    // a grace period the process is killed so one test cannot eat the whole 60s timeout, then its folder is removed.
    let graceTimer: NodeJS.Timeout | undefined;
    const closed = await Promise.race([
      app.close().then(() => true),
      new Promise<false>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), 10_000);
      }),
    ]);
    clearTimeout(graceTimer);
    if (!closed) app.process().kill();
    rmSync(userData, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  },
});

export { expect };
