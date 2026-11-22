import { describe, expect, it } from 'vitest';
import { matrix, plan } from './affected.mjs';

describe('e2e affected-spec plan', () => {
  it('runs nothing for docs and unit specs', () => {
    expect(plan(['README.md', 'docs/roadmap.md', 'electron/sessions/sessions.spec.ts'])).toEqual({
      mode: 'none',
      specs: [],
      es: false,
      windows: false,
    });
  });

  it('maps a feature change to its spec folders only', () => {
    const result = plan(['src/app/features/changes/changes-page.ts', 'electron/worktrees/x.ts']);
    expect(result).toEqual({ mode: 'subset', specs: ['e2e/changes/'], es: false, windows: true });
  });

  it('maps browser domain changes to browser, session, and shell e2e specs', () => {
    expect(plan(['src/app/features/browser/browser-pane.ts'])).toEqual({
      mode: 'subset',
      specs: ['e2e/browser/', 'e2e/session/', 'e2e/shell/'],
      es: false,
      windows: false,
    });
    expect(plan(['electron/browser/browser-service.ts'])).toEqual({
      mode: 'subset',
      specs: ['e2e/browser/', 'e2e/session/', 'e2e/shell/'],
      es: false,
      windows: true,
    });
    expect(plan(['electron/rpc/browser.ts']).specs).toEqual([
      'e2e/browser/',
      'e2e/session/',
      'e2e/shell/',
    ]);
    expect(plan(['src/shared/browser/browser.rpc.ts']).specs).toEqual([
      'e2e/browser/',
      'e2e/session/',
      'e2e/shell/',
    ]);
    expect(plan(['e2e/browser/browser.spec.ts']).specs).toEqual(['e2e/browser/browser.spec.ts']);
  });

  it('maps the LAN and device modules to the devices and settings specs', () => {
    expect(plan(['electron/lan/server.ts', 'src/shared/devices/devices.rpc.ts']).specs).toEqual([
      'e2e/devices/',
      'e2e/settings/',
    ]);
  });

  it('adds the neighbours of the session area', () => {
    expect(plan(['electron/sessions/sessions.ts']).specs).toEqual(['e2e/session/', 'e2e/shell/']);
  });

  it('runs a changed e2e spec alone, and a changed baseline maps to its spec', () => {
    expect(plan(['e2e/shell/sidebar.spec.ts']).specs).toEqual(['e2e/shell/sidebar.spec.ts']);
    expect(plan(['e2e/shell/__screenshots__/sidebar.spec.ts/sidebar-open.png']).specs).toEqual([
      'e2e/shell/sidebar.spec.ts',
    ]);
  });

  it('runs everything for the harness, the build and the core of the app', () => {
    for (const file of [
      'e2e/fixtures.ts',
      'package-lock.json',
      'electron/main.ts',
      'src/app/core/desktop-layers.ts',
      'src/app/ui/button/index.ts',
      '.github/workflows/ci.yml',
      'scripts/e2e/affected.mjs',
    ]) {
      expect(plan([file]).mode, file).toBe('full');
    }
  });

  it('does not guess: an unmapped app path runs everything', () => {
    expect(plan(['electron/brand-new-domain/thing.ts']).mode).toBe('full');
  });

  it('needs Spanish only when translations or locale code change', () => {
    expect(plan(['src/locale/messages.es.xlf']).es).toBe(true);
    expect(plan(['electron/i18n/locale.ts']).es).toBe(true);
    expect(plan(['src/app/features/changes/changes-page.ts']).es).toBe(false);
  });

  it('adds Windows for main-process and harness changes, not for renderer-only ones', () => {
    expect(plan(['src/app/features/changes/changes-page.ts']).windows).toBe(false);
    expect(plan(['electron/worktrees/x.ts']).windows).toBe(true);
  });

  it('builds the job matrix: Linux shards, plus Windows shards only when asked', () => {
    const names = (m) => m.include.map((job) => `${job['os-name']}${job.shard}`);
    expect(names(matrix({ windows: false }))).toEqual(['linux1', 'linux2']);
    expect(names(matrix({ windows: true }))).toEqual(['linux1', 'linux2', 'windows1', 'windows2']);
  });

  it('forced full always includes Spanish', () => {
    expect(plan([], { full: true })).toMatchObject({ mode: 'full', es: true });
  });
});
