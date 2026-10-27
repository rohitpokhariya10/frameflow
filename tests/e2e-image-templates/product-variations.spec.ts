/**
 * Phase 2 end to end on the real LG Ganesh creative (cropped from Ganesh-Chaturthi.png): saved template → Generate with AI
 * (styles, aspect ratios, a typed headline, a chosen product) → the cards show what was made → Send to Decomposition →
 * the existing run dashboard → Open in editor → a word, a product and the logo edited → export → reload → Saved Runs →
 * reopened with every edit. Detection is the HANDMADE fixture manifest (FRAMEFLOW_PRODUCT_REFERENCE=1), never model output;
 * every provider is a fake and no request leaves the machine.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { ProductCreative, ProjectDocument } from '@frameflow/shared';
import type { ProductView, VariationJob } from '../../client/src/features/productTemplates/api';
const API = '/api/layerize-experiment/product-templates', OUT = 'test-results/product-v4/screens';
test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` } });
test.setTimeout(420000);

async function saveTemplate(page: Page, panel: Locator, request: Page['request']) {
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  await panel.getByRole('button', { name: 'New product template' }).click();
  const sheet = await (await request.get('/__test__/ganesh-sheet.png')).body();
  await panel.getByLabel('Creative to upload').setInputFiles({ name: 'Ganesh.png', mimeType: 'image/png', buffer: sheet });
  await expect(panel.getByText('This picture has 4 creatives')).toBeVisible();
  await panel.getByLabel('Template name').fill('Ganesh variations');
  await panel.getByRole('checkbox', { name: /Find characters and products with AI/ }).check();
  const created = page.waitForResponse(r => r.url().endsWith(API) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Upload and find elements' }).click();
  const id = ((await (await created).json()) as ProductView).template.id;
  await expect(panel.getByRole('heading', { name: 'Here’s what we found' })).toBeVisible({ timeout: 120000 });
  await panel.getByRole('button', { name: 'Save and choose what to decompose' }).click();
  await expect(panel.getByRole('heading', { name: 'Choose what to decompose' })).toBeVisible();
  await panel.getByRole('button', { name: 'Continue to Decomposition' }).click();
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 120000 });
  for (const c of await panel.getByRole('complementary', { name: 'Checks' }).getByRole('checkbox').all()) await c.check();
  await panel.getByRole('button', { name: 'Save master template' }).click();
  await panel.getByRole('button', { name: 'Use this template' }).click();
  return id;
}

test('Ganesh: Generate with AI → selected variation → Decomposition Layers → editor (edit, export, reopen)', async ({ page, request }) => {
  mkdirSync(OUT, { recursive: true });
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => r.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  const id = await saveTemplate(page, panel, request);
  const view = await (await request.get(`${API}/${id}`)).json() as ProductView;
  const file = (f: string) => `/api/layerize-experiment/protected-templates/${id}/files/${f}`;
  writeFileSync(`${OUT}/00-original.png`, await (await request.get(file(view.template.source.inputFile))).body());
  for (const [name, f] of [['01-clean', view.product.prepared!.clean.file], ['02-background', view.product.prepared!.base.file], ['03-reconstructed', view.product.prepared!.previews.recombined]] as const) writeFileSync(`${OUT}/${name}.png`, await (await request.get(file(f))).body());

  // Generate with AI: three styles, three sizes, a typed headline, a new product in one slot.
  await panel.getByRole('tab', { name: 'Generate with AI' }).click();
  await expect(panel.getByRole('heading', { name: 'What should the variations look like?' })).toBeVisible();
  await panel.getByRole('radio', { name: '3', exact: true }).click();
  await panel.getByRole('checkbox', { name: 'Story 9:16' }).click();
  await panel.getByRole('checkbox', { name: 'Landscape 16:9' }).click();
  await panel.getByLabel('Headline for the variations').fill('A grand welcome for Bappa brings bigger savings');
  const packshot = await (await request.get('/__test__/product-packshot.png')).body();
  await panel.getByLabel('Add a product picture').setInputFiles({ name: 'Blue speaker.png', mimeType: 'image/png', buffer: packshot });
  await expect(panel.getByText('Blue speaker added.')).toBeVisible();
  const firstSlot = panel.getByRole('combobox', { name: /^Product for / }).first();
  await firstSlot.selectOption({ label: 'Blue speaker' });
  const slotName = (await firstSlot.getAttribute('aria-label'))!.replace('Product for ', '');
  await page.screenshot({ path: `${OUT}/10-generate-form.png`, fullPage: true });
  const started = page.waitForResponse(r => r.url().endsWith(`${API}/${id}/variations`) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Generate 3 variations' }).click();
  const jobId = ((await (await started).json()) as VariationJob).id;
  const cards = panel.getByRole('region', { name: 'Variations' }).getByRole('article');
  await expect(cards).toHaveCount(3, { timeout: 120000 });
  await expect(panel.getByRole('img', { name: /Preview of / })).toHaveCount(3);
  await page.screenshot({ path: `${OUT}/11-variation-cards.png`, fullPage: true });
  // The form and the cards fit a phone-sized window (no sideways scrolling).
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${OUT}/11b-variation-cards-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });

  // What the cards say is what was made.
  const job = await (await request.get(`${API}/${id}/variations/${jobId}`)).json() as VariationJob;
  expect(job.results.map(r => [r.creative!.variation!.aspectRatio, r.creative!.canvas.width, r.creative!.canvas.height])).toEqual([['original', 607, 606], ['9:16', 607, 1079], ['16:9', 1077, 606]]);
  for (const r of job.results) {
    const c = r.creative!, headline = c.groups.find(g => g.category === 'headline')!;
    expect(c.texts.filter(t => t.groupId === headline.id).sort((a, b) => a.line - b.line || a.x - b.x).map(t => t.text).join(' ')).toBe('A grand welcome for Bappa brings bigger savings');
    expect(c.objects.find(o => o.label === 'Blue speaker'), `${r.plan!.title}: the chosen product`).toBeTruthy();
    expect(c.variation!.checks!.status).not.toBe('failed');
    writeFileSync(`${OUT}/12-variation-${r.index}-${c.variation!.aspectRatio!.replace(':', 'x')}.png`, await (await request.get(file(r.preview!))).body());
    if (c.background) writeFileSync(`${OUT}/12-variation-${r.index}-background.png`, await (await request.get(file(c.background.file))).body());
  }
  // Inspect one card, then send the 9:16 one to decomposition.
  const tall = cards.nth(1);
  await tall.getByRole('button', { name: /^Inspect / }).click();
  await page.screenshot({ path: `${OUT}/13-inspect-selected.png` });
  const sent = page.waitForResponse(r => r.url().endsWith('/results/1/decomposition') && r.request().method() === 'POST');
  await tall.getByRole('button', { name: 'Send to Decomposition' }).click();
  const { runId, creativeId } = await (await sent).json() as { runId: string; creativeId: string };
  // The existing Decomposition Run Dashboard (the workspace's Overview tab), not a note in the variations panel.
  await expect(panel.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('tab', { name: 'Offer Templates', exact: true })).toHaveAttribute('aria-selected', 'false');
  await expect(panel.getByRole('region', { name: 'Variations' })).toHaveCount(0);
  const dashboard = panel.getByRole('tabpanel', { name: 'Overview' });
  await expect(dashboard.getByRole('heading', { name: 'Image to editor layers', exact: true })).toBeVisible();
  await expect(dashboard.getByText('Decomposition result · Saved creative · no AI')).toBeVisible();
  await expect(dashboard.getByTestId('variation-run-note')).toContainText('9:16');
  await expect(dashboard.getByRole('region', { name: 'Final editor layers' })).toBeVisible();
  await expect(dashboard.getByRole('region', { name: 'Final editor layers' }).getByText('A grand welcome for Bappa brings bigger savings')).toBeVisible();
  await expect(dashboard.getByRole('region', { name: 'Pipeline' })).toBeVisible();
  await dashboard.getByRole('heading', { name: 'Image to editor layers', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/14-run-dashboard.png` });
  await dashboard.getByRole('region', { name: 'Final editor layers' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/14b-run-dashboard-layers.png` });
  const run = await (await request.get(`/api/layerize-experiment/runs/${runId}`)).json();
  expect(run.canvas).toEqual({ width: 607, height: 1079 });
  expect(run.creative.provenance).toMatchObject({ cost: { usd: 0, providerRequests: 0, segmentation: 'reused' }, variation: { jobId, index: 1, aspectRatio: '9:16' } });
  const creative = await (await request.get(`${API}/${id}/creatives/${creativeId}`)).json() as ProductCreative;
  expect(run.creative.texts.map((t: { id: string; text: string; x: number; baselineY: number }) => [t.id, t.text, t.x, t.baselineY])).toEqual(creative.texts.filter(t => t.text.trim()).map(t => [t.id, t.text, t.x, t.baselineY]));
  expect(run.creative.layers.filter((l: { kind: string }) => l.kind === 'object')).toHaveLength(creative.objects.filter(o => !o.hidden).length);
  const calls = await (await request.get('/__test__/product-calls')).json();

  // Open in editor, from the run dashboard: the variation's own canvas, every word native text, every logo and object its own picture.
  await dashboard.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(panel).toBeHidden();
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!) as ProjectDocument);
  await expect.poll(async () => (await stored()).variants.some(v => v.productTemplate && v.importedFrom?.runId === runId)).toBe(true);
  const before = (await stored()).variants.find(v => v.importedFrom?.runId === runId)!;
  expect(before.canvas).toMatchObject({ width: 607, height: 1079 });
  expect(before.elements.every(w => w.type === 'text')).toBe(true);
  expect(before.elements.map(w => w.type === 'text' ? w.text : '')).toEqual(expect.arrayContaining(['brings', 'bigger', 'savings']));
  expect(before.layers!.filter(l => l.type === 'image' && l.role === 'logo').length).toBe(creative.images.filter(i => !i.hidden).length);
  await page.screenshot({ path: `${OUT}/15-editor-opened.png` });
  // One word moved, then changed: the words after it on its line keep their spacing to it (a shorter word closes up, a
  // longer one never runs into the next); everything else stays where it was.
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.locator('.text-elements summary').filter({ hasText: 'brings bigger' }).click();
  await page.getByRole('button', { name: 'Select word bigger', exact: true }).first().click();
  const bigger = before.elements.find(w => w.type === 'text' && w.text === 'bigger')!;
  await page.getByLabel('X', { exact: true }).fill(String(bigger.x + 30));
  await page.getByLabel('X', { exact: true }).press('Enter');
  await page.getByLabel('Text content', { exact: true }).fill('huge');
  await page.getByLabel('Text content', { exact: true }).blur();
  await expect.poll(async () => (await stored()).variants.find(v => v.id === before.id)!.elements.find(w => w.id === bigger.id)!.text).toBe('huge');
  let after = (await stored()).variants.find(v => v.id === before.id)!;
  expect(after.elements.find(w => w.id === bigger.id)!.x).toBeCloseTo(bigger.x + 30, 1);
  const slot = bigger.type === 'text' ? bigger.protectedSlot?.word : undefined;
  const following = before.elements.filter(w => w.type === 'text' && w.id !== bigger.id && slot && w.protectedSlot?.word?.groupId === slot.groupId && w.protectedSlot.word.lineId === slot.lineId && w.protectedSlot.word.order > slot.order).map(w => w.id);
  expect(following.length).toBeGreaterThan(0);
  expect(after.elements.filter(w => w.id !== bigger.id && !following.includes(w.id))).toEqual(before.elements.filter(w => w.id !== bigger.id && !following.includes(w.id)));
  const style = bigger.type === 'text' ? { fontFamily: bigger.fontFamily, fontSize: bigger.fontSize, fontWeight: bigger.fontWeight, fontStyle: bigger.fontStyle ?? 'normal' as const, letterSpacing: bigger.letterSpacing } : undefined;
  // (By how much narrower "huge" is drawn than "bigger", measured as the editor's canvas draws them: the editor measures
  // the edited word so; an estimate was off by 4 px here.)
  const shrink = await page.evaluate(({ a, b, s }) => {
    const c = document.createElement('canvas').getContext('2d')!; c.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize}px "${s.fontFamily}"`;
    const w = (t: string) => (s.letterSpacing ? [...t].reduce((sum, ch) => sum + c.measureText(ch).width + s.letterSpacing, 0) : c.measureText(t).width);
    return w(a) - w(b);
  }, { a: 'bigger', b: 'huge', s: style! });
  expect(shrink).toBeGreaterThan(0);
  for (const id of following) expect(Math.abs(after.elements.find(w => w.id === id)!.x - (before.elements.find(w => w.id === id)!.x - shrink))).toBeLessThan(1);
  // The chosen product and the LG logo moved.
  const product = before.layers!.find(l => l.name === 'Blue speaker')!, logo = before.layers!.find(l => l.name === 'LG logo')!;
  for (const [layer, dx] of [[product, 24], [logo, -12]] as const) {
    await page.locator('.layer-select', { hasText: layer.name }).first().click();
    await page.getByLabel('X', { exact: true }).fill(String(layer.x + dx));
    await page.getByLabel('X', { exact: true }).blur();
    await expect.poll(async () => (await stored()).variants.find(v => v.id === before.id)!.layers!.find(l => l.id === layer.id)!.x).toBe(layer.x + dx);
  }
  after = (await stored()).variants.find(v => v.id === before.id)!;
  await page.screenshot({ path: `${OUT}/16-editor-edited.png` });
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const exported = await download; await exported.saveAs(`${OUT}/17-export.png`);
  const meta = await sharp(`${OUT}/17-export.png`).metadata();
  expect([meta.width, meta.height]).toEqual([607, 1079]);
  // Reload, reopen the same run from Saved Runs: the edits are there.
  await page.reload();
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await panel.getByRole('tab', { name: 'Saved Runs', exact: true }).click();
  await panel.getByRole('article', { name: `Saved run ${runId}`, exact: true }).getByRole('button', { name: /View run/ }).click();
  await expect(panel.getByTestId('variation-run-note')).toBeVisible();
  await panel.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(panel).toBeHidden();
  const reopened = (await stored()).variants.find(v => v.id === before.id)!;
  expect(reopened.elements).toEqual(after.elements);
  expect(reopened.layers!.find(l => l.id === product.id)!.x).toBe(product.x + 24);
  expect(reopened.layers!.find(l => l.id === logo.id)!.x).toBe(logo.x - 12);
  await page.screenshot({ path: `${OUT}/18-reopened.png` });
  writeFileSync('test-results/product-v4/variation-evidence.json', JSON.stringify({ fixture: 'handmade Ganesh manifest (not AI output); offline style planner; fake providers', templateId: id, jobId, runId, creativeId,
    variations: job.results.map(r => ({ index: r.index, title: r.plan!.title, kind: r.plan!.kind, aspectRatio: r.creative!.variation!.aspectRatio, canvas: r.creative!.canvas, checks: r.creative!.variation!.checks, background: r.creative!.background })),
    chosenProductSlot: slotName, providerCallsAfterDecomposition: calls, run: { canvas: run.canvas, provenance: run.creative.provenance, layers: run.creative.layers.length },
    editor: { canvas: before.canvas, words: before.elements.length, edited: { before: bigger, after: after.elements.find(w => w.id === bigger.id) }, neighboursUnchanged: true, productMoved: [product.x, product.x + 24], logoMoved: [logo.x, logo.x - 12] },
    export: [meta.width, meta.height], reopenedWithEdits: true }, null, 2));
});
