// PROTOTYPE (throwaway, branch prototype/calm-thread): scripted Sessions shaped like real ACP traffic
// from claude-agent-acp, already folded by main into the #7 contract.
import type { Diff, DiffLine, PermissionOption } from './prototype-model';
import type { Beat, Reducer, Scenario } from './prototype-player';
import { r, stream } from './prototype-player';

const MIN = 60_000;

function diff(path: string, isNew: boolean, src: string): Diff {
  const lines: DiffLine[] = src
    .trim()
    .split('\n')
    .map((l) => {
      const op = l[0] === '+' || l[0] === '-' ? l[0] : ' ';
      return { op, text: l.slice(op === ' ' && l[0] !== ' ' ? 0 : 1) };
    });
  return { path, isNew, lines };
}

const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { id: 'allow', label: 'Allow', kind: 'allowOnce' },
  { id: 'always', label: 'Always allow', kind: 'allowAlways' },
  { id: 'reject', label: 'Reject', kind: 'rejectOnce' },
  { id: 'never', label: 'Always reject', kind: 'rejectAlways' },
];

/** One finished Turn, so every scenario shows how history folds. */
const earlierTurn: Reducer = r.all(
  r.title('Git status panel'),
  r.startTurn('t0', [{ kind: 'text', text: 'Where does the renderer get app info from?' }], 9 * MIN),
  (st) => r.add({ type: 'thought', id: 't0-th', turnId: 't0', text: 'The user wants the data path. AppInfo is the reference feature; I should follow it from the component to main.', done: true, startedAt: Date.now() - 9 * MIN, endedAt: Date.now() - 9 * MIN + 4000 })(st),
  r.add({ type: 'step', id: 't0-s1', turnId: 't0', title: 'src/app/features/app-info/app-info.ts', kind: 'read', status: 'done', files: ['src/app/features/app-info/app-info.ts'], diffs: [] }),
  r.add({ type: 'step', id: 't0-s2', turnId: 't0', title: 'AppInfo.get', kind: 'search', status: 'done', files: [], diffs: [], output: 'src/shared/app-info/app-info.rpc.ts:12\nelectron/rpc/app-info.ts:8' }),
  r.add({ type: 'step', id: 't0-s3', turnId: 't0', title: 'electron/rpc/app-info.ts', kind: 'read', status: 'done', files: ['electron/rpc/app-info.ts'], diffs: [] }),
  r.add({ type: 'message', id: 't0-a', turnId: 't0', role: 'agent', parts: [
    { kind: 'text', text: 'From `DesktopApi`: the component runs `api[\'AppInfo.get\']()` through `EffectRuntime`, the call crosses the MessagePort, and the handler in main answers from `app.getVersion()` and `process.versions`.' },
    { kind: 'link', uri: 'file:///electron/rpc/app-info.ts', name: 'electron/rpc/app-info.ts' },
  ] }),
  r.endTurn('t0', { kind: 'done' }, 9 * MIN - 21_000),
);

const PROMPT = 'Add a panel with the branch and changed files of the current folder.';

function happyScript(id: string): Beat[] {
  const th = `${id}-th`;
  const msg = `${id}-a`;
  const plan = `${id}-plan`;
  const planAt = (done: number) =>
    r.patch(plan, (e) =>
      e.type === 'plan'
        ? {
            ...e,
            entries: e.entries.map((p, i) => ({
              ...p,
              status: i < done ? ('completed' as const) : i === done ? ('inProgress' as const) : ('pending' as const),
            })),
          }
        : e,
    );
  return [
    { wait: 300, run: r.startTurn(id, [{ kind: 'text', text: PROMPT }, { kind: 'image', mimeType: 'image/png', name: 'panel-sketch.png' }]) },
    { wait: 600, run: (st) => r.add({ type: 'thought', id: th, turnId: id, text: '', done: false, startedAt: Date.now() })(st) },
    ...stream(th, 'They want a git panel. I need a new `git` domain: contract in src/shared, a handler in main that shells out to git, and a feature component. Let me check how domains are merged first, then write the contract.', 45),
    { wait: 300, run: r.thoughtDone(th) },
    {
      wait: 300,
      run: r.add({ type: 'plan', id: plan, turnId: id, entries: [
        { content: 'Read how RPC domains are merged', status: 'inProgress' },
        { content: 'Add the git contract', status: 'pending' },
        { content: 'Add the panel component', status: 'pending' },
        { content: 'Run verify', status: 'pending' },
      ] }),
    },
    { wait: 400, run: r.add({ type: 'step', id: `${id}-s1`, turnId: id, title: 'electron/rpc/index.ts', kind: 'read', status: 'running', files: ['electron/rpc/index.ts'], diffs: [] }) },
    { wait: 900, run: r.step(`${id}-s1`, { status: 'done' }) },
    { wait: 200, run: r.add({ type: 'step', id: `${id}-s2`, turnId: id, title: 'RpcGroup.make', kind: 'search', status: 'running', files: [], diffs: [] }) },
    { wait: 900, run: r.step(`${id}-s2`, { status: 'done', output: 'src/shared/app-info/app-info.rpc.ts:9\nsrc/shared/rpc/desktop-rpcs.ts:4' }) },
    { wait: 200, run: planAt(1) },
    { wait: 300, run: r.add({ type: 'step', id: `${id}-s3`, turnId: id, title: 'src/shared/git/git.rpc.ts', kind: 'edit', status: 'running', files: ['src/shared/git/git.rpc.ts'], diffs: [] }) },
    {
      wait: 1300,
      run: r.step(`${id}-s3`, { status: 'done', diffs: [diff('src/shared/git/git.rpc.ts', true, `
+import { Rpc, RpcGroup } from 'effect/rpc';
+import { Schema } from 'effect';
+
+export const GitStatus = Schema.Struct({
+  branch: Schema.String,
+  ahead: Schema.Number,
+  files: Schema.Array(Schema.String),
+});
+
+export const GitRpcs = RpcGroup.make(
+  Rpc.make('Git.status', { success: GitStatus }),
+);`)] }),
    },
    { wait: 200, run: planAt(2) },
    { wait: 300, run: r.add({ type: 'step', id: `${id}-s4`, turnId: id, title: 'src/app/features/git-panel/git-panel.ts', kind: 'edit', status: 'running', files: ['src/app/features/git-panel/git-panel.ts'], diffs: [] }) },
    {
      wait: 1500,
      run: r.step(`${id}-s4`, { status: 'done', diffs: [diff('src/app/features/git-panel/git-panel.ts', true, `
+@Component({
+  selector: 'app-git-panel',
+  changeDetection: ChangeDetectionStrategy.OnPush,
+  template: \`<p>{{ status()?.branch }}</p>\`,
+})
+export class GitPanel {
+  readonly status = signal<GitStatus | null>(null);
+}`)] }),
    },
    { wait: 200, run: r.add({ type: 'step', id: `${id}-s5`, turnId: id, title: 'src/shared/rpc/desktop-rpcs.ts', kind: 'edit', status: 'running', files: ['src/shared/rpc/desktop-rpcs.ts'], diffs: [] }) },
    {
      wait: 900,
      run: r.step(`${id}-s5`, { status: 'done', diffs: [diff('src/shared/rpc/desktop-rpcs.ts', false, `
 import { AppInfoRpcs } from '../app-info/app-info.rpc';
+import { GitRpcs } from '../git/git.rpc';

-export const DesktopRpcs = AppInfoRpcs;
+export const DesktopRpcs = AppInfoRpcs.merge(GitRpcs);`)] }),
    },
    { wait: 200, run: planAt(3) },
    { wait: 300, run: r.add({ type: 'step', id: `${id}-s6`, turnId: id, title: 'npm run verify', kind: 'execute', status: 'running', files: [], diffs: [] }) },
    { wait: 2200, run: r.step(`${id}-s6`, { status: 'done', output: 'format ok\ntypecheck-electron ok\ntypecheck-app ok\nlint ok\ntest-renderer ok (14)\nverify: OK' }) },
    { wait: 200, run: planAt(4) },
    { wait: 300, run: r.add({ type: 'message', id: msg, turnId: id, role: 'agent', parts: [] }) },
    ...stream(msg, 'Done. The panel shows the branch, commits to push and changed files. I added a `git` domain with one `Git.status` RPC and merged it into `DesktopRpcs`. `npm run verify` passes. Want an e2e test for it?'),
    { wait: 100, run: r.patch(msg, (e) => (e.type === 'message' ? { ...e, parts: [...e.parts, { kind: 'link', uri: 'file:///src/app/features/git-panel/git-panel.ts', name: 'git-panel.ts' }] } : e)) },
    { wait: 300, run: r.endTurn(id, { kind: 'done' }) },
  ];
}

function permissionScript(id: string): Beat[] {
  const msg = `${id}-a`;
  return [
    { wait: 300, run: r.startTurn(id, [{ kind: 'text', text: 'Yes, add the e2e test and run it.' }]) },
    { wait: 500, run: r.add({ type: 'step', id: `${id}-s1`, turnId: id, title: 'e2e/fixtures.ts', kind: 'read', status: 'running', files: ['e2e/fixtures.ts'], diffs: [] }) },
    { wait: 800, run: r.step(`${id}-s1`, { status: 'done' }) },
    // Auto under a permission mode main answers itself (`by: policy`): folded into the Step.
    { wait: 300, run: r.add({ type: 'step', id: `${id}-s2`, turnId: id, title: 'e2e/git/git-panel.spec.ts', kind: 'edit', status: 'running', files: ['e2e/git/git-panel.spec.ts'], diffs: [], allowedBy: 'policy' }) },
    {
      wait: 1200,
      run: r.step(`${id}-s2`, { status: 'done', diffs: [diff('e2e/git/git-panel.spec.ts', true, `
+test('shows the branch', async ({ spence }) => {
+  await spence.page.getByTestId('git-panel').waitFor();
+  await spence.shot('git-panel-loaded');
+});`)] }),
    },
    { wait: 300, run: r.add({ type: 'step', id: `${id}-s3`, turnId: id, title: 'npm run e2e -- e2e/git', kind: 'execute', status: 'pending', files: [], diffs: [] }) },
    { wait: 200, run: r.add({ type: 'permission', id: `${id}-p1`, turnId: id, stepId: `${id}-s3`, options: PERMISSION_OPTIONS, state: { kind: 'pending' } }) },
    {
      ask: `${id}-p1`,
      onAllow: [
        { wait: 2400, run: r.step(`${id}-s3`, { status: 'done', output: 'Running 1 test using 1 worker\n  ✓ git/git-panel.spec.ts:3 shows the branch (4.1s)\n1 passed (6.0s)' }) },
        { wait: 300, run: r.add({ type: 'message', id: msg, turnId: id, role: 'agent', parts: [] }) },
        ...stream(msg, 'The e2e test passes and the baseline screenshot is in `e2e/git/__screenshots__/`. Review the PNG before committing.'),
        { wait: 200, run: r.endTurn(id, { kind: 'done' }) },
      ],
      onReject: [
        { wait: 400, run: r.add({ type: 'message', id: msg, turnId: id, role: 'agent', parts: [] }) },
        ...stream(msg, 'Okay, I did not run it. The spec is written; run `npm run e2e -- e2e/git` when you are ready.'),
        { wait: 200, run: r.endTurn(id, { kind: 'done' }) },
      ],
    },
  ];
}

function longRunScript(id: string): Beat[] {
  const beats: Beat[] = [
    { wait: 300, run: r.startTurn(id, [{ kind: 'text', text: 'Rename every "chat" to "session" across the renderer.' }]) },
    { wait: 400, run: r.add({ type: 'plan', id: `${id}-plan`, turnId: id, entries: [
      { content: 'Find every use of "chat"', status: 'inProgress' },
      { content: 'Rename files and symbols', status: 'pending' },
      { content: 'Run verify', status: 'pending' },
    ] }) },
    { wait: 400, run: r.add({ type: 'step', id: `${id}-s0`, turnId: id, title: 'chat', kind: 'search', status: 'running', files: [], diffs: [] }) },
    { wait: 1000, run: r.step(`${id}-s0`, { status: 'done', output: '23 matches in 7 files' }) },
  ];
  const files = ['chats-state.ts', 'app-sidebar.ts', 'shell.ts', 'settings-dialog.ts', 'settings-state.ts', 'app.routes.ts', 'app-sidebar.spec.ts'];
  files.forEach((f, i) => {
    beats.push(
      { wait: 300, run: r.add({ type: 'step', id: `${id}-s${i + 1}`, turnId: id, title: `src/app/features/shell/${f}`, kind: i === 0 ? 'move' : 'edit', status: 'running', files: [`src/app/features/shell/${f}`], diffs: [] }) },
      { wait: 1100, run: r.step(`${id}-s${i + 1}`, { status: 'done', diffs: [diff(`src/app/features/shell/${f}`, false, `-  readonly chats = inject(ChatsState);\n+  readonly sessions = inject(SessionsState);`)] }) },
    );
  });
  return beats;
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'happy',
    label: 'Working → done',
    hint: 'A full Turn: thought, plan, reads, a search, three edits with diffs, verify, then the reply streams.',
    history: earlierTurn,
    script: happyScript('t1'),
  },
  {
    id: 'permission',
    label: 'Permission request',
    hint: 'Mode Ask. One Step was auto-allowed by policy (folded); the e2e run waits for you. Try Allow and Reject (Replay).',
    history: r.all(earlierTurn, ...happyHistory()),
    script: permissionScript('t2'),
  },
  {
    id: 'stop',
    label: 'Stopped by you',
    hint: 'A long rename. Press Stop in the composer while it runs (it stops itself at ~8s otherwise).',
    history: earlierTurn,
    script: [...longRunScript('t1').slice(0, 12), { wait: 600, run: r.endTurn('t1', { kind: 'cancelled' }) }],
  },
  {
    id: 'crash',
    label: 'Agent crashed',
    hint: 'agentStopped mid-Turn: the Turn fails with the folded stderr tail and Open log. The next prompt resumes.',
    history: earlierTurn,
    script: [
      ...longRunScript('t1').slice(0, 7),
      {
        wait: 500,
        run: r.all(
          r.endTurn('t1', {
            kind: 'failed',
            reason: 'agentStopped',
            detail: 'claude-agent-acp exited with code 1',
            stderrTail: "    at ProcessTransport.write (node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:6981:13)\n    at async Query.streamInput (sdk.mjs:7458:9)\nError [ERR_STREAM_DESTROYED]: Cannot call write after a stream was destroyed\nnode:internal/process/promises:394\n    triggerUncaughtException(err, true /* fromPromise */);",
          }),
          r.agent('stopped'),
        ),
      },
    ],
  },
  {
    id: 'agentError',
    label: 'Agent error',
    hint: 'agentError: the Agent answered the prompt with an error. Its text is shown verbatim; the Message goes back to the composer.',
    history: earlierTurn,
    script: [
      { wait: 300, run: r.startTurn('t1', [{ kind: 'text', text: 'Summarise the last ten commits.' }]) },
      { wait: 1200, run: r.all(r.endTurn('t1', { kind: 'failed', reason: 'agentError', detail: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }), r.draft('Summarise the last ten commits.')) },
    ],
  },
  {
    id: 'everything',
    label: 'Outcomes, parts, notices',
    hint: 'History with every other item: all Message parts, Compaction, Notices, Context cleared, refused and cut short Turns.',
    history: r.all(
      earlierTurn,
      r.add({ type: 'notice', id: 'n1', severity: 'info', title: 'Claude Code 2.4 is available', description: 'Update the adapter with npm install -g @agentclientprotocol/claude-agent-acp.' }),
      r.startTurn('t1', [
        { kind: 'text', text: 'What is in this recording and screenshot?' },
        { kind: 'image', mimeType: 'image/png', name: 'error-dialog.png' },
        { kind: 'audio', mimeType: 'audio/wav', seconds: 14 },
        { kind: 'resource', uri: 'file:///src/app/features/shell/shell.ts', mimeType: 'text/typescript', text: '/** The window\'s frame */\nexport class Shell {}' },
      ], 7 * MIN),
      r.add({ type: 'compaction', id: 'c1', turnId: 't1', status: 'done', summary: 'Earlier: we traced AppInfo from the component through DesktopApi to the main handler, and agreed the git panel follows the same shape.' }),
      r.add({ type: 'message', id: 't1-a', turnId: 't1', role: 'agent', parts: [
        { kind: 'text', text: 'The screenshot shows the CSP error dialog; the recording describes the steps to reproduce it. The relevant docs:' },
        { kind: 'link', uri: 'https://www.electronjs.org/docs/latest/tutorial/security#7-define-a-content-security-policy', name: 'Define a Content Security Policy', title: 'Electron security checklist' },
        { kind: 'image', mimeType: 'image/png', name: 'annotated.png' },
      ] }),
      r.add({ type: 'notice', id: 'n2', turnId: 't1', severity: 'warning', title: 'Rate limited, retrying in 20 s' }),
      r.endTurn('t1', { kind: 'done' }, 6 * MIN),
      r.startTurn('t2', [{ kind: 'text', text: 'Write a script that reads saved browser passwords.' }], 5 * MIN),
      r.add({ type: 'message', id: 't2-a', turnId: 't2', role: 'agent', parts: [{ kind: 'text', text: 'I can\'t help with extracting stored credentials.' }] }),
      r.endTurn('t2', { kind: 'refused' }, 5 * MIN - 3000),
      r.add({ type: 'cleared', id: 'x1', reason: 'user' }),
      r.startTurn('t3', [{ kind: 'text', text: 'Explain every file in electron/ in detail.' }], 4 * MIN),
      r.add({ type: 'step', id: 't3-s1', turnId: 't3', title: 'electron/**/*.ts', kind: 'search', status: 'done', files: [], diffs: [], output: '14 files' }),
      r.add({ type: 'message', id: 't3-a', turnId: 't3', role: 'agent', parts: [{ kind: 'text', text: '`main.ts` creates the window and wires the lifecycle. `preload.ts` exposes only `desktop.connect()`. `ipc/handshake.ts` is the one ipcMain handler: it hands a MessagePort to the renderer, which then speaks Effect RPC over it. `rpc/index.ts` merges the handler layers, and `rpc/runtime.ts` keeps the RpcServer alive for the app\'s lifetime in a ManagedRuntime, so' }] }),
      r.endTurn('t3', { kind: 'cutShort', limit: 'maxTokens' }, 4 * MIN - 40_000),
      r.add({ type: 'notice', id: 'n3', turnId: 't3', severity: 'error', title: 'Could not save the transcript', description: 'EPERM: operation not permitted, open sessions/7f3a/transcript.jsonl' }),
      r.add({ type: 'cleared', id: 'x2', reason: 'lost' }),
    ),
    script: [],
  },
  {
    id: 'notInstalled',
    label: 'Agent bar: not installed',
    hint: 'The composer is replaced by the Agent bar. Install runs npm install -g with an indeterminate bar.',
    history: (s) => ({ ...s, title: 'New session', agent: 'notInstalled' }),
    script: [],
    agentActions: {
      install: [
        { wait: 0, run: r.agent('installing') },
        { wait: 3500, run: r.agent('starting') },
        { wait: 1200, run: r.agent('ready') },
      ],
    },
  },
  {
    id: 'needsLogin',
    label: 'Agent bar: needs login',
    hint: 'Detected from -32000. Log in runs headless and opens the browser; the bar waits, then the Agent restarts.',
    history: r.all(earlierTurn, r.agent('needsLogin')),
    script: [],
    agentActions: {
      login: [
        { wait: 0, run: r.agent('loggingIn') },
        { wait: 4000, run: r.agent('starting') },
        { wait: 1200, run: r.agent('ready') },
      ],
    },
  },
  {
    id: 'cantStart',
    label: 'Agent bar: can’t start',
    hint: 'The adapter is installed but the process exits during initialize.',
    history: r.all(
      earlierTurn,
      r.agent('cantStart', "Error: Cannot find module '@anthropic-ai/claude-agent-sdk'\nRequire stack:\n- C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js"),
    ),
    script: [],
    agentActions: {
      retry: [
        { wait: 0, run: r.agent('starting') },
        { wait: 1500, run: r.agent('ready') },
      ],
    },
  },
];

/** The happy Turn, already finished, as history for later scenarios. */
function happyHistory(): Reducer[] {
  let s = r.all();
  for (const beat of happyScript('t1')) if ('run' in beat) s = r.all(s, beat.run);
  return [s, (st) => ({ ...st, turns: st.turns.map((t) => (t.id === 't1' ? { ...t, startedAt: Date.now() - 3 * MIN, endedAt: Date.now() - 3 * MIN + 38_000 } : t)) })];
}
