// Beta release manifest builder and verified GitHub Release publisher. Never signs or handles private keys.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const UNSIGNED_WINDOWS_NOTICE =
  'Windows installers are unsigned, so Windows SmartScreen may show an unknown publisher warning.';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;

const findSingleArtifact = (directory, extension) => {
  const matches = readdirSync(directory).filter((name) => name.endsWith(extension));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${extension} artifact in ${directory}, found ${matches.length}.`,
    );
  }
  return matches[0];
};

const sha512AndSize = (filePath) => {
  const bytes = readFileSync(filePath);
  if (bytes.length === 0) throw new Error(`Artifact ${filePath} is empty.`);
  return {
    sizeBytes: bytes.length,
    sha512: createHash('sha512').update(bytes).digest('base64'),
  };
};

/** Ensures the release notes or known issues explicitly warn testers about the unsigned Windows installer. */
export const ensureUnsignedWindowsNotice = (knownIssues) => {
  const trimmed = knownIssues.trim();
  if (/unsigned/i.test(trimmed)) return trimmed;
  return trimmed === '' ? UNSIGNED_WINDOWS_NOTICE : `${trimmed}\n\n${UNSIGNED_WINDOWS_NOTICE}`;
};

/** Builds an unsigned `update-manifest.json` object from staged Windows and Linux x64 artifacts. */
export const buildBetaManifest = (options) => {
  const {
    directory,
    version,
    repo,
    releaseNotes,
    knownIssues = '',
    releasedAt = new Date().toISOString(),
  } = options;
  if (!SEMVER.test(version)) throw new Error(`Invalid version: ${version}`);
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error(`Invalid GitHub repo: ${repo}`);
  if (releaseNotes.trim() === '') throw new Error('Release notes are required.');

  const winFile = findSingleArtifact(directory, '.exe');
  const linuxFile = findSingleArtifact(directory, '.AppImage');
  const tag = `v${version}`;
  const baseDownloadUrl = `https://github.com/${repo}/releases/download/${tag}`;

  const winMeta = sha512AndSize(join(directory, winFile));
  const linuxMeta = sha512AndSize(join(directory, linuxFile));

  return {
    version,
    channel: 'beta',
    releasedAt,
    releaseUrl: `https://github.com/${repo}/releases/tag/${tag}`,
    releaseNotes: releaseNotes.trim(),
    knownIssues: ensureUnsignedWindowsNotice(knownIssues),
    artifacts: {
      'win-x64': {
        url: `${baseDownloadUrl}/${encodeURIComponent(winFile)}`,
        sha512: winMeta.sha512,
        sizeBytes: winMeta.sizeBytes,
      },
      'linux-x64': {
        url: `${baseDownloadUrl}/${encodeURIComponent(linuxFile)}`,
        sha512: linuxMeta.sha512,
        sizeBytes: linuxMeta.sizeBytes,
      },
    },
  };
};

/** Refuses to proceed if any PEM private key file is present inside the release staging folder. */
export const verifyNoPrivateKeys = (directory) => {
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.pem') && !name.endsWith('.key')) continue;
    const text = readFileSync(join(directory, name), 'utf8');
    if (text.includes('PRIVATE KEY')) {
      throw new Error(`Refusing to publish: private key material found in staging (${name}).`);
    }
  }
};

/** Verifies `update-manifest.json`, `update-manifest.sig`, and both staged artifacts against `publicKeyPath`. */
export const verifyReleaseStaging = (directory, publicKeyPath) => {
  verifyNoPrivateKeys(directory);
  const manifestPath = join(directory, 'update-manifest.json');
  const signaturePath = join(directory, 'update-manifest.sig');
  const manifestBytes = readFileSync(manifestPath);
  const signatureText = readFileSync(signaturePath, 'utf8').trim();
  const key = createPublicKey(readFileSync(publicKeyPath));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Key must be Ed25519.');
  if (
    !SIGNATURE_PATTERN.test(signatureText) ||
    !verify(null, manifestBytes, key, Buffer.from(signatureText, 'base64'))
  ) {
    throw new Error('Invalid manifest signature.');
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (
    !manifest ||
    manifest.channel !== 'beta' ||
    typeof manifest.version !== 'string' ||
    !SEMVER.test(manifest.version) ||
    typeof manifest.releaseNotes !== 'string' ||
    manifest.releaseNotes.trim() === '' ||
    typeof manifest.knownIssues !== 'string' ||
    !(/unsigned/i.test(manifest.knownIssues) || /unsigned/i.test(manifest.releaseNotes))
  ) {
    throw new Error('Invalid beta manifest metadata or missing unsigned Windows notice.');
  }
  const files = [];
  for (const target of ['win-x64', 'linux-x64']) {
    const artifact = manifest.artifacts?.[target];
    if (!artifact || typeof artifact.url !== 'string') {
      throw new Error(`Missing ${target} artifact in manifest.`);
    }
    const url = new URL(artifact.url);
    const name = decodeURIComponent(url.pathname.split('/').pop() || '');
    if (url.protocol !== 'https:' || !name || name !== basename(name)) {
      throw new Error(`Invalid artifact URL for ${target}.`);
    }
    const filePath = join(directory, name);
    const data = readFileSync(filePath);
    if (
      data.length !== artifact.sizeBytes ||
      createHash('sha512').update(data).digest('base64') !== artifact.sha512
    ) {
      throw new Error(`Artifact mismatch for ${target}: ${name}`);
    }
    files.push(filePath);
  }
  return { manifest, files, manifestPath, signaturePath };
};

/** Builds the `gh release create` arguments for a verified beta release. */
export const releaseCommandArgs = (verified, repo) => {
  const { manifest, files, manifestPath, signaturePath } = verified;
  const tag = `v${manifest.version}`;
  const notes = [
    manifest.releaseNotes.trim(),
    '',
    '## Known issues',
    '',
    manifest.knownIssues.trim(),
  ].join('\n');
  return {
    tag,
    notes,
    args: [
      'release',
      'create',
      tag,
      ...(repo ? ['--repo', repo] : []),
      '--prerelease',
      '--title',
      `Spence ${tag} (Beta)`,
      '--notes',
      notes,
      ...files,
      manifestPath,
      signaturePath,
    ],
  };
};

const parseFlags = (argv) => {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (key === 'dry-run') {
        flags[key] = 'true';
      } else if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        index += 1;
      } else {
        throw new Error(`Missing value for --${key}`);
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const [action, ...rest] = process.argv.slice(2);
    const { flags, positional } = parseFlags(rest);
    if (action === 'prepare') {
      const directory = positional[0];
      const version = flags['version'];
      const repo = flags['repo'] ?? 'ManuelUsoz/spence';
      const notes = flags['notes-file']
        ? readFileSync(flags['notes-file'], 'utf8')
        : (flags['notes'] ?? '');
      if (!directory || !version) {
        throw new Error(
          'Usage: node scripts/beta-release.mjs prepare <staging-dir> --version <semver> --notes <text> [--known-issues <text>] [--repo <owner/repo>]',
        );
      }
      if (existsSync(join(directory, 'update-manifest.sig'))) {
        throw new Error('Refusing to overwrite manifest beside an existing update-manifest.sig.');
      }
      const manifest = buildBetaManifest({
        directory,
        version,
        repo,
        releaseNotes: notes,
        knownIssues: flags['known-issues'] ?? '',
        ...(flags['released-at'] ? { releasedAt: flags['released-at'] } : {}),
      });
      writeFileSync(
        join(directory, 'update-manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      process.stdout.write(`Prepared update-manifest.json for v${version}\n`);
    } else if (action === 'publish') {
      const [directory, publicKeyPath] = positional;
      if (!directory || !publicKeyPath) {
        throw new Error(
          'Usage: node scripts/beta-release.mjs publish <staging-dir> <public.pem> [--repo <owner/repo>] [--dry-run]',
        );
      }
      const verified = verifyReleaseStaging(directory, publicKeyPath);
      const command = releaseCommandArgs(verified, flags['repo']);
      if (flags['dry-run'] === 'true') {
        process.stdout.write(`gh ${command.args.map((arg) => JSON.stringify(arg)).join(' ')}\n`);
      } else {
        execFileSync('gh', command.args, { stdio: 'inherit' });
      }
    } else {
      throw new Error('Unknown action. Use "prepare" or "publish".');
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
