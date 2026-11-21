import {
  Clock,
  Context,
  Effect,
  Layer,
  Schema,
  Schedule,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import { createHash } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  acceptsOnChannel,
  compareVersions,
  isNewerVersion,
  type UpdateArtifact,
  type UpdateManifest,
  type UpdateTarget,
} from '../../src/shared/updates/manifest';
import {
  UpdatesError,
  type UpdateChannel,
  type UpdateInfo,
  type UpdateState,
} from '../../src/shared/updates/updates.rpc';
import { layerStoreUserData, Store, type LenientFile } from '../store/store';
import { layerUpdateInstaller, UpdateInstaller } from './installer';
import { UPDATE_OWNER, UPDATE_REPO, UPDATE_SIGNING_PUBLIC_KEY } from './public-key';
import { artifactFor, decodeManifest, fileNameOf, verifyManifestSignature } from './signature';
import {
  layerGitHubTransport,
  UpdateTransport,
  UpdateTransportError,
  updateFilePath,
  type FeedRelease,
} from './transport';

/** How often a running Spence looks for a release; startup checks once more (spec §6). */
export const UPDATE_CHECK_INTERVAL = '24 hours' as const;

/** The newest version this installation ever saw, so switching channels can never go backwards. */
const UpdatesFile: LenientFile<{ highestVersion: string }> = {
  file: 'updates.json',
  version: 1,
  migrations: [],
  fields: { highestVersion: Schema.String },
  defaults: { highestVersion: '' },
};

export interface UpdatesConfig {
  /** The running app's version, from `app.getVersion()`. */
  readonly currentVersion: string;
  /** The raw Ed25519 public key (base64); empty when the build has none, which rejects every update. */
  readonly publicKey: string;
  /** This build's package, or `null` where Spence ships none (macOS, ARM). */
  readonly target: UpdateTarget | null;
  /** Only beta today; kept explicit so the GitHub channel is never implicit (spec §5). */
  readonly channel: UpdateChannel;
}

interface Candidate {
  readonly info: UpdateInfo;
  readonly artifact: UpdateArtifact;
}

export interface UpdatesShape {
  /** The state now, then every change: checking, progress, failures, readiness. */
  readonly watch: Stream.Stream<UpdateState>;
  readonly state: Effect.Effect<UpdateState>;
  /** Checks the signed beta feed; failure is a state the page shows, never a thrown RPC error. */
  readonly check: Effect.Effect<UpdateState>;
  readonly download: Effect.Effect<UpdateState, UpdatesError>;
  /** Prepares the verified artifact for the next restart. The caller then quits Spence. */
  readonly restart: Effect.Effect<void, UpdatesError>;
  /** Cancel a requested restart without discarding the downloaded update. */
  readonly cancelRestart: Effect.Effect<void>;
  /** Applies a prepared install while quitting; `true` when Spence must relaunch the new version. */
  readonly applyPending: Effect.Effect<boolean, UpdatesError>;
}

export class Updates extends Context.Service<Updates, UpdatesShape>()('updates/Updates') {}

/** The state a failure leaves, keeping the release the user was reading when there was one. */
const failure = (
  state: UpdateState,
  reason: 'CheckFailed' | 'DownloadFailed' | 'VerificationFailed' | 'InstallFailed' | 'Unsupported',
  detail: string,
): UpdateState => ({
  _tag: 'Failed',
  reason,
  detail,
  ...(state._tag === 'Available' || state._tag === 'Downloading' || state._tag === 'Ready'
    ? { info: state.info }
    : {}),
});

const infoOf = (manifest: UpdateManifest, artifact: UpdateArtifact): UpdateInfo => ({
  version: manifest.version,
  releasedAt: manifest.releasedAt,
  releaseUrl: manifest.releaseUrl,
  releaseNotes: manifest.releaseNotes,
  knownIssues: manifest.knownIssues,
  sizeBytes: artifact.sizeBytes,
});

type Attempt =
  | { readonly _tag: 'Candidate'; readonly candidate: Candidate }
  | { readonly _tag: 'Rejected'; readonly detail: string }
  | { readonly _tag: 'Skipped' };

/**
 * Builds the updater over injected transport, installer and store. `check` verifies the detached Ed25519
 * signature before trusting anything in the manifest, then the artifact's SHA-512 before marking it ready.
 * Nothing in a failed or altered update can reach `Ready` or the installer.
 */
export const makeUpdates = Effect.fnUntraced(function* (config: UpdatesConfig) {
  const transport = yield* UpdateTransport;
  const installer = yield* UpdateInstaller;
  const store = yield* Store;
  const lock = yield* Semaphore.make(1);
  const ref = yield* SubscriptionRef.make<UpdateState>({ _tag: 'Idle' });

  let candidate: Candidate | null = null;
  let downloadedPath: string | null = null;
  let prepared = false;

  const setState = (state: UpdateState) => SubscriptionRef.set(ref, state);
  const state = SubscriptionRef.get(ref);

  /** The running version or the newest one ever seen, whichever is greater. */
  const floor = Effect.gen(function* () {
    const { highestVersion } = yield* store.readLenient(UpdatesFile);
    return isNewerVersion(highestVersion, config.currentVersion)
      ? highestVersion
      : config.currentVersion;
  });

  const remember = (version: string) =>
    store.readLenient(UpdatesFile).pipe(
      Effect.flatMap((stored) =>
        isNewerVersion(version, stored.highestVersion)
          ? store.writeLenient(UpdatesFile, { highestVersion: version })
          : Effect.void,
      ),
      Effect.catch((error) =>
        Effect.logWarning(`Could not remember update ${version}: ${error.detail}`),
      ),
    );

  const attempt = Effect.fnUntraced(function* (release: FeedRelease) {
    const [text, signature] = yield* Effect.all([
      transport.text(release.manifestUrl),
      transport.text(release.signatureUrl),
    ]);
    const bytes = new TextEncoder().encode(text);
    if (!verifyManifestSignature(config.publicKey, bytes, signature.trim())) {
      return {
        _tag: 'Rejected',
        detail: `The release ${release.version} has an invalid signature.`,
      } satisfies Attempt;
    }
    const manifest = decodeManifest(text);
    if (manifest === null || manifest.version !== release.version) {
      return {
        _tag: 'Rejected',
        detail: `The release ${release.version} has a malformed manifest.`,
      } satisfies Attempt;
    }
    if (!acceptsOnChannel(manifest) || config.target === null) {
      return { _tag: 'Skipped' } satisfies Attempt;
    }
    const artifact = artifactFor(manifest, config.target);
    if (artifact === null) return { _tag: 'Skipped' } satisfies Attempt;
    return {
      _tag: 'Candidate',
      candidate: { info: infoOf(manifest, artifact), artifact },
    } satisfies Attempt;
  });

  const checkOnly = Effect.gen(function* () {
    const before = yield* state;
    // A downloaded update waits for its restart; a download in flight is not abandoned by a timer.
    if (before._tag === 'Downloading' || before._tag === 'Ready') return before;
    if (config.target === null) {
      const next = failure(
        before,
        'Unsupported',
        'Spence does not ship updates for this platform. Download a new build from the release page.',
      );
      yield* setState(next);
      return next;
    }
    if (config.publicKey === '') {
      const next = failure(
        before,
        'Unsupported',
        'This build has no update signing key, so it cannot verify releases. Download a new build from the release page.',
      );
      yield* setState(next);
      return next;
    }
    yield* setState({ _tag: 'Checking' });

    const releases = yield* transport.releases.pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Update check failed: ${error.detail}`).pipe(Effect.as(null)),
      ),
    );
    if (releases === null) {
      const next = failure(
        before,
        'CheckFailed',
        'Could not reach the release feed. Check your connection and try again.',
      );
      yield* setState(next);
      return next;
    }

    const current = yield* floor;
    const ordered = [...releases].sort((left, right) =>
      isNewerVersion(left.version, right.version) ? -1 : 1,
    );
    let rejection: string | null = null;
    let sawNewer = false;
    for (const release of ordered) {
      if (
        !isNewerVersion(release.version, config.currentVersion) ||
        compareVersions(release.version, current) < 0
      )
        continue;
      sawNewer = true;
      const result = yield* attempt(release).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            _tag: 'Rejected',
            detail: `Could not read release ${release.version}: ${error.detail}`,
          } satisfies Attempt),
        ),
      );
      switch (result._tag) {
        case 'Candidate': {
          const info = result.candidate.info;
          if (
            !isNewerVersion(info.version, config.currentVersion) ||
            compareVersions(info.version, current) < 0
          )
            continue;
          yield* remember(info.version);
          candidate = result.candidate;
          const next: UpdateState = { _tag: 'Available', info };
          yield* setState(next);
          return next;
        }
        case 'Rejected':
          rejection = result.detail;
          continue;
        case 'Skipped':
          continue;
      }
    }

    if (rejection !== null) {
      const next = failure(before, 'VerificationFailed', rejection);
      yield* setState(next);
      return next;
    }
    if (sawNewer) yield* Effect.logInfo('The newest beta has no build for this platform yet.');
    const next: UpdateState = {
      _tag: 'UpToDate',
      checkedAt: yield* Clock.currentTimeMillis,
    };
    yield* setState(next);
    return next;
  }).pipe(Semaphore.withPermit(lock));

  const download = Effect.gen(function* () {
    const before = yield* state;
    if (before._tag !== 'Available' || candidate === null) {
      return yield* new UpdatesError({
        reason: 'NotReady',
        detail: 'There is no verified update to download.',
      });
    }
    const current = candidate;
    const name = fileNameOf(current.artifact.url);
    const safeName = name === null || name.includes('/') || name.includes('\\') ? null : name;
    if (safeName === null) {
      return yield* new UpdatesError({
        reason: 'NotReady',
        detail: 'The release names no usable artifact.',
      });
    }
    const destination = updateFilePath(store.root, current.info.version, safeName);
    yield* setState({
      _tag: 'Downloading',
      info: current.info,
      receivedBytes: 0,
      totalBytes: current.artifact.sizeBytes,
    });

    const body = yield* transport.download(current.artifact.url);
    const total = body.totalBytes > 0 ? body.totalBytes : current.artifact.sizeBytes;
    const hash = createHash('sha512');
    let received = 0;

    const write = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => mkdir(path.dirname(destination), { recursive: true }),
          catch: (cause) => new UpdateTransportError({ reason: 'Io', detail: String(cause) }),
        });
        const handle = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => open(destination, 'w'),
            catch: (cause) => new UpdateTransportError({ reason: 'Io', detail: String(cause) }),
          }),
          (opened) => Effect.promise(() => opened.close()),
        );
        yield* Stream.runForEach(
          body.chunks,
          Effect.fnUntraced(function* (chunk) {
            yield* Effect.tryPromise({
              try: () => handle.writeFile(chunk),
              catch: (cause) => new UpdateTransportError({ reason: 'Io', detail: String(cause) }),
            });
            hash.update(chunk);
            received += chunk.byteLength;
            yield* setState({
              _tag: 'Downloading',
              info: current.info,
              receivedBytes: received,
              totalBytes: total,
            });
          }),
        );
      }),
    );

    const outcome = yield* write.pipe(
      Effect.as({ _tag: 'Done' as const }),
      Effect.catch((error) => Effect.succeed({ _tag: 'Transport' as const, detail: error.detail })),
    );
    if (outcome._tag === 'Transport') {
      yield* Effect.promise(() => rm(destination, { force: true }));
      const next = failure(
        { _tag: 'Downloading', info: current.info, receivedBytes: received, totalBytes: total },
        'DownloadFailed',
        `The download did not finish: ${outcome.detail}. Try again.`,
      );
      yield* setState(next);
      return next;
    }

    const digest = hash.digest('base64');
    if (digest !== current.artifact.sha512 || received !== current.artifact.sizeBytes) {
      yield* Effect.promise(() => rm(destination, { force: true }));
      const next = failure(
        { _tag: 'Downloading', info: current.info, receivedBytes: received, totalBytes: total },
        'VerificationFailed',
        'The downloaded update does not match its signed manifest. It was discarded.',
      );
      yield* setState(next);
      return next;
    }

    downloadedPath = destination;
    const next: UpdateState = { _tag: 'Ready', info: current.info };
    yield* setState(next);
    return next;
  }).pipe(
    Semaphore.withPermit(lock),
    Effect.catch((error) => {
      if (error._tag === 'UpdatesError') return Effect.fail(error);
      return Effect.gen(function* () {
        const next = failure(
          yield* state,
          'DownloadFailed',
          `The download failed: ${error.detail}. Try again.`,
        );
        yield* setState(next);
        return next;
      });
    }),
  );

  const check = checkOnly.pipe(
    Effect.flatMap((result) =>
      result._tag === 'Available'
        ? download.pipe(Effect.orElseSucceed(() => result))
        : Effect.succeed(result),
    ),
  );

  const restart = Effect.gen(function* () {
    const current = yield* state;
    if (current._tag !== 'Ready' || downloadedPath === null) {
      return yield* new UpdatesError({
        reason: 'NotReady',
        detail: 'No verified update is ready to install.',
      });
    }
    yield* installer.prepare(downloadedPath);
    prepared = true;
  }).pipe(Semaphore.withPermit(lock));

  const applyPending = Effect.gen(function* () {
    if (!prepared) return false;
    prepared = false;
    const relaunch = yield* installer.apply.pipe(
      Effect.catch(
        Effect.fnUntraced(function* (error) {
          yield* Effect.logWarning(`Installing the update failed: ${error.detail}`);
          yield* setState(failure(yield* state, 'InstallFailed', error.detail));
          return yield* error;
        }),
      ),
    );
    return relaunch;
  });

  return {
    watch: SubscriptionRef.changes(ref),
    state,
    check,
    download,
    restart,
    cancelRestart: Effect.sync(() => {
      prepared = false;
    }),
    applyPending,
  } satisfies UpdatesShape;
});

/** The updater over injected services, for tests. */
export const layerUpdates = (config: UpdatesConfig) => Layer.effect(Updates, makeUpdates(config));

/**
 * Production wiring: the GitHub beta feed, the platform installer and the embedded public key. Starts the
 * startup check and the 24-hour timer in the layer's scope, so it lives as long as `MainRuntime`.
 */
export const layerUpdatesLive = (config: {
  readonly currentVersion: string;
  readonly target: UpdateTarget | null;
}) =>
  Layer.effect(
    Updates,
    Effect.gen(function* () {
      const updates = yield* makeUpdates({
        ...config,
        channel: 'beta',
        publicKey: UPDATE_SIGNING_PUBLIC_KEY,
      });
      const scope = yield* Effect.scope;
      yield* updates.check.pipe(
        Effect.ignore,
        Effect.repeat(Schedule.spaced(UPDATE_CHECK_INTERVAL)),
        Effect.forkIn(scope),
      );
      return updates;
    }),
  ).pipe(
    Layer.provideMerge(layerUpdateInstaller),
    Layer.provideMerge(
      layerGitHubTransport({
        owner: UPDATE_OWNER,
        repo: UPDATE_REPO,
        userAgent: `Spence/${config.currentVersion}`,
      }),
    ),
    Layer.provide(layerStoreUserData),
  );
