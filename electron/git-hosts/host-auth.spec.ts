import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { layerSecretStorageFake } from '../devices/secret-storage';
import { layerStore } from '../store/store';
import { layerGitHubHttp } from './github-http';
import { GhCli, HostAuth, layerHostAuth, type GhCliShape } from './host-auth';

const withTempDir = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'spence-host-auth-'))),
    use,
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );

const jsonResponse = (
  request: Parameters<HttpClient.HttpClient['execute']>[0],
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    }),
  );

const makeFakeGhCli = (overrides?: Partial<GhCliShape>) =>
  Layer.succeed(GhCli, {
    check: () => Effect.succeed({ available: true, authenticated: true, handle: 'octocat' }),
    readToken: () => Effect.succeed('gho_imported_token_123'),
    ...overrides,
  });

const makeLayer = (options: {
  readonly storeRoot: string;
  readonly secretAvailable?: boolean;
  readonly ghCli?: Layer.Layer<GhCli>;
  readonly httpHandler: (
    req: Parameters<HttpClient.HttpClient['execute']>[0],
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>;
}) => {
  const clientLayer = Layer.succeed(HttpClient.HttpClient, HttpClient.make(options.httpHandler));
  const httpLayer = layerGitHubHttp.pipe(Layer.provide(clientLayer));
  return layerHostAuth.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerStore(options.storeRoot),
        layerSecretStorageFake({ available: options.secretAvailable ?? true }),
        httpLayer,
        options.ghCli ?? makeFakeGhCli(),
      ),
    ),
  );
};

describe('HostAuth', () => {
  it.effect('handles Device Flow polling (authorization_pending, slow_down, complete)', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        let pollStep = 0;
        const layer = makeLayer({
          storeRoot: dir,
          httpHandler: (req) => {
            if (req.url.endsWith('/login/device/code')) {
              return Effect.succeed(
                jsonResponse(req, 200, {
                  device_code: 'dev-code-1',
                  user_code: 'ABCD-1234',
                  verification_uri: 'https://github.com/login/device',
                  expires_in: 900,
                  interval: 5,
                }),
              );
            }
            if (req.url.endsWith('/login/oauth/access_token')) {
              pollStep++;
              if (pollStep === 1) {
                return Effect.succeed(jsonResponse(req, 200, { error: 'authorization_pending' }));
              }
              if (pollStep === 2) {
                return Effect.succeed(jsonResponse(req, 200, { error: 'slow_down', interval: 10 }));
              }
              return Effect.succeed(jsonResponse(req, 200, { access_token: 'gho_device_tok' }));
            }
            if (req.url.endsWith('/user')) {
              return Effect.succeed(
                jsonResponse(
                  req,
                  200,
                  { login: 'octocat', name: 'The Octocat', avatar_url: 'https://avatars/octo.png' },
                  { 'x-oauth-scopes': 'repo, read:org' },
                ),
              );
            }
            return Effect.succeed(jsonResponse(req, 404, { message: 'not found' }));
          },
        });

        yield* HostAuth.use((auth) =>
          Effect.gen(function* () {
            const prompt = yield* auth.startDeviceFlow('github');
            expect(prompt.userCode).toBe('ABCD-1234');
            expect(prompt.intervalSeconds).toBe(5);

            const p1 = yield* auth.pollDeviceFlow('github', prompt.flowId, 'secure');
            expect(p1).toEqual({ status: 'pending', intervalSeconds: 5 });

            const p2 = yield* auth.pollDeviceFlow('github', prompt.flowId, 'secure');
            expect(p2).toEqual({ status: 'pending', intervalSeconds: 10 });

            const p3 = yield* auth.pollDeviceFlow('github', prompt.flowId, 'secure');
            expect(p3.status).toBe('complete');
            if (p3.status === 'complete') {
              expect(p3.account.handle).toBe('octocat');
              expect(p3.account.authMethod).toBe('device-flow');
              expect(p3.account.status).toBe('connected');
            }
          }),
        ).pipe(Effect.provide(layer));
      }),
    ),
  );

  it.effect('handles Device Flow expired_token, access_denied, and cancellation', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        let mode: 'expired' | 'denied' = 'expired';
        const layer = makeLayer({
          storeRoot: dir,
          httpHandler: (req) => {
            if (req.url.endsWith('/login/device/code')) {
              return Effect.succeed(
                jsonResponse(req, 200, {
                  device_code: 'dev-code-2',
                  user_code: 'WXYZ-5678',
                  verification_uri: 'https://github.com/login/device',
                  expires_in: 900,
                  interval: 5,
                }),
              );
            }
            if (req.url.endsWith('/login/oauth/access_token')) {
              return Effect.succeed(
                jsonResponse(req, 200, {
                  error: mode === 'expired' ? 'expired_token' : 'access_denied',
                }),
              );
            }
            return Effect.succeed(jsonResponse(req, 404, {}));
          },
        });

        yield* HostAuth.use((auth) =>
          Effect.gen(function* () {
            const p1 = yield* auth.startDeviceFlow('github');
            const errExpired = yield* Effect.flip(
              auth.pollDeviceFlow('github', p1.flowId, 'secure'),
            );
            expect(errExpired.reason).toBe('TokenExpired');

            mode = 'denied';
            const p2 = yield* auth.startDeviceFlow('github');
            const errDenied = yield* Effect.flip(
              auth.pollDeviceFlow('github', p2.flowId, 'secure'),
            );
            expect(errDenied.reason).toBe('Forbidden');

            const p3 = yield* auth.startDeviceFlow('github');
            yield* auth.cancelDeviceFlow('github', p3.flowId);
            const errCancelled = yield* Effect.flip(
              auth.pollDeviceFlow('github', p3.flowId, 'secure'),
            );
            expect(errCancelled.reason).toBe('NotFound');
          }),
        ).pipe(Effect.provide(layer));
      }),
    ),
  );

  it.effect('validates Classic PAT scopes (requiring repo and read:org) and connects', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const layer = makeLayer({
          storeRoot: dir,
          httpHandler: (req) => {
            const authHeader = req.headers['authorization'];
            if (authHeader === 'Bearer pat_missing_scope') {
              return Effect.succeed(
                jsonResponse(req, 200, { login: 'octocat' }, { 'x-oauth-scopes': 'repo' }),
              );
            }
            return Effect.succeed(
              jsonResponse(
                req,
                200,
                { login: 'octocat', name: 'Octo', avatar_url: 'https://avatars/1' },
                { 'x-oauth-scopes': 'repo, read:org, gist' },
              ),
            );
          },
        });

        yield* HostAuth.use((auth) =>
          Effect.gen(function* () {
            const missingErr = yield* Effect.flip(
              auth.connectPat('github', 'pat_missing_scope', 'secure'),
            );
            expect(missingErr.reason).toBe('Forbidden');
            expect(missingErr.detail).toContain('read:org');

            const account = yield* auth.connectPat('github', 'pat_valid', 'secure');
            expect(account.handle).toBe('octocat');
            expect(account.authMethod).toBe('pat');
            expect(account.scopes).toEqual(['repo', 'read:org', 'gist']);

            const tokenSeen = yield* auth.withToken('github', (tok) => Effect.succeed(tok));
            expect(tokenSeen).toBe('pat_valid');
          }),
        ).pipe(Effect.provide(layer));
      }),
    ),
  );

  it.effect('imports token from gh CLI via Merged PATH', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const layer = makeLayer({
          storeRoot: dir,
          httpHandler: (req) =>
            Effect.succeed(
              jsonResponse(
                req,
                200,
                { login: 'gh-user', name: 'GH User', avatar_url: null },
                { 'x-oauth-scopes': 'repo, read:org' },
              ),
            ),
        });

        yield* HostAuth.use((auth) =>
          Effect.gen(function* () {
            const cli = yield* auth.checkGhCli('github');
            expect(cli.available).toBe(true);
            expect(cli.authenticated).toBe(true);

            const account = yield* auth.importGhCli('github', 'secure');
            expect(account.handle).toBe('gh-user');
            expect(account.authMethod).toBe('gh-cli');
          }),
        ).pipe(Effect.provide(layer));
      }),
    ),
  );

  it.effect(
    'refuses silent disk persistence when SecretStorage is unavailable and supports session-only memory mode',
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const layer = makeLayer({
            storeRoot: dir,
            secretAvailable: false,
            httpHandler: (req) =>
              Effect.succeed(
                jsonResponse(
                  req,
                  200,
                  { login: 'linux-user', name: null, avatar_url: null },
                  { 'x-oauth-scopes': 'repo, read:org' },
                ),
              ),
          });

          yield* HostAuth.use((auth) =>
            Effect.gen(function* () {
              const state = yield* auth.getAccounts;
              expect(state.secretStorageAvailable).toBe(false);

              const refused = yield* Effect.flip(auth.connectPat('github', 'pat_secret', 'secure'));
              expect(refused.reason).toBe('UnsupportedCapability');

              const sessionAccount = yield* auth.connectPat(
                'github',
                'pat_session_only',
                'session-only',
              );
              expect(sessionAccount.persistMode).toBe('session-only');
              expect(sessionAccount.status).toBe('connected');

              const tokenSeen = yield* auth.withToken('github', (tok) => Effect.succeed(tok));
              expect(tokenSeen).toBe('pat_session_only');
            }),
          ).pipe(Effect.provide(layer));

          // Disk file must not contain any sealedToken or raw token.
          const accountsFile = path.join(dir, 'git-hosts', 'accounts.json');
          if (existsSync(accountsFile)) {
            const raw = readFileSync(accountsFile, 'utf8');
            expect(raw).not.toContain('pat_session_only');
            expect(raw).not.toContain('sealedToken');
          }
        }),
      ),
  );

  it.effect('transitions to needs-reconnect on 401 and purges pull-requests/ on disconnect', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        let should401 = false;
        const prDir = path.join(dir, 'pull-requests', 'projects', 'p1');
        mkdirSync(prDir, { recursive: true });
        writeFileSync(path.join(prDir, 'summaries.json'), '{}');

        const layer = makeLayer({
          storeRoot: dir,
          httpHandler: (req) => {
            if (should401) {
              return Effect.succeed(jsonResponse(req, 401, { message: 'Bad credentials' }));
            }
            return Effect.succeed(
              jsonResponse(
                req,
                200,
                { login: 'octocat', name: 'Octo', avatar_url: null },
                { 'x-oauth-scopes': 'repo, read:org' },
              ),
            );
          },
        });

        yield* HostAuth.use((auth) =>
          Effect.gen(function* () {
            yield* auth.connectPat('github', 'pat_good', 'secure');
            should401 = true;

            const verified = yield* auth.verify('github');
            expect(verified.status).toBe('needs-reconnect');
            expect(verified.handle).toBe('octocat');
            expect(verified.statusDetail).toBeTruthy();

            yield* auth.disconnect('github');
            const after = yield* auth.getAccounts;
            expect(after.accounts).toEqual([]);
            expect(existsSync(path.join(dir, 'pull-requests'))).toBe(false);
          }),
        ).pipe(Effect.provide(layer));
      }),
    ),
  );
});
