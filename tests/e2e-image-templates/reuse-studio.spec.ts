import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { reuseCanvasFor, type ProductCreative, type ProjectDocument, type ReuseDraft } from '@frameflow/shared';
import type { ProductView, ReusePreview } from '../../client/src/features/productTemplates/api';

const API = '/api/layerize-experiment/product-templates', OUT = 'test-results/reuse-studio', NAME = 'LG reuse studio proof';
test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` }, actionTimeout: 30000 });
test.setTimeout(600000);

/** "The person's" product pictures: drawn here, transparent PNGs (no provider). */
const productPng = (kind: 'television' | 'washer' | 'dishwasher') => sharp(Buffer.from(kind === 'television'
  ? '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect x="20" y="10" width="600" height="350" rx="10" fill="#111827"/><rect x="40" y="28" width="560" height="314" fill="#2563eb"/><circle cx="320" cy="185" r="90" fill="#f59e0b"/><rect x="260" y="360" width="120" height="40" fill="#374151"/><rect x="190" y="396" width="260" height="16" rx="6" fill="#1f2937"/></svg>'
  : kind === 'washer'
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="520"><rect x="10" y="10" width="380" height="500" rx="18" fill="#e5e7eb" stroke="#9ca3af" stroke-width="6"/><rect x="10" y="10" width="380" height="80" rx="18" fill="#d1d5db"/><circle cx="200" cy="300" r="140" fill="#6b7280"/><circle cx="200" cy="300" r="100" fill="#1e3a8a"/></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="560"><rect x="10" y="10" width="400" height="540" rx="10" fill="#9ca3af" stroke="#4b5563" stroke-width="6"/><rect x="10" y="10" width="400" height="70" fill="#6b7280"/><rect x="60" y="120" width="300" height="12" rx="6" fill="#e5e7eb"/></svg>')).png().toBuffer();

async function openPanel(page: Page) {
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => r.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  return panel;
}
/** The LG reference as a saved master template (handmade detection manifest, local preparation). */
async function savedMaster(page: Page, request: APIRequestContext) {
  const panel = await openPanel(page);
  await panel.getByRole('button', { name: 'New product template' }).click();
  await panel.getByLabel('Creative to upload').setInputFiles({ name: 'Ganesh.png', mimeType: 'image/png', buffer: await (await request.get('/__test__/ganesh-sheet.png')).body() });
  await expect(panel.getByText('This picture has 4 creatives')).toBeVisible();
  await panel.getByLabel('Template name').fill(NAME);
  await panel.getByRole('checkbox', { name: /Find characters and products with AI/ }).check();
  const created = page.waitForResponse(r => r.url().endsWith(API) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Upload and find elements' }).click();
  const id = ((await (await created).json()) as ProductView).template.id;
  await expect(panel.getByRole('heading', { name: 'Here’s what we found' })).toBeVisible({ timeout: 120000 });
  await panel.getByRole('button', { name: 'Save and choose what to decompose' }).click();
  await panel.getByRole('button', { name: 'Continue to Decomposition on this computer (free)' }).click();
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 120000 });
  for (const c of await panel.getByRole('complementary', { name: 'Checks' }).getByRole('checkbox').all()) await c.check();
  await panel.getByRole('button', { name: 'Save master template', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Use this template' })).toBeVisible();
  return id;
}
async function openReuse(page: Page, id: string) {
  const panel = await openPanel(page);
  const card = panel.getByRole('article', { name: `Product template ${NAME}` }).filter({ has: page.locator(`img[src*="${id}"]`) });
  await card.getByRole('button', { name: 'Reuse Template' }).click();
  return panel;
}

test('Reuse Template: choose, replace, add and remove products, AI placement, 4 formats, save, reopen, Seedream and the editor (offline providers)', async ({ page, request }) => {
  test.skip(process.env.FRAMEFLOW_PRODUCT_REFERENCE !== '1' || process.env.FRAMEFLOW_PRODUCT_REUSE_PROOF !== '1', 'Uses the real LG reference with a handmade detection manifest.');
  mkdirSync(OUT, { recursive: true });
  const id = await savedMaster(page, request);
  const masterBefore = await (await request.get(`${API}/${id}/revisions/1`)).text(), masterCanvas = JSON.parse(masterBefore).canvas as { width: number; height: number };
  const wide = reuseCanvasFor(masterCanvas, '16:9');
  // 1–3. Product Templates → Reuse Template → the reviewed objects load (no new detection).
  let panel = await openReuse(page, id);
  // The simple flow opens first; the detailed studio is one click away.
  await expect(panel.getByRole('heading', { name: 'Create Your Offer Creative' })).toBeVisible();
  await panel.getByRole('button', { name: 'All creatives from this template' }).click();
  await panel.getByRole('button', { name: 'Start a detailed reuse' }).click();
  const list = panel.getByRole('list', { name: 'Product list' });
  await expect(list.getByRole('listitem')).toHaveCount(8);
  await expect(panel.getByTestId('creative-preview')).toBeVisible();
  const draftId = (await (await request.get(`${API}/${id}/reuse`)).json()).drafts[0].id as string;
  const draft = async () => (await (await request.get(`${API}/${id}/reuse/${draftId}`)).json()).draft as ReuseDraft;
  const row = (name: string) => list.getByRole('listitem', { name: `Product ${name}`, exact: true });
  // 4–5. Deselect several products; Ganesh stays.
  await panel.getByRole('button', { name: 'Deselect all' }).click();
  await expect.poll(async () => (await draft()).items.filter(i => i.kind === 'product' && i.included).length).toBe(0);
  for (const name of ['OLED TV with sound system', 'Washing machine', 'Refrigerator', 'Microwave']) await row(name).getByRole('checkbox').check();
  await expect.poll(async () => (await draft()).items.filter(i => i.kind === 'product' && i.included).length).toBe(4);
  // 6–7. Replace the television and the washing machine with "the person's" pictures.
  await row('OLED TV with sound system').getByLabel(/with a picture/).setInputFiles({ name: 'my-television.png', mimeType: 'image/png', buffer: await productPng('television') });
  await expect.poll(async () => (await draft()).items.find(i => /OLED TV/i.test(i.original?.label ?? ''))?.asset.kind).toBe('upload');
  await row('Washing machine').getByLabel(/with a picture/).setInputFiles({ name: 'my-washer.png', mimeType: 'image/png', buffer: await productPng('washer') });
  await expect.poll(async () => (await draft()).items.find(i => /washing machine/i.test(i.original?.label ?? ''))?.asset.kind).toBe('upload');
  // 8. A new dishwasher that was not in the template (its own slot does not exist).
  await panel.getByLabel('New product name').fill('Dishwasher');
  await panel.getByLabel('Add a product picture').setInputFiles({ name: 'my-dishwasher.png', mimeType: 'image/png', buffer: await productPng('dishwasher') });
  await expect.poll(async () => (await draft()).items.filter(i => !i.objectId && i.kind === 'product').map(i => i.label)).toEqual(['Dishwasher']);
  // 9. Remove another existing product (the microwave): out of this draft, restorable.
  await row('Microwave').getByRole('button', { name: 'Remove Microwave' }).click();
  await expect(panel.getByRole('region', { name: 'Removed products' })).toContainText(/microwave/i);
  // 10. No removed or deselected product is drawn: exactly the chosen four.
  let d = await draft();
  const preview = async (ratio: string) => (await (await request.get(`${API}/${id}/reuse/${draftId}/preview?ratio=${ratio}`)).json()) as ReusePreview;
  const chosen = d.items.filter(i => i.kind === 'product' && i.included && !i.removed).map(i => i.id).sort();
  expect(chosen).toHaveLength(4);
  const original = await preview('original');
  expect(original.creative.objects.filter(o => o.kind === 'product').map(o => o.id).sort()).toEqual(chosen);
  expect(original.creative.objects.some(o => /microwave/i.test(o.label))).toBe(false);
  expect(original.creative.objects.find(o => o.kind === 'character')!.asset.kind).toBe('template');
  // Formats: 3:9, 4:9 and 16:9 as well as the original.
  for (const f of ['Portrait 3:9', 'Portrait 4:9', 'Landscape 16:9']) await panel.getByRole('checkbox', { name: `Format ${f}` }).check();
  await expect.poll(async () => (await draft()).ratios).toEqual(['original', '3:9', '4:9', '16:9']);
  // 11. AI Smart Placement with the mocked planner: one approval, one request per format, every box checked.
  await panel.getByRole('button', { name: 'Arrange with AI…' }).click();
  const confirm = panel.getByRole('group', { name: 'Confirm AI placement' });
  await expect(confirm).toContainText('test placement planner'); await expect(confirm).toContainText('$0.32');
  expect((await (await request.get('/__test__/placement-calls')).json()).calls).toHaveLength(0);
  await confirm.getByRole('button', { name: 'Yes, spend $0.32' }).click();
  await expect(panel.getByRole('radio', { name: /AI Smart Placement/ })).toBeChecked({ timeout: 60000 });
  const calls = (await (await request.get('/__test__/placement-calls')).json()).calls as { format: string; products: string[]; imageBytes: number }[];
  expect(calls.map(c => c.format)).toEqual(['original', '3:9', '4:9', '16:9']);
  expect(calls.every(c => c.products.slice().sort().join() === chosen.join() && c.imageBytes > 1000)).toBe(true);
  d = await draft();
  expect(d.placement.mode).toBe('ai'); expect(d.ai.requests).toBe(4); expect(d.ai.costUsd).toBeCloseTo(0.32, 6);
  // The deliberately bad box (over the headline) was refused and replaced by the rule's box.
  expect(Object.values(d.ai.plans).every(p => p!.rejected.length === 1), JSON.stringify(Object.values(d.ai.plans).map(p => [p!.ratio, p!.rejected]))).toBe(true);
  // 12. Placed naturally: on the stage, inside the canvas, clear of text and logos, the hero enlarged.
  for (const r of ['original', '3x9', '4x9', '16x9']) {
    const p = await preview(r);
    expect(p.mode).toBe('ai');
    expect(p.checks.issues.filter(i => i.blocking), r).toEqual([]);
    for (const o of p.creative.objects.filter(x => x.kind === 'product')) {
      expect(o.box.x).toBeGreaterThanOrEqual(0); expect(o.box.y).toBeGreaterThanOrEqual(0);
      expect(o.box.x + o.box.width).toBeLessThanOrEqual(p.creative.canvas.width); expect(o.box.y + o.box.height).toBeLessThanOrEqual(p.creative.canvas.height);
    }
  }
  // 13. Headline edited (the person's own words).
  const headline = panel.getByLabel('headline text');
  await headline.fill('Golden days call for golden deals');
  await panel.getByRole('button', { name: 'Apply text' }).click();
  await expect.poll(async () => (await draft()).texts && Object.values((await draft()).texts).some(t => t.text === 'Golden days call for golden deals')).toBe(true);
  await page.screenshot({ path: `${OUT}/01-studio.png`, fullPage: true });
  // 14–17. Generate: four complete posters (background, Ganesh, decorations, chosen products, text, logos).
  await panel.getByRole('button', { name: 'Generate Reused Creative' }).click();
  const results = panel.getByRole('region', { name: 'Reused creatives' });
  for (const f of ['Original size', 'Portrait 3:9', 'Portrait 4:9', 'Landscape 16:9']) await expect(results.getByRole('img', { name: `${f} creative` })).toBeVisible({ timeout: 120000 });
  d = await draft();
  const sizes: Record<string, [number, number]> = { original: [4096, 4096], '3:9': [1365, 4096], '4:9': [1820, 4096], '16:9': [4096, 2304] };
  for (const [ratio, o] of Object.entries(d.outputs)) {
    expect(o!.checks.status, `${ratio}: ${JSON.stringify(o!.checks.issues)}`).not.toBe('failed');
    const png = await (await request.get(`/api/layerize-experiment/protected-templates/${id}/files/${o!.preview}`)).body();
    writeFileSync(`${OUT}/02-${ratio.replace(':', 'x')}.png`, png);
    const meta = await sharp(png).metadata(), [w, h] = sizes[ratio];
    expect(Math.abs(meta.width! / meta.height! - w / h)).toBeLessThan(0.01);
    // A complete poster, not a product cut-out: most of it is opaque artwork.
    const stats = await sharp(png).stats(); expect(stats.channels[3]?.mean ?? 255).toBeGreaterThan(250);
  }
  await results.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/03-results.png`, fullPage: true });
  // 18. Save every format as a creative of the template; the master revision is untouched.
  await results.getByRole('button', { name: 'Save reused creatives' }).click();
  await expect(results.getByText('Saved', { exact: true })).toHaveCount(4, { timeout: 60000 });
  d = await draft();
  const creatives = (await (await request.get(`${API}/${id}/creatives`)).json()).creatives as { id: string; origin: { kind: string; draftId?: string } }[];
  expect(creatives.filter(c => c.origin.kind === 'reuse' && c.origin.draftId === draftId)).toHaveLength(4);
  const landscape = await (await request.get(`${API}/${id}/creatives/${d.outputs['16:9']!.creativeId}`)).json() as ProductCreative;
  expect(landscape.canvas).toEqual(wide);
  expect(landscape.objects.filter(o => o.kind === 'product')).toHaveLength(4);
  expect(landscape.objects.filter(o => o.kind === 'product' && o.asset.kind === 'upload').every(o => o.asset.file.startsWith(`pca-${landscape.id.slice(3)}-`))).toBe(true);
  expect(landscape.texts.some(t => t.text === 'Golden')).toBe(true);
  expect(await (await request.get(`${API}/${id}/revisions/1`)).text()).toBe(masterBefore);
  // 19. Reopen: a fresh page, the draft from the library, every choice kept.
  panel = await openReuse(page, id);
  await panel.getByRole('button', { name: 'All creatives from this template' }).click();
  await panel.getByRole('article', { name: /Reuse draft/ }).first().getByRole('button', { name: 'Continue editing' }).click();
  await expect(panel.getByRole('list', { name: 'Product list' }).getByRole('listitem')).toHaveCount(8);
  await expect(panel.getByRole('region', { name: 'Removed products' })).toContainText(/microwave/i);
  await expect(panel.getByLabel('headline text')).toHaveValue('Golden days call for golden deals');
  for (const f of ['Portrait 3:9', 'Portrait 4:9', 'Landscape 16:9']) await expect(panel.getByRole('checkbox', { name: `Format ${f}` })).toBeChecked();
  await expect(panel.getByRole('radio', { name: /AI Smart Placement/ })).toBeChecked();
  const reopened = panel.getByRole('region', { name: 'Reused creatives' });
  await expect(reopened.getByText('Saved', { exact: true })).toHaveCount(4);
  await page.screenshot({ path: `${OUT}/04-reopened.png`, fullPage: true });
  // 390 px: the studio stacks into one column without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${OUT}/04b-studio-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  // 20–21. Decompose & Edit the landscape creative: review, then a SEPARATE approval of OpenAI + Seedream (mock transport).
  const submissions = (await (await request.get('/__test__/product-calls')).json()).submissions.length;
  const handoff = page.waitForResponse(r => r.url().endsWith('/outputs/16x9/decomposition') && r.request().method() === 'POST');
  await reopened.getByRole('article', { name: 'Creative Landscape 16:9' }).getByRole('button', { name: 'Decompose & Edit' }).click();
  const { templateId } = await (await handoff).json() as { templateId: string };
  await expect(panel.getByRole('heading', { name: 'Here’s what we found' })).toBeVisible({ timeout: 120000 });
  await panel.getByRole('button', { name: 'Save and choose what to decompose' }).click();
  expect((await (await request.get('/__test__/product-calls')).json()).submissions).toHaveLength(submissions);
  await panel.getByRole('button', { name: /Decompose with AI…/ }).click();
  await expect(panel.getByRole('group', { name: 'Confirm the cost' })).toBeVisible();
  const sent = page.waitForRequest(r => r.url().endsWith(`/${templateId}/prepare`) && r.method() === 'POST');
  await panel.getByRole('button', { name: 'Yes, decompose with AI', exact: true }).click();
  const approved = (await sent).postDataJSON();
  expect(approved.engine).toBe('ai'); expect(approved.approveUsd).toBeGreaterThan(0);
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 120000 });
  const calls2 = await (await request.get('/__test__/product-calls')).json();
  expect(calls2.submissions).toHaveLength(submissions + 1);
  const input = calls2.decompositionInputs.at(-1);
  // The creative's own 16:9 picture (the existing route may enlarge a small picture to the provider's minimum size).
  expect(Math.abs(input.width / input.height - wide.width / wide.height)).toBeLessThan(0.01); expect(input.width).toBeGreaterThanOrEqual(wide.width);
  expect(input.excluded.words).toBeGreaterThan(0);
  const decomposed = await (await request.get(`${API}/${templateId}`)).json() as ProductView;
  expect(decomposed.product.prepared!.separation).toMatchObject({ method: 'seedream' });
  await page.screenshot({ path: `${OUT}/05-inspect.png`, fullPage: true });
  // 22–23. The existing editor: move, resize and hide a product, edit a word, save, reopen, export.
  const opened = page.waitForResponse(r => r.url().endsWith(`/${templateId}/open-editor`) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  const { runId } = await (await opened).json();
  await expect(panel).toBeHidden({ timeout: 60000 });
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!) as ProjectDocument);
  await expect.poll(async () => (await stored()).variants.some(v => v.importedFrom?.runId === runId)).toBe(true);
  const design = (await stored()).variants.find(v => v.importedFrom?.runId === runId)!;
  expect([design.canvas.width, design.canvas.height]).toEqual([wide.width, wide.height]);
  const products = decomposed.product.objects.filter(o => o.kind === 'product' && o.cutout);
  expect(products.length).toBe(4);
  for (const o of products) expect(design.layers!.some(l => l.name === o.label), o.label).toBe(true);
  const product = design.layers!.find(l => l.name === products[0].label)!;
  await page.locator('.layer-select', { hasText: product.name }).first().click();
  await page.getByLabel('X', { exact: true }).fill(String(product.x + 12));
  await page.getByLabel('X', { exact: true }).blur();
  await expect.poll(async () => (await stored()).variants.find(v => v.id === design.id)!.layers!.find(l => l.id === product.id)!.x).toBe(product.x + 12);
  await page.getByLabel('Width', { exact: true }).fill(String(Math.round(product.width) + 10));
  await page.getByLabel('Width', { exact: true }).blur();
  await page.getByRole('button', { name: `Hide ${product.name}`, exact: true }).click();
  await expect.poll(async () => (await stored()).variants.find(v => v.id === design.id)!.layers!.find(l => l.id === product.id)!.visible).toBe(false);
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.locator('.text-elements summary').filter({ hasText: 'Golden' }).first().click();
  await page.getByRole('button', { name: 'Select word Golden', exact: true }).first().click();
  await page.getByLabel('Text content', { exact: true }).fill('Festive');
  await page.getByLabel('Text content', { exact: true }).blur();
  await expect.poll(async () => (await stored()).variants.find(v => v.id === design.id)!.elements.some(e => e.text === 'Festive')).toBe(true);
  await page.getByRole('button', { name: 'Save creative', exact: true }).click();
  await expect(page.getByText(/Saved to creative · revision \d+/)).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  await (await download).saveAs(`${OUT}/06-export.png`);
  const exported = await sharp(`${OUT}/06-export.png`).metadata();
  expect(exported.width! / exported.height!).toBeCloseTo(16 / 9, 2);
  await page.reload();
  const again = (await stored()).variants.find(v => v.id === design.id)!;
  expect(again.layers!.find(l => l.id === product.id)!.visible).toBe(false);
  expect(again.layers!.find(l => l.id === product.id)!.x).toBe(product.x + 12);
  expect(again.elements.some(e => e.text === 'Festive')).toBe(true);
  writeFileSync(`${OUT}/evidence.json`, JSON.stringify({ testProvidersOnly: true, templateId: id, draftId, derivedTemplateId: templateId, runId, placementCalls: calls.length, outputs: Object.fromEntries(Object.entries(d.outputs).map(([r, o]) => [r, { canvas: o!.canvas, status: o!.checks.status, creativeId: o!.creativeId }])) }, null, 2));
});
