# Glossary

The domain language of Spence. Add a term here before using it in code; see `docs/adr/` for the decisions behind it.

- **Agent**: a program found on the user's PATH that speaks ACP and runs Sessions; it offers its own Models and modes
  (Claude Code, Codex, Gemini CLI). Not to be confused with a future parallel **Worker**.
- **ACP session**: the Agent's own session for a Session; replaceable, while the Session is the durable record.
- **Message**: one turn said within a Session, by the user or by the Agent.
- **Model**: a model an Agent offers for its Sessions.
- **Project**: a local folder added to Spence; it holds many Sessions, and they all run in that folder.
- **Session**: one conversation in a Project, bound to a single Agent for its lifetime. Switching Agent means a new Session.
- **DesktopApi**: the renderer's typed client for everything main offers; the only way the renderer reaches the desktop shell.
- **Domain**: one RPC group (`src/shared/<domain>`) with its handlers (`electron/rpc/<domain>.ts`).
- **Helm**: Spartan's styled component layer, generated into `src/app/ui` and imported as `@ui/<name>`.
