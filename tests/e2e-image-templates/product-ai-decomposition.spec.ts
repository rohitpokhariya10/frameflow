import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { ProjectDocument, TextElement } from '@frameflow/shared';
import type { ProductView } from '../../client/src/features/productTemplates/api';

/**
 * The AI decomposition choice in the browser (offline fixture server; its AI decomposer is the OFFLINE STAND-IN of
 * aiDecompose.ts — no OpenAI, no Seedream — and every screen says so): Choose what to decompose → Decompose with AI →
 * Inspect (made with the AI route, its instructions shown) → Save master template → Open in the editor: every word of
 * the text an editable text of its own at its place, every bank logo a picture layer of its own, the decomposed elements
 * pictures of their own — no text or logo in the background picture.
 */
test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` }, actionTimeout: 30000 });
test.describe.configure({ timeout: 300000 });
const API = '/api/layerize-experiment/product-templates', OUT = 'test-results/product-v15/ai-decomposition';

test('Decompose with AI (offline stand-in): text and logos stay out, and come back as editable layers in the editor', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop' || process.env.FRAMEFLOW_PRODUCT_LAYERIZE === 'off', 'One run; needs the offline AI stand-in.');
  mkdirSync(OUT, { recursive: true });
  const outgoing: string[] = [];
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => { outgoing.push(r.request().url()); return r.abort(); });
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  await panel.getByRole('button', { name: 'New product template' }).click();
  await panel.getByLabel('Creative to upload').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: await (await request.get('/__test__/product-poster.png')).body() });
  await panel.getByLabel('Template name').fill(`AI decomposition ${Date.now()}`);
  await panel.getByRole('checkbox', { name: /Find characters and products with AI/ }).check();
  const created = page.waitForResponse(r => r.url().endsWith(API) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Upload and find elements' }).click();
  const id = ((await (await created).json()) as ProductView).template.id;
  await expect(panel.getByRole('heading', { name: 'Here’s what we found' })).toBeVisible({ timeout: 60000 });
  await panel.getByRole('button', { name: 'Save and choose what to decompose' }).click();
  await expect(panel.getByRole('heading', { name: 'Choose what to decompose' })).toBeVisible();
  const ai = panel.getByRole('region', { name: 'Decompose with AI' });
  await expect(ai).toContainText('offline stand-in');
  // The decomposition on this computer stays offered, free (a plain button once the AI choice is shown).
  await expect(panel.getByRole('button', { name: 'Continue to Decomposition on this computer (free)' })).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.screenshot({ path: `${OUT}/1-choose.png` });
  const before = await (await request.get(`${API}/${id}`)).json() as ProductView;
  await ai.getByRole('button', { name: /Decompose with AI/ }).click();
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 120000 });
  const view = await (await request.get(`${API}/${id}`)).json() as ProductView;
  expect(view.product.prepared!.separation).toMatchObject({ method: 'seedream', ai: { offline: true, unmatched: [] } });
  expect(view.product.objects.filter(o => o.cutout).every(o => o.cutout!.method === 'seedream')).toBe(true);
  const details = panel.getByRole('region', { name: 'AI decomposition' });
  await expect(details).toContainText('offline stand-in');
  await details.getByText('The planner’s instructions').click();
  await expect(details).toContainText('front to back');
  await page.screenshot({ path: `${OUT}/2-inspect.png`, fullPage: true });
  // The words and logos as they were: not changed by the decomposition.
  expect(view.texts.flatMap(t => t.wordList ?? []).map(w => [w.id, w.text, w.box])).toEqual(before.texts.flatMap(t => t.wordList ?? []).map(w => [w.id, w.text, w.box]));
  expect(view.logos.map(l => [l.id, l.box, l.file])).toEqual(before.logos.map(l => [l.id, l.box, l.file]));
  for (const c of await panel.getByRole('complementary', { name: 'Checks' }).getByRole('checkbox').all()) await c.check();
  const blocking = view.product.prepared!.quality.issues.filter(i => i.blocking);
  if (blocking.length) { await panel.getByRole('button', { name: 'Save as a draft with these warnings…' }).click(); await panel.getByRole('button', { name: 'Yes, save as a draft' }).click(); }
  else await panel.getByRole('button', { name: 'Save master template' }).click();
  await expect(panel.getByRole('heading', { name: 'Your template is saved' })).toBeVisible({ timeout: 60000 });
  // The master reused: a new creative of it, sent to the Decomposition Layers run, opened in the editor.
  await panel.getByRole('button', { name: 'Use this template' }).click();
  await panel.getByRole('button', { name: 'New creative' }).click();
  const sent = page.waitForResponse(r => r.url().endsWith('/open') && r.request().method() === 'POST', { timeout: 120000 });
  await panel.getByRole('button', { name: 'Send to Decomposition', exact: true }).click();
  const { runId } = await (await sent).json() as { runId: string };
  await expect(panel.getByRole('heading', { name: 'Image to editor layers', exact: true })).toBeVisible({ timeout: 60000 });
  await panel.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(panel).toBeHidden({ timeout: 60000 });

  // The editor: every word its own editable text at its place; every bank logo its own picture layer; the products and
  // the mascot their own pictures.
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!) as ProjectDocument);
  await expect.poll(async () => (await stored()).variants.some(v => v.importedFrom?.runId === runId), { timeout: 60000 }).toBe(true);
  const design = (await stored()).variants.find(v => v.importedFrom?.runId === runId)!;
  const words = view.texts.flatMap(t => (t.wordList ?? []).filter(w => !w.removed)), texts = design.elements.filter((e): e is TextElement => e.type === 'text');
  expect(texts.map(t => t.text).sort()).toEqual(words.map(w => w.text).sort());
  for (const w of words) { const t = texts.find(x => x.protectedSlot?.word?.id === w.id)!; expect(t, w.text).toBeTruthy(); expect(Math.abs(t.x - w.box.x)).toBeLessThan(w.box.height); }
  const images = design.layers!.filter(l => l.type === 'image'), names = images.map(l => l.name ?? '');
  for (const l of view.logos.filter(x => !x.removed && !x.inBackground)) expect(names, l.label).toContain(l.label);
  for (const o of view.product.objects.filter(x => x.cutout)) expect(names, o.label).toContain(o.label);
  await page.screenshot({ path: `${OUT}/3-editor.png` });
  expect((await (await request.get('/__test__/product-calls')).json()).layerizer).toBeGreaterThanOrEqual(1);
  expect(outgoing).toEqual([]);
});
