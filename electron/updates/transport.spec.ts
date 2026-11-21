import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Stream } from 'effect';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeGitHubTransport, releasesFromApi } from './transport';

const collectDownload = (url: string, apiBase: string) => {
  const transport = makeGitHubTransport({
    owner: 'ManuelUsoz',
    repo: 'spence',
    userAgent: 'Spence/1.0.0-beta.1',
    apiBase,
  });
  return Effect.gen(function* () {
    const body = yield* transport.download(url);
    const chunks = yield* Stream.runCollect(body.chunks);
    return {
      totalBytes: body.totalBytes,
      bytes: Buffer.concat(chunks),
    };
  });
};

describe('update transport', () => {
  it('filters drafts and incomplete releases from the GitHub API feed', () => {
    const releases = releasesFromApi([
      {
        draft: true,
        prerelease: true,
        tag_name: 'v1.0.2-beta.1',
        assets: [
          { name: 'update-manifest.json', browser_download_url: 'https://example.com/m1' },
          { name: 'update-manifest.sig', browser_download_url: 'https://example.com/s1' },
        ],
      },
      {
        draft: false,
        prerelease: true,
        tag_name: 'v1.0.1-beta.1',
        assets: [{ name: 'update-manifest.json', browser_download_url: 'https://example.com/m2' }],
      },
      {
        draft: false,
        prerelease: false,
        tag_name: 'v1.0.1',
        assets: [
          { name: 'update-manifest.json', browser_download_url: 'https://example.com/m3' },
          { name: 'update-manifest.sig', browser_download_url: 'https://example.com/s3' },
        ],
      },
    ]);

    expect(releases).toEqual([
      {
        version: '1.0.1',
        prerelease: false,
        manifestUrl: 'https://example.com/m3',
        signatureUrl: 'https://example.com/s3',
      },
    ]);
  });

  it('fetches releases, text assets and streamed downloads over HTTP, and reports errors', async () => {
    const payload = Buffer.from('binary-installer-bytes');
    const server = createServer((request, response) => {
      if (request.url === '/repos/ManuelUsoz/spence/releases?per_page=30') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify([
            {
              draft: false,
              prerelease: true,
              tag_name: 'v1.0.1-beta.1',
              assets: [
                {
                  name: 'update-manifest.json',
                  browser_download_url: `http://127.0.0.1:${port}/manifest.json`,
                },
                {
                  name: 'update-manifest.sig',
                  browser_download_url: `http://127.0.0.1:${port}/manifest.sig`,
                },
              ],
            },
          ]),
        );
        return;
      }
      if (request.url === '/manifest.json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"version":"1.0.1-beta.1"}');
        return;
      }
      if (request.url === '/artifact.exe') {
        response.writeHead(200, { 'content-length': String(payload.length) });
        response.end(payload);
        return;
      }
      response.writeHead(404);
      response.end('not found');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const transport = makeGitHubTransport({
        owner: 'ManuelUsoz',
        repo: 'spence',
        userAgent: 'Spence/1.0.0-beta.1',
        apiBase: base,
      });

      const releases = await Effect.runPromise(transport.releases);
      expect(releases).toHaveLength(1);
      expect(releases[0]?.version).toBe('1.0.1-beta.1');

      const text = await Effect.runPromise(transport.text(`${base}/manifest.json`));
      expect(text).toBe('{"version":"1.0.1-beta.1"}');

      const downloaded = await Effect.runPromise(collectDownload(`${base}/artifact.exe`, base));
      expect(downloaded.totalBytes).toBe(payload.length);
      expect(downloaded.bytes).toEqual(payload);

      const missing = await Effect.runPromise(Effect.exit(transport.text(`${base}/missing`)));
      expect(missing._tag).toBe('Failure');
      if (Exit.isFailure(missing)) {
        expect(Cause.squash(missing.cause)).toMatchObject({
          _tag: 'UpdateTransportError',
          reason: 'Http',
        });
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
