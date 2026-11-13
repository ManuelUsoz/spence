// A fake ACP Agent for specs: speaks ACP v1 over stdio with scripted replies. Never shipped.
//
// Launch arguments (constants, like a Catalog entry's):
//   --protocol=<n>   answer `initialize` with protocol version n (default 1)
//   --fail-init      write to stderr and exit with code 2 before answering `initialize`
//   --extra-auth     advertise two terminal authMethods (`login`, `api-key`)
//   --login-mode     act as the terminal login process (exits 0 unless FAKE_LOGIN_FAIL=1 or FAKE_LOGIN_HOLD=1)
//   --login-hold     with --login-mode, wait until killed (for Cancel tests)
//   --bare           advertise no optional capabilities (no load, resume, close, delete, image)
//   --no-resume      advertise `session/load` but not `session/resume`
//   --fail-resume    advertise `session/resume` but refuse it
//   --fail-load      advertise `session/load` but refuse it
//
// Each session offers a Model (small, large) and an Effort (low, medium, high: no max), and lists the Commands
// clear, compact and review just after `session/new`.
//
// The prompt text picks the script:
//   "how"       replies how its session was opened: "new", "resumed" or "loaded"
//   "model"     replies the session's Model
//   "crash"     one chunk, then the process exits with code 3
//   "login"     reports that authentication is required
//   "error"     throws JSON-RPC internal error (-32603)
//   "error-dup" streams the error message verbatim then throws JSON-RPC -32603 with the same text
//   "hold"    one chunk ("working"), then waits for `session/cancel` and ends `cancelled`
//   "ask"     a Permission request; after `session/cancel` it reports the outcome it got and ends `cancelled`
//   "work"    a whole Turn's work: a Thought, a Plan, Steps (a read, an edit with a diff, a failed command), a
//             Notice, then a reply; ends `end_turn`
//   "busy"    a Thought, a Plan and a running command, then waits for `session/cancel` and ends `cancelled`
//   "permit"  a Step (`tool_call` "ls -la"), then a Permission request for it; reports the option picked
//             ("permission <optionId>", or "permission cancelled") and ends `end_turn`
//   "mode"    replies with the session's current mode id and ends `end_turn`
//   "echo:<text>" (or anything else) streams the text back in three chunks and ends `end_turn`
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

const args = process.argv.slice(2);
const protocol = Number(
  (args.find((arg) => arg.startsWith('--protocol=')) ?? '--protocol=1').split('=')[1],
);
const failInit = args.includes('--fail-init');
const extraAuth = args.includes('--extra-auth');
const loginMode = args.includes('--login-mode');
const loginHold = args.includes('--login-hold') || process.env.FAKE_LOGIN_HOLD === '1';
const bare = args.includes('--bare');
const noResume = args.includes('--no-resume');
const failResume = args.includes('--fail-resume');
const failLoad = args.includes('--fail-load');

if (loginMode) {
  if (loginHold) {
    process.stderr.write('login waiting\n');
    setInterval(() => {}, 1000);
  } else {
    process.exit(process.env.FAKE_LOGIN_FAIL === '1' ? 1 : 0);
  }
} else if (failInit) {
  process.stderr.write('init failed\n');
  process.exit(2);
}

process.stderr.write(`fake agent ${process.pid} up\n`);

let sessions = 0;
/** Per session: how it was opened. */
const opened = new Map();
/** Per session: its Model, when not the default `small`. */
const models = new Map();
/** Per session: its Effort, when not the default `medium`. */
const efforts = new Map();
/** Per session: its Permission mode, when not the default `ask`. */
const permissions = new Map();

const configOptions = (sessionId) => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: models.get(sessionId) ?? 'small',
    options: [
      { value: 'small', name: 'Small' },
      { value: 'large', name: 'Large' },
    ],
  },
  {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    type: 'select',
    currentValue: efforts.get(sessionId) ?? 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
  {
    id: 'permission',
    name: 'Permission',
    category: 'permission',
    type: 'select',
    currentValue: permissions.get(sessionId) ?? 'ask',
    options: [
      { value: 'ask', name: 'Ask' },
      { value: 'auto', name: 'Auto' },
    ],
  },
];
/** The session modes offered: like Claude's, but without an auto mode of the Agent's own. */
const MODES = [
  { id: 'default', name: 'Always ask' },
  { id: 'acceptEdits', name: 'Accept edits' },
  { id: 'plan', name: 'Plan' },
];
/** Per session: its current mode id. */
const modes = new Map();
/** Per session: resolves when `session/cancel` arrives. */
const cancelled = new Map();
const waitForCancel = (sessionId) =>
  new Promise((resolve) => {
    cancelled.set(sessionId, resolve);
  });

const COMMANDS = [
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'review', description: 'Review the changes', input: { hint: 'what to review' } },
];

const chunk = (sessionId, text) => ({
  sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
});

/** Per session: the folder it runs in, from `session/new`. */
const folders = new Map();

const update = (sessionId, body) => ({ sessionId, update: body });
const thought = (text) => ({
  sessionUpdate: 'agent_thought_chunk',
  content: { type: 'text', text },
});
const plan = (statuses) => ({
  sessionUpdate: 'plan',
  entries: ['Read the view', 'Add the greeting', 'Run the tests', 'Tidy up'].map((content, i) => ({
    content,
    priority: 'medium',
    status: statuses[i] ?? 'pending',
  })),
});

/** The scripted work of `work` and `busy`: each update in order. */
const script = (cwd, busy) => {
  const file = (name) => `${cwd}/${name}`;
  const before = 'export const view = () => {\n  render();\n};\n';
  const after = "export const view = () => {\n  greet('hello');\n  render();\n};\n";
  const common = [
    thought('The user wants a greeting. '),
    thought('I should read the view first, then edit it and run the tests.'),
    plan(['in_progress']),
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'read-1',
      title: 'Read src/view.ts',
      kind: 'read',
      status: 'in_progress',
      locations: [{ path: file('src/view.ts') }],
    },
    { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed' },
    plan(['completed', 'in_progress']),
  ];
  if (busy) {
    return [
      ...common,
      plan(['completed', 'completed', 'in_progress']),
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'run-1',
        title: 'npm test -- --watch=false',
        kind: 'execute',
        status: 'in_progress',
      },
    ];
  }
  return [
    ...common,
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'edit-1',
      title: 'Edit src/view.ts',
      kind: 'edit',
      status: 'in_progress',
      locations: [{ path: file('src/view.ts') }],
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      status: 'completed',
      content: [{ type: 'diff', path: file('src/view.ts'), oldText: before, newText: after }],
    },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'new-1',
      title: 'Write src/greet.ts',
      kind: 'edit',
      status: 'completed',
      content: [
        {
          type: 'diff',
          path: file('src/greet.ts'),
          newText: 'export const greet = (text: string) => text;\n',
        },
      ],
    },
    plan(['completed', 'completed', 'in_progress']),
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'run-1',
      title: 'npm test',
      kind: 'execute',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: '1 failing' } }],
    },
    { sessionUpdate: 'notice', severity: 'warning', title: 'One test still fails' },
    plan(['completed', 'completed', 'completed', 'completed']),
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I added ' } },
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'the greeting to `src/view.ts`.' },
    },
  ];
};

const textOf = (prompt) =>
  prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

const app = acp
  .agent({ name: 'fake-agent' })
  .onRequest('initialize', () => ({
    protocolVersion: protocol,
    agentInfo: { name: 'fake-agent', version: '0.0.0' },
    authMethods: extraAuth
      ? [
          {
            type: 'terminal',
            id: 'login',
            name: 'Log in with Browser',
            description: 'Open browser to log in',
            args: ['--login-mode'],
          },
          {
            type: 'terminal',
            id: 'api-key',
            name: 'API Key',
            description: 'Use an API key',
            args: ['--login-key'],
          },
        ]
      : [{ id: 'login', name: 'Log in' }],
    agentCapabilities: bare
      ? {}
      : {
          loadSession: true,
          promptCapabilities: { image: true },
          sessionCapabilities: {
            ...(noResume ? {} : { resume: {} }),
            close: {},
            delete: {},
          },
        },
  }))
  .onRequest('session/new', ({ client, params }) => {
    sessions += 1;
    const sessionId = `fake-${sessions}`;
    opened.set(sessionId, 'new');
    folders.set(sessionId, params.cwd);
    // Like real Agents, the Commands follow the session's creation.
    setTimeout(() => {
      void client.notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS },
      });
    }, 0);
    modes.set(sessionId, 'default');
    return {
      sessionId,
      modes: { currentModeId: 'default', availableModes: MODES },
      configOptions: configOptions(sessionId),
    };
  })
  .onRequest('session/load', async ({ params, client }) => {
    if (failLoad) throw acp.RequestError.internalError(undefined, 'no such session');
    opened.set(params.sessionId, 'loaded');
    // The conversation so far, replayed before the answer.
    await client.notify('session/update', {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed' } },
    });
    await client.notify('session/update', chunk(params.sessionId, 'replayed'));
    return {
      modes: { currentModeId: modes.get(params.sessionId) ?? 'default', availableModes: MODES },
      configOptions: configOptions(params.sessionId),
    };
  })
  .onRequest('session/resume', ({ params }) => {
    if (failResume) throw acp.RequestError.internalError(undefined, 'no such session');
    opened.set(params.sessionId, 'resumed');
    return {
      modes: { currentModeId: modes.get(params.sessionId) ?? 'default', availableModes: MODES },
      configOptions: configOptions(params.sessionId),
    };
  })
  .onRequest('session/close', () => ({}))
  .onRequest('session/delete', () => ({}))
  .onRequest('session/set_config_option', ({ params }) => {
    if (params.configId === 'model') models.set(params.sessionId, params.value);
    else if (params.configId === 'effort') efforts.set(params.sessionId, params.value);
    else if (params.configId === 'permission') permissions.set(params.sessionId, params.value);
    return {
      modes: { currentModeId: modes.get(params.sessionId) ?? 'default', availableModes: MODES },
      configOptions: configOptions(params.sessionId),
    };
  })
  .onRequest('session/set_mode', ({ params }) => {
    modes.set(params.sessionId, params.modeId);
    return {};
  })
  .onNotification('session/cancel', ({ params }) => {
    cancelled.get(params.sessionId)?.();
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const text = textOf(params.prompt);
    const { sessionId } = params;
    if (text === 'login') throw acp.RequestError.authRequired();
    if (text === 'error') throw new acp.RequestError(-32603, 'API Error: overloaded');
    if (text === 'error-dup') {
      await client.notify('session/update', chunk(sessionId, 'API Error: overloaded'));
      throw new acp.RequestError(-32603, 'API Error: overloaded');
    }
    if (text === 'crash') {
      await client.notify('session/update', chunk(sessionId, 'about to crash'));
      process.exit(3);
    }
    if (text === 'hold') {
      const cancel = waitForCancel(sessionId);
      await client.notify('session/update', chunk(sessionId, 'working'));
      await cancel;
      return { stopReason: 'cancelled' };
    }
    if (text === 'work' || text === 'busy') {
      const busy = text === 'busy';
      const cancel = busy ? waitForCancel(sessionId) : undefined;
      for (const body of script(folders.get(sessionId) ?? process.cwd(), busy)) {
        await client.notify('session/update', update(sessionId, body));
      }
      if (cancel === undefined) return { stopReason: 'end_turn' };
      await cancel;
      return { stopReason: 'cancelled' };
    }
    if (text === 'ask') {
      const cancel = waitForCancel(sessionId);
      const answer = client.request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'call-1', title: 'Run ls', kind: 'execute' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      });
      await cancel;
      const { outcome } = await answer;
      await client.notify('session/update', chunk(sessionId, `permission ${outcome.outcome}`));
      return { stopReason: 'cancelled' };
    }
    if (text === 'how') {
      await client.notify('session/update', chunk(sessionId, opened.get(sessionId) ?? 'unknown'));
      return { stopReason: 'end_turn' };
    }
    if (text === 'model') {
      await client.notify('session/update', chunk(sessionId, models.get(sessionId) ?? 'small'));
      return { stopReason: 'end_turn' };
    }
    if (text === 'permit') {
      await client.notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'ls -la',
          kind: 'execute',
          status: 'pending',
        },
      });
      const { outcome } = await client.request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'call-1', title: 'ls -la', kind: 'execute' },
        options: [
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        ],
      });
      const picked = outcome.outcome === 'selected' ? outcome.optionId : 'cancelled';
      await client.notify('session/update', chunk(sessionId, `permission ${picked}`));
      return { stopReason: 'end_turn' };
    }
    if (text === 'mode') {
      await client.notify('session/update', chunk(sessionId, modes.get(sessionId) ?? 'none'));
      return { stopReason: 'end_turn' };
    }
    const reply = text.startsWith('echo:') ? text.slice('echo:'.length) : text;
    const third = Math.ceil(reply.length / 3);
    for (const part of [
      reply.slice(0, third),
      reply.slice(third, 2 * third),
      reply.slice(2 * third),
    ]) {
      await client.notify('session/update', chunk(sessionId, part));
    }
    return { stopReason: 'end_turn' };
  });

const connection = app.connect(
  acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
// Closing stdin is how a client says goodbye.
await connection.closed;
process.exit(0);
