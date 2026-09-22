import { expect, test, type Page } from '@playwright/test';

const nameInput = (page: Page) => page.getByRole('textbox', { name: 'Design name', exact: true });
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!));
const savedName = (page: Page, name: string) => expect.poll(async () => (await stored(page))?.name).toBe(name);

test('design name commits on Enter, persists, and supports one-step undo/redo', async ({ page }, testInfo) => {
  await page.goto('/');
  const input = nameInput(page);
  await expect(input).toHaveValue('New design');
  await input.click();
  await expect(input).toBeFocused();
  await input.fill('  Aarav & Meera — Wedding celebration  ');
  await page.screenshot({ path: testInfo.outputPath('design-name-editing.png'), animations: 'disabled' });
  await input.press('Enter');
  await expect(input).not.toBeFocused();
  await expect(input).toHaveValue('Aarav & Meera — Wedding celebration');
  await savedName(page, 'Aarav & Meera — Wedding celebration');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(input).toHaveValue('New design');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await savedName(page, 'Aarav & Meera — Wedding celebration');
  await page.getByRole('button', { name: /^Landscape/ }).click();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.reload();
  await expect(input).toHaveValue('Aarav & Meera — Wedding celebration');
  await expect(page.getByTestId('canvas-dimensions')).toHaveText('1600 × 900 px');
  await page.screenshot({ path: testInfo.outputPath('design-name-restored.png'), animations: 'disabled' });
  const titleBox = await input.boundingBox(), dimensions = await page.getByTestId('canvas-dimensions').boundingBox();
  const exportBox = await page.getByRole('button', { name: 'Export PNG' }).boundingBox();
  expect(titleBox!.x + titleBox!.width).toBeLessThan(dimensions!.x);
  expect(exportBox!.x + exportBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await input.fill('A very long wedding invitation design name — '.repeat(20));
  await input.press('Enter');
  expect((await input.boundingBox())!.width).toBe(titleBox!.width);
  await page.screenshot({ path: testInfo.outputPath('design-name-long.png'), animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('loads existing and blank legacy names, and safely recovers a missing required name', async ({ page }) => {
  await page.goto('/');
  await savedName(page, 'New design');
  const project = await stored(page);
  for (const name of ['Existing invitation', '', '   ']) {
    await page.evaluate((document) => localStorage.setItem('frameflow:project:v1', JSON.stringify(document)), { ...project, name });
    await page.reload();
    await expect(nameInput(page)).toHaveValue(name.trim() || 'New design');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  }
  delete project.name;
  await page.evaluate((document) => localStorage.setItem('frameflow:project:v1', JSON.stringify(document)), project);
  await page.reload();
  await expect(nameInput(page)).toHaveValue('New design');
  await expect(page.getByRole('alert')).toContainText('Saved design is invalid');
});

test('design name commits on blur and normalizes empty or whitespace names', async ({ page }) => {
  await page.goto('/');
  const input = nameInput(page);
  for (const value of ['  Reception  ', '', 'Another design', '   ']) {
    await input.fill(value);
    await page.getByRole('tab', { name: 'Text', exact: true }).click();
    const expected = value.trim() || 'New design';
    await expect(input).toHaveValue(expected);
    await savedName(page, expected);
  }
  await page.reload();
  await expect(input).toHaveValue('New design');
});

test('Escape cancels a draft without saving or adding history; unchanged blur is a no-op', async ({ page }) => {
  await page.goto('/');
  const input = nameInput(page);
  await input.fill('Original name'); await input.press('Enter');
  await savedName(page, 'Original name');
  const before = await stored(page);
  for (const draft of ['Discard this draft', '']) {
    await input.fill(draft); await input.press('Escape');
    await expect(input).toHaveValue('Original name');
    await expect(input).not.toBeFocused();
    expect(await stored(page)).toEqual(before);
  }
  await input.focus(); await input.press('Tab');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(input).toHaveValue('New design');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});
