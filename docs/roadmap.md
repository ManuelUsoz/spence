# Roadmap after v1

Status: candidates for the next Wayfinder maps, most important first. Nothing here is decided. Each entry names the
problem, a first idea, and the question its map has to answer. v1 is `docs/specs/calm-session-view-v1.md`; items it
lists as out of scope (§12) are marked "(v1 §12)".

Words in **bold** are defined in `GLOSSARY.md`.

## 1. Context usage meter and visible compaction (v1 §12)

**Problem.** The user can't tell how full the Agent's context is, so they don't know when to Clear or Compact, and
an automatic compaction silently drops detail from earlier in the **Session**.

**First idea.** A quiet meter near the **Composer** that turns amber close to the limit. A marker in the thread where
context was compacted or cleared ("Context compacted here").

**Question for the map.** What does `claude-agent-acp` report over ACP: token usage, the context window size,
compaction events? If it reports nothing, is there a usable estimate, or does the meter wait?

## 2. Edit, retry and fork

**Problem.** Steering a wrong Turn means typing a correction on top of it. Users expect to fix the prompt instead.

**First idea.** Edit and resend the last prompt. Retry the last **Turn**. Fork a new Session from any past message.

**Question for the map.** ACP has no "rewind". Is editing done by forking (new ACP session, replay the transcript
up to that point)? What does a fork carry: messages only, or also the Agent's context? How does a fork show in the
sidebar?

## 3. Changed files per Turn, with undo

**Problem.** The Agent edits files and the user can't easily see or reverse what one Turn did. This is the biggest
trust gap.

**First idea.** The **Receipt** lists the files each Turn changed. One action undoes a Turn's file changes.

**Question for the map.** Where does undo come from without worktrees (v1 §12): a snapshot taken by main before each
Turn, git stash, or the Agent's own checkpoints? What happens when the user edited the same files in between?

## 4. Persistent permission rules

**Problem.** v1 answers every **Permission request** once. Approving the same harmless command again and again is
noise, which is what Spence exists to remove.

**First idea.** "Always allow" on a request, scoped to the **Project**, listed and revocable in **Settings**.

**Question for the map.** Does the Agent's own "allow always" option suffice, or does main keep its own rules? How
narrow is a rule (exact command, prefix, tool)?

## 5. Queued messages

**Problem.** While a Turn runs the user often already knows the next step and has to wait to say it.

**First idea.** Typing in the Composer during a Turn queues the message and sends it when the Turn ends. Optionally,
"send now" injects it into the running Turn.

**Question for the map.** Does ACP allow a prompt during a running Turn, or only after? How is a queued message shown
and cancelled?

## 6. Hand off to a new Session with a summary

**Problem.** A long Session degrades. Clear loses everything and Compact is opaque.

**First idea.** "Continue in a new Session": the Agent writes a summary the user can edit, and it becomes the first
prompt of a fresh Session in the same Project, linked back to the old one.

**Question for the map.** Who writes the summary (the Agent through a prompt, or a fixed template)? Is this the same
feature as Compact, seen by the user?

## 7. Search across Sessions

**Problem.** Finding "where did we decide X" means opening Sessions one by one.

**First idea.** Search over transcripts, filtered by Project, opening the Session at the hit.

**Question for the map.** Scan the JSONL files on demand, or keep an index under `<userData>/spence/`? How large do
transcripts get?

## 8. Cost and time per Turn

**Problem.** The user has no sense of what a Turn cost or why it was slow.

**First idea.** Tokens, cost and duration on the Receipt, folded by default.

**Question for the map.** Same as item 1: what does the adapter report? Probably mapped together with the meter.

## 9. Pinned context

**Problem.** The same files or instructions get pasted into many Sessions of a Project.

**First idea.** Per-Project notes or files added to every new Session.

**Question for the map.** Is this just the Agent's own project instructions (`CLAUDE.md`), edited from Spence? If so,
the feature is an editor, not a new mechanism.

## 10. Export a Session

**Problem.** Sharing a Session means copying the thread by hand.

**First idea.** Export to Markdown: prompts, answers, the Steps folded into a summary.

**Question for the map.** Include images and tool output, or text only?
