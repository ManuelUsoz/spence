// Throwaway preview server for the Issues design decision.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const file = new URL('../src/app/features/session/issues-prototype/index.html', import.meta.url);
createServer(async (_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(await readFile(file));
}).listen(4319, '127.0.0.1', () =>
  process.stdout.write('Issues prototype: http://127.0.0.1:4319/?variant=A\n'),
);
