# 0004. Per-Project Tabs hold a split Pane tree (1 Panel per Pane) with full-Tab tool overlays

Status: accepted (updated: Panel stacks removed; Changes and Workers open as full-Tab overlays)

## Context

Spence previously modeled a Tab 1:1 with an open Session in a flat global list with no Tab strip, rendered one Session
at a time, and overlaid or replaced it with `Changes` and `Workers`. Working across multiple Sessions inside a Project
requires viewing and organizing multiple Session surfaces side by side without conflating Agent conversations with full-width
tool views.

## Decision

- **Per-Project Tabs and Tab strip**: each Project owns its own Tab strip at the top of the workspace, paired with an
  MRU Windows-style `Ctrl+Tab` Tab switcher. Switching Projects in the sidebar swaps both the sidebar Session list and
  the visible Tab strip while keeping other Projects' Tabs and running Sessions alive. Settings remains a global
  full-area view outside of Tabs.
- **Free-form Pane split tree (up to 4 Panes, 1 Panel per Pane)**: each Tab holds a resizable binary split tree of up to
  four Panes with minimum size constraints. Each Pane holds a single Panel (no vertical Panel stacks); dragging a Panel
  onto the center of another Pane swaps their contents, while dragging onto an edge splits.
- **Full-Tab `Changes` and `Workers` overlays**: `Changes` and `Workers` open as full-Tab views replacing all Panes in
  that Tab with a Back header (`< Session / Changes` or `/ Workers`), keeping the Tab's underlying split Pane tree
  intact. Clicking a Worker exits the overlay and splits beside its Parent Session (or opens a new Tab at 4 Panes).
- **Uniqueness and floating per-Pane controls**: a Session may be open in at most one Panel at a time (opening it
  elsewhere focuses it). A single-Pane Tab floats compact top-right action pills without duplicating the Tab title or `×`
  button; split Tabs (2–4 Panes) surface per-Pane title drag handles and `×` close buttons.
- **Lifecycle and Store persistence**: closing a Panel collapses empty Panes and Tabs; closing a Tab leaves non-draft
  Sessions intact and running Turns alive; closing the last Tab shows an empty workspace state. Each Project's Tab
  strip, split tree, ratios, and per-Session background assignments are persisted in Spence's Store (draft Sessions are
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
