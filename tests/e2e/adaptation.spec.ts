import { expect, test, type Page } from '@playwright/test';
import type { AdaptRequest, ImageResponse, ProjectDocument } from '@frameflow/shared';
import type { Stage } from 'konva/lib/Stage';
import type { Text } from 'konva/lib/shapes/Text';
const key = 'frameflow:project:v1';
const wording = { eyebrow: '  Together with family  ', title: 'Aarav & Meera\n♥', date: '12 December 2026 · 7:00 PM', venue: 'The Grand Royal Wedding Palace, Connaught Place, New Delhi, India' };
const saved = (page: Page) => expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
const documentJSON = (page: Page) => page.evaluate((storageKey) => localStorage.getItem(storageKey)!, key);
async function project(page: Page): Promise<ProjectDocument> { return JSON.parse(await documentJSON(page)); }
async function image(page: Page, width: number, height: number): Promise<ImageResponse> {
  const base64 = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d')!; context.fillStyle = '#fcf8ef'; context.fillRect(0, 0, width, height);
    context.fillStyle = '#9e8550'; context.fillRect(width * .06, height * .1, width * .15, height * .8);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { width, height });
  return { requestId: 'mocked-adaptation', image: { base64, width, height, mimeType: 'image/png' },
    generation: { mode: 'live', provider: 'cloudflare', model: 'mocked-reference-model', requestedAspectRatio: '16:9', promptUsed: 'Use reference artwork. Recompose with quiet text space.' } };
}
async function sourceDesign(page: Page) {
  // Every source generation and adaptation is explicitly mocked in this suite.
  await page.route('**/api/health', (route) => route.fulfill({ json: { status: 'ok', provider: 'cloudflare', aiConfigured: true, aiAvailable: true } }));
  await page.goto('/');
  const original = await image(page, 816, 1024), target = await image(page, 640, 360);
  await page.route('**/api/ai/generate', (route) => route.fulfill({ json: original }));
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await page.getByLabel('Visual theme', { exact: true }).fill('Ivory florals and antique gold, with a calm center');
  await page.getByText('Exact event wording', { exact: false }).click();
  for (const [role, text] of Object.entries(wording)) await page.getByLabel(`Event ${role}`, { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Generate design', exact: true }).click();
  await page.getByRole('button', { name: 'Use this design', exact: true }).click(); await saved(page);
  await page.getByRole('button', { name: 'Adapt format', exact: true }).click();
  return { target, original: await documentJSON(page) };
}
async function assetInfo(page: Page) {
  return page.evaluate(async () => new Promise<{ id: string; bytes: number; hash: number }[]>((resolve, reject) => {
    const open = indexedDB.open('frameflow-assets'); open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, read = db.transaction('assets').objectStore('assets').getAll();
      read.onerror = () => reject(read.error);
      read.onsuccess = async () => {
        db.close(); resolve(await Promise.all((read.result as { id: string; blob: Blob }[]).map(async ({ id, blob }) => {
          const bytes = new Uint8Array(await blob.arrayBuffer()); let hash = 0;
          for (const byte of bytes) hash = (hash * 31 + byte) | 0;
          return { id, bytes: bytes.length, hash };
        })));
      };
    };
  }));
}
async function previewText(page: Page) {
  return page.evaluate(() => (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages
    .filter((stage) => stage.container().isConnected).map((stage) => stage.find<Text>('.comparison-text').map((text) => text.text())));
}

test('mocked reference adaptation preserves exact content through comparison, atomic apply, switching and reload', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  const { original, target } = await sourceDesign(page), beforeAssets = await assetInfo(page);
  let requests = 0, request: AdaptRequest | undefined;
  await page.route('**/api/ai/adapt', (route) => { requests++; request = route.request().postDataJSON() as AdaptRequest; return route.fulfill({ json: target }); });
  await page.getByRole('button', { name: 'Adapt artwork', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this version', exact: true })).toBeEnabled();
  expect(requests).toBe(1); expect(request).toMatchObject({ format: 'landscape', target: { width: 1600, height: 900 }, source: { variantId: 'original', width: 1080, height: 1350 }, referenceImage: { mimeType: 'image/png', width: 407, height: 511 } });
  expect(JSON.stringify(request)).not.toContain('Aarav'); expect(request?.referenceImage.base64.length).toBeGreaterThan(100);
  expect(await documentJSON(page)).toBe(original);
  const sourceFrame = await page.getByTestId('source-frame').boundingBox(), targetFrame = await page.getByTestId('target-frame').boundingBox();
  expect(sourceFrame!.width / sourceFrame!.height).toBeCloseTo(.8, 2); expect(targetFrame!.width / targetFrame!.height).toBeCloseTo(1600 / 900, 2);
  expect(await previewText(page)).toEqual([Object.values(wording), Object.values(wording)]);
  expect(await assetInfo(page)).toHaveLength(2); expect(await assetInfo(page)).toEqual(expect.arrayContaining(beforeAssets));
  await page.screenshot({ path: testInfo.outputPath('mocked-adaptation-compare.png') });
  await page.getByRole('button', { name: 'Use this version', exact: true }).click(); await saved(page);
  const applied = await documentJSON(page), document = JSON.parse(applied) as ProjectDocument, source = JSON.parse(original).variants[0];
  expect(document.variants).toHaveLength(2); expect(document.variants[0]).toEqual(source);
  const adapted = document.variants[1];
  expect(adapted).toMatchObject({ sourceVariantId: source.id, canvas: { width: 1600, height: 900 }, generation: { provider: 'cloudflare', sourceAssetId: source.background.assetId } });
  expect(adapted.elements.map((e) => [e.id, e.text])).toEqual(source.elements.map((e: { id: string; text: string }) => [e.id, e.text]));
  expect(adapted.elements.every((e) => e.x > 1600 * .4 && e.align === 'left')).toBe(true);
  await expect(page.getByLabel('Active version')).toHaveValue(adapted.id);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await saved(page); expect(await documentJSON(page)).toBe(original);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await saved(page); expect(await documentJSON(page)).toBe(applied); expect(requests).toBe(1);
  await page.getByRole('button', { name: 'Compare versions', exact: true }).click(); await expect(page.getByTestId('source-frame')).toBeVisible();
  await page.getByRole('button', { name: 'Back to editing', exact: true }).click();
  await page.reload(); await saved(page); expect(await documentJSON(page)).toBe(applied);
  await page.getByLabel('Active version').selectOption(adapted.id); await expect(page.getByTestId('canvas-dimensions')).toHaveText('1600 × 900 px');
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: /Aarav & Meera/ }).click();
  await expect(page.getByLabel('Text content')).toHaveValue(wording.title);
  await page.getByLabel('Text content').fill(wording.title + ' editable'); await page.getByLabel('Text content').blur(); await saved(page);
  expect((await project(page)).variants[0]).toEqual(source);
  await page.getByLabel('Active version').selectOption(source.id); await expect(page.getByTestId('canvas-dimensions')).toHaveText('1080 × 1350 px');
  expect(await assetInfo(page)).toHaveLength(2); expect(requests).toBe(1); expect(errors).toEqual([]);
});

test('mocked adaptation rejects an edited source and keeps stale artwork out of the document', async ({ page }) => {
  const { target } = await sourceDesign(page);
  await page.getByRole('tab', { name: 'Text', exact: true }).click(); await page.getByRole('button', { name: /Aarav & Meera/ }).click();
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  let release!: () => void; const ready = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/ai/adapt', async (route) => { await ready; await route.fulfill({ json: target }); });
  await page.getByRole('button', { name: 'Adapt artwork', exact: true }).click();
  await expect(page.getByText('Adapting your artwork…')).toBeVisible();
  await page.getByLabel('Text content').fill('New source wording'); await page.getByLabel('Text content').blur(); await saved(page);
  const edited = await documentJSON(page); release();
  await expect(page.getByRole('button', { name: 'Use this version', exact: true })).toBeDisabled();
  await expect(page.getByText('Your source design changed.', { exact: false })).toBeVisible();
  expect(await documentJSON(page)).toBe(edited);
  await page.getByRole('button', { name: 'Discard', exact: true }).click(); await expect.poll(() => assetInfo(page).then((assets) => assets.length)).toBe(1);
});

test('mocked adaptation invalidates a preview after switching away and back', async ({ page }) => {
  const { target } = await sourceDesign(page);
  await page.route('**/api/ai/adapt', (route) => route.fulfill({ json: target }));
  await page.getByRole('button', { name: 'Adapt artwork', exact: true }).click(); await page.getByRole('button', { name: 'Use this version', exact: true }).click(); await saved(page);
  await page.getByLabel('Active version').selectOption('original');
  await page.getByRole('button', { name: 'Adapt artwork', exact: true }).click(); await expect(page.getByRole('button', { name: 'Use this version', exact: true })).toBeEnabled();
  const doc = await project(page); await page.getByLabel('Active version').selectOption(doc.variants[1].id); await page.getByLabel('Active version').selectOption('original');
  await expect(page.getByRole('button', { name: 'Use this version', exact: true })).toBeDisabled(); expect(await project(page)).toEqual(doc);
});

test('mocked cancelled adaptation ignores a late response and preserves the source asset', async ({ page }) => {
  const { target, original } = await sourceDesign(page); let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; }); let calls = 0;
  await page.route('**/api/ai/adapt', async (route) => { calls++; await ready; await route.fulfill({ json: target }).catch(() => undefined); });
  await page.getByRole('button', { name: 'Adapt artwork', exact: true }).click(); await expect.poll(() => calls).toBe(1);
  await page.getByRole('button', { name: 'Cancel adaptation', exact: true }).click(); release();
  await expect(page.getByRole('button', { name: 'Adapt artwork', exact: true })).toBeEnabled();
  expect(await documentJSON(page)).toBe(original); expect(await assetInfo(page)).toHaveLength(1); await expect(page.getByTestId('target-frame')).toHaveCount(0);
});

for (const failure of ['provider', 'reference', 'storage'] as const) test(`mocked ${failure} failure preserves the adaptation source`, async ({ page }) => {
  const { target, original } = await sourceDesign(page); let calls = 0;
  await page.route('**/api/ai/adapt', (route) => { calls++; return failure === 'provider' ? route.fulfill({ status: 429, json: { error: { message: 'Image quota exhausted.' } } }) : route.fulfill({ json: target }); });
  if (failure === 'reference') await page.evaluate(() => { HTMLImageElement.prototype.decode = async () => { throw new Error('Mock decode failure'); }; });
  if (failure === 'storage') await page.evaluate(() => { IDBObjectStore.prototype.put = () => { throw new DOMException('Mock full storage', 'QuotaExceededError'); }; });
  await page.getByRole('button', { name: 'Adapt artwork', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: failure === 'provider' ? 'usage limit' : failure === 'reference' ? 'prepare the source' : 'store the artwork' })).toBeVisible();
  expect(await documentJSON(page)).toBe(original); expect(calls).toBe(failure === 'reference' ? 0 : 1);
  expect(await assetInfo(page)).toHaveLength(1); await expect(page.getByRole('button', { name: 'Use this version' })).toHaveCount(0);
});
