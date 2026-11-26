import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DeviceFlowId,
  PullRequestsRpcs,
  type GhCliStatus,
  type GitHostError,
  type HostAccount,
  type HostAccountsState,
} from '../../../../shared/pull-requests/pull-requests.rpc';
import { LinksRpcs } from '../../../../shared/links/links.rpc';
import { makeDesktopTestLayer } from '../../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../../core/effect-runtime';
import { KEYMAP_PLATFORM, Keymap } from '../../../core/keymap';
import { SettingsGitHosts } from './settings-git-hosts';

const connectedAccount: HostAccount = {
  host: 'github',
  handle: 'octocat',
  displayName: 'The Octocat',
  avatarUrl: null,
  authMethod: 'pat',
  scopes: ['repo', 'read:org'],
  status: 'connected',
  statusDetail: null,
  persistMode: 'secure',
  updatedAt: 1_700_000_000_000,
};

const setup = (options?: {
  readonly initialState?: HostAccountsState;
  readonly ghCli?: GhCliStatus;
  readonly connectPat?: (
    token: string,
    persistMode: 'secure' | 'session-only',
  ) => Effect.Effect<HostAccount, GitHostError>;
  readonly importGhCli?: (
    persistMode: 'secure' | 'session-only',
  ) => Effect.Effect<HostAccount, GitHostError>;
  readonly verify?: () => Effect.Effect<HostAccount, GitHostError>;
  readonly disconnect?: () => Effect.Effect<void, GitHostError>;
  readonly startDeviceFlow?: () => Effect.Effect<
    {
      readonly flowId: DeviceFlowId;
      readonly host: 'github';
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresAt: number;
      readonly intervalSeconds: number;
    },
    GitHostError
  >;
}) => {
  let state: HostAccountsState = options?.initialState ?? {
    accounts: [],
    secretStorageAvailable: true,
  };
  let disconnected = false;

  const handlers = Layer.mergeAll(
    PullRequestsRpcs.toLayer({
      'HostAuth.getAccounts': () => Effect.succeed(state),
      'HostAuth.checkGhCli': () =>
        Effect.succeed(
          options?.ghCli ?? { available: true, authenticated: true, handle: 'octocat' },
        ),
      'HostAuth.connectPat': ({ token, persistMode }) =>
        options?.connectPat
          ? options.connectPat(token, persistMode).pipe(
              Effect.tap((account) =>
                Effect.sync(() => {
                  state = { ...state, accounts: [account] };
                }),
              ),
            )
          : Effect.sync(() => {
              const account: HostAccount = { ...connectedAccount, persistMode };
              state = { ...state, accounts: [account] };
              return account;
            }),
      'HostAuth.importGhCli': ({ persistMode }) =>
        options?.importGhCli
          ? options.importGhCli(persistMode)
          : Effect.sync(() => {
              const account: HostAccount = {
                ...connectedAccount,
                authMethod: 'gh-cli',
                persistMode,
              };
              state = { ...state, accounts: [account] };
              return account;
            }),
      'HostAuth.startDeviceFlow': () =>
        options?.startDeviceFlow
          ? options.startDeviceFlow()
          : Effect.succeed({
              flowId: DeviceFlowId.make('flow-1'),
              host: 'github' as const,
              userCode: 'ABCD-1234',
              verificationUri: 'https://github.com/login/device',
              expiresAt: Date.now() + 900_000,
              intervalSeconds: 60,
            }),
      'HostAuth.pollDeviceFlow': () =>
        Effect.succeed({ status: 'pending' as const, intervalSeconds: 60 }),
      'HostAuth.cancelDeviceFlow': () => Effect.void,
      'HostAuth.verify': () =>
        options?.verify ? options.verify() : Effect.succeed(state.accounts[0] ?? connectedAccount),
      'HostAuth.disconnect': () =>
        options?.disconnect
          ? options.disconnect()
          : Effect.sync(() => {
              disconnected = true;
              state = { ...state, accounts: [] };
            }),
      'PullRequests.changes': () => Stream.empty,
      'PullRequests.setActiveView': () => Effect.void,
      'PullRequests.getProjectState': () => Effect.die('unused'),
      'PullRequests.refreshProject': () => Effect.die('unused'),
      'PullRequests.lookupByNumber': () => Effect.die('unused'),
      'PullRequests.unpinNumber': () => Effect.void,
      'PullRequests.getDetail': () => Effect.die('unused'),
      'PullRequests.getDiff': () => Effect.die('unused'),
    }),
    LinksRpcs.toLayer({
      'Links.openExternal': () => Effect.void,
    }),
  );

  TestBed.configureTestingModule({
    imports: [SettingsGitHosts],
    providers: [
      { provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers) },
      { provide: KEYMAP_PLATFORM, useValue: 'linux' },
      Keymap,
    ],
  });
  const fixture = TestBed.createComponent(SettingsGitHosts);
  return {
    fixture,
    get disconnected() {
      return disconnected;
    },
  };
};

const flush = async (fixture: ComponentFixture<SettingsGitHosts>): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
};

describe('SettingsGitHosts', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('connects via Classic PAT and displays account metadata, scopes, and status', async () => {
    const { fixture } = setup();
    await flush(fixture);

    const root = fixture.nativeElement as HTMLElement;
    const patInput = root.querySelector<HTMLInputElement>('[data-testid="git-hosts-pat-input"]');
    const patSubmit = root.querySelector<HTMLButtonElement>('[data-testid="git-hosts-pat-submit"]');
    expect(patInput).not.toBeNull();
    expect(patSubmit).not.toBeNull();

    if (patInput) {
      patInput.value = 'ghp_test_token';
      patInput.dispatchEvent(new Event('input'));
    }
    fixture.detectChanges();
    patSubmit?.click();
    await flush(fixture);

    expect(root.textContent).toContain('@octocat');
    expect(root.textContent).toContain('The Octocat');
    expect(root.textContent).toContain('repo');
    expect(root.textContent).toContain('read:org');
    expect(root.textContent).toContain('Connected');
  });

  it('warns when OS secure storage is unavailable and uses session-only mode', async () => {
    let seenPersistMode: string | null = null;
    const { fixture } = setup({
      initialState: { accounts: [], secretStorageAvailable: false },
      connectPat: (_token, persistMode) => {
        seenPersistMode = persistMode;
        return Effect.succeed({ ...connectedAccount, persistMode });
      },
    });
    await flush(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="git-hosts-insecure-warning"]')).not.toBeNull();

    const patInput = root.querySelector<HTMLInputElement>('[data-testid="git-hosts-pat-input"]');
    const patSubmit = root.querySelector<HTMLButtonElement>('[data-testid="git-hosts-pat-submit"]');
    if (patInput) {
      patInput.value = 'ghp_session';
      patInput.dispatchEvent(new Event('input'));
    }
    fixture.detectChanges();
    patSubmit?.click();
    await flush(fixture);

    expect(seenPersistMode).toBe('session-only');
    expect(root.textContent).toContain('Session-only');
  });

  it('confirms Disconnect in an alert-dialog modal before disconnecting', async () => {
    const ctx = setup({
      initialState: { accounts: [connectedAccount], secretStorageAvailable: true },
    });
    await flush(ctx.fixture);

    const root = ctx.fixture.nativeElement as HTMLElement;
    const disconnectBtn = root.querySelector<HTMLButtonElement>(
      '[data-testid="git-hosts-disconnect"]',
    );
    disconnectBtn?.click();
    await flush(ctx.fixture);

    const confirmBtn = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="git-hosts-disconnect-confirm"]',
    );
    expect(confirmBtn).not.toBeNull();
    expect(ctx.disconnected).toBe(false);

    confirmBtn?.click();
    await flush(ctx.fixture);

    expect(ctx.disconnected).toBe(true);
  });
});
