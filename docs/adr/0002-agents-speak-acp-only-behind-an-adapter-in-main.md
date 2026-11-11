# 0002. Agents speak ACP only behind an adapter in main

Status: accepted

## Context

Spence runs coding Agents (Claude Code, Codex, Gemini CLI, ...) found on the user's PATH and talks to them over the
Agent Client Protocol. ACP is young and still changing, and later versions of Spence want several Agents per Session
and possibly other protocols. If ACP types leak into the renderer or into `src/shared`, every protocol change ripples
through the UI.

## Decision

- ACP types and the ACP SDK are used only in `electron/`, inside an adapter per protocol.
- ACP is spoken through the official `@agentclientprotocol/sdk` npm package, pinned to an exact version (it ships
  breaking majors often) and wrapped in an Effect service; we do not hand-roll the JSON-RPC.
- The renderer and `src/shared` see only Spence's own Session contract (Projects, Sessions, Messages, steps, errors),
  defined in `src/shared/` and exposed through `DesktopRpcs` like any other domain.
- Every Agent, whatever the vendor, is launched through its official `@agentclientprotocol/*` npm package.
- One shared client stack in `electron/acp/`, split like gemini-cli's `packages/cli/src/acp` but for the client side,
  with its camelCase file names (`acpSession.ts`) and otherwise this repo's conventions (`.spec.ts` next to each
  file, Effect services and `Schema`, no Zod of our own). Per-Agent folders hold only what differs:

  ```
  electron/acp/
    acpStdioTransport.ts        spawn the Agent package, connect its stdio through the SDK
    acpClientDispatcher.ts      our acp.Client: session updates and permission requests from the Agent
    acpSessionManager.ts        create, resume, close ACP sessions on one connection
    acpSession.ts               one live ACP session: prompt, cancel, config options, event hub
    acpMappers.ts               ACP <-> Spence Session contract
    acpErrors.ts                ACP error codes -> tagged errors
    agents/<agent>/             package, launch args, env, quirks (claude, codex, gemini, ...)
  ```

  gemini-cli's file-system service and command handler have no counterpart: Spence exposes no file system to
  Agents, and slash commands stay with the Agent.

- The adapter translates ACP into that contract and back; anything ACP offers that the contract doesn't model is
  dropped or folded there, not passed through.

## Consequences

- An ACP change touches the adapter only; a second protocol is a second adapter behind the same contract.
- The contract must be designed for what the UI needs, not mirrored from ACP.
- Features and their tests never depend on an Agent being installed: tests provide the contract with `makeDesktopTestLayer`.
