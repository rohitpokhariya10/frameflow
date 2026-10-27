/**
 * The complete offline journey on the REAL LG Ganesh creative (FRAMEFLOW_PRODUCT_REFERENCE=1 FRAMEFLOW_PRODUCT_RECORDED=1):
 * the RECORDED real gpt-5.6-sol answer for detection and the three RECORDED real gpt-image-2 artworks of 2026-10-22 (one
 * per size: 16:9, 9:16, 1:1 — three different pictures), replayed; no request leaves the machine.
 *
 *   Test 1  master template: upload → detection → review (the soundbar's misplaced box drawn where it is) → choose →
 *           decompose → inspect → save → the page reloaded and the template reopened from the library
 *   Test 2  one-click generation: the library's Generate AI Variations → 3 variations in 16:9, 9:16 and 1:1, nothing
 *           typed (no prompt, no direction) → a job planned from the template's own instructions; 3 results of their own
 *   Test 3  a variation → Decompose & Edit → its own template (layers of the variation) → editor: one product moved, a word
 *           made longer (the rest of its line moves on, nothing else) → reloaded: kept → exported: the editor's picture
 *
 * The replayed artworks were made by a real model earlier; replaying them proves the app's handling of distinct artworks
 * per variation, not that generation works live today (that needs a paid run).
 */
import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import type { ProjectDocument, TextElement } from '@frameflow/shared';
import type { ProductView, TemplateBrief, VariationJob } from '../../client/src/features/productTemplates/api';

test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` }, actionTimeout: 30000 });
test.describe.configure({ timeout: 600000 });
const API = '/api/layerize-experiment/product-templates', OUT = process.env.PRODUCT_SHOTS_OUT ?? 'test-results/product-v15/final-journey';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function library(page: Page) {
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  return panel;
}

test('Tests 1–3 on the LG creative: master template, generation without a prompt, a variation decomposed, edited, reopened and exported', async ({ page, request }, info) => {
  test.skip(process.env.FRAMEFLOW_PRODUCT_RECORDED !== '1' || info.project.name !== 'desktop', 'Needs the recorded real answer and artworks (FRAMEFLOW_PRODUCT_REFERENCE=1 FRAMEFLOW_PRODUCT_RECORDED=1).');
  mkdirSync(OUT, { recursive: true });
  const outgoing: string[] = [], evidence: Record<string, unknown> = { note: 'offline; recorded real AI answer and recorded real gpt-image-2 artworks replayed (no live AI request)' };
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => { outgoing.push(r.request().url()); return r.abort(); });
  const name = `LG final journey ${Date.now()}`;
  await page.goto('/');
  let panel = await library(page);

  // ---- Test 1: the master template ---------------------------------------------------------------------------------
  await panel.getByRole('button', { name: 'New product template' }).click();
  await panel.getByLabel('Creative to upload').setInputFiles({ name: 'Ganesh-Chaturthi.png', mimeType: 'image/png', buffer: readFileSync('Ganesh-Chaturthi.png') });
  await expect(panel.getByText('This picture has 4 creatives')).toBeVisible();
  await panel.getByLabel('Template name').fill(name);
  await panel.getByRole('checkbox', { name: /Find characters and products with AI/ }).check();
  const created = page.waitForResponse(r => r.url().endsWith(API) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Upload and find elements' }).click();
  const masterId = ((await (await created).json()) as ProductView).template.id;
  await expect(panel.getByRole('heading', { name: 'Here’s what we found' })).toBeVisible({ timeout: 120000 });
  await expect(panel.getByText('A recorded AI answer for this exact image, replayed: no new AI request was made.')).toBeVisible();
  await expect(panel.getByText('1 Characters · 12 Products · 42 Text words · 5 Text groups · 18 Logos')).toBeVisible();
  // The answer put the soundbar's box on the speakers below the TV (nothing of it inside). The reviewer draws it where
  // it is, by numbers: the soundbar becomes a layer of its own, not part of the TV's.
  await panel.getByRole('region', { name: 'Products', exact: true }).getByRole('button', { name: /^Soundbar/ }).click();
  for (const [k, v] of [['width', 66], ['height', 8], ['x', 290], ['y', 345]] as const) await panel.getByRole('complementary', { name: 'Selected element' }).getByLabel(`Box ${k}`).fill(String(v));
  await page.screenshot({ path: `${OUT}/1a-review.png` });
  await panel.getByRole('button', { name: 'Save and choose what to decompose' }).click();
  await expect(panel.getByRole('heading', { name: 'Choose what to decompose' })).toBeVisible();
  const choose = panel.getByRole('region', { name: 'Elements to decompose' });
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const products = ((await (await request.get(`${API}/${masterId}`)).json()) as ProductView).product.objects.filter(o => o.kind === 'product' && !o.hidden).map(o => o.label);
  expect(products).toHaveLength(12); expect(products).toContain('Soundbar');
  for (const p of products) await expect(choose.getByRole('checkbox', { name: new RegExp(`^Decompose ${esc(p)}`) }).first()).toBeChecked();
  await panel.getByRole('button', { name: 'Continue to Decomposition' }).click();
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 180000 });
  await panel.getByRole('tab', { name: 'Individual layers' }).click();
  const layers = panel.getByRole('region', { name: 'Individual layers' });
  for (const p of products) await expect(layers.getByRole('article', { name: new RegExp(`^Layer ${esc(p)}`) }).first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/1b-layers.png`, fullPage: true });
  await panel.getByRole('tab', { name: 'Background only' }).click();
  await page.screenshot({ path: `${OUT}/1c-background.png` });
  let master = await (await request.get(`${API}/${masterId}`)).json() as ProductView;
  const soundbar = master.product.objects.find(o => o.label === 'Soundbar')!;
  expect(soundbar.cutout, 'the soundbar is a layer of its own').toBeTruthy();
  const blocking = master.product.prepared!.quality.issues.filter(i => i.blocking);
  evidence.masterIssues = master.product.prepared!.quality.issues.map(i => `${i.blocking ? 'BLOCKING ' : ''}${i.id}: ${i.message.slice(0, 140)}`);
  for (const c of await panel.getByRole('complementary', { name: 'Checks' }).getByRole('checkbox').all()) await c.check();
  if (blocking.length) {
    // (A blocking problem keeps it from being saved as an approved master: saved as a draft, explicitly.)
    await panel.getByRole('button', { name: 'Save as a draft with these warnings…' }).click();
    await panel.getByRole('button', { name: 'Yes, save as a draft' }).click();
  } else await panel.getByRole('button', { name: 'Save master template' }).click();
  await expect(panel.getByRole('heading', { name: 'Your template is saved' })).toBeVisible({ timeout: 60000 });
  master = await (await request.get(`${API}/${masterId}`)).json() as ProductView;
  expect(master.product.revisions.length).toBe(1);
  const masterSnapshot = async () => sha(JSON.stringify(await (await request.get(`${API}/${masterId}/revisions/1`)).json()));
  const masterBefore = { revisions: JSON.stringify(master.product.revisions), snapshot: await masterSnapshot() };
  evidence.master = { id: masterId, revision: 1, draft: master.product.revisions[0].draft ?? false, layers: master.product.objects.filter(o => o.cutout).map(o => o.label), stands: master.product.prepared!.stands?.map(s => s.label) };

  // Reopened: the page reloaded, the template found in the library and opened again.
  await page.reload();
  panel = await library(page);
  const card = panel.getByRole('article', { name: `Product template ${name}` });
  await expect(card.getByRole('button', { name: 'Generate AI Variations' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Edit master' })).toBeVisible();
  await page.screenshot({ path: `${OUT}/1d-library-reopened.png` });

  // ---- Test 2: one-click generation, nothing typed -----------------------------------------------------------------
  await card.getByRole('button', { name: 'Generate AI Variations' }).click();
  await expect(panel.getByRole('tab', { name: 'Generate with AI' })).toHaveAttribute('aria-selected', 'true');
  await panel.getByRole('radio', { name: '3', exact: true }).click();
  for (const size of ['Landscape 16:9', 'Story 9:16', 'Square 1:1']) await panel.getByRole('checkbox', { name: size }).click();
  await panel.getByRole('checkbox', { name: 'Original size' }).click();
  await panel.getByRole('radio', { name: /New AI artwork/ }).check();
  await expect(panel.getByText(/Real gpt-image-2 artwork recorded earlier, replayed/)).toBeVisible();
  await expect(panel.getByLabel('Creative direction')).toHaveValue('');
  await page.screenshot({ path: `${OUT}/2a-generate-form.png`, fullPage: true });
  const started = page.waitForResponse(r => r.url().endsWith(`${API}/${masterId}/variations`) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Generate 3 variations' }).click();
  const jobId = ((await (await started).json()) as VariationJob).id;
  const cards = panel.getByRole('region', { name: 'Variations' }).getByRole('article');
  await expect(cards).toHaveCount(3, { timeout: 180000 });
  await page.screenshot({ path: `${OUT}/2b-variations.png`, fullPage: true });
  let job = await (await request.get(`${API}/${masterId}/variations/${jobId}`)).json() as VariationJob;
  // Planned from the template's own instructions: no prompt, no direction typed.
  expect(job.request).toMatchObject({ count: 3, aspectRatios: ['16:9', '9:16', '1:1'], artwork: 'ai', briefSource: 'template' });
  expect((job.request as { direction?: string }).direction).toBeUndefined();
  expect(job.request.brief).toBe(((await (await request.get(`${API}/${masterId}/brief`)).json()) as TemplateBrief).generation.prompt);
  expect(job.artwork).toMatchObject({ model: 'gpt-image-2 (recorded artwork, replayed)', offline: true, costUsd: 0 });
  // Three results of their own: their own creative, picture and artwork (three different recorded pictures).
  const results = job.results.filter(r => r.status === 'ready');
  expect(results).toHaveLength(3);
  const file = (f: string) => `/api/layerize-experiment/protected-templates/${masterId}/files/${f}`;
  const ids = results.map(r => r.creative!.id), previews = await Promise.all(results.map(async r => sha(await (await request.get(file(r.preview!))).body()))), artworks = await Promise.all(results.map(async r => sha(await (await request.get(file(r.creative!.background!.file))).body())));
  expect(new Set(ids).size).toBe(3); expect(new Set(previews).size).toBe(3); expect(new Set(artworks).size).toBe(3);
  for (const r of results) writeFileSync(`${OUT}/2c-variation-${r.index}-${r.creative!.variation!.aspectRatio!.replace(':', 'x')}.png`, await (await request.get(file(r.preview!))).body());
  const shape = (c: { width: number; height: number }) => (c.width / c.height > 1.02 ? 'wide' : c.width / c.height < 0.98 ? 'tall' : 'square');
  expect(results.map(r => [r.creative!.variation!.aspectRatio, shape(r.creative!.canvas)])).toEqual([['16:9', 'wide'], ['9:16', 'tall'], ['1:1', 'square']]);
  for (const r of results) expect(r.creative!.variation!.checks!.status, JSON.stringify(r.creative!.variation!.checks)).not.toBe('failed');
  evidence.generation = { jobId, request: job.request, artwork: job.artwork, planner: job.planner, results: results.map((r, k) => ({ index: r.index, creativeId: r.creative!.id, size: r.creative!.variation!.aspectRatio, canvas: r.creative!.canvas, previewSha256: previews[k], artworkSha256: artworks[k], checks: r.creative!.variation!.checks!.status })) };

  // ---- Test 3: Decompose & Edit the 1:1 variation; the editor ------------------------------------------------------
  await cards.nth(2).getByRole('button', { name: 'Decompose & Edit' }).click();
  await expect(panel.getByRole('heading', { name: 'Here’s what we found' })).toBeVisible({ timeout: 120000 });
  await expect(panel.getByTestId('from-variation')).toContainText('no AI request');
  await panel.getByRole('button', { name: 'Save and choose what to decompose' }).click();
  await panel.getByRole('button', { name: 'Continue to Decomposition' }).click();
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 180000 });
  await panel.getByRole('tab', { name: 'Individual layers' }).click();
  await expect(panel.getByRole('region', { name: 'Individual layers' }).getByRole('article', { name: /^Layer OLED television/ })).toContainText('the variation’s own layer');
  await page.screenshot({ path: `${OUT}/3a-variation-layers.png`, fullPage: true });
  job = await (await request.get(`${API}/${masterId}/variations/${jobId}`)).json() as VariationJob;
  const derivedId = job.results[2].templateId!;
  expect(derivedId).toBeTruthy(); expect(derivedId).not.toBe(masterId);
  const derived = await (await request.get(`${API}/${derivedId}`)).json() as ProductView;
  const methods = derived.product.objects.filter(o => o.cutout).map(o => `${o.kind}:${o.label}=${o.cutout!.method}`);
  // (Each element keeps the variation's own layer: nothing is cut out of the flat picture again.)
  expect(methods.filter(m => !m.endsWith('=layer'))).toEqual([]);
  expect(derived.product.activity).toMatchObject({ aiCalls: 0, costUsd: 0 });
  for (const c of await panel.getByRole('complementary', { name: 'Checks' }).getByRole('checkbox').all()) await c.check();
  await panel.getByRole('button', { name: 'Save master template' }).click();
  await expect(panel.getByRole('heading', { name: 'Your template is saved' })).toBeVisible({ timeout: 60000 });
  await panel.getByRole('button', { name: 'Open in the editor' }).click();
  await expect(panel).toBeHidden({ timeout: 60000 });
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!) as ProjectDocument);
  await expect.poll(async () => (await stored()).variants.some(v => v.productTemplate)).toBe(true);
  const design = (await stored()).variants.filter(v => v.productTemplate).at(-1)!;
  await page.screenshot({ path: `${OUT}/3b-editor.png` });

  // One product moved on its own.
  const tv = design.layers!.find(l => l.type === 'image' && /OLED television/.test(l.name ?? ''))!, othersBefore = design.layers!.filter(l => l.id !== tv.id).map(l => JSON.stringify(l));
  await page.locator('.layer-select', { hasText: 'OLED television' }).first().click();
  const x = Number(await page.getByLabel('X', { exact: true }).inputValue()) + 40;
  await page.getByLabel('X', { exact: true }).fill(String(x));
  await page.getByLabel('X', { exact: true }).press('Enter');
  await expect.poll(async () => Math.round((await stored()).variants.find(v => v.id === design.id)!.layers!.find(l => l.id === tv.id)!.x)).toBe(Math.round(x));
  expect((await stored()).variants.find(v => v.id === design.id)!.layers!.filter(l => l.id !== tv.id).map(l => JSON.stringify(l))).toEqual(othersBefore);
  // A word made longer: the words after it on its line move on (no collision); every other text stays.
  const texts = design.elements.filter((e): e is TextElement => e.type === 'text' && !!e.protectedSlot?.word);
  const word = texts.find(e => /^[A-Za-z]{2,5}$/.test(e.text) && texts.some(n => n.protectedSlot!.word!.lineId === e.protectedSlot!.word!.lineId && n.protectedSlot!.word!.order > e.protectedSlot!.word!.order))!;
  const sameLine = (e: TextElement) => e.protectedSlot!.word!.lineId === word.protectedSlot!.word!.lineId, after = (e: TextElement) => sameLine(e) && e.protectedSlot!.word!.order > word.protectedSlot!.word!.order;
  const next = texts.filter(after).sort((a, b) => a.protectedSlot!.word!.order - b.protectedSlot!.word!.order)[0];
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.locator('.text-elements summary').filter({ hasText: word.text }).first().click();
  await page.getByRole('button', { name: `Select word ${word.text}`, exact: true }).first().click();
  await page.getByLabel('Text content', { exact: true }).fill('EDITEDWORD');
  await page.getByLabel('Text content', { exact: true }).blur();
  await expect.poll(async () => ((await stored()).variants.find(v => v.id === design.id)!.elements.find(e => e.id === word.id) as TextElement).text).toBe('EDITEDWORD');
  const edited = (await stored()).variants.find(v => v.id === design.id)!.elements.filter((e): e is TextElement => e.type === 'text');
  const movedNext = edited.find(e => e.id === next.id)!;
  // The next word moved on by as much as the word grew, measured as the canvas draws (gap to it kept).
  const grow = await page.evaluate(({ before, style }) => {
    const c = document.createElement('canvas').getContext('2d')!; c.font = `${style.fontStyle ?? 'normal'} ${style.fontWeight} ${style.fontSize}px "${style.fontFamily}"`;
    // (As the editor draws: with letter spacing, character by character, each followed by the spacing.)
    const w = (t: string) => (style.letterSpacing ? [...t].reduce((sum, ch) => sum + c.measureText(ch).width + style.letterSpacing, 0) : c.measureText(t).width);
    return w('EDITEDWORD') - w(before);
  }, { before: word.text, style: { fontStyle: word.fontStyle, fontWeight: word.fontWeight, fontSize: word.fontSize, fontFamily: word.fontFamily, letterSpacing: word.letterSpacing } });
  expect(Math.abs(movedNext.x - next.x - grow)).toBeLessThan(2);
  expect(edited.filter(e => !sameLine(e as TextElement) || !(e as TextElement).protectedSlot?.word).map(e => [e.id, e.x, e.y])).toEqual(design.elements.filter(e => e.type === 'text' && (!e.protectedSlot?.word || !sameLine(e))).map(e => [e.id, e.x, e.y]));
  await page.screenshot({ path: `${OUT}/3c-editor-edited.png` });

  // Reloaded: both edits kept (saved in the browser's project).
  await page.reload();
  await expect.poll(async () => { const v = (await stored()).variants.find(d => d.id === design.id); const e = v?.elements.find(el => el.id === word.id); return e && e.type === 'text' ? e.text : ''; }).toBe('EDITEDWORD');
  expect(Math.round((await stored()).variants.find(v => v.id === design.id)!.layers!.find(l => l.id === tv.id)!.x)).toBe(Math.round(x));
  await page.screenshot({ path: `${OUT}/3d-editor-reopened.png` });

  // Exported: the editor's picture at the variation's size; away from what was edited it is the decomposed variation.
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  await (await download).saveAs(`${OUT}/3e-export.png`);
  const meta = await sharp(`${OUT}/3e-export.png`).metadata();
  expect([meta.width, meta.height]).toEqual([design.canvas.width, design.canvas.height]);
  const W = design.canvas.width, H = design.canvas.height;
  const recombined = await sharp(await (await request.get(`/api/layerize-experiment/protected-templates/${derivedId}/files/${derived.product.prepared!.previews.recombined}`)).body()).resize(W, H).removeAlpha().raw().toBuffer();
  const exported = await sharp(`${OUT}/3e-export.png`).removeAlpha().raw().toBuffer();
  const tvBox = { x0: Math.min(tv.x, x) - 4, x1: Math.max(tv.x, x) + tv.width + 4, y0: tv.y - 4, y1: tv.y + tv.height + 4 };
  const line = edited.filter(e => sameLine(e as TextElement)), lineBox = { x0: Math.min(...line.map(e => e.x)) - 20, x1: Math.max(...line.map(e => e.x + e.width)) + 400, y0: Math.min(...line.map(e => e.y)) - 30, y1: Math.max(...line.map(e => e.y + (e as TextElement).fontSize * 1.6)) + 30 };
  let differ = 0, counted = 0;
  for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
    if ([tvBox, lineBox].some(z => xx > z.x0 && xx < z.x1 && y > z.y0 && y < z.y1)) continue;
    const i = (y * W + xx) * 3; counted++;
    if (Math.max(Math.abs(recombined[i] - exported[i]), Math.abs(recombined[i + 1] - exported[i + 1]), Math.abs(recombined[i + 2] - exported[i + 2])) > 48) differ++;
  }
  evidence.editor = { derivedTemplateId: derivedId, designId: design.id, movedLayer: tv.name, editedWord: [word.text, 'EDITEDWORD'], nextWordMovedPx: Math.round(movedNext.x - next.x), canvasGrowPx: Math.round(grow), export: [meta.width, meta.height], exportVsDecomposedDifferPercent: Math.round(10000 * differ / counted) / 100 };
  expect(differ / counted).toBeLessThan(0.03);

  // The master was not changed by generating from it or by editing a variation.
  master = await (await request.get(`${API}/${masterId}`)).json() as ProductView;
  expect({ revisions: JSON.stringify(master.product.revisions), snapshot: await masterSnapshot() }).toEqual(masterBefore);
  evidence.masterUnchanged = true;
  evidence.outgoing = outgoing;
  expect(outgoing).toEqual([]);
  writeFileSync(`${OUT}/evidence.json`, JSON.stringify(evidence, null, 2));
});
