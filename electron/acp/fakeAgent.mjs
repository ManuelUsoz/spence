// A fake ACP Agent for specs: speaks ACP v1 over stdio with scripted replies. Never shipped.
//
// Launch arguments (constants, like a Catalog entry's):
//   --protocol=<n>   answer `initialize` with protocol version n (default 1)
//   --version=<v>    answer `initialize.agentInfo.version` with v (default 1.0.0)
//   --version        print `FAKE_CLI_VERSION` (or 1.0.0) and exit 0 (simulates native `--version`)
//   --no-agent-info-version  omit `version` from `initialize.agentInfo`
//   --fail-init      write to stderr and exit with code 2 before answering `initialize`
//   --no-acp         write to stderr and exit with code 2 as a non-ACP binary
//   --no-auto        advertise unsupported Auto gate via `_meta.spence.supportsAuto`
//   --no-ask         omit Ask permission mode and default ask mode
//   --no-cancel      advertise unsupported Cancel gate via `_meta.spence.supportsCancel`
//   --no-auth-detection  advertise unsupported -32000 auth detection via `_meta.spence.supportsAuthDetection`
//   --no-models      omit the `model` config option
//   --no-effort      omit the `effort` config option
//   --no-images      advertise `promptCapabilities.image: false`
//   --ineligible-models  include ineligible third-party models (`claude-sonnet-4`, `gpt-5`)
//   --extra-auth     advertise two terminal authMethods (`login`, `api-key`)
//   --login-mode     act as the terminal login process (exits 0 unless FAKE_LOGIN_FAIL=1 or FAKE_LOGIN_HOLD=1)
//   --login-hold     with --login-mode, wait until killed (for Cancel tests)
//   --bare           advertise no optional capabilities (no load, resume, close, delete, image)
//   --no-steering    omit the `_meta.steering.supported` flag and the `_session/steering` handler
//   --no-resume      advertise `session/load` but not `session/resume`
//   --fail-resume    advertise `session/resume` but refuse it
//   --fail-load      advertise `session/load` but refuse it
//   --stall-cancel   ignore `session/cancel` on all prompts
//   --ignore-sigterm ignore SIGTERM (must be killed with SIGKILL or taskkill /F)
//   --delay-exit=<n> delay process exit by n ms after stdin closes
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
//   "stall"   one chunk ("working"), then ignores `session/cancel` until killed
//   "steer-hold"  a Thought and one chunk, then waits for Steers and `session/cancel`; ends `cancelled`
//   "steer-done"  a Thought and one chunk, then waits for one Steer and ends `end_turn`
//   "refuse"  ends `refusal`
//   "max-tokens"  ends `max_tokens`
//   "max-turn-requests"  ends `max_turn_requests`
//   "ask"     a Permission request; after `session/cancel` it reports the outcome it got and ends `cancelled`
//   "work"    a whole Turn's work: a Thought, a Plan, Steps (a read, an edit with a diff, a failed command), a
//             Notice, then a reply; ends `end_turn`
//   "busy"    a Thought, a Plan and a running command, then waits for `session/cancel` and ends `cancelled`
//   "permit"  a Step (`tool_call` "ls -la"), then a Permission request for it; reports the option picked
//             ("permission <optionId>", or "permission cancelled") and ends `end_turn`
//   "mode"    replies with the session's current mode id and ends `end_turn`
//   "usage:<used>/<size>" reports Context usage and ends `end_turn`
//   "image:reply" streams one 1600x1200 PNG as a structured Agent image
//   "markdown:long" streams a long Markdown reply in small chunks for renderer profiling
//   "echo:<text>" (or anything else) streams the text back in three chunks and ends `end_turn`
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { deflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const protocol = Number(
  (args.find((arg) => arg.startsWith('--protocol=')) ?? '--protocol=1').split('=')[1],
);
const agentVersion =
  args.find((arg) => arg.startsWith('--version='))?.slice('--version='.length) ?? '1.0.0';
const noAgentInfoVersion = args.includes('--no-agent-info-version');
const printCliVersion = args.includes('--version');
const failInit = args.includes('--fail-init');
const noAcp = args.includes('--no-acp');
const noAuto = args.includes('--no-auto');
const noAsk = args.includes('--no-ask');
const noCancel = args.includes('--no-cancel');
const noAuthDetection = args.includes('--no-auth-detection');
const noModels = args.includes('--no-models');
const noEffort = args.includes('--no-effort');
const noImages = args.includes('--no-images');
const codexFixture = args.includes('--codex-fixture');
const ineligibleModels = args.includes('--ineligible-models');
const extraAuth = args.includes('--extra-auth');
const loginMode = args.includes('--login-mode');
const loginHold = args.includes('--login-hold') || process.env.FAKE_LOGIN_HOLD === '1';
const bare = args.includes('--bare');
const noSteering = args.includes('--no-steering');
const steeringEnabled = !noSteering && !bare;
const noResume = args.includes('--no-resume');
const failResume = args.includes('--fail-resume');
const failLoad = args.includes('--fail-load');
const stallCancel = args.includes('--stall-cancel');
const ignoreSigterm = args.includes('--ignore-sigterm');
const delayExitMs = Number(
  (args.find((arg) => arg.startsWith('--delay-exit=')) ?? '--delay-exit=0').split('=')[1],
);
const noCompaction = args.includes('--no-compaction');
const compactFail = args.includes('--compact-fail');
const compactHold = args.includes('--compact-hold');
const compactUsageSpec = args
  .find((arg) => arg.startsWith('--compact-usage='))
  ?.slice('--compact-usage='.length);
const failIsolatedSummary = args.includes('--fail-isolated-summary');
const handoffUnexpectedTool = args.includes('--handoff-unexpected-tool');
const handoffCrash = args.includes('--handoff-crash');
const handoffStall = args.includes('--handoff-stall');
let clientHasFsOrTerminal = false;

if (ignoreSigterm) {
  process.on('SIGTERM', () => {});
}

if (printCliVersion) {
  process.stdout.write(`${process.env.FAKE_CLI_VERSION ?? agentVersion}\n`);
  process.exit(0);
} else if (loginMode) {
  if (loginHold) {
    process.stderr.write('login waiting\n');
    setInterval(() => {}, 1000);
  } else {
    process.exit(process.env.FAKE_LOGIN_FAIL === '1' ? 1 : 0);
  }
} else if (failInit || noAcp) {
  process.stderr.write(noAcp ? 'missing acp subcommand\n' : 'init failed\n');
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

const MODEL_OPTIONS = ineligibleModels
  ? [
      { value: 'gemini-pro', name: 'Gemini Pro' },
      { value: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
      { value: 'gpt-5', name: 'GPT-5' },
    ]
  : codexFixture
    ? [
        { value: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
        { value: 'gpt-5.4-codex', name: 'GPT-5.4 Codex' },
      ]
    : [
        { value: 'small', name: 'Small' },
        { value: 'large', name: 'Large' },
      ];

const configOptions = (sessionId) => [
  ...(noModels
    ? []
    : [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: models.get(sessionId) ?? MODEL_OPTIONS[0].value,
          options: MODEL_OPTIONS,
        },
      ]),
  ...(noEffort
    ? []
    : [
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
            ...(codexFixture ? [{ value: 'max', name: 'Max' }] : []),
          ],
        },
      ]),
  {
    id: 'permission',
    name: 'Permission',
    category: 'permission',
    type: 'select',
    currentValue: permissions.get(sessionId) ?? (noAsk ? 'auto' : 'ask'),
    options: [...(noAsk ? [] : [{ value: 'ask', name: 'Ask' }]), { value: 'auto', name: 'Auto' }],
  },
];
/** The session modes offered: like Claude's, or Codex's `read-only` / `auto` under `--codex-fixture`. */
const MODES = codexFixture
  ? [
      ...(noAsk ? [] : [{ id: 'read-only', name: 'Read Only' }]),
      { id: 'auto', name: 'Auto' },
      { id: 'full-access', name: 'Full Access' },
    ]
  : [
      ...(noAsk ? [] : [{ id: 'default', name: 'Always ask' }]),
      { id: 'acceptEdits', name: 'Accept edits' },
      { id: 'plan', name: 'Plan' },
    ];
const DEFAULT_MODE = codexFixture
  ? noAsk
    ? 'auto'
    : 'read-only'
  : noAsk
    ? 'acceptEdits'
    : 'default';
/** Per session: its current mode id. */
const modes = new Map();
/** Per session: resolves when `session/cancel` arrives. */
const cancelled = new Map();
const waitForCancel = (sessionId) =>
  new Promise((resolve) => {
    cancelled.set(sessionId, resolve);
  });

/** Per session: steered texts waiting for the scripted Turn, and Turns waiting for one. */
const steering = new Map();
const steerEntry = (sessionId) => {
  const existing = steering.get(sessionId);
  if (existing !== undefined) return existing;
  const created = { queued: [], waiting: [] };
  steering.set(sessionId, created);
  return created;
};
const waitForSteer = (sessionId) =>
  new Promise((resolve) => {
    const entry = steerEntry(sessionId);
    const queued = entry.queued.shift();
    if (queued !== undefined) resolve(queued);
    else entry.waiting.push(resolve);
  });
const deliverSteer = (sessionId, text) => {
  const entry = steerEntry(sessionId);
  const waiting = entry.waiting.shift();
  if (waiting !== undefined) waiting(text);
  else entry.queued.push(text);
};
/** Sessions with a `session/prompt` in flight. */
const runningPrompts = new Set();

const COMMANDS = [
  { name: 'clear', description: 'Clear the conversation' },
  ...(bare || noCompaction ? [] : [{ name: 'compact', description: 'Compact the conversation' }]),
  { name: 'review', description: 'Review the changes', input: { hint: 'what to review' } },
];

const chunk = (sessionId, text) => ({
  sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
});

const imageChunk = (sessionId, mimeType, data) => ({
  sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType, data } },
});

/** A deterministic PNG for the structured-image e2e path: large enough to measure real decoding. */
const imageReply = (() => {
  const width = 1_600;
  const height = 1_200;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const pngChunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3;
      raw[at] = (x * 255) / width;
      raw[at + 1] = (y * 255) / height;
      raw[at + 2] = ((x + y) * 255) / (width + height);
    }
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
})();

/** A long Markdown reply, streamed in small chunks so the real renderer is exercised while it grows. */
const longMarkdown = [
  ...Array.from(
    { length: 120 },
    (_, index) => `## Section ${index + 1}

Paragraph ${index + 1} with **bold**, *emphasis*, ~~struck~~ and \`inline-code-${index + 1}\`.

- item one
- item two

\`\`\`ts
const value = ${index + 1};
\`\`\`
`,
  ),
  '## Final section complete.\n\nAll sections arrived.\n',
].join('\n');

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

/** Marks a session as running for the duration of one `session/prompt`. */
const withRunning = (handler) => async (args) => {
  const { sessionId } = args.params;
  runningPrompts.add(sessionId);
  try {
    return await handler(args);
  } finally {
    runningPrompts.delete(sessionId);
  }
};

const app = acp
  .agent({ name: 'fake-agent' })
  .onRequest('initialize', ({ params }) => {
    const fs = params?.clientCapabilities?.fs;
    clientHasFsOrTerminal = Boolean(
      fs?.readTextFile || fs?.writeTextFile || params?.clientCapabilities?.terminal,
    );
    return {
      protocolVersion: protocol,
      ...(steeringEnabled ? { _meta: { steering: { supported: true } } } : {}),
      ...(noAgentInfoVersion ? {} : { agentInfo: { name: 'fake-agent', version: agentVersion } }),
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
            _meta: { compaction: !noCompaction },
            loadSession: true,
            promptCapabilities: { image: !noImages },
            sessionCapabilities: {
              ...(noResume ? {} : { resume: {} }),
              close: {},
              delete: {},
            },
            ...(noAuto || noCancel || noAuthDetection
              ? {
                  _meta: {
                    spence: {
                      ...(noAuto ? { supportsAuto: false } : {}),
                      ...(noCancel ? { supportsCancel: false } : {}),
                      ...(noAuthDetection ? { supportsAuthDetection: false } : {}),
                    },
                  },
                }
              : {}),
          },
    };
  })
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
    modes.set(sessionId, DEFAULT_MODE);
    return {
      sessionId,
      modes: { currentModeId: DEFAULT_MODE, availableModes: MODES },
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
      modes: { currentModeId: modes.get(params.sessionId) ?? DEFAULT_MODE, availableModes: MODES },
      configOptions: configOptions(params.sessionId),
    };
  })
  .onRequest('session/resume', ({ params }) => {
    if (failResume) throw acp.RequestError.internalError(undefined, 'no such session');
    opened.set(params.sessionId, 'resumed');
    return {
      modes: { currentModeId: modes.get(params.sessionId) ?? DEFAULT_MODE, availableModes: MODES },
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
      modes: { currentModeId: modes.get(params.sessionId) ?? DEFAULT_MODE, availableModes: MODES },
      configOptions: configOptions(params.sessionId),
    };
  })
  .onRequest('session/set_mode', ({ params }) => {
    modes.set(params.sessionId, params.modeId);
    return {};
  })
  .onNotification('session/cancel', ({ params }) => {
    if (stallCancel) return;
    cancelled.get(params.sessionId)?.();
  })
  .onRequest(
    '_session/steering',
    (params) => params,
    async ({ params, client }) => {
      if (!steeringEnabled) throw new acp.RequestError(-32601, 'method not found');
      const { sessionId } = params;
      if (!runningPrompts.has(sessionId)) {
        return { outcome: 'promptRequired', reason: 'noRunningTurn' };
      }
      const text = textOf(params.prompt);
      await client.notify('session/update', update(sessionId, thought(`Steering: ${text}`)));
      await client.notify('session/update', chunk(sessionId, `steered:${text}\n`));
      deliverSteer(sessionId, text);
      return { outcome: 'injected' };
    },
  )
  .onRequest(
    'session/compact',
    (params) => params,
    async ({ params, client }) => {
      const { sessionId } = params;
      const cid = 'compact-1';
      const cancel = compactHold ? waitForCancel(sessionId) : undefined;
      await client.notify(
        'session/update',
        update(sessionId, {
          sessionUpdate: 'compaction_update',
          compactionId: cid,
          status: 'in_progress',
        }),
      );
      if (cancel !== undefined) {
        await cancel;
        await client.notify(
          'session/update',
          update(sessionId, {
            sessionUpdate: 'compaction_update',
            compactionId: cid,
            status: 'cancelled',
          }),
        );
        return {};
      }
      if (compactFail) {
        await client.notify(
          'session/update',
          update(sessionId, {
            sessionUpdate: 'compaction_update',
            compactionId: cid,
            status: 'failed',
          }),
        );
        return {};
      }
      await client.notify(
        'session/update',
        update(sessionId, {
          sessionUpdate: 'compaction_summary_chunk',
          compactionId: cid,
          content: { type: 'text', text: 'Compacted ' },
        }),
      );
      await client.notify(
        'session/update',
        update(sessionId, {
          sessionUpdate: 'compaction_summary_chunk',
          compactionId: cid,
          content: { type: 'text', text: 'summary' },
        }),
      );
      await client.notify(
        'session/update',
        update(sessionId, {
          sessionUpdate: 'compaction_update',
          compactionId: cid,
          status: 'completed',
        }),
      );
      if (compactUsageSpec !== undefined) {
        const [rawUsed, rawSize] = compactUsageSpec.split('/');
        await client.notify(
          'session/update',
          update(sessionId, {
            sessionUpdate: 'usage_update',
            used: Number(rawUsed),
            ...(rawSize === undefined ? {} : { size: Number(rawSize) }),
          }),
        );
      }
      return {};
    },
  )
  .onRequest(
    'session/prompt',
    withRunning(async ({ params, client }) => {
      const text = textOf(params.prompt);
      const { sessionId } = params;
      if (text.startsWith('Summarize the following Session Transcript extract')) {
        if (failIsolatedSummary) throw new acp.RequestError(-32603, 'Isolated summary failed');
        const toolsTag = clientHasFsOrTerminal ? 'tools-enabled' : 'tools-disabled';
        await client.notify(
          'session/update',
          chunk(
            sessionId,
            `Isolated summary (${toolsTag}):\nGoal: continued from isolated session.`,
          ),
        );
        return { stopReason: 'end_turn' };
      }
      if (text.startsWith('You are receiving a reviewed Summary handoff')) {
        if (handoffCrash) {
          await client.notify('session/update', chunk(sessionId, 'starting handoff'));
          process.exit(3);
        }
        if (handoffStall) {
          await client.notify('session/update', chunk(sessionId, 'starting handoff'));
          const cancel = stallCancel ? undefined : waitForCancel(sessionId);
          if (cancel === undefined) {
            await new Promise(() => {});
          }
          await cancel;
          return { stopReason: 'cancelled' };
        }
        if (handoffUnexpectedTool) {
          const cwd = folders.get(sessionId) ?? process.cwd();
          await client.notify(
            'session/update',
            update(sessionId, {
              sessionUpdate: 'tool_call',
              toolCallId: 'unexpected-edit-1',
              title: 'Edit unplanned.ts',
              kind: 'edit',
              status: 'in_progress',
              locations: [{ path: `${cwd}/unplanned.ts` }],
              content: [
                {
                  type: 'diff',
                  path: `${cwd}/unplanned.ts`,
                  oldText: 'before',
                  newText: 'after',
                },
              ],
            }),
          );
          await client.notify(
            'session/update',
            update(sessionId, {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'unexpected-edit-1',
              status: 'completed',
            }),
          );
          await client.notify('session/update', chunk(sessionId, 'I edited unplanned.ts.'));
          return { stopReason: 'end_turn' };
        }
        await client.notify(
          'session/update',
          chunk(sessionId, 'Handoff acknowledged. Waiting for your next instruction.'),
        );
        return { stopReason: 'end_turn' };
      }
      if (text.startsWith('title:')) {
        await client.notify(
          'session/update',
          update(sessionId, { sessionUpdate: 'session_info_update', title: text.slice(6) }),
        );
        return { stopReason: 'end_turn' };
      }
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
      if (text === 'stall') {
        await client.notify('session/update', chunk(sessionId, 'working'));
        await new Promise(() => {});
      }
      if (text === 'steer-hold') {
        const cancel = waitForCancel(sessionId);
        await client.notify('session/update', update(sessionId, thought('Planning the Turn.')));
        await client.notify('session/update', chunk(sessionId, 'working'));
        await cancel;
        return { stopReason: 'cancelled' };
      }
      if (text === 'steer-done') {
        await client.notify('session/update', update(sessionId, thought('Planning the Turn.')));
        await client.notify('session/update', chunk(sessionId, 'working'));
        await waitForSteer(sessionId);
        return { stopReason: 'end_turn' };
      }
      if (text === 'refuse') {
        await client.notify('session/update', chunk(sessionId, 'refused'));
        return { stopReason: 'refusal' };
      }
      if (text === 'max-tokens') return { stopReason: 'max_tokens' };
      if (text === 'max-turn-requests') return { stopReason: 'max_turn_requests' };
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
      if (text === 'permit' || text === 'permit-no-allow-once') {
        const noAllowOnce = text === 'permit-no-allow-once';
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
            ...(noAllowOnce ? [] : [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }]),
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
      if (text === 'cumulative-only') {
        await client.notify('session/update', chunk(sessionId, 'cumulative'));
        return {
          stopReason: 'end_turn',
          usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        };
      }
      if (text.startsWith('usage:')) {
        const spec = text.slice('usage:'.length);
        const [rawUsed, rawSize] = spec.split('/');
        const used = rawUsed === 'nan' ? Number.NaN : Number(rawUsed);
        const size =
          rawSize === undefined ? undefined : rawSize === 'nan' ? Number.NaN : Number(rawSize);
        await client.notify(
          'session/update',
          update(sessionId, {
            sessionUpdate: 'usage_update',
            used,
            ...(size === undefined ? {} : { size }),
          }),
        );
        await client.notify('session/update', chunk(sessionId, 'usage reported'));
        return { stopReason: 'end_turn' };
      }
      if (text === 'compact-ok' || text.startsWith('compact-ok:')) {
        const cid = 'compact-1';
        await client.notify(
          'session/update',
          update(sessionId, {
            sessionUpdate: 'compaction_update',
            compactionId: cid,
            status: 'in_progress',
          }),
        );
        await client.notify(
          'session/update',
          update(sessionId, {
            sessionUpdate: 'compaction_update',
            compactionId: cid,
            status: 'completed',
            summary: [{ type: 'text', text: 'Compacted summary' }],
          }),
        );
        if (text.startsWith('compact-ok:')) {
          const [rawUsed, rawSize] = text.slice('compact-ok:'.length).split('/');
          await client.notify(
            'session/update',
            update(sessionId, {
              sessionUpdate: 'usage_update',
              used: Number(rawUsed),
              ...(rawSize === undefined ? {} : { size: Number(rawSize) }),
            }),
          );
        }
        await client.notify('session/update', chunk(sessionId, 'compacted'));
        return { stopReason: 'end_turn' };
      }
      if (text === 'compact-fail') {
        const cid = 'compact-1';
        await client.notify(
          'session/update',
          update(sessionId, {
            sessionUpdate: 'compaction_update',
            compactionId: cid,
            status: 'in_progress',
          }),
        );
        await client.notify(
          'session/update',
          update(sessionId, {
            sessionUpdate: 'compaction_update',
            compactionId: cid,
            status: 'failed',
          }),
        );
        await client.notify('session/update', chunk(sessionId, 'compact failed'));
        return { stopReason: 'end_turn' };
      }
      if (text === 'compact-cancel') {
        const cid = 'compact-1';
        const cancel = waitForCancel(sessionId);
        await client.notify(
          'session/update',
          update(sessionId, {
            sessionUpdate: 'compaction_update',
            compactionId: cid,
            status: 'in_progress',
          }),
        );
        await cancel;
        await client.notify(
          'session/update',
          update(sessionId, {
            sessionUpdate: 'compaction_update',
            compactionId: cid,
            status: 'cancelled',
          }),
        );
        return { stopReason: 'cancelled' };
      }
      if (text === 'image:reply') {
        await client.notify('session/update', imageChunk(sessionId, 'image/png', imageReply));
        return { stopReason: 'end_turn' };
      }
      if (text === 'markdown:long') {
        const size = 160;
        for (let at = 0; at < longMarkdown.length; at += size) {
          await client.notify(
            'session/update',
            chunk(sessionId, longMarkdown.slice(at, at + size)),
          );
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
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
    }),
  );

const connection = app.connect(
  acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
// Closing stdin is how a client says goodbye.
await connection.closed;
if (delayExitMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayExitMs));
}
process.exit(0);
