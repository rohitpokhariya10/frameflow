/**
 * Recomposed variations on new artwork, in the browser, on the real LG Ganesh creative (recorded real answer when
 * FRAMEFLOW_PRODUCT_RECORDED=1, else the handmade manifest): Background "New AI artwork" with the OFFLINE test image
 * model (no network; labelled as test artwork), a creative direction and three sizes → every element laid out again →
 * the cards → Send to Decomposition → the existing Run Dashboard → the existing editor → a word edited → export at the
 * landscape size. Also the free "simple backdrop". No paid request is possible here.
 */
import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ProjectDocument } from '@frameflow/shared';
import type { ProductView, VariationJob } from '../../client/src/features/productTemplates/api';
const API = '/api/layerize-experiment/product-templates', OUT = 'test-results/product-v5/generation';
test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` } });
test.setTimeout(240000);
test.use({ actionTimeout: 20000 });

test('Ganesh: new artwork, every element laid out again for 16:9, 9:16 and 1:1 → Run Dashboard → editor → export', async ({ page, request }, info) => {
  test.skip(process.env.FRAMEFLOW_PRODUCT_REFERENCE !== '1' || info.project.name !== 'desktop', 'Real-reference flow only on request.');
  mkdirSync(OUT, { recursive: true });
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => r.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  await panel.getByRole('button', { name: 'New product template' }).click();
  await panel.getByLabel('Creative to upload').setInputFiles({ name: 'Ganesh-Chaturthi.png', mimeType: 'image/png', buffer: readFileSync('Ganesh-Chaturthi.png') });
  await expect(panel.getByText('This picture has 4 creatives')).toBeVisible();
  await panel.getByLabel('Template name').fill('LG Ganesh · new artwork');
  await panel.getByRole('checkbox', { name: /Find characters and products with AI/ }).check();
  const created = page.waitForResponse(r => r.url().endsWith(API) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Upload and find elements' }).click();
  const id = ((await (await created).json()) as ProductView).template.id;
  await expect(panel.getByRole('heading', { name: 'Here’s what we found' })).toBeVisible({ timeout: 120000 });
  if (process.env.FRAMEFLOW_PRODUCT_RECORDED === '1') {
    // The answer put the soundbar's box on the speakers below the TV (nothing of it inside: blocking). The reviewer draws it
    // again where it is, under the screen (by numbers): the soundbar becomes a layer of its own, not part of the TV's.
    await panel.getByRole('region', { name: 'Products', exact: true }).getByRole('button', { name: /^Soundbar/ }).click();
    for (const [k, v] of [['width', 66], ['height', 8], ['x', 290], ['y', 345]] as const) await panel.getByRole('complementary', { name: 'Selected element' }).getByLabel(`Box ${k}`).fill(String(v));
  }
  await panel.getByRole('button', { name: 'Save and choose what to decompose' }).click();
  await expect(panel.getByRole('heading', { name: 'Choose what to decompose' })).toBeVisible();
  await panel.getByRole('button', { name: 'Continue to Decomposition' }).click();
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 120000 });
  for (const c of await panel.getByRole('complementary', { name: 'Checks' }).getByRole('checkbox').all()) await c.check();
  await panel.getByRole('button', { name: 'Save master template' }).click();
  await panel.getByRole('button', { name: 'Use this template' }).click();

  await panel.getByRole('tab', { name: 'Generate with AI' }).click();
  await panel.getByRole('radio', { name: '3', exact: true }).click();
  for (const size of ['Landscape 16:9', 'Story 9:16', 'Square 1:1']) await panel.getByRole('checkbox', { name: size }).click();
  await panel.getByRole('checkbox', { name: 'Original size' }).click(); // the last size can never be unticked, so this goes after
  await panel.getByRole('radio', { name: /New AI artwork/ }).check();
  const recorded = process.env.FRAMEFLOW_PRODUCT_RECORDED === '1';
  // The offline artwork named as what it is: real artwork recorded earlier and replayed, or the test model.
  await expect(panel.getByText(recorded ? /Real gpt-image-2 artwork recorded earlier, replayed/ : /Test image model \(offline, free\)/)).toBeVisible();
  await panel.getByLabel('Creative direction').fill('Golden festive lights over a marble terrace');
  await panel.getByLabel('Headline for the variations').fill('A grand welcome for Bappa brings bigger savings');
  await page.screenshot({ path: `${OUT}/01-form.png`, fullPage: true });
  const started = page.waitForResponse(r => r.url().endsWith(`${API}/${id}/variations`) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Generate 3 variations' }).click();
  const jobId = ((await (await started).json()) as VariationJob).id;
  const cards = panel.getByRole('region', { name: 'Variations' }).getByRole('article');
  await expect(cards).toHaveCount(3, { timeout: 120000 });
  await expect(cards.first().getByText(recorded ? 'Recorded AI artwork (replayed)' : 'Test artwork (offline)')).toBeVisible();
  await page.screenshot({ path: `${OUT}/02-cards.png`, fullPage: true });
  const job = await (await request.get(`${API}/${id}/variations/${jobId}`)).json() as VariationJob;
  expect(job.artwork).toMatchObject({ mode: 'ai', model: recorded ? 'gpt-image-2 (recorded artwork, replayed)' : 'offline-image-model', offline: true, costUsd: 0 });
  expect(job.results.map(r => [r.creative!.canvas.width, r.creative!.canvas.height, r.creative!.layout?.composition?.split('-')[0]])).toEqual([[1077, 606, 'split'], [607, 1079, 'stage'], [607, 606, 'stage']]);
  const file = (f: string) => `/api/layerize-experiment/protected-templates/${id}/files/${f}`;
  for (const r of job.results) {
    expect(r.creative!.variation!.checks!.status, JSON.stringify(r.creative!.variation!.checks)).not.toBe('failed');
    // On the real artwork the stage is found and the products stand on its top surface (no floating), with a shadow under them.
    if (recorded) {
      const stage = r.creative!.layout!.stage!, products = r.creative!.objects.filter(o => o.kind === 'product' && !o.hidden), bottom = Math.max(...products.map(o => o.box.y + o.box.height));
      expect(stage, r.creative!.variation!.aspectRatio).toBeTruthy();
      expect(bottom).toBeGreaterThanOrEqual(stage.cy - stage.b); expect(bottom).toBeLessThanOrEqual(stage.cy + stage.b);
      expect(r.creative!.objects.some(o => o.label === 'Shadow · products')).toBe(true);
    }
    writeFileSync(`${OUT}/03-variation-${r.index}-${r.creative!.variation!.aspectRatio!.replace(':', 'x')}.png`, await (await request.get(file(r.preview!))).body());
  }
  // The landscape one to decomposition: the existing Run Dashboard, then the existing editor.
  const sent = page.waitForResponse(r => r.url().endsWith('/results/0/decomposition') && r.request().method() === 'POST');
  await cards.first().getByRole('button', { name: 'Send to Decomposition' }).click();
  const { runId } = await (await sent).json() as { runId: string };
  await expect(panel.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  const dashboard = panel.getByRole('tabpanel', { name: 'Overview' });
  await expect(dashboard.getByRole('heading', { name: 'Image to editor layers', exact: true })).toBeVisible();
  await expect(dashboard.getByTestId('variation-run-note')).toContainText('16:9');
  await page.screenshot({ path: `${OUT}/04-run-dashboard.png` });
  await dashboard.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(panel).toBeHidden();
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!) as ProjectDocument);
  await expect.poll(async () => (await stored()).variants.some(v => v.importedFrom?.runId === runId)).toBe(true);
  const design = (await stored()).variants.find(v => v.importedFrom?.runId === runId)!;
  expect(design.canvas).toMatchObject({ width: 1077, height: 606 });
  expect(design.elements.map(e => (e.type === 'text' ? e.text : ''))).toEqual(expect.arrayContaining(['brings', 'bigger', 'savings']));
  await page.screenshot({ path: `${OUT}/05-editor.png` });
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.locator('.text-elements summary').filter({ hasText: 'brings' }).first().click();
  await page.getByRole('button', { name: 'Select word bigger', exact: true }).first().click();
  await page.getByLabel('Text content', { exact: true }).fill('huge');
  await page.getByLabel('Text content', { exact: true }).blur();
  await expect.poll(async () => (await stored()).variants.find(v => v.id === design.id)!.elements.some(e => e.type === 'text' && e.text === 'huge')).toBe(true);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  await (await download).saveAs(`${OUT}/06-export.png`);
  expect(await sharp(`${OUT}/06-export.png`).metadata().then(m => [m.width, m.height])).toEqual([1077, 606]);
  // The editor's export is the variation the card showed: the server's preview (made before the word was edited) and the
  // export agree everywhere except around the edited word and the words after it on its line, which close up behind the
  // shorter word (each such word's place before and after the edit; nothing else may move).
  const preview = await sharp(await (await request.get(file(job.results[0].preview!))).body()).resize(1077, 606).removeAlpha().raw().toBuffer();
  const exported = await sharp(`${OUT}/06-export.png`).resize(1077, 606).removeAlpha().raw().toBuffer();
  const edited = design.elements.find(e => e.type === 'text' && e.text === 'bigger')!;
  const afterEdit = (await stored()).variants.find(v => v.id === design.id)!;
  const moved = afterEdit.elements.filter(e => { const b = design.elements.find(d => d.id === e.id); return !!b && (b.x !== e.x || b.y !== e.y); });
  expect(moved.every(e => e.type === 'text' && Math.abs(e.y - edited.y) < 1 && e.x > edited.x)).toBe(true);
  const zones = [edited, ...moved, ...moved.map(e => design.elements.find(d => d.id === e.id)!)].map(e => e.type === 'text' ? { x0: e.x - 40, x1: e.x + Math.max(e.width, 180) + 40, y0: e.y - 40, y1: e.y + 90 } : { x0: 0, x1: 0, y0: 0, y1: 0 });
  let differ = 0, counted = 0;
  for (let y = 0; y < 606; y++) for (let x = 0; x < 1077; x++) {
    if (zones.some(z => x > z.x0 && x < z.x1 && y > z.y0 && y < z.y1)) continue;
    const i = (y * 1077 + x) * 3; counted++;
    // (The server draws the preview's text with its SVG renderer, the editor with the browser's canvas: glyph edges are
    // anti-aliased a little differently. A pixel differs only when nothing within one pixel of it in the export is alike,
    // so a word drawn 2 px or more off its place still counts.)
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) {
      const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= 1077 || Y >= 606) continue; const j = (Y * 1077 + X) * 3;
      if (Math.max(Math.abs(preview[i] - exported[j]), Math.abs(preview[i + 1] - exported[j + 1]), Math.abs(preview[i + 2] - exported[j + 2])) <= 48) near = true;
    }
    if (!near) differ++;
  }
  writeFileSync(`${OUT}/07-preview-vs-export.json`, JSON.stringify({ differPercent: Math.round(10000 * differ / counted) / 100, threshold: 48, tolerance: '1 px' }));
  expect(differ / counted).toBeLessThan(0.03);
  writeFileSync(`${OUT}/evidence.json`, JSON.stringify({ note: 'offline TEST image model (no AI artwork was generated); recomposition, checks, run and editor are real', templateId: id, jobId, runId, artwork: job.artwork,
    variations: job.results.map(r => ({ index: r.index, canvas: r.creative!.canvas, composition: r.creative!.layout?.composition, checks: r.creative!.variation!.checks, prompt: r.creative!.background?.artwork?.prompt })) }, null, 2));
});
