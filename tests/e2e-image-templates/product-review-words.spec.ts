/**
 * Word-by-word review in the browser on the RECORDED real AI answer for the LG Ganesh creative (FRAMEFLOW_PRODUCT_REFERENCE=1
 * FRAMEFLOW_PRODUCT_RECORDED=1; replayed, no network): a word retyped and widened, a word moved to a block of its own, a
 * word removed, missed text added, a product renamed, a logo replaced, the corrections previewed; then prepared, saved,
 * reused, sent to the existing Run Dashboard and opened in the existing editor with every correction, and exported.
 */
import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ProductCreative, ProjectDocument } from '@frameflow/shared';
import type { ProductView } from '../../client/src/features/productTemplates/api';
const API = '/api/layerize-experiment/product-templates', OUT = 'test-results/product-v5/review-words';
test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` } });
test.setTimeout(240000);
test.use({ actionTimeout: 20000 });

test('recorded real answer: words, text, objects and logos corrected in the review reach the master, the run and the editor', async ({ page, request }, info) => {
  test.skip(process.env.FRAMEFLOW_PRODUCT_RECORDED !== '1' || info.project.name !== 'desktop', 'Needs the recorded real answer (FRAMEFLOW_PRODUCT_RECORDED=1).');
  mkdirSync(OUT, { recursive: true });
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => r.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  await panel.getByRole('button', { name: 'New product template' }).click();
  await panel.getByLabel('Creative to upload').setInputFiles({ name: 'Ganesh-Chaturthi.png', mimeType: 'image/png', buffer: readFileSync('Ganesh-Chaturthi.png') });
  await expect(panel.getByText('This picture has 4 creatives')).toBeVisible();
  await panel.getByLabel('Template name').fill('LG Ganesh · review words');
  await panel.getByRole('checkbox', { name: /Find characters and products with AI/ }).check();
  const created = page.waitForResponse(r => r.url().endsWith(API) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Upload and find elements' }).click();
  const id = ((await (await created).json()) as ProductView).template.id;
  await expect(panel.getByRole('heading', { name: 'Here’s what we found' })).toBeVisible({ timeout: 120000 });
  await expect(panel.getByText('A recorded AI answer for this exact image, replayed: no new AI request was made.')).toBeVisible();
  // (12 products: the TV's soundbar, subwoofer and two satellites are advertised one by one, so each is its own.)
  await expect(panel.getByText('1 Characters · 12 Products · 42 Text words · 5 Text groups · 18 Logos')).toBeVisible();
  // The answer put the soundbar's box on the speakers below the TV (nothing of it inside: blocking). The reviewer draws it
  // again where it is, under the screen (by numbers): the soundbar becomes a layer of its own, not part of the TV's.
  await panel.getByRole('region', { name: 'Products', exact: true }).getByRole('button', { name: /^Soundbar/ }).click();
  for (const [k, v] of [['width', 66], ['height', 8], ['x', 290], ['y', 345]] as const) await panel.getByRole('complementary', { name: 'Selected element' }).getByLabel(`Box ${k}`).fill(String(v));
  await page.screenshot({ path: `${OUT}/01-review-recorded.png` });
  const inspector = panel.getByRole('complementary', { name: 'Selected element' }), text = panel.getByRole('region', { name: 'Text', exact: true });
  // The headline opened into its words; "calls" retyped and widened.
  await text.getByRole('button', { name: /^Show the words of A grand$/ }).click();
  await text.getByRole('button', { name: 'Select word calls', exact: true }).click();
  await inspector.getByLabel('Word', { exact: true }).fill('brings');
  const width = inspector.getByLabel('Word width');
  await width.fill(String(Number(await width.inputValue()) + 6));
  await page.screenshot({ path: `${OUT}/02-word-selected.png` });
  // "savings." into a block of its own.
  await text.getByRole('button', { name: 'Select word savings.', exact: true }).click();
  await inspector.getByLabel('Text block of the word').selectOption({ value: 'new' });
  // The offer opened; "products." removed.
  await text.getByRole('button', { name: /^Show the words of Get 26% cashback/ }).click();
  await text.getByRole('button', { name: 'Select word products.', exact: true }).click();
  await inspector.getByRole('button', { name: 'Not a word: remove it' }).click();
  // Text the detection missed, drawn on the white footer beside the validity pill.
  await panel.getByLabel('Add an element').selectOption({ value: 'text' });
  const svg = await panel.locator('svg.prt-canvas').boundingBox(), k = svg!.width / 607;
  await page.mouse.move(svg!.x + 420 * k, svg!.y + 588 * k); await page.mouse.down(); await page.mouse.move(svg!.x + 540 * k, svg!.y + 602 * k, { steps: 6 }); await page.mouse.up();
  await inspector.getByLabel('Added text').fill('Offer ends soon');
  // A product renamed (the model's "air purifier" is the water purifier).
  await panel.getByRole('region', { name: 'Products', exact: true }).getByRole('button', { name: /Air purifier/ }).click();
  await inspector.getByLabel('Name').fill('Water purifier');
  // The unclear bank logo replaced with a picture and named.
  await panel.getByRole('region', { name: 'Logos', exact: true }).getByRole('button', { name: /Unclear red-and-black bank logo/ }).click();
  const logoPng = await sharp({ create: { width: 90, height: 24, channels: 4, background: '#1d4ed8' } }).png().toBuffer();
  await inspector.getByLabel('Replace the picture of Unclear red-and-black bank logo').setInputFiles({ name: 'dbs.png', mimeType: 'image/png', buffer: logoPng });
  await expect(inspector.getByRole('button', { name: 'Use the original' })).toBeVisible();
  await inspector.getByLabel('Name').fill('DBS Bank logo');
  // Preview of the corrections.
  await panel.getByRole('button', { name: 'Preview corrections' }).click();
  await page.screenshot({ path: `${OUT}/03-preview-corrections.png` });
  // Approve, prepare, save.
  await panel.getByRole('button', { name: 'Save and choose what to decompose' }).click();
  await expect(panel.getByRole('heading', { name: 'Choose what to decompose' })).toBeVisible();
  await panel.getByRole('button', { name: 'Continue to Decomposition' }).click();
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 120000 });
  const view = await (await request.get(`${API}/${id}`)).json() as ProductView;
  const words = view.texts.flatMap(b => (b.wordList ?? []).filter(w => !w.removed).map(w => w.text));
  expect(words).toEqual(expect.arrayContaining(['brings', 'savings.', 'Offer', 'ends', 'soon']));
  expect(words).not.toContain('calls'); expect(words).not.toContain('products.');
  expect(view.logos.find(l => l.label === 'DBS Bank logo')!.file).toMatch(/^prl-/);
  expect(view.product.objects.some(o => o.label === 'Water purifier')).toBe(true);
  for (const [name, f] of [['04-clean', view.product.prepared!.clean.file], ['05-background', view.product.prepared!.base.file], ['06-reconstructed', view.product.prepared!.previews.recombined]] as const)
    writeFileSync(`${OUT}/${name}.png`, await (await request.get(`/api/layerize-experiment/protected-templates/${id}/files/${f}`)).body());
  await panel.getByRole('tab', { name: 'Background only' }).click();
  await page.screenshot({ path: `${OUT}/07-prepared-background.png` });
  for (const c of await panel.getByRole('complementary', { name: 'Checks' }).getByRole('checkbox').all()) await c.check();
  await panel.getByRole('button', { name: 'Save master template' }).click();
  await panel.getByRole('button', { name: 'Use this template' }).click();
  await panel.getByRole('button', { name: 'New creative' }).click();
  // The creative, its run on the existing Run Dashboard, then the existing editor.
  const sent = page.waitForResponse(r => r.url().endsWith('/open') && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Send to Decomposition', exact: true }).click();
  const { runId } = await (await sent).json() as { runId: string };
  await expect(panel.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('heading', { name: 'Image to editor layers', exact: true })).toBeVisible();
  await page.screenshot({ path: `${OUT}/08-run-dashboard.png` });
  const creatives = (await (await request.get(`${API}/${id}/creatives`)).json()).creatives as { id: string }[];
  const creative = await (await request.get(`${API}/${id}/creatives/${creatives[0].id}`)).json() as ProductCreative;
  expect(creative.texts.map(t => t.text)).toEqual(expect.arrayContaining(['brings', 'Offer', 'ends', 'soon']));
  expect(creative.images.some(i => /^prl-/.test(i.asset.file))).toBe(true);
  await panel.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(panel).toBeHidden();
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!) as ProjectDocument);
  await expect.poll(async () => (await stored()).variants.some(v => v.importedFrom?.runId === runId)).toBe(true);
  const design = (await stored()).variants.find(v => v.importedFrom?.runId === runId)!;
  const texts = design.elements.map(e => (e.type === 'text' ? e.text : ''));
  expect(texts).toEqual(expect.arrayContaining(['brings', 'Offer', 'ends', 'soon', 'savings.']));
  expect(texts).not.toContain('calls');
  expect(design.layers!.some(l => l.name === 'DBS Bank logo')).toBe(true);
  expect(design.layers!.some(l => l.name === 'Water purifier')).toBe(true);
  await page.screenshot({ path: `${OUT}/09-editor.png` });
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  await (await download).saveAs(`${OUT}/10-export.png`);
  expect(await sharp(`${OUT}/10-export.png`).metadata().then(m => [m.width, m.height])).toEqual([607, 606]);
  writeFileSync(`${OUT}/evidence.json`, JSON.stringify({ answer: 'recorded real gpt-5.6-sol answer, replayed (no network)', templateId: id, runId, words: words.length, corrected: ['calls→brings (+6px width)', 'savings. → own block', 'products. removed', 'Offer ends soon added', 'Air purifier → Water purifier', 'Unclear logo → DBS Bank logo (replaced picture)'] }, null, 2));
});
