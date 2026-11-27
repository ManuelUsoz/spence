import { net } from 'electron';
import { Clock, Context, Deferred, Duration, Effect, Layer, Semaphore } from 'effect';
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from 'effect/http';
import { createHash } from 'node:crypto';
import { GitHostError } from '../../src/shared/pull-requests/pull-requests.rpc';

const DEFAULT_HOST = 'github.com';
const PER_HOST_CONCURRENCY = 4;
const REQUEST_TIMEOUT = Duration.seconds(30);
const DEFAULT_USER_AGENT = 'Spence';

export interface GitHubHttpResponse<A> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly data: A;
}

export interface GitHubHttpShape {
  readonly getJson: <A>(
    url: string,
    options?: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly host?: string;
      readonly coalesce?: boolean;
      readonly allowNotModified?: boolean;
    },
  ) => Effect.Effect<GitHubHttpResponse<A>, GitHostError>;
  readonly getText: (
    url: string,
    options?: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly host?: string;
      readonly coalesce?: boolean;
    },
  ) => Effect.Effect<GitHubHttpResponse<string>, GitHostError>;
  readonly postJson: <A>(
    url: string,
    body: unknown,
    options?: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly host?: string;
    },
  ) => Effect.Effect<GitHubHttpResponse<A>, GitHostError>;
  readonly patchJson: <A>(
    url: string,
    body: unknown,
    options?: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly host?: string;
    },
  ) => Effect.Effect<GitHubHttpResponse<A>, GitHostError>;
  readonly deleteJson: <A>(
    url: string,
    body?: unknown,
    options?: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly host?: string;
    },
  ) => Effect.Effect<GitHubHttpResponse<A>, GitHostError>;
  readonly postForm: <A>(
    url: string,
    body: Readonly<Record<string, string>>,
    options?: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly host?: string;
    },
  ) => Effect.Effect<GitHubHttpResponse<A>, GitHostError>;
}

/** Effect-native GitHub HTTP transport over Electron `net.fetch` with per-host concurrency and read coalescing. */
export class GitHubHttp extends Context.Service<GitHubHttp, GitHubHttpShape>()(
  'git-hosts/GitHubHttp',
) {}

const normalizeHeaders = (
  headers: HttpClientResponse.HttpClientResponse['headers'],
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
  }
  return out;
};

const parseRetryAfterSeconds = (
  raw: string | undefined,
  nowMs: number,
): { readonly retryAfterSeconds?: number; readonly resetAt?: number } => {
  if (raw === undefined) return {};
  const trimmed = raw.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return { retryAfterSeconds: seconds, resetAt: nowMs + seconds * 1_000 };
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs) && dateMs > nowMs) {
    return {
      retryAfterSeconds: Math.ceil((dateMs - nowMs) / 1_000),
      resetAt: dateMs,
    };
  }
  return {};
};

const parseRateLimitReset = (
  headers: Readonly<Record<string, string>>,
  nowMs: number,
): { readonly retryAfterSeconds?: number; readonly resetAt?: number } => {
  const fromRetryAfter = parseRetryAfterSeconds(headers['retry-after'], nowMs);
  if (fromRetryAfter.resetAt !== undefined) return fromRetryAfter;
  const reset = Number(headers['x-ratelimit-reset']) * 1_000;
  if (Number.isFinite(reset) && reset > nowMs) {
    return {
      retryAfterSeconds: Math.max(0, Math.ceil((reset - nowMs) / 1_000)),
      resetAt: reset,
    };
  }
  return {};
};

const isRateLimitedResponse = (
  status: number,
  headers: Readonly<Record<string, string>>,
  bodyText: string,
): boolean =>
  status === 429 ||
  (status === 403 &&
    (headers['x-ratelimit-remaining'] === '0' ||
      /rate limit|abuse detection mechanism/i.test(bodyText)));

const extractMessage = (parsed: unknown, fallback: string): string => {
  if (typeof parsed === 'object' && parsed !== null && 'message' in parsed) {
    const msg = (parsed as { readonly message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim().length > 0) return msg;
  }
  return fallback;
};

const toGitHostError = (
  status: number,
  headers: Readonly<Record<string, string>>,
  bodyText: string,
  parsed: unknown,
  nowMs: number,
): GitHostError => {
  const detail = extractMessage(parsed, `GitHub returned HTTP ${status}.`);
  if (status === 401) {
    return new GitHostError({ reason: 'TokenExpired', detail });
  }
  if (isRateLimitedResponse(status, headers, bodyText)) {
    const timing = parseRateLimitReset(headers, nowMs);
    return new GitHostError({
      reason: 'RateLimited',
      detail,
      ...(timing.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: timing.retryAfterSeconds }),
      ...(timing.resetAt === undefined ? {} : { resetAt: timing.resetAt }),
    });
  }
  if (status === 403) return new GitHostError({ reason: 'Forbidden', detail });
  if (status === 404) return new GitHostError({ reason: 'NotFound', detail });
  if (status === 409) return new GitHostError({ reason: 'Conflict', detail });
  if (status === 422) return new GitHostError({ reason: 'ValidationFailed', detail });
  return new GitHostError({ reason: 'HostError', detail });
};

const authFingerprint = (headers?: Readonly<Record<string, string>>): string => {
  const auth = headers?.['authorization'] ?? headers?.['Authorization'] ?? '';
  if (auth.length === 0) return '';
  return createHash('sha256').update(auth).digest('hex').slice(0, 16);
};

export const layerGitHubHttp = Layer.effect(
  GitHubHttp,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const semaphores = new Map<string, Semaphore.Semaphore>();
    const inFlight = new Map<
      string,
      Deferred.Deferred<GitHubHttpResponse<unknown>, GitHostError>
    >();

    const semaphoreFor = (host: string): Semaphore.Semaphore => {
      const key = host.trim().toLowerCase();
      const existing = semaphores.get(key);
      if (existing !== undefined) return existing;
      const created = Semaphore.makeUnsafe(PER_HOST_CONCURRENCY);
      semaphores.set(key, created);
      return created;
    };

    const runRequest = <A>(
      request: HttpClientRequest.HttpClientRequest,
      host: string,
      options?: { readonly allowNotModified?: boolean; readonly rawText?: boolean },
    ): Effect.Effect<GitHubHttpResponse<A>, GitHostError> =>
      semaphoreFor(host).withPermits(1)(
        Effect.gen(function* () {
          const response = yield* client.execute(request).pipe(
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.mapError(
              (err) =>
                new GitHostError({
                  reason: 'NetworkUnavailable',
                  detail:
                    err instanceof Error ? err.message : 'Could not reach GitHub over the network.',
                }),
            ),
          );
          const headers = normalizeHeaders(response.headers);
          if (options?.allowNotModified === true && response.status === 304) {
            return {
              status: 304,
              headers,
              data: undefined as A,
            };
          }
          const text = yield* response.text.pipe(
            Effect.mapError(
              () =>
                new GitHostError({
                  reason: 'HostError',
                  detail: 'Could not read response body from GitHub.',
                }),
            ),
          );
          let parsed: unknown = undefined;
          if (!options?.rawText && text.trim().length > 0) {
            try {
              parsed = JSON.parse(text) as unknown;
            } catch {
              parsed = undefined;
            }
          }
          if (response.status < 200 || response.status >= 300) {
            const nowMs = yield* Clock.currentTimeMillis;
            return yield* toGitHostError(response.status, headers, text, parsed, nowMs);
          }
          return {
            status: response.status,
            headers,
            data: (options?.rawText ? text : (parsed ?? {})) as A,
          };
        }),
      );

    const runCoalescedGet = <A>(
      request: HttpClientRequest.HttpClientRequest,
      host: string,
      key: string,
      options?: {
        readonly coalesce?: boolean;
        readonly allowNotModified?: boolean;
        readonly rawText?: boolean;
      },
    ): Effect.Effect<GitHubHttpResponse<A>, GitHostError> => {
      if (options?.coalesce === false) {
        return runRequest<A>(request, host, options);
      }
      return Effect.gen(function* () {
        const existing = inFlight.get(key);
        if (existing !== undefined) {
          return (yield* Deferred.await(existing)) as GitHubHttpResponse<A>;
        }
        const deferred = yield* Deferred.make<GitHubHttpResponse<unknown>, GitHostError>();
        inFlight.set(key, deferred);
        return yield* runRequest<A>(request, host, options).pipe(
          Effect.tap((res) => Deferred.succeed(deferred, res)),
          Effect.tapError((err) => Deferred.fail(deferred, err)),
          Effect.ensuring(
            Effect.sync(() => {
              if (inFlight.get(key) === deferred) {
                inFlight.delete(key);
              }
            }),
          ),
        );
      });
    };

    const getJson: GitHubHttpShape['getJson'] = <A>(
      url: string,
      options?: {
        readonly headers?: Readonly<Record<string, string>>;
        readonly host?: string;
        readonly coalesce?: boolean;
        readonly allowNotModified?: boolean;
      },
    ): Effect.Effect<GitHubHttpResponse<A>, GitHostError> => {
      const host = options?.host ?? DEFAULT_HOST;
      const request = HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeaders({
          accept: 'application/vnd.github+json',
          'user-agent': DEFAULT_USER_AGENT,
          'x-github-api-version': '2022-11-28',
          ...(options?.headers ?? {}),
        }),
      );
      const etag = options?.headers?.['if-none-match'] ?? options?.headers?.['If-None-Match'] ?? '';
      const key = `GET-JSON\0${url}\0${authFingerprint(options?.headers)}\0${etag}`;
      return runCoalescedGet<A>(request, host, key, {
        ...(options?.coalesce !== undefined ? { coalesce: options.coalesce } : {}),
        ...(options?.allowNotModified !== undefined
          ? { allowNotModified: options.allowNotModified }
          : {}),
      });
    };

    const getText: GitHubHttpShape['getText'] = (url, options) => {
      const host = options?.host ?? DEFAULT_HOST;
      const request = HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeaders({
          accept: 'application/vnd.github.v3.diff',
          'user-agent': DEFAULT_USER_AGENT,
          'x-github-api-version': '2022-11-28',
          ...(options?.headers ?? {}),
        }),
      );
      const key = `GET-TEXT\0${url}\0${authFingerprint(options?.headers)}`;
      return runCoalescedGet<string>(request, host, key, {
        ...(options?.coalesce !== undefined ? { coalesce: options.coalesce } : {}),
        rawText: true,
      });
    };

    const sendJson = <A>(
      baseRequest: HttpClientRequest.HttpClientRequest,
      body: unknown,
      options?: {
        readonly headers?: Readonly<Record<string, string>>;
        readonly host?: string;
      },
    ): Effect.Effect<GitHubHttpResponse<A>, GitHostError> => {
      const host = options?.host ?? DEFAULT_HOST;
      const withHeaders = baseRequest.pipe(
        HttpClientRequest.setHeaders({
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': DEFAULT_USER_AGENT,
          'x-github-api-version': '2022-11-28',
          ...(options?.headers ?? {}),
        }),
      );
      const request =
        body === undefined
          ? withHeaders
          : HttpClientRequest.bodyText(withHeaders, JSON.stringify(body), 'application/json');
      return runRequest<A>(request, host);
    };

    const postJson: GitHubHttpShape['postJson'] = (url, body, options) =>
      sendJson(HttpClientRequest.post(url), body, options);

    const patchJson: GitHubHttpShape['patchJson'] = (url, body, options) =>
      sendJson(HttpClientRequest.patch(url), body, options);

    const deleteJson: GitHubHttpShape['deleteJson'] = (url, body, options) =>
      sendJson(HttpClientRequest.delete(url), body, options);

    const postForm: GitHubHttpShape['postForm'] = <A>(
      url: string,
      body: Readonly<Record<string, string>>,
      options?: {
        readonly headers?: Readonly<Record<string, string>>;
        readonly host?: string;
      },
    ): Effect.Effect<GitHubHttpResponse<A>, GitHostError> => {
      const host = options?.host ?? DEFAULT_HOST;
      const request = HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders({
          accept: 'application/json',
          'user-agent': DEFAULT_USER_AGENT,
          ...(options?.headers ?? {}),
        }),
        HttpClientRequest.bodyUrlParams(body),
      );
      return runRequest<A>(request, host);
    };

    return { getJson, getText, postJson, patchJson, deleteJson, postForm };
  }),
);

/** Production `GitHubHttp` layer backed by Electron `net.fetch`. */
export const layerGitHubHttpLive = Layer.suspend(() =>
  layerGitHubHttp.pipe(
    Layer.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, net.fetch as typeof fetch)),
      ),
    ),
  ),
);
