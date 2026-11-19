# 0004. Per-Project Tabs hold a split Pane tree of collapsible Panel stacks

Status: accepted

## Context

Spence previously modeled a Tab 1:1 with an open Session in a flat global list with no Tab strip, rendered one Session
at a time, and overlaid or replaced it with `Changes` and `Workers`. Working across multiple Sessions, Workers, and
Source Control views inside a Project requires viewing and organizing multiple surfaces side by side without conflating
Agent conversations with tool views.

## Decision

- **Per-Project Tabs and Tab strip**: each Project owns its own Tab strip at the top of the workspace. Switching
  Projects in the sidebar swaps both the sidebar Session list and the visible Tab strip while keeping other Projects'
  Tabs and running Sessions alive. Settings remains a global full-area view outside of Tabs.
- **Free-form Pane split tree (up to 4 Panes)**: each Tab holds a resizable binary split tree of up to four Panes with
  minimum size constraints. A Tab is not rigidly anchored to a single primary Session; it may hold zero, one, or
  multiple Sessions alongside other Panels.
- **Extensible Panel registry with Session kept as Agent conversation**: **Session** remains an Agent conversation
  (local, Worker, or Remote). Non-conversation views are modeled as Panel types behind an extensible registry
  (v1: `Session`, `Changes`, `Workers`).
- **Vertically collapsible Panel stacks**: each Pane holds one or more Panels. Multiple Panels in a Pane form a
  collapsible vertical stack where more than one Panel may stay expanded simultaneously (sharing vertical space with
  resizable dividers) and at least one Panel remains expanded.
- **Uniqueness and Session binding**: a Session may be open in at most one Panel at a time (opening it elsewhere
  focuses it, or moves it on drag). Auxiliary Panels (`Changes`, `Workers`) are pinned to a specific Session (with an
  optional header picker to re-bind) rather than following focus.
- **Per-Panel headers and indicators**: each Panel has a compact Panel header for its title, collapse toggle when
  stacked, and actions (replacing the single global Session Top bar). Attention and Working indicators bubble up to
  collapsed Panel headers, Tabs (Attention over Working), and the Project switcher; activating a Session auto-expands
  its Panel if collapsed.
- **Lifecycle and Store persistence**: closing a Panel collapses empty Panes and Tabs; closing a Tab leaves non-draft
  Sessions intact and running Turns alive; closing the last Tab shows an empty workspace state. Each Project's Tab
  strip, split tree, ratios, Panel stacks, and collapsed states are persisted in Spence's Store (draft Sessions are
  dropped on restart; deleted Sessions and removed Projects prune their Panels and Tabs).

## Considered Options

- **Tabbed pane groups (IDE editor groups, one visible Panel per Pane)**: rejected in favor of vertically collapsible
  Panel stacks so users can glance at or keep multiple Panels expanded in the same Pane simultaneously.
- **Tab anchored to one primary Session + auxiliary drawers**: rejected because it prevents side-by-side Sessions
  (e.g., a Parent Session alongside a Worker or two Worktree Sessions) in the same Tab.
- **Broadening Session to cover non-Agent tools (Terminal, Diff, etc.)**: rejected to keep Session, Transcript, Turn,
  and Attention clean and specific to Agent conversations while letting tool views evolve as Panel types.
- **Allowing the same Session in multiple Panels simultaneously**: rejected to avoid duplicate Composers, split scroll
  state, and conflicting Permission prompts.
- **Focus-following auxiliary Panels (`Changes`, `Workers`)**: rejected in favor of pinning them to a Session so users
  can compare two Sessions' Changes side by side or inspect one Session while reading another.
