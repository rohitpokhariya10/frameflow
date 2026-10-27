import { test, expect } from '@playwright/test';

/**
 * Screens of a real reference (only with FRAMEFLOW_PRODUCT_REFERENCE=1 and Ganesh-Chaturthi.png in the project root): the LG
 * creative chosen from the sheet, read by the real local OCR, its characters and products from the HAND-MADE stand-in
 * answer (tests/fixtures/ganeshHandmade.fixture.ts, not a model), reviewed, prepared locally and saved.
 */
test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` }, actionTimeout: 30000 });
test.describe.configure({ timeout: 300000 });
const SHOTS = process.env.PRODUCT_SHOTS_OUT ?? 'test-results/product-v1/screens';

test('the Ganesh Chaturthi LG creative: chosen from the sheet, reviewed, prepared and saved (screens)', async ({ page, request }, info) => {
  test.skip(process.env.FRAMEFLOW_PRODUCT_REFERENCE !== '1' || info.project.name !== 'desktop', 'Real-reference screens only on request.');
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => r.abort());
  const sheet = await request.get('/__test__/ganesh-sheet.png');
  test.skip(!sheet.ok(), 'Ganesh-Chaturthi.png is not in the project root.');
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  await panel.getByRole('button', { name: 'New product template' }).click();
  await panel.getByLabel('Creative to upload').setInputFiles({ name: 'Ganesh-Chaturthi.png', mimeType: 'image/png', buffer: await sheet.body() });
  await expect(panel.getByText('This picture has 4 creatives')).toBeVisible();
  await panel.getByLabel('Template name').fill('LG Ganesh Chaturthi');
  await panel.getByRole('checkbox', { name: /Find characters and products with AI/ }).check();
  await page.screenshot({ path: `${SHOTS}/g1-upload-sheet.png` });
  await panel.getByRole('button', { name: 'Upload and find elements' }).click();
  await expect(panel.getByRole('heading', { name: 'Here’s what we found' })).toBeVisible({ timeout: 120000 });
  await page.screenshot({ path: `${SHOTS}/g2-review.png` });
  await panel.getByRole('region', { name: 'Characters', exact: true }).getByRole('button', { name: /Ganesha/ }).click();
  await page.screenshot({ path: `${SHOTS}/g3-review-ganesha.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${SHOTS}/g4-review-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await panel.getByRole('button', { name: 'Save and choose what to decompose' }).click();
  await expect(panel.getByRole('heading', { name: 'Choose what to decompose' })).toBeVisible();
  await panel.getByRole('button', { name: 'Continue to Decomposition' }).click();
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 180000 });
  await page.screenshot({ path: `${SHOTS}/g5-prepared.png` });
  for (const name of ['Refrigerator', 'Washing machine', 'OLED TV with sound system']) await panel.getByRole('button', { name, exact: true }).click();
  await page.screenshot({ path: `${SHOTS}/g6-prepared-hidden.png` });
  await panel.getByRole('tab', { name: 'Reconstructed full creative' }).click();
  await page.screenshot({ path: `${SHOTS}/g7-compare.png` });
  for (const c of await panel.getByRole('complementary', { name: 'Checks' }).getByRole('checkbox').all()) await c.check();
  await panel.getByRole('button', { name: 'Save master template' }).click();
  await expect(panel.getByRole('heading', { name: 'Your template is saved' })).toBeVisible({ timeout: 60000 });
  await panel.getByRole('button', { name: 'Use this template' }).click();
  await panel.getByRole('button', { name: 'New creative' }).click();
  await expect(panel.getByRole('region', { name: 'Products and characters' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/g8-creative.png` });
  await panel.getByRole('button', { name: 'Open in editor' }).click();
  await expect(panel).toBeHidden({ timeout: 60000 });
  await expect(page.locator('.layer-select', { hasText: 'Ganesha' }).first()).toBeVisible({ timeout: 30000 });
  await page.locator('.layer-select', { hasText: 'Ganesha' }).first().click();
  await page.screenshot({ path: `${SHOTS}/g9-editor.png` });
});
