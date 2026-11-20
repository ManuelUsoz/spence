// Offline release helper. Never fetches assets or generates keys.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [action, directory, keyPath] = process.argv.slice(2);
try {
  if (!['sign', 'verify'].includes(action) || !directory || !keyPath) {
    throw new Error(
      'Usage: node scripts/offline-update-sign.mjs <sign|verify> <asset-directory> <key.pem>',
    );
  }
  const bytes = readFileSync(join(directory, 'update-manifest.json'));
  const signaturePath = join(directory, 'update-manifest.sig');
  const key =
    action === 'sign'
      ? createPrivateKey(readFileSync(keyPath))
      : createPublicKey(readFileSync(keyPath));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Key must be Ed25519');
  if (action === 'verify') {
    const encoded = readFileSync(signaturePath, 'utf8').trim();
    if (
      !/^[A-Za-z0-9+/]{86}==$/.test(encoded) ||
      !verify(null, bytes, key, Buffer.from(encoded, 'base64'))
    ) {
      throw new Error('Invalid manifest signature');
    }
  }
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (
    !manifest ||
    typeof manifest.version !== 'string' ||
    manifest.channel !== 'beta' ||
    typeof manifest.releasedAt !== 'string' ||
    typeof manifest.releaseUrl !== 'string' ||
    typeof manifest.releaseNotes !== 'string' ||
    typeof manifest.knownIssues !== 'string' ||
    !manifest.artifacts ||
    typeof manifest.artifacts !== 'object'
  )
    throw new Error('Invalid manifest');
  if (new URL(manifest.releaseUrl).protocol !== 'https:') throw new Error('Invalid release URL');
  for (const target of ['win-x64', 'linux-x64']) {
    const artifact = manifest.artifacts[target];
    if (
      !artifact ||
      typeof artifact.url !== 'string' ||
      typeof artifact.sha512 !== 'string' ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes <= 0
    )
      throw new Error(`Invalid ${target} artifact`);
    const url = new URL(artifact.url);
    const name = decodeURIComponent(url.pathname.split('/').pop() || '');
    if (
      url.protocol !== 'https:' ||
      !name ||
      name !== basename(name) ||
      name === '.' ||
      name === '..'
    )
      throw new Error('Invalid artifact URL');
    const data = readFileSync(join(directory, name));
    if (
      data.length !== artifact.sizeBytes ||
      createHash('sha512').update(data).digest('base64') !== artifact.sha512
    ) {
      throw new Error(`Artifact mismatch: ${target}`);
    }
  }
  if (action === 'sign')
    writeFileSync(signaturePath, sign(null, bytes, key).toString('base64') + '\n', { flag: 'wx' });
  process.stdout.write(`${action} succeeded\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
