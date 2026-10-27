import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import type { ProductCreative, ProjectDocument, ReuseDraft } from '@frameflow/shared';
import type { ProductView, ReusePreview } from '../../client/src/features/productTemplates/api';

const API = '/api/layerize-experiment/product-templates', FILES = '/api/layerize-experiment/protected-templates', OUT = 'test-results/simple-reuse', NAME = 'LG simple reuse proof';
test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` }, actionTimeout: 30000 });
test.setTimeout(600000);

/** "The person's" product photos: transparent PNGs drawn here (no provider). */
const SVG: Record<string, string> = {
  'washing-machine': '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="540"><rect x="10" y="10" width="400" height="520" rx="22" fill="#f3f4f6" stroke="#9ca3af" stroke-width="6"/><rect x="10" y="10" width="400" height="86" rx="22" fill="#e5e7eb"/><circle cx="330" cy="54" r="18" fill="#2563eb"/><circle cx="210" cy="310" r="150" fill="#6b7280"/><circle cx="210" cy="310" r="110" fill="#1e3a8a"/></svg>',
  cooker: '<svg xmlns="http://www.w3.org/2000/svg" width="520" height="380"><rect x="8" y="12" width="300" height="22" rx="10" fill="#111827"/><ellipse cx="250" cy="120" rx="200" ry="40" fill="#9ca3af"/><rect x="50" y="120" width="400" height="220" rx="30" fill="#d1d5db" stroke="#6b7280" stroke-width="6"/><rect x="300" y="30" width="210" height="34" rx="14" fill="#111827"/><circle cx="250" cy="96" r="22" fill="#374151"/></svg>',
  television: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="430"><rect x="20" y="10" width="600" height="350" rx="10" fill="#111827"/><rect x="40" y="28" width="560" height="314" fill="#7c3aed"/><circle cx="320" cy="185" r="90" fill="#f59e0b"/><rect x="260" y="360" width="120" height="40" fill="#374151"/><rect x="190" y="396" width="260" height="16" rx="6" fill="#1f2937"/></svg>',
  refrigerator: '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="760"><rect x="10" y="10" width="340" height="740" rx="18" fill="#374151"/><rect x="24" y="24" width="150" height="712" rx="10" fill="#4b5563"/><rect x="186" y="24" width="150" height="712" rx="10" fill="#4b5563"/><rect x="150" y="260" width="10" height="160" rx="5" fill="#d1d5db"/><rect x="200" y="260" width="10" height="160" rx="5" fill="#d1d5db"/></svg>',
  microwave: '<svg xmlns="http://www.w3.org/2000/svg" width="560" height="340"><rect x="10" y="10" width="540" height="320" rx="16" fill="#1f2937"/><rect x="34" y="40" width="360" height="260" rx="10" fill="#111827" stroke="#6b7280" stroke-width="6"/><rect x="420" y="50" width="100" height="40" rx="6" fill="#10b981"/><circle cx="470" cy="200" r="34" fill="#9ca3af"/></svg>',
};
const photo = async (name: string) => ({ name: `${name}.png`, mimeType: 'image/png', buffer: await sharp(Buffer.from(SVG[name])).png().toBuffer() });
/** Mean colour of a picture's opaque pixels and its opaque size: a product's identity, as uploaded and as used. */
async function identity(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1, r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) { const i = (y * info.width + x) * 4; if (data[i + 3] < 128) continue; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
  return { width: x1 - x0 + 1, height: y1 - y0 + 1, mean: [r / n, g / n, b / n] };
}

async function openPanel(page: Page) {
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => r.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  return panel;
}
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
  await panel.getByRole('article', { name: `Product template ${NAME}` }).filter({ has: page.locator(`img[src*="${id}"]`) }).getByRole('button', { name: 'Reuse Template' }).click();
  return panel;
}

test('Create a New Creative: upload two products, one click, review, save, reopen, customise, Seedream and the editor; five products too (offline providers)', async ({ page, request }) => {
  test.skip(process.env.FRAMEFLOW_PRODUCT_REFERENCE !== '1' || process.env.FRAMEFLOW_PRODUCT_REUSE_PROOF !== '1', 'Uses the real LG reference with a handmade detection manifest.');
  mkdirSync(OUT, { recursive: true });
  const id = await savedMaster(page, request);
  const master = await (await request.get(`${API}/${id}/revisions/1`)).json(), masterText = JSON.stringify(master);
  const templateProducts = (master.objects as { id: string; kind: string }[]).filter(o => o.kind === 'product').map(o => o.id);
  // 1–3. Product Templates → Reuse Template → the simple Upload Products step, by default.
  let panel = await openReuse(page, id);
  await expect(panel.getByRole('heading', { name: 'Create Your Offer Creative' })).toBeVisible();
  await expect(panel.getByText('Upload your product photos. AI will arrange them beautifully in your selected template.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Upload Products', exact: true })).toBeVisible();
  await page.screenshot({ path: `${OUT}/01-start.png` });
  // 4–5. Two photos in one action: both thumbnails, both selected.
  await panel.getByLabel('Upload product photos').setInputFiles([await photo('washing-machine'), await photo('cooker')]);
  const list = panel.getByRole('list', { name: 'Your products' });
  await expect(list.getByRole('listitem', { name: /^Product / })).toHaveCount(2, { timeout: 60000 });
  await expect(list.getByRole('checkbox')).toHaveCount(2);
  for (const c of await list.getByRole('checkbox').all()) await expect(c).toBeChecked();
  await expect(panel.getByText('All changes saved')).toBeVisible();
  await page.screenshot({ path: `${OUT}/02-uploaded.png` });
  const draftId = (await (await request.get(`${API}/${id}/reuse`)).json()).drafts[0].id as string;
  const draft = async () => (await (await request.get(`${API}/${id}/reuse/${draftId}`)).json()).draft as ReuseDraft;
  let d = await draft();
  expect(d.simple).toBe(true);
  // Every product of the template is left out; Ganesh is kept.
  expect(d.items.filter(i => i.objectId && i.kind === 'product').every(i => !i.included)).toBe(true);
  expect(d.items.find(i => i.kind === 'character')!.included).toBe(true);
  const uploaded = d.items.filter(i => !i.objectId).map(i => i.id).sort();
  expect(d.items.filter(i => !i.objectId).map(i => [i.label, i.category]).sort()).toEqual([['cooker', 'cooker'], ['washing machine', 'washing machine']]);
  // 6. One click; the AI cost confirmed once; each status a real step.
  await panel.getByRole('button', { name: 'Generate Creative' }).click();
  const confirm = panel.getByRole('dialog', { name: 'Arrange Products with AI' });
  await expect(confirm).toContainText('$0.08');
  const callsAtStart = ((await (await request.get('/__test__/placement-calls')).json()).calls as unknown[]).length;
  await confirm.getByRole('button', { name: 'Approve & Generate' }).click();
  await expect(panel.getByRole('heading', { name: 'Your creative is ready!' })).toBeVisible({ timeout: 120000 });
  await expect(panel.getByRole('img', { name: 'Your finished creative' })).toBeVisible();
  await expect(panel.getByText('Products arranged by AI')).toBeVisible();
  const calls = (await (await request.get('/__test__/placement-calls')).json()).calls as { products: string[] }[];
  expect(calls).toHaveLength(callsAtStart + 1); expect(calls.at(-1)!.products.sort()).toEqual(uploaded);
  // 7–10. Only the two uploaded products; no product of the template; Ganesh, logos and text as in the template.
  const preview = (await (await request.get(`${API}/${id}/reuse/${draftId}/preview?ratio=original`)).json()) as ReusePreview;
  expect(preview.mode).toBe('ai');
  const shown = preview.creative.objects.filter(o => o.kind === 'product');
  expect(shown.map(o => o.id).sort()).toEqual(uploaded);
  expect(shown.some(o => templateProducts.includes(o.id))).toBe(false);
  const ganesh = preview.creative.objects.find(o => o.kind === 'character')!;
  expect(ganesh.asset.kind).toBe('template');
  for (const p of shown) { expect(p.box.x).toBeGreaterThanOrEqual(0); expect(p.box.x + p.box.width).toBeLessThanOrEqual(preview.creative.canvas.width); expect(p.box.width * p.box.height).toBeGreaterThan(preview.creative.canvas.width * preview.creative.canvas.height * 0.004); }
  expect(preview.checks.issues.filter(i => i.blocking)).toEqual([]);
  expect(preview.creative.images.filter(i => !i.hidden).length).toBe(master.logoSlots.length);
  // The copy as in the template: its own lettering (a layer per text block), its editable words kept underneath.
  expect(preview.creative.texts.map(t => t.text).join(' ')).toContain('cashback');
  expect(preview.creative.objects.filter(o => o.label.startsWith('Text · ')).length).toBe(master.groups.length);
  // The products are the person's own pictures (not redrawn): same opaque size and colour.
  for (const [name, item] of [['washing-machine', 'washing machine'], ['cooker', 'cooker']] as const) {
    const asset = shown.find(o => o.label === item)!.asset.file, used = await identity(await (await request.get(`${FILES}/${id}/files/${asset}`)).body()), original = await identity((await photo(name)).buffer);
    expect([used.width, used.height]).toEqual([original.width, original.height]);
    used.mean.forEach((v, k) => expect(Math.abs(v - original.mean[k])).toBeLessThan(1));
  }
  d = await draft();
  const poster = await (await request.get(`${FILES}/${id}/files/${d.outputs.original!.preview}`)).body();
  writeFileSync(`${OUT}/03-two-products.png`, poster);
  await page.screenshot({ path: `${OUT}/03-result.png`, fullPage: true });
  // Mobile: the review stacks without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${OUT}/03b-result-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  // 12. Save.
  await panel.getByRole('button', { name: 'Save Creative' }).click();
  await expect(panel.getByRole('button', { name: 'Saved' })).toBeVisible();
  d = await draft();
  const creativeId = d.outputs.original!.creativeId!;
  expect(((await (await request.get(`${API}/${id}/creatives/${creativeId}`)).json()) as ProductCreative).origin).toMatchObject({ kind: 'reuse', draftId });
  // 13. Reopen: a fresh page continues the same creative, saved.
  panel = await openReuse(page, id);
  await expect(panel.getByRole('heading', { name: 'Your creative is ready!' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Saved' })).toBeVisible();
  await expect(panel.getByRole('img', { name: 'Your finished creative' })).toBeVisible();
  // 14. Customise one product (optional): the detailed studio on the same draft; Size +.
  await panel.getByRole('button', { name: 'Customize Manually' }).click();
  const washer = panel.getByRole('list', { name: 'Product list' }).getByRole('listitem', { name: 'Product washing machine', exact: true });
  await washer.getByRole('button', { name: 'Edit placement' }).click();
  const before = (await draft()).revision;
  await panel.getByRole('button', { name: 'Size +' }).click();
  await expect.poll(async () => (await draft()).revision).toBeGreaterThan(before);
  const washerId = shown.find(o => o.label === 'washing machine')!.id;
  expect((await draft()).overrides.original![`o:${washerId}`]).toBeTruthy();
  await page.screenshot({ path: `${OUT}/04-customise.png`, fullPage: true });
  await panel.getByRole('button', { name: 'Back to my creative' }).click();
  await expect(panel.getByText('You changed your creative since this preview was made.')).toBeVisible();
  const callsBefore = (await (await request.get('/__test__/placement-calls')).json()).calls.length;
  await panel.getByRole('button', { name: 'Update preview' }).click();
  await expect(panel.getByRole('heading', { name: 'Your creative is ready!' })).toBeVisible({ timeout: 120000 });
  expect((await (await request.get('/__test__/placement-calls')).json()).calls).toHaveLength(callsBefore);
  // 15–16. Save the change, then Decompose into Layers: its own OpenAI + Seedream cost dialog (mock transport), Review Layers.
  await panel.getByRole('button', { name: 'Save Creative' }).click();
  await expect(panel.getByRole('button', { name: 'Saved' })).toBeVisible();
  const submissions = (await (await request.get('/__test__/product-calls')).json()).submissions.length;
  const handoff = page.waitForResponse(r => r.url().endsWith('/outputs/original/decomposition') && r.request().method() === 'POST');
  await panel.getByRole('region', { name: 'Edit Your Creative' }).getByRole('button', { name: 'Decompose into Layers' }).click();
  const { templateId } = await (await handoff).json() as { templateId: string };
  expect((await draft()).outputs.original!.creativeRevision).toBe(2);
  const makeEditable = page.getByRole('dialog', { name: 'Make Your Creative Editable' });
  await expect(makeEditable.getByRole('button', { name: /^Make Editable/ })).toBeEnabled({ timeout: 120000 });
  expect((await (await request.get('/__test__/product-calls')).json()).submissions).toHaveLength(submissions);
  await makeEditable.getByRole('button', { name: /^Make Editable/ }).click();
  await page.getByRole('dialog', { name: 'Your Creative Is Ready to Edit!' }).getByRole('button', { name: 'Review Layers' }).click({ timeout: 180000 });
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 120000 });
  const providerCalls = await (await request.get('/__test__/product-calls')).json();
  expect(providerCalls.submissions).toHaveLength(submissions + 1);
  expect(providerCalls.decompositionInputs.at(-1).excluded.words).toBeGreaterThan(0);
  const decomposed = await (await request.get(`${API}/${templateId}`)).json() as ProductView;
  const layers = decomposed.product.objects.filter(o => o.kind === 'product' && o.cutout);
  expect(layers.map(o => o.label.toLowerCase()).sort()).toEqual(['cooker', 'washing machine']);
  await page.screenshot({ path: `${OUT}/05-inspect.png`, fullPage: true });
  // 17–18. The existing editor: move and resize one product, hide the other, edit the headline, save, reopen, export.
  const opened = page.waitForResponse(r => r.url().endsWith(`/${templateId}/open-editor`) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  const { runId } = await (await opened).json();
  await expect(panel).toBeHidden({ timeout: 60000 });
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!) as ProjectDocument);
  await expect.poll(async () => (await stored()).variants.some(v => v.importedFrom?.runId === runId)).toBe(true);
  const design = (await stored()).variants.find(v => v.importedFrom?.runId === runId)!;
  const named = (n: string) => design.layers!.find(l => l.name.toLowerCase() === n)!, washerLayer = named('washing machine'), cookerLayer = named('cooker');
  await page.locator('.layer-select', { hasText: washerLayer.name }).first().click();
  await page.getByLabel('X', { exact: true }).fill(String(washerLayer.x + 12)); await page.getByLabel('X', { exact: true }).blur();
  await page.getByLabel('Width', { exact: true }).fill(String(Math.round(washerLayer.width) + 10)); await page.getByLabel('Width', { exact: true }).blur();
  await expect.poll(async () => (await stored()).variants.find(v => v.id === design.id)!.layers!.find(l => l.id === washerLayer.id)!.x).toBe(washerLayer.x + 12);
  await page.getByRole('button', { name: `Hide ${cookerLayer.name}`, exact: true }).click();
  await expect.poll(async () => (await stored()).variants.find(v => v.id === design.id)!.layers!.find(l => l.id === cookerLayer.id)!.visible).toBe(false);
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.locator('.text-elements summary').filter({ hasText: 'grand' }).first().click();
  await page.getByRole('button', { name: 'Select word grand', exact: true }).first().click();
  await page.getByLabel('Text content', { exact: true }).fill('golden'); await page.getByLabel('Text content', { exact: true }).blur();
  await expect.poll(async () => (await stored()).variants.find(v => v.id === design.id)!.elements.some(e => e.text === 'golden')).toBe(true);
  await page.screenshot({ path: `${OUT}/06-editor.png` });
  await page.getByRole('button', { name: 'Save creative', exact: true }).click();
  await expect(page.getByText(/Saved to creative · revision \d+/)).toBeVisible();
  await page.reload();
  const again = (await stored()).variants.find(v => v.id === design.id)!;
  expect(again.layers!.find(l => l.id === washerLayer.id)!.x).toBe(washerLayer.x + 12);
  expect(again.layers!.find(l => l.id === cookerLayer.id)!.visible).toBe(false);
  expect(again.elements.some(e => e.text === 'golden')).toBe(true);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  await (await download).saveAs(`${OUT}/07-export.png`);
  expect((await sharp(`${OUT}/07-export.png`).metadata()).width).toBeGreaterThan(100);
  // Five products: Start over, five photos at once, the free automatic arrangement this time.
  panel = await openReuse(page, id);
  await panel.getByRole('button', { name: 'Start over' }).click();
  await panel.getByLabel('Upload product photos').setInputFiles(await Promise.all(['washing-machine', 'cooker', 'television', 'refrigerator', 'microwave'].map(photo)));
  await expect(panel.getByRole('list', { name: 'Your products' }).getByRole('listitem', { name: /^Product / })).toHaveCount(5, { timeout: 60000 });
  await panel.getByRole('listitem', { name: 'Product television' }).getByRole('button', { name: 'Make main product' }).click();
  await panel.getByRole('button', { name: 'Generate Creative' }).click();
  await panel.getByRole('dialog', { name: 'Arrange Products with AI' }).getByRole('button', { name: 'Arrange Automatically (Free)' }).click();
  await expect(panel.getByRole('heading', { name: 'Your creative is ready!' })).toBeVisible({ timeout: 120000 });
  await expect(panel.getByText('Products arranged automatically')).toBeVisible();
  const five = (await (await request.get(`${API}/${id}/reuse`)).json()).drafts.find((x: { simple: boolean; id: string }) => x.simple && x.id !== draftId).id as string;
  const fivePreview = (await (await request.get(`${API}/${id}/reuse/${five}/preview?ratio=original`)).json()) as ReusePreview;
  const products = fivePreview.creative.objects.filter(o => o.kind === 'product');
  expect(products).toHaveLength(5); expect(fivePreview.mode).toBe('geometry');
  expect(fivePreview.checks.issues.filter(i => i.blocking)).toEqual([]);
  // The main product (the television) stands in the middle and is among the largest.
  const tv = products.find(o => o.label === 'television')!, centre = (b: { x: number; width: number }) => b.x + b.width / 2;
  const byX = [...products].sort((a, b) => centre(a.box) - centre(b.box));
  expect(byX.indexOf(tv)).toBeGreaterThanOrEqual(1); expect(byX.indexOf(tv)).toBeLessThanOrEqual(3);
  expect(tv.box.width * tv.box.height).toBeGreaterThanOrEqual(Math.max(...products.map(o => o.box.width * o.box.height)) * 0.8);
  for (const o of products) { expect(o.box.x).toBeGreaterThanOrEqual(0); expect(o.box.x + o.box.width).toBeLessThanOrEqual(fivePreview.creative.canvas.width); }
  const fiveDraft = (await (await request.get(`${API}/${id}/reuse/${five}`)).json()).draft as ReuseDraft;
  writeFileSync(`${OUT}/08-five-products.png`, await (await request.get(`${FILES}/${id}/files/${fiveDraft.outputs.original!.preview}`)).body());
  await page.screenshot({ path: `${OUT}/08-five-result.png`, fullPage: true });
  // The master revision was only read.
  expect(JSON.stringify(await (await request.get(`${API}/${id}/revisions/1`)).json())).toBe(masterText);
});
