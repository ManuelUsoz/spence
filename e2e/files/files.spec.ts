import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures';

const git = (cwd: string, args: ReadonlyArray<string>): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};

const entryByPath = (page: import('@playwright/test').Page, relativePath: string) =>
  page.locator(`[data-testid="files-tree-item"][data-path="${relativePath}"]`);

test('browses live workspace files, previews text/binary/large states, toggles ignored files, and reacts to live watch', async ({
  spence,
}) => {
  const repoDir = await spence.pickNext('files-repo');

  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'test@spence.dev']);
  git(repoDir, ['config', 'user.name', 'Spence']);
  writeFileSync(path.join(repoDir, '.gitignore'), 'ignored.log\n');
  writeFileSync(path.join(repoDir, 'README.md'), '# Live Workspace\nhello from main\n');
  mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const ready = true;\n');
  writeFileSync(path.join(repoDir, 'ignored.log'), 'secret ignored log\n');
  writeFileSync(path.join(repoDir, 'asset.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  writeFileSync(path.join(repoDir, 'huge.txt'), 'a'.repeat(2 * 1024 * 1024 + 1024));

  const nestedDir = path.join(repoDir, 'nested-repo');
  mkdirSync(nestedDir, { recursive: true });
  git(nestedDir, ['init', '-b', 'main']);
  writeFileSync(path.join(nestedDir, 'inner.txt'), 'inside nested repo\n');

  git(repoDir, ['add', '.gitignore', 'README.md', 'src/index.ts', 'asset.bin', 'huge.txt']);
  git(repoDir, ['commit', '-m', 'initial']);

  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('files-repo');

  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('worktree-pill')).toHaveText('main');

  const toggle = page.getByTestId('files-inspector-toggle');
  await toggle.click();

  const pane = page.getByTestId('session-inspector-pane');
  await expect(pane).toBeVisible();
  await expect(pane.getByTestId('files-root-context')).toContainText('main');

  // `.git` metadata is excluded, `nested-repo` is marked non-traversable `repo`, `ignored.log` hidden by default.
  await expect(entryByPath(page, 'README.md')).toBeVisible();
  await expect(entryByPath(page, 'src')).toBeVisible();
  await expect(entryByPath(page, 'nested-repo')).toBeVisible();
  await expect(entryByPath(page, 'nested-repo')).toHaveAttribute('data-kind', 'nestedRepo');
  await expect(entryByPath(page, '.git')).toHaveCount(0);
  await expect(entryByPath(page, 'ignored.log')).toHaveCount(0);

  // Clicking nested-repo refuses traversal and explains why without revealing inner files.
  await entryByPath(page, 'nested-repo').click();
  await expect(pane.getByTestId('files-preview-unavailable')).toBeVisible();
  await expect(entryByPath(page, 'nested-repo/inner.txt')).toHaveCount(0);
  await pane.getByTestId('files-preview-back').click();

  // Expand `src/` lazily and open saved text preview.
  await entryByPath(page, 'src').click();
  await expect(entryByPath(page, 'src/index.ts')).toBeVisible();
  await entryByPath(page, 'src/index.ts').click();
  await expect(pane.getByTestId('files-preview-content')).toContainText(
    'export const ready = true;',
  );

  // Close preview back to tree and verify live watch picks up a new file written on disk.
  await pane.getByTestId('files-preview-back').click();
  await expect(entryByPath(page, 'README.md')).toBeVisible();

  writeFileSync(path.join(repoDir, 'live-added.txt'), 'created while watching\n');
  await expect(entryByPath(page, 'live-added.txt')).toBeVisible();

  // Open binary file and >2 MiB large file preview states.
  await entryByPath(page, 'asset.bin').click();
  await expect(pane.getByTestId('files-preview-binary')).toBeVisible();
  await pane.getByTestId('files-preview-back').click();

  await entryByPath(page, 'huge.txt').click();
  await expect(pane.getByTestId('files-preview-truncated')).toBeVisible();
  await pane.getByTestId('files-preview-back').click();

  // Enable Project ignored-file visibility and preview ignored file.
  await pane.getByTestId('files-options-trigger').click();
  await page.getByTestId('files-toggle-ignored').click();
  await expect(entryByPath(page, 'ignored.log')).toBeVisible();
  await entryByPath(page, 'ignored.log').click();
  await expect(pane.getByTestId('files-preview-content')).toContainText('secret ignored log');

  // Close inspector and verify focus returns cleanly to the trigger button.
  await pane.getByTestId('inspector-close').click();
  await expect(pane).toBeHidden();
  await expect(toggle).toBeFocused();
});

test('browses a plain non-Git folder cleanly', async ({ spence }) => {
  const plainDir = await spence.pickNext('files-plain');
  writeFileSync(path.join(plainDir, 'notes.txt'), 'plain workspace note\n');

  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('files-plain');

  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('worktree-pill')).toContainText(
    spence.t({ en: 'Local folder', es: 'Carpeta local' }),
  );

  await page.getByTestId('files-inspector-toggle').click();
  const pane = page.getByTestId('session-inspector-pane');
  await expect(pane.getByTestId('files-root-context')).toContainText(
    spence.t({ en: 'Local folder', es: 'Carpeta local' }),
  );
  await expect(entryByPath(page, 'notes.txt')).toBeVisible();

  await entryByPath(page, 'notes.txt').click();
  await expect(pane.getByTestId('files-preview-content')).toContainText('plain workspace note');
});
