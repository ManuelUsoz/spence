# 0008. Separate Issue tracker from Git host

Status: accepted

Spence integrates both **Git hosts** (Pull requests) and **Issue trackers** (Issues). For GitHub—the primary host in v1—both live on the same `owner/repo` and share the same `HostAuth` token and 5,000/hour rate limit, making it tempting to add Issues as capabilities on `GitHost` and reuse the `@` Composer picker.

We model **Issue tracker** as a separate domain concept from **Git host**, with its own `IssueTracker` port, `TrackerAuth` seam, `IssueTrackerError`, `ProjectSettings.issueTracker` **Tracker binding**, `Store` namespace, and `!` Composer picker, while delegating GitHub Issue authentication to `HostAuth.withToken('github')` and enforcing a shared GitHub rate-limit budget guard. Linear and Jira have no Git host, and Azure DevOps Boards can pair with a GitHub repository (and has no Git host adapter in v1), so coupling Issues to `GitHost` would break non-Git trackers and mixed pairings.

This split touches shared RPC contracts, `ProjectSettings`, cache layout, and the Composer triggers and is costly to reverse later; conversely, sharing `HostAuth` and the GitHub budget guard avoids duplicate sign-in ceremonies and rate-limit exhaustion without collapsing the two domain concepts.
