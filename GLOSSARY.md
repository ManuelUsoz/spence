# Glossary

The domain language of Spence. Add a term here before using it in code; see `docs/adr/` for the decisions behind it.

- **Agent**: a coding assistant Spence runs Sessions with, always through its official ACP adapter (`@agentclientprotocol/*`);
  an assistant without one is not an Agent. It offers its own Models and modes. Not to be confused with a future
  parallel **Worker**.
- **Catalog**: the Agents Spence knows how to launch, written into Spence itself (v1: Claude).
- **Merged PATH**: the PATH Agents are resolved on and launched with: Spence's own PATH merged with the one the user's
  shell or Windows' registry sets, so an adapter installed after Spence started (or outside a terminal) is found.
- **Installed / not installed**: whether a Catalog Agent's adapter is on the merged PATH. Only installed Agents can
  run Sessions; a not-installed one is still shown, with a way to install it.
- **Agent status**: what state an Agent is in for the user: **ready**, **starting**, **not installed**, **needs login**,
  **can't start** (it never came up), or **stopped** (it was running and died). An Agent that is simply not running
  has no status worth showing; it starts when needed.
- **ACP session**: the Agent's own session for a Session; replaceable, while the Session is the durable record.
- **Transcript**: Spence's own record of everything that happened in a Session. It outlives the Agent's memory:
  when that is cleared or lost, the Transcript keeps going and marks where the memory starts over.
- **Message**: text said within a Session, by the user or by the Agent.
- **Image**: a picture in a Message, from the user or the Agent. The user _attaches_ Images to the Message they are
  writing; there is no separate attachment that outlives the Message. Only Agents that accept Images can be sent them.
- **Turn**: one user Message and everything the Agent does in response, until it stops; it ends with an outcome.
- **Working (a Session)**: a Session whose Turn is running, including one waiting on a Permission request. Quitting
  asks first while any Session is working.
- **Thread**: a Session's Transcript as the user reads it in the Session view: Messages and how each Turn ended, and
  in time the Ticker, Receipts, Notices and Clear marks. It never records the Agent's health.
- **Thought**: the Agent's reasoning during a Turn, kept apart from its Message so it can be folded away.
- **Step**: one action the Agent takes during a Turn (read, edit, run a command, ...). Never "tool call".
- **Plan**: the Agent's current to-do list for a Session, always replaced as a whole.
- **Compaction**: the Agent summarizing the older part of a Session to free room in its context; shown in the thread.
- **Notice**: a short message from the Agent beside its answer (info, warning, error), kept in the thread.
- **Clear**: giving a Session a fresh Agent context; the transcript stays, marked where the Agent's memory starts over.
  The same mark appears when the Agent's memory is lost, for example when it cannot restore a reopened Session.
- **Command**: a slash command the Agent offers in a Session (`/name args`), sent as Message text.
- **Permission request**: the Agent asking before a Step; the user answers by picking one of its options.
- **Permission mode**: how much a Session may do without asking: **Ask** (the Agent asks as much as it can) or
  **Auto** (works without asking; the Agent may still check on risky Steps). Spence's own vocabulary, the same for
  every Agent; mapped onto the Agent's own auto mode where it has one, otherwise Spence answers Permission requests
  by it.
- **Effort**: how hard the Agent thinks in a Session: low, medium, high, or max. Spence's own vocabulary; an Agent
  may offer only some levels, or none.
- **Model**: a model an Agent offers for its Sessions, named as the Agent names it.
- **Project**: a local folder added to Spence; it holds many Sessions, and they all run in that folder. Its name is
  Spence's own label for it (the folder name by default); renaming never touches the folder.
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
- **Session**: one conversation in a Project, bound to a single Agent for its lifetime. Switching Agent means a new Session.
  A new Session is a **draft** until its first Message: it has a Tab and a placeholder row in the sidebar, but is
  not kept, and closing it leaves nothing behind.
- **Tab**: a Session open in the window. Closing a Tab leaves the Session and its Agent alive.
- **Archive (a Session)**: Spence moves the Session out of its Project's list into the Project's archived ones;
  nothing is lost and the Agent is not told. An archived Session never calls for Attention, and sending it a Message
  brings it back. **Auto-archive** does the same to Sessions left idle for a number of days, when the user turns it on.
- **Title (of a Session)**: the name a Session is listed by. The Agent gives it once the conversation starts and
  may change it later; if the Agent gives none by the end of the first Turn, it is the start of the first Message.
  Until then the Session is **untitled**, shown as a muted "New Session" (a draft's row is italic).
- **Rename (a Session)**: the user giving a Session their own title, in place in the sidebar; it wins over any title
  Spence or the Agent would set.
- **Sidebar layout**: a Setting for how the sidebar lists Sessions: **One Project** (the default; one Project at a time
  behind a Project switcher) or **All Projects** (every Project, its most recent Sessions first).
- **Delete (a Session)**: Spence forgets the Session for good, Transcript included, and asks the Agent to forget its
  side too. Not undoable.
- **Attention**: a Session calling the user back, for one of two causes only: it _needs an answer_ (a pending
  Permission request) or it hit an _error_ (its last Turn failed, or its Agent stopped). Nothing else calls the user
  back; there is no "seen" or "unread".
- **Composer**: where the user writes the next Message of a Session. It is always shown, whatever state the Agent is in.
- **Agent bar**: the Agent status shown as a notice on top of the Composer (not installed, needs login, can't start),
  with its one action. It never replaces the Composer; Send waits until the Agent is ready.
- **Ticker**: the single line a running Turn shows in the thread: a fixed spinner, an icon for the kind of Step or for
  thinking, and only the target. No changing state words; never a list.
- **Dock**: the place just above the Composer for what a running Turn wants from the user: a pending Permission
  request, otherwise the Plan's progress. Empty when no Turn runs.
- **Receipt**: what a finished Turn folds into, under its reply: changed files first (each opens its diff), then the
  Steps and the Thought on demand.
- **DesktopApi**: the renderer's typed client for everything main offers; the only way the renderer reaches the desktop shell.
- **Store**: Spence's own files under `<userData>/spence/`, written only by main: versioned JSON files, lenient
  settings-style files, JSONL Transcripts and content-addressed blobs. A file from a newer Spence is refused, never
  overwritten.
- **Domain**: one RPC group (`src/shared/<domain>`) with its handlers (`electron/rpc/<domain>.ts`).
- **Helm**: Spartan's styled component layer, generated into `src/app/ui` and imported as `@ui/<name>`.
