import { render, screen, fireEvent } from '@testing-library/angular';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { AppInfoRpcs, type AppInfo } from '../../../shared/app-info/app-info.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { AppInfoView } from './app-info';

const info: AppInfo = {
  name: 'spence',
  version: '0.1.0',
  electron: '45.3.0',
  chrome: '136.0.0.0',
  node: '24.0.0',
  platform: 'win32',
  cwd: 'C:/spence',
};

describe('AppInfoView (Chromium browser integration)', () => {
  it('loads and renders app info through DesktopApi in a real browser', async () => {
    await render(AppInfoView, {
      providers: [
        {
          provide: DESKTOP_LAYER,
          useValue: makeDesktopTestLayer(
            AppInfoRpcs.toLayer({ 'AppInfo.get': () => Effect.succeed(info) }),
          ),
        },
      ],
    });

    const button = screen.getByTestId('load-info');
    expect(button.offsetParent).not.toBeNull();
    fireEvent.click(button);

    const dl = await screen.findByTestId('info');
    expect(dl.textContent).toContain('spence 0.1.0');
    expect(dl.textContent).toContain('45.3.0');
    expect(dl.textContent).toContain('win32');
  });

  it('shows the failure state when DesktopApi dies', async () => {
    await render(AppInfoView, {
      providers: [
        {
          provide: DESKTOP_LAYER,
          useValue: makeDesktopTestLayer(
            AppInfoRpcs.toLayer({ 'AppInfo.get': () => Effect.die('bridge unavailable') }),
          ),
        },
      ],
    });

    fireEvent.click(screen.getByTestId('load-info'));

    const err = await screen.findByTestId('info-error');
    expect(err.textContent).toContain('Could not load app info.');
  });
});
