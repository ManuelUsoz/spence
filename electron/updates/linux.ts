import { app } from 'electron';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Release } from './releases';

const MAX_BYTES = 512 * 1024 * 1024;

/** Downloads a release asset into a private directory and verifies GitHub's SHA-256. */
export const downloadDeb = async (release: Release): Promise<string> => {
  const asset = release.assets.find((item) =>
    /^spence_[A-Za-z0-9.+~_-]+_amd64\.deb$/.test(item.name),
  );
  if (!asset || !asset.digest || !/^sha256:[0-9a-f]{64}$/.test(asset.digest))
    return Promise.reject('Release has no verifiable Ubuntu package');
  const url = `https://github.com/ManuelUsoz/spence/releases/download/${release.tag_name}/${asset.name}`;
  if (asset.browser_download_url !== url) return Promise.reject('Unexpected update download URL');
  const dir = await mkdtemp(path.join(app.getPath('temp'), 'spence-update-'));
  await chmod(dir, 0o700);
  const file = path.join(dir, asset.name);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
    if (!response.ok || !response.body)
      return await Promise.reject(`Update download returned HTTP ${response.status}`);
    const handle = await open(file, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    try {
      const reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) return await Promise.reject('Update package is too large');
        hash.update(chunk.value);
        await handle.writeFile(chunk.value);
      }
    } finally {
      await handle.close();
    }
    if (`sha256:${hash.digest('hex')}` !== asset.digest)
      return await Promise.reject('Update package checksum does not match');
    return file;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    return Promise.reject(error);
  }
};

/** Run a fixed system installer without a shell; polkit requests the user's authentication. */
export const installDeb = async (file: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/pkexec', ['/usr/bin/apt-get', 'install', '-y', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const capture = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-65536);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          `Package installation failed or was cancelled (${code})${output ? `\n${output}` : ''}`,
        );
    });
  });
  await rm(path.dirname(file), { recursive: true, force: true }).catch((error: unknown) => {
    console.warn('Could not remove the downloaded update', error);
  });
};
