# Roadmap after v1

Status: candidates for the next Wayfinder maps, most important first. Unless linked to an active map, nothing here is decided. Each entry names the
problem, a first idea, and the question its map has to answer. v1 is `docs/specs/calm-session-view-v1.md`; items it
lists as out of scope (§12) are marked "(v1 §12)".

Words in **bold** are defined in `GLOSSARY.md`.

Item 1 is now being planned in [Wayfinder: context management, Agent switching and Session forks](https://github.com/ManuelUsoz/spence/issues/55).
The remaining entries are candidates; the map records item 1's agreed scope and open decisions.

## 1. Context usage, context management and visible compaction (v1 §12)

**Problem.** The user can't tell how full the Agent's context is, so they don't know when to Clear or Compact, and
an automatic compaction silently drops detail from earlier in the **Session**.

**First idea.** A quiet meter near the **Composer** that turns amber close to the limit. A marker in the thread where
context was compacted or cleared ("Context compacted here").

**Agreed planning scope.** Reported and estimated context usage, context management and visible compaction across
Claude, Codex and Antigravity ACP integrations. Include switching Agents within an existing Session through a
**Summary handoff**, and **Fork** with a chosen Agent / Model: a new Session in the same Project, started from a
summary, with its source preserved. Fork belongs to Spence and is independent of the ACP provider. Finish or cancel
the current Turn before switching or forking. Native ACP is allowed when available; a translation layer maps native
and packaged integrations into Spence's domain model, keeping protocol details behind the main-process boundary.
This is planned behavior, not a claim of current support.

**Questions for the map.** Which integrations and context signals are available? How should estimates, summary
handoffs, context boundaries, Agent ownership and fork lineage behave? The linked map owns these decisions.

## 2. Edit and retry a Turn with undo

**Problem.** Steering a wrong Turn means typing a correction on top of it. Users expect to fix the prompt instead.

**First idea.** Edit and resend the last prompt. Retry the last **Turn**. Fork a new Session from any past message.

**Queue messages.** Two modes for correctness Queue or Steer besides the edit last message sent. Queue stablish a FIFO queue for messages that will be sent in 1 by 1 in order when the agent answers. The order queue can be altered. Steer does not involve a queue and sends the message right away to steer. Last message sent pauses the chat, enables the edit bubble from the user message and re send the message. As lacking rewind if the edit the last message we put a modal confirming the revert of X files modify by the agent

**Question for the map.** ACP has no "rewind". Is editing done by forking (new ACP session, replay the transcript
up to that point)? What does a fork carry: messages only, or also the Agent's context? How does a fork show in the
sidebar?

## 3. Send message to another session or create a new one from an existing session to another project or to another worktree within the same repo

**Problem.** Devs often work in different repostories without being in a monorepo. Therefore a feature can involved N repositories. Therefore a good feature for spence would involve send messages between Sessions. The first iteration would involve human interaction, second interaction would be automatically with agents.

## 4. Persistent permission rules

**Problem.** v1 answers every **Permission request** once. Approving the same harmless command again and again is
noise, which is what Spence exists to remove.

**First idea.** "Always allow" on a request, scoped to the **Project**, listed and revocable in **Settings**.

**Question for the map.** Does the Agent's own "allow always" option suffice, or does main keep its own rules? How
narrow is a rule (exact command, prefix, tool)?

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
