import { expect, test } from '@playwright/test';
import { AI_PRICING, sumCosts } from '@frameflow/shared';

test('a final Seedream rejection explains the provider response and never offers a useless resume', async ({ page, request }, testInfo) => {
  const image = await (await request.get('/__test__/reference.png')).body();
  const writes: string[] = [];
  const run = { id: '2026-10-08T00-00-00-000Z-abcdef', createdAt: '2026-10-08T00:00:00Z', stage: 'failed',
    original: { file: 'original.png', width: 1024, height: 1024 }, input: { file: 'original.png', width: 1024, height: 1024, orientationNormalized: false },
    seedream: { endpoint: AI_PRICING.seedream.model, requestId: 'offline-rejected', status: 'COMPLETED' }, timings: {}, warnings: [],
    error: { code: 'PROVIDER_DECOMPOSITION_REJECTED', stage: 'in_progress', message: 'Stored final rejection.',
      provider: { code: 'PROVIDER_REJECTED', status: 422, messages: [{ msg: 'The provided image could not be processed for layer decomposition. Try a different image.', type: 'invalid_request' }] } } };
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.route('**/api/layerize-experiment/**', route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') { writes.push(path); return route.abort(); }
    if (path.endsWith('/runs')) return route.fulfill({ json: { active: null, runs: [run] } });
    if (path.endsWith('/diagnostics')) return route.fulfill({ json: { runId: run.id, updatedAt: run.createdAt, fx: 90, pricingVersion: AI_PRICING.version,
      sources: AI_PRICING.sources, stages: [], total: sumCosts([], 90), calls: 0, callsMeasured: true, rawLayers: 0, editorLayers: 0, prompts: [], raw: [], notes: [] } });
    if (path.endsWith('/files/original.png')) return route.fulfill({ contentType: 'image/png', body: image });
    return route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await expect(panel.getByRole('alert')).toContainText('Provider response (HTTP 422)');
  await expect(panel.getByRole('alert')).toContainText('Resume cannot recover it');
  await expect(panel.getByRole('button', { name: 'Resume saved result' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Retry extraction', exact: true })).toBeEnabled();
  const dialog = page.waitForEvent('dialog');
  const click = panel.getByRole('button', { name: 'Retry extraction', exact: true }).click();
  const confirmation = await dialog;
  expect(confirmation.message()).toContain('One new paid Seedream request; no planner request');
  await confirmation.dismiss(); await click;
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await panel.locator('.ws-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('provider-rejection-mobile.png') });
  await panel.getByRole('button', { name: 'Choose image or template' }).click();
  await expect(panel.getByRole('region', { name: 'Template library', exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});

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
  await expect(panel.getByRole('heading', { name: 'Start with a creative' })).toBeVisible();
  await expect(panel.getByRole('tabpanel')).toHaveCount(1);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('workspace-overview.png') });
  await tab('Overview').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab('Create Template')).toBeFocused();
  await expect(tab('Create Template')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('button', { name: 'Create New Template', exact: true })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('workspace-create.png') });
  await panel.getByRole('button', { name: 'Create New Template', exact: true }).click();
  const upload = await (await request.get('/__test__/reference.png')).body();
  await panel.getByLabel('Creative image', { exact: true }).setInputFiles({ name: 'family-draft.png', mimeType: 'image/png', buffer: upload });
  await tab('Decompose/Test').click();
  await expect(panel.getByRole('button', { name: 'Run decomposition' })).toBeDisabled();
  const image = await (await request.get('/__test__/reference.png')).body();
  await panel.getByLabel('Image to decompose').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: image });
  await panel.getByRole('checkbox', { name: /Recursive cleanup/ }).uncheck();
  await tab('Saved Runs').click();
  await expect(panel.getByRole('heading', { name: 'Your results will appear here' })).toBeVisible();
  await tab('Create Template').click();
  await expect(panel.getByText('family-draft.png', { exact: true })).toBeVisible();
  await tab('Decompose/Test').click();
  await expect(panel.getByRole('checkbox', { name: /Recursive cleanup/ })).not.toBeChecked();
  await expect(panel.getByText('draft.png', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Run decomposition' })).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['Overview', 'Create Template', 'Decompose/Test', 'Saved Runs']) {
    await tab(name).click();
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
