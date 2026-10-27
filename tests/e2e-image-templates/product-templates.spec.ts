import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { ProductCreative } from '@frameflow/shared';
import type { ProductView } from '../../client/src/features/productTemplates/api';

/**
 * Product with Text templates in the browser, against the offline fixture server (fake reading, vision answer and cut-out
 * service; no network): a sheet uploaded and one creative chosen, the review (needs-attention, approve, delete + undo),
 * preparing, the layer try-out and checks, saving; then reuse (a product replaced in its slot, the headline rewritten,
 * opened in the editor) and variations (generated, saved, regenerated, removed). Screens at 1440 px and 390 px.
 */
test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` }, actionTimeout: 30000 });
test.describe.configure({ timeout: 300000 });
const API = '/api/layerize-experiment/product-templates', SHOTS = process.env.PRODUCT_SHOTS_OUT ?? 'test-results/product-v1/screens';
async function open(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  return panel;
}
const calls = async (request: APIRequestContext) => (await request.get('/__test__/product-calls')).json() as Promise<{ analyzer: number; segmenter: number; recognizer: number }>;
async function savedTemplate(request: APIRequestContext, name: string) {
  const poster = await (await request.get('/__test__/product-poster.png')).body();
  let v = await (await request.post(API, { multipart: { name, useAi: 'true', image: { name: 'poster.png', mimeType: 'image/png', buffer: poster } } })).json() as ProductView;
  const id = v.template.id;
  await expect.poll(async () => { v = await (await request.get(`${API}/${id}`)).json(); return v.stage; }, { timeout: 60000 }).toBe('review');
  // Preparing needs every character and product looked at (accepted) first.
  v = await (await request.put(`${API}/${id}/review`, { data: { expectedRevision: v.template.revision, objects: v.product.objects.map(o => ({ id: o.id, kind: o.kind, label: o.label, box: o.box, accepted: true })), texts: [], logos: [], dismissMissingText: true } })).json();
  await request.post(`${API}/${id}/prepare`, { data: { expectedRevision: v.template.revision } });
  await expect.poll(async () => { v = await (await request.get(`${API}/${id}`)).json(); return v.stage; }, { timeout: 120000 }).toBe('prepared');
  v = await (await request.post(`${API}/${id}/approve`, { data: { expectedRevision: v.template.revision, acknowledge: v.product.prepared!.quality.issues.map(i => i.id) } })).json();
  v = await (await request.post(`${API}/${id}/publish`, { data: { expectedRevision: v.template.revision } })).json();
  expect(v.stage).toBe('ready');
  return v;
}

test('create: a creative chosen from a sheet, reviewed, prepared, checked and saved, all in the browser', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'One run of this long flow; the narrow screen is checked inside it.');
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => r.abort());
  const before = await calls(request), name = `Festive ${Date.now()}`;
  const panel = await open(page);
  await panel.getByRole('button', { name: 'New product template' }).click();
  await expect(panel.getByRole('heading', { name: 'Upload your creative' })).toBeVisible();
  const sheet = await (await request.get('/__test__/product-sheet.png')).body();
  await panel.getByLabel('Creative to upload').setInputFiles({ name: 'festive-sheet.png', mimeType: 'image/png', buffer: sheet });
  await expect(panel.getByText('This picture has 2 creatives')).toBeVisible();
  await panel.getByRole('radio', { name: /Creative 2/ }).click();
  await panel.getByLabel('Template name').fill(name);
  await panel.getByRole('checkbox', { name: /Find characters and products with AI/ }).check();
  await page.screenshot({ path: `${SHOTS}/01-upload-sheet.png` });
  await panel.getByRole('button', { name: 'Upload and find elements' }).click();

  // Review: what needs a look first; approve, retype, delete and undo.
  await expect(panel.getByRole('heading', { name: 'Here’s what we found' })).toBeVisible({ timeout: 60000 });
  const attention = panel.getByRole('region', { name: 'Needs a look' });
  await expect(attention.getByRole('button')).toHaveCount(4); // three items and "They all look right"
  await expect(attention).toContainText('Television');
  await expect(attention).toContainText('Get 26% cashback');
  await expect(attention).toContainText('Hurry');
  for (const g of ['Characters', 'Products', 'Text', 'Logos']) await expect(panel.getByRole('region', { name: g, exact: true })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Products', exact: true }).getByRole('button')).toHaveCount(3);
  await page.screenshot({ path: `${SHOTS}/02-review.png` });
  await attention.getByRole('button', { name: /Television/ }).click();
  const inspector = panel.getByRole('complementary', { name: 'Selected element' });
  await expect(inspector.getByRole('heading', { name: 'Television' })).toBeVisible();
  await inspector.getByRole('button', { name: 'Looks right' }).click();
  await expect(attention).not.toContainText('Television');
  await attention.getByRole('button', { name: /Get 26% cashback/ }).click();
  await inspector.getByLabel('Wording').fill('Get 26% cashback today');
  await expect(attention).not.toContainText('cashback');
  await page.screenshot({ path: `${SHOTS}/03-review-text.png` });
  // Delete the podium with the keyboard, then undo.
  await panel.getByRole('region', { name: 'Background & decorations' }).getByRole('button', { name: /Podium/ }).click();
  await page.keyboard.press('Delete');
  await expect(panel.getByRole('region', { name: 'Background & decorations' }).getByRole('button', { name: /Podium/ })).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(panel.getByRole('region', { name: 'Background & decorations' }).getByRole('button', { name: /Podium/ })).toHaveCount(1);
  // The narrow screen: everything reachable, nothing wider than the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByRole('button', { name: 'Save and choose what to decompose' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${SHOTS}/04-review-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await panel.getByRole('button', { name: 'Save and choose what to decompose' }).click();
  await expect(panel.getByRole('heading', { name: 'Choose what to decompose' })).toBeVisible();
  await panel.getByRole('button', { name: 'Continue to Decomposition' }).click();

  // Prepare: the comparison, the layer try-out and the checks.
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 120000 });
  await expect(panel.getByText(/of the picture looks the same as your original/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/05-prepared-layers.png` });
  await panel.getByRole('button', { name: 'Television', exact: true }).click();
  await panel.getByRole('button', { name: 'Text and logos' }).click();
  await page.screenshot({ path: `${SHOTS}/06-prepared-hidden.png` });
  await panel.getByRole('tab', { name: 'Reconstructed full creative' }).click();
  await page.screenshot({ path: `${SHOTS}/07-prepared-compare.png` });
  const save = panel.getByRole('button', { name: 'Save master template' });
  const checks = panel.getByRole('complementary', { name: 'Checks' }).getByRole('checkbox');
  if (await checks.count()) await expect(save).toBeDisabled();
  for (const c of await checks.all()) await c.check();
  await expect(panel.getByText(/cut-out service \(SAM-3 on fal\.ai\)/)).toBeVisible();
  await save.click();
  await expect(panel.getByRole('heading', { name: 'Your template is saved' })).toBeVisible({ timeout: 60000 });
  await page.screenshot({ path: `${SHOTS}/08-saved.png` });
  // One vision request (the person turned it on), no cut-out request: this template's own record (other tests share the server).
  const listed = (await (await request.get(API)).json()).templates as { id: string; name: string }[], mine = listed.find(t => t.name === name)!;
  const saved = await (await request.get(`${API}/${mine.id}`)).json() as ProductView;
  expect(saved.product.activity).toMatchObject({ aiCalls: 1, segmentRequests: 0, costUsd: 0 });
  expect(saved.product.sheet?.crop).toMatchObject({ x: 1140, y: 100, width: 1000, height: 1200 });
  expect((await calls(request)).analyzer).toBeGreaterThan(before.analyzer);
});

test('reuse: a product replaced in its slot, the headline rewritten, opened in the editor; variations made, saved, regenerated, removed, sent to decomposition', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'One run of this long flow; the narrow screen is checked inside it.');
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => r.abort());
  const name = `Reuse ${Date.now()}`, v = await savedTemplate(request, name), id = v.template.id;
  const panel = await open(page);
  await panel.getByRole('article', { name: `Product template ${name}` }).getByRole('button', { name: 'Use template' }).click();
  await panel.getByRole('button', { name: 'New creative' }).click();
  const change = panel.getByRole('complementary', { name: 'Change the creative' });
  await expect(change.getByRole('region', { name: 'Products and characters' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/09-creative.png` });
  // Replace the television with a packshot: its white backdrop removed, fitted to the slot.
  const packshot = await (await request.get('/__test__/product-packshot.png')).body();
  await change.getByLabel('Replace Television').setInputFiles({ name: 'speaker.png', mimeType: 'image/png', buffer: packshot });
  await expect(change.getByText('Its plain background was removed, and it was fitted to the slot.')).toBeVisible();
  // The headline rewritten (set to fit), saved as a new version.
  await change.getByLabel('Headline text').fill('Festive Savings');
  await change.getByRole('button', { name: 'Apply' }).click();
  await change.getByRole('button', { name: 'Save changes' }).click();
  await expect(change.getByText(/^Version 3\./)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/10-creative-edited.png` });
  const list = (await (await request.get(`${API}/${id}/creatives`)).json()).creatives as { id: string; revision: number }[];
  const creative = await (await request.get(`${API}/${id}/creatives/${list[0].id}`)).json() as ProductCreative;
  expect(creative.texts.map(t => t.text)).toEqual(expect.arrayContaining(['Festive', 'Savings']));
  expect(creative.objects.find(o => o.label === 'Television')!.asset.kind).toBe('upload');
  expect((await request.get(`${API}/${id}/creatives/${list[0].id}?revision=1`)).ok()).toBe(true);
  // 390 px: the reuse page fits.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${SHOTS}/11-creative-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Variations.
  await panel.getByRole('tab', { name: 'Generate with AI' }).click();
  await panel.getByRole('radio', { name: '3' }).click();
  await panel.getByRole('button', { name: 'Generate 3 variations' }).click();
  const grid = panel.getByRole('region', { name: 'Variations' });
  await expect(grid.getByRole('article')).toHaveCount(3, { timeout: 60000 });
  // No drafts: each card shows its checks and what it is (style, size); what it says is what was drawn.
  await expect(grid.getByText(/^(Automatic checks passed|Needs a look)$/).first()).toBeVisible();
  await expect(grid.getByText(/Original size · 1000 × 1200 px/).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/12-variations.png`, fullPage: true });
  const first = grid.getByRole('article').first();
  await first.getByRole('button', { name: 'Save' }).click();
  await expect(first.getByText('Saved')).toBeVisible();
  const second = grid.getByRole('article').nth(1), src = await second.getByRole('img').getAttribute('src');
  await second.getByRole('button', { name: 'Regenerate' }).click();
  await expect.poll(async () => grid.getByRole('article').nth(1).getByRole('img').getAttribute('src')).not.toBe(src);
  await grid.getByRole('article').nth(2).getByRole('button', { name: 'Remove' }).click();
  await expect(grid.getByRole('article')).toHaveCount(2);

  // Send to Decomposition → the run dashboard → Open in editor: each element its own layer, text editable.
  await grid.getByRole('article').first().getByRole('button', { name: 'Send to Decomposition' }).click();
  await expect(panel.getByTestId('variation-run-note')).toBeVisible({ timeout: 60000 });
  await panel.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'OpenAI + Seedream test' })).toBeHidden({ timeout: 60000 });
  await expect(page.locator('.layer-select', { hasText: 'Mascot' }).first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.layer-select', { hasText: 'Washing machine' }).first()).toBeVisible();
  // Edit: a word of the headline, the mascot moved; saved on this device; exported at the creative's own size.
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  // Words are grouped under their headline (collapsed); a single word is selected inside it.
  await page.locator('.text-elements summary').filter({ hasText: 'Grand' }).first().click();
  await page.getByRole('button', { name: 'Select word Grand', exact: true }).first().click();
  await page.getByLabel('Text content', { exact: true }).fill('Mega');
  await page.keyboard.press('Escape');
  await page.locator('.layer-select', { hasText: 'Mascot' }).first().click();
  const x = Number(await page.getByLabel('X', { exact: true }).inputValue()) + 30;
  await page.getByLabel('X', { exact: true }).fill(String(x));
  await page.getByLabel('X', { exact: true }).press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Saved on this device' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/13-editor.png` });
  const exported = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  expect(await sharp((await (await exported).path())!).metadata().then(m => [m.width, m.height])).toEqual([1000, 1200]);
  // Reload and reopen the same creative: the edited design comes back (no second design).
  await page.reload();
  const again = await open(page);
  // A saved template's card: use it, generate AI variations from it (straight to its Generate with AI tab), edit its master.
  const card = again.getByRole('article', { name: `Product template ${name}` });
  await expect(card.getByRole('button', { name: 'Edit master' })).toBeVisible();
  await card.getByRole('button', { name: 'Generate AI Variations' }).click();
  await expect(again.getByRole('tab', { name: 'Generate with AI' })).toHaveAttribute('aria-selected', 'true');
  await expect(again.getByRole('heading', { name: 'What should the variations look like?' })).toBeVisible();
  await again.getByRole('button', { name: 'Templates', exact: true }).click();
  await again.getByRole('article', { name: `Product template ${name}` }).getByRole('button', { name: 'Use template' }).click();
  await again.getByRole('complementary', { name: 'Creatives' }).getByRole('button', { name: /Festive original/ }).click();
  await again.getByRole('button', { name: 'Open in editor' }).click();
  await expect(page.getByRole('dialog', { name: 'OpenAI + Seedream test' })).toBeHidden({ timeout: 60000 });
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.locator('.text-elements summary').filter({ hasText: 'Mega' }).first().click();
  await expect(page.getByRole('button', { name: 'Select word Mega', exact: true }).first()).toBeVisible();
  await page.locator('.layer-select', { hasText: 'Mascot' }).first().click();
  await expect(page.getByLabel('X', { exact: true })).toHaveValue(String(x));
});
