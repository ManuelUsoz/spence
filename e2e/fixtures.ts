import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { spawnSync, type ChildProcess } from 'node:child_process';
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

/** Kills the app and the Agent processes it spawned (a plain `kill()` leaves them holding the data folder). */
const killTree = (child: ChildProcess) => {
  if (child.pid !== undefined && process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
};

export type SpenceLocale = 'en' | 'es';

export interface SpenceOptions {
  spenceLocale: SpenceLocale;
  spenceSettings: Record<string, unknown>;
  spenceSidebarOpen: boolean;
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
    private readonly launchPeer: () => Promise<Spence>,
  ) {}

  /**
   * A second Spence, another Device on this machine: its own data directory, the same locale and Settings, loopback
   * only. Closed with this one. For the LAN flows, reached by `127.0.0.1:port` (no discovery under e2e).
   */
  peer(): Promise<Spence> {
    return this.launchPeer();
  }

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

interface LaunchOptions {
  readonly locale: SpenceLocale;
  readonly settings: Record<string, unknown>;
  readonly installedAgents: string[];
  readonly sidebarOpen: boolean;
}

interface Launched {
  readonly spence: Spence;
  readonly close: () => Promise<void>;
}

export const ensureSidebarOpen = async (page: Page): Promise<void> => {
  const sidebar = page.locator('hlm-sidebar');
  await sidebar.waitFor({ state: 'attached' });
  if ((await sidebar.getAttribute('data-state')) === 'collapsed') {
    await page.locator('[data-slot="sidebar-trigger"]').click();
    await expect(sidebar).toHaveAttribute('data-state', 'expanded');
    await expect
      .poll(async () => (await page.locator('[data-slot="sidebar-container"]').boundingBox())?.x)
      .toBe(50);
  }
};

/** Starts one Spence over its own fresh data directory; `close` quits it and removes the directory. */
const launch = async (options: LaunchOptions, peer: () => Promise<Spence>): Promise<Launched> => {
  const userData = mkdtempSync(path.join(tmpdir(), 'spence-e2e-'));
  const pickFolder = path.join(userData, 'folders', 'demo-project');
  mkdirSync(pickFolder, { recursive: true });
  mkdirSync(path.join(userData, 'spence'));
  const agentBin = path.join(userData, 'bin');
  installFakeAgent(agentBin);
  const env: NodeJS.ProcessEnv = { ...process.env };
  let installedBin: string | undefined;
  if (options.installedAgents.length > 0) {
    const pathBin = path.join(userData, 'path-bin');
    installedBin = pathBin;
    for (const name of options.installedAgents) installFakeAgent(pathBin, name);
    // Windows spells it `Path`; keep whichever key the environment already uses.
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = [env[pathKey], pathBin].filter(Boolean).join(path.delimiter);
  }
  // Linux runners have no OS keyring, where Pairing is refused: they use the e2e stand-in. Elsewhere the real one.
  if (process.platform === 'linux') env['SPENCE_E2E_SECRET_STORAGE'] = 'fake';
  writeFileSync(
    path.join(userData, 'spence', 'settings.json'),
    JSON.stringify({ version: 1, ...options.settings }),
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
      SPENCE_LOCALE: options.locale,
      SPENCE_E2E_PICK_FOLDER: pickFolder,
      // Where the in-app folder browser starts: the folder `pickNext` creates folders in.
      SPENCE_E2E_HOME: path.dirname(pickFolder),
      SPENCE_E2E_AGENT_BIN: agentBin,
      ...(installedBin === undefined ? {} : { SPENCE_E2E_INSTALLED_BIN: installedBin }),
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  if (options.sidebarOpen) {
    await ensureSidebarOpen(page);
  }
  const close = async () => {
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
    if (!closed) killTree(app.process());
    try {
      rmSync(userData, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    } catch {
      // A killed app's children can still hold the folder for a moment on Windows; it is a throwaway temp dir.
    }
  };
  return { spence: new Spence(app, page, userData, pickFolder, options.locale, peer), close };
};

export const test = base.extend<{
  spence: Spence;
  spenceLocale: SpenceLocale;
  spenceSettings: Record<string, unknown>;
  spenceInstalledAgents: string[];
  spenceSidebarOpen: boolean;
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
  /**
   * Whether the fixture expands the Sessions sidebar after launch. Most specs interact with sidebar controls
   * directly; specs testing the collapsed-by-default launch state set `spenceSidebarOpen: false`.
   */
  spenceSidebarOpen: [true, { option: true }],
  spence: async (
    { spenceLocale, spenceSettings, spenceInstalledAgents, spenceSidebarOpen },
    use,
  ) => {
    const options: LaunchOptions = {
      locale: spenceLocale,
      settings: spenceSettings,
      installedAgents: spenceInstalledAgents,
      sidebarOpen: spenceSidebarOpen,
    };
    const closers: Array<() => Promise<void>> = [];
    const peer = async (): Promise<Spence> => {
      const launched = await launch(options, peer);
      closers.push(launched.close);
      return launched.spence;
    };
    const main = await launch(options, peer);
    closers.push(main.close);
    await use(main.spence);
    await Promise.all(closers.map((close) => close()));
  },
});

export { expect };
