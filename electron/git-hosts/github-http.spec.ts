import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import { GitHubHttp, layerGitHubHttp } from './github-http';

const makeFakeHttpClient = (
  handler: (
    request: Parameters<HttpClient.HttpClient['execute']>[0],
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
) => Layer.succeed(HttpClient.HttpClient, HttpClient.make(handler));

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

describe('GitHubHttp', () => {
  it.effect('enforces a per-host Semaphore(4) concurrency cap', () =>
    Effect.gen(function* () {
      let current = 0;
      let peak = 0;
      const gate = yield* Deferred.make<void>();

      const clientLayer = makeFakeHttpClient((req) =>
        Effect.gen(function* () {
          current++;
          peak = Math.max(peak, current);
          yield* Deferred.await(gate);
          current--;
          return jsonResponse(req, 200, { ok: true });
        }),
      );

      const http = yield* GitHubHttp.use((service) =>
        Effect.gen(function* () {
          const fibers = yield* Effect.forEach(
            Array.from({ length: 8 }, (_, i) => i),
            (i) =>
              service
                .getJson<{ ok: boolean }>(`https://api.github.com/item/${i}`, { coalesce: false })
                .pipe(Effect.forkChild),
          );
          // Yield enough ticks for all 4 permitted requests to enter the handler.
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(peak).toBe(4);
          yield* Deferred.succeed(gate, undefined);
          const results = yield* Effect.forEach(fibers, Fiber.join);
          expect(results).toHaveLength(8);
          return peak;
        }),
      ).pipe(Effect.provide(layerGitHubHttp.pipe(Layer.provide(clientLayer))));

      expect(http).toBe(4);
    }),
  );

  it.effect('coalesces identical in-flight GET requests into one HTTP call', () =>
    Effect.gen(function* () {
      let calls = 0;
      const gate = yield* Deferred.make<void>();

      const clientLayer = makeFakeHttpClient((req) =>
        Effect.gen(function* () {
          calls++;
          yield* Deferred.await(gate);
          return jsonResponse(req, 200, { login: 'octocat' });
        }),
      );

      yield* GitHubHttp.use((service) =>
        Effect.gen(function* () {
          const f1 = yield* service
            .getJson<{ login: string }>('https://api.github.com/user', {
              headers: { authorization: 'Bearer tok-1' },
            })
            .pipe(Effect.forkChild);
          const f2 = yield* service
            .getJson<{ login: string }>('https://api.github.com/user', {
              headers: { authorization: 'Bearer tok-1' },
            })
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(calls).toBe(1);
          yield* Deferred.succeed(gate, undefined);
          const [r1, r2] = yield* Effect.all([Fiber.join(f1), Fiber.join(f2)]);
          expect(r1.data.login).toBe('octocat');
          expect(r2.data.login).toBe('octocat');
        }),
      ).pipe(Effect.provide(layerGitHubHttp.pipe(Layer.provide(clientLayer))));
    }),
  );

  it.effect(
    'normalizes 401, 403 rate-limit, 403 forbidden, and network errors into GitHostError',
    () =>
      Effect.gen(function* () {
        const clientLayer = makeFakeHttpClient((req) => {
          if (req.url.includes('/401'))
            return Effect.succeed(jsonResponse(req, 401, { message: 'Bad credentials' }));
          if (req.url.includes('/429')) {
            return Effect.succeed(
              jsonResponse(req, 429, { message: 'Too many requests' }, { 'retry-after': '42' }),
            );
          }
          if (req.url.includes('/403-rate')) {
            return Effect.succeed(
              jsonResponse(
                req,
                403,
                { message: 'API rate limit exceeded' },
                { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' },
              ),
            );
          }
          if (req.url.includes('/403-perm')) {
            return Effect.succeed(jsonResponse(req, 403, { message: 'Resource not accessible' }));
          }
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request: req,
                cause: new Error('ECONNREFUSED'),
              }),
            }),
          );
        });

        yield* GitHubHttp.use((service) =>
          Effect.gen(function* () {
            const e401 = yield* Effect.flip(service.getJson('https://api.github.com/401'));
            expect(e401.reason).toBe('TokenExpired');

            const e429 = yield* Effect.flip(service.getJson('https://api.github.com/429'));
            expect(e429.reason).toBe('RateLimited');
            expect(e429.retryAfterSeconds).toBe(42);

            const e403Rate = yield* Effect.flip(service.getJson('https://api.github.com/403-rate'));
            expect(e403Rate.reason).toBe('RateLimited');
            expect(e403Rate.resetAt).toBe(1700000000 * 1000);

            const e403Perm = yield* Effect.flip(service.getJson('https://api.github.com/403-perm'));
            expect(e403Perm.reason).toBe('Forbidden');

            const eNet = yield* Effect.flip(service.getJson('https://api.github.com/net-down'));
            expect(eNet.reason).toBe('NetworkUnavailable');
          }),
        ).pipe(Effect.provide(layerGitHubHttp.pipe(Layer.provide(clientLayer))));
      }),
  );
});
