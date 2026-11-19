# Cross-device qualification: Codex

Status: **not qualified for cross-device.** No live run is recorded here. Codex takes Spence's MCP tools, so its
Sessions are offered the cross-device tools (`crossDeviceTools: true`); "not qualified" is a statement in this record
only and never changes what the app does.

Source: [Cross-device parity matrix and Agent Qualification](https://github.com/ManuelUsoz/spence/issues/192), spec
[LAN Devices](../specs/lan-devices.md). Format follows [rich-chat-composer.md](rich-chat-composer.md).

"Qualified for cross-device" needs every row below to read **Pass** for one exact adapter version. Live runs are opt-in
and never a CI gate.

## Adapter

| Item | Value |
| --- | --- |
| Adapter baseline | `@agentclientprotocol/codex-acp@2.6.0` (exact) |
| Version tested | _none yet_ |
| Date | _none yet_ |
| Cross-device tools | Offered (the adapter takes Spence's MCP tools over HTTP) |

## Automated evidence (fake Agent, every CI run)

`electron/lan/parity.spec.ts` runs every row below once Local and once Remote with the Spence fake ACP Agent and
asserts identical outcomes and Transcripts apart from Provenance. It says nothing about Codex itself.

## How to run the live probe

1. Install the adapter at the baseline above and log in.
2. Point `SPENCE_CODEX_ACP_BIN` at the folder that holds the adapter binary, and optionally `SPENCE_QUALIFICATION_OUT` at a
   folder for the result rows.
3. `npx vitest run electron/lan/parity.live.spec.ts` (uses real provider turns; expect several minutes).
4. Paste the rows it prints or writes over the table below, with the version and date. Rows the probe cannot ask a
   real Agent for reliably come back Unproven: they stay Unproven until a person checks them by hand.

## Live matrix

| Row | Case | Status | Notes |
| --- | --- | --- | --- |
| `turn` | a Message and the Agent's streamed answer | Unproven | No live run yet |
| `work` | the Agent's thoughts, Plan and Steps, and the sidebar following the Turn | Unproven | Not scriptable for a real Agent: check by hand |
| `permissions` | Permission requests answered Allow once, Always allow and Deny, with Attention | Unproven | No live run yet |
| `cancel` | Stop cancels the running Turn | Unproven | Not scriptable for a real Agent: check by hand |
| `queue-steer` | Queue, reorder, clear and steer | Unproven | Not scriptable for a real Agent: check by hand |
| `composer` | the unsent Composer draft is kept where the Session runs | Unproven | No live run yet |
| `options` | Agent, Model, Effort and Permission mode of a Session | Unproven | No live run yet |
| `lifecycle` | rename, archive, unarchive and delete a Session | Unproven | No live run yet |
| `context` | compact and clear the Agent's context, stop and restart the Agent | Unproven | No live run yet |
| `session-tools` | the Session and Worker tools: delegate, list_sessions and send_message | Unproven | No live run yet |
| `handoff` | a Summary handoff: prepare, review, fork | Unproven | No live run yet |
| `images` | images, audio, links and resources, shown on demand from a Remote device | Unproven | Not scriptable for a real Agent: check by hand |
| `commands` | the Agent's Skills and Commands in the Composer | Unproven | No live run yet |
| `files` | the Session's files: list and preview | Unproven | No live run yet |
| `projects` | add, rename, configure, check, locate and remove a Project by a browsed folder | Unproven | No live run yet |
| `execution-settings` | execution Settings: default Permission mode, auto-archive, per-Agent Model and Effort | Unproven | No live run yet |
| `agents` | the Agents, their install command and install | Unproven | No live run yet |
| `source-control` | Source control: changes, diffs, commits, revert, discard, branches, fetch, pull and push | Unproven | No live run yet |
| `worktrees` | Worktrees: list, and a draft Session moved into a new one | Unproven | No live run yet |
| `cross-device-tools` | the cross-device tools: targets by handle, send under Auto and Ask, await_result, start_session, refusals | Unproven | No live run yet |
| `human-messaging` | Send to another Session and Start a new Session in, from a person | Unproven | No live run yet |

## Manual lines

| Check | Status |
| --- | --- |
| Real-OS sleep and wake of the host while a Remote Session runs | Unproven |
| Two real computers on one LAN (discovery, firewall prompts) | Unproven |
