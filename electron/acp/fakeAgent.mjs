// A fake ACP Agent for specs: speaks ACP v1 over stdio with scripted replies. Never shipped.
//
// Launch arguments (constants, like a Catalog entry's):
//   --protocol=<n>   answer `initialize` with protocol version n (default 1)
//   --bare           advertise no optional capabilities (no load, resume, close, delete, image)
//
// The prompt text picks the script:
//   "crash"   one chunk, then the process exits with code 3
//   "hold"    one chunk ("working"), then waits for `session/cancel` and ends `cancelled`
//   "ask"     a Permission request; after `session/cancel` it reports the outcome it got and ends `cancelled`
//   "work"    a whole Turn's work: a Thought, a Plan, Steps (a read, an edit with a diff, a failed command), a
//             Notice, then a reply; ends `end_turn`
//   "busy"    a Thought, a Plan and a running command, then waits for `session/cancel` and ends `cancelled`
//   "echo:<text>" (or anything else) streams the text back in three chunks and ends `end_turn`
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

const args = process.argv.slice(2);
const protocol = Number(
  (args.find((arg) => arg.startsWith('--protocol=')) ?? '--protocol=1').split('=')[1],
);
const bare = args.includes('--bare');

process.stderr.write(`fake agent ${process.pid} up\n`);

let sessions = 0;
/** Per session: resolves when `session/cancel` arrives. */
const cancelled = new Map();
const waitForCancel = (sessionId) =>
  new Promise((resolve) => {
    cancelled.set(sessionId, resolve);
  });

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
    authMethods: [{ id: 'login', name: 'Log in' }],
    agentCapabilities: bare
      ? {}
      : {
          loadSession: true,
          promptCapabilities: { image: true },
          sessionCapabilities: { resume: {}, close: {}, delete: {} },
        },
  }))
  .onRequest('session/new', ({ params }) => {
    sessions += 1;
    folders.set(`fake-${sessions}`, params.cwd);
    return {
      sessionId: `fake-${sessions}`,
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'small',
          options: [
            { value: 'small', name: 'Small' },
            { value: 'large', name: 'Large' },
          ],
        },
      ],
    };
  })
  .onRequest('session/load', async ({ params, client }) => {
    await client.notify('session/update', {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed' } },
    });
    return {};
  })
  .onRequest('session/resume', () => ({}))
  .onRequest('session/close', () => ({}))
  .onRequest('session/delete', () => ({}))
  .onRequest('session/set_config_option', ({ params }) => ({
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: params.value,
        options: [
          { value: 'small', name: 'Small' },
          { value: 'large', name: 'Large' },
        ],
      },
    ],
  }))
  .onNotification('session/cancel', ({ params }) => {
    cancelled.get(params.sessionId)?.();
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const text = textOf(params.prompt);
    const { sessionId } = params;
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
