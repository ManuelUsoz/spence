// Manual live provider probe. Pass an absolute path to agy.exe; not a CI test.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const binary = process.argv[2];
if (!binary) throw new Error('Pass the absolute path to agy.exe');
const agent = spawn(binary, ['acp'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let id = 0;
let parentText = '';
let announcements = 0;
let invokeObserved = false;
const timeout = setTimeout(() => {
  console.error('Probe timed out');
  agent.kill();
  process.exit(1);
}, 120_000);
function request(method, params) {
  const requestId = ++id;
  agent.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  return new Promise((resolve) => pending.set(requestId, resolve));
}
createInterface({ input: agent.stdout }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method && message.id !== undefined) {
    agent.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } })}\n`,
    );
  } else if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  } else if (message.method === 'session/update') {
    const update = message.params.update;
    if (update.sessionUpdate === 'subagent_update') announcements++;
    if (update.sessionUpdate === 'tool_call' && update.name === 'invoke_subagent')
      invokeObserved = true;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text')
      parentText += update.content.text;
  }
});
agent.on('error', (error) => {
  console.error(error.message);
  clearTimeout(timeout);
  process.exit(1);
});
const init = await request('initialize', {
  protocolVersion: 1,
  clientInfo: { name: 'spence', version: '0.0.0' },
  clientCapabilities: { subagents: {} },
});
const session = await request('session/new', { cwd: process.cwd(), mcpServers: [] });
if (!session.result?.sessionId) {
  console.error(JSON.stringify({ initialize: init.result, sessionError: session.error }));
  clearTimeout(timeout);
  agent.kill();
  process.exit(1);
}
const parent = await request('session/prompt', {
  sessionId: session.result.sessionId,
  prompt: [
    {
      type: 'text',
      text: 'Call invoke_subagent to start a research subagent in the inherited workspace. Ask it to read AGENTS.md and reply CHILD_INITIAL_MARKER. Do not modify files. Wait for its result.',
    },
  ],
});
const child = parentText.match(/conversation:\/\/([a-zA-Z0-9-]+)/)?.[1];
const direct = child
  ? await request('session/prompt', {
      sessionId: child,
      prompt: [{ type: 'text', text: 'Reply with CHILD_DIRECT_IDLE_MARKER.' }],
    })
  : undefined;
console.log(
  JSON.stringify(
    {
      protocolVersion: init.result?.protocolVersion,
      agentInfo: init.result?.agentInfo,
      subagents: init.result?.agentCapabilities?.sessionCapabilities?.subagents ?? null,
      invokeObserved,
      announcements,
      linkedConversation: Boolean(child),
      parentReportedMarker: parentText.includes('CHILD_INITIAL_MARKER'),
      parentStopReason: parent.result?.stopReason,
      parentError: parent.error,
      directResult: direct?.result,
      directError: direct?.error
        ? {
            code: direct.error.code,
            message: direct.error.message.replace(child ?? '', '<conversation-id>'),
          }
        : undefined,
    },
    null,
    2,
  ),
);
clearTimeout(timeout);
agent.kill();
