# Public repository readiness

Tracking: [#230](https://github.com/ManuelUsoz/spence/issues/230), part of [#228](https://github.com/ManuelUsoz/spence/issues/228). This is a release gate, not authorization to change visibility. Record the reviewer, date, evidence and any unresolved exceptions privately; do not put credentials or sensitive findings in an issue or this document.

## Review before changing visibility

- Inventory the current tree, all branches and tags, Git history and GitHub-hosted material that will become visible, including issues, pull requests, releases, Actions logs and artifacts. Include deleted files and old commits. Check personal data, private URLs, credentials, signing material and third-party content. Review the license and attribution of assets and dependencies.
- Run a reputable secret scanner over the full reachable history and current tree, then manually review its findings and content it cannot assess. A clean scan alone is not proof that the repository is safe. Review any additional refs and objects that GitHub may expose, including pull request refs. The local checkout is not necessarily a complete inventory of GitHub data.
- For every exposed credential, revoke or rotate it at the provider and assess access before addressing the repository copy. Coordinate any history rewrite and cleanup of hosted copies with maintainers; rewriting history does not invalidate a credential or remove copies and caches. Re-scan and document resolution privately. Do not make the repository public until the review and remediation are complete.
- Retain the Apache 2.0 license. Confirm the final public tree and history after remediation.

## GitHub settings to configure and verify

Some controls depend on repository visibility, plan and account permissions. An administrator must check availability and effective behavior, including organization policies and bypass actors. If a required control cannot be enabled while private, prepare its configuration and coordinate the visibility change and immediate enablement; do not claim there is uninterrupted protection without verifying it. Resolve the exposure window before proceeding.

- Protect the default branch: require pull requests and the stable `CI` status check to pass, require zero approvals while there is one maintainer, block force pushes and deletion, and limit bypass to explicitly authorized maintainers. Exercise a test PR and confirm an unsuccessful or missing check blocks merging. Revisit approvals when maintainers are added.
- Restrict creation, update and deletion of release tags to authorized maintainers using an applicable tag ruleset. Restrict release publication and any publishing credentials or environments to authorized maintainers. Verify unauthorized actors cannot create or move a release tag or publish. Keep update signing keys outside Actions, as required by #228.
- Keep Actions token permissions at read-only by default, and grant only the permissions needed by individual jobs. Require approval before workflows run for **all external contributors**, including first-time and repeat contributors. Review workflow changes before approving runs; verify the effective setting and test the external contribution path. Review allowed actions, runner access, secrets and environment protections before publication.
- Enable available free Dependabot alerts, secret scanning, push protection and code scanning. Verify each is active and has scanned the intended default branch; investigate and resolve findings. Where a feature becomes available only after visibility changes, enable and verify it as part of the coordinated change, and record any unavailable control and mitigation.
- Recheck protections, bypasses, scanning and workflow approval after the change. Record the actual required check names from a completed PR, and verify that a skipped, cancelled or failed verification cannot satisfy the gate. Repeat this review when workflows or repository access change.

## Read-only snapshot, 2026-11-20

The GitHub API reported `ManuelUsoz/spence` private with default branch `main`. Default Actions workflow permissions were `read`, and Actions could not approve pull request reviews. Actions were enabled and all actions allowed. The dependency-alert endpoint reported alerts disabled; secret scanning reported disabled and code scanning reported not enabled. The branch protection and ruleset endpoints returned HTTP 403 indicating a plan upgrade or public visibility is needed; their effective configuration was not established. Push protection, external-contributor approval, publishing permissions, bypass actors and hosted content were not verified.

The checked-in CI workflow declares `contents: read` and exposes a stable `CI` job; confirm its behavior and exact status context on GitHub before requiring it. The repository contains an Apache 2.0 `LICENSE`.

## Local and GitHub-hosted audit, 2026-11-21

- **Git history & tree**: Targeted scans across all reachable Git commits (`git log --all -G ...` for `ghp_`, `github_pat_`, `gho_`, `sk-`, `sk-ant-`, `AKIA`, `AIza`, `xoxb-`/`xoxp-`, `BEGIN RSA/EC/OPENSSH/PGP/DSA PRIVATE KEY`) found zero exposed credentials. Commit `1995f2a` matches only runtime TLS certificate generation in `electron/devices/certificate.ts`. All commit author emails use `@users.noreply.github.com`.
- **Personal paths & leftover entries on `main`**: `docs/qualification/workers-antigravity-1.5.7.md` line 7 contains a local Windows username path (`C:\Users\miuso\...`), and `main` contains tracked `.worktrees/*` gitlinks / `.worktrees/issue-103-partial.patch` worth reviewing/cleaning before making the repository public.
- **GitHub-hosted material**: Scanned all 247 issues/PRs, 156 issue comments, and 0 PR review comments via `gh api`: zero credential pattern hits. Repository has 0 releases, 0 tags, 0 Actions secrets, 0 Actions variables, 0 environments, 0 deploy keys, and 49 CI workflow artifacts (`app-build` / `e2e-report-*`).
- **Remaining before switching visibility**: Run a dedicated secret scanner (such as `gitleaks`) over the full repository and history, review the two hygiene items above and third-party dependency/asset licenses, then enable GitHub branch protection, tag ruleset, fork-PR approval policy, and security scanning immediately on going public.
