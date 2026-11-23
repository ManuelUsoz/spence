import { Schema } from 'effect';
import { parseReleaseVersion, selectRelease } from './releases';

const GithubReleases = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.Boolean,
    assets: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        browser_download_url: Schema.String,
        digest: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);

export const findUpdate = async (version: string, platform: 'win32' | 'linux') => {
  if (!parseReleaseVersion(version))
    return Promise.reject('Installed version is not supported by the updater');
  const response = await fetch(
    'https://api.github.com/repos/ManuelUsoz/spence/releases?per_page=100',
    {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Spence-Updater' },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok) return Promise.reject(`GitHub releases returned HTTP ${response.status}`);
  const releases = Schema.decodeUnknownSync(GithubReleases)(await response.json());
  return selectRelease(releases, version, platform);
};
