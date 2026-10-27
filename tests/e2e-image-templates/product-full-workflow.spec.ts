import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import type { ProjectDocument } from '@frameflow/shared';
import type { ProductView, TemplateBrief, VariationJob } from '../../client/src/features/productTemplates/api';

/**
 * The connected workflow in the browser, against the offline fixture server (fake vision answer, offline test image
 * model; no request leaves the machine):
 *
 *   A  upload → AI detection → review → choose what to decompose (one product left in the background) → decompose →
 *      inspect (original, background only with its estimated areas, individual layers) → save the master template
 *   B  the saved master → Template details (instructions written from the detection, the decomposition plan) →
 *      Generate with AI: 3 variations, 1:1, the custom instructions left EMPTY → 3 creatives
 *   C  a variation → Decompose & Edit → its own review (found from its own layers, no AI request) → choose → decompose
 *      (each element its own layer, nothing estimated) → save → Open in the editor → a product moved, a word edited →
 *      reload: kept → export
 */
test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` }, actionTimeout: 30000 });
test.describe.configure({ timeout: 420000 });
const API = '/api/layerize-experiment/product-templates', OUT = process.env.PRODUCT_SHOTS_OUT ?? 'test-results/product-v13/full-workflow';

async function open(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  return panel;
}

test('A → B → C: master template, generation without a prompt, a variation decomposed and edited', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'One run of this long flow.');
  mkdirSync(OUT, { recursive: true });
  const outgoing: string[] = [];
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => { outgoing.push(r.request().url()); return r.abort(); });
  const name = `Workflow ${Date.now()}`, panel = await open(page);

  // A — upload, detect, review, choose, decompose, inspect, save.
  await panel.getByRole('button', { name: 'New product template' }).click();
  const poster = await (await request.get('/__test__/product-poster.png')).body();
  await panel.getByLabel('Creative to upload').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: poster });
  await panel.getByLabel('Template name').fill(name);
  await panel.getByRole('checkbox', { name: /Find characters and products with AI/ }).check();
  const created = page.waitForResponse(r => r.url().endsWith(API) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Upload and find elements' }).click();
  const id = ((await (await created).json()) as ProductView).template.id;
  await expect(panel.getByRole('heading', { name: 'Here’s what we found' })).toBeVisible({ timeout: 60000 });
  await panel.getByRole('button', { name: 'Save and choose what to decompose' }).click();
  await expect(panel.getByRole('heading', { name: 'Choose what to decompose' })).toBeVisible();
  const choose = panel.getByRole('region', { name: 'Elements to decompose' });
  await expect(choose.getByRole('checkbox', { name: 'Decompose Television' })).toBeChecked();
  await expect(panel.getByRole('region', { name: 'Always editable layers' })).toContainText('never sent to image decomposition');
  await choose.getByRole('checkbox', { name: 'Decompose Washing machine' }).uncheck();
  await page.screenshot({ path: `${OUT}/A1-choose.png` });
  await panel.getByRole('button', { name: 'Continue to Decomposition' }).click();
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 120000 });
  for (const tab of ['Original', 'Reconstructed full creative', 'Background only', 'Individual layers', 'Hide / Move test']) await expect(panel.getByRole('tab', { name: tab })).toBeVisible();
  await panel.getByRole('tab', { name: 'Background only' }).click();
  await panel.getByRole('button', { name: 'Show estimated areas' }).click();
  await page.screenshot({ path: `${OUT}/A2-background-estimated.png` });
  await panel.getByRole('tab', { name: 'Individual layers' }).click();
  const layers = panel.getByRole('region', { name: 'Individual layers' });
  await expect(layers.getByRole('article', { name: 'Layer Television' })).toBeVisible();
  await expect(layers.getByRole('article', { name: 'Layer Washing machine' })).toHaveCount(0); // left in the background, as chosen
  await page.screenshot({ path: `${OUT}/A3-layers.png` });
  for (const c of await panel.getByRole('complementary', { name: 'Checks' }).getByRole('checkbox').all()) await c.check();
  await panel.getByRole('button', { name: 'Save master template' }).click();
  await expect(panel.getByRole('heading', { name: 'Your template is saved' })).toBeVisible({ timeout: 60000 });
  const master = await (await request.get(`${API}/${id}`)).json() as ProductView;
  expect(master.product.objects.filter(o => o.cutout).map(o => o.label).sort()).toEqual(['Mascot', 'Refrigerator', 'Television']);

  // B — the master's details, then Generate with AI with nothing typed.
  await panel.getByRole('button', { name: 'Use this template' }).click();
  await panel.getByRole('tab', { name: 'Template details' }).click();
  const details = panel.getByRole('region', { name: 'How new creatives should look' });
  await expect(details.getByText('Written by FrameFlow from the AI detection')).toBeVisible();
  await expect(panel.getByRole('region', { name: 'How it is decomposed' })).toContainText('Kept in the background: ');
  await page.screenshot({ path: `${OUT}/B1-details.png`, fullPage: true });
  await panel.getByRole('tab', { name: 'Generate with AI' }).click();
  await panel.getByRole('radio', { name: '3', exact: true }).click();
  await panel.getByRole('checkbox', { name: 'Square 1:1' }).click();
  await panel.getByRole('checkbox', { name: 'Original size' }).click();
  await expect(panel.getByLabel('Creative direction')).toHaveValue('');
  await expect(panel.getByTestId('variation-outputs')).toContainText('Makes 3 creatives: 3 designs, all Square 1:1, 3 artwork images (test image model, free).');
  await page.screenshot({ path: `${OUT}/B2-generate-form.png`, fullPage: true });
  const started = page.waitForResponse(r => r.url().endsWith(`${API}/${id}/variations`) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Generate 3 variations' }).click();
  const jobId = ((await (await started).json()) as VariationJob).id;
  const cards = panel.getByRole('region', { name: 'Variations' }).getByRole('article');
  await expect(cards).toHaveCount(3, { timeout: 120000 });
  const job = await (await request.get(`${API}/${id}/variations/${jobId}`)).json() as VariationJob;
  expect(job.request).toMatchObject({ count: 3, aspectRatios: ['1:1'], artwork: 'ai', briefSource: 'template' });
  expect(job.request.brief).toBe(((await (await request.get(`${API}/${id}/brief`)).json()) as TemplateBrief).generation.prompt);
  expect(job.results.every(r => r.creative?.background?.method === 'ai-artwork' && r.creative.canvas.width === r.creative.canvas.height)).toBe(true);
  await page.screenshot({ path: `${OUT}/B3-variations.png`, fullPage: true });

  // C — Decompose & Edit the first variation through the same steps.
  await cards.first().getByRole('button', { name: 'Decompose & Edit' }).click();
  await expect(panel.getByRole('heading', { name: 'Here’s what we found' })).toBeVisible({ timeout: 60000 });
  await expect(panel.getByTestId('from-variation')).toContainText('no AI request');
  await page.screenshot({ path: `${OUT}/C1-variation-review.png` });
  await panel.getByRole('button', { name: 'Save and choose what to decompose' }).click();
  await panel.getByRole('button', { name: 'Continue to Decomposition' }).click();
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 120000 });
  await panel.getByRole('tab', { name: 'Individual layers' }).click();
  await expect(panel.getByRole('region', { name: 'Individual layers' }).getByRole('article', { name: 'Layer Television' })).toContainText('the variation’s own layer');
  await page.screenshot({ path: `${OUT}/C2-variation-layers.png` });
  const derivedId = (job.results[0].templateId ?? ((await (await request.get(`${API}/${id}/variations/${jobId}`)).json()) as VariationJob).results[0].templateId)!;
  const derived = await (await request.get(`${API}/${derivedId}`)).json() as ProductView;
  expect(derived.product.objects.filter(o => o.cutout).every(o => o.cutout!.method === 'layer')).toBe(true);
  expect(derived.product.prepared!.quality.reconstructedPercent ?? 0).toBe(0);
  expect(derived.product.activity).toMatchObject({ aiCalls: 0, costUsd: 0 });
  for (const c of await panel.getByRole('complementary', { name: 'Checks' }).getByRole('checkbox').all()) await c.check();
  await panel.getByRole('button', { name: 'Save master template' }).click();
  await expect(panel.getByRole('heading', { name: 'Your template is saved' })).toBeVisible({ timeout: 60000 });
  await panel.getByRole('button', { name: 'Open in the editor' }).click();
  await expect(panel).toBeHidden({ timeout: 60000 });

  // The editor: a product moved on its own, a word edited; reloaded, kept; exported at the variation's size.
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!) as ProjectDocument);
  await expect.poll(async () => (await stored()).variants.some(v => v.productTemplate)).toBe(true);
  const design = (await stored()).variants.filter(v => v.productTemplate).at(-1)!;
  await page.screenshot({ path: `${OUT}/C3-editor.png` });
  const tvLayer = design.layers!.find(l => l.type === 'image' && /Television/.test(l.name ?? ''))!, otherBefore = design.layers!.filter(l => l.id !== tvLayer.id).map(l => JSON.stringify(l));
  await page.locator('.layer-select', { hasText: 'Television' }).first().click();
  const x = Number(await page.getByLabel('X', { exact: true }).inputValue()) + 40;
  await page.getByLabel('X', { exact: true }).fill(String(x));
  await page.getByLabel('X', { exact: true }).press('Enter');
  await expect.poll(async () => Math.round((await stored()).variants.find(v => v.id === design.id)!.layers!.find(l => l.id === tvLayer.id)!.x)).toBe(Math.round(x));
  // (Moving the television moved nothing else.)
  expect((await stored()).variants.find(v => v.id === design.id)!.layers!.filter(l => l.id !== tvLayer.id).map(l => JSON.stringify(l))).toEqual(otherBefore);
  const word = design.elements.find(e => e.type === 'text' && /^[A-Za-z]{4,}$/.test(e.text))!;
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.locator('.text-elements summary').filter({ hasText: word.type === 'text' ? word.text : '' }).first().click();
  await page.getByRole('button', { name: `Select word ${word.type === 'text' ? word.text : ''}`, exact: true }).first().click();
  await page.getByLabel('Text content', { exact: true }).fill('EDITED');
  await page.getByLabel('Text content', { exact: true }).blur();
  await expect.poll(async () => { const e = (await stored()).variants.find(v => v.id === design.id)!.elements.find(el => el.id === word.id)!; return e.type === 'text' ? e.text : ''; }).toBe('EDITED');
  await page.reload();
  await expect.poll(async () => { const e = (await stored()).variants.find(v => v.id === design.id)?.elements.find(el => el.id === word.id); return e && e.type === 'text' ? e.text : ''; }).toBe('EDITED');
  await page.screenshot({ path: `${OUT}/C4-editor-after-reload.png` });
  const exported = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const meta = await sharp((await (await exported).path())!).metadata();
  expect(meta.width).toBe(meta.height);
  expect(outgoing).toEqual([]);
});
