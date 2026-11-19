import { Effect, Schema } from 'effect';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

/** The reasons a tool call fails in a way the Agent can read and act on. */
export const ToolErrorReason = Schema.Literals([
  'BadRequest',
  'Internal',
  'NotActive',
  'RequestIdConflict',
  'NotReachable',
  'InvalidTarget',
  'PermissionDenied',
  'RateLimited',
  'HopLimit',
  'DeliveryFailed',
  'WorkerFailed',
  'WorkerCancelled',
  'DepthLimit',
  'WorkerLimit',
  // A cross-device send the target Device refused, or could not be reached for.
  'Offline',
  'Busy',
  'NotFound',
  'Forbidden',
  'Loop',
  'Unavailable',
]).annotate({ identifier: 'ToolErrorReason' });
export type ToolErrorReason = typeof ToolErrorReason.Type;

/** What a tool call returns to the Agent; `isError` marks a structured failure the Agent can read. */
export interface ToolOutcome {
  readonly text: string;
  readonly isError?: boolean;
}

/** A structured failure: the Agent reads `{ error: { reason, detail } }` and can retry or change course. */
export const toolError = (reason: ToolErrorReason, detail: string): ToolOutcome => ({
  isError: true,
  text: JSON.stringify({ error: { reason, detail } }),
});

export interface SendMessageInput {
  readonly to: string;
  readonly text: string;
  readonly needsUser: boolean;
}

export interface ListSessionsInput {
  /** Another Project whose Sessions to list; needs the user's permission for that Project pair. */
  readonly projectId?: string;
}

export interface StartSessionInput {
  /** A project handle from `list_targets`. */
  readonly project: string;
  readonly text: string;
}

export interface AwaitResultInput {
  /** A handle from `send_message` to another Device, or from `start_session`. */
  readonly handle: string;
  readonly timeoutSeconds: number;
}

/** The longest `await_result` waits before it answers Pending. */
export const MAX_AWAIT_SECONDS = 300;
const DEFAULT_AWAIT_SECONDS = 60;

/** What one registration (one credential, one parent Session and live context) can do. */
export interface DelegationTools {
  readonly delegate: (task: string) => Promise<ToolOutcome>;
  readonly listSessions: (input: ListSessionsInput) => Promise<ToolOutcome>;
  readonly sendMessage: (input: SendMessageInput) => Promise<ToolOutcome>;
  readonly listTargets: () => Promise<ToolOutcome>;
  readonly startSession: (input: StartSessionInput) => Promise<ToolOutcome>;
  readonly awaitResult: (input: AwaitResultInput) => Promise<ToolOutcome>;
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
            run: (tools) => tools.delegate(task),
          }
        : undefined;
    },
  },
  {
    name: 'list_sessions',
    description:
      'List the other Spence Sessions in your delegation tree that you can message: id, title, state and relation (parent, ancestor, child, descendant, sibling or relative). Also lists the other Projects (id, name, allowed). Pass projectId to list the Sessions of another Project: the user is asked to allow it the first time.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'A project id from list_sessions' } },
    },
    prepare: (args) => {
      const { projectId } = args;
      if (projectId !== undefined && typeof projectId !== 'string') return undefined;
      const input: ListSessionsInput = projectId === undefined ? {} : { projectId };
      return { fingerprint: JSON.stringify(input), run: (tools) => tools.listSessions(input) };
    },
  },
  {
    name: 'send_message',
    description:
      'Send a message to another Session in your delegation tree (a Parent, a Worker, a sibling) or, with user permission for that Project pair, to a Session of another Project. It is queued if the Session is busy and starts a Turn if it is idle. Set needsUser when the user must answer: send it to your Parent, who surfaces it to the user. Pass a session handle from list_targets to message a Session on another Device instead: the user may be asked first, a busy Session refuses it, and the answer holds a handle for await_result. Reuse requestId when retrying the same message.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'A session id from list_sessions, or a session handle from list_targets',
        },
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
  {
    name: 'list_targets',
    description:
      'List the other Devices paired with this one and, for each online Device, its Projects and Sessions you can reach, by opaque handle. Pass a session handle to send_message, or a project handle to start_session.',
    inputSchema: { type: 'object', properties: {} },
    prepare: () => ({ fingerprint: '{}', run: (tools) => tools.listTargets() }),
  },
  {
    name: 'start_session',
    description:
      'Start a new Session in a Project on another Device with a first message. The user may be asked first; the new Session runs under that Device’s own default Permission mode. The answer holds a session handle for send_message and a handle for await_result. Reuse requestId when retrying the same start.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'A project handle from list_targets' },
        text: { type: 'string' },
        requestId: retryKeyProperty,
      },
      required: ['project', 'text'],
    },
    prepare: (args) => {
      const { project, text } = args;
      if (typeof project !== 'string' || typeof text !== 'string' || text.length === 0)
        return undefined;
      const input: StartSessionInput = { project, text };
      return { fingerprint: JSON.stringify(input), run: (tools) => tools.startSession(input) };
    },
  },
  {
    name: 'await_result',
    description: `Wait for the outcome of the Turn a message to another Device (or a started Session) began: its outcome and final message text, or pending if it has not ended within timeoutSeconds (default ${DEFAULT_AWAIT_SECONDS}, at most ${MAX_AWAIT_SECONDS}). Call it again to keep waiting.`,
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'A handle from send_message or start_session' },
        timeoutSeconds: { type: 'number', minimum: 0, maximum: MAX_AWAIT_SECONDS },
      },
      required: ['handle'],
    },
    prepare: (args) => {
      const { handle, timeoutSeconds } = args;
      if (
        typeof handle !== 'string' ||
        (timeoutSeconds !== undefined &&
          (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds)))
      )
        return undefined;
      const input: AwaitResultInput = {
        handle,
        timeoutSeconds: Math.min(
          Math.max(timeoutSeconds ?? DEFAULT_AWAIT_SECONDS, 0),
          MAX_AWAIT_SECONDS,
        ),
      };
      return { fingerprint: JSON.stringify(input), run: (tools) => tools.awaitResult(input) };
    },
  },
];

const record = (value: unknown): Args | undefined =>
  typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : undefined;

/**
 * A loopback MCP endpoint; each registration is a separately revocable capability.
 *
 * The HTTP edge is raw `node:http` bridged to Promises on purpose: MCP over Streamable HTTP needs only a POST that
 * answers one JSON-RPC message, the agent connects from another process (so it cannot be an Electron IPC or RPC
 * endpoint), and a framework or SDK would add a dependency to main for about a hundred lines. Everything past the
 * parse (credential, retry keys, tools) is ordinary domain code in `Sessions`.
 */
export const makeDelegationServer = Effect.gen(function* () {
  /**
   * Retry keys, per scope (one parent Session and its active context). They outlive a registration, so a retry
   * after a reconnect or reload (a new credential for the same context) still finds its earlier work. Only
   * successes are kept: a failed or rejected call is retryable.
   */
  const requestsByScope = new Map<
    string,
    Map<string, { readonly fingerprint: string; readonly result: Promise<ToolOutcome> }>
  >();
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
          const malformed = error instanceof SyntaxError;
          response.writeHead(malformed ? 400 : 500, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              error: { reason: malformed ? 'BadRequest' : 'Internal', detail: String(error) },
            }),
          );
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
    /** Forgets the retry keys of every scope that starts with `prefix` (a deleted Session). */
    forget: (prefix: string) => {
      for (const scope of [...requestsByScope.keys()])
        if (scope.startsWith(prefix)) requestsByScope.delete(scope);
    },
    /** `scope` names the parent Session and its current context, so retry keys survive re-registration. */
    register: (tools: DelegationTools, scope: () => string) => {
      const token = randomBytes(32).toString('hex');
      handlers.set(token, async (name, args) => {
        const call = toolSpecs.find((spec) => spec.name === name)?.prepare(args);
        if (call === undefined) return undefined;
        const requestId = args['requestId'];
        if (typeof requestId !== 'string') return call.run(tools);
        const key = `${name}:${requestId}`;
        const current = scope();
        const requests = requestsByScope.get(current) ?? new Map();
        requestsByScope.set(current, requests);
        const previous = requests.get(key);
        if (previous !== undefined) {
          return previous.fingerprint === call.fingerprint
            ? previous.result
            : toolError('RequestIdConflict', 'This requestId was already used for different input');
        }
        const result = call.run(tools);
        const entry = { fingerprint: call.fingerprint, result };
        requests.set(key, entry);
        const forgetUnlessDone = () => {
          if (requests.get(key) === entry) requests.delete(key);
        };
        result.then((outcome) => {
          if (outcome.isError === true) forgetUnlessDone();
        }, forgetUnlessDone);
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
