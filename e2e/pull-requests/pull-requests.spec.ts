import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { expect, test as base } from '../fixtures';

interface MockGitHubServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

const startMockGitHubServer = async (): Promise<MockGitHubServer> => {
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');

    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    if (url.endsWith('/user')) {
      return json(
        200,
        { login: 'octocat', name: 'Octo Cat', avatar_url: null },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }

    if (url.includes('/pulls?state=all')) {
      return json(200, [{ number: 42, updated_at: '2026-11-20T12:00:00Z', draft: false }], {
        etag: '"e2e-list-1"',
      });
    }

    if (url.includes('/repos/acme/spence/pulls/42') && req.headers['accept']?.includes('diff')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        [
          'diff --git a/README.md b/README.md',
          'index 1111111..2222222 100644',
          '--- a/README.md',
          '+++ b/README.md',
          '@@ -1 +1,2 @@',
          ' # demo-project',
          '+Added Pull request e2e coverage.',
        ].join('\n'),
      );
      return;
    }

    if (url.endsWith('/repos/acme/spence/pulls/42')) {
      return json(200, { number: 42, head: { sha: 'sha-42' } }, { etag: '"e2e-pr-42"' });
    }

    if (url.includes('/commits/sha-42/check-runs')) {
      return json(200, { total_count: 1, check_runs: [] }, { etag: '"e2e-checks-42"' });
    }

    if (url.endsWith('/graphql')) {
      const parsed = rawBody ? (JSON.parse(rawBody) as { query?: string }) : {};
      const query = parsed.query ?? '';
      if (query.includes('pullRequest(number:')) {
        return json(200, {
          data: {
            repository: {
              mergeCommitAllowed: true,
              squashMergeAllowed: true,
              rebaseMergeAllowed: false,
              labels: { nodes: [] },
              milestones: { nodes: [] },
              assignableUsers: { nodes: [] },
              pullRequest: {
                number: 42,
                title: 'Add Pull request inspection flow',
                url: 'https://github.com/acme/spence/pull/42',
                body: 'Verifies GitHub connection, Composer PR pill, and detail inspection.',
                state: 'OPEN',
                isDraft: false,
                headRefName: 'feat/add-pr-e2e',
                headRefOid: 'sha-42',
                baseRefName: 'main',
                updatedAt: '2026-11-20T12:00:00Z',
                isCrossRepository: false,
                headRepository: { nameWithOwner: 'acme/spence' },
                mergeStateStatus: 'CLEAN',
                autoMergeRequest: null,
                reviewDecision: 'APPROVED',
                viewerCanUpdate: true,
                viewerDidAuthor: false,
                viewerPermission: 'WRITE',
                author: { login: 'octocat', name: 'Octo Cat', avatarUrl: null },
                labels: { nodes: [{ id: 'lbl-1', name: 'e2e', color: '0e8a16' }] },
                reviewRequests: { nodes: [] },
                assignees: { nodes: [] },
                milestone: null,
                comments: { totalCount: 0, nodes: [] },
                reviewThreads: { totalCount: 0, nodes: [] },
                reviews: { nodes: [] },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          contexts: {
                            nodes: [
                              {
                                __typename: 'CheckRun',
                                id: 'cr-42',
                                name: 'ci / verify',
                                status: 'COMPLETED',
                                conclusion: 'SUCCESS',
                                detailsUrl: null,
                                isRequired: true,
                              },
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      }

      return json(200, {
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  number: 42,
                  title: 'Add Pull request inspection flow',
                  url: 'https://github.com/acme/spence/pull/42',
                  state: 'OPEN',
                  isDraft: false,
                  headRefName: 'feat/add-pr-e2e',
                  headRefOid: 'sha-42',
                  baseRefName: 'main',
                  updatedAt: '2026-11-20T12:00:00Z',
                  isCrossRepository: false,
                  headRepository: { nameWithOwner: 'acme/spence' },
                  reviewDecision: 'APPROVED',
                  author: { login: 'octocat', name: 'Octo Cat', avatarUrl: null },
                  comments: { totalCount: 0 },
                  reviewThreads: { totalCount: 0 },
                  reviewRequests: { nodes: [] },
                  assignees: { nodes: [] },
                  commits: {
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: { state: 'SUCCESS' },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      });
    }

    return json(404, { message: `Unhandled mock GitHub route: ${url}` });
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind mock GitHub server');
  }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
};

const initDemoGitRepo = (dir: string) => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, windowsHide: true });
  git('init', '-b', 'main');
  git('config', 'user.email', 'octocat@spence.local');
  git('config', 'user.name', 'Octo Cat');
  writeFileSync(path.join(dir, 'README.md'), '# demo-project\n');
  git('add', 'README.md');
  git('commit', '-m', 'init');
  git('remote', 'add', 'origin', 'https://github.com/acme/spence.git');
  git('checkout', '-b', 'feat/add-pr-e2e');
};

const test = base.extend<{ mockGitHub: MockGitHubServer }>({
  mockGitHub: async ({}, use) => {
    const srv = await startMockGitHubServer();
    try {
      await use(srv);
    } finally {
      await srv.close();
    }
  },
  spenceEnv: async ({ mockGitHub }, use) => {
    await use({
      SPENCE_E2E_SECRET_STORAGE: 'fake',
      SPENCE_GITHUB_API_URL: mockGitHub.url,
      SPENCE_GITHUB_WEB_URL: mockGitHub.url,
    });
  },
});

test('connects GitHub in Settings, opens PR from Composer pill and rail, and inspects PR detail', async ({
  spence,
}) => {
  const { page } = spence;
  initDemoGitRepo(spence.pickFolder);

  // 1. Connect GitHub via PAT in Settings -> Git Hosts
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings-page');
  await expect(settings).toBeVisible();
  await settings.getByTestId('settings-nav-git-hosts').click();
  await expect(settings.getByTestId('settings-git-hosts')).toBeVisible();

  await settings.getByTestId('git-hosts-pat-input').fill('ghp_e2e_test_token');
  await settings.getByTestId('git-hosts-pat-submit').click();
  await expect(settings.getByTestId('git-hosts-account')).toContainText('@octocat');

  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  // 2. Add the Git-backed demo-project and start a Session
  await page.getByTestId('add-project').click();
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();

  // 3. Composer PR pill links the checked-out branch to PR #42 and opens the PR page
  const prPill = page.getByTestId('composer-status-pr');
  await expect(prPill).toContainText('#42');
  await prPill.click();

  await expect(page.getByTestId('pull-requests-header')).toBeVisible();
  await expect(page.getByTestId('pull-requests-project-name')).toHaveText('demo-project');
  await expect(page.getByTestId('pr-detail-pane')).toBeVisible();
  await expect(page.getByTestId('pr-detail-title')).toContainText(
    'Add Pull request inspection flow',
  );
  await spence.shot('pull-requests-detail');

  // 4. Rail navigation switches between Sessions and Pull requests
  await page.getByTestId('rail-nav-sessions').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.getByTestId('rail-nav-pull-requests').click();
  await expect(page.getByTestId('pull-requests-header')).toBeVisible();
  await page.getByTestId('pr-list-item-42').click();
  await expect(page.getByTestId('pr-detail-pane')).toBeVisible();
});
