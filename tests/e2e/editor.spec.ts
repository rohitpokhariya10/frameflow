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
  await expect(page.locator('canvas').first()).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Add heading' })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Export/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Open wedding example' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Design', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Text', exact: true })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Words with presence.' })).toBeVisible();
  await page.getByRole('button', { name: /Create with AI/ }).click();
  await expect(page.getByRole('tab', { name: 'AI', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Set the atmosphere.' })).toBeVisible();
  await expect(page.getByLabel('Visual theme')).toBeVisible();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
});

test('Express health endpoint is reachable from the application origin', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body).toEqual({ status: 'ok', provider: expect.any(String), aiConfigured: expect.any(Boolean), aiAvailable: expect.any(Boolean) });
  expect(['gemini', 'cloudflare']).toContain(body.provider);
  expect(body.aiAvailable).toBe(body.aiConfigured);
});

test('custom sizes preserve text geometry, fit, undo and survive reload', async ({ page }, testInfo) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  const read = () => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!));
  const original = await read();
  await page.getByRole('tab', { name: 'Design', exact: true }).click();
  await page.getByRole('button', { name: 'Custom size' }).click();
  for (const [width, height] of [[1600, 900], [1080, 1350], [1000, 1000], [4096, 256], [1600, 900]]) {
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.getByRole('textbox', { name: 'Width', exact: true }).fill(String(width));
    await page.getByRole('textbox', { name: 'Height', exact: true }).fill(String(height));
    const previous = await read();
    await page.getByRole('button', { name: 'Apply size' }).click();
    await expect(page.getByTestId('canvas-dimensions')).toHaveText(`${width} × ${height} px`);
    await expect(page.getByTestId('canvas-frame')).toHaveAttribute('data-logical-width', String(width));
    await expect(page.getByTestId('canvas-frame')).toHaveAttribute('data-logical-height', String(height));
    await expectFrameFits(page);
    await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
    const resized = await read();
    expect(resized.variants[0].elements).toEqual(original.variants[0].elements);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible(); expect(await read()).toEqual(previous);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible(); expect(await read()).toEqual(resized);
  }
  await page.reload();
  await expect(page.getByTestId('canvas-dimensions')).toHaveText('1600 × 900 px'); await expectFrameFits(page);
  expect((await read()).variants[0].elements).toEqual(original.variants[0].elements);
  await page.screenshot({ path: testInfo.outputPath('custom-restored.png'), fullPage: true });
});

test('custom invalid sizes including 160 by 900 never mutate the saved document', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  const read = () => page.evaluate(() => localStorage.getItem('frameflow:project:v1'));
  const original = await read();
  await page.getByRole('tab', { name: 'Design', exact: true }).click(); await page.getByRole('button', { name: 'Custom size' }).click();
  for (const [width, height] of [['160', '900'], ['', '900'], ['900', ''], ['900.5', '900'], ['-900', '900'], ['NaN', '900'], ['900', 'Infinity'], ['4097', '900'], ['4096', '4096']]) {
    await page.getByRole('textbox', { name: 'Width', exact: true }).fill(width);
    await page.getByRole('textbox', { name: 'Height', exact: true }).fill(height);
    await page.getByRole('button', { name: 'Apply size' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('canvas-dimensions')).toHaveText('1080 × 1350 px');
    expect(await read()).toBe(original);
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  expect(JSON.parse((await read())!).variants[0].elements).toHaveLength(0);
});
