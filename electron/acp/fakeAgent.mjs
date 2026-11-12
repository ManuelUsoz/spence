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
  .onRequest('session/new', () => {
    sessions += 1;
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
