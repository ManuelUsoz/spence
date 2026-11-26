import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { Timestamp } from '../projects/projects.rpc';

/** Supported external Git host kinds. */
export const GitHostKind = Schema.Literals(['github']).annotate({
  identifier: 'GitHostKind',
});
export type GitHostKind = typeof GitHostKind.Type;

/** Identifies an in-progress OAuth Device Flow ceremony. */
export const DeviceFlowId = Schema.String.pipe(Schema.brand('DeviceFlowId')).annotate({
  identifier: 'DeviceFlowId',
});
export type DeviceFlowId = typeof DeviceFlowId.Type;

/** How a Host account was authenticated. */
export const HostAuthMethod = Schema.Literals(['device-flow', 'pat', 'gh-cli']).annotate({
  identifier: 'HostAuthMethod',
});
export type HostAuthMethod = typeof HostAuthMethod.Type;

/** Connection health of a configured Host account. */
export const HostAccountStatus = Schema.Literals(['connected', 'needs-reconnect']).annotate({
  identifier: 'HostAccountStatus',
});
export type HostAccountStatus = typeof HostAccountStatus.Type;

/** Where the Host credential is kept: OS keyring (`secure`) or process memory only (`session-only`). */
export const HostPersistMode = Schema.Literals(['secure', 'session-only']).annotate({
  identifier: 'HostPersistMode',
});
export type HostPersistMode = typeof HostPersistMode.Type;

/** Required OAuth scopes for GitHub Host operations in Spence. */
export const GITHUB_REQUIRED_SCOPES: ReadonlyArray<string> = ['repo', 'read:org'];

/** Public metadata for a connected (or reconnect-needed) Git host account. Never contains a raw token. */
export const HostAccount = Schema.Struct({
  host: GitHostKind,
  handle: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  authMethod: HostAuthMethod,
  scopes: Schema.Array(Schema.String),
  status: HostAccountStatus,
  statusDetail: Schema.NullOr(Schema.String),
  persistMode: HostPersistMode,
  updatedAt: Timestamp,
}).annotate({ identifier: 'HostAccount' });
export type HostAccount = typeof HostAccount.Type;

/** Current Host accounts and whether OS secure storage is available on this machine. */
export const HostAccountsState = Schema.Struct({
  accounts: Schema.Array(HostAccount),
  secretStorageAvailable: Schema.Boolean,
}).annotate({ identifier: 'HostAccountsState' });
export type HostAccountsState = typeof HostAccountsState.Type;

/** User-facing OAuth Device Flow prompt returned when starting sign-in. */
export const DeviceFlowPrompt = Schema.Struct({
  flowId: DeviceFlowId,
  host: GitHostKind,
  userCode: Schema.String,
  verificationUri: Schema.String,
  expiresAt: Timestamp,
  intervalSeconds: Schema.Int,
}).annotate({ identifier: 'DeviceFlowPrompt' });
export type DeviceFlowPrompt = typeof DeviceFlowPrompt.Type;

/** One poll step of an OAuth Device Flow ceremony. */
export const DeviceFlowPollResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('pending'),
    intervalSeconds: Schema.Int,
  }),
  Schema.Struct({
    status: Schema.Literal('complete'),
    account: HostAccount,
  }),
]).annotate({ identifier: 'DeviceFlowPollResult' });
export type DeviceFlowPollResult = typeof DeviceFlowPollResult.Type;

/** Availability of the `gh` CLI on Merged PATH for one-time token import. */
export const GhCliStatus = Schema.Struct({
  available: Schema.Boolean,
  authenticated: Schema.Boolean,
  handle: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'GhCliStatus' });
export type GhCliStatus = typeof GhCliStatus.Type;

/** Normalized failure across all Git host auth, transport, and API boundaries. */
export class GitHostError extends Schema.TaggedError<GitHostError>()('GitHostError', {
  reason: Schema.Literals([
    'NotAuthenticated',
    'TokenExpired',
    'Forbidden',
    'NotFound',
    'ValidationFailed',
    'Conflict',
    'RateLimited',
    'UnsupportedCapability',
    'NetworkUnavailable',
    'HostError',
  ]),
  detail: Schema.String,
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
  resetAt: Schema.optionalKey(Timestamp),
  conflictingFields: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

/**
 * Local-only RPC group for Git host authentication and Pull requests.
 * Merged into `DesktopRpcs` only; never exposed in `DeviceScopedRpcs` or `RemoteRpcs`.
 */
export const PullRequestsRpcs = RpcGroup.make(
  Rpc.make('HostAuth.getAccounts', {
    success: HostAccountsState,
    error: GitHostError,
  }),
  Rpc.make('HostAuth.startDeviceFlow', {
    payload: { host: GitHostKind },
    success: DeviceFlowPrompt,
    error: GitHostError,
  }),
  Rpc.make('HostAuth.pollDeviceFlow', {
    payload: { host: GitHostKind, flowId: DeviceFlowId, persistMode: HostPersistMode },
    success: DeviceFlowPollResult,
    error: GitHostError,
  }),
  Rpc.make('HostAuth.cancelDeviceFlow', {
    payload: { host: GitHostKind, flowId: DeviceFlowId },
    success: Schema.Void,
  }),
  Rpc.make('HostAuth.connectPat', {
    payload: { host: GitHostKind, token: Schema.String, persistMode: HostPersistMode },
    success: HostAccount,
    error: GitHostError,
  }),
  Rpc.make('HostAuth.checkGhCli', {
    payload: { host: GitHostKind },
    success: GhCliStatus,
    error: GitHostError,
  }),
  Rpc.make('HostAuth.importGhCli', {
    payload: { host: GitHostKind, persistMode: HostPersistMode },
    success: HostAccount,
    error: GitHostError,
  }),
  Rpc.make('HostAuth.verify', {
    payload: { host: GitHostKind },
    success: HostAccount,
    error: GitHostError,
  }),
  Rpc.make('HostAuth.disconnect', {
    payload: { host: GitHostKind },
    success: Schema.Void,
    error: GitHostError,
  }),
);
