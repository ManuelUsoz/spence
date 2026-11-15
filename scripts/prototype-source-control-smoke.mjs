import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:4317/?variant=A');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  if (!(await page.locator('.tree-folder').count())) throw Error('File tree missing');
  if (await page.locator('.inline-diff').count()) throw Error('Files shows a diff');
  await page.getByRole('button', { name: '⌑ session.ts', exact: true }).click();
  if (!(await page.locator('.file-contents').count())) throw Error('Plain file preview missing');
  if (await page.locator('.inline-diff').count()) throw Error('File preview shows a diff');
  await page.getByRole('button', { name: '‹ Files', exact: true }).click();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  if (await page.getByRole('button', { name: 'Session history', exact: true }).count())
    throw Error('Session history tab visible');
  await page.locator('#commit-message').fill('Refine composer');
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Commit', exact: true }).click();
  await page.getByRole('button', { name: /Go back to/ }).click();
  if (!(await page.getByText(/This action is irreversible/).count()))
    throw Error('Missing irreversible warning');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const rewindButtons = page.getByRole('button', {
    name: 'Rewind to before this message',
    exact: true,
  });
  if ((await rewindButtons.count()) !== 2) throw Error('User messages need rewind buttons');
  await rewindButtons.last().click();
  if (!(await page.getByRole('heading', { name: 'Rewind to before this message?' }).count()))
    throw Error('Wrong rewind target');
  if ((await page.getByRole('dialog').locator('p').count()) !== 1)
    throw Error('Rewind copy too verbose');
  await page.getByRole('button', { name: 'Review remote rewind', exact: true }).click();
  await page.getByRole('button', { name: 'Rewind everything', exact: true }).click();
  if ((await page.locator('.thread .message').count()) !== 2)
    throw Error('Later user message was not removed');
  await page.getByRole('button', { name: /4 steps/ }).click();
  if (!(await page.getByText('Turn 12 · before → after', { exact: true }).count()))
    throw Error('Receipt comparison unavailable');
  await page.goto('http://127.0.0.1:4317/?variant=A');
  await page
    .getByRole('button', { name: 'Rewind to before this message', exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: 'Review remote rewind', exact: true }).click();
  await page.getByRole('button', { name: 'Rewind everything', exact: true }).click();
  if ((await page.locator('.thread .message').count()) !== 0)
    throw Error('First message rewind target incorrect');
  await page.goto('http://127.0.0.1:4317/?variant=A');
  await page.screenshot({
    path: 'src/app/features/session/source-control-prototype/preview-A.png',
  });
  if (errors.length) throw Error(errors.join('; '));
  console.warn(
    'Browser checks passed: calm inspector, commit review, Go back preview, Receipt comparison.',
  );
} finally {
  await browser.close();
}
