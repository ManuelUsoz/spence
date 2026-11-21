import { Context, Effect, Layer, Schedule, Schema, Stream } from 'effect';
import path from 'node:path';

/** A feed request or download failed: offline, a non-2xx answer, or a body that could not be read. */
export class UpdateTransportError extends Schema.TaggedError<UpdateTransportError>()(
  'UpdateTransportError',
  {
    reason: Schema.Literals(['Offline', 'Http', 'Io']),
    detail: Schema.String,
  },
) {}

/** One published release that carries a signed manifest, found by the feed. */
export const FeedRelease = Schema.Struct({
  /** `tag_name` without its leading `v`. */
  version: Schema.String,
  prerelease: Schema.Boolean,
  manifestUrl: Schema.String,
  signatureUrl: Schema.String,
}).annotate({ identifier: 'FeedRelease' });
export type FeedRelease = typeof FeedRelease.Type;

/** A download ready to be written: its body as chunks and the size the server declared (`0` when unknown). */
export interface DownloadBody {
  readonly totalBytes: number;
  readonly chunks: Stream.Stream<Uint8Array, UpdateTransportError>;
}

export interface UpdateTransportShape {
  /** Every non-draft release carrying both the manifest and its signature, in GitHub's order. */
  readonly releases: Effect.Effect<ReadonlyArray<FeedRelease>, UpdateTransportError>;
  readonly text: (url: string) => Effect.Effect<string, UpdateTransportError>;
  readonly download: (url: string) => Effect.Effect<DownloadBody, UpdateTransportError>;
}

export class UpdateTransport extends Context.Service<UpdateTransport, UpdateTransportShape>()(
  'updates/UpdateTransport',
) {}

export interface GitHubFeedConfig {
  readonly owner: string;
  readonly repo: string;
  /** Sent to GitHub; GitHub refuses requests without one. */
  readonly userAgent: string;
  /** `https://api.github.com` unless a test or mirror says otherwise. */
  readonly apiBase?: string;
}

const RELEASE = Schema.Struct({
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  tag_name: Schema.String,
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      browser_download_url: Schema.String,
    }),
  ),
});

const releaseName = (tag: string): string => (tag.startsWith('v') ? tag.slice(1) : tag);

/** A release is usable when it carries both signed-manifest files. */
export const releasesFromApi = (json: unknown): ReadonlyArray<FeedRelease> => {
  const decoded = Schema.decodeUnknownSync(Schema.Array(RELEASE))(json);
  return decoded.flatMap((release) => {
    if (release.draft) return [];
    const manifest = release.assets.find((asset) => asset.name === 'update-manifest.json');
    const signature = release.assets.find((asset) => asset.name === 'update-manifest.sig');
    if (manifest === undefined || signature === undefined) return [];
    return [
      {
        version: releaseName(release.tag_name),
        prerelease: release.prerelease,
        manifestUrl: manifest.browser_download_url,
        signatureUrl: signature.browser_download_url,
      },
    ];
  });
};

const networkError = (detail: string) => new UpdateTransportError({ reason: 'Offline', detail });

const statusError = (url: string, status: number) =>
  new UpdateTransportError({ reason: 'Http', detail: `${url} answered ${status}` });

/** Where an update body is saved: under the store, one folder per version. */
export const updateFilePath = (root: string, version: string, fileName: string): string =>
  path.join(root, 'updates', version, fileName);

export const makeGitHubTransport = (config: GitHubFeedConfig): UpdateTransportShape => {
  const apiBase = config.apiBase ?? 'https://api.github.com';
  const userAgent = config.userAgent;

  const request = (url: string, headers: Record<string, string> = {}) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          headers: { 'User-Agent': userAgent, ...headers },
          signal: AbortSignal.timeout(30_000),
        });
        return response;
      },
      catch: (cause) =>
        cause instanceof UpdateTransportError ? cause : networkError(String(cause)),
    }).pipe(
      Effect.flatMap((response) =>
        response.ok ? Effect.succeed(response) : Effect.fail(statusError(url, response.status)),
      ),
    );

  const releases = Effect.gen(function* () {
    const url = `${apiBase}/repos/${config.owner}/${config.repo}/releases?per_page=30`;
    const response = yield* request(url, {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    const json = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => networkError(String(cause)),
    });
    return yield* Effect.try({
      try: (): ReadonlyArray<FeedRelease> => releasesFromApi(json),
      catch: (cause) =>
        new UpdateTransportError({
          reason: 'Http',
          detail: `unexpected release feed: ${String(cause)}`,
        }),
    });
  }).pipe(
    // A startup check racing a sleeping network is not worth an error the user must dismiss.
    Effect.retry(Schedule.exponential('1 second').pipe(Schedule.upTo({ times: 2 }))),
  );

  const text = Effect.fnUntraced(function* (url: string) {
    const response = yield* request(url);
    return yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => networkError(String(cause)),
    });
  });

  const download = Effect.fnUntraced(function* (url: string) {
    const response = yield* request(url);
    const body = response.body;
    if (body === null) {
      return yield* new UpdateTransportError({
        reason: 'Http',
        detail: `${url} has no body`,
      });
    }
    return {
      totalBytes: Number(response.headers.get('content-length') ?? '') || 0,
      chunks: Stream.fromReadableStream<Uint8Array, UpdateTransportError>({
        evaluate: () => body,
        onError: (cause) => networkError(String(cause)),
      }),
    } satisfies DownloadBody;
  });

  return { releases, text, download };
};

/** The public GitHub Releases of the maintainer's repository. Nothing else is trusted as a feed. */
export const layerGitHubTransport = (config: GitHubFeedConfig): Layer.Layer<UpdateTransport> =>
  Layer.succeed(UpdateTransport, makeGitHubTransport(config));
