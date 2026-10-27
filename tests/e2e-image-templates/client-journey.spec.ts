import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ProjectDocument } from '@frameflow/shared';

// A first-time SPOC user on a COPY of the real Ganesh Ji template (FRAMEFLOW_SAVED_VARIATION_FIXTURE=<copy root with
// protected/>): Create Offer Creative → choose the template → upload a refrigerator and a coffee machine → Generate Creative
// (the AI cost dialog; offline stand-in planner) → review (full screen, compare) → save → reopen → Decompose into Layers
// (its own cost dialog; offline stand-in decomposition) → Open Visual Editor → move, resize, edit text → save → reopen →
// export, the badge checked against the original; then Continue Editing without a new request. Screenshots at desktop,
// tablet and phone widths. No request leaves this computer.
const OUT = 'test-results/client-journey', fixture = process.env.FRAMEFLOW_SAVED_VARIATION_FIXTURE, id = process.env.FRAMEFLOW_CLIENT_TEMPLATE ?? 'pt-c533f7a238e7';
const TEMPLATE = /^Template Ganesh ji$/;
test.use({ actionTimeout: 30000 });
test.setTimeout(600000);
const photo = (file: string, name: string) => ({ name, mimeType: 'image/png', buffer: readFileSync(join(fixture!, 'protected', id, file)) });
const TWO = () => [photo('pru-c44f9207-b315dd33506a.png', 'Refrigerator.png'), photo('pru-c44f9207-40ba4b1d40b9.png', 'Coffee machine.png')];
const PHOTOS = () => [photo('pru-c44f9207-b315dd33506a.png', 'Refrigerator.png'), photo('pvarproduct-cc404718-2-562a0cd2b8f7.png', 'Washing machine.png'), photo('pru-c44f9207-40ba4b1d40b9.png', 'Coffee machine.png')];
/** Nothing scrolls sideways: the page, nor the dialog's scrolling body. */
async function noSideScroll(page: Page) {
  await expect.poll(() => page.evaluate(() => [document.documentElement, ...document.querySelectorAll('.ws-body')].every(e => e.scrollWidth <= e.clientWidth + 1))).toBe(true);
}
const loaded = (img: Locator) => expect.poll(() => img.evaluate(i => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
async function openTemplate(page: Page) {
  await page.getByRole('button', { name: 'Create Offer Creative' }).click();
  const app = page.getByRole('dialog', { name: 'Create Offer Creative' });
  await expect(app.getByRole('heading', { name: 'Choose a template' })).toBeVisible();
  return app;
}

test('A SPOC user makes a Ganesh Ji offer creative: template → upload → generate → review → save → reopen → edit in the editor (offline providers)', async ({ page }) => {
  test.skip(!fixture, 'Needs a template copy (FRAMEFLOW_SAVED_VARIATION_FIXTURE).');
  mkdirSync(OUT, { recursive: true });
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => r.abort());
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create Offer Creative' })).toBeVisible();
  await page.screenshot({ path: `${OUT}/00-home.png` });
  // 1–3. Choose the template.
  let app = await openTemplate(page);
  const card = app.getByRole('article', { name: TEMPLATE });
  await loaded(card.locator('img'));
  await page.screenshot({ path: `${OUT}/01-templates.png` });
  await card.getByRole('button', { name: 'Use This Template' }).click();
  await expect(app.getByRole('heading', { name: 'Create Your Offer Creative' })).toBeVisible();
  // (The copy has earlier creatives of this template: a new user starts a new one.)
  const start = app.getByRole('button', { name: 'Start over' });
  if (await start.isVisible().catch(() => false)) await start.click();
  await expect(app.getByText('Upload your product photos. AI will arrange them beautifully in your selected template.')).toBeVisible();
  await expect(app.getByText('Drag your product photos here')).toBeVisible();
  await noSideScroll(page);
  // 4–5. Two photos at once: two cards, each included.
  await app.getByLabel('Upload product photos').setInputFiles(TWO());
  const list = app.getByRole('list', { name: 'Your products' });
  await expect(list.getByRole('listitem', { name: /^Product / })).toHaveCount(2, { timeout: 60000 });
  for (const c of await list.getByRole('checkbox').all()) await expect(c).toBeChecked();
  await expect(app.getByText('2 of 2 selected')).toBeVisible();
  await expect(app.getByText('All changes saved')).toBeVisible();
  for (const img of await list.locator('.sr-product-img img').all()) await loaded(img);
  await page.screenshot({ path: `${OUT}/02-upload.png` });
  // 6. Generate Creative: the AI cost first (the offline planner stands in for OpenAI).
  await app.getByRole('button', { name: 'Generate Creative' }).click();
  const cost = app.getByRole('dialog', { name: 'Arrange Products with AI' });
  await expect(cost).toContainText('Estimated cost'); await expect(cost).toContainText('$0.08');
  await expect(cost.getByRole('button', { name: 'Arrange Automatically (Free)' })).toBeVisible();
  await page.screenshot({ path: `${OUT}/03-cost.png` });
  await cost.getByRole('button', { name: 'Approve & Generate' }).click();
  // 7. The poster, large.
  await expect(app.getByRole('heading', { name: 'Your creative is ready!' })).toBeVisible({ timeout: 120000 });
  const poster = app.getByRole('img', { name: 'Your finished creative' });
  await loaded(poster);
  await noSideScroll(page);
  await page.screenshot({ path: `${OUT}/04-result.png` });
  await app.getByRole('button', { name: 'Compare with template' }).click();
  await loaded(app.getByRole('img', { name: 'The original template' }));
  await page.screenshot({ path: `${OUT}/04b-compare.png` });
  await app.getByRole('button', { name: 'Hide template' }).click();
  await app.getByRole('button', { name: 'Full screen' }).click();
  const full = page.getByRole('dialog', { name: 'Full-screen preview' });
  await loaded(full.getByRole('img'));
  await page.screenshot({ path: `${OUT}/05-fullscreen.png` });
  await page.keyboard.press('Escape');
  await expect(full).toBeHidden();
  // Customize Manually (optional): the poster to drag on, products, text and logos; back with Done.
  await app.getByRole('button', { name: 'Customize Manually' }).click();
  await expect(app.getByRole('heading', { name: 'Customize Manually' })).toBeVisible();
  await expect(app.getByRole('group', { name: /Advanced settings/ }).or(app.getByText('Advanced settings (sizes, arrangement)'))).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/04c-customize.png` });
  await app.getByRole('button', { name: 'Done — show my creative' }).click();
  await expect(app.getByRole('heading', { name: 'Your creative is ready!' })).toBeVisible();
  // 8. Save.
  await app.getByRole('button', { name: 'Save Creative' }).click();
  await expect(app.getByRole('button', { name: 'Saved' })).toBeVisible();
  await expect(app.getByText('It’s saved to your creatives — you can use it as it is.')).toBeVisible();
  // Saved: Edit Your Creative appears, with one action.
  const edit = app.getByRole('region', { name: 'Edit Your Creative' });
  await expect(edit.getByRole('button', { name: 'Decompose into Layers' })).toBeVisible();
  await page.screenshot({ path: `${OUT}/05b-saved.png` });
  // 9. Reopen: closed and opened again, the saved creative is where it was.
  await app.getByRole('button', { name: 'Close' }).click();
  app = await openTemplate(page);
  await app.getByRole('article', { name: TEMPLATE }).getByRole('button', { name: 'Use This Template' }).click();
  await expect(app.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 60000 });
  await loaded(app.getByRole('img', { name: 'Your finished creative' }));
  // Tablet and phone widths of the review.
  for (const [w, h] of [[1024, 768], [768, 1024], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await noSideScroll(page);
    await page.screenshot({ path: `${OUT}/08-result-${w}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // 10–11. Decompose into Layers: the free checks, then its own cost (offline stand-in), progress, success, the editor.
  const calls = async () => ((await (await page.request.get('/__test__/product-calls')).json()).submissions as unknown[]).length;
  const before = await calls();
  await app.getByRole('region', { name: 'Edit Your Creative' }).getByRole('button', { name: 'Decompose into Layers' }).click();
  const layersDialog = page.getByRole('dialog', { name: 'Make Your Creative Editable' });
  await expect(layersDialog).toBeVisible();
  await expect(layersDialog.getByText('Estimated cost')).toBeVisible();
  await expect(layersDialog.getByRole('button', { name: /^Make Editable/ })).toBeEnabled({ timeout: 120000 });
  await expect(layersDialog).toContainText(/about \$\d+\.\d\d/);
  expect(await calls()).toBe(before);
  await page.screenshot({ path: `${OUT}/06-decompose-dialog.png` });
  // (The editing document is made while "Preparing editable layers" runs.)
  const opened = page.waitForResponse(r => /\/open-editor$/.test(r.url()) && r.request().method() === 'POST', { timeout: 180000 });
  await layersDialog.getByRole('button', { name: /^Make Editable/ }).click();
  const working = page.getByRole('dialog', { name: 'Making your creative editable' });
  await expect(working).toBeVisible();
  await page.screenshot({ path: `${OUT}/06b-decompose-progress.png` });
  const ready = page.getByRole('dialog', { name: 'Your Creative Is Ready to Edit!' });
  await expect(ready).toBeVisible({ timeout: 180000 });
  expect(await calls()).toBe(before + 1);
  await page.screenshot({ path: `${OUT}/06c-decompose-ready.png` });
  const { runId } = await (await opened).json();
  await ready.getByRole('button', { name: 'Open Visual Editor' }).click();
  await expect(app).toBeHidden({ timeout: 60000 });
  // 12–14. Move and resize the refrigerator, edit a word, save, reopen, export.
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!) as ProjectDocument);
  await expect.poll(async () => (await stored()).variants.some(v => v.importedFrom?.runId === runId)).toBe(true);
  const design = (await stored()).variants.find(v => v.importedFrom?.runId === runId)!;
  // Separate product layers (the uploaded photos, complete), each movable.
  expect(design.layers!.map(l => l.name.toLowerCase())).toEqual(expect.arrayContaining(['refrigerator', 'coffee machine']));
  const fridge = design.layers!.find(l => l.name.toLowerCase() === 'refrigerator')!, movedX = Math.round(fridge.x + 60), widened = Math.round(fridge.width) + 30;
  await page.locator('.layer-select', { hasText: fridge.name }).first().click();
  await page.getByLabel('X', { exact: true }).fill(String(movedX)); await page.getByLabel('X', { exact: true }).blur();
  await page.getByLabel('Width', { exact: true }).fill(String(widened)); await page.getByLabel('Width', { exact: true }).blur();
  const layer = async () => (await stored()).variants.find(v => v.id === design.id)!.layers!.find(l => l.id === fridge.id)!;
  await expect.poll(async () => (await layer()).x).toBe(movedX);
  await expect.poll(async () => Math.round((await layer()).width)).toBe(widened);
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.locator('.text-elements summary').filter({ hasText: 'grand' }).first().click();
  await page.getByRole('button', { name: 'Select word grand', exact: true }).first().click();
  await page.getByLabel('Text content', { exact: true }).fill('golden'); await page.getByLabel('Text content', { exact: true }).blur();
  await expect.poll(async () => (await stored()).variants.find(v => v.id === design.id)!.elements.some(e => e.text === 'golden')).toBe(true);
  await page.getByRole('tab', { name: 'Design', exact: true }).click();
  await page.screenshot({ path: `${OUT}/07-editor.png` });
  await page.getByRole('button', { name: 'Save creative', exact: true }).click();
  await expect(page.getByText(/Saved to creative · revision \d+/)).toBeVisible();
  await page.reload();
  expect((await layer()).x).toBe(movedX);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  await (await download).saveAs(`${OUT}/09-export.png`);
  const exported = await sharp(`${OUT}/09-export.png`).metadata();
  expect(exported.width).toBe(4096);
  // The badge in the export is the original's artwork (its lettering, ribbon and borders; the strip at its left edge,
  // where the old stand was taken off the stage, left out of the comparison).
  const box = { left: 3300, top: 2113, width: 617, height: 711 };
  const [a, b] = await Promise.all([sharp(join(fixture!, 'protected', id, 'source.jpg')).extract(box).removeAlpha().raw().toBuffer(), sharp(`${OUT}/09-export.png`).extract(box).removeAlpha().raw().toBuffer()]);
  let off = 0; for (let k = 0; k < a.length; k += 3) if (Math.max(Math.abs(a[k] - b[k]), Math.abs(a[k + 1] - b[k + 1]), Math.abs(a[k + 2] - b[k + 2])) > 24) off++;
  expect(off).toBeLessThan(box.width * box.height * 0.002);
  // Already separated: Continue Editing reopens it, with no new decomposition request.
  const made = await calls();
  app = await openTemplate(page);
  await app.getByRole('article', { name: TEMPLATE }).getByRole('button', { name: 'Use This Template' }).click();
  const again = app.getByRole('region', { name: 'Edit Your Creative' }).getByRole('button', { name: 'Continue Editing' });
  await expect(again).toBeVisible({ timeout: 60000 });
  await expect(app.getByText('Your creative is already separated into layers — no new cost.')).toBeVisible();
  await page.screenshot({ path: `${OUT}/10-continue-editing.png` });
  const reopened = page.waitForResponse(r => /\/open-editor$/.test(r.url()) && r.request().method() === 'POST');
  await again.click();
  const { runId: runAgain } = await (await reopened).json();
  await expect(app).toBeHidden({ timeout: 60000 });
  // The design it opens keeps the saved edits (the moved refrigerator).
  await expect.poll(async () => (await stored()).variants.some(v => v.importedFrom?.runId === runAgain)).toBe(true);
  const continued = (await stored()).variants.find(v => v.importedFrom?.runId === runAgain)!;
  expect(Math.round(continued.layers!.find(l => l.name.toLowerCase() === 'refrigerator')!.x)).toBe(movedX);
  expect(await calls()).toBe(made);
});

test('The same journey on a phone (390 px): choose, upload, cost dialog, review — large tap targets, nothing sideways', async ({ page }) => {
  test.skip(!fixture, 'Needs a template copy (FRAMEFLOW_SAVED_VARIATION_FIXTURE).');
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => r.abort());
  await page.goto('/');
  // Only the client's launcher shows on a phone.
  await expect(page.getByRole('button', { name: 'Create Offer Creative' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'OpenAI + Seedream test' })).toBeHidden();
  const app = await openTemplate(page);
  await loaded(app.getByRole('article', { name: TEMPLATE }).locator('img'));
  await noSideScroll(page);
  await page.screenshot({ path: `${OUT}/m01-templates.png` });
  await app.getByRole('article', { name: TEMPLATE }).getByRole('button', { name: 'Use This Template' }).click();
  await expect(app.getByRole('heading', { name: 'Create Your Offer Creative' })).toBeVisible();
  const start = app.getByRole('button', { name: 'Start over' });
  if (await start.isVisible().catch(() => false)) await start.click();
  await app.getByLabel('Upload product photos').setInputFiles(PHOTOS());
  await expect(app.getByRole('list', { name: 'Your products' }).getByRole('listitem', { name: /^Product / })).toHaveCount(3, { timeout: 60000 });
  await noSideScroll(page);
  await page.screenshot({ path: `${OUT}/m02-upload.png` });
  const generate = app.getByRole('button', { name: 'Generate Creative' });
  expect((await generate.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await generate.click();
  const cost = app.getByRole('dialog', { name: 'Arrange Products with AI' });
  await expect(cost).toBeVisible();
  await page.screenshot({ path: `${OUT}/m03-cost.png` });
  await cost.getByRole('button', { name: 'Arrange Automatically (Free)' }).click();
  await expect(app.getByRole('heading', { name: 'Your creative is ready!' })).toBeVisible({ timeout: 120000 });
  await expect(app.getByText('Products arranged automatically')).toBeVisible();
  await loaded(app.getByRole('img', { name: 'Your finished creative' }));
  await noSideScroll(page);
  await page.screenshot({ path: `${OUT}/m04-result.png`, fullPage: true });
  expect((await app.getByRole('button', { name: 'Save Creative' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
});
