// Throwaway preview server. No access to Git operations or desktop RPCs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const base = 'src/app/features/session/source-control-prototype/';
const assets = new Map([
  ['/', [base + 'index.html', 'text/html']],
  ['/prototype.js', [base + 'prototype.js', 'text/javascript']],
  ['/prototype.css', [base + 'prototype.css', 'text/css']],
]);
createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const font = path.match(
    /^\/fonts\/(sans|mono)\/(index\.css|400\.css|files\/[a-z0-9-]+\.woff2?)$/,
  );
  if (font) {
    const folder =
      font[1] === 'sans' ? '@fontsource-variable/instrument-sans' : '@fontsource/fragment-mono';
    response.writeHead(200, { 'Content-Type': path.endsWith('.css') ? 'text/css' : 'font/woff2' });
    response.end(await readFile(new URL(`node_modules/${folder}/${font[2]}`, root)));
    return;
  }
  if (path === '/theme.css') {
    const source = await readFile(new URL('src/styles.css', root), 'utf8');
    response.writeHead(200, { 'Content-Type': 'text/css' });
    const start = source.indexOf(':root {');
    response.end(source.slice(start, source.indexOf('@media (prefers-color-scheme: dark)', start)));
    return;
  }
  const asset = assets.get(path);
  if (!asset) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { 'Content-Type': asset[1] });
  response.end(await readFile(new URL(asset[0], root)));
}).listen(4317, '127.0.0.1', () =>
  console.warn('Throwaway source-control prototype: http://127.0.0.1:4317/?variant=A'),
);
