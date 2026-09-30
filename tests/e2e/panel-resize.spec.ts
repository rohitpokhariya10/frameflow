import { expect, test, type Page } from '@playwright/test';

const separator = (page: Page) => page.getByRole('separator', { name: 'Resize design tools' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Design tools' });
async function dragTo(page: Page, width: number) {
  const handle = (await separator(page).boundingBox())!;
  const bounds = (await panel(page).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + width, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
}
async function expectWidth(page: Page, width: number) {
  await expect(separator(page)).toHaveAttribute('aria-valuenow', String(width));
  await expect.poll(async () => Math.round((await panel(page).boundingBox())!.width)).toBe(width);
  const viewport = (await page.getByTestId('canvas-viewport').boundingBox())!;
  expect(viewport.width).toBeGreaterThanOrEqual(359);
}

test('left panel drag resizes, clamps at both limits and persists across reload', async ({ page }) => {
  await page.goto('/');
  await dragTo(page, 350);
  await expect.poll(async () => (await panel(page).boundingBox())!.width).toBeGreaterThan(340);
  const saved = await separator(page).getAttribute('aria-valuenow');
  await page.reload();
  await expectWidth(page, Number(saved));
  await dragTo(page, 900);
  await expectWidth(page, 480);
  await dragTo(page, 80);
  await expectWidth(page, 224);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.reload();
  await expectWidth(page, 224);
});

test('left panel supports keyboard steps, Home/End and cancelling a drag', async ({ page }) => {
  await page.goto('/');
  const handle = separator(page);
  await handle.focus();
  await handle.press('Home'); await expectWidth(page, 224);
  await handle.press('ArrowRight'); await expectWidth(page, 234);
  await handle.press('Shift+ArrowRight'); await expectWidth(page, 284);
  await handle.press('ArrowLeft'); await expectWidth(page, 274);
  await handle.press('End'); await expectWidth(page, 480);
  const bounds = (await handle.boundingBox())!;
  await page.mouse.move(bounds.x + 4, bounds.y + 30); await page.mouse.down();
  await page.mouse.move(310, bounds.y + 30);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expectWidth(page, 480);
  await page.reload(); await expectWidth(page, 480);
});

test('left panel preserves its preference through narrow viewport fallback', async ({ page }, testInfo) => {
  await page.goto('/');
  await separator(page).focus(); await separator(page).press('End');
  await page.setViewportSize({ width: 1100, height: 800 });
  await expectWidth(page, 480);
  await page.setViewportSize({ width: 760, height: 800 });
  await expectWidth(page, 400);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(separator(page)).toBeHidden();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('.mobile-notice')).toBeVisible();
  await expect(page.getByTestId('canvas-frame')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('narrow-editor.png'), fullPage: true });
  await page.reload(); await expect(separator(page)).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectWidth(page, 480);
});
