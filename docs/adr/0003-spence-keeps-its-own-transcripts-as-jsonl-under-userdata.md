# 0003. Spence keeps its own Transcripts as JSONL files under userData

Status: accepted

## Context

Every Session needs a durable Transcript that outlives its Agent's memory. `Session.events({ afterSeq })` replays it
by sequence number, and the Transcript must survive a crash mid-Turn. Later efforts want Sessions that read or talk
to other Sessions, and Sessions running in worktrees of a Project.

## Decision

- All of Spence's domain data lives in `<userData>/spence/`: the Project list, Sessions, Transcripts, blobs, Agent
  logs and later Settings. The rest of `userData` belongs to Chromium. Spence's metadata never lives in a Project
  folder; explicit user-authorized Git and file operations may modify Project folders and Worktrees.
- Sessions are stored flat by global id (`spence/sessions/<sessionId>/`), not nested under their Project, so a
  Session can be referenced from anywhere and moving a Project never moves its Sessions. A Session's metadata keeps
  its `cwd` apart from its `projectId`; in v1 `cwd` is always the Project folder.
- A Transcript is one append-only JSONL file of `seq`-numbered events, encoded with Effect `Schema`. Binary parts
  (image, audio, blob resources) live in content-addressed sidecar files and are referenced by hash.
- Main is the only writer, guarded by Electron's single-instance lock. Lines are written whole, so other readers
  can read a Transcript while Spence runs. The format is documented and versioned, with forward-only migrations
  on first read. A file from a newer version is refused, never overwritten.

## Source-control planning refinement

The planned [source-control spec](../specs/source-control.md) keeps domain metadata, checkpoints and recovery in Store
while permitting the user-requested Project writes above. Ordinary Transcript writing remains append-only within a
generation; complete Session rewind may publish a retained Transcript prefix as a new generation only after local
restoration succeeds, with durable recovery, reader reset and old Agent-context invalidation. These are approved
planning constraints, not a claim that source control or rewind is already implemented.

## Considered Options

- **SQLite** (`better-sqlite3` or `node:sqlite`): a native module to rebuild per Electron version, or an unproven
  built-in. It is also harder for other processes to read.
- **One JSON document per Session, rewritten on each change**: not crash-safe while text streams, and costly on long
  Sessions.
- **`~/.spence/` or a `.spence/` folder per Project**: rejected in favour of the OS-standard app data folder, which
  e2e already isolates per run.
