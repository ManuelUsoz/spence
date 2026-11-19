# Research: GitHub Auth, APIs, and npm Packages for Electron PR Integration

**Ticket:** [#195 — Research GitHub auth, APIs, and npm packages for Electron PR integration](https://github.com/ManuelUsoz/spence/issues/195)
**Map:** [#194 — Wayfinder: Git host integration, Pull requests and Composer PR context](https://github.com/ManuelUsoz/spence/issues/194)
**Target stack:** Electron `^45.3.0` (`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, strict CSP), Node `>=20` (`esbuild` CJS bundle for `electron/main.ts`), Effect `4.1.3`, TypeScript `~6.0.2` (`strict`, `moduleResolution: "bundler"`).

---

## Executive Summary & Recommendations

| Decision area | Recommendation | Why |
| :--- | :--- | :--- |
| **Primary auth flow** | **GitHub OAuth App + Device Flow** (`repo`, `read:org`) | Zero-secret public `client_id`; opens `https://github.com/login/device` via `shell.openExternal` (no local callback server or custom protocol handler); works across all user-accessible repos without requiring org admins to install a GitHub App. |
| **Secondary / fallback auth** | **Classic PAT paste** + optional **`gh auth token` import** | Escape hatch for organizations that restrict unapproved OAuth Apps; zero-friction bootstrap for users already signed into `gh`. Avoid fine-grained PATs as a required path because they cannot read the Checks API. |
| **Token storage** | **Electron `safeStorage` async API** in `electron/` main process | Uses OS keychain (macOS Keychain, Windows DPAPI, Linux Secret Service/KWallet); renderer never sees tokens. Use `isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync` (sync methods deprecated in Electron 45) and guard against the Linux `basic_text` fallback via `getSelectedStorageBackend()`. |
| **HTTP transport / SDK** | **Thin Effect-native client on `effect/unstable/http` (`HttpClient`) backed by Electron `net.fetch`** (alternative: modular `@octokit/core` + `@octokit/plugin-rest-endpoint-methods` + `@octokit/plugin-paginate-rest` with `request: { fetch: net.fetch }`) | `net.fetch` inherits OS proxies (PAC/WPAD/NTLM) and system certs. Wrapping `HttpClient` in an Effect `Context.Service` gives zero extra runtime deps, native fiber cancellation, `Schedule` retries/polling, built-in ETag middleware, and trivial `Layer` testability. |
| **API protocol split** | **Hybrid GraphQL + REST** | **GraphQL** for PR discovery, detail hydration (`statusCheckRollup`, `mergeStateStatus`, `reviewDecision`, `reviewThreads`), and GraphQL-only mutations (`resolveReviewThread`, `enablePullRequestAutoMerge`). **REST** for diffs/patches (`application/vnd.github.diff`, `/pulls/{n}/files`), ETag/`If-None-Match` (`304`) background polling, and simple PR CRUD/merge endpoints. |

---

## 1. Authentication & Token Storage in Electron

### 1.1 Auth Flow Comparison

| Flow | Token Prefix & Expiry | Client Secret Needed? | Org / Repo Friction | Full PR Lifecycle Coverage? | Desktop UX |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **OAuth App (Device Flow)** | `gho_`, non-expiring until revoked | **No** (public `client_id`) | Works on all repos the user can access (subject only to org OAuth App access restrictions) | **Yes** (`repo` + `read:org`) | User copies 8-char code, clicks link (`shell.openExternal`), approves in browser. No callback server. |
| **GitHub App (User-to-Server Device Flow)** | `ghu_` (8h) + `ghr_` refresh token (6mo, rotates on use) | **No** (both device flow and `grant_type=refresh_token` omit `client_secret` for device-flow tokens) | **High blocker:** private repo access requires the GitHub App to be **installed** on every target user account/org | **Yes** (`Pull requests: R/W`, `Checks: R`, `Commit statuses: R`, `Contents: R/W`, `Metadata: R`) | Same device flow UX, plus silent 8h token rotation — but breaks on any private org repo where the app isn't installed. |
| **Classic PAT** | `ghp_`, user-defined expiry | N/A | User must authorize SAML SSO per org if enabled | **Yes** (`repo` + `read:org`) | Manual token creation & paste in Settings. |
| **Fine-Grained PAT** | `github_pat_`, max 1yr | N/A | Single resource owner per token (personal OR one org); often requires org admin approval | **No — missing Checks API** (`check_runs` / `check_suites` unsupported) | High friction; unsuitable as primary auth. |
| **`gh` CLI (`gh auth token`)** | Reuses `gh`'s token (`gho_` / `ghp_`) | N/A | Inherits whatever `gh` already authorized | **Yes** (`gh` defaults to `repo`, `read:org`, `gist`) | Zero-friction if `gh` is installed & logged in, but fails if `gh` is absent or not on GUI `PATH`. |

#### Primary-Source Findings

1. **OAuth Device Flow (`POST /login/device/code` -> poll `POST /login/oauth/access_token`)**:
   - Designed for headless and desktop apps that cannot safely embed a `client_secret` or run a redirect server ([GitHub Docs: Authorizing OAuth apps — Device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)).
   - Fits Spence's Electron security model cleanly: main process requests the device code, sends `user_code` + `verification_uri` to the renderer via `DesktopRpcs`, opens `https://github.com/login/device` via `shell.openExternal` (already permitted by `isAllowedExternalUrl`), and polls in main process until authorized or cancelled.
2. **Why GitHub App user-to-server is a poor fit for a general-purpose desktop IDE**:
   - GitHub App user access tokens (`ghu_`) expire after 8 hours and ship with a 6-month `ghr_` refresh token that rotates on every refresh ([GitHub Docs: Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)). For device-flow tokens, `client_secret` is omitted even during refresh.
   - **Critical limitation:** Repository access for a GitHub App user access token is the **intersection** of the user's permissions, the app's permissions, and the app's **installation** boundaries ([GitHub Docs: Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)). Private repositories owned by an organization where Spence's GitHub App is not installed cannot be accessed. For a local developer desktop tool working across arbitrary repos, requiring org-admin installation per org is an adoption cliff.
3. **Required scopes & permissions for full PR read + write (including inline review comments, checks, and merge)**:
   - **OAuth App / Classic PAT**:
     - `repo`: Full control of public, internal, and private repositories — covers PRs, diffs, issue comments, inline review comments, reviews, Checks API (`check_runs`/`check_suites`), Commit Statuses, and merging ([GitHub Docs: Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)).
     - `read:org`: Read organization and team membership (needed for org-owned PR discovery and team review requests).
   - **Fine-grained PAT gaps**:
     - Merging a PR requires **`Contents: Read and write`** in addition to **`Pull requests: Read and write`** because merging mutates git refs ([GitHub Docs: Permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)).
     - **Checks API gap:** Fine-grained PATs have `Commit statuses` (`Read`/`Write`) but **do not have a `Checks` permission**; endpoints like `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` do not accept fine-grained PATs ([GitHub Docs: Checks — List check runs for a Git reference](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)).
4. **Reusing `gh` CLI (`gh auth token`)**:
   - `gh auth login` stores tokens in the OS keyring by default (falling back to `~/.config/gh/hosts.yml` when no keyring exists) and requests `repo`, `read:org`, `gist` ([GitHub CLI Manual: `gh auth token`](https://cli.github.com/manual/gh_auth_token), [`gh auth login`](https://cli.github.com/manual/gh_auth_login)).
   - `gh auth token` prints the active token to stdout (respecting `GH_TOKEN`/`GITHUB_TOKEN`). It is useful as an optional **"Import from GitHub CLI"** button in Settings, not as the sole auth mechanism (GUI apps on macOS/Windows often lack login-shell `PATH`, and many users don't install `gh`).

### 1.2 Secure Token Storage in Electron (`safeStorage`)

Spence enforces `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and strict CSP (`electron/main.ts`). All token acquisition, storage, and GitHub API calls **must stay in the Electron main process** (`electron/`); the renderer only receives auth status and viewer metadata over `DesktopRpcs`.

- **Use the async `safeStorage` API**: In modern Electron (Spence is on `^45.3.0`), the synchronous methods (`isEncryptionAvailable`, `encryptString`, `decryptString`) are deprecated in favor of `safeStorage.isAsyncEncryptionAvailable()`, `safeStorage.encryptStringAsync(plainText)`, and `safeStorage.decryptStringAsync(encryptedBuffer)` ([Electron Docs: `safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage)).
- **OS Backends**:
  - **macOS:** Keychain Access.
  - **Windows:** DPAPI (Data Protection API).
  - **Linux:** `gnome_libsecret` (GNOME/XFCE/Cinnamon via D-Bus Secret Service) or `kwallet` / `kwallet5` / `kwallet6` (KDE).
- **The Linux `basic_text` trap**: If no secret service daemon is running on Linux or Electron doesn't recognize the desktop environment, `safeStorage` silently falls back to `basic_text`, which encrypts using a **hardcoded key** (effectively plaintext on disk), even while encryption reports available ([Electron Docs: `safeStorage.getSelectedStorageBackend()`](https://www.electronjs.org/docs/latest/api/safe-storage#safestoragegetselectedstoragebackend-linux)).
  - **Mitigation:** On Linux, check `safeStorage.getSelectedStorageBackend()`. If it returns `'basic_text'`, do not silently persist tokens to disk — either keep the token in memory for the current session or warn the user and require explicit opt-in.
- **Persistence pattern:** Encrypt the token JSON payload into a `Buffer`, encode as base64, and persist in a dedicated file under `app.getPath('userData')` (respecting Spence's `SPENCE_E2E` / `SPENCE_USER_DATA` override in `electron/main.ts`), separate from plaintext settings.

---

## 2. npm Packages vs. Direct HTTP / Effect HTTP vs. `gh` CLI

### 2.1 Transport & Package Comparison

| Option | Latest Versions & Maintenance | Dependencies / Footprint | TypeScript Types | Effect 4.1.3 Ergonomics | Pagination / ETag / Rate-Limit | Electron `net.fetch` Support |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`octokit`** (all-in-one SDK) | `v5.x` (Node >=20, ESM-only, actively maintained by GitHub) | **Heavy** — pulls `@octokit/app`, `@octokit/oauth-app`, `@octokit/webhooks`, `bottleneck`, etc. (server-side baggage) | Full OpenAPI REST types; manual generic for GraphQL | Medium — Promise-based; must wrap in `Effect.tryPromise` + map `RequestError` | Built-in `paginate`, `retry`, `throttling`; **no** built-in ETag cache | Yes (`request: { fetch: net.fetch }`) |
| **Modular `@octokit/*`** (`@octokit/core` v7 + `rest-endpoint-methods` + `paginate-rest` + optional `auth-oauth-device`) | Actively maintained by GitHub; ESM-only (esbuild in `scripts/build-electron.mjs` bundles cleanly to CJS) | **Moderate** — avoids server-only packages (`app`, `webhooks`) | Full OpenAPI REST types (`@octokit/openapi-types`); manual generic for GraphQL | Medium — wrap behind an Effect `Context.Service`; forward `AbortSignal`; replace `plugin-retry`/`throttling` with Effect `Schedule` | Built-in Link-header pagination; ETag cache still custom | Yes (`request: { fetch: net.fetch }`) |
| **Effect `effect/unstable/http` (`HttpClient`) + Electron `net.fetch`** | Bundled in `effect@4.1.3` (`unstable` namespace) | **Zero** new runtime deps (optionally `@octokit/openapi-types` as `devDependency`) | End-to-end runtime-validated types via Effect `Schema` (matches Spence's IPC/domain style) | **Best** — native `Context.Service` & `Layer` testing, fiber interruption, `Schedule` retries/polling, composable middleware | ~150–250 LOC for Link pagination, ETag cache, GraphQL helper, `Retry-After` handling | **Yes** — custom `FetchHttpClient.Fetch` layer using `net.fetch` |
| **`gh` CLI subprocesses** | External user-installed binary | Zero npm deps, but requires `gh` on `PATH` | None (parse JSON stdout manually) | Poor — process spawn overhead per call (slow on Windows), brittle stderr parsing, no ETag caching | `--paginate` only; no conditional `304` requests | N/A (Go `net/http`) |

### 2.2 Key Technical Notes for Spence

1. **Use Electron `net.fetch`, not Node `globalThis.fetch`, in the main process**:
   - `net.fetch` routes through Chromium's network stack and automatically honors OS proxy settings, PAC/WPAD scripts, enterprise proxy auth (NTLM/Kerberos/Negotiate), and OS certificate stores on Windows/macOS ([Electron Docs: `net.fetch`](https://www.electronjs.org/docs/latest/api/net#netfetchinput-init)).
   - Node's built-in `fetch` ignores OS PAC/WPAD proxies and relies on separate CA flags (`--use-system-ca` / `NODE_EXTRA_CA_CERTS`).
   - *Linux caveat:* Chromium's `net.fetch` reads custom CAs from the NSS database (`~/.pki/nssdb`) rather than `/etc/ssl/certs`.
2. **Effect 4.1.3 ergonomics (`effect/unstable/http` vs. Octokit)**:
   - Spence pins `effect: "4.1.3"` and models all domain services as `Context.Service` + `Layer` with `Schema.TaggedError` and `makeXTestLayer` test doubles (`AGENTS.md`).
   - With `HttpClient` from `effect/unstable/http` (backed by `net.fetch`), the entire GitHub client (REST, GraphQL, Device Flow polling, ETag cache, secondary rate-limit backoff) is a pure Effect service with zero extra runtime dependencies, automatic fiber cancellation on window close or query supersede, and zero Promise-to-Effect bridging boilerplate.
   - Even if modular `@octokit/*` is chosen for typed REST methods, **do not** install the full `octokit` meta-package (it bundles server-only webhook/app packages), and **do** wrap it behind an Effect `Context.Service` so callers never see `RequestError` or Promises.
   - Note that `@octokit/graphql` does **not** type-check GraphQL queries or infer response shapes automatically (`octokit.graphql<T>(query, vars)`), so for the GraphQL-heavy PR read layer, Effect `Schema` decoding is needed either way.
3. **ESM compatibility**:
   - All current `@octokit/*` majors (`octokit@5`, `@octokit/rest@22`, `@octokit/core@7`, `@octokit/graphql@9`) are ESM-only and require Node `>=20`.
   - Spence's `tsconfig.electron.json` uses `"moduleResolution": "bundler"` and `scripts/build-electron.mjs` bundles with `esbuild` (`bundle: true, platform: 'node', format: 'cjs', target: 'node22'`), so ESM-only packages are compatible if ever added.

---

## 3. REST vs. GraphQL Coverage & Rate Limits

### 3.1 PR Lifecycle Capability Matrix

| PR Capability | GraphQL | REST | Recommended Transport & Notes |
| :--- | :--- | :--- | :--- |
| **Viewer-authored / review-requested / assigned PRs** | `search(type: ISSUE, query: "is:pr is:open author:@me ...")` (can alias multiple buckets in 1 request) | `GET /search/issues?q=...` (capped at **30 req/min**!) | **GraphQL** — avoids the 30 req/min REST Search cap and hydrates `reviewDecision`, `statusCheckRollup`, and branch names in 1 round-trip. |
| **Branch-linked PR lookup** | `repository(owner, name).pullRequests(headRefName: $branch, states: OPEN)` | `GET /repos/{o}/{r}/pulls?head={o}:{branch}&state=open` | **Either** — REST supports `If-None-Match` (`304`) for cheap polling; GraphQL hydrates checks & review state in the same call. |
| **PR diffs & file patches** | `PullRequest.files` returns paths & counts only (**no patch/hunk text**) | `GET /repos/{o}/{r}/pulls/{n}` (`Accept: application/vnd.github.diff` / `.patch`) & `GET /repos/{o}/{r}/pulls/{n}/files` | **REST (required)** — GraphQL does not expose diff hunks. Watch for `406` / timeout on PRs >300 files (fallback to local `git diff` when worktree is available). |
| **Combined CI checks & commit statuses** | `PullRequest.commits(last: 1).nodes[0].commit.statusCheckRollup` (`state` + `contexts` union of `CheckRun` & `StatusContext`) | Separate calls: `/commits/{sha}/check-runs` + `/commits/{sha}/status` | **GraphQL** — single unified rollup combining Check Runs and legacy Commit Statuses. |
| **Merge readiness & review state** | `mergeStateStatus` (`CLEAN`, `BLOCKED`, `BEHIND`, `DIRTY`, `UNSTABLE`), `reviewDecision` (`APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`) | Partial (`mergeable_state` is undocumented/unstable; requires separate `/reviews` call) | **GraphQL** — first-class typed enums. |
| **Review threads & resolution status** | `reviewThreads` (`id`, `isResolved`, `isOutdated`, `viewerCanResolve`, `comments`) + `resolveReviewThread` / `unresolveReviewThread` | Lists flat comments only; **no resolution status or resolve endpoint** | **GraphQL (required)** — REST cannot read or mutate thread resolution state. |
| **Create / edit PR (incl. draft toggle)** | `createPullRequest`, `updatePullRequest`, `markPullRequestReadyForReview`, `convertPullRequestToDraft` | `POST /repos/{o}/{r}/pulls`, `PATCH /repos/{o}/{r}/pulls/{n}` (supports `draft: true\|false`) | **REST** (simpler, no Node ID pre-fetch needed) or GraphQL. |
| **Issue comments & PR reviews (incl. inline comments)** | `addComment`, `addPullRequestReview`, `addPullRequestReviewThread`, `addPullRequestReviewThreadReply` | `POST /issues/{n}/comments`, `POST /pulls/{n}/reviews`, `POST /pulls/{n}/comments/{id}/replies` | **REST** (or GraphQL when replying by thread Node ID already loaded). |
| **Merge PR** | `mergePullRequest` | `PUT /repos/{o}/{r}/pulls/{n}/merge` | **REST** — straightforward merge method (`merge`, `squash`, `rebase`) + `sha` guard. |
| **Auto-merge** | `enablePullRequestAutoMerge` / `disablePullRequestAutoMerge` | **No REST endpoint** | **GraphQL (required)**. |

### 3.2 Rate Limits & Desktop Client Best Practices

- **Separate primary buckets** ([GitHub Docs: Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [Rate limits for the GraphQL API](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api)):
  - **REST `core`**: **5,000 requests/hour** per authenticated user.
  - **REST `search`**: **30 requests/minute** per authenticated user.
  - **GraphQL**: **5,000 points/hour** per authenticated user (cost scales with requested node counts, calculated before execution).
  - REST and GraphQL draw from **independent** hourly buckets.
- **Conditional requests (`ETag` / `If-None-Match`)**:
  - **REST only**: Returning `304 Not Modified` costs **0 primary rate-limit quota** ([GitHub Docs: Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate)).
  - **GraphQL does not support `ETag` / `304`**: every GraphQL POST consumes points.
- **Secondary rate limits** ([GitHub Docs: Secondary rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits)):
  - Max **100 concurrent requests** globally across REST + GraphQL.
  - Burst limits on mutating requests (`POST`/`PATCH`/`PUT`/`DELETE`) and server CPU time; violations return `403` or `429` with `Retry-After` or `x-ratelimit-reset`.
- **Recommended desktop polling & quota strategy for Spence**:
  1. Always send `X-GitHub-Api-Version: 2022-11-28` and a `User-Agent: Spence/<version>` header.
  2. **ETag-gated polling**: For background refresh of a repo's open PRs or an open PR detail view, poll the lightweight REST endpoint with `If-None-Match`. Only trigger a GraphQL hydration query when REST returns `200` (data changed) or on explicit user refresh.
  3. **Focus-aware scheduling**: Pause background polling when the Electron window is unfocused/minimized; refresh on focus with a cooldown (e.g., 30–60s).
  4. **Tight GraphQL pagination & low concurrency**: Keep `first:` limits modest (avoid multiplicative `first: 100` nesting that inflates point cost), cap client concurrency with an Effect `Semaphore` (e.g., 4–6 permits), and honor `Retry-After` / `x-ratelimit-reset` headers via Effect `Schedule`.

---

## Primary Sources

- GitHub Docs — [Authorizing OAuth apps (Device flow)](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
- GitHub Docs — [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- GitHub Docs — [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- GitHub Docs — [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- GitHub Docs — [Permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- GitHub Docs — [REST API: Pull requests](https://docs.github.com/en/rest/pulls/pulls) & [Checks: List check runs for a Git reference](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)
- GitHub Docs — [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) & [Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- GitHub Docs — [Rate limits and node limits for the GraphQL API](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api) & [GraphQL API Reference (PullRequest, PullRequestReviewThread, Mutations)](https://docs.github.com/en/graphql/reference)
- GitHub CLI Manual — [`gh auth token`](https://cli.github.com/manual/gh_auth_token) & [`gh auth login`](https://cli.github.com/manual/gh_auth_login)
- Electron Docs — [`safeStorage` API](https://www.electronjs.org/docs/latest/api/safe-storage) & [`net.fetch`](https://www.electronjs.org/docs/latest/api/net#netfetchinput-init)
- Octokit — [`octokit/octokit.js`](https://github.com/octokit/octokit.js), [`octokit/rest.js`](https://github.com/octokit/rest.js), [`octokit/graphql.js`](https://github.com/octokit/graphql.js), [`octokit/auth-oauth-device.js`](https://github.com/octokit/auth-oauth-device.js)
- Effect v4 — [`effect/unstable/http` (`HttpClient`, `FetchHttpClient`)](https://effect.website/docs/platform/http-client/)
