import { Effect } from 'effect';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

/** A loopback MCP endpoint; each registration is a separately revocable capability. */
export const makeDelegationServer = Effect.gen(function* () {
  const handlers = new Map<string, (task: string, requestId: string) => Promise<string>>();
  const server = createServer((request, response) => {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    const handler = token === undefined ? undefined : handlers.get(token);
    if (handler === undefined || request.method !== 'POST') {
      response.writeHead(403).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 100_000) request.destroy();
    });
    request.on('end', () => {
      void (async () => {
        try {
          const message: unknown = JSON.parse(body);
          if (typeof message !== 'object' || message === null || !('method' in message)) {
            response.writeHead(400).end();
            return;
          }
          const id = 'id' in message ? message.id : undefined;
          if (id === undefined) {
            response.writeHead(202).end();
            return;
          }
          let result: unknown;
          if (message.method === 'initialize')
            result = {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'spence', version: '1.0.0' },
            };
          else if (message.method === 'tools/list')
            result = {
              tools: [
                {
                  name: 'delegate',
                  description:
                    'Delegate a task to a Spence Worker and receive its result. Reuse requestId when retrying the same task.',
                  inputSchema: {
                    type: 'object',
                    properties: { task: { type: 'string' }, requestId: { type: 'string' } },
                    required: ['task', 'requestId'],
                  },
                },
              ],
            };
          else if (
            message.method === 'tools/call' &&
            'params' in message &&
            typeof message.params === 'object' &&
            message.params !== null &&
            'name' in message.params &&
            message.params.name === 'delegate' &&
            'arguments' in message.params &&
            typeof message.params.arguments === 'object' &&
            message.params.arguments !== null &&
            'task' in message.params.arguments &&
            typeof message.params.arguments.task === 'string' &&
            'requestId' in message.params.arguments &&
            typeof message.params.arguments.requestId === 'string' &&
            message.params.arguments.requestId.length > 0 &&
            message.params.arguments.requestId.length <= 200
          ) {
            const value = await handler(
              message.params.arguments.task,
              message.params.arguments.requestId,
            );
            if (handlers.get(token ?? '') !== handler) {
              response.writeHead(403).end();
              return;
            }
            result = { content: [{ type: 'text', text: value }] };
          } else {
            response.writeHead(400).end();
            return;
          }
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', id, result }));
        } catch (error) {
          response
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: String(error) }));
        }
      })();
    });
  });
  yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
          });
        }),
    ),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
  );
  const address = server.address();
  if (address === null || typeof address === 'string')
    return yield* Effect.die('No delegation server address');
  return {
    register: (handler: (task: string) => Promise<string>) => {
      const token = randomBytes(32).toString('hex');
      const requests = new Map<
        string,
        { readonly task: string; readonly result: Promise<string> }
      >();
      handlers.set(token, (task, requestId) => {
        const previous = requests.get(requestId);
        if (previous !== undefined) {
          return previous.task === task
            ? previous.result
            : Promise.reject('Request ID reused for a different task');
        }
        const result = handler(task);
        requests.set(requestId, { task, result });
        return result;
      });
      return {
        server: {
          type: 'http' as const,
          name: 'spence',
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
        },
        revoke: () => {
          handlers.delete(token);
        },
      };
    },
  };
});
