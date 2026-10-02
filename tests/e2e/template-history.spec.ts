import { expect, test, type Page } from '@playwright/test';
import type { Stage } from 'konva/lib/Stage';
import type { Group } from 'konva/lib/Group';
import type { Text } from 'konva/lib/shapes/Text';
import type { Image as KonvaImage } from 'konva/lib/shapes/Image';
import { DIWALI_TEMPLATES } from '../../shared/src/designTemplates/offerTemplates.js';

const layer = (page: Page, name: string) => page.locator('.tpl-layers button').filter({ has: page.getByText(name, { exact: true }) }).first();
const history = (page: Page) => page.getByRole('group', { name: 'Template history', exact: true });
const undo = (page: Page) => history(page).getByRole('button', { name: /Undo/ });
const redo = (page: Page) => history(page).getByRole('button', { name: /Redo/ });
const ready = async (page: Page) => { await expect(page.locator('.tpl-main')).not.toHaveAttribute('data-fonts-state', 'loading'); };
const layoutField = (page: Page, name: string) => page.locator('.tpl-panel label.tpl-field').filter({ has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) }).getByRole('spinbutton');
const library = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:design-templates:v1')!));
async function setup(page: Page) {
  const calls: string[] = [];
  await page.route('**/api/**', route => { calls.push(route.request().url()); return route.abort(); });
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.goto('/'); await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.locator('.decomp-launch', { hasText: 'Create Own Template' }).click();
  await expect(undo(page)).toBeDisabled(); await expect(redo(page)).toBeDisabled(); return calls;
}
// Read rendered Konva state for assertions only. All mutations use real controls or pointer gestures.
const canvas = (page: Page) => page.evaluate(() => {
  const frame = document.querySelector('[data-testid="template-canvas"]')!;
  const stage = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages.find(s => frame.contains(s.container()))!;
  return stage.find<Group>('.template-element').map(n => ({
    id: n.id(), x: n.x(), y: n.y(), w: n.offsetX() * 2, h: n.offsetY() * 2, rotation: n.rotation(),
    texts: n.find<Text>('.template-text').map(t => ({ text: t.text(), font: t.fontFamily(), size: t.fontSize(), color: t.fill() })),
    images: n.find<KonvaImage>('.template-image').map(i => ({ src: (i.image() as HTMLImageElement).src, width: i.width(), height: i.height() })),
  }));
});
async function upload(page: Page, color: string) {
  const data = await page.evaluate(color => { const c = document.createElement('canvas'); c.width = 60; c.height = 100; const x = c.getContext('2d')!; x.fillStyle = color; x.fillRect(0, 0, 60, 100); return c.toDataURL().split(',')[1]; }, color);
  await page.locator('.tpl-panel input[type=file]').setInputFiles({ name: 'product.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
  await expect(page.locator('.tpl-panel').getByRole('button', { name: 'Replace image', exact: true })).toBeVisible();
}
async function drag(page: Page, id: string, destination?: { x: number; y: number }) {
  await page.getByTestId('template-canvas').click({ trial: true });
  const point = await page.evaluate(id => {
    const frame = document.querySelector('[data-testid="template-canvas"]')!;
    const stage = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages.find(s => frame.contains(s.container()))!;
    const node = stage.findOne(`#${id}`)!; const at = node.getAbsolutePosition(), box = stage.container().getBoundingClientRect();
    return { x: box.x + at.x, y: box.y + at.y };
  }, id);
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(destination?.x ?? point.x + 24, destination?.y ?? point.y + 20, { steps: 20 }); await page.mouse.up();
}
async function check(page: Page, state: Awaited<ReturnType<typeof canvas>>) {
  await ready(page); await expect.poll(() => canvas(page)).toEqual(state);
}

test('campaign edits undo and redo one meaningful action at a time, including both image slots', async ({ page }, info) => {
  test.setTimeout(90000); const calls = await setup(page), states = [await canvas(page)];
  await page.getByRole('button', { name: 'Use Diwali Mega Sale template', exact: true }).click(); await ready(page); states.push(await canvas(page));
  await drag(page, 'offer-headline'); states.push(await canvas(page)); expect(states[2]).not.toEqual(states[1]);
  await layer(page, 'Offer').click(); const text = page.getByRole('textbox', { name: 'Text', exact: true });
  await text.fill(''); await text.pressSequentially('Diwali 40%'); await text.blur(); states.push(await canvas(page));
  await page.getByRole('button', { name: 'Choose font', exact: true }).click(); await page.getByRole('searchbox', { name: 'Search fonts' }).fill('Yatra One');
  await page.getByRole('listitem', { name: 'Use font Yatra One', exact: true }).click(); await ready(page); states.push(await canvas(page));
  for (const name of ['YOUR PRODUCT', 'YOUR LOGO']) {
    await layer(page, name).click();
    for (const color of ['#FF0000', '#0000FF']) {
      const before = await canvas(page); await upload(page, color);
      const id = name === 'YOUR PRODUCT' ? 'offer-product' : 'offer-logo';
      await expect.poll(async () => (await canvas(page)).find(n => n.id === id)?.images.length).toBe(1);
      await expect.poll(async () => JSON.stringify(await canvas(page))).not.toBe(JSON.stringify(before)); states.push(await canvas(page));
    }
  }
  for (let i = states.length - 2; i >= 0; i--) { await undo(page).click(); await check(page, states[i]); }
  await expect(undo(page)).toBeDisabled(); await expect(redo(page)).toBeEnabled();
  for (const state of states.slice(1)) { await redo(page).click(); await check(page, state); }
  await expect(redo(page)).toBeDisabled();
  await page.screenshot({ path: info.outputPath('history-toolbar-and-restored-campaign.png') });
  expect(calls).toEqual([]);
});

test('resize and rotate pointer gestures each commit once; duplicate/delete clear stale selection', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: '+ Rectangle', exact: true }).click();
  const states = [await canvas(page)];
  // Native disabled buttons can swallow mouseup. Releasing over unavailable Redo must still commit the drag.
  const unavailableRedo = (await redo(page).boundingBox())!;
  await drag(page, states[0][0].id, { x: unavailableRedo.x + unavailableRedo.width / 2, y: unavailableRedo.y + unavailableRedo.height / 2 });
  await expect(page.getByTestId('layout-debug')).toContainText('y: 0.00%');
  await undo(page).click(); await check(page, states[0]);
  for (const handle of ['.bottom-right', '.rotater']) {
    const point = await page.evaluate(handle => {
      const frame = document.querySelector('[data-testid="template-canvas"]')!;
      const stage = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages.find(s => frame.contains(s.container()))!;
      const at = stage.findOne(handle)!.getAbsolutePosition(), box = stage.container().getBoundingClientRect();
      return { x: at.x + box.x, y: at.y + box.y };
    }, handle);
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.mouse.move(point.x + 35, point.y + 12, { steps: 16 }); await page.mouse.up();
    const after = await canvas(page); expect(after).not.toEqual(states.at(-1)); states.push(after);
  }
  await undo(page).click(); await check(page, states[1]); await undo(page).click(); await check(page, states[0]);
  await redo(page).click(); await check(page, states[1]); await redo(page).click(); await check(page, states[2]);
  await page.getByRole('button', { name: 'Duplicate element', exact: true }).click(); await expect(page.locator('.tpl-layers li')).toHaveCount(2);
  await undo(page).click(); await expect(page.locator('.tpl-layers li')).toHaveCount(1); await expect(page.getByRole('button', { name: 'Remove element', exact: true })).toHaveCount(0);
  await redo(page).click(); await layer(page, 'Rectangle copy').click(); const duplicated = await canvas(page);
  await page.getByRole('button', { name: 'Remove element', exact: true }).click(); await undo(page).click(); await check(page, duplicated);
  await redo(page).click(); await expect(page.locator('.tpl-layers li')).toHaveCount(1);
});

test('ratio browsing adds no history; geometry, ordering, color and theme styling restore exactly', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: 'Use Diwali Mega Sale template', exact: true }).click(); await ready(page);
  const square = await canvas(page), ratio = page.getByRole('group', { name: 'Aspect preview' });
  for (const name of ['4:5', '3:4', '9:16', '16:9']) await ratio.getByRole('button', { name, exact: true }).click();
  const wide = await canvas(page); await layer(page, 'YOUR PRODUCT').click();
  await layoutField(page, 'X').fill('55'); await layoutField(page, 'X').blur(); expect(await canvas(page)).not.toEqual(wide);
  await undo(page).click(); await check(page, wide); await expect(ratio.getByRole('button', { name: '16:9', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await ratio.getByRole('button', { name: '1:1', exact: true }).click(); await check(page, square);
  await layer(page, 'Headline').click(); await page.getByRole('textbox', { name: 'Colour hex', exact: true }).fill('#FFFFFF'); await page.getByRole('textbox', { name: 'Colour hex', exact: true }).blur();
  await expect(redo(page)).toBeDisabled(); await undo(page).click(); await check(page, square);
  await page.getByRole('button', { name: 'To back', exact: true }).click(); expect(await canvas(page)).not.toEqual(square); await undo(page).click(); await check(page, square);
  await page.getByRole('button', { name: 'Apply Holi theme', exact: true }).click(); await page.getByRole('button', { name: 'Apply styling only', exact: true }).click(); await ready(page);
  await undo(page).click(); await check(page, square); await undo(page).click(); await expect(page.locator('.tpl-layers li')).toHaveCount(0); await expect(undo(page)).toBeDisabled();
});

test('releasing over either disabled history button persists exactly one reversible drag', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '+ Rectangle', exact: true }).click();
  await page.getByRole('button', { name: 'Save Template', exact: true }).click();
  for (const button of [undo(page), redo(page)]) {
    await page.getByRole('button', { name: 'Edit Template', exact: true }).click();
    await expect(undo(page)).toBeDisabled(); await expect(redo(page)).toBeDisabled();
    const before = await canvas(page), destination = (await button.boundingBox())!;
    await drag(page, before[0].id, { x: destination.x + destination.width / 2, y: destination.y + destination.height / 2 });
    await expect(page.getByTestId('layout-debug')).toContainText('y: 0.00%');
    const after = await canvas(page); expect(after).not.toEqual(before);
    await page.getByRole('button', { name: /^Save Template/ }).click();
    expect((await library(page)).templates.at(-1).elements[0].layout.y).toBe(0);
    await undo(page).click(); await check(page, before); await expect(undo(page)).toBeDisabled();
    await redo(page).click(); await check(page, after); await expect(redo(page)).toBeDisabled();
    // Save the original geometry so the next empty-history session can perform the same real drag.
    await undo(page).click(); await page.getByRole('button', { name: /^Save Template/ }).click();
  }
});

test('AI draft has no history; Apply is atomic and undo/redo never call the provider', async ({ page }) => {
  const calls = await setup(page); let requests = 0;
  await page.route('**/api/themes/plan', route => { requests++; return route.fulfill({ json: { spec: DIWALI_TEMPLATES[1].spec } }); });
  await page.getByRole('button', { name: '+ Heading', exact: true }).click(); await ready(page);
  const before = await canvas(page); await page.locator('.ai-theme-panel summary').click();
  await page.getByRole('textbox', { name: 'Describe your Diwali creative' }).fill('Premium Diwali');
  await page.getByRole('button', { name: 'Generate Editable Theme', exact: true }).click(); await expect(page.getByRole('group', { name: 'AI theme draft' })).toBeVisible();
  await check(page, before); await undo(page).click(); await expect(undo(page)).toBeDisabled(); await redo(page).click(); await check(page, before);
  await page.getByRole('button', { name: 'Apply generated theme', exact: true }).click(); await ready(page); const after = await canvas(page);
  await undo(page).click(); await check(page, before); await redo(page).click(); await check(page, after);
  expect(requests).toBe(1); expect(calls).toEqual([]);
});

test('shortcuts respect text focus and IME; new edits clear redo', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: '+ Heading', exact: true }).click(); await ready(page);
  const text = page.locator('.tpl-element-properties textarea'); await text.fill(''); await text.pressSequentially('Diwali Mega Sale');
  await text.press('ControlOrMeta+z'); await expect(page.locator('.tpl-layers li')).toHaveCount(1); await expect(redo(page)).toBeDisabled();
  // These synthetic DOM events exercise focus ownership; native typing undo is left to Chromium.
  await text.evaluate(el => { const node = document.createElement('span'); node.contentEditable = 'true'; node.textContent = 'Editable note'; el.parentElement!.append(node); node.focus(); });
  await page.locator('[contenteditable=true]').dispatchEvent('keydown', { key: 'z', ctrlKey: true }); await expect(page.locator('.tpl-layers li')).toHaveCount(1);
  const stage = page.getByLabel('Template canvas', { exact: true }); await stage.focus();
  await stage.dispatchEvent('keydown', { key: 'z', ctrlKey: true, isComposing: true }); await expect(redo(page)).toBeDisabled();
  await page.keyboard.press('ControlOrMeta+z'); await expect(text).toHaveValue('Heading');
  await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(text).not.toHaveValue('Heading');
  await page.keyboard.press('Control+z'); await expect(text).toHaveValue('Heading'); await page.keyboard.press('Control+y'); await expect(text).not.toHaveValue('Heading');
  // Exercise macOS key modifiers as well, independent of the host OS.
  await page.keyboard.press('Meta+z'); await expect(text).toHaveValue('Heading'); await page.keyboard.press('Meta+Shift+z'); await expect(text).not.toHaveValue('Heading');
  await undo(page).click(); await page.getByRole('button', { name: '+ Circle', exact: true }).click(); await expect(redo(page)).toBeDisabled();
});

test('saved template sessions, reload and derived creatives have isolated histories', async ({ page }) => {
  await setup(page); page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Use Diwali Mega Sale template', exact: true }).click(); await ready(page);
  await page.getByRole('button', { name: 'Save Template', exact: true }).click(); const saved = (await library(page)).templates[0];
  // Save does not erase undo, but reopening an editing session does.
  await expect(undo(page)).toBeEnabled(); await page.getByRole('button', { name: 'Edit Template', exact: true }).click(); await expect(undo(page)).toBeDisabled();
  await page.locator('.tpl-sidebar').getByRole('button', { name: 'Create Own Template', exact: true }).click(); await page.getByRole('button', { name: '+ Heading', exact: true }).click();
  await page.getByRole('button', { name: 'Save Template', exact: true }).click();
  const first = page.locator('.tpl-card').filter({ has: page.getByText('Diwali Mega Sale', { exact: true }) });
  await first.getByRole('button', { name: 'Edit Template', exact: true }).click(); await expect(undo(page)).toBeDisabled(); await expect(redo(page)).toBeDisabled();
  await first.getByRole('button', { name: 'Use Template', exact: true }).click(); await expect(undo(page)).toBeDisabled();
  const headline = page.locator('fieldset').filter({ has: page.locator('legend', { hasText: /^Headline/ }) }).locator('textarea'); const original = await headline.inputValue();
  await headline.fill('A derived campaign'); await headline.blur();
  await page.getByRole('group', { name: 'Aspect ratio', exact: true }).getByRole('button', { name: '16:9', exact: true }).click();
  await undo(page).click(); await expect(headline).toHaveValue(original); await expect(undo(page)).toBeDisabled();
  await expect(page.getByRole('group', { name: 'Aspect ratio', exact: true }).getByRole('button', { name: '16:9', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await redo(page).click(); await expect(headline).toHaveValue('A derived campaign'); await page.getByRole('button', { name: 'Save Creative', exact: true }).click();
  expect((await library(page)).templates.find((t: { id: string }) => t.id === saved.id)).toEqual(saved);
  await page.reload(); await page.locator('.decomp-launch', { hasText: 'Create Own Template' }).click(); await expect(undo(page)).toBeDisabled();
  await page.locator('.tpl-creatives button').filter({ hasText: 'Diwali Mega Sale creative' }).click(); await expect(undo(page)).toBeDisabled(); await expect(redo(page)).toBeDisabled(); await expect(headline).toHaveValue('A derived campaign');
});
