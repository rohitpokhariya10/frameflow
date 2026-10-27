/**
 * AI detection of a FULL-SIZE upload in the browser, free: the LG Ganesh creative at 4096 px (as uploaded in the dev server
 * on 2026-10-22, where the whole picture was sent and the request timed out at 120 s, shown as "PROVIDER_ERROR"). The live
 * analyzer code runs with a client that never reaches the network (FRAMEFLOW_PRODUCT_AI_CLIENT, see
 * tests/fixtures/imageTemplateOfflineServer.ts):
 *
 *   recorded  the RECORDED real answer, given for the picture actually sent (2048 px): a complete detection — Ganesha,
 *             12 products, 42 words, in the creative's own 4096 px coordinates (the soundbar's box, misplaced by the
 *             answer, corrected in the review); then the whole route at full size:
 *             prepared (objects analysed on a working copy, every layer at 4096 px: multiscale.ts), saved, a creative
 *             sent to the Run Dashboard, opened in the editor and exported at 4096 px
 *   timeout   the review says the AI detection did not complete, why (a timeout, not a provider error), what was sent
 *             and how long it waited; the text read on this computer is labelled as such, never as a finished
 *             detection; preparing stays blocked and a retry asks before spending
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import type { ProductCreative, ProjectDocument } from '@frameflow/shared';
import type { ProductView } from '../../client/src/features/productTemplates/api';
import { decodeRgba } from '../../server/src/decomposition/protectedTemplates/pixels';
import { findSheetCreatives } from '../../server/src/decomposition/protectedTemplates/product/sheet';
const API = '/api/layerize-experiment/product-templates', OUT = process.env.FRAMEFLOW_E2E_OUT ?? 'test-results/product-v7/ai-detection';
test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` } });
test.setTimeout(300000);
test.use({ actionTimeout: 20000 });

/** The LG creative of the sheet, enlarged to 4096 px wide (a full-size upload of the same creative), as a JPEG. */
async function fullSize() {
  const sheet = readFileSync('Ganesh-Chaturthi.png'), c = findSheetCreatives(await decodeRgba(sheet)).boxes[0];
  return sharp(sheet).extract({ left: c.x, top: c.y, width: c.width, height: c.height }).resize(4096, null, { kernel: 'lanczos3' }).jpeg({ quality: 95 }).toBuffer();
}
async function upload(page: Page, name: string) {
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => r.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  await panel.getByRole('button', { name: 'New product template' }).click();
  await panel.getByLabel('Creative to upload').setInputFiles({ name: 'ganesh-4096.jpg', mimeType: 'image/jpeg', buffer: await fullSize() });
  await panel.getByLabel('Template name').fill(name);
  await panel.getByRole('checkbox', { name: /Find characters and products with AI/ }).check();
  const created = page.waitForResponse(r => r.url().endsWith(API) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Upload and find elements' }).click();
  return { panel, id: ((await (await created).json()) as ProductView).template.id };
}

test('a full-size upload: the AI gets a 2048 px picture and the recorded real answer completes the detection', async ({ page, request }, info) => {
  test.skip(process.env.FRAMEFLOW_PRODUCT_AI_CLIENT !== 'recorded' || info.project.name !== 'desktop', 'Needs FRAMEFLOW_PRODUCT_AI_CLIENT=recorded.');
  mkdirSync(OUT, { recursive: true });
  const { panel, id } = await upload(page, 'LG Ganesh 4096 · recorded');
  await expect(panel.getByRole('heading', { name: 'Here’s what we found' })).toBeVisible({ timeout: 120000 });
  await expect(panel.getByText('A recorded AI answer for this exact image, replayed: no new AI request was made.')).toBeVisible();
  // (12 products: the TV's soundbar, subwoofer and two satellites are advertised one by one, so each is its own.)
  await expect(panel.getByText('1 Characters · 12 Products · 42 Text words · 5 Text groups · 18 Logos')).toBeVisible();
  await page.screenshot({ path: `${OUT}/01-recorded-review.png` });
  const view = await (await request.get(`${API}/${id}`)).json() as ProductView;
  expect(view.template.source).toMatchObject({ width: 4096, height: 4089 });
  expect(view.product.detection!.ai).toMatchObject({ status: 'done' });
  // A complete detection: nothing blocks preparing.
  await expect(panel.getByRole('button', { name: 'Save and choose what to decompose' })).toBeEnabled();
  await expect(panel.getByTestId('prepare-needs-ai')).toHaveCount(0);
  const words = view.texts.flatMap(b => (b.wordList ?? []).filter(w => !w.removed));
  expect(words.every(w => w.box.x + w.box.width <= 4096 && w.box.y + w.box.height <= 4089)).toBe(true);
  expect(Math.max(...words.map(w => w.box.x + w.box.width))).toBeGreaterThan(2048);

  // The answer put the soundbar's box on the speakers below the TV (nothing of it inside: blocking). The reviewer draws it
  // again where it is, under the screen (by numbers; the 607 px creative's 290, 345, 66 × 8 at this size): its own layer.
  await panel.getByRole('region', { name: 'Products', exact: true }).getByRole('button', { name: /^Soundbar/ }).click();
  for (const [k, v] of [['width', 445], ['height', 54], ['x', 1957], ['y', 2328]] as const) await panel.getByRole('complementary', { name: 'Selected element' }).getByLabel(`Box ${k}`).fill(String(v));

  // Prepared at full size, in bounded time (it did not finish in 240 s before the working copy).
  const t0 = Date.now();
  await panel.getByRole('button', { name: 'Save and choose what to decompose' }).click();
  await expect(panel.getByRole('heading', { name: 'Choose what to decompose' })).toBeVisible();
  await panel.getByRole('button', { name: 'Continue to Decomposition' }).click();
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 90000 });
  const prepareSeconds = (Date.now() - t0) / 1000;
  await expect(panel.getByRole('region', { name: 'Display stands' }).getByRole('heading', { name: /^Display stands \(\d+\)$/ })).toBeVisible();
  await page.screenshot({ path: `${OUT}/06-prepared.png` });
  const prepared = (await (await request.get(`${API}/${id}`)).json() as ProductView).product.prepared!;
  const stands = prepared.stands ?? [];
  expect(stands.length).toBeGreaterThanOrEqual(3);
  for (const o of [...stands, ...(await (await request.get(`${API}/${id}`)).json() as ProductView).product.objects.filter(x => x.cutout)]) {
    const b = (o.cutout ?? { placement: o.box }).placement; expect(b.x >= 0 && b.y >= 0 && b.x + b.width <= 4096 && b.y + b.height <= 4089, o.label).toBe(true);
  }
  // Saved; a creative; the Run Dashboard; the editor; exported at full size.
  for (const c of await panel.getByRole('complementary', { name: 'Checks' }).getByRole('checkbox').all()) await c.check();
  // The quality gate: a blocking problem (here a stand completed behind a product where no stand is: its silhouette
  // shows when the product is hidden) keeps it from being saved as a master; it is saved as a draft, explicitly.
  const blocking = prepared.quality.issues.filter(i => i.blocking);
  if (blocking.length) {
    expect(blocking.every(i => i.id.startsWith('outline-')), blocking.map(i => i.message).join(' | ')).toBe(true);
    await expect(panel.getByRole('button', { name: 'Save master template' })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Save as a draft with these warnings…' }).click();
    await panel.getByRole('button', { name: 'Yes, save as a draft' }).click();
    await expect.poll(async () => ((await (await request.get(`${API}/${id}`)).json()) as ProductView).product.revisions.at(-1)?.draft).toBe(true);
  } else await panel.getByRole('button', { name: 'Save master template' }).click();
  await panel.getByRole('button', { name: 'Use this template' }).click();
  await panel.getByRole('button', { name: 'New creative' }).click();
  await expect(panel.getByRole('region', { name: 'Display stands' }).getByRole('listitem')).toHaveCount(stands.length, { timeout: 60000 });
  const creatives = (await (await request.get(`${API}/${id}/creatives`)).json()).creatives as { id: string }[];
  const creative = await (await request.get(`${API}/${id}/creatives/${creatives[0].id}`)).json() as ProductCreative;
  const t1 = Date.now(), sent = page.waitForResponse(r => r.url().endsWith('/open') && r.request().method() === 'POST', { timeout: 120000 });
  await panel.getByRole('button', { name: 'Send to Decomposition', exact: true }).click();
  const { runId } = await (await sent).json() as { runId: string };
  await expect(panel.getByRole('heading', { name: 'Image to editor layers', exact: true })).toBeVisible({ timeout: 60000 });
  const decompositionSeconds = (Date.now() - t1) / 1000;
  await page.screenshot({ path: `${OUT}/07-dashboard.png` });
  await panel.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(panel).toBeHidden({ timeout: 60000 });
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!) as ProjectDocument);
  await expect.poll(async () => (await stored()).variants.some(v => v.importedFrom?.runId === runId), { timeout: 60000 }).toBe(true);
  const design = (await stored()).variants.find(v => v.importedFrom?.runId === runId)!;
  for (const o of creative.objects.filter(x => !x.hidden && (x.kind === 'product' || x.kind === 'character' || x.kind === 'podium'))) expect(design.layers!.some(l => l.name === o.label), o.label).toBe(true);
  await page.screenshot({ path: `${OUT}/08-editor.png` });
  const download = page.waitForEvent('download', { timeout: 120000 });
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  await (await download).saveAs(`${OUT}/09-export.png`);
  const exported = await sharp(`${OUT}/09-export.png`).metadata();
  expect([exported.width, exported.height]).toEqual([4096, 4089]);
  writeFileSync(`${OUT}/recorded-evidence.json`, JSON.stringify({ source: view.template.source, ai: view.product.detection!.ai, counts: view.counts, words: words.length, prepareSeconds,
    preparedDurationMs: prepared.durationMs, stands: stands.map(s => s.label), decompositionSeconds, editorLayers: design.layers!.length, export: [exported.width, exported.height] }, null, 2));
});

test('a failed AI detection says so plainly: why, what was sent, and that only the text was read', async ({ page, request }, info) => {
  test.skip(process.env.FRAMEFLOW_PRODUCT_AI_CLIENT !== 'timeout' || info.project.name !== 'desktop', 'Needs FRAMEFLOW_PRODUCT_AI_CLIENT=timeout.');
  mkdirSync(OUT, { recursive: true });
  const { panel, id } = await upload(page, 'LG Ganesh 4096 · timeout');
  await expect(panel.getByRole('heading', { name: 'AI detection did not complete' })).toBeVisible({ timeout: 120000 });
  const alert = panel.getByRole('alert').filter({ hasText: 'AI detection did not complete (TIMEOUT).' });
  await expect(alert).toContainText('timed out: OpenAI sent no answer within 300 s');
  await expect(alert).toContainText('may still have processed (and billed) it');
  await expect(alert).toContainText('Sent: a 2048 × 2045 PNG');
  await expect(alert).toContainText('from your 4096 × 4089 creative');
  await expect(alert).toContainText('Characters and products were not detected');
  await expect(alert).not.toContainText('PROVIDER_ERROR');
  // The local reading, labelled as such; no "0 Characters · 0 Products" presented as a result.
  await expect(panel.getByTestId('local-only-counts')).toContainText('Read on this computer, without AI:');
  await expect(panel.getByTestId('local-only-counts')).toContainText('Characters and products: not detected.');
  await expect(panel.getByText(/^0 Characters · 0 Products/)).toHaveCount(0);
  // Preparing is blocked, and says why.
  await expect(panel.getByRole('button', { name: 'Save and choose what to decompose' })).toBeDisabled();
  await expect(panel.getByTestId('prepare-needs-ai')).toBeVisible();
  await page.screenshot({ path: `${OUT}/03-timeout-review.png` });
  // A retry asks first, with its cost; cancelled here (no request is made).
  await panel.getByRole('button', { name: 'Retry AI analysis…' }).click();
  await expect(panel.getByText(/Authorize one OpenAI vision analysis request\. Estimated cost: up to about \$0\.35/)).toBeVisible();
  await page.screenshot({ path: `${OUT}/04-retry-asks.png` });
  await panel.getByRole('button', { name: 'Cancel' }).click();
  const view = await (await request.get(`${API}/${id}`)).json() as ProductView;
  expect(view.product.detection!.ai).toMatchObject({ status: 'failed', code: 'TIMEOUT', sent: { width: 2048, height: 2045, mime: 'image/png', source: { width: 4096, height: 4089 } } });
  expect(view.product.activity.aiCalls).toBe(1);
  // At 390 px the explanation reads without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(alert).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await alert.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${OUT}/05-timeout-390.png` });
  writeFileSync(`${OUT}/timeout-evidence.json`, JSON.stringify({ ai: view.product.detection!.ai, local: view.product.detection!.local, error: view.product.detection!.error }, null, 2));
});
