import { Effect, Schema } from 'effect';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  FeedbackCategory,
  FeedbackLatency,
  FeedbackSeverity,
  parseReportFeedback,
  type ReportFeedbackInput,
} from '../feedback/feedback';

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
  readonly requestId?: string;
}

export interface ListSessionsInput {
  /** Another Project whose Sessions to list; needs the user's permission for that Project pair. */
  readonly projectId?: string;
}

export interface StartSessionInput {
  /** A project handle from `list_targets`. */
  readonly project: string;
  readonly text: string;
  readonly requestId?: string;
}

export interface NeedsUserInput {
  /** What the Worker needs from the user. */
  readonly reason: string;
  readonly requestId?: string;
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
  readonly reportFeedback: (input: ReportFeedbackInput) => Promise<ToolOutcome>;
  readonly needsUser: (input: NeedsUserInput) => Promise<ToolOutcome>;
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
  /** A cross-device tool: offered only to an Agent that can carry them (`AgentCapabilities.crossDeviceTools`). */
  readonly crossDevice?: true;
  /** What the description adds when the cross-device tools are offered too. */
  readonly crossDeviceNote?: string;
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
      'Start a Spence Worker asynchronously on a task and return immediately. Do not poll list_sessions or await_result; end your turn and stand idle—Spence delivers the Worker response to you automatically as a message when it finishes. Reuse requestId when retrying the same task.',
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
      'List writable Spence Sessions in the current Project and discover local Projects by id and name. Pass projectId to list Sessions in a particular Project.',
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
      'Send a message to a writable Session. It is queued if the Session is busy and starts a Turn if it is idle. Cross-Project contact follows your Permission mode. Set needsUser when the user must answer: send it to your Parent, who surfaces it to the user. The result handle identifies the Turn this Message starts. Reuse requestId when retrying the same message.',
    crossDeviceNote:
      ' Pass a session handle from list_targets to message a Session on another Device instead: the user may be asked first, a busy Session refuses it, and the answer holds a handle for await_result.',
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
      const { to, text, needsUser, requestId } = args;
      if (
        typeof to !== 'string' ||
        typeof text !== 'string' ||
        text.length === 0 ||
        (needsUser !== undefined && typeof needsUser !== 'boolean')
      )
        return undefined;
      const input: SendMessageInput = {
        to,
        text,
        needsUser: needsUser === true,
        ...(typeof requestId === 'string' ? { requestId } : {}),
      };
      return {
        fingerprint: JSON.stringify(input),
        run: (tools) => tools.sendMessage(input),
      };
    },
  },
  {
    name: 'list_targets',
    crossDevice: true,
    description:
      'List the other Devices paired with this one and, for each online Device, its Projects and Sessions you can reach, by opaque handle. Pass a session handle to send_message, or a project handle to start_session.',
    inputSchema: { type: 'object', properties: {} },
    prepare: () => ({ fingerprint: '{}', run: (tools) => tools.listTargets() }),
  },
  {
    name: 'start_session',
    description:
      'Start a regular Session in a local Project with its first message. The new Session uses the destination Project defaults. The answer contains a Session id and a handle for await_result. Reuse requestId when retrying the same start.',
    crossDeviceNote: ' A project handle from list_targets starts a Session on a paired Device.',
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
      const { project, text, requestId } = args;
      if (typeof project !== 'string' || typeof text !== 'string' || text.length === 0)
        return undefined;
      const input: StartSessionInput = {
        project,
        text,
        ...(typeof requestId === 'string' ? { requestId } : {}),
      };
      return { fingerprint: JSON.stringify(input), run: (tools) => tools.startSession(input) };
    },
  },
  {
    name: 'await_result',
    description: `Wait for the outcome and final reply of the Turn started by send_message or start_session (not for delegate, which delivers automatically when you stand idle). Returns pending if the Turn has not ended within timeoutSeconds (default ${DEFAULT_AWAIT_SECONDS}, at most ${MAX_AWAIT_SECONDS}).`,
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
  {
    name: 'report_feedback',
    description:
      'Record feedback, bugs, workflow friction, or suggestions locally on the machine running Spence so the user can inspect the saved feedback file. For a tool that felt slow or expensive in tokens, set tool, latency and suggestion: they are what makes the report actionable. Reuse requestId when retrying the same report.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1, description: 'Concise summary of the feedback' },
        details: { type: 'string', description: 'Optional detailed context or reproduction notes' },
        category: {
          type: 'string',
          enum: FeedbackCategory.literals,
          description: 'Feedback category (default: other)',
        },
        severity: {
          type: 'string',
          enum: FeedbackSeverity.literals,
          description: 'Impact severity (default: medium)',
        },
        tool: {
          type: 'string',
          description: 'Tool this report is about, by MCP name (e.g. "snapshot").',
        },
        latency: {
          type: 'string',
          enum: FeedbackLatency.literals,
          description: 'How slow the tool felt while you used it.',
        },
        suggestion: {
          type: 'string',
          description:
            'The concrete change that would have made the tool faster or cheaper in tokens.',
        },
        requestId: retryKeyProperty,
      },
      required: ['summary'],
    },
    prepare: (args) => {
      const input = parseReportFeedback(args);
      if (input === undefined) return undefined;
      return { fingerprint: JSON.stringify(input), run: (tools) => tools.reportFeedback(input) };
    },
  },
  {
    name: 'needs_user',
    description:
      "Call this when you are a Worker that cannot finish without the user: missing information, a credential, a decision or a manual step. State exactly what you need in reason. Spence raises the user's attention on your Parent Session and relays the reason; then end your turn and stand idle. Do not use it for a permission request, which the user already sees. Reuse requestId when retrying the same call.",
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          minLength: 1,
          description: 'What you need from the user, concretely',
        },
        requestId: retryKeyProperty,
      },
      required: ['reason'],
    },
    prepare: (args) => {
      const { reason, requestId } = args;
      if (typeof reason !== 'string' || reason.trim().length === 0 || !validRetryKey(args))
        return undefined;
      const input: NeedsUserInput = {
        reason: reason.trim(),
        ...(typeof requestId === 'string' ? { requestId } : {}),
      };
      return { fingerprint: JSON.stringify(input), run: (tools) => tools.needsUser(input) };
    },
  },
];

/** Every tool the Spence MCP endpoint offers an Agent, by name. */
export const SPENCE_TOOL_NAMES: ReadonlyArray<string> = toolSpecs.map((spec) => spec.name);

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
    {
      readonly tools: ReadonlyArray<Readonly<Record<string, unknown>>>;
      readonly call: (name: string, args: Args) => Promise<ToolOutcome | undefined>;
    }
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
          else if (message['method'] === 'tools/list') result = { tools: handler.tools };
          else if (message['method'] === 'tools/call') {
            const params = record(message['params']);
            const args = record(params?.['arguments'] ?? {});
            const name = params?.['name'];
            if (args === undefined || typeof name !== 'string' || !validRetryKey(args)) {
              response.writeHead(400).end();
              return;
            }
            const outcome = await handler.call(name, args);
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
    /**
     * `scope` names the parent Session and its current context, so retry keys survive re-registration. Without
     * `crossDevice` the Agent is neither offered nor served the cross-device tools.
     */
    register: (
      tools: DelegationTools,
      scope: () => string,
      options: { readonly crossDevice: boolean } = { crossDevice: true },
    ) => {
      const token = randomBytes(32).toString('hex');
      const offered = toolSpecs.filter((spec) => options.crossDevice || spec.crossDevice !== true);
      const listed = offered.map(({ name, description, crossDeviceNote, inputSchema }) => ({
        name,
        description: options.crossDevice ? description + (crossDeviceNote ?? '') : description,
        inputSchema,
      }));
      handlers.set(token, {
        tools: listed,
        call: async (name, args) => {
          const call = offered.find((spec) => spec.name === name)?.prepare(args);
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
              : toolError(
                  'RequestIdConflict',
                  'This requestId was already used for different input',
                );
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
        },
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
