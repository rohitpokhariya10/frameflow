import { expect, test, type Page } from '@playwright/test';
import type { Stage } from 'konva/lib/Stage';
import type { Text } from 'konva/lib/shapes/Text';
import type { Transformer } from 'konva/lib/shapes/Transformer';

async function nodeState(page: Page) {
  return page.evaluate(() => {
    const stage = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0];
    const node = stage.findOne<Text>('.editable-text')!;
    const transformer = stage.findOne<Transformer>('Transformer')!;
    return { text: node.text(), x: node.x(), y: node.y(), width: node.width(), height: node.height(), textWidth: node.getTextWidth(),
      fontSize: node.fontSize(), scaleX: node.scaleX(), scaleY: node.scaleY(),
      attached: transformer.nodes()[0] === node, anchors: transformer.enabledAnchors() };
  });
}
async function setNumber(page: Page, name: string, value: number) {
  const input = page.getByRole('spinbutton', { name, exact: true });
  await input.fill(String(value)); await input.press('Enter');
}
async function expectInside(page: Page) {
  const node = await nodeState(page);
  const frame = page.getByTestId('canvas-frame');
  const width = Number(await frame.getAttribute('data-logical-width'));
  const height = Number(await frame.getAttribute('data-logical-height'));
  const margin = Math.max(12, Math.min(96, Math.round(Math.min(width, height) * 0.04)));
  expect(node.x).toBeGreaterThanOrEqual(margin - 1);
  expect(node.y).toBeGreaterThanOrEqual(margin - 1);
  expect(node.x + Math.max(node.width, node.textWidth)).toBeLessThanOrEqual(width - margin + 1);
  expect(node.y + node.height).toBeLessThanOrEqual(height - margin + 1);
  expect(node.height).toBeGreaterThan(0);
  expect(node).toMatchObject({ scaleX: 1, scaleY: 1, attached: true, anchors: ['middle-left', 'middle-right'] });
}
const warning = 'Text extends outside the safe frame.';
async function expectFeedbackInView(page: Page, selector: string) {
  const bounds = await page.locator(selector).boundingBox();
  const inspector = await page.locator('.text-inspector').boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(inspector!.y);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(inspector!.y + inspector!.height);
}

test('long venue fits with actual fonts, truthful warning, intact content, and idempotence', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  const text = 'The Grand Royal Wedding Palace, Connaught Place, New Delhi, India';
  await page.getByLabel('Text content').fill(text);
  await setNumber(page, 'X', 950); await setNumber(page, 'Y', 1250);
  await expect(page.getByText(warning, { exact: true })).toBeVisible();
  await expectFeedbackInView(page, '.layout-warning');
  await page.screenshot({ path: testInfo.outputPath('auto-layout-warning.png'), fullPage: true });
  const before = await nodeState(page);
  await page.getByRole('button', { name: 'Auto Layout', exact: true }).click();
  await expect(page.getByText(warning, { exact: true })).toHaveCount(0);
  await expect(page.locator('.layout-feedback')).toContainText('Moved');
  await expectFeedbackInView(page, '.layout-feedback');
  await expectInside(page);
  const fitted = await nodeState(page);
  expect(fitted.text).toBe(text);
  expect(fitted.fontSize).toBe(before.fontSize);
  await expect(page.getByLabel('Text content')).toHaveValue(text);
  await page.screenshot({ path: testInfo.outputPath('auto-layout-fitted.png'), fullPage: true });
  const control = await page.getByRole('button', { name: 'Auto Layout', exact: true }).boundingBox();
  expect(control!.y + control!.height).toBeLessThan(page.viewportSize()!.height);
  await page.getByRole('button', { name: 'Auto Layout', exact: true }).click();
  await expect(page.getByText('This text already fits.', { exact: true })).toBeVisible();
  expect(await nodeState(page)).toEqual(fitted);
  // Existing width handles remain functional after an atomic fit.
  await setNumber(page, 'Text box width', 600);
  expect((await nodeState(page)).fontSize).toBe(fitted.fontSize);
  expect(errors).toEqual([]);
});

test('impossible explicit paragraphs retain original geometry and show unresolved feedback', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Custom size' }).click();
  await page.getByRole('textbox', { name: 'Width', exact: true }).fill('256');
  await page.getByRole('textbox', { name: 'Height', exact: true }).fill('256');
  await page.getByRole('button', { name: 'Apply size' }).click();
  await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  await page.getByLabel('Text content').fill('Line one 👩🏽‍🎨\nLine two\n'.repeat(70));
  const before = await nodeState(page);
  await page.getByRole('button', { name: 'Auto Layout', exact: true }).click();
  await expect(page.getByText('This text cannot fit at a readable size. Try a larger canvas or shorter copy.', { exact: true })).toBeVisible();
  expect(await nodeState(page)).toEqual(before);
  await expectFeedbackInView(page, '.layout-feedback');
  await page.screenshot({ path: testInfo.outputPath('auto-layout-unresolved.png'), fullPage: true });
});

test('real renderer widens narrow graphemes, preserves tokens/newlines and reduces only when necessary', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  const text = '👩🏽‍🎨 Family 👨‍👩‍👧‍👦\nSupercalifragilisticexpialidociousWeddingVenue123456789';
  await page.getByLabel('Text content').fill(text);
  await setNumber(page, 'Text box width', 32);
  await expect(page.getByText(warning, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Auto Layout', exact: true }).click();
  await expect(page.getByText(warning, { exact: true })).toHaveCount(0);
  expect((await nodeState(page)).text).toBe(text);
  expect((await nodeState(page)).fontSize).toBe(72);
  expect((await nodeState(page)).width).toBeGreaterThan(32);
  await expectInside(page);
  await page.getByLabel('Font family').selectOption('Inter');
  await page.getByLabel('Weight', { exact: true }).selectOption('700');
  const longText = 'A joyful celebration with everyone we love. '.repeat(45);
  await page.getByLabel('Text content').fill(longText);
  await setNumber(page, 'Font size', 120);
  await page.getByRole('button', { name: 'Auto Layout', exact: true }).click();
  await expect(page.locator('.layout-feedback')).toContainText('Font reduced from 120');
  const reduced = await nodeState(page);
  expect(reduced.text).toBe(longText);
  expect(reduced.fontSize).toBeGreaterThanOrEqual(18);
  expect(reduced.fontSize).toBeLessThan(120);
  await expectInside(page);
  await page.getByRole('button', { name: 'Auto Layout', exact: true }).click();
  await expect(page.getByText('This text already fits.')).toBeVisible();
  expect(await nodeState(page)).toEqual(reduced);
  // A slightly larger size cannot fit even after moving to the top of the safe region.
  await setNumber(page, 'Font size', reduced.fontSize + 0.02);
  expect((await nodeState(page)).height).toBeGreaterThan(1350 - 43 * 2 + 1);
  await expect(page.getByText(warning, { exact: true })).toBeVisible();
});

test('overflow reacts to canvas, content and typography; empty and small text safely no-op', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  await page.getByLabel('Text content').fill('Wedding');
  await setNumber(page, 'Y', 900);
  await expect(page.getByText(warning, { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Design', exact: true }).click();
  await page.getByRole('button', { name: /^Landscape/ }).click();
  await expect(page.getByText(warning, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Auto Layout', exact: true }).click();
  await expect(page.getByText(warning, { exact: true })).toHaveCount(0);
  await setNumber(page, 'Font size', 512);
  await expect(page.getByText(warning, { exact: true })).toBeVisible();
  await page.getByLabel('Text content').fill('');
  await expect(page.getByText(warning, { exact: true })).toHaveCount(0);
  const empty = await nodeState(page);
  await page.getByRole('button', { name: 'Auto Layout', exact: true }).click();
  await expect(page.getByText('Add text to use Auto Layout.')).toBeVisible();
  expect(await nodeState(page)).toEqual(empty);
  await page.getByLabel('Text content').fill('Intentionally small');
  await setNumber(page, 'Font size', 8);
  await setNumber(page, 'X', -10);
  await page.getByRole('button', { name: 'Auto Layout', exact: true }).click();
  await expect(page.getByText(warning, { exact: true })).toHaveCount(0);
  expect((await nodeState(page)).fontSize).toBe(8);
  await expectInside(page);
});
