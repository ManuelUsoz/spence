---
name: release
description: Cut a Spence release or release candidate. Use when the user asks to create, bump, tag, or publish a release or RC to trigger the GitHub Release workflow.
---

# Release

Cut a Spence release or release candidate (`vX.Y.Z` or `vX.Y.Z-rc.N`) and push the tag to trigger [`.github/workflows/release.yml`](../../../.github/workflows/release.yml).

## Version rules

- Format: `X.Y.Z` (full release) or `X.Y.Z-rc.N` (GitHub prerelease), matching tag `v<version>`.
- No leading zeros; `N` is `1` to `99999999` (8 digits max for Squirrel).
- Versions must strictly increase over published releases (`compareReleaseVersions` in [`electron/updates/releases.ts`](../../../electron/updates/releases.ts)); all releases share one update stream.

## Steps

1. **Sync `main` and check state.**
   Verify the current branch is `main` and tracked source files are clean (`git status --short`; ignore nested `.worktrees/` entries). If on another branch or tracked files have unintended edits, stop and ask.
   Run `git fetch origin --tags && git pull --ff-only origin main`.
   Check the current version in `package.json`, existing tags (`git tag --sort=-v:refname`), and `gh release list -L 5`.

2. **Resolve the target version.**
   - Explicit version given: validate it against the version rules and confirm it is strictly newer than existing releases.
   - Next release candidate from `X.Y.Z-rc.N`: bump to `X.Y.Z-rc.(N+1)`.
   - Graduate `X.Y.Z-rc.N` to final: set `X.Y.Z`.
   - New RC from stable `X.Y.Z` with no level specified: ask the user whether to bump patch, minor, or major.
   Confirm `v<version>` does not exist locally or on `origin`.

3. **Bump `package.json` and `package-lock.json`.**
   Run `npm version <version> --no-git-tag-version` so both files stay in lockstep before verification.
   Completion: `git diff package.json package-lock.json` shows only the expected version change.

4. **Verify.**
   Run `npm run verify` and confirm it prints `verify: OK`. Resolve any failures before committing or tagging.

5. **Commit, tag, and push.**
   Stage `package.json` and `package-lock.json` explicitly by path.
   Commit with `Release v<version>`, create an annotated tag `git tag -a "v<version>" -m "Release v<version>"`, and push `git push origin main` then `git push origin "v<version>"`.
   Completion: both `main` and `v<version>` are pushed to `origin`.

6. **Confirm workflow execution.**
   Run `gh run list --workflow=release.yml -L 3` to verify the `Release` workflow started for `v<version>`, and report the tag, commit SHA, and workflow run link/ID.
