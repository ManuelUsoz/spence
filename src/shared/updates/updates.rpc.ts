import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

/**
 * The only channel Spence ships today. Every installed build follows beta, which receives beta and stable
 * releases; there is no channel selector until a stable channel exists (spec §17-19).
 */
export const UpdateChannel = Schema.Literal('beta').annotate({ identifier: 'UpdateChannel' });
export type UpdateChannel = typeof UpdateChannel.Type;

/** One signed release, as the updater shows it: what is newer and why the user might want it. */
export const UpdateInfo = Schema.Struct({
  version: Schema.String,
  /** The release page, opened for the full notes. */
  releaseUrl: Schema.String,
  releasedAt: Schema.String,
  /** Markdown-ish plain text published with the release. */
  releaseNotes: Schema.String,
  knownIssues: Schema.String,
  /** Size of this platform's artifact in bytes. */
  sizeBytes: Schema.Number,
}).annotate({ identifier: 'UpdateInfo' });
export type UpdateInfo = typeof UpdateInfo.Type;

/** Why an update stopped. Every one offers Check again; `NotWritable` also explains how to update by hand. */
export const UpdateFailure = Schema.Literals([
  'CheckFailed',
  'DownloadFailed',
  'VerificationFailed',
  'NotWritable',
  'InstallFailed',
  'Unsupported',
]).annotate({ identifier: 'UpdateFailure' });
export type UpdateFailure = typeof UpdateFailure.Type;

/**
 * What the updater is doing. `Failed` keeps the last `info` when there was one, so the user can still read the
 * release they were downloading. Unverified or altered updates never reach `Ready`.
 */
export const UpdateState = Schema.Union([
  Schema.TaggedStruct('Idle', {}),
  Schema.TaggedStruct('Checking', {}),
  Schema.TaggedStruct('UpToDate', { checkedAt: Schema.Number }),
  Schema.TaggedStruct('Available', { info: UpdateInfo }),
  Schema.TaggedStruct('Downloading', {
    info: UpdateInfo,
    receivedBytes: Schema.Number,
    totalBytes: Schema.Number,
  }),
  Schema.TaggedStruct('Ready', { info: UpdateInfo }),
  Schema.TaggedStruct('Failed', {
    reason: UpdateFailure,
    detail: Schema.String,
    info: Schema.optional(UpdateInfo),
  }),
]).annotate({ identifier: 'UpdateState' });
export type UpdateState = typeof UpdateState.Type;
export type UpdateStateTag = UpdateState['_tag'];

/** The release page opened from Settings; main only opens URLs the signed manifest named. */
export class UpdatesError extends Schema.TaggedError<UpdatesError>()('UpdatesError', {
  reason: Schema.Literals(['NotReady', 'Busy', 'NotPackaged', 'NotWritable']),
  detail: Schema.String,
}) {}

/**
 * The updater, Local to this Device: updates are installed by the machine that runs the app, never by a
 * Paired device. `watch` is the current state then every change; the calls return the state they leave behind.
 */
export const UpdatesRpcs = RpcGroup.make(
  Rpc.make('Updates.watch', { success: UpdateState, stream: true }),
  /** Checks now (startup, the 24-hour timer and Settings all use this one path). */
  Rpc.make('Updates.check', { success: UpdateState, error: UpdatesError }),
  /** Downloads the available artifact in the background; `watch` follows the progress. */
  Rpc.make('Updates.download', { success: UpdateState, error: UpdatesError }),
  /** Restarts to install the downloaded update. Ordinary quitting leaves it pending. */
  Rpc.make('Updates.restart', { error: UpdatesError }),
);
