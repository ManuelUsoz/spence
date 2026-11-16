// Manual live qualification only. Pass the pinned codex-acp dist/index.js as argv[2].
// This starts a real provider turn; it does not belong in CI.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const adapter = process.argv[2];
if (!adapter) throw new Error('Pass the path to codex-acp/dist/index.js');
const processHandle = spawn(process.execPath, [adapter], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let nextId = 0;
let childId;
let activeResult;
let idleResult;
let parentResult;
let childText = '';
const timeout = setTimeout(() => finish('Timed out'), 120_000);

function request(method, params) {
  const id = ++nextId;
  processHandle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}
function finish(error) {
  clearTimeout(timeout);
  processHandle.kill();
  if (error) console.error(error);
  console.log(
    JSON.stringify(
      { childAnnounced: Boolean(childId), childText, activeResult, idleResult, parentResult },
      null,
      2,
    ),
  );
  process.exitCode = error ? 1 : 0;
}
function promptChild(phase) {
  return request('session/prompt', {
    sessionId: childId,
    prompt: [{ type: 'text', text: `Reply with exactly CHILD_DIRECT_${phase}_MARKER.` }],
  }).then(({ result, error }) => ({ result, error }));
}
createInterface({ input: processHandle.stdout }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method && message.id !== undefined) {
    processHandle.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } })}\n`,
    );
  } else if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  } else if (message.method === 'session/update') {
    const { sessionId, update } = message.params;
    if (update.sessionUpdate === 'subagent_update' && update.sessionId && !childId) {
      childId = update.sessionId;
      void promptChild('ACTIVE').then((value) => {
        activeResult = value;
      });
    }
    if (
      sessionId === childId &&
      update.sessionUpdate === 'agent_message_chunk' &&
      update.content?.type === 'text'
    ) {
      childText += update.content.text;
    }
    if (
      update.sessionUpdate === 'subagent_update' &&
      update.sessionId === childId &&
      update.state?.state === 'idle' &&
      !idleResult
    ) {
      idleResult = { pending: true };
      void promptChild('IDLE').then((value) => {
        idleResult = value;
      });
    }
  }
});
processHandle.on('error', (error) => finish(error.message));
processHandle.on('exit', (code) => {
  if (code && !parentResult) finish(`Adapter exited: ${code}`);
});
const initialized = await request('initialize', {
  protocolVersion: 1,
  clientInfo: { name: 'spence', version: '0.0.0' },
  clientCapabilities: { subagents: {} },
});
console.log(
  JSON.stringify({
    protocolVersion: initialized.result?.protocolVersion,
    agentInfo: initialized.result?.agentInfo,
    subagents: initialized.result?.agentCapabilities?.sessionCapabilities?.subagents,
  }),
);
const created = await request('session/new', { cwd: process.cwd(), mcpServers: [] });
if (!created.result?.sessionId) {
  finish(`Session creation failed: ${JSON.stringify(created.error)}`);
} else {
  const parent = await request('session/prompt', {
    sessionId: created.result.sessionId,
    prompt: [
      {
        type: 'text',
        text: 'Use spawn_agent to start a real child immediately. Ask it to wait briefly, then reply with CHILD_INITIAL_MARKER. Wait for it. Do not modify files.',
      },
    ],
  });
  parentResult = parent.error ?? parent.result?.stopReason;
  // Give in-flight idle prompt responses time to arrive.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  finish(
    !childId || !activeResult || !idleResult || idleResult.pending
      ? 'Probe did not observe all required phases'
      : undefined,
  );
}
