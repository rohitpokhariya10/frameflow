import { expect, test, type Page } from '@playwright/test';

async function expectFrameFits(page: Page) {
  const viewport = await page.getByTestId('canvas-viewport').boundingBox();
  const frame = await page.getByTestId('canvas-frame').boundingBox();
  expect(viewport).not.toBeNull();
  expect(frame).not.toBeNull();
  if (!viewport || !frame) throw new Error('Missing canvas viewport or frame');
  expect(frame.x).toBeGreaterThanOrEqual(viewport.x);
  expect(frame.y).toBeGreaterThanOrEqual(viewport.y);
  expect(frame.x + frame.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1);
  expect(frame.y + frame.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1);
  expect(Math.abs(frame.x + frame.width / 2 - viewport.x - viewport.width / 2)).toBeLessThan(2);
  expect(Math.abs(frame.y + frame.height / 2 - viewport.y - viewport.height / 2)).toBeLessThan(2);
}

test('presets render exact logical dimensions and fit at desktop sizes', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Something good/ })).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  await expectFrameFits(page);
  await page.screenshot({ path: testInfo.outputPath(`editor-${testInfo.project.name}.png`), fullPage: true });
  for (const [name, width, height] of [['Square', 1080, 1080], ['Landscape', 1600, 900], ['Story', 1080, 1920], ['Poster', 1080, 1350]] as const) {
    await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
    await expect(page.getByTestId('canvas-frame')).toHaveAttribute('data-logical-width', String(width));
    await expect(page.getByTestId('canvas-frame')).toHaveAttribute('data-logical-height', String(height));
    await expect(page.getByTestId('canvas-dimensions')).toHaveText(`${width} × ${height} px`);
    await expectFrameFits(page);
  }
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('custom dimensions reject invalid input without changing the canvas', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Custom size' }).click();
  const width = page.getByRole('textbox', { name: 'Width', exact: true });
  const height = page.getByRole('textbox', { name: 'Height', exact: true });
  for (const invalid of ['', '1080.5', '-300', 'NaN', 'Infinity', '255', '4097', '1e3']) {
    await width.fill(invalid);
    await page.getByRole('button', { name: 'Apply size' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('canvas-frame')).toHaveAttribute('data-logical-width', '1080');
    await expect(page.getByTestId('canvas-frame')).toHaveAttribute('data-logical-height', '1350');
  }
  await width.fill('4096'); await height.fill('4096');
  await page.getByRole('button', { name: 'Apply size' }).click();
  await expect(page.getByRole('alert')).toContainText('12,000,000');
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('custom-validation.png'), fullPage: true });
  await width.fill('1200'); await height.fill('800');
  await page.getByRole('button', { name: 'Apply size' }).click();
  await expect(page.getByTestId('canvas-dimensions')).toHaveText('1200 × 800 px');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectFrameFits(page);
  for (const [w, h] of [[4096, 256], [256, 4096]]) {
    await width.fill(String(w)); await height.fill(String(h));
    await page.getByRole('button', { name: 'Apply size' }).click();
    await expect(page.getByTestId('canvas-dimensions')).toHaveText(`${w} × ${h} px`);
    await expectFrameFits(page);
    await expect(page.getByRole('button', { name: 'Add heading' })).toHaveCount(0);
  }
});

test('zoom only changes display; Fit, same preset, and workspace resize restore fitting', async ({ page }) => {
  await page.goto('/');
  const initialZoom = await page.getByLabel('Current zoom').textContent();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.getByLabel('Current zoom')).not.toHaveText(initialZoom!);
  await expect(page.getByTestId('canvas-frame')).toHaveAttribute('data-logical-width', '1080');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await expect(page.getByLabel('Current zoom')).toHaveText(initialZoom!);
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.getByRole('button', { name: /^Poster/ }).click();
  await expect(page.getByLabel('Current zoom')).toHaveText(initialZoom!);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.getByRole('complementary', { name: 'Properties', exact: true })).toBeHidden();
  await expectFrameFits(page);
  await page.setViewportSize({ width: 1366, height: 650 });
  await expect.poll(() => page.getByLabel('Current zoom').textContent()).not.toBe(initialZoom);
  await expectFrameFits(page);
});

test('upcoming actions are truthful and keyboard tabs work', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Add heading' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Export/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Open wedding example' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Design', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Text', exact: true })).toBeFocused();
  await expect(page.getByText('Text editing · Milestone 2')).toBeVisible();
  await page.getByRole('button', { name: /Create with AI/ }).click();
  await expect(page.getByRole('tab', { name: 'AI', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('AI generation · Milestone 5')).toBeVisible();
  await expect(page.getByText('Not saved yet')).toBeVisible();
});

test('Express health endpoint is reachable from the application origin', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ status: 'ok', aiAvailable: false });
});
