/** Versions accepted by the release workflow, ordered as SemVer. */
export interface ReleaseVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly rc: number | null;
}

export const parseReleaseVersion = (value: string): ReleaseVersion | null => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d{0,7}))?$/.exec(value);
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined)
    return null;
  const values = [Number(match[1]), Number(match[2]), Number(match[3])];
  const [major, minor, patch] = values;
  const rc = match[4] === undefined ? null : Number(match[4]);
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    !values.every(Number.isSafeInteger) ||
    (rc !== null && !Number.isSafeInteger(rc))
  )
    return null;
  return { major, minor, patch, rc };
};

export const compareReleaseVersions = (left: ReleaseVersion, right: ReleaseVersion): number =>
  left.major - right.major ||
  left.minor - right.minor ||
  left.patch - right.patch ||
  (left.rc === right.rc ? 0 : left.rc === null ? 1 : right.rc === null ? -1 : left.rc - right.rc);

export interface ReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly digest?: string | null;
}
export interface Release {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly assets: ReadonlyArray<ReleaseAsset>;
}

/** Selects the highest published complete release, including GitHub prereleases. */
export const selectRelease = (
  releases: ReadonlyArray<Release>,
  current: string,
  platform: 'win32' | 'linux',
): Release | null => {
  const currentVersion = parseReleaseVersion(current);
  if (!currentVersion) return null;
  return (
    releases
      .filter((release) => {
        const version = release.tag_name.startsWith('v')
          ? parseReleaseVersion(release.tag_name.slice(1))
          : null;
        if (release.draft || !version || compareReleaseVersions(version, currentVersion) <= 0)
          return false;
        const names = release.assets.map((asset) => asset.name);
        return platform === 'win32'
          ? names.includes('RELEASES') && names.some((name) => name.endsWith('-full.nupkg'))
          : names.some((name) => name.endsWith('_amd64.deb'));
      })
      .sort((left, right) => {
        const a = parseReleaseVersion(left.tag_name.slice(1));
        const b = parseReleaseVersion(right.tag_name.slice(1));
        return a && b ? compareReleaseVersions(b, a) : 0;
      })[0] ?? null
  );
};
