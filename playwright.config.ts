import { defineConfig } from '@playwright/test';
import type { SpenceOptions } from './e2e/fixtures';

// Electron e2e + visual regression. Baselines live next to each spec in __screenshots__/.
// `npm run e2e` builds and runs; `npm run e2e:update` regenerates the baselines.
export default defineConfig<SpenceOptions>({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'e2e-output/results',
  // Each test launches its own Electron with a private userData dir (and its own single-instance lock), so tests
  // are independent. Locally windows are real and share your desktop: serial by default. CI has a display per job
  // (Xvfb on Linux), so it runs a few at once. `SPENCE_E2E_WORKERS` overrides both.
  workers: Number(process.env['SPENCE_E2E_WORKERS'] ?? (process.env['CI'] ? 2 : 1)),
  fullyParallel: false,
  // One retry on CI: slow Windows runners sometimes start the app with "Could not load Projects" (the renderer's first
  // load fails and is not retried). A retry shows up as "flaky" in the report, so it stays visible.
  retries: process.env['CI'] ? 1 : 0,
  timeout: 60_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' },
  },
  snapshotPathTemplate: '{testDir}/{testFileDir}/__screenshots__/{testFileName}/{arg}{ext}',
  reporter: [['list'], ['html', { outputFolder: 'e2e-output/report', open: 'never' }]],
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'en',
      use: { spenceLocale: 'en' },
    },
    {
      name: 'es',
      testIgnore: '**/i18n/locale.spec.ts',
      use: { spenceLocale: 'es' },
    },
  ],
});
