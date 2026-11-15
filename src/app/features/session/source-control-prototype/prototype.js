// Three throwaway Session layouts, switched by ?variant=A|B|C. All mutations are fictional.
const variants = ['A', 'B', 'C'];
const names = { A: 'Right inspector', B: 'Full-width workbench', C: 'Bottom tray' };
const scenarios = {
  idle: 'Idle · staged + unstaged + untracked',
  running: 'Shared Worktree · two active Turns',
  stale: 'Files changed after review',
  hook: 'Commit hook failed',
  push: 'Committed; push failed',
  diverged: 'Pull · branches diverged',
  conflict: 'Rebase conflict',
  recovery: 'Recovery storage unavailable',
  partial: 'Partial file-operation failure',
  missing: 'Worktree missing',
  incomplete: 'Historical capture incomplete',
  nonGit: 'Non-Git Project',
  loading: 'Loading current changes',
  error: 'Git status failed',
};
const fixture = [
  { path: 'src/session.ts', state: 'staged + unstaged', selected: true },
  { path: 'src/theme.css', state: 'staged', selected: false },
  { path: 'notes.md', state: 'untracked', selected: false },
];
let state;
const escape = (text) =>
  String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const button = (label, action, disabled = false, kind = '') =>
  `<button class="${kind}" data-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`;
const field = (label, value = '') => `<label>${label}<input value="${escape(value)}"></label>`;
const choose = (label, options) =>
  `<label>${label}<select>${options.map((x) => `<option>${escape(x)}</option>`).join('')}</select></label>`;
const active = () => state.scenario === 'running';
const integrating = () => state.scenario === 'conflict';
const git = () => state.scenario !== 'nonGit';
const unavailable = () => ['missing', 'loading', 'error'].includes(state.scenario);
const blocked = () => active() || integrating() || unavailable() || !git();
const selected = () => state.files.filter((file) => file.selected);
function reset() {
  const value = new URLSearchParams(location.search).get('variant');
  state = {
    variant: variants.includes(value) ? value : 'A',
    scenario: document.querySelector('#scenario').value || 'idle',
    tab: 'Current changes',
    workspace: false,
    panelOpen: true,
    worktree: 'main',
    file: 'src/session.ts',
    files: structuredClone(fixture),
    message: '',
    notice: '',
    ignored: false,
    revision: 1,
    integration: 'Rebase',
    recovery: false,
  };
  render();
}
function notice() {
  const text = {
    running: '2 Turns running. Pull and restore wait until they stop.',
    stale: 'Files changed. Review again.',
    hook: 'Commit failed: formatting required. Review changes and retry.',
    push: 'Committed; push failed. Sign in and retry Push.',
    diverged: 'Branches diverged. Choose Merge or Rebase.',
    conflict: `${state.integration} paused. Resolve src/session.ts to continue.`,
    recovery: 'Recovery storage full. Restore and discard unavailable.',
    partial: 'Copied src/session.ts. notes.md is locked; remaining files unchanged.',
    missing: 'Worktree missing. Locate it to continue.',
    incomplete: 'Turn 12 incomplete: notes.md unavailable.',
    nonGit: 'Local folder. Git unavailable.',
    loading: 'Loading changes…',
    error: 'Git unavailable. Check your installation and retry.',
  }[state.scenario];
  return [text, state.notice]
    .filter(Boolean)
    .map((x) => `<div class="notice" role="status">${escape(x)}</div>`)
    .join('');
}
function panel() {
  const history = ['Session history', 'Git history'].includes(state.tab);
  const files = state.tab === 'Files';
  return `<aside class="panel"><div class="tabs">${['Current changes', 'Session history', 'Git history', 'Files'].map((tab) => button(tab, `tab:${tab}`, !git() && tab !== 'Files', state.tab === tab ? 'selected' : '')).join('')}</div>
  <div class="section">${notice()}<div class="row end"><span class="path">${escape(state.worktree)} · /projects/spence</span>${button('Worktree ▾', 'worktree')}</div></div>
  <div class="panel-body"><div class="section">
  ${history ? choose('Comparison', state.tab === 'Session history' ? ['Turn 12 · main · before → after', 'Turn 11 · feature/search · before → after'] : ['a14e2 · Refine composer · terminal', '9c101 · Improve focus']) : ''}
  ${files ? `<h3>Project files</h3><label><input id="ignored" type="checkbox" ${state.ignored ? 'checked' : ''}> Show Git-ignored files · Project setting</label>` : `<h3>${history ? 'Observed files' : 'Current changes'}</h3><p class="muted">${history ? 'Observed changes; external writers may be included. Overlapping Turns may show the same changes.' : 'All writers · whole-file selection · selected saved contents include newer unstaged edits.'}</p>`}
  ${unavailable() ? button('Retry', 'retry') : `<ul class="files">${state.files.map((file, i) => `<li>${!files ? `<input type="checkbox" aria-label="Select ${file.path}" data-file="${i}" ${file.selected ? 'checked' : ''}>` : ''}<button data-action="file:${file.path}"><span class="path">${file.path}</span><br><small>${file.state}</small></button></li>`).join('')}${files && state.ignored ? '<li class="path">.env · ignored</li>' : ''}</ul>`}
  ${files ? `<div class="row">${button('New file / folder', 'new')}${button('Rename', 'rename')}${button('Delete', 'delete')}${button('Copy / move…', 'transfer', !git())}</div>` : button('Select all files', 'all')}
  ${history ? `<div class="row">${button('Restore historical files…', 'restore', blocked())}${state.tab === 'Git history' ? button('Revert commit…', 'revert', blocked() || state.files.length > 0) : ''}</div>${state.tab === 'Git history' && state.files.length ? '<small>Revert requires a clean Worktree and index. Use “Clean fixture” below to review it.</small>' + button('Clean fixture', 'clean') : ''}` : ''}
  </div><div class="section"><div class="row end"><span class="path">${escape(state.file)}</span>${button('Open externally', 'external')}</div><p class="muted">${history ? 'Retained observation · read-only' : files ? 'Live saved disk contents · read-only' : 'Reviewed current saved contents · staged + unstaged'}</p><pre class="diff">${state.scenario === 'incomplete' && state.file === 'notes.md' ? 'Contents unavailable — file was not retained.' : '- const label = "Changes";\n+ const label = "Current changes";\n+ showWorktreeName();'}</pre>${files ? '<small>Binary / large file: bounded preview or Open externally. Transfer is independent of preview eligibility.</small>' : ''}${button('Simulate external edit', 'edit')}</div>
  <div class="section">${state.tab === 'Current changes' && git() ? `<h3>Commit ${selected().length} selected files</h3><textarea id="commit-message" aria-label="Commit message" placeholder="Commit message">${escape(state.message)}</textarea><p class="muted">Unselected staged files stay staged. Push sends every pending branch commit, including commits made outside Spence.</p><div class="row">${button('Commit selected', 'commit', integrating() || unavailable() || !selected().length || !state.message.trim(), 'primary')}${button('Commit & push', 'commitPush', integrating() || unavailable() || !selected().length || !state.message.trim())}${button('Commit all…', 'commitAll', integrating() || unavailable() || !state.message.trim())}</div><div class="row">${button('Discard selected…', 'discard', blocked() || !selected().length, 'danger')}${button('Discard all…', 'discardAll', blocked() || !state.files.length, 'danger')}</div>` : ''}
  ${git() ? `<p class="muted">origin/main · 2 ahead · 1 behind</p><div class="row">${button('Fetch', 'fetch', unavailable())}${button('Pull…', 'pull', blocked())}${button('Push', 'push', integrating() || unavailable())}${button('Force push…', 'force', integrating() || unavailable(), 'danger')}</div>${integrating() ? `<div class="row">${button('Mark externally resolved', 'resolved')}${button('Continue', 'continue', !state.resolved)}${button('Abort…', 'abort')}</div>` : ''}` : ''}
  ${state.recovery ? button('Review recovery…', 'recover', blocked()) : ''}</div></div></aside>`;
}
function calmFileTree(menu) {
  const file = (path) =>
    `<div class="tree-file"><button class="path" data-action="browse:${path}">⌑ ${escape(path.split('/').at(-1))}</button>${menu(button('Open externally', 'external') + button('Rename…', 'rename') + button('Copy / move…', 'transfer', !git()) + button('Delete…', 'delete', false, 'danger'))}</div>`;
  if (state.browsedFile) {
    const contents =
      {
        'src/session.ts':
          'const composer = createComposer();\nconst label = "Current changes";\nshowWorktreeName();',
        'src/theme.css': '.composer {\n  border-radius: 24px;\n}',
        'src/app/app.ts': 'export class App {}',
        'src/app/app.html': '<main>\n  <app-shell />\n</main>',
        'README.md': '# Spence\n\nA quiet place to work with coding agents.',
        'package.json': '{\n  "name": "spence",\n  "private": true\n}',
        'notes.md': '# Notes\n\nKeep the conversation calm.',
        '.env': 'EXAMPLE_SETTING=local',
      }[state.browsedFile] ?? '';
    return `<div class="file-preview"><div class="row end">${button('‹ Files', 'backToTree')}${button('Open externally', 'external')}</div><p class="path">${escape(state.browsedFile)}</p><pre class="file-contents">${escape(contents)}</pre><small>Read-only · saved file</small></div>`;
  }
  return `<div class="file-tools row end"><span class="path muted">spence</span>${menu(button('New file / folder', 'new') + button(state.ignored ? 'Hide ignored files' : 'Show ignored files', 'toggleIgnored'))}</div><div class="file-tree" aria-label="Project files"><details open class="tree-folder"><summary class="path">src</summary><div class="tree-children"><details open class="tree-folder"><summary class="path">app</summary><div class="tree-children">${file('src/app/app.ts')}${file('src/app/app.html')}</div></details>${file('src/session.ts')}${file('src/theme.css')}</div></details>${file('README.md')}${file('package.json')}${file('notes.md')}${state.ignored ? file('.env') : ''}</div>`;
}
function calmPanel() {
  const files = state.tab === 'Files';
  const turn = state.tab === 'Session history';
  const commits = state.tab === 'Git history';
  const current = !files && !turn && !commits;
  const menu = (items) =>
    `<details class="more"><summary aria-label="More actions">···</summary><div class="menu">${items}</div></details>`;
  return `<aside class="panel calm-panel">
    <div class="calm-panel-top"><div class="segmented">${button('Changes', 'tab:Current changes', !git(), current || turn || commits ? 'selected' : '')}${button('Files', 'tab:Files', false, files ? 'selected' : '')}</div>${menu(button('Commits', 'tab:Git history', !git()) + button('Fetch', 'fetch', unavailable() || !git()) + button('Pull…', 'pull', blocked()) + button('Force push…', 'force', integrating() || unavailable() || !git(), 'danger') + (state.recovery ? button('Review recovery…', 'recover', blocked()) : ''))}${button('×', 'closePanel', false, 'icon')}</div>
    <div class="calm-context"><span class="path">${escape(state.worktree)}</span><span class="muted">${turn ? 'Turn 12 · before → after' : commits ? 'Commits' : git() ? '↑ 2 commits to push' : 'Local folder'}</span></div>
    <div class="calm-scroll">${notice()}
    ${turn ? `<div class="history-context">Turn 12 ${button('Back to current changes', 'tab:Current changes')}</div>` : ''}
    ${commits ? `<div class="commit-list">${button('a14e2 · Refine composer', 'commitDetail')}${button('9c101 · Improve focus', 'commitDetail')}</div>` : ''}
    ${files ? calmFileTree(menu) : unavailable() ? `<p class="muted">${state.scenario === 'loading' ? 'Loading changes…' : 'Changes unavailable'}</p>${button('Retry', 'retry')}` : state.files.map((file, index) => `<div class="calm-file"><div class="calm-file-row"><input type="checkbox" aria-label="Select ${file.path}" data-file="${index}" ${file.selected ? 'checked' : ''}><button class="file-name" data-action="file:${file.path}">${escape(file.path.split('/').at(-1))}<small>${escape(file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '')}</small></button><span class="path muted">${index === 0 ? '+18 −6' : index === 1 ? '+4 −2' : '+3'}</span>${menu(turn ? button('Restore historical files…', 'restore', blocked()) : button('Open externally', 'external') + button('Discard selected…', 'discard', blocked() || !selected().length, 'danger'))}</div>${state.file === file.path ? `<div class="inline-diff"><div class="diff-location path">@@ −1,2 +1,3 @@</div><pre>${state.scenario === 'incomplete' && file.path === 'notes.md' ? 'Contents unavailable' : '  1   const composer = createComposer();\n− 2   const label = "Changes";\n+ 2   const label = "Current changes";\n+ 3   showWorktreeName();'}</pre></div>` : ''}</div>`).join('')}
    ${integrating() ? `<div class="conflict-actions">${button('Open externally', 'external')}${button('Continue', 'continue', !state.resolved)}${button('Abort…', 'abort')}</div>` : ''}</div>
    ${current && git() ? `<div class="calm-commit"><textarea id="commit-message" aria-label="Commit message" placeholder="Commit message" rows="2">${escape(state.message)}</textarea><div class="row end">${menu(button('Select all files', 'all') + button('Commit all…', 'commitAll', !state.message.trim() || integrating()) + button('Commit & push', 'commitPush', !selected().length || !state.message.trim() || integrating()) + button('Discard all…', 'discardAll', blocked(), 'danger'))}<div class="row">${button('↑ Push 2', 'push', integrating() || unavailable())}${button('Commit', 'commit', !selected().length || !state.message.trim() || integrating() || unavailable(), 'primary')}</div></div></div>` : ''}
    ${turn ? `<div class="calm-commit">${button('Restore selected files…', 'restore', blocked())}</div>` : ''}
  </aside>`;
}
function calmShell() {
  return `<div class="shell layout-A calm ${state.panelOpen ? '' : 'panel-closed'}"><nav class="sidebar"><div class="brand">Spence <span class="muted">⌕</span></div><button class="new-session" data-action="send">＋ New Session</button><p>Today</p><button class="selected">Refine composer</button><button>Fix keyboard focus</button><button>Research accessibility</button><p>This week</p><button>Polish empty states</button><button>Keyboard shortcuts</button><div class="sidebar-bottom muted">⚙ Settings</div></nav>
    <main class="session"><div class="top"><span>Refine composer</span></div><div class="thread"><div class="message user">Make the composer quieter and keep the branch and changes of this worktree close at hand.</div>${button('✓ 4 steps · 2 changed files ›', 'receipt', !git(), 'receipt')}<div class="message">The branch now sits below the Composer, alongside the changes count. The conversation keeps its space.<p>The changes panel shows the files in this worktree, with their diffs one click away.</p><div class="turn-actions">${button('↶ Go back to here', 'goBack', !git())}</div></div><div class="message user">Yes. Keep the file list simple, too.</div><div class="message">I’ll keep the diff beside the conversation and tuck the other actions into menus.</div>${active() ? '<p class="muted path">◌ src/session.ts</p>' : ''}</div><div class="composer-wrap"><div class="composer"><textarea aria-label="Message" placeholder="Ask Spence…"></textarea><div class="row end"><div class="row">${button('＋', 'send')}${button('Ask', 'send')}${button('Claude · Sonnet ▾', 'send')}</div>${button(active() ? '■' : '↑', 'send', state.scenario === 'missing', 'primary send')}</div></div><div class="composer-bottom">${button(git() ? `⑂ ${state.worktree}` : 'Local folder', 'worktree', !git())}<span></span>${button(git() ? '+18 −6' : 'Files', 'workspace')}</div></div></main>${state.panelOpen ? calmPanel() : ''}</div>`;
}
function render() {
  document.querySelector('#app').innerHTML =
    `<div class="shell layout-${state.variant} ${state.workspace ? 'workspace' : ''}"><nav class="sidebar"><h3>Spence</h3><p>Project</p><button class="selected">spence ▾</button><p>Sessions</p><button class="selected">Refine composer</button><button>Fix keyboard focus ${active() ? '◌' : ''}</button><button>Research accessibility</button><p>Yesterday</p><button>Polish empty states</button></nav>
  <main class="session"><div class="top"><span>Refine composer</span>${button('Conversation', 'chat')}${button('Source control', 'workspace')}</div><div class="thread"><p class="muted">Today · Claude · Sonnet</p><div class="message user">Make the composer quieter and keep the worktree visible.</div><div class="message">The branch now sits below the message, alongside the changes count. The conversation keeps its space.</div>${button('⌄ 2 observed files · +18 −6 · Turn 12', 'receipt', !git(), 'receipt')}<p class="muted">${active() ? '◌ src/session.ts · 00:24' : 'Turn complete · 24s'}</p></div><div class="composer"><textarea aria-label="Message" placeholder="Continue the conversation…"></textarea><div class="row end"><span class="muted">Claude · Sonnet · Auto</span>${button(active() ? 'Stop' : 'Send', 'send', state.scenario === 'missing')}</div><div class="row">${button(git() ? `⑂ ${state.worktree} ▾` : 'Local folder', 'worktree', !git())}${button(git() ? `${state.files.length} changed files` : 'Files', 'workspace')}</div></div></main>${panel()}</div>`;
  if (state.variant === 'A') {
    document.querySelector('#app').innerHTML = calmShell();
    document.querySelectorAll('.thread .message.user').forEach((message, index) => {
      message.insertAdjacentHTML(
        'beforeend',
        `<div class="turn-actions"><button aria-label="Rewind to before this message" title="Rewind to before this message" data-action="rewindUser:${index}">↶</button></div>`,
      );
    });
    if (state.rewound) {
      document.querySelectorAll('.thread .message').forEach((message, index) => {
        if (index >= state.rewindKeep) message.remove();
      });
    }
  }
  document.querySelector('#variant-label').textContent =
    `${state.variant} · ${names[state.variant]}`;
  document.querySelector('#state').textContent = JSON.stringify(state, null, 2);
}
function modal(title, body, action, label = 'Review and confirm') {
  document.querySelector('#dialog-content').innerHTML =
    `<h2>${title}</h2>${body}<div class="row">${action ? button(label, action, false, 'primary') : ''}${button('Cancel', 'cancel')}</div>`;
  document.querySelector('#dialog').showModal();
}
function close() {
  document.querySelector('#dialog').close();
}
function review(kind) {
  const targets = ['discardAll', 'commitAll'].includes(kind) ? state.files : selected();
  state.review = { kind, revision: state.revision, paths: targets.map((file) => file.path) };
  const commit = kind.startsWith('commit');
  const title = commit
    ? 'Commit selected files?'
    : kind === 'restore'
      ? 'Restore files?'
      : kind === 'recover'
        ? 'Recover files?'
        : kind === 'abort'
          ? 'Abort ' + state.integration + '?'
          : 'Discard changes?';
  const subtitle = commit
    ? 'Commit saved contents; keep unselected staging.'
    : kind === 'restore'
      ? 'Replace selected files and leave them unstaged.'
      : kind === 'recover'
        ? 'Replace current files with the recovery copy.'
        : kind === 'abort'
          ? 'Return to the state before this operation.'
          : 'Restore tracked files to HEAD; delete selected untracked files.';
  let body =
    '<p>' +
    subtitle +
    '</p><div class="path">' +
    escape(state.worktree) +
    ' · a14e2</div><ul>' +
    targets
      .map(
        (file) =>
          '<li><code>' +
          escape(file.path) +
          '</code>' +
          (file.state === 'untracked' && kind.startsWith('discard') ? ' · delete' : '') +
          '</li>',
      )
      .join('') +
    '</ul>';
  if (commit) body += '<blockquote>' + escape(state.message) + '</blockquote>';
  if (kind === 'restore')
    body +=
      choose('From', ['Turn 12 · before', 'Turn 12 · after']) +
      choose('To Worktree', [state.worktree, 'feature/search']);
  if (
    kind === 'restore' &&
    state.scenario === 'incomplete' &&
    targets.some((file) => file.path === 'notes.md')
  )
    body = body.replace(subtitle, 'notes.md unavailable. Deselect it to restore other files.');
  const label =
    kind === 'commitPush'
      ? 'Commit & push'
      : commit
        ? 'Commit'
        : kind === 'restore'
          ? 'Restore files'
          : kind === 'recover'
            ? 'Recover files'
            : kind === 'abort'
              ? 'Abort ' + state.integration
              : 'Discard changes';
  modal(title, body, 'apply', label);
}
function action(name) {
  if (name.startsWith('rewindUser:')) {
    state.rewindKeep = Number(name.slice(11)) * 2;
    state.rewindBefore = true;
    action('goBack');
    return;
  }
  if (name.startsWith('browse:')) {
    state.browsedFile = name.slice(7);
    state.file = state.browsedFile;
    render();
    return;
  }
  if (name.startsWith('tab:')) {
    state.tab = name.slice(4);
    render();
    return;
  }
  if (name.startsWith('file:')) {
    state.file = name.slice(5);
    render();
    return;
  }
  switch (name) {
    case 'backToTree':
      state.browsedFile = undefined;
      break;
    case 'goBack':
      if (!state.rewindBefore) state.rewindKeep = 2;
      modal(
        state.rewindBefore ? 'Rewind to before this message?' : 'Rewind to after this reply?',
        `<p>This action is irreversible. Later messages, commits and edits—including other writers’ edits—will be lost.</p><ul><li><code>src/session.ts</code> · restore</li><li><code>src/theme.css</code> · restore</li><li><code>notes.md</code> · delete</li></ul><dl><dt>Messages to delete</dt><dd>${4 - state.rewindKeep}</dd><dt>Commits to remove</dt><dd class="path">b321a, c901b</dd><dt>Branch target</dt><dd class="path">main → ${state.rewindKeep === 0 ? '9c101' : 'a14e2'}</dd></dl>${active() ? '<div role="status">Wait for active Turns to stop.</div>' : ''}`,
        active() ? null : 'rewindRemote',
        'Review remote rewind',
      );
      state.rewindBefore = false;
      break;
    case 'rewindRemote':
      state.rewindRevision = state.revision;
      modal(
        'Rewind remote history too?',
        `<p>Irreversibly rewrite this shared branch with lease protection. All listed files, messages and commits will be rewound.</p><div class="path">origin/main · c901b → ${state.rewindKeep === 0 ? '9c101' : 'a14e2'}</div>`,
        'rewindApply',
        'Rewind everything',
      );
      break;
    case 'rewindApply':
      if (state.rewindRevision !== state.revision) {
        state.notice = 'Files changed after review. Review the rewind again.';
        close();
        break;
      }
      state.rewound = true;
      state.files = [];
      state.notice = 'Rewound files, messages and commits.';
      close();
      break;
    case 'closePanel':
      state.panelOpen = false;
      break;
    case 'toggleIgnored':
      state.ignored = !state.ignored;
      break;
    case 'commitDetail':
      modal(
        'Refine composer',
        '<p class="path">a14e2 · main</p><pre>− const label = "Changes";\n+ const label = "Current changes";</pre>' +
          button('Revert commit…', 'revert', blocked() || state.files.length > 0),
      );
      break;
    case 'cancel':
      close();
      break;
    case 'chat':
      state.workspace = false;
      break;
    case 'workspace':
      state.workspace = true;
      state.panelOpen = true;
      break;
    case 'receipt':
      state.tab = 'Session history';
      state.workspace = true;
      state.panelOpen = true;
      break;
    case 'all':
      state.files.forEach((file) => {
        file.selected = true;
      });
      break;
    case 'clean':
      state.files = [];
      break;
    case 'edit':
      state.revision++;
      state.notice = 'Live file contents updated. Historical observations stay unchanged.';
      break;
    case 'retry':
      state.scenario = 'idle';
      break;
    case 'external':
      state.notice = 'Open externally (preview).';
      break;
    case 'send':
      state.notice = 'Conversation preview.';
      break;
    case 'worktree':
      modal(
        'Session Worktree',
        `<p>Choose where this Session works.</p>${choose('Worktree', ['main · /projects/spence · 2 Sessions', 'feature/search · /projects/search'])}${button('Choose feature/search', 'switch', active())}${button('Create Worktree…', 'create')}${button('Locate missing folder…', 'locate')}${button('Remove Worktree…', 'remove', active())}`,
      );
      break;
    case 'switch':
      modal(
        'Review Summary handoff',
        '<p>Start a fresh Agent context; keep this conversation.</p><textarea aria-label="Summary">Continue refining the composer in the selected checkout.</textarea>',
        'switched',
        'Switch Worktree',
      );
      break;
    case 'switched':
      state.worktree = 'feature/search';
      state.scenario = 'idle';
      close();
      break;
    case 'locate':
      state.notice =
        'Prototype folder picker: explicitly locate or replace the missing checkout. No fallback to the Project folder.';
      close();
      break;
    case 'create':
      modal(
        'Create Worktree',
        field('Branch', 'feature/composer') +
          field('Destination folder', '/projects/composer') +
          choose('Start from', ['Current HEAD · a14e2', 'Existing eligible branch']) +
          '<p>Uncommitted changes stay in the original Worktree.</p>',
        'created',
        'Create',
      );
      break;
    case 'created':
      state.notice = 'Created feature/composer.';
      close();
      break;
    case 'remove':
      modal(
        'Remove Worktree',
        '<p>2 Sessions use this Worktree. Stop their Turns first.</p>' +
          choose('Action', [
            'Remove linked Worktree through Git · keep branch',
            'Delete folder from disk · clean stale registration',
          ]) +
          '',
      );
      break;
    case 'new':
      modal(
        'Create file or folder',
        field('Relative path', 'src/new-file.ts') + choose('Kind', ['File', 'Folder']),
        'fileDone',
        'Create',
      );
      break;
    case 'rename':
      modal(
        'Rename file',
        field('New relative path', 'src/composer.ts') + '',
        'fileDone',
        'Rename',
      );
      break;
    case 'delete':
      modal(
        'Delete selected file',
        `<p>Move this file to the recycle bin?</p><div class="path">${escape(state.file)}</div>`,
        'fileDone',
        'Move to recycle bin',
      );
      break;
    case 'transfer':
      modal(
        'Copy or move between Worktrees',
        choose('Operation', ['Copy', 'Move']) +
          choose('Destination Worktree', ['feature/search', 'main']) +
          field('Destination folder', 'src') +
          '<label><input type="checkbox"> Include ignored files</label>' +
          choose('File collision', [
            'Skip',
            'Keep both',
            'Replace · preview and recycle old destination',
          ]) +
          button('Preview folder collision', 'collision') +
          '',
        'fileDone',
        'Review transfer',
      );
      break;
    case 'collision':
      modal(
        'Folder already exists',
        '<p>Replace the destination folder, or merge their contents.</p>' +
          button('Replace completely', 'replaceFolder') +
          button('Merge', 'mergeFolder'),
      );
      break;
    case 'replaceFolder':
      modal(
        'Review complete replacement',
        '<p>Replaced files go to the recycle bin.</p><ul><li><code>src/legacy.ts</code> · remove</li><li><code>src/session.ts</code> · replace</li></ul>',
        'fileDone',
        'Replace completely',
      );
      break;
    case 'mergeFolder':
      modal(
        'Merge folders',
        choose('src/session.ts already exists', [
          'Skip',
          'Keep both',
          'Replace · recycle old contents',
        ]),
        'fileDone',
        'Merge',
      );
      break;
    case 'fileDone':
      state.notice = 'File operation complete.';
      close();
      break;
    case 'commit':
    case 'commitPush':
    case 'commitAll':
    case 'discard':
    case 'discardAll':
    case 'restore':
    case 'recover':
    case 'abort':
      review(name);
      break;
    case 'staleReview':
      state.revision++;
      document
        .querySelector('#dialog-content')
        .insertAdjacentHTML(
          'beforeend',
          '<p role="alert">Review invalidated: external file or index change. Apply will require another review.</p>',
        );
      break;
    case 'apply': {
      const reviewed = state.review;
      if (!reviewed) break;
      if (reviewed.revision !== state.revision) {
        state.notice = 'Review expired. Open a fresh preview.';
        close();
        break;
      }
      const kind = reviewed.kind;
      if (!kind.startsWith('commit') && state.scenario === 'recovery') {
        state.notice = 'Refused: required recovery could not be saved. No files changed.';
        close();
        break;
      }
      if (
        kind === 'restore' &&
        state.scenario === 'incomplete' &&
        reviewed.paths.includes('notes.md')
      ) {
        state.notice = 'Refused: selected contents unavailable. Deselect notes.md.';
        close();
        break;
      }
      if (kind.startsWith('commit') && state.scenario === 'hook') {
        state.notice =
          'Hook failed; review formatting changes before retry. Message and selection retained.';
        close();
        break;
      }
      if (kind.startsWith('commit')) {
        state.files = state.files.filter((file) => !reviewed.paths.includes(file.path));
        state.message = '';
        state.notice =
          kind === 'commitPush' && state.scenario === 'push'
            ? 'Committed; push failed. Retry Push without making another commit.'
            : 'Commit created. Unselected staging preserved.';
      } else {
        state.recovery = true;
        state.notice =
          'Simulated operation complete; recovery retained. Unselected files and staging preserved.';
      }
      if (kind === 'abort') {
        state.scenario = 'idle';
        state.notice = 'Integration aborted; conflict edits retained for reviewed recovery.';
      }
      close();
      break;
    }
    case 'fetch':
      state.notice = 'Fetched origin.';
      break;
    case 'push':
      modal(
        'Push branch',
        choose('Destination', ['Configured origin/main', 'Choose remote and branch…']) +
          '<p>Push all pending commits on this branch.</p>',
        'pushed',
        'Push',
      );
      break;
    case 'pushed':
      state.notice =
        state.scenario === 'push'
          ? 'Push failed: authentication required. Commit remains; retry Push after signing in.'
          : 'Normal push complete.';
      close();
      break;
    case 'force':
      modal(
        'Force push?',
        '<p>Replace remote history. Stops if the remote has changed.</p><div class="path">origin/main · c901b → a14e2</div>',
        'forced',
        'Force push with lease',
      );
      break;
    case 'forced':
      state.notice =
        state.scenario === 'stale'
          ? 'Force push refused: remote changed since review. Review again.'
          : 'Simulated lease-protected Force push complete.';
      close();
      break;
    case 'pull':
      if (state.files.length) {
        modal(
          'Pull requires a clean Worktree',
          '<p>Commit or discard your changes first.</p>',
          'cleanPull',
          'Use clean fixture',
        );
        break;
      }
      modal(
        'Pull',
        '<p>Choose how to integrate remote commits.</p>' +
          button('Merge · preserve history', 'merge') +
          button('Rebase · replay local commits', 'rebase') +
          button('Fast-forward only', 'ff'),
      );
      break;
    case 'cleanPull':
      state.files = [];
      close();
      action('pull');
      return;
    case 'merge':
    case 'rebase':
      state.integration = name === 'merge' ? 'Merge' : 'Rebase';
      state.scenario = 'conflict';
      state.resolved = false;
      state.notice = '';
      close();
      break;
    case 'ff':
      state.notice =
        state.scenario === 'diverged'
          ? 'Fast-forward refused: branches diverged. Choose Merge or Rebase explicitly.'
          : 'Fast-forward complete.';
      close();
      break;
    case 'resolved':
      state.resolved = true;
      state.notice = 'Fixture: conflicts resolved externally. Continue now available.';
      break;
    case 'continue':
      state.scenario = 'idle';
      state.notice = `${state.integration} continued with normal hooks. Push remains separate.`;
      break;
    case 'revert':
      modal(
        'Revert ordinary commit',
        '<p>Create a new commit reversing a14e2.</p>' +
          field('Commit message', 'Revert "Refine composer"') +
          '',
        'reverted',
        'Create reversal commit',
      );
      break;
    case 'reverted':
      state.integration = 'Revert';
      state.scenario = 'conflict';
      state.resolved = false;
      state.notice = 'Fixture: reversal encountered a conflict.';
      close();
      break;
  }
  render();
}
document.querySelector('#scenario').innerHTML = Object.entries(scenarios)
  .map(([key, label]) => `<option value="${key}">${label}</option>`)
  .join('');
document.querySelector('#scenario').addEventListener('change', reset);
document.querySelector('#reset').addEventListener('click', reset);
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (target) action(target.dataset.action);
});
document.addEventListener('change', (event) => {
  if (event.target.matches('[data-file]')) {
    state.files[Number(event.target.dataset.file)].selected = event.target.checked;
    render();
  }
  if (event.target.id === 'ignored') {
    state.ignored = event.target.checked;
    render();
  }
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'commit-message') {
    state.message = event.target.value;
    const start = event.target.selectionStart;
    render();
    const input = document.querySelector('#commit-message');
    input.focus();
    input.setSelectionRange(start, start);
  }
});
function cycle(direction) {
  state.variant =
    variants[(variants.indexOf(state.variant) + direction + variants.length) % variants.length];
  const url = new URL(location.href);
  url.searchParams.set('variant', state.variant);
  history.replaceState(null, '', url);
  render();
}
document.querySelector('#previous').addEventListener('click', () => cycle(-1));
document.querySelector('#next').addEventListener('click', () => cycle(1));
document.addEventListener('keydown', (event) => {
  if (
    event.target.closest('input,textarea,select,[contenteditable]') ||
    document.querySelector('dialog[open]')
  )
    return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    cycle(event.key === 'ArrowLeft' ? -1 : 1);
  }
});
reset();
