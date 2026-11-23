# Glossary

The domain language of Spence. Add a term here before using it in code; see `docs/adr/` for the decisions behind it.

- **Agent**: a coding assistant Spence runs Sessions with through ACP, using a packaged adapter or native ACP support.
  It offers its own Models and modes. Not to be confused with a **Worker**.
- **Worker**: an assistant spawned by an Agent within a Session, with its own writable Session linked to the
  spawning **Parent Session**. Avoid: subagent.
- **Parent Session**: the Session in which a Worker was spawned. The relationship persists after the Worker stops
  working; it is distinct from a Fork's source Session.
- **Catalog**: the Agents Spence knows how to launch, written into Spence itself (v1: Claude).
- **Merged PATH**: the PATH Agents are resolved on and launched with: Spence's own PATH merged with the one the user's
  shell or Windows' registry sets, so an adapter installed after Spence started (or outside a terminal) is found.
- **Installed / not installed**: whether a Catalog Agent's adapter is on the merged PATH. Only installed Agents can
  run Sessions; a not-installed one is still shown, with a way to install it.
- **Agent status**: what state an Agent is in for the user: **ready**, **starting**, **not installed**, **needs login**,
  **can't start** (it never came up), or **stopped** (it was running and died). An Agent that is simply not running
  has no status worth showing; it starts when needed.
- **Qualification (of an Agent)**: verifying an exact Agent integration version and its required runtime dependencies
  on a target OS and architecture before treating it as supported. An **unverified** installed version that starts
  and speaks ACP v1 runs with a visible notice rather than breaking existing working setups.
- **Stop Agent**: forcefully terminating an Agent process tree when cancelling a Turn stalls, ending active Turns
  on that process as interrupted and requiring confirmed process exit before switching Agents or starting a Fork.
- **ACP session**: the Agent's own session for one Agent context; replaceable, while the Session is the durable record.
- **Agent context**: a stretch of a Session during which one Agent retains its conversational memory. Switching
  Agents, Clear, or lost memory starts a new Agent context; Compaction stays within the current one.
- **Context usage**: the Agent-reported number of tokens currently in its conversational memory, together with
  its reported context-window capacity when available. Distinct from cumulative Usage.
- **Usage**: token accounting and cost counters, such as cumulative input and output tokens; distinct from
  Context usage, which describes current conversational memory.
- **Handoff attempt**: preparation and startup for a Summary handoff, distinct from the committed conversation.
  A failed attempt remains inspectable from its source Session without changing that Session's current Agent.
- **Transcript**: Spence's own record of everything that happened in a Session. It outlives the Agent's memory:
  when that is cleared or lost, the Transcript keeps going and marks where the memory starts over.
- **Message**: text said within a Session, by the user or by the Agent.
- **Session-to-Session Message**: a Message addressed from one Session to another, with each Session identified to
  the other.
- **Image**: a picture in a Message, from the user or the Agent. The user _attaches_ Images to the Message they are
  writing; there is no separate attachment that outlives the Message. Only Agents that accept Images can be sent them.
- **Turn**: one incoming Message and everything the Agent does in response, until it stops. It ends with an outcome.
  Its Agent and Model attribution belongs to that Turn and does not change when the Session switches Agents.
- **Session status**: what state a Session is in: **idle** (no Turn, Compaction, or Summary handoff running, and neither blocked nor in error), **working** (a Turn, Compaction, or Summary handoff is actively progressing), **blocked** (waiting on the user's answer to a pending Permission request, a browser handoff, or a Message from another Session's Agent), or **error** (its last Turn failed, or its Agent stopped).
- **Working (a Session)**: a Session whose Turn, Compaction, or Summary handoff is actively progressing (not **blocked**). Quitting asks first while any Session has a running Turn (including one waiting on a Permission request).
- **Thread**: a Session's Transcript as the user reads it in the Session view: Messages and how each Turn ended, and
  in time the Ticker, Receipts, Notices and Clear marks. It never records the Agent's health.
- **Thought**: the Agent's reasoning during a Turn, kept apart from its Message so it can be folded away.
- **Step**: one action the Agent takes during a Turn (read, edit, run a command, ...). Never "tool call".
- **Plan**: the Agent's current to-do list for a Session, always replaced as a whole.
- **Compaction**: the Agent summarizing the older part of a Session to free room in its context; shown in the thread.
- **Notice**: a short message from the Agent beside its answer (info, warning, error), kept in the thread.
- **Clear**: giving a Session a fresh Agent context; the transcript stays, marked where the Agent's memory starts over.
  The same mark appears when the Agent's memory is lost, for example when it cannot restore a reopened Session.
- **Command**: an explicit action offered in the Composer, owned by Spence or the Agent's vendor. Invoking a Skill
  can be one such action.
- **Skill**: a named instruction pack an Agent can apply to a task, automatically or through explicit invocation.
  Invoking a Skill for a Message is distinct from enabling it for a Session.
- **Permission request**: the Agent asking before a Step; the user answers by picking one of its options.
- **Permission mode**: how much a Session may do without asking: **Ask** (the Agent asks as much as it can) or
  **Auto** (works without asking; the Agent may still check on risky Steps). Spence's own vocabulary, the same for
  every Agent; mapped onto the Agent's own auto mode where it has one, otherwise Spence answers Permission requests
  by it. The planned Agent admission policy makes Auto the default; Ask is optional.
- **Effort**: how hard the Agent thinks in a Session: low, medium, high, or max. Spence's own vocabulary; an Agent
  may offer only some levels, or none.
- **Model**: a model an Agent offers for its Sessions, named as the Agent names it.
- **Device**: one computer running Spence, owning its own Store, Projects, Sessions and Agent processes. The **Local
  device** is the one the window runs on; a **Remote device** is another Paired device the window is connected to.
  Avoid: Node, Environment, Machine, Host, Peer.
- **Pairing**: the one-time ceremony, started from the hosting Device with a short single-use code, after which two
  Devices trust each other in both directions. Nothing crosses Devices before it.
- **Paired device**: a Remote device that completed Pairing. Paired does not mean reachable: it can be offline, or
  not hosting.
- **Provenance**: who a Message came from when it crossed Devices: the sending Device, Project and Session, and
  whether a person or an Agent sent it. Shown on the receiving Session.
- **Cross-device message**: a Message sent from a Session on one Device to a Session on another, by a person or, when
  allowed, an Agent. It is Session-to-Session, distinct from driving a Remote device's Session in its own view.
- **Allow Agents from this Device**: a per-Paired-device setting, off by default, letting Agents on that Device send
  Messages or start Sessions here. Messages from a person always pass.
- **Project**: a folder on a Device added to Spence, holding many Sessions; a Git Project covers one repository and
  its Worktrees. Its name is Spence's own label (the folder name by default); renaming never touches the folder.
- **Worktree**: a checkout registered with a Git repository, selectable by Sessions in its Project; multiple Sessions
  may share one. Its lifetime is independent of the Sessions using it.
- **Current changes**: the staged, unstaged and non-ignored untracked changes in a Worktree, regardless of who made them.
- **Turn comparison**: the net changes between observations before and after a Turn in its Worktree; overlapping or
  external work may be included, so it does not establish Agent authorship.
- **Session history**: a Session's ordered Turn comparisons, each tied to its Worktree; it is not a cumulative Session diff.
- **Discard current changes**: returning explicitly selected current files and their staging to the current commit,
  including deleting explicitly selected untracked files.
- **Restore historical files**: replacing selected files with retained observed contents, leaving the result unstaged
  without changing branch or commit pointers.
- **Revert commit**: a new commit reversing one ordinary commit, preserving the earlier history.
- **Session rewind**: returning files, Git history and the conversation to a saved boundary, removing everything later
  in that conversation; irreversible after successful completion.
- **Rewind checkpoint**: saved file and, where applicable, Git state at a conversation boundary, usable for complete
  rewind only while all required contents and Worktree baselines remain available.
- **Git host**: an external hosting service for Git repositories (such as GitHub, GitLab, Bitbucket, or Azure DevOps),
  distinct from local source control. Avoid: provider, forge.
- **Host account**: the user's authenticated identity on a **Git host** on the **Local device**. Avoid: profile, login.
- **Remote repository**: a repository on a **Git host**, identified by its host and canonical path and linked to a
  **Project** through a Git remote. Avoid: repo, upstream.
- **Pull request**: a proposed change from a head branch to a base branch on a **Remote repository** (canonical term
  across all Git hosts, including Merge Requests). Avoid: MR, change request.
- **Review**: a submitted evaluation on a **Pull request** (approve, request changes, or comment), which may bundle
  inline **Review threads**.
- **Review thread**: an anchored conversation on a diff location of a **Pull request**, distinct from general
  conversation comments, which may be resolved or unresolved when the **Git host** supports it.
- **Check rollup**: the aggregated verification status outcome for a **Pull request**'s head commit (pending, passing,
  failing, or none), with individual check runs available on demand.
- **Issue tracker**: an external service that holds **Issues** (such as GitHub Issues, Azure DevOps Boards, Linear, or
  Jira), distinct from **Git host** because trackers such as Linear and Jira have no Git host. Avoid: provider, board.
- **Issue**: the canonical unit of tracked work on an **Issue tracker** (including Azure DevOps work items), keeping the
  tracker's state and type verbatim alongside a hidden open/closed status. Avoid: work item, ticket.
- **Tracker account**: the user's authenticated identity for an **Issue tracker** on the **Local device** (reusing a
  **Host account** credential where both share a service, such as GitHub). Avoid: profile, login.
- **Tracker project**: a container of **Issues** on an **Issue tracker** (such as a GitHub `owner/repo` or an Azure
  DevOps `org/project`). Avoid: board, repo.
- **Tracker binding**: a **Project**'s link to one **Tracker project** and a **Tracker scope**, owning the tracker kind
  and the shared cache identity across Projects with identical bindings.
- **Tracker scope**: an adapter-defined filter within a **Tracker project** (such as Entire project, a GitHub label or
  milestone, or an Azure Area Path, tag, or saved query), stored opaquely by Spence inside a **Tracker binding**.
  Avoid: scope.
- **Remove (a Project)**: Spence stops listing the Project; nothing on disk is deleted. Adding the same folder again
  brings it back with its Sessions.
- **Folder missing**: a Project whose folder is no longer where Spence left it. Its Sessions can still be read; the user
  **Locates** the folder to work in them again.
- **Settings**: the user's own choices for how Spence behaves everywhere: language, theme, notifications, the sidebar,
  defaults for new Sessions, and each Agent's default Model and Effort. A default is either **Last used** (what that
  Agent last ran with) or a value the user pinned. What Spence merely remembers is not a Setting.
- **Locale**: the language the renderer is built in (`en`, `es`); one build per Locale, and main loads one of them.
  Settings calls it **Language**.
- **Project settings**: a Project's overrides of Spence's Settings; anything a Project does not set comes from Settings.
- **Last used (a Project)**: when a Turn last started in any of its Sessions; opening a Tab does not count.
- **Session**: one conversation in a Project. In v1 it is bound to one Agent; the planned context-management work allows
  switching Agents within it through a Summary handoff while preserving its Transcript.
  A new Session is a **draft** until its first Message: it has a Tab and a placeholder row in the sidebar, but is
  not kept, and closing it leaves nothing behind.
- **Summary handoff**: a user-reviewed summary of the Transcript that gives an incoming Agent fresh context when
  switching Agents or starting a Fork; earlier Messages remain readable without becoming the Agent's memory.
- **Fork (a Session)**: a new Session in the same Project, started through a Summary handoff with a chosen Agent and
  Model, linked to the source's latest settled Turn. The source Session stays intact and the Project folder stays
  shared; Fork transfers conversation context, not an earlier state of the files. A Fork keeps its own transferred
  content even if its source is deleted.
- **Tab**: a workspace tab belonging to a Project, shown in that Project's **Tab strip**, holding a split layout of
  up to four **Panes**. Switching Projects swaps the visible Tab strip while keeping other Projects' Tabs and running
  Sessions alive.
- **Tab strip**: the bar at the top of the workspace listing the active Project's Tabs, with controls to switch,
  rename, close, or open a new Tab.
- **Pane**: one resizable split region within a Tab's layout holding one **Panel**. Avoid: quadrant, slot, container.
- **Panel**: the view surface inside a Pane (a **Session** — local, Worker, or Remote — or another registered view).
  A Session may be open in at most one Panel at a time; `Changes` and `Workers` open as full-Tab overlays replacing
  all Panes in that Tab until dismissed.
- **Panel header**: the borderless floating controls at the top of a Pane (in 1-Pane Tabs, compact action pills for
  `Changes`, `Workers`, `Split`, and `⋯` Session actions; when split into 2–4 Panes, per-Pane title drag handle,
  actions, and close). Fork is not there; it belongs to a Turn.
- **Archive (a Session)**: Spence moves the Session out of its Project's list into the Project's archived ones;
  nothing is lost and the Agent is not told. An archived Session never calls for Attention, and sending it a Message
  brings it back. **Auto-archive** does the same to Sessions left idle for a number of days, when the user turns it on.
- **Title (of a Session)**: the name a Session is listed by. The Agent gives it once the conversation starts and
  may change it later; if the Agent gives none by the end of the first Turn, it is the start of the first Message.
  Until then the Session is **untitled**, shown as a muted "New Session" (a draft's row is italic).
- **Rename (a Session)**: the user giving a Session their own title, in place in the sidebar or Panel header; it wins
  over any title Spence or the Agent would set.
- **Delete (a Session)**: Spence forgets the Session for good, Transcript included, and asks the Agent to forget its
  side too. Its handoff attempts and Worker descendants are removed; independent Forks survive. Not undoable.
- **Attention**: a Session calling the user back, for one of two causes only: its Session status is **blocked** or
  **error**. Nothing else calls the user back; there is no "seen" or "unread".
- **Notification**: a transient alert emitted when a Session not currently visible in the focused window transitions to
  **blocked**, transitions to **error**, or finishes a Turn (unless cancelled by the user or a normal Worker Turn
  completion), routed to notification channels (OS notification when unfocused, in-app toast when focused, and future
  channels such as voice).
- **Browser**: the embedded web side pane bound to a local Session, hosted in Electron `WebContentsView` instances
  under a shared `persist:spence-browser` partition with no preload script and denied hardware permissions. Remote
  Sessions disable it.
- **Page**: one web page open inside a Session's **Browser** (its own URL, title, loading state, navigation history,
  and `WebContentsView`), switchable via the Page strip.
- **Browser handoff**: an Agent pausing its Turn on the embedded **Browser** so the user can complete a step (such as
  signing in or solving a verification gate), putting the Session in **blocked** (and raising **Attention**) until the
  user continues the Agent or cancels.
- **Composer**: where the user writes the next Message of a Session. It is always shown, whatever state the Agent is in.
- **Agent bar**: the Agent status shown as a notice on top of the Composer (not installed, needs login, can't start),
  with its one action. It never replaces the Composer; Send waits until the Agent is ready.
- **Ticker**: the single line a running Turn shows in the thread: a fixed spinner, an icon for the kind of Step or for
  thinking, and only the target. No changing state words; never a list.
- **Dock**: the place just above the Composer for what a running Turn wants from the user: a pending Permission
  request, otherwise the Plan's progress. Empty when no Turn runs.
- **Receipt**: what a finished Turn folds into, under its reply: observed changed files first when available, then the
  Steps and the Thought on demand; Agent-reported diffs remain attached to their Steps.
- **DesktopApi**: the renderer's typed client for everything main offers; the only way the renderer reaches the desktop shell.
- **Store**: Spence's own files under `<userData>/spence/`, written only by main: versioned JSON files, lenient
  settings-style files, JSONL Transcripts and content-addressed blobs. A file from a newer Spence is refused, never
  overwritten.
- **Domain**: one RPC group (`src/shared/<domain>`) with its handlers (`electron/rpc/<domain>.ts`).
- **Helm**: Spartan's styled component layer, generated into `src/app/ui` and imported as `@ui/<name>`.
