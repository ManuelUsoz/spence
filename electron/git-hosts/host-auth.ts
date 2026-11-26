import { Clock, Context, Effect, Layer, Schema, Semaphore } from 'effect';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  DeviceFlowId,
  GITHUB_REQUIRED_SCOPES,
  GitHostError,
  HostAccount,
  type GitHostKind,
  type DeviceFlowPollResult,
  type DeviceFlowPrompt,
  type GhCliStatus,
  type HostAccountsState,
  type HostAuthMethod,
  type HostPersistMode,
} from '../../src/shared/pull-requests/pull-requests.rpc';
import { MergedPath } from '../agents/merged-path';
import { SecretStorage } from '../devices/secret-storage';
import { Store, type VersionedFile } from '../store/store';
import { GitHubHttp } from './github-http';

const execFileAsync = promisify(execFile);

const GITHUB_WEB_BASE = 'https://github.com';
const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_GITHUB_CLIENT_ID = 'Ov23liSpenceDesktop';

const githubClientId = (): string => {
  const fromEnv = process.env['SPENCE_GITHUB_CLIENT_ID']?.trim();
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_GITHUB_CLIENT_ID;
};

const StoredHostEntry = Schema.Struct({
  account: HostAccount,
  sealedToken: Schema.optionalKey(Schema.String),
});
type StoredHostEntry = typeof StoredHostEntry.Type;

const StoredHostAccounts = Schema.Struct({
  accounts: Schema.Record(Schema.String, StoredHostEntry),
});
type StoredHostAccounts = typeof StoredHostAccounts.Type;

const HostAccountsFile: VersionedFile<StoredHostAccounts> = {
  file: 'git-hosts/accounts.json',
  version: 1,
  migrations: [],
  schema: StoredHostAccounts,
  initial: () => ({ accounts: {} }),
};

export interface GhCliShape {
  readonly check: (host: GitHostKind) => Effect.Effect<GhCliStatus>;
  readonly readToken: (host: GitHostKind) => Effect.Effect<string, GitHostError>;
}

/** Runs `gh` CLI commands on Merged PATH. Swapped in tests. */
export class GhCli extends Context.Service<GhCli, GhCliShape>()('git-hosts/GhCli') {}

const runGh = (args: ReadonlyArray<string>, mergedPath: string): Promise<string> =>
  execFileAsync('gh', [...args], {
    env: { ...process.env, PATH: mergedPath },
    timeout: 10_000,
    windowsHide: true,
  }).then((res) => res.stdout.trim());

export const layerGhCliLive = Layer.effect(
  GhCli,
  Effect.gen(function* () {
    const mergedPath = yield* MergedPath;

    const check: GhCliShape['check'] = Effect.fnUntraced(function* () {
      const pathValue = yield* mergedPath.get;
      const versionOk = yield* Effect.tryPromise(() => runGh(['--version'], pathValue)).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (!versionOk) {
        return { available: false, authenticated: false, handle: null };
      }
      const token = yield* Effect.tryPromise(() =>
        runGh(['auth', 'token', '--hostname', 'github.com'], pathValue),
      ).pipe(Effect.catch(() => Effect.succeed('')));
      if (token.length === 0) {
        return { available: true, authenticated: false, handle: null };
      }
      const statusOut = yield* Effect.tryPromise(() =>
        runGh(['api', 'user', '--jq', '.login'], pathValue),
      ).pipe(Effect.catch(() => Effect.succeed('')));
      return {
        available: true,
        authenticated: true,
        handle: statusOut.length > 0 ? statusOut : null,
      };
    });

    const readToken: GhCliShape['readToken'] = Effect.fnUntraced(function* () {
      const pathValue = yield* mergedPath.get;
      const token = yield* Effect.tryPromise({
        try: () => runGh(['auth', 'token', '--hostname', 'github.com'], pathValue),
        catch: () =>
          new GitHostError({
            reason: 'NotAuthenticated',
            detail:
              'GitHub CLI (`gh`) is not authenticated for github.com. Run `gh auth login` first.',
          }),
      });
      if (token.length === 0) {
        return yield* new GitHostError({
          reason: 'NotAuthenticated',
          detail: 'GitHub CLI (`gh`) returned an empty token.',
        });
      }
      return token;
    });

    return { check, readToken };
  }),
);

interface PendingDeviceFlow {
  readonly flowId: DeviceFlowId;
  readonly host: GitHostKind;
  readonly deviceCode: string;
  readonly expiresAt: number;
  intervalSeconds: number;
}

interface GitHubUserResponse {
  readonly login?: unknown;
  readonly name?: unknown;
  readonly avatar_url?: unknown;
}

interface DeviceCodeApiResponse {
  readonly device_code?: unknown;
  readonly user_code?: unknown;
  readonly verification_uri?: unknown;
  readonly expires_in?: unknown;
  readonly interval?: unknown;
  readonly error?: unknown;
  readonly error_description?: unknown;
}

interface AccessTokenApiResponse {
  readonly access_token?: unknown;
  readonly interval?: unknown;
  readonly error?: unknown;
  readonly error_description?: unknown;
}

const parseScopes = (header: string | undefined): ReadonlyArray<string> => {
  if (header === undefined || header.trim().length === 0) return [];
  return header
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

const missingRequiredScopes = (scopes: ReadonlyArray<string>): ReadonlyArray<string> =>
  GITHUB_REQUIRED_SCOPES.filter((req) => !scopes.includes(req));

export interface HostAuthShape {
  readonly getAccounts: Effect.Effect<HostAccountsState, GitHostError>;
  readonly startDeviceFlow: (host: GitHostKind) => Effect.Effect<DeviceFlowPrompt, GitHostError>;
  readonly pollDeviceFlow: (
    host: GitHostKind,
    flowId: DeviceFlowId,
    persistMode: HostPersistMode,
  ) => Effect.Effect<DeviceFlowPollResult, GitHostError>;
  readonly cancelDeviceFlow: (host: GitHostKind, flowId: DeviceFlowId) => Effect.Effect<void>;
  readonly connectPat: (
    host: GitHostKind,
    token: string,
    persistMode: HostPersistMode,
  ) => Effect.Effect<HostAccount, GitHostError>;
  readonly checkGhCli: (host: GitHostKind) => Effect.Effect<GhCliStatus, GitHostError>;
  readonly importGhCli: (
    host: GitHostKind,
    persistMode: HostPersistMode,
  ) => Effect.Effect<HostAccount, GitHostError>;
  readonly verify: (host: GitHostKind) => Effect.Effect<HostAccount, GitHostError>;
  readonly markNeedsReconnect: (
    host: GitHostKind,
    detail: string,
  ) => Effect.Effect<void, GitHostError>;
  readonly disconnect: (host: GitHostKind) => Effect.Effect<void, GitHostError>;
  readonly withToken: <A, E>(
    host: GitHostKind,
    use: (token: string) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | GitHostError>;
}

/** Owns Git host authentication ceremonies, SecretStorage token sealing, and account state. */
export class HostAuth extends Context.Service<HostAuth, HostAuthShape>()('git-hosts/HostAuth') {}

export const layerHostAuth = Layer.effect(
  HostAuth,
  Effect.gen(function* () {
    const store = yield* Store;
    const secretStorage = yield* SecretStorage;
    const http = yield* GitHubHttp;
    const ghCli = yield* GhCli;
    const lock = Semaphore.makeUnsafe(1);
    const sessionTokens = new Map<GitHostKind, string>();
    const pendingFlows = new Map<DeviceFlowId, PendingDeviceFlow>();

    const readStored = (): Effect.Effect<StoredHostAccounts, GitHostError> =>
      store.readVersioned(HostAccountsFile).pipe(
        Effect.mapError(
          (err) =>
            new GitHostError({
              reason: 'HostError',
              detail: `Could not read Git host accounts: ${err.detail}`,
            }),
        ),
      );

    const writeStored = (next: StoredHostAccounts): Effect.Effect<void> =>
      store.writeVersioned(HostAccountsFile, next);

    const fetchGitHubUser = Effect.fnUntraced(function* (
      token: string,
      requireScopesHeader: boolean,
    ) {
      const res = yield* http.getJson<GitHubUserResponse>(`${GITHUB_API_BASE}/user`, {
        headers: { authorization: `Bearer ${token}` },
        coalesce: false,
      });
      const login = typeof res.data.login === 'string' ? res.data.login.trim() : '';
      if (login.length === 0) {
        return yield* new GitHostError({
          reason: 'HostError',
          detail: 'GitHub did not return a user login.',
        });
      }
      const scopesHeader = res.headers['x-oauth-scopes'];
      const scopes = parseScopes(scopesHeader);
      if (requireScopesHeader || scopesHeader !== undefined) {
        const missing = missingRequiredScopes(scopes);
        if (missing.length > 0) {
          return yield* new GitHostError({
            reason: 'Forbidden',
            detail: `Token is missing required GitHub scopes: ${missing.join(', ')}. Required: ${GITHUB_REQUIRED_SCOPES.join(', ')}.`,
          });
        }
      }
      return {
        handle: login,
        displayName:
          typeof res.data.name === 'string' && res.data.name.length > 0 ? res.data.name : null,
        avatarUrl:
          typeof res.data.avatar_url === 'string' && res.data.avatar_url.length > 0
            ? res.data.avatar_url
            : null,
        scopes: scopes.length > 0 ? scopes : [...GITHUB_REQUIRED_SCOPES],
      };
    });

    const saveConnectedAccount = (
      host: GitHostKind,
      token: string,
      authMethod: HostAuthMethod,
      persistMode: HostPersistMode,
      profile: {
        readonly handle: string;
        readonly displayName: string | null;
        readonly avatarUrl: string | null;
        readonly scopes: ReadonlyArray<string>;
      },
    ): Effect.Effect<HostAccount, GitHostError> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (persistMode === 'secure') {
            const available = yield* secretStorage.available;
            if (!available) {
              return yield* new GitHostError({
                reason: 'UnsupportedCapability',
                detail:
                  'OS secure storage is unavailable (Linux keyring missing). Choose session-only mode to keep credentials in memory for this session.',
              });
            }
          }

          const current = yield* readStored();
          const previous = current.accounts[host];
          if (previous !== undefined && previous.account.handle !== profile.handle) {
            yield* store.removeDir('pull-requests');
          }

          const now = yield* Clock.currentTimeMillis;
          const account: HostAccount = {
            host,
            handle: profile.handle,
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
            authMethod,
            scopes: [...profile.scopes],
            status: 'connected',
            statusDetail: null,
            persistMode,
            updatedAt: now,
          };

          if (persistMode === 'secure') {
            const sealedToken = yield* secretStorage.seal(token);
            sessionTokens.delete(host);
            yield* writeStored({
              accounts: {
                ...current.accounts,
                [host]: { account, sealedToken },
              },
            });
          } else {
            sessionTokens.set(host, token);
            yield* writeStored({
              accounts: {
                ...current.accounts,
                [host]: { account },
              },
            });
          }

          return account;
        }),
      );

    const markNeedsReconnect: HostAuthShape['markNeedsReconnect'] = (host, detail) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* readStored();
          const entry = current.accounts[host];
          if (entry === undefined) return;
          const now = yield* Clock.currentTimeMillis;
          const updated: StoredHostEntry = {
            ...entry,
            account: {
              ...entry.account,
              status: 'needs-reconnect',
              statusDetail: detail,
              updatedAt: now,
            },
          };
          yield* writeStored({
            accounts: {
              ...current.accounts,
              [host]: updated,
            },
          });
        }),
      );

    const getAccounts: HostAuthShape['getAccounts'] = Effect.gen(function* () {
      const secretStorageAvailable = yield* secretStorage.available;
      const stored = yield* readStored();
      const accounts: HostAccount[] = [];
      for (const [host, entry] of Object.entries(stored.accounts) as Array<
        [GitHostKind, StoredHostEntry]
      >) {
        if (
          entry.account.persistMode === 'session-only' &&
          !sessionTokens.has(host) &&
          entry.account.status === 'connected'
        ) {
          accounts.push({
            ...entry.account,
            status: 'needs-reconnect',
            statusDetail: 'Session-only credential expired when Spence restarted.',
          });
        } else {
          accounts.push(entry.account);
        }
      }
      return { accounts, secretStorageAvailable };
    });

    const startDeviceFlow: HostAuthShape['startDeviceFlow'] = Effect.fnUntraced(function* (host) {
      const res = yield* http.postForm<DeviceCodeApiResponse>(
        `${GITHUB_WEB_BASE}/login/device/code`,
        {
          client_id: githubClientId(),
          scope: GITHUB_REQUIRED_SCOPES.join(' '),
        },
      );
      const deviceCode = typeof res.data.device_code === 'string' ? res.data.device_code : '';
      const userCode = typeof res.data.user_code === 'string' ? res.data.user_code : '';
      const verificationUri =
        typeof res.data.verification_uri === 'string' ? res.data.verification_uri : '';
      const expiresIn = typeof res.data.expires_in === 'number' ? res.data.expires_in : 900;
      const intervalSeconds = typeof res.data.interval === 'number' ? res.data.interval : 5;

      if (deviceCode.length === 0 || userCode.length === 0 || verificationUri.length === 0) {
        const desc =
          typeof res.data.error_description === 'string'
            ? res.data.error_description
            : 'GitHub did not return a device flow code.';
        return yield* new GitHostError({ reason: 'HostError', detail: desc });
      }

      const now = yield* Clock.currentTimeMillis;
      const expiresAt = now + expiresIn * 1_000;
      const flowId = DeviceFlowId.make(randomUUID());
      pendingFlows.set(flowId, {
        flowId,
        host,
        deviceCode,
        expiresAt,
        intervalSeconds,
      });

      return {
        flowId,
        host,
        userCode,
        verificationUri,
        expiresAt,
        intervalSeconds,
      };
    });

    const pollDeviceFlow: HostAuthShape['pollDeviceFlow'] = Effect.fnUntraced(
      function* (host, flowId, persistMode) {
        const flow = pendingFlows.get(flowId);
        if (flow === undefined || flow.host !== host) {
          return yield* new GitHostError({
            reason: 'NotFound',
            detail: 'Device flow session was cancelled or does not exist.',
          });
        }
        const now = yield* Clock.currentTimeMillis;
        if (now >= flow.expiresAt) {
          pendingFlows.delete(flowId);
          return yield* new GitHostError({
            reason: 'TokenExpired',
            detail: 'The GitHub sign-in code expired. Start again.',
          });
        }

        const res = yield* http.postForm<AccessTokenApiResponse>(
          `${GITHUB_WEB_BASE}/login/oauth/access_token`,
          {
            client_id: githubClientId(),
            device_code: flow.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          },
        );

        if (typeof res.data.access_token === 'string' && res.data.access_token.length > 0) {
          const token = res.data.access_token;
          const profile = yield* fetchGitHubUser(token, false);
          const account = yield* saveConnectedAccount(
            host,
            token,
            'device-flow',
            persistMode,
            profile,
          );
          pendingFlows.delete(flowId);
          return { status: 'complete', account } satisfies DeviceFlowPollResult;
        }

        const errorCode = typeof res.data.error === 'string' ? res.data.error : '';
        switch (errorCode) {
          case 'authorization_pending':
            return {
              status: 'pending',
              intervalSeconds: flow.intervalSeconds,
            } satisfies DeviceFlowPollResult;
          case 'slow_down': {
            const nextInterval =
              typeof res.data.interval === 'number' ? res.data.interval : flow.intervalSeconds + 5;
            flow.intervalSeconds = nextInterval;
            return {
              status: 'pending',
              intervalSeconds: nextInterval,
            } satisfies DeviceFlowPollResult;
          }
          case 'expired_token':
            pendingFlows.delete(flowId);
            return yield* new GitHostError({
              reason: 'TokenExpired',
              detail: 'The GitHub sign-in code expired. Start again.',
            });
          case 'access_denied':
            pendingFlows.delete(flowId);
            return yield* new GitHostError({
              reason: 'Forbidden',
              detail: 'The sign-in was cancelled on GitHub.',
            });
          default: {
            pendingFlows.delete(flowId);
            const desc =
              typeof res.data.error_description === 'string'
                ? res.data.error_description
                : `GitHub refused the sign-in (${errorCode || 'unknown error'}).`;
            return yield* new GitHostError({ reason: 'HostError', detail: desc });
          }
        }
      },
    );

    const cancelDeviceFlow: HostAuthShape['cancelDeviceFlow'] = (host, flowId) =>
      Effect.sync(() => {
        const flow = pendingFlows.get(flowId);
        if (flow !== undefined && flow.host === host) {
          pendingFlows.delete(flowId);
        }
      });

    const connectPat: HostAuthShape['connectPat'] = Effect.fnUntraced(
      function* (host, rawToken, persistMode) {
        const token = rawToken.trim();
        if (token.length === 0) {
          return yield* new GitHostError({
            reason: 'ValidationFailed',
            detail: 'Enter a GitHub personal access token.',
          });
        }
        const profile = yield* fetchGitHubUser(token, true);
        return yield* saveConnectedAccount(host, token, 'pat', persistMode, profile);
      },
    );

    const checkGhCli: HostAuthShape['checkGhCli'] = (host) => ghCli.check(host);

    const importGhCli: HostAuthShape['importGhCli'] = Effect.fnUntraced(
      function* (host, persistMode) {
        const token = yield* ghCli.readToken(host);
        const profile = yield* fetchGitHubUser(token, true);
        return yield* saveConnectedAccount(host, token, 'gh-cli', persistMode, profile);
      },
    );

    const openStoredToken = Effect.fnUntraced(function* (host: GitHostKind) {
      const stored = yield* readStored();
      const entry = stored.accounts[host];
      if (entry === undefined) {
        return yield* new GitHostError({
          reason: 'NotAuthenticated',
          detail: `No ${host} account is connected.`,
        });
      }
      if (entry.account.persistMode === 'session-only') {
        const mem = sessionTokens.get(host);
        if (mem === undefined) {
          yield* markNeedsReconnect(host, 'Session-only credential expired when Spence restarted.');
          return yield* new GitHostError({
            reason: 'TokenExpired',
            detail: 'Session-only credential expired when Spence restarted.',
          });
        }
        return mem;
      }
      if (entry.sealedToken === undefined) {
        return yield* new GitHostError({
          reason: 'NotAuthenticated',
          detail: `No sealed token found for ${host}.`,
        });
      }
      const opened = yield* secretStorage.open(entry.sealedToken);
      if (opened.stale) {
        const reSealed = yield* secretStorage.seal(opened.plain);
        yield* writeStored({
          accounts: {
            ...stored.accounts,
            [host]: { ...entry, sealedToken: reSealed },
          },
        });
      }
      return opened.plain;
    });

    const withToken: HostAuthShape['withToken'] = Effect.fnUntraced(function* <A, E>(
      host: GitHostKind,
      use: (token: string) => Effect.Effect<A, E>,
    ) {
      const token = yield* openStoredToken(host);
      return yield* use(token).pipe(
        Effect.tapError((err) => {
          if (err instanceof GitHostError && err.reason === 'TokenExpired') {
            return markNeedsReconnect(host, err.detail).pipe(Effect.ignore);
          }
          return Effect.void;
        }),
      );
    });

    const verify: HostAuthShape['verify'] = Effect.fnUntraced(function* (host) {
      const stored = yield* readStored();
      const entry = stored.accounts[host];
      if (entry === undefined) {
        return yield* new GitHostError({
          reason: 'NotAuthenticated',
          detail: `No ${host} account is connected.`,
        });
      }

      const tokenResult = yield* openStoredToken(host).pipe(Effect.result);
      if (tokenResult._tag === 'Failure') {
        const updated = (yield* readStored()).accounts[host];
        if (updated !== undefined && updated.account.status === 'needs-reconnect') {
          return updated.account;
        }
        return yield* tokenResult.failure;
      }

      const requireScopes = entry.account.authMethod !== 'device-flow';
      const profileResult = yield* fetchGitHubUser(tokenResult.success, requireScopes).pipe(
        Effect.result,
      );
      if (profileResult._tag === 'Failure') {
        const err = profileResult.failure;
        if (err.reason === 'TokenExpired' || err.reason === 'Forbidden') {
          yield* markNeedsReconnect(host, err.detail);
          const refreshed = (yield* readStored()).accounts[host];
          if (refreshed !== undefined) return refreshed.account;
        }
        return yield* err;
      }

      const now = yield* Clock.currentTimeMillis;
      const nextAccount: HostAccount = {
        ...entry.account,
        handle: profileResult.success.handle,
        displayName: profileResult.success.displayName,
        avatarUrl: profileResult.success.avatarUrl,
        scopes: [...profileResult.success.scopes],
        status: 'connected',
        statusDetail: null,
        updatedAt: now,
      };
      yield* writeStored({
        accounts: {
          ...stored.accounts,
          [host]: { ...entry, account: nextAccount },
        },
      });
      return nextAccount;
    });

    const disconnect: HostAuthShape['disconnect'] = (host) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          sessionTokens.delete(host);
          const current = yield* readStored();
          const nextAccounts = { ...current.accounts };
          delete nextAccounts[host];
          yield* writeStored({ accounts: nextAccounts });
          yield* store.removeDir('pull-requests');
        }),
      );

    return {
      getAccounts,
      startDeviceFlow,
      pollDeviceFlow,
      cancelDeviceFlow,
      connectPat,
      checkGhCli,
      importGhCli,
      verify,
      markNeedsReconnect,
      disconnect,
      withToken,
    };
  }),
);
