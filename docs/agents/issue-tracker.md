# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `ManuelUsoz/spence`. Use the `gh` CLI.

## Conventions

- Create: `gh issue create --title "..." --body "..."`.
  For multiline bodies, write the exact text to a temporary file and use `--body-file`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`,
  with appropriate `--label` and `--state` filters.
- Sub-issues: `gh issue create --parent <parent> ...` or
  `gh issue edit <parent> --add-sub-issue <child>` (`gh` 2.94+).
  For older versions, use `gh api --method POST
  repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`.
  If sub-issues are unavailable, put `Part of #<parent>` at the top of the child body.
- Blocking: use GitHub's native issue dependencies with
  `gh issue create --blocked-by <n>,<n> ...` or
  `gh issue edit <child> --add-blocked-by <blocker>` (`gh` 2.94+).
  For older versions, use `gh api --method POST
  repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
  Obtain the numeric database ID with
  `gh api repos/<owner>/<repo>/issues/<n> --jq .id`.
  If dependencies are unavailable, put `Blocked by: #<n>, #<n>` at the top of
  the child body. A ticket is unblocked when every blocker is closed.
- Count open blockers: `gh api repos/<owner>/<repo>/issues/<n> --jq
  .issue_dependencies_summary.blocked_by`, or filter `gh issue view <n>
  --json blockedBy` to nodes whose state is `OPEN`.
- Comment: `gh issue comment <number> --body "..."`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or
  `--remove-label "..."`.
- Close: post the explanation with `gh issue comment`, then run
  `gh issue close <number>`. `gh issue close --comment` can drop the comment
  on an already-closed issue.

Before the first issue creation in a session, check the target with
`gh repo view --json nameWithOwner`. File issues only in the user's own repo;
confirm the target with the user if it is not their repo.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set this to `yes` if external PRs should
enter the triage queue.

When enabled, read PRs with `gh pr view <number>`, `gh pr view <number>
--comments`, and `gh pr diff <number>`. List external open PRs with
`gh api --paginate 'repos/{owner}/{repo}/pulls?state=open'` and filter out
`OWNER`, `MEMBER`, and `COLLABORATOR` author associations. Use `gh pr comment`,
`gh pr edit`, and `gh pr close` to manage them. Issues and PRs share a number
space; resolve an ambiguous number with `gh pr view`, then `gh issue view`.

## Skill operations

- “Publish to the issue tracker”: create a GitHub issue.
- “Fetch the relevant ticket”: read it using the command above.

## Wayfinding operations

- A map is one issue labelled `wayfinder:map`, holding Notes, Decisions-so-far,
  and Fog.
- Child tickets are sub-issues labelled `wayfinder:<type>` (`research`,
  `prototype`, `grilling`, or `task`). If sub-issues are unavailable, add the
  child to a task list in the map and put `Part of #<map>` in its body.
- For the frontier, list open children, remove those with open blockers or an
  assignee, and choose the first in map order.
- Claim with `gh issue edit <n> --add-assignee @me` as the session's first write.
- Resolve by commenting the answer, closing the ticket, and appending a
  context pointer with a gist and link to the map's Decisions-so-far.
