import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import type { ProjectDocument, ReuseDraft } from '@frameflow/shared';

// The client demo on a COPY of a real saved template (FRAMEFLOW_SAVED_VARIATION_FIXTURE=<copy root with protected/>), with
// a draft made beforehand on that copy: open it in Create a New Creative, save, Decompose & Edit (offline stand-in
// providers), the editor (move, resize, edit text), save, reopen, export. FRAMEFLOW_REUSE_DEMO=<template id>:<draft name>.
const API = '/api/layerize-experiment/product-templates', FILES = '/api/layerize-experiment/protected-templates', OUT = 'test-results/real-reuse-demo';
test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` }, actionTimeout: 30000 });
test.setTimeout(600000);

async function openPanel(page: Page) {
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => r.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  return panel;
}

test('Client demo on a copy of a real template: saved creative → Decompose & Edit → editor → export (offline providers)', async ({ page, request }) => {
  const [id, name] = (process.env.FRAMEFLOW_REUSE_DEMO ?? '').split(':');
  test.skip(!id || !name || !process.env.FRAMEFLOW_SAVED_VARIATION_FIXTURE, 'Needs FRAMEFLOW_REUSE_DEMO and a template copy.');
  mkdirSync(OUT, { recursive: true });
  const master = JSON.stringify(await (await request.get(`${API}/${id}/revisions/1`)).json());
  const draftId = ((await (await request.get(`${API}/${id}/reuse`)).json()).drafts as { id: string; name: string }[]).find(d => d.name === name)!.id;
  // Generated again (free, on this computer): the draft the simple flow opens first.
  expect((await request.post(`${API}/${id}/reuse/${draftId}/generate`, { data: {} })).ok()).toBe(true);
  const draft = async () => (await (await request.get(`${API}/${id}/reuse/${draftId}`)).json()).draft as ReuseDraft;
  const preview = await (await request.get(`${API}/${id}/reuse/${draftId}/preview?ratio=original`)).json();
  expect(preview.creative.background?.stageCleaned).toBe(true);
  expect(preview.checks.issues.filter((i: { blocking: boolean }) => i.blocking)).toEqual([]);
  writeFileSync(`${OUT}/01-creative.png`, await (await request.get(`${FILES}/${id}/files/${(await draft()).outputs.original!.preview}`)).body());

  const panel = await openPanel(page);
  await panel.getByRole('article').filter({ has: page.locator(`img[src*="${id}"]`) }).first().getByRole('button', { name: 'Reuse Template' }).click();
  await expect(panel.getByRole('heading', { name: 'Your creative is ready!' })).toBeVisible({ timeout: 120000 });
  await expect(panel.getByText('Products arranged automatically')).toBeVisible();
  await page.screenshot({ path: `${OUT}/02-ready.png`, fullPage: true });
  // Save.
  await panel.getByRole('button', { name: 'Save Creative' }).click();
  await expect(panel.getByRole('button', { name: 'Saved' })).toBeVisible();
  const creativeId = (await draft()).outputs.original!.creativeId!;
  const saved = await (await request.get(`${API}/${id}/creatives/${creativeId}`)).json();
  expect(saved.background?.stageCleaned).toBe(true);
  // Decompose & Edit with the offline stand-in (no OpenAI, no Seedream request leaves this computer).
  const handoff = page.waitForResponse(r => r.url().endsWith('/outputs/original/decomposition') && r.request().method() === 'POST');
  const submissions = (await (await request.get('/__test__/product-calls')).json()).submissions.length;
  await panel.getByRole('region', { name: 'Edit Your Creative' }).getByRole('button', { name: 'Decompose into Layers' }).click();
  const { templateId } = await (await handoff).json() as { templateId: string };
  const makeEditable = page.getByRole('dialog', { name: 'Make Your Creative Editable' });
  await expect(makeEditable.getByRole('button', { name: /^Make Editable/ })).toBeEnabled({ timeout: 120000 });
  expect((await (await request.get('/__test__/product-calls')).json()).submissions).toHaveLength(submissions);
  await makeEditable.getByRole('button', { name: /^Make Editable/ }).click();
  await page.getByRole('dialog', { name: 'Your Creative Is Ready to Edit!' }).getByRole('button', { name: 'Review Layers' }).click({ timeout: 180000 });
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 120000 });
  await page.screenshot({ path: `${OUT}/04-inspect.png`, fullPage: true });
  const decomposed = await (await request.get(`${API}/${templateId}`)).json();
  type Cut = { id: string; kind: string; label: string; cutout?: { file: string } };
  const products = (decomposed.product.objects as Cut[]).filter(o => o.kind === 'product' && o.cutout);
  const savedProducts = (saved.objects as { kind: string; label: string; asset: { file: string }; box: { width: number; height: number } }[]).filter(o => o.kind === 'product');
  expect(products.map(o => o.label.toLowerCase()).sort()).toEqual(savedProducts.map(o => o.label.toLowerCase()).sort());
  writeFileSync(`${OUT}/decomposition.json`, JSON.stringify(decomposed.product, null, 1));
  // The largest product stands partly behind a smaller one in front of it: it is found hidden, and its layer is its
  // complete picture — the uploaded photo as the creative shows it (same opaque size and colours), not the part that showed.
  expect(JSON.stringify(decomposed.product)).toContain('moving it shows all of it');
  const washerAsset = [...savedProducts].sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
  const opaque = async (png: Buffer, size?: { width: number; height: number }) => {
    const { data, info } = await (size ? sharp(png).resize(Math.round(size.width), Math.round(size.height), { fit: 'fill' }) : sharp(png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1, k = 0, r = 0, g = 0, b = 0;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) { const i = (y * info.width + x) * 4; if (data[i + 3] < 128) continue; k++; r += data[i]; g += data[i + 1]; b += data[i + 2]; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { width: x1 - x0 + 1, height: y1 - y0 + 1, pixels: k, mean: [r / k, g / k, b / k] };
  };
  const layer = await opaque(await (await request.get(`${FILES}/${templateId}/files/${products.find(o => o.label.toLowerCase() === washerAsset.label.toLowerCase())!.cutout!.file}`)).body());
  const photo = await opaque(await (await request.get(`${FILES}/${id}/files/${washerAsset.asset.file}`)).body(), washerAsset.box);
  expect(Math.abs(layer.width - photo.width)).toBeLessThanOrEqual(2); expect(Math.abs(layer.height - photo.height)).toBeLessThanOrEqual(2);
  expect(Math.abs(layer.pixels - photo.pixels)).toBeLessThan(photo.pixels * 0.01);
  layer.mean.forEach((v, c) => expect(Math.abs(v - photo.mean[c])).toBeLessThan(2));
  // The editor: the washing machine moved out from behind the cooker shows whole, the stage behind it clean; a word of
  // the headline edited; saved, reopened, exported.
  const opened = page.waitForResponse(r => r.url().endsWith(`/${templateId}/open-editor`) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  const { runId } = await (await opened).json();
  await expect(panel).toBeHidden({ timeout: 60000 });
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!) as ProjectDocument);
  await expect.poll(async () => (await stored()).variants.some(v => v.importedFrom?.runId === runId)).toBe(true);
  const design = (await stored()).variants.find(v => v.importedFrom?.runId === runId)!;
  const exportAs = async (name: string) => { const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export PNG', exact: true }).click(); await (await download).saveAs(`${OUT}/${name}`); };
  await exportAs('05a-before-move.png');
  const washer = design.layers!.find(l => l.name.toLowerCase() === washerAsset.label.toLowerCase())!, movedX = Math.round(washer.x + washer.width * 0.6);
  await page.locator('.layer-select', { hasText: washer.name }).first().click();
  await page.getByLabel('X', { exact: true }).fill(String(movedX)); await page.getByLabel('X', { exact: true }).blur();
  await expect.poll(async () => (await stored()).variants.find(v => v.id === design.id)!.layers!.find(l => l.id === washer.id)!.x).toBe(movedX);
  // Resized too (wider by 40 px): still its complete picture.
  const widened = Math.round(washer.width) + 40;
  await page.getByLabel('Width', { exact: true }).fill(String(widened)); await page.getByLabel('Width', { exact: true }).blur();
  await expect.poll(async () => Math.round((await stored()).variants.find(v => v.id === design.id)!.layers!.find(l => l.id === washer.id)!.width)).toBe(widened);
  await page.screenshot({ path: `${OUT}/05-editor-layers.png` });
  await exportAs('05b-after-move.png');
  // Before and after, side by side around the products.
  const crop = async (f: string) => { const m = await sharp(f).metadata(), k = m.width! / design.canvas.width; return sharp(f).extract({ left: Math.round(washer.x * k - washer.width * 1.4 * k), top: Math.round((washer.y - washer.height * 0.15) * k), width: Math.round(washer.width * 3.2 * k), height: Math.round(washer.height * 1.45 * k) }).resize(900).png().toBuffer(); };
  const [before, after] = [await crop(`${OUT}/05a-before-move.png`), await crop(`${OUT}/05b-after-move.png`)], bh = (await sharp(before).metadata()).height!;
  await sharp({ create: { width: 1820, height: bh, channels: 3, background: '#ffffff' } }).composite([{ input: before, left: 0, top: 0 }, { input: after, left: 920, top: 0 }]).png().toFile(`${OUT}/05c-before-after-move.png`);
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.locator('.text-elements summary').filter({ hasText: 'grand' }).first().click();
  await page.getByRole('button', { name: 'Select word grand', exact: true }).first().click();
  await page.getByLabel('Text content', { exact: true }).fill('golden'); await page.getByLabel('Text content', { exact: true }).blur();
  await expect.poll(async () => (await stored()).variants.find(v => v.id === design.id)!.elements.some(e => e.text === 'golden')).toBe(true);
  await page.getByRole('button', { name: 'Save creative', exact: true }).click();
  await expect(page.getByText(/Saved to creative · revision \d+/)).toBeVisible();
  await page.reload();
  const again = (await stored()).variants.find(v => v.id === design.id)!;
  expect(again.layers!.find(l => l.id === washer.id)!.x).toBe(movedX);
  expect(Math.round(again.layers!.find(l => l.id === washer.id)!.width)).toBe(widened);
  expect(again.elements.some(e => e.text === 'golden')).toBe(true);
  await exportAs('06-export.png');
  expect((await sharp(`${OUT}/06-export.png`).metadata()).width).toBeGreaterThan(100);
  // The master revision was only read.
  expect(JSON.stringify(await (await request.get(`${API}/${id}/revisions/1`)).json())).toBe(master);
});
