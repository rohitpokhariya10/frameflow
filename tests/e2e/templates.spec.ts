import { expect, test, type Page } from '@playwright/test';
import type { Group } from 'konva/lib/Group';
import type { Image as KonvaImage } from 'konva/lib/shapes/Image';
import type { Text } from 'konva/lib/shapes/Text';
import type { Stage } from 'konva/lib/Stage';

// The reusable-template flow ("Create Own Template") end to end in the real app. It is local by design, so this test
// needs no provider and no credit: every /api request is blocked, and the test fails if the flow attempts one.
// Konva is read through its public API for assertions only; every change goes through the real UI and pointer.
const LIBRARY_KEY = 'frameflow:design-templates:v1';
const RATIOS = { '1:1': [1080, 1080], '4:5': [1080, 1350], '3:4': [1080, 1440], '9:16': [1080, 1920], '16:9': [1920, 1080] } as const;
const HEADING = [0.05, 0.05, 0.6, 0.1];
type Layout = { x: number; y: number; width: number; height: number; rotation: number };
type StoredTemplate = { id: string; name: string; version: number; elements: { id: string; name: string; layout: Layout }[] };
type StoredLibrary = { templates: StoredTemplate[]; creatives: { name: string; templateVersion: number; aspectRatio: string; contentOverrides: Record<string, Record<string, unknown>> }[] };

/** The template canvas as Konva drew it: its logical size, and each element's box in pixels and as fractions of the canvas. */
const canvasState = (page: Page) => page.evaluate(() => {
  const frame = document.querySelector<HTMLElement>('[data-testid="template-canvas"]')!;
  const stage = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages.find(item => frame.contains(item.container()))!;
  const width = Number(frame.dataset.logicalWidth), height = Number(frame.dataset.logicalHeight);
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  const elements = stage.find<Group>('.template-element').map((node) => {
    const box = [node.x() - node.offsetX(), node.y() - node.offsetY(), node.offsetX() * 2, node.offsetY() * 2];
    return { id: node.id(), pixels: box.map(round), fractions: [box[0] / width, box[1] / height, box[2] / width, box[3] / height].map(round), draggable: node.draggable() };
  });
  const heading = stage.find<Text>('.template-text')[0];
  return { size: [width, height], elements, pictures: stage.find<KonvaImage>('.template-image').length,
    headingText: heading ? { fontSize: heading.fontSize(), height: heading.height() } : undefined };
});
const library = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null') as StoredLibrary | null, LIBRARY_KEY);
const layoutField = (page: Page, label: string) => page.locator('.tpl-panel label.tpl-field').filter({ has: page.locator('span', { hasText: new RegExp(`^${label}$`) }) }).getByRole('spinbutton');
async function setLayout(page: Page, values: Record<string, number>) {
  for (const [label, value] of Object.entries(values)) { const input = layoutField(page, label); await input.fill(String(value)); await input.blur(); }
}
const fields = (page: Page, element: string) => page.locator('fieldset.tpl-fields').filter({ has: page.locator('legend', { hasText: element }) });
/** Drags the element at `index` by a fraction of the canvas, with the real pointer. */
async function dragElement(page: Page, index: number, by: [number, number]) {
  const frame = (await page.getByTestId('template-canvas').boundingBox())!, [x, y, width, height] = (await canvasState(page)).elements[index].fractions;
  const from = { x: frame.x + (x + width / 2) * frame.width, y: frame.y + (y + height / 2) * frame.height };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by[0] * frame.width / 2, from.y + by[1] * frame.height / 2, { steps: 4 });
  await page.mouse.move(from.x + by[0] * frame.width, from.y + by[1] * frame.height, { steps: 4 });
  await page.mouse.up();
}
/** The x, y, w, h percentages shown in the layout debug panel. */
async function debugPercentages(page: Page) {
  const text = await page.getByTestId('layout-debug').innerText();
  return ['x', 'y', 'w', 'h'].map(key => Number(new RegExp(`${key}: ([\\d.]+)%`).exec(text)![1]));
}

test('reusable template flow: author, every ratio, creatives, versions and the editor, with no API request', async ({ page }) => {
  test.setTimeout(90_000);
  const apiRequests: string[] = [], externalRequests: string[] = [];
  await page.route(url => url.pathname.startsWith('/api/'), (route) => { apiRequests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`); return route.abort(); });
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  page.on('request', (request) => { const url = new URL(request.url()); if (/^https?:$/.test(url.protocol) && url.origin !== origin) externalRequests.push(request.url()); });
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  const launcher = page.locator('.decomp-launch', { hasText: 'Create Own Template' });
  const card = page.locator('.tpl-card').filter({ has: page.locator('strong', { hasText: /^Festival Campaign$/ }) });
  const layer = (name: string) => page.locator('.tpl-layers button', { hasText: name }).first();
  const headingOf = async () => (await canvasState(page)).elements[1];
  let templateV1: StoredTemplate;

  await test.step('Create Own Template opens the authoring editor; elements are added and arranged on the 1:1 canvas', async () => {
    await launcher.click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: /Create Own Template/ })).toBeVisible();
    await page.getByLabel('Template name').fill('Festival Campaign');
    for (const name of ['+ Background', '+ Heading', '+ Paragraph', '+ Hero', '+ CTA']) await page.getByRole('button', { name, exact: true }).click();
    await expect.poll(async () => (await canvasState(page)).elements.length).toBe(5);
    await layer('Heading').click();
    await setLayout(page, { X: 5, Y: 5, Width: 60, Height: 10 });
    await page.locator('.tpl-panel textarea').first().fill('DIWALI OFFER');
    await expect(page.getByTestId('layout-debug')).toHaveText(/x: 5\.00%\s*y: 5\.00%\s*w: 60\.00%\s*h: 10\.00%\s*rotation: 0°\s*zIndex: 1/);
    expect((await canvasState(page)).size).toEqual([1080, 1080]);
  });

  await test.step('a drag on the canvas is stored as normalized values, and cannot leave the canvas', async () => {
    await page.getByRole('group', { name: 'Aspect preview' }).getByRole('button', { name: '4:5', exact: true }).click();
    await expect.poll(async () => (await canvasState(page)).size).toEqual([1080, 1350]);
    await dragElement(page, 1, [0.1, 0.2]);
    await expect.poll(async () => (await debugPercentages(page))[0]).toBeGreaterThan(14);
    const [x, y, width, height] = await debugPercentages(page);
    expect(Math.abs(x - 15)).toBeLessThan(1);
    expect(Math.abs(y - 25)).toBeLessThan(1);
    // Only the position was converted: the size is exactly what it was.
    expect([width, height]).toEqual([60, 10]);
    // Dragged well past the top-left corner: the element stops at the canvas edge.
    await dragElement(page, 1, [-0.6, -0.6]);
    await expect(page.getByTestId('layout-debug')).toHaveText(/x: 0\.00%\s*y: 0\.00%\s*w: 60\.00%\s*h: 10\.00%/);
    await setLayout(page, { X: 5, Y: 5 });
    await page.getByRole('group', { name: 'Aspect preview' }).getByRole('button', { name: '1:1', exact: true }).click();
  });

  await test.step('the same normalized layout drives every aspect ratio', async () => {
    for (const [ratio, size] of Object.entries(RATIOS)) {
      await page.getByRole('group', { name: 'Aspect preview' }).getByRole('button', { name: ratio, exact: true }).click();
      await expect.poll(async () => (await canvasState(page)).size).toEqual(size);
      const state = await canvasState(page);
      // 5% from the left and top, 60% wide, 10% high in every ratio; the pixels follow the canvas.
      expect(state.elements[1].fractions).toEqual(HEADING);
      expect(state.elements[1].pixels).toEqual([0.05 * size[0], 0.05 * size[1], 0.6 * size[0], 0.1 * size[1]].map(value => Math.round(value * 1e6) / 1e6));
      expect(state.elements[0].pixels).toEqual([0, 0, size[0], size[1]]);
      // Switching the ratio re-renders the same five elements: no copies.
      expect(state.elements).toHaveLength(5);
      await expect(page.getByTestId('layout-debug')).toHaveText(/x: 5\.00%\s*y: 5\.00%\s*w: 60\.00%\s*h: 10\.00%/);
    }
    await page.getByRole('group', { name: 'Aspect preview' }).getByRole('button', { name: '4:5', exact: true }).click();
    await expect.poll(async () => (await headingOf()).pixels).toEqual([54, 67.5, 648, 135]);
  });

  await test.step('the template is saved with normalized geometry only, and survives a reload', async () => {
    await page.getByRole('button', { name: /^Save Template/ }).click();
    await expect(page.getByText('Saved "Festival Campaign" as version 1.')).toBeVisible();
    const stored = (await library(page))!;
    expect(stored.templates).toHaveLength(1);
    templateV1 = stored.templates[0];
    expect(templateV1.elements.find(element => element.name === 'Heading')!.layout).toEqual({ x: 0.05, y: 0.05, width: 0.6, height: 0.1, rotation: 0 });
    for (const { layout } of templateV1.elements) {
      expect(Object.keys(layout)).toEqual(['x', 'y', 'width', 'height', 'rotation']);
      for (const value of [layout.x, layout.y, layout.width, layout.height]) { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1); }
    }
    await page.reload();
    await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
    await launcher.click();
    await expect(card).toContainText('version 1 · 5 elements');
  });

  const creativeGeometry: Record<string, number[][]> = {};
  await test.step('two creatives of the template differ in content and share its geometry, which is locked', async () => {
    const picture = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 200;
      const context = canvas.getContext('2d')!; context.fillStyle = '#c0392b'; context.fillRect(0, 0, 200, 200); context.fillStyle = '#2c3e80'; context.fillRect(200, 0, 200, 200);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    for (const [name, text, ratio, colour] of [['Diwali Cashback Campaign', 'Diwali Offer', '1:1', '#F4A261'], ['Holi Cashback Campaign', 'Holi Offer', '4:5', '#F48FB1']] as const) {
      await card.getByRole('button', { name: 'Use Template' }).click();
      await expect(page.getByRole('dialog').getByRole('heading', { name: /Use Template/ })).toBeVisible();
      await page.getByLabel('Creative name').fill(name);
      await page.getByRole('group', { name: 'Aspect ratio' }).getByRole('button', { name: ratio, exact: true }).click();
      await expect.poll(async () => (await canvasState(page)).size).toEqual(RATIOS[ratio]);
      const before = (await canvasState(page)).elements.map(element => element.fractions);
      await fields(page, 'Heading').locator('textarea').fill(text);
      await fields(page, 'Background').getByLabel('Colour hex').fill(colour);
      if (name.startsWith('Holi')) {
        // Replacing the picture of an image slot, and longer wording, change content only.
        await fields(page, 'Hero image').locator('input[type=file]').setInputFiles({ name: 'hero.png', mimeType: 'image/png', buffer: Buffer.from(picture, 'base64') });
        await expect.poll(async () => (await canvasState(page)).pictures).toBe(1);
        await fields(page, 'Heading').locator('textarea').fill('MEGA FESTIVE CASHBACK OFFER');
        await expect.poll(async () => (await canvasState(page)).headingText!.fontSize).toBeLessThan(81);
        const shrunk = await canvasState(page);
        // The wording shrank to fit inside the unchanged 648 × 135 px box.
        expect(shrunk.headingText!.height).toBeLessThanOrEqual(135.5);
        expect(shrunk.elements[1].pixels).toEqual([54, 67.5, 648, 135]);
        await fields(page, 'Heading').locator('textarea').fill('MEGA FESTIVE CASHBACK OFFER '.repeat(14));
        await expect(page.getByText(/"Heading" does not fit its box even at the smallest font size/)).toBeVisible();
        await fields(page, 'Heading').locator('textarea').fill(text);
        await expect(page.getByText(/does not fit its box/)).toHaveCount(0);
      }
      const after = await canvasState(page);
      expect(after.elements.map(element => element.fractions)).toEqual(before);
      // Geometry is locked in a creative: nothing is draggable, and a drag moves nothing.
      expect(after.elements.map(element => element.draggable)).toEqual([false, false, false, false, false]);
      await dragElement(page, 1, [0.1, 0.1]);
      expect((await canvasState(page)).elements.map(element => element.fractions)).toEqual(before);
      creativeGeometry[name] = before;
      await page.getByRole('button', { name: 'Save Creative' }).click();
      await expect(page.getByText(`Saved creative "${name}".`)).toBeVisible();
    }
    expect(creativeGeometry['Holi Cashback Campaign']).toEqual(creativeGeometry['Diwali Cashback Campaign']);
    expect(creativeGeometry['Holi Cashback Campaign'][1]).toEqual(HEADING);
    const stored = (await library(page))!;
    // A creative stores its template version, its ratio and what it changed: no geometry. The template is untouched.
    expect(stored.creatives.map(creative => [creative.name, creative.templateVersion, creative.aspectRatio])).toEqual([['Diwali Cashback Campaign', 1, '1:1'], ['Holi Cashback Campaign', 1, '4:5']]);
    expect(stored.creatives.map(creative => Object.values(creative.contentOverrides).flatMap(override => Object.keys(override)).sort())).toEqual([['color', 'text'], ['assetId', 'color', 'text']]);
    expect(stored.templates).toEqual([templateV1]);
  });

  await test.step('editing the template adds version 2; version 1 and its creatives stay as they were', async () => {
    const before = (await library(page))!;
    await card.getByRole('button', { name: 'Edit Template' }).click();
    await layer('Heading').click();
    await setLayout(page, { Y: 30 });
    await page.getByRole('button', { name: /^Save Template/ }).click();
    await expect(page.getByText('Saved as version 2. 2 existing creatives stay on the earlier version and are unchanged.')).toBeVisible();
    const stored = (await library(page))!;
    expect(stored.templates.map(template => template.version)).toEqual([1, 2]);
    expect(stored.templates[0]).toEqual(templateV1);
    expect(stored.templates[1].elements.find(element => element.name === 'Heading')!.layout.y).toBe(0.3);
    expect(stored.creatives).toEqual(before.creatives);
  });

  await test.step('a saved creative opens in the existing editor at the same geometry', async () => {
    await page.locator('.tpl-creatives button', { hasText: 'Holi Cashback Campaign' }).click();
    await expect(page.getByText('This creative uses version 1 of the template and stays on it. Version 2 exists.')).toBeVisible();
    // Still version 1's layout: the heading is 5% from the top, not the 30% of version 2.
    await expect.poll(async () => (await headingOf()).pixels).toEqual([54, 67.5, 648, 135]);
    await page.getByRole('button', { name: 'Open in editor' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('canvas-dimensions')).toHaveText(/1080 × 1350/);
    const editor = () => page.evaluate(() => {
      const stage = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0];
      return { texts: stage.find<Text>('.editable-text').map(node => ({ text: node.text(), x: node.x(), y: node.y(), width: node.width() })),
        layers: stage.find<Group>('.design-layer').length, pictures: stage.find<KonvaImage>('.layer-image').map(node => [node.width(), node.height()].map(value => Math.round(value * 1e6) / 1e6)),
        buttons: stage.find('.text-box').length, order: stage.find((node: Group) => node.hasName('editable-text') || node.hasName('design-layer')).map(node => node.getClassName()) };
    });
    await expect.poll(async () => (await editor()).pictures).toEqual([[540, 742.5]]);
    const opened = await editor();
    expect(opened.texts).toContainEqual({ text: 'Holi Offer', x: 54, y: 67.5, width: 648 });
    expect(opened.texts.map(item => item.text)).toEqual(['Holi Offer', 'Paragraph text', 'Call to action']);
    // One layer, the hero picture: the CTA stays one text with its button, and keeps its place above the picture.
    expect(opened.layers).toBe(1);
    expect(opened.buttons).toBe(1);
    expect(opened.order).toEqual(['Text', 'Text', 'Group', 'Text']);
  });

  // Nothing in the whole flow asked a server for anything: no OpenAI, no fal, no decomposition.
  expect(apiRequests).toEqual([]);
  expect(externalRequests).toEqual([]);
});

// The three properties a creative used to lose on its way into the editor: the place of text in the layer order, text
// rotation, and the overflow rules of a text box. One template (background z0, a rotated text z1, the hero picture z2,
// a two-line heading z3), one creative with a long heading, opened in the editor, then reloaded.
test('a creative opens in the editor with its z-order, rotation, raw text and overflow rules, and keeps them after a reload', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const LONG = 'MEGA FESTIVE CASHBACK OFFER FOR EVERY NEW AND EXISTING CUSTOMER THIS FESTIVE SEASON ACROSS ALL OUR BRANCHES';
  const apiRequests: string[] = [];
  await page.route(url => url.pathname.startsWith('/api/'), (route) => { apiRequests.push(new URL(route.request().url()).pathname); return route.abort(); });
  await page.goto('/');
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  const layer = (name: string) => page.locator('.tpl-layers button', { hasText: name }).first();

  // The template, authored on the 1:1 canvas.
  await page.locator('.decomp-launch', { hasText: 'Create Own Template' }).click();
  await page.getByLabel('Template name').fill('Order and rotation');
  for (const name of ['+ Background', '+ Text', '+ Hero', '+ Heading']) await page.getByRole('button', { name, exact: true }).click();
  await layer('Text').click();
  await setLayout(page, { X: 10, Y: 30, Width: 50, Height: 8, Rotation: 15 });
  await page.locator('.tpl-panel textarea').first().fill('Limited time only');
  await layer('Hero image').click();
  await setLayout(page, { X: 30, Y: 25, Width: 60, Height: 50 });
  const picture = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 200;
    const context = canvas.getContext('2d')!; context.fillStyle = '#1e8449'; context.fillRect(0, 0, 200, 200); context.fillStyle = '#f1c40f'; context.fillRect(200, 0, 200, 200);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('.tpl-panel input[type=file]').first().setInputFiles({ name: 'hero.png', mimeType: 'image/png', buffer: Buffer.from(picture, 'base64') });
  await expect.poll(async () => (await canvasState(page)).pictures).toBe(1);
  await layer('Heading').click();
  await setLayout(page, { X: 5, Y: 20, Width: 60, Height: 10 });
  await page.getByRole('button', { name: /^Save Template/ }).click();
  await expect(page.getByText('Saved "Order and rotation" as version 1.')).toBeVisible();
  const template = (await library(page))!.templates[0];
  expect(template.elements.map(element => element.name)).toEqual(['Background', 'Text', 'Hero image', 'Heading']);
  const [, ribbon, hero, heading] = template.elements;

  // The creative: the heading becomes far longer than its two lines.
  await page.locator('.tpl-card').getByRole('button', { name: 'Use Template' }).click();
  await page.getByRole('group', { name: 'Aspect ratio' }).getByRole('button', { name: '4:5', exact: true }).click();
  await expect.poll(async () => (await canvasState(page)).size).toEqual([1080, 1350]);
  await fields(page, 'Heading').locator('textarea').fill(LONG);
  await expect(page.getByText(/"Heading" does not fit its box even at the smallest font size/)).toBeVisible();
  await page.getByRole('button', { name: 'Save Creative' }).click();
  await expect(page.getByText(/^Saved creative/)).toBeVisible();
  /** Each element as Template Studio draws it: where its own corner lands on the canvas, its size, rotation and drawn text. */
  const studio = await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('[data-testid="template-canvas"]')!;
    const stage = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages.find(item => frame.contains(item.container()))!;
    const round = (value: number) => Math.round(value * 1e6) / 1e6;
    return stage.find<Group>('.template-element').filter(node => !node.hasName('template-element-background')).map((node) => {
      // The node turns about its centre; this is its top-left corner after that turn, in canvas pixels.
      const corner = node.getTransform().point({ x: 0, y: 0 }), text = node.findOne<Text>('.template-text');
      return { id: node.id(), x: round(corner.x), y: round(corner.y), width: round(node.offsetX() * 2), height: round(node.offsetY() * 2), rotation: node.rotation(),
        ...(text ? { lines: text.textArr.map(line => line.text), fontSize: round(text.fontSize()) } : {}) };
    });
  });
  expect(studio.map(element => element.id)).toEqual([ribbon.id, hero.id, heading.id]);
  await page.screenshot({ path: testInfo.outputPath('1-template-studio.png') });

  await page.getByRole('button', { name: 'Open in editor' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('canvas-dimensions')).toHaveText(/1080 × 1350/);

  /** The same elements as the existing editor draws them, in its drawing order, and as it stored them. */
  const editor = async () => {
    await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
    return page.evaluate(() => {
      const stage = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0];
      const round = (value: number) => Math.round(value * 1e6) / 1e6;
      const drawn = stage.find((node: Group) => node.hasName('editable-text') || node.hasName('design-layer')).map((node) => {
        const text = node.getClassName() === 'Text' ? node as unknown as Text : undefined, picture = (node as Group).findOne?.<KonvaImage>('.layer-image');
        return { id: node.id(), x: round(node.x()), y: round(node.y()), rotation: node.rotation(),
          ...(text ? { rawText: text.text(), lines: text.textArr.map(line => line.text), fontSize: round(text.fontSize()), width: round(text.width()) } : {}),
          ...(picture ? { width: round(picture.width()), height: round(picture.height()) } : {}) };
      });
      const document = JSON.parse(localStorage.getItem('frameflow:project:v1')!) as { variants: { id: string; canvas: { width: number; height: number }; elements: Record<string, unknown>[]; layers: Record<string, unknown>[]; template?: { templateId: string } }[] };
      return { drawn, stored: document.variants.find(variant => variant.template)! };
    });
  };
  await expect.poll(async () => (await editor()).drawn.filter(node => 'height' in node).length).toBe(1);
  const opened = await editor();
  await page.screenshot({ path: testInfo.outputPath('2-editor.png') });

  // 1. The same z-order: the rotated text below the hero picture, the heading above it. Text is not forced on top.
  expect(opened.drawn.map(node => node.id)).toEqual([ribbon.id, hero.id, heading.id]);
  expect([...opened.stored.elements, ...opened.stored.layers].map(element => [element.id, element.zIndex]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([[ribbon.id, 1], [hero.id, 2], [heading.id, 3]]);
  // 2. The same rotation, drawn and stored.
  expect(opened.drawn[0].rotation).toBe(15);
  expect(opened.stored.elements.find(element => element.id === ribbon.id)!.rotation).toBe(15);
  // 3. The same raw text and the same overflow rules: two lines, shrunk to the smallest size, the second ending with an ellipsis,
  //    while what is stored is the whole text at the design size.
  const drawnHeading = opened.drawn[2], storedHeading = opened.stored.elements.find(element => element.id === heading.id)!;
  expect(drawnHeading.rawText).toBe(LONG);
  expect(storedHeading).toMatchObject({ text: LONG, maxLines: 2, overflow: 'shrink', height: 135, width: 648 });
  expect(storedHeading.fontSize).toBeCloseTo(81, 6);
  expect(storedHeading.minFontSize).toBeCloseTo(41.04, 6);
  expect(JSON.stringify(opened.stored)).not.toContain('…');
  expect(drawnHeading.lines).toHaveLength(2);
  expect(drawnHeading.lines![1].endsWith('…')).toBe(true);
  // Drawn exactly as Template Studio drew it: the same lines at the same font size.
  const studioHeading = studio[2];
  expect(drawnHeading.lines).toEqual(studioHeading.lines);
  expect(drawnHeading.fontSize).toBe(studioHeading.fontSize);
  // 4. The same geometry, no movement: every element's corner, size and rotation match what the studio drew...
  for (const [index, node] of opened.drawn.entries()) expect([node.id, node.x, node.y, node.rotation]).toEqual([studio[index].id, studio[index].x, studio[index].y, studio[index].rotation]);
  expect([opened.drawn[1].width, opened.drawn[1].height]).toEqual([studio[1].width, studio[1].height]);
  // ...and the stored pixels are the template's normalized layout on this 1080 × 1350 canvas.
  expect(storedHeading).toMatchObject({ x: heading.layout.x * 1080, y: heading.layout.y * 1350, width: heading.layout.width * 1080, height: heading.layout.height * 1350 });
  expect(opened.stored.layers[0]).toMatchObject({ x: hero.layout.x * 1080, y: hero.layout.y * 1350, width: hero.layout.width * 1080, height: hero.layout.height * 1350, fit: 'cover' });
  expect(opened.stored.elements.find(element => element.id === ribbon.id)).toMatchObject({ width: ribbon.layout.width * 1080, height: ribbon.layout.height * 1350 });
  expect([heading.layout, ribbon.layout.rotation]).toEqual([{ x: 0.05, y: 0.2, width: 0.6, height: 0.1, rotation: 0 }, 15]);
  // The editor explains the fixed box next to the text, and the text box shows the whole text.
  await page.getByRole('tab', { name: 'Text' }).click();
  await page.getByRole('list', { name: 'Text elements' }).getByRole('button').filter({ hasText: 'MEGA FESTIVE' }).click();
  await expect(page.getByLabel('Text content')).toHaveValue(LONG);
  await expect(page.getByTestId('text-box-rules')).toContainText('up to 2 lines');

  // Save and reopen once more: a reload brings back the same design, drawn and stored the same.
  await page.reload();
  await expect(page.getByTestId('canvas-dimensions')).toHaveText(/1080 × 1350/);
  await expect.poll(async () => (await editor()).drawn.filter(node => 'height' in node).length).toBe(1);
  const reopened = await editor();
  expect(reopened.stored).toEqual(opened.stored);
  expect(reopened.drawn).toEqual(opened.drawn);
  await page.screenshot({ path: testInfo.outputPath('3-editor-after-reload.png') });

  // The template and the creative in the studio are what they were: the editor design is a separate instance.
  const after = (await library(page))!;
  expect(after.templates[0]).toEqual(template);
  expect(after.creatives[0].contentOverrides).toEqual({ [heading.id]: { text: LONG } });
  expect(apiRequests).toEqual([]);
});
