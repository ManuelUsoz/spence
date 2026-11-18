import { Effect } from 'effect';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

/** What a tool call returns to the Agent; `isError` marks a structured failure the Agent can read. */
export interface ToolOutcome {
  readonly text: string;
  readonly isError?: boolean;
}

export interface SendMessageInput {
  readonly to: string;
  readonly text: string;
  readonly needsUser: boolean;
}

/** What one registration (one credential, one parent Session and live context) can do. */
export interface DelegationTools {
  readonly delegate: (task: string) => Promise<string>;
  readonly listSessions: () => Promise<ToolOutcome>;
  readonly sendMessage: (input: SendMessageInput) => Promise<ToolOutcome>;
}

type Args = Readonly<Record<string, unknown>>;

/** A validated call: its input fingerprint (for retry keys) and how to run it. */
interface PreparedCall {
  readonly fingerprint: string;
  readonly run: (tools: DelegationTools) => Promise<ToolOutcome>;
}

interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** The prepared call, or `undefined` when the arguments are malformed. */
  readonly prepare: (args: Args) => PreparedCall | undefined;
}

const retryKeyProperty = { type: 'string', minLength: 1, maxLength: 200 } as const;

const validRetryKey = (args: Args): boolean =>
  !('requestId' in args) ||
  (typeof args['requestId'] === 'string' &&
    args['requestId'].length > 0 &&
    args['requestId'].length <= 200);

const toolSpecs: ReadonlyArray<ToolSpec> = [
  {
    name: 'delegate',
    description:
      'Delegate a task to a Spence Worker and receive its result. Reuse requestId when retrying the same task.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string' }, requestId: retryKeyProperty },
      required: ['task'],
    },
    prepare: (args) => {
      const task = args['task'];
      return typeof task === 'string'
        ? {
            fingerprint: task,
            run: async (tools) => ({ text: await tools.delegate(task) }),
          }
        : undefined;
    },
  },
  {
    name: 'list_sessions',
    description:
      'List the other Spence Sessions in your delegation tree that you can message: id, title, state and relation (parent, ancestor, child, descendant, sibling or relative).',
    inputSchema: { type: 'object', properties: {} },
    prepare: () => ({ fingerprint: '', run: (tools) => tools.listSessions() }),
  },
  {
    name: 'send_message',
    description:
      'Send a message to another Session in your delegation tree (a Parent, a Worker, a sibling). It is queued if the Session is busy and starts a Turn if it is idle. Set needsUser when the user must answer: send it to your Parent, who surfaces it to the user. Reuse requestId when retrying the same message.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'A session id from list_sessions' },
        text: { type: 'string' },
        needsUser: { type: 'boolean' },
        requestId: retryKeyProperty,
      },
      required: ['to', 'text'],
    },
    prepare: (args) => {
      const { to, text, needsUser } = args;
      if (
        typeof to !== 'string' ||
        typeof text !== 'string' ||
        text.length === 0 ||
        (needsUser !== undefined && typeof needsUser !== 'boolean')
      )
        return undefined;
      const input: SendMessageInput = { to, text, needsUser: needsUser === true };
      return {
        fingerprint: JSON.stringify(input),
        run: (tools) => tools.sendMessage(input),
      };
    },
  },
];

const record = (value: unknown): Args | undefined =>
  typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : undefined;

/** A loopback MCP endpoint; each registration is a separately revocable capability. */
export const makeDelegationServer = Effect.gen(function* () {
  const handlers = new Map<
    string,
    (name: string, args: Args) => Promise<ToolOutcome | undefined>
  >();
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
          const message = record(JSON.parse(body));
          if (message === undefined || !('method' in message)) {
            response.writeHead(400).end();
            return;
          }
          const id = message['id'];
          if (id === undefined) {
            response.writeHead(202).end();
            return;
          }
          let result: unknown;
          if (message['method'] === 'initialize')
            result = {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'spence', version: '1.0.0' },
            };
          else if (message['method'] === 'tools/list')
            result = {
              tools: toolSpecs.map(({ name, description, inputSchema }) => ({
                name,
                description,
                inputSchema,
              })),
            };
          else if (message['method'] === 'tools/call') {
            const params = record(message['params']);
            const args = record(params?.['arguments'] ?? {});
            const name = params?.['name'];
            if (args === undefined || typeof name !== 'string' || !validRetryKey(args)) {
              response.writeHead(400).end();
              return;
            }
            const outcome = await handler(name, args);
            if (outcome === undefined) {
              response.writeHead(400).end();
              return;
            }
            if (handlers.get(token ?? '') !== handler) {
              response.writeHead(403).end();
              return;
            }
            result = {
              content: [{ type: 'text', text: outcome.text }],
              ...(outcome.isError === true ? { isError: true } : {}),
            };
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
    register: (tools: DelegationTools) => {
      const token = randomBytes(32).toString('hex');
      /** Retry keys are scoped to this registration, so to one parent Session and live context. */
      const requests = new Map<
        string,
        { readonly fingerprint: string; readonly result: Promise<ToolOutcome> }
      >();
      handlers.set(token, async (name, args) => {
        const call = toolSpecs.find((spec) => spec.name === name)?.prepare(args);
        if (call === undefined) return undefined;
        const requestId = args['requestId'];
        if (typeof requestId !== 'string') return call.run(tools);
        const key = `${name}:${requestId}`;
        const previous = requests.get(key);
        if (previous !== undefined) {
          return previous.fingerprint === call.fingerprint
            ? previous.result
            : {
                isError: true,
                text: JSON.stringify({
                  error: {
                    reason: 'RequestIdConflict',
                    detail: 'This requestId was already used for different input',
                  },
                }),
              };
        }
        const result = call.run(tools);
        requests.set(key, { fingerprint: call.fingerprint, result });
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
