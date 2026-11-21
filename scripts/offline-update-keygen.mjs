// Offline Ed25519 key generator for Spence update signing. Never writes inside the repository or prints private keys.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const isInsideRepo = (targetDir) => {
  let current = resolve(targetDir);
  while (true) {
    if (existsSync(join(current, '.git'))) {
      const rel = relative(current, resolve(targetDir));
      return rel === '' || !rel.startsWith('..');
    }
    const parent = resolve(current, '..');
    if (parent === current) return false;
    current = parent;
  }
};

export const generateOfflineKeypair = (outputDir) => {
  const dir = resolve(outputDir);
  if (isInsideRepo(dir)) {
    throw new Error(
      `Refusing to write signing keys inside a Git repository (${dir}). Choose an offline directory outside the repo.`,
    );
  }
  mkdirSync(dir, { recursive: true });

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePemPath = join(dir, 'private.pem');
  const publicPemPath = join(dir, 'public.pem');

  writeFileSync(privatePemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(publicPemPath, publicKey.export({ type: 'spki', format: 'pem' }), {
    flag: 'wx',
  });

  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPublicKeyBase64 = spkiDer.subarray(spkiDer.length - 32).toString('base64');

  return { privatePemPath, publicPemPath, rawPublicKeyBase64 };
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const [outputDir] = process.argv.slice(2);
    if (!outputDir) {
      throw new Error('Usage: node scripts/offline-update-keygen.mjs <offline-output-dir>');
    }
    const { privatePemPath, publicPemPath, rawPublicKeyBase64 } = generateOfflineKeypair(outputDir);
    process.stdout.write(
      [
        `Wrote private key (keep offline & encrypted backup): ${privatePemPath}`,
        `Wrote public key: ${publicPemPath}`,
        '',
        'Paste into electron/updates/public-key.ts (UPDATE_SIGNING_PUBLIC_KEY):',
        rawPublicKeyBase64,
        '',
      ].join('\n'),
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
