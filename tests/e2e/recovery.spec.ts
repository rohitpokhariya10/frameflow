import { expect, test, type Page } from '@playwright/test';
import type { Stage } from 'konva/lib/Stage';
import type { Text } from 'konva/lib/shapes/Text';
import type { Transformer } from 'konva/lib/shapes/Transformer';

const saved = (page: Page) => expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
async function setNumber(page: Page, name: string, value: number) {
  const input = page.getByRole('spinbutton', { name, exact: true });
  await input.fill(String(value)); await input.press('Enter');
}
async function canvasState(page: Page) {
  return page.evaluate(() => {
    const stage = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0];
    const rect = stage.container().getBoundingClientRect();
    const anchor = stage.findOne<Transformer>('Transformer')?.findOne('.middle-right')?.getAbsolutePosition();
    return { zoom: stage.scaleX(), left: rect.x, top: rect.y, anchor,
      nodes: stage.find<Text>('.editable-text').map((node) => ({ text: node.text(), x: node.x(), y: node.y(), width: node.width(), height: node.height(), fontSize: node.fontSize(), family: node.fontFamily(), weight: node.fontStyle(), fill: node.fill() })) };
  });
}

test('recovers exact design and fitted geometry after refresh; history starts empty', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  const text = 'The Grand Royal Wedding Palace\nConnaught Place, New Delhi 👩🏽‍🎨';
  await page.getByLabel('Text content').fill(text);
  await page.getByLabel('Font family').selectOption('Inter');
  await page.getByLabel('Weight', { exact: true }).selectOption('700');
  await page.getByLabel('Color', { exact: true }).fill('#285443');
  await setNumber(page, 'X', 950); await setNumber(page, 'Y', 1250);
  await page.getByRole('tab', { name: 'Design', exact: true }).click();
  await page.getByRole('button', { name: /^Landscape/ }).click();
  await page.getByRole('button', { name: 'Auto Layout', exact: true }).click();
  await expect(page.locator('.layout-warning')).toHaveCount(0);
  await saved(page);
  const before = (await canvasState(page)).nodes;
  await page.screenshot({ path: testInfo.outputPath('saved-editor.png'), fullPage: true });
  await page.reload(); await saved(page);
  expect((await canvasState(page)).nodes).toEqual(before);
  await expect(page.getByTestId('canvas-dimensions')).toHaveText('1600 × 900 px');
  await expect(page.getByRole('heading', { name: 'Select an element' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('list', { name: 'Text elements' }).getByRole('button').click();
  await expect(page.getByLabel('Text content')).toHaveValue(text);
  const json = await page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!));
  for (const field of ['past', 'future', 'selectedElementId', 'zoom']) expect(json).not.toHaveProperty(field);
});

test('drag, resize and Auto Layout each undo in one step; redo restores fitted snapshot', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  await page.getByLabel('Text content').fill('A celebration together');
  let state = await canvasState(page); const original = state.nodes[0];
  const start = { x: state.left + (original.x + original.width / 2) * state.zoom, y: state.top + (original.y + original.height / 2) * state.zoom };
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + 35, start.y + 20, { steps: 10 }); await page.mouse.up();
  const moved = (await canvasState(page)).nodes[0]; expect(moved.x).not.toBe(original.x);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect((await canvasState(page)).nodes[0]).toEqual(original);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); expect((await canvasState(page)).nodes[0]).toEqual(moved);
  state = await canvasState(page);
  await page.mouse.move(state.left + state.anchor!.x, state.top + state.anchor!.y); await page.mouse.down();
  await page.mouse.move(state.left + state.anchor!.x - 40, state.top + state.anchor!.y, { steps: 10 }); await page.mouse.up();
  expect((await canvasState(page)).nodes[0].width).toBeLessThan(moved.width);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect((await canvasState(page)).nodes[0]).toEqual(moved);
  await setNumber(page, 'Y', 1320); const overflow = (await canvasState(page)).nodes[0];
  await page.getByRole('button', { name: 'Auto Layout', exact: true }).click();
  const fitted = (await canvasState(page)).nodes[0]; expect(fitted.y).toBeLessThan(overflow.y);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect((await canvasState(page)).nodes[0]).toEqual(overflow);
  await saved(page); await page.reload(); await saved(page);
  expect((await canvasState(page)).nodes[0]).toEqual(overflow);
  // Reload intentionally clears history. Fit again, then verify redo uses the fitted snapshot.
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('list', { name: 'Text elements' }).getByRole('button').click();
  await page.getByRole('button', { name: 'Auto Layout', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); expect((await canvasState(page)).nodes[0]).toEqual(fitted);
});

test('typing groups into one undo; shortcuts respect input, and new edits invalidate redo', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  const original = (await canvasState(page)).nodes[0].text;
  const textarea = page.getByLabel('Text content');
  await textarea.fill(''); await textarea.pressSequentially('Twenty letters typed', { delay: 20 });
  await textarea.press('Backspace'); await textarea.press('Delete');
  expect((await canvasState(page)).nodes).toHaveLength(1);
  for (const shortcut of ['Control+z', 'Meta+z', 'Control+Shift+z', 'Meta+Shift+z']) await textarea.press(shortcut);
  expect((await canvasState(page)).nodes).toHaveLength(1);
  await page.getByRole('main', { name: 'Canvas workspace' }).focus();
  await page.keyboard.press('Control+z');
  expect((await canvasState(page)).nodes[0].text).toBe(original);
  await page.keyboard.press('Control+Shift+z');
  expect((await canvasState(page)).nodes[0].text).not.toBe(original);
  await page.keyboard.press('Meta+z'); expect((await canvasState(page)).nodes[0].text).toBe(original);
  await page.keyboard.press('Meta+Shift+z');
  await setNumber(page, 'X', 250); await setNumber(page, 'X', 300);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await setNumber(page, 'Y', 500);
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
});

test('corrupt recovery and storage failures remain usable and truthful', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('frameflow:project:v1', '{broken'));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Could not recover');
  await expect(page.getByText('Could not save', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('frameflow:project:v1'))).toBe('{broken');
  await page.getByRole('button', { name: 'Dismiss recovery warning' }).click();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
  await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  await expect(page.getByText('Saving…', { exact: true })).toBeVisible();
  await expect(page.getByText('Could not save', { exact: true })).toBeVisible();
  expect((await canvasState(page)).nodes).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('save-error.png'), fullPage: true });
});
