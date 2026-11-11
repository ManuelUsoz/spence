# Glossary

The domain language of Spence. Add a term here before using it in code; see `docs/adr/` for the decisions behind it.

- **Agent**: a coding assistant Spence runs Sessions with, always through its official ACP adapter (`@agentclientprotocol/*`);
  an assistant without one is not an Agent. It offers its own Models and modes. Not to be confused with a future
  parallel **Worker**.
- **Catalog**: the Agents Spence knows how to launch, written into Spence itself (v1: Claude).
- **Installed / not installed**: whether a Catalog Agent's adapter is on the user's PATH. Only installed Agents can
  run Sessions; a not-installed one is still shown, with a way to install it.
- **Agent status**: what state an Agent is in for the user: **ready**, **starting**, **not installed**, **needs login**,
  **can't start** (it never came up), or **stopped** (it was running and died). An Agent that is simply not running
  has no status worth showing; it starts when needed.
- **ACP session**: the Agent's own session for a Session; replaceable, while the Session is the durable record.
- **Transcript**: Spence's own record of everything that happened in a Session. It outlives the Agent's memory:
  when that is cleared or lost, the Transcript keeps going and marks where the memory starts over.
- **Message**: text said within a Session, by the user or by the Agent.
- **Turn**: one user Message and everything the Agent does in response, until it stops; it ends with an outcome.
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
- **Project**: a local folder added to Spence; it holds many Sessions, and they all run in that folder.
- **Session**: one conversation in a Project, bound to a single Agent for its lifetime. Switching Agent means a new Session.
  A new Session is a **draft** until its first Message: it has a Tab but is not kept or listed, and closing it leaves
  nothing behind.
- **Tab**: a Session open in the window. Closing a Tab leaves the Session and its Agent alive.
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
- **Domain**: one RPC group (`src/shared/<domain>`) with its handlers (`electron/rpc/<domain>.ts`).
- **Helm**: Spartan's styled component layer, generated into `src/app/ui` and imported as `@ui/<name>`.
