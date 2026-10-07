import { expect, test } from '@playwright/test';

test('test workspace tabs guide a first visit and keep unfinished forms on desktop and mobile', async ({ page, request }, testInfo) => {
  const writes: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // This journey only reads local fixtures. Navigation and editing drafts must never start a paid action.
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.route('**/api/layerize-experiment/**', route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') { writes.push(path); return route.abort(); }
    if (path.endsWith('/runs')) return route.fulfill({ json: { active: null, runs: [] } });
    return route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  const tab = (name: string) => panel.getByRole('tab', { name, exact: true });
  await expect(panel.getByRole('tab')).toHaveText(['Overview', 'Create Template', 'Decompose/Test', 'Saved Runs']);
  await expect(panel.getByRole('heading', { name: 'From one image to editable layers.' })).toBeVisible();
  await expect(panel.getByRole('tabpanel')).toHaveCount(1);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('workspace-overview.png') });
  await tab('Overview').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab('Create Template')).toBeFocused();
  await expect(tab('Create Template')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('button', { name: 'Create Template from Image', exact: true })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('workspace-create.png') });
  await panel.getByRole('button', { name: 'Create Template B', exact: true }).click();
  await panel.getByLabel('Main product', { exact: true }).fill('Draft lavender phone');
  await expect(panel.getByTestId('prompt-review')).not.toHaveAttribute('open');

  await tab('Decompose/Test').click();
  await expect(panel.getByRole('button', { name: 'Run decomposition' })).toBeDisabled();
  const advanced = panel.locator('details').filter({ has: page.getByText('Advanced test settings', { exact: true }) });
  await expect(advanced).not.toHaveAttribute('open');
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('workspace-decompose.png') });
  await panel.getByLabel('Template', { exact: true }).selectOption('template-a');
  const image = await (await request.get('/__test__/reference.png')).body();
  await panel.getByLabel('Image to decompose').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: image });
  await panel.getByText('Advanced test settings', { exact: true }).click();
  await panel.getByRole('spinbutton', { name: /^Target layers/ }).fill('6');
  await panel.getByRole('checkbox', { name: /Recursive cleanup/ }).uncheck();
  await tab('Saved Runs').click();
  await expect(panel.getByRole('heading', { name: 'Your results will appear here' })).toBeVisible();
  await tab('Create Template').click();
  await expect(panel.getByLabel('Main product', { exact: true })).toHaveValue('Draft lavender phone');
  await tab('Decompose/Test').click();
  await expect(panel.getByRole('spinbutton', { name: /^Target layers/ })).toHaveValue('6');
  await expect(panel.getByRole('checkbox', { name: /Recursive cleanup/ })).not.toBeChecked();
  await expect(panel.getByText('draft.png', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Run decomposition' })).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['Overview', 'Create Template', 'Decompose/Test', 'Saved Runs']) {
    await tab(name).click();
    if (name === 'Create Template') {
      await panel.getByTestId('advanced-options').locator('summary').click();
      await panel.getByTestId('prompt-review').locator('summary').first().click();
    }
    await expect(panel.getByRole('tabpanel')).toHaveCount(1);
    expect(await panel.locator('.ws-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${name} fits mobile`).toBe(true);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`workspace-mobile-${name.replaceAll('/', '-')}.png`) });
  }
  await tab('Saved Runs').focus();
  await page.keyboard.press('Home');
  await expect(tab('Overview')).toBeFocused();
  await page.keyboard.press('End');
  await expect(tab('Saved Runs')).toBeFocused();
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
