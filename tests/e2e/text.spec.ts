import { expect, test, type Page } from '@playwright/test';
import type { Stage } from 'konva/lib/Stage';
import type { Text } from 'konva/lib/shapes/Text';
import type { Transformer } from 'konva/lib/shapes/Transformer';

// Read public Konva APIs for assertions only; all mutations go through real UI/pointer events.
async function canvasState(page: Page) {
  return page.evaluate(() => {
    const stage = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0];
    const rect = stage.container().getBoundingClientRect();
    const transformer = stage.findOne<Transformer>('Transformer');
    const anchors = (['middle-left', 'middle-right'] as const).map((name) => {
      const anchor = transformer?.findOne(`.${name}`);
      const position = anchor?.getAbsolutePosition();
      return position ? { x: rect.x + position.x, y: rect.y + position.y } : null;
    });
    return {
      zoom: stage.scaleX(), left: rect.x, top: rect.y, anchors,
      nodes: stage.find<Text>('.editable-text').map((node) => ({
        id: node.id(), x: node.x(), y: node.y(), width: node.width(), height: node.height(),
        fontSize: node.fontSize(), fontFamily: node.fontFamily(), fontStyle: node.fontStyle(),
        fill: node.fill(), align: node.align(), text: node.text(), scaleX: node.scaleX(), scaleY: node.scaleY(),
      })),
    };
  });
}

async function setNumber(page: Page, name: string, value: number | string) {
  const input = page.getByRole('spinbutton', { name, exact: true });
  await input.fill(String(value));
  await input.press('Enter');
}

test('creates all text types, edits exact content and typography, duplicates and deletes', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Text properties' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Text', exact: true })).toHaveAttribute('aria-selected', 'true');
  const text = 'Together, in full bloom\nAarav & Meera';
  await page.getByLabel('Text content').fill(text);
  await page.getByLabel('Font family').selectOption('Inter');
  await page.getByLabel('Weight', { exact: true }).selectOption('700');
  await setNumber(page, 'Font size', 64);
  await page.getByLabel('Color', { exact: true }).fill('#285443');
  await page.getByRole('button', { name: 'Align left' }).click();
  expect((await canvasState(page)).nodes[0]).toMatchObject({ text, fontFamily: 'Inter', fontStyle: '700', fontSize: 64, fill: '#285443', align: 'left' });
  await page.getByRole('button', { name: 'Add subheading' }).click();
  await page.getByRole('button', { name: 'Add body text' }).click();
  await expect(page.getByRole('list', { name: 'Text elements' }).getByRole('button')).toHaveCount(3);
  const nodes = (await canvasState(page)).nodes;
  expect(nodes.map((node) => node.fontSize)).toEqual([64, 38, 26]);
  await page.getByRole('list', { name: 'Text elements' }).getByRole('button').first().click();
  await expect(page.getByLabel('Text content')).toHaveValue(text);
  await page.getByLabel('Font family').selectOption('Lora');
  await page.getByRole('button', { name: 'Align center' }).click();
  const deleteBounds = await page.getByRole('button', { name: 'Delete', exact: true }).boundingBox();
  expect(deleteBounds).not.toBeNull();
  expect(deleteBounds!.y + deleteBounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: testInfo.outputPath('text-editor.png'), fullPage: true });
  const original = (await canvasState(page)).nodes[0];
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  const copy = (await canvasState(page)).nodes[3];
  expect(copy).toMatchObject({ text, fontFamily: 'Lora', fontSize: 64, x: original.x + 24, y: original.y + 24 });
  expect(copy.id).not.toBe(original.id);
  await expect(page.getByRole('list', { name: 'Text elements' }).getByRole('button').last()).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  expect((await canvasState(page)).nodes).toHaveLength(3);
  await expect(page.getByRole('heading', { name: 'Select an element' })).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  const fits = await page.getByRole('complementary', { name: 'Properties', exact: true }).evaluate((node) => node.scrollWidth <= node.clientWidth);
  expect(fits).toBe(true);
});

test('dragging at two zoom levels commits logical coordinates only on release', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  for (let pass = 0; pass < 2; pass++) {
    if (pass) {
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    }
    const before = await canvasState(page);
    const node = before.nodes[0];
    const start = { x: before.left + (node.x + node.width / 2) * before.zoom, y: before.top + (node.y + node.height / 2) * before.zoom };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 40, start.y + 25, { steps: 8 });
    await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue(String(Number(node.x.toFixed(2))));
    await page.mouse.up();
    const after = (await canvasState(page)).nodes[0];
    expect(after.x - node.x).toBeCloseTo(40 / before.zoom, 0);
    expect(after.y - node.y).toBeCloseTo(25 / before.zoom, 0);
    await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue(String(Number(after.x.toFixed(2))));
  }
});

test('both side handles reflow text at two zoom levels without scaling glyphs', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  await page.getByLabel('Text content').fill('The Grand Royal Wedding Palace, Connaught Place, New Delhi, India');
  for (let pass = 0; pass < 2; pass++) {
    if (pass) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    const before = await canvasState(page);
    const node = before.nodes[0];
    const anchor = before.anchors[pass === 0 ? 1 : 0];
    expect(anchor).not.toBeNull();
    if (!anchor) throw new Error('Missing side handle');
    await page.mouse.move(anchor.x, anchor.y);
    await page.mouse.down();
    await page.mouse.move(anchor.x + (pass === 0 ? -70 : 35), anchor.y, { steps: 10 });
    const live = (await canvasState(page)).nodes[0];
    expect(live.scaleX).toBe(1);
    expect(live.scaleY).toBe(1);
    expect(live.fontSize).toBe(node.fontSize);
    await expect(page.getByRole('spinbutton', { name: 'Text box width' })).toHaveValue(String(Number(node.width.toFixed(2))));
    await page.mouse.up();
    const after = (await canvasState(page)).nodes[0];
    expect(after.width).toBeLessThan(node.width - 25);
    expect(after.height).toBeGreaterThanOrEqual(node.height);
    expect(after.fontSize).toBe(node.fontSize);
    expect(after.text).toBe(node.text);
    expect(after.scaleX).toBe(1);
    if (pass === 1) expect(after.x).toBeGreaterThan(node.x);
    await expect(page.getByRole('spinbutton', { name: 'Text box width' })).toHaveValue(String(Number(after.width.toFixed(2))));
  }
  await page.screenshot({ path: testInfo.outputPath('resized-text.png'), fullPage: true });
});

test('selection, Escape and delete shortcuts respect typing and interaction ownership', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  const input = page.getByLabel('Text content');
  await input.fill('Keep this text');
  await input.press('End');
  await input.press('Backspace');
  await input.press('Delete');
  await expect(input).toHaveValue('Keep this tex');
  expect((await canvasState(page)).nodes).toHaveLength(1);
  await page.getByLabel('Font family').focus();
  await page.keyboard.press('Backspace');
  expect((await canvasState(page)).nodes).toHaveLength(1);
  await page.getByRole('main', { name: 'Canvas workspace' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Select an element' })).toBeVisible();
  let state = await canvasState(page);
  let node = state.nodes[0];
  await page.mouse.click(state.left + (node.x + node.width / 2) * state.zoom, state.top + (node.y + node.height / 2) * state.zoom);
  await expect(input).toHaveValue('Keep this tex');
  await page.mouse.click(state.left + 10, state.top + 10);
  await expect(page.getByRole('heading', { name: 'Select an element' })).toBeVisible();
  await page.getByRole('list', { name: 'Text elements' }).getByRole('button').click();
  await page.keyboard.press('Backspace');
  expect((await canvasState(page)).nodes).toHaveLength(0);
  await page.getByRole('tab', { name: 'Design', exact: true }).click();
  await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  state = await canvasState(page); node = state.nodes[0];
  // Konva batches drawing: the node exists before the next frame paints its hit map.
  // Wait for the real pointer target, rather than clicking a still-blank hit canvas.
  await expect.poll(() => page.evaluate(({ x, y }) => {
    const stage = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0];
    return stage.getIntersection({ x, y })?.id();
  }, { x: (node.x + node.width / 2) * state.zoom, y: (node.y + node.height / 2) * state.zoom })).toBe(node.id);
  await page.mouse.click(state.left + (node.x + node.width / 2) * state.zoom, state.top + (node.y + node.height / 2) * state.zoom);
  await expect(input).toHaveValue('Add a beautiful heading');
  await page.keyboard.press('Delete');
  expect((await canvasState(page)).nodes).toHaveLength(0);
});

test('numeric bounds, empty text recovery, and preset changes preserve logical content', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Story/ }).click();
  await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  await setNumber(page, 'Y', 1400);
  const before = (await canvasState(page)).nodes[0];
  await page.getByRole('tab', { name: 'Design', exact: true }).click();
  await page.getByRole('button', { name: /^Landscape/ }).click();
  expect((await canvasState(page)).nodes[0]).toEqual(before);
  await page.getByRole('main', { name: 'Canvas workspace' }).focus();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('list', { name: 'Text elements' }).getByRole('button').click();
  await setNumber(page, 'Y', 200);
  await setNumber(page, 'X', 200);
  await setNumber(page, 'Text box width', 400);
  await setNumber(page, 'Font size', -10);
  await expect(page.getByRole('spinbutton', { name: 'Font size' })).toHaveValue('8');
  await setNumber(page, 'Font size', '');
  await expect(page.getByRole('alert')).toContainText('finite number');
  expect((await canvasState(page)).nodes[0].fontSize).toBe(8);
  await setNumber(page, 'Font size', 72);
  await setNumber(page, 'X', 99999);
  expect((await canvasState(page)).nodes[0].x).toBe(1600 - 24);
  await setNumber(page, 'X', 200);
  await page.getByLabel('Text content').fill('');
  await page.getByRole('main', { name: 'Canvas workspace' }).focus();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Empty text/ }).click();
  await page.getByLabel('Text content').fill('Recovered, without Auto Layout.');
  expect((await canvasState(page)).nodes[0]).toMatchObject({ text: 'Recovered, without Auto Layout.', x: 200, y: 200, width: 400 });
});

test('all advertised font faces are loaded before text renders', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  const loaded = await page.evaluate(() => [...document.fonts].filter((font) => font.status === 'loaded').map((font) => `${font.family.replace(/['"]/g, '')}:${font.weight}`));
  expect(loaded).toEqual(expect.arrayContaining(['Inter:400', 'Inter:600', 'Inter:700', 'Lora:400', 'Lora:600', 'Lora:700']));
});
