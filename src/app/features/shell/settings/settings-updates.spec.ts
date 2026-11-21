import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, SubscriptionRef } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinksRpcs } from '../../../../shared/links/links.rpc';
import {
  UpdatesError,
  UpdatesRpcs,
  type UpdateInfo,
  type UpdateState,
} from '../../../../shared/updates/updates.rpc';
import { makeDesktopTestLayer } from '../../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../../core/effect-runtime';
import { SettingsUpdates } from './settings-updates';

const sampleInfo: UpdateInfo = {
  version: '1.2.0-beta.1',
  releaseUrl: 'https://github.com/ManuelUsoz/spence/releases/tag/v1.2.0-beta.1',
  releasedAt: '2026-11-20T12:00:00Z',
  releaseNotes: 'Signed beta release notes.',
  knownIssues: 'Windows installer is unsigned.',
  sizeBytes: 1024,
};

interface Served {
  readonly state: SubscriptionRef.SubscriptionRef<UpdateState>;
  checks: number;
  downloads: number;
  restarts: number;
  openedUrls: string[];
  checkResult: () => Effect.Effect<UpdateState, UpdatesError>;
  downloadResult: () => Effect.Effect<UpdateState, UpdatesError>;
  restartResult: () => Effect.Effect<void, UpdatesError>;
}

const setState = (served: Served, next: UpdateState): void =>
  Effect.runSync(SubscriptionRef.set(served.state, next));

const createServed = (initial: UpdateState = { _tag: 'Idle' }): Served => {
  const served: Served = {
    state: Effect.runSync(SubscriptionRef.make<UpdateState>(initial)),
    checks: 0,
    downloads: 0,
    restarts: 0,
    openedUrls: [],
    checkResult: () =>
      Effect.sync(() => {
        const next: UpdateState = { _tag: 'UpToDate', checkedAt: 1_700_000_000_000 };
        setState(served, next);
        return next;
      }),
    downloadResult: () =>
      Effect.sync(() => {
        const next: UpdateState = { _tag: 'Ready', info: sampleInfo };
        setState(served, next);
        return next;
      }),
    restartResult: () => Effect.void,
  };
  return served;
};

const handlers = (served: Served) =>
  Layer.mergeAll(
    UpdatesRpcs.toLayer({
      'Updates.watch': () => SubscriptionRef.changes(served.state),
      'Updates.check': () =>
        Effect.sync(() => {
          served.checks += 1;
        }).pipe(Effect.andThen(served.checkResult())),
      'Updates.download': () =>
        Effect.sync(() => {
          served.downloads += 1;
        }).pipe(Effect.andThen(served.downloadResult())),
      'Updates.restart': () =>
        Effect.sync(() => {
          served.restarts += 1;
        }).pipe(Effect.andThen(served.restartResult())),
    }),
    LinksRpcs.toLayer({
      'Links.openExternal': ({ url }) =>
        Effect.sync(() => {
          served.openedUrls.push(url);
        }),
    }),
  );

const open = (served: Served): ComponentFixture<SettingsUpdates> => {
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers(served)) }],
  });
  const fixture = TestBed.createComponent(SettingsUpdates);
  fixture.detectChanges();
  return fixture;
};

const byTestId = (fixture: ComponentFixture<SettingsUpdates>, id: string): HTMLElement | null =>
  (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${id}"]`);

const click = (fixture: ComponentFixture<SettingsUpdates>, id: string): void => {
  const button = byTestId(fixture, id);
  expect(button, `missing button ${id}`).not.toBeNull();
  button?.click();
};

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('SettingsUpdates', () => {
  it('shows beta channel, unsigned Windows notice, and transitions Idle -> Checking -> UpToDate', async () => {
    const served = createServed();
    const fixture = open(served);

    expect(fixture.nativeElement.textContent).toContain('Beta');
    expect(fixture.nativeElement.textContent).toContain('Windows installers are unsigned');

    setState(served, { _tag: 'Checking' });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'updates-checking')).not.toBeNull();
      expect(byTestId(fixture, 'updates-check')).toBeNull();
    });

    setState(served, { _tag: 'Idle' });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'updates-check')).not.toBeNull();
    });

    click(fixture, 'updates-check');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'updates-up-to-date')).not.toBeNull();
    });
    expect(served.checks).toBe(1);
  });

  it('displays Available release notes, download progress, Ready state, and Restart to update', async () => {
    const served = createServed({ _tag: 'Available', info: sampleInfo });
    const fixture = open(served);

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'updates-available')).not.toBeNull();
    });
    expect(byTestId(fixture, 'updates-release-version')?.textContent).toContain('1.2.0-beta.1');
    expect(byTestId(fixture, 'updates-release-notes')?.textContent).toContain(
      'Signed beta release notes.',
    );
    expect(byTestId(fixture, 'updates-known-issues')?.textContent).toContain(
      'Windows installer is unsigned.',
    );

    click(fixture, 'updates-open-release');
    await vi.waitFor(() => {
      expect(served.openedUrls).toEqual([sampleInfo.releaseUrl]);
    });

    setState(served, {
      _tag: 'Downloading',
      info: sampleInfo,
      receivedBytes: 512,
      totalBytes: 1024,
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'updates-downloading')?.textContent).toContain('50%');
    });

    setState(served, { _tag: 'Ready', info: sampleInfo });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'updates-ready')).not.toBeNull();
    });

    click(fixture, 'updates-restart');
    await vi.waitFor(() => {
      expect(served.restarts).toBe(1);
    });
  });

  it('surfaces failures with retry and Linux AppImage NotWritable guidance', async () => {
    const served = createServed({ _tag: 'Ready', info: sampleInfo });
    served.restartResult = () => {
      const detail =
        'Spence cannot replace /opt/Spence.AppImage. Move the AppImage to a folder you can write to.';
      setState(served, { _tag: 'Failed', reason: 'NotWritable', detail, info: sampleInfo });
      return Effect.fail(new UpdatesError({ reason: 'NotWritable', detail }));
    };
    const fixture = open(served);

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'updates-ready')).not.toBeNull();
    });

    click(fixture, 'updates-restart');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'updates-failed')).not.toBeNull();
    });
    expect(byTestId(fixture, 'updates-failed')?.textContent).toContain(
      'Spence cannot replace its AppImage here.',
    );
    expect(byTestId(fixture, 'updates-failure-detail')?.textContent).toContain(
      '/opt/Spence.AppImage',
    );
    expect(byTestId(fixture, 'updates-problem')).toBeNull();

    click(fixture, 'updates-check');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'updates-up-to-date')).not.toBeNull();
    });
    expect(served.checks).toBe(1);
  });

  it('surfaces inline restart errors when state remains Ready', async () => {
    const served = createServed({ _tag: 'Ready', info: sampleInfo });
    served.restartResult = () =>
      Effect.fail(new UpdatesError({ reason: 'NotReady', detail: 'No verified update is ready.' }));
    const fixture = open(served);

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'updates-restart')).not.toBeNull();
    });

    click(fixture, 'updates-restart');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId(fixture, 'updates-problem')?.textContent).toContain(
        'No verified update is ready.',
      );
    });
  });
});
