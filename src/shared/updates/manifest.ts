import { Schema } from 'effect';
import { UpdateChannel } from './updates.rpc';

/**
 * One file a release ships. `sha512` is base64 over the exact artifact bytes, computed before the manifest is
 * signed: an altered artifact no longer matches the signed manifest.
 */
export const UpdateArtifact = Schema.Struct({
  /** Absolute https URL on the release, signed so a compromised host cannot point at other code. */
  url: Schema.String,
  /** base64 SHA-512 of the artifact bytes. */
  sha512: Schema.String,
  sizeBytes: Schema.Int.check(Schema.isGreaterThan(0)),
}).annotate({ identifier: 'UpdateArtifact' });
export type UpdateArtifact = typeof UpdateArtifact.Type;

/** The platforms Spence packages today (out of scope: macOS, ARM, other Linux formats). */
export const UpdateTarget = Schema.Literals(['win-x64', 'linux-x64']).annotate({
  identifier: 'UpdateTarget',
});
export type UpdateTarget = typeof UpdateTarget.Type;

/**
 * The signed description of one beta release. It is published as `update-manifest.json` beside
 * `update-manifest.sig` (an Ed25519 signature over the exact manifest bytes), both on the public GitHub
 * Release. `channel` is always `beta` today.
 */
export const UpdateManifest = Schema.Struct({
  version: Schema.String,
  channel: UpdateChannel,
  releasedAt: Schema.String,
  releaseUrl: Schema.String,
  releaseNotes: Schema.String,
  knownIssues: Schema.String,
  artifacts: Schema.Record(UpdateTarget, UpdateArtifact),
}).annotate({ identifier: 'UpdateManifest' });
export type UpdateManifest = typeof UpdateManifest.Type;

export const UPDATE_MANIFEST_ASSET = 'update-manifest.json';
export const UPDATE_SIGNATURE_ASSET = 'update-manifest.sig';

/** A version as Spence compares it: `major.minor.patch` with an optional dot-separated prerelease. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** `undefined` for a stable release; lower than every stable release of the same numbers. */
  readonly prerelease: ReadonlyArray<string> | undefined;
}

/** Parses `1.2.3` / `1.2.3-beta.1`; `null` when it is not a version Spence accepts. */
export const parseVersion = (version: string): ParsedVersion | null => {
  const match = VERSION.exec(version);
  if (match === null) return null;
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? undefined : prerelease.split('.'),
  };
};

const comparePrerelease = (
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): number => {
  // A stable release is newer than any prerelease with the same numbers.
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index] ?? '';
    const b = right[index] ?? '';
    const aNumber = /^\d+$/.test(a) ? Number(a) : null;
    const bNumber = /^\d+$/.test(b) ? Number(b) : null;
    if (aNumber !== null && bNumber !== null) {
      if (aNumber !== bNumber) return aNumber < bNumber ? -1 : 1;
    } else if (aNumber !== null) {
      return -1;
    } else if (bNumber !== null) {
      return 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
};

/** Negative when `left` is older, positive when newer, 0 when equal; invalid versions sort below valid ones. */
export const compareVersions = (left: string, right: string): number => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) return a === null && b === null ? 0 : a === null ? -1 : 1;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
};

/** Whether `candidate` is a release this build may move to: strictly newer than `current`. */
export const isNewerVersion = (candidate: string, current: string): boolean =>
  compareVersions(candidate, current) > 0;

/**
 * The beta channel accepts beta and stable releases. A stable release is newer than the betas before it, so a
 * beta user keeps receiving both (spec §17). Downgrades are never offered.
 */
export const acceptsOnChannel = (candidate: { readonly channel: UpdateChannel }): boolean =>
  candidate.channel === 'beta';
