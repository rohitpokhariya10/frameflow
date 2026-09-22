import { expect, test, type Page, type Route } from '@playwright/test';
import type { GenerateRequest, ImageResponse, ProjectDocument } from '@frameflow/shared';
import type { Stage } from 'konva/lib/Stage';
import type { Image as KonvaImage } from 'konva/lib/shapes/Image';
import type { Text } from 'konva/lib/shapes/Text';

// Every generation in this file is intercepted. This is browser integration
// coverage with synthetic artwork, never evidence of a live provider request.
const storageKey = 'frameflow:project:v1';
const visualPrompt = 'Ivory botanical borders with warm gold details and a quiet center';
const exactContent = {
  eyebrow: 'Together, with family',
  title: 'Aarav & Meera\nA celebration',
  date: '12 December 2026 · 7:00 PM',
  venue: 'The Grand Royal Wedding Palace, Connaught Place, New Delhi, India',
};
const saved = (page: Page) => expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
const documentJSON = (page: Page) => page.evaluate((key) => localStorage.getItem(key)!, storageKey);
async function project(page: Page): Promise<ProjectDocument> { return JSON.parse(await documentJSON(page)); }
async function openAI(page: Page, configured = true) {
  await page.route('**/api/health', (route) => route.fulfill({ json: { status: 'ok', provider: 'cloudflare', aiConfigured: configured, aiAvailable: configured } }));
  await page.goto('/');
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set the atmosphere.' })).toBeVisible();
  await saved(page);
}
async function existingDesign(page: Page) {
  await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  await page.getByLabel('Text content').fill('Keep this existing design');
  await page.getByLabel('Text content').blur();
  await saved(page);
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  return documentJSON(page);
}
async function mockImage(page: Page): Promise<ImageResponse> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 320;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#f5efe1'; context.fillRect(0, 0, 320, 320);
    context.strokeStyle = '#9e8550'; context.lineWidth = 8; context.strokeRect(20, 20, 280, 280);
    context.fillStyle = '#48664f'; context.beginPath(); context.ellipse(35, 70, 12, 35, .5, 0, Math.PI * 2); context.fill();
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { requestId: 'mocked-browser-request', image: { base64, mimeType: 'image/png', width: 320, height: 320 },
    generation: { mode: 'live', provider: 'cloudflare', model: 'mocked-e2e-provider', requestedAspectRatio: '16:9', promptUsed: 'Mocked background-artwork request; no event wording.' } };
}
async function fillPrompt(page: Page) {
  await page.getByLabel('Artwork direction').fill(visualPrompt);
  await page.getByLabel('Preview format').selectOption('landscape');
}
async function fillContent(page: Page) {
  await expect(page.getByLabel('Event title', { exact: true })).toBeVisible();
  for (const [role, value] of Object.entries(exactContent)) await page.getByLabel(`Event ${role}`, { exact: true }).fill(value);
}
async function assetRecords(page: Page) {
  return page.evaluate(async () => {
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database.name === 'frameflow-assets')) return [];
    return new Promise<{ id: string; mimeType: string; blobType: string; bytes: number; isBlob: boolean }[]>((resolve, reject) => {
      const open = indexedDB.open('frameflow-assets'); open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const request = database.transaction('assets').objectStore('assets').getAll();
        request.onerror = () => { database.close(); reject(request.error); };
        request.onsuccess = () => { database.close(); resolve(request.result.map((asset: { id: string; mimeType: string; blob: Blob }) =>
          ({ id: asset.id, mimeType: asset.mimeType, blobType: asset.blob.type, bytes: asset.blob.size, isBlob: asset.blob instanceof Blob }))); };
      };
    });
  });
}
async function artworkState(page: Page) {
  return page.evaluate(() => {
    const stage = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0];
    const image = stage.findOne<KonvaImage>('.background-artwork');
    const texts = stage.find<Text>('.editable-text, .preview-text');
    return {
      image: image ? { width: image.width(), height: image.height(), x: image.x(), y: image.y(), listening: image.listening(),
        layer: image.getLayer()!.zIndex(), clipWidth: image.getLayer()!.clipWidth(), clipHeight: image.getLayer()!.clipHeight() } : null,
      texts: texts.map((node) => ({ text: node.text(), layer: node.getLayer()!.zIndex(), listening: node.listening(), name: node.name() })),
    };
  });
}
async function fulfillImage(route: Route, response: ImageResponse) { await route.fulfill({ json: response }); }

test('mocked AI configuration state intentionally disables generation', async ({ page }, testInfo) => {
  let requests = 0;
  await page.route('**/api/ai/generate', (route) => { requests++; return route.abort(); });
  await openAI(page, false);
  await expect(page.getByText('AI artwork is unavailable right now. You can still add text, edit and export.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate design', exact: true })).toBeDisabled();
  const button = await page.getByRole('button', { name: 'Generate design', exact: true }).boundingBox();
  expect(button!.y + button!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('ai-missing-configuration.png'), fullPage: true });
  expect(requests).toBe(0);
});

test('mocked generation previews before one atomic apply, preserves exact editable text and recovers artwork', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openAI(page);
  const original = await existingDesign(page);
  const response = await mockImage(page);
  let requests = 0; let body: GenerateRequest | undefined;
  let release!: () => void; const responseReady = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/ai/generate', async (route) => {
    requests++; body = route.request().postDataJSON() as GenerateRequest;
    await responseReady; await fulfillImage(route, response);
  });
  await page.getByRole('button', { name: 'Generate design', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Describe the artwork');
  expect(requests).toBe(0);
  await fillPrompt(page); await fillContent(page);
  await page.getByRole('button', { name: 'Generate design', exact: true }).click();
  await expect(page.getByText('Creating your design…', { exact: true })).toBeVisible();
  const loadingBounds = await page.getByText('Creating your design…', { exact: true }).boundingBox();
  const actionBounds = await page.getByRole('button', { name: 'Cancel generation', exact: true }).boundingBox();
  expect(loadingBounds!.y + loadingBounds!.height).toBeLessThan(actionBounds!.y);
  await expect(page.getByLabel('Artwork direction')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel generation', exact: true })).toBeVisible();
  expect(await documentJSON(page)).toBe(original);
  await page.screenshot({ path: testInfo.outputPath('ai-mocked-loading.png'), fullPage: true });
  release();
  await expect(page.getByRole('button', { name: 'Use this design', exact: true })).toBeVisible();
  await expect.poll(async () => (await artworkState(page)).image !== null).toBe(true);
  expect(requests).toBe(1);
  expect(body).toMatchObject({ prompt: visualPrompt, target: { width: 1600, height: 900 }, styleBrief: { theme: 'Elegant wedding' } });
  for (const wording of Object.values(exactContent)) expect(JSON.stringify(body)).not.toContain(wording);
  expect(await documentJSON(page)).toBe(original);
  await expect(page.getByTestId('canvas-dimensions')).toHaveText('1080 × 1350 px');
  await expect(page.getByTestId('canvas-frame')).toHaveAttribute('data-logical-width', '1600');
  const preview = await artworkState(page);
  expect(preview.texts.map((node) => node.text)).toEqual(Object.values(exactContent));
  expect(preview.texts.every((node) => node.name === 'preview-text' && !node.listening)).toBe(true);
  const records = await assetRecords(page);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ isBlob: true, mimeType: 'image/png', blobType: 'image/png' });
  expect(records[0].bytes).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('ai-mocked-preview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Use this design', exact: true }).click(); await saved(page);
  const applied = await documentJSON(page); const result = JSON.parse(applied) as ProjectDocument;
  const variant = result.variants[0];
  expect(variant.canvas).toMatchObject({ width: 1600, height: 900 });
  expect(variant.background).toEqual({ assetId: records[0].id, fit: 'cover', focalPoint: { x: .5, y: .5 } });
  expect(variant.generation).toMatchObject({ provider: 'cloudflare', model: 'mocked-e2e-provider', returnedWidth: 320, returnedHeight: 320, requestedAspectRatio: '16:9' });
  expect(result.originalPrompt).toBe(visualPrompt);
  expect(result.styleBrief?.theme).toBe('Elegant wedding');
  expect(variant.elements.map((element) => ({ role: element.role, text: element.text }))).toEqual(Object.entries(exactContent).map(([role, text]) => ({ role, text })));
  expect(applied).not.toContain(response.image.base64);
  expect(applied).not.toMatch(/data:image|blob:|"past"|"future"/);
  const artwork = await artworkState(page);
  expect(artwork.image).toMatchObject({ width: 1600, height: 1600, x: 0, y: -350, listening: false, clipWidth: 1600, clipHeight: 900 });
  expect(artwork.texts.every((node) => node.layer > artwork.image!.layer && node.listening && node.name === 'editable-text')).toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await saved(page);
  expect(await documentJSON(page)).toBe(original);
  expect((await artworkState(page)).image).toBeNull();
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await saved(page);
  expect(await documentJSON(page)).toBe(applied); expect(requests).toBe(1);
  await expect.poll(async () => (await artworkState(page)).image !== null).toBe(true);
  await page.reload(); await saved(page);
  await expect.poll(async () => (await artworkState(page)).image !== null).toBe(true);
  expect(await documentJSON(page)).toBe(applied);
  expect((await project(page)).variants[0].generation?.provider).toBe('cloudflare');
  expect((await artworkState(page)).texts.map((node) => node.text)).toEqual(Object.values(exactContent));
  await expect(page.getByTestId('canvas-dimensions')).toHaveText('1600 × 900 px');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('list', { name: 'Text elements' }).getByRole('button').filter({ hasText: exactContent.title.split('\n')[0] }).click();
  await expect(page.getByLabel('Text content')).toHaveValue(exactContent.title);
  await page.getByLabel('Text content').fill('Still editable after recovery');
  await expect.poll(async () => (await artworkState(page)).texts.some((node) => node.text === 'Still editable after recovery')).toBe(true);
  await page.getByRole('button', { name: 'Auto Layout', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('ai-mocked-applied-inspector.png'), fullPage: true });
  expect(requests).toBe(1); expect(errors).toEqual([]);
});

test('mocked preview discard deletes its uncommitted asset and retains the existing design', async ({ page }) => {
  await openAI(page); const original = await existingDesign(page); const response = await mockImage(page);
  await page.route('**/api/ai/generate', (route) => fulfillImage(route, response));
  await fillPrompt(page);
  await page.getByRole('button', { name: 'Generate design', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this design', exact: true })).toBeVisible();
  expect(await assetRecords(page)).toHaveLength(1);
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate design', exact: true })).toBeVisible();
  await expect.poll(() => assetRecords(page)).toEqual([]);
  expect(await documentJSON(page)).toBe(original);
  expect((await artworkState(page)).image).toBeNull();
  expect((await artworkState(page)).texts.map((node) => node.text)).toEqual(['Keep this existing design']);
});

test('mocked preview restores its form across tabs and regeneration preserves exact wording', async ({ page }) => {
  await openAI(page); const original = await existingDesign(page); const response = await mockImage(page);
  let requests = 0;
  await page.route('**/api/ai/generate', (route) => { requests++; return fulfillImage(route, response); });
  await fillPrompt(page); await fillContent(page);
  await page.getByRole('button', { name: 'Floral', exact: true }).click();
  await page.getByRole('button', { name: 'Generate design', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this design', exact: true })).toBeVisible();
  const firstAsset = (await assetRecords(page))[0].id;
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  expect((await artworkState(page)).texts.map((node) => node.text)).toEqual(['Keep this existing design']);
  expect((await artworkState(page)).image).toBeNull();
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(page.getByLabel('Artwork direction')).toHaveValue(visualPrompt);
  await expect(page.getByLabel('Preview format')).toHaveValue('landscape');
  await expect(page.getByRole('button', { name: 'Floral', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Event title', { exact: true })).toBeVisible();
  for (const [role, value] of Object.entries(exactContent)) await expect(page.getByLabel(`Event ${role}`, { exact: true })).toHaveValue(value);
  await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByRole('button', { name: 'Use this design', exact: true })).toBeVisible();
  expect((await artworkState(page)).texts.map((node) => node.text)).toEqual(Object.values(exactContent));
  const regenerated = await assetRecords(page);
  expect(regenerated).toHaveLength(1); expect(regenerated[0].id).not.toBe(firstAsset);
  expect(await documentJSON(page)).toBe(original);
});

test('mocked stale preview cannot overwrite document edits made from another tab', async ({ page }) => {
  await openAI(page); await existingDesign(page); const response = await mockImage(page);
  await page.route('**/api/ai/generate', (route) => fulfillImage(route, response));
  await fillPrompt(page); await page.getByRole('button', { name: 'Generate design', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this design', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('list', { name: 'Text elements' }).getByRole('button').click();
  await page.getByLabel('Text content').fill('A newer edit must be retained');
  await page.getByLabel('Text content').blur(); await saved(page);
  const newer = await documentJSON(page);
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: 'Use this design', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Your design changed while this preview was prepared');
  expect(await documentJSON(page)).toBe(newer);
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  expect((await artworkState(page)).texts.map((node) => node.text)).toEqual(['A newer edit must be retained']);
});

test('mocked cancellation ignores a late response and keeps the current design', async ({ page }) => {
  await openAI(page); const original = await existingDesign(page); const response = await mockImage(page);
  let requests = 0; let release!: () => void; let finished!: () => void;
  const responseReady = new Promise<void>((resolve) => { release = resolve; });
  const completed = new Promise<void>((resolve) => { finished = resolve; });
  await page.route('**/api/ai/generate', async (route) => {
    requests++; await responseReady;
    try { await fulfillImage(route, response); } catch { /* Browser already aborted this mocked request. */ }
    finally { finished(); }
  });
  await fillPrompt(page);
  await page.getByRole('button', { name: 'Generate design', exact: true }).click();
  await expect(page.getByText('Creating your design…', { exact: true })).toBeVisible();
  await expect.poll(() => requests).toBe(1);
  await page.getByRole('button', { name: 'Cancel generation', exact: true }).click();
  release(); await completed;
  await expect(page.getByRole('button', { name: 'Generate design', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Use this design', exact: true })).toHaveCount(0);
  expect(await documentJSON(page)).toBe(original); expect(await assetRecords(page)).toHaveLength(0);
});

test('mocked service, network and undecodable image failures preserve the design', async ({ page }) => {
  await openAI(page); const original = await existingDesign(page); const response = await mockImage(page);
  await fillPrompt(page);
  const failures: { respond: (route: Route) => Promise<void>; message: string }[] = [
    { respond: (route) => route.fulfill({ status: 503, json: { error: { code: 'PROVIDER_FAILURE', message: 'The image service is temporarily unavailable. Your design is unchanged.', requestId: 'mocked-failure', retryable: true } } }), message: 'The image service is temporarily unavailable' },
    { respond: (route) => route.abort('failed'), message: 'Could not reach the image service' },
    { respond: (route) => fulfillImage(route, { ...response, image: { ...response.image, base64: 'bm90IGFuIGltYWdl' } }), message: 'The returned artwork could not be decoded' },
  ];
  for (const failure of failures) {
    await page.route('**/api/ai/generate', failure.respond);
    await page.getByRole('button', { name: 'Generate design', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(failure.message);
    await expect(page.getByRole('button', { name: 'Generate design', exact: true })).toBeEnabled();
    expect(await documentJSON(page)).toBe(original);
    expect((await artworkState(page)).texts.map((node) => node.text)).toEqual(['Keep this existing design']);
    expect(await assetRecords(page)).toHaveLength(0);
    await page.unroute('**/api/ai/generate', failure.respond);
  }
});

test('mocked artwork is not previewed or applied when IndexedDB rejects storage', async ({ page }) => {
  await openAI(page); const original = await existingDesign(page); const response = await mockImage(page);
  await page.route('**/api/ai/generate', (route) => fulfillImage(route, response));
  await page.evaluate(() => { IDBObjectStore.prototype.put = () => { throw new DOMException('Test quota exhausted', 'QuotaExceededError'); }; });
  await fillPrompt(page); await page.getByRole('button', { name: 'Generate design', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not store the artwork on this device');
  await expect(page.getByRole('button', { name: 'Use this design', exact: true })).toHaveCount(0);
  expect(await documentJSON(page)).toBe(original);
  expect(await assetRecords(page)).toHaveLength(0);
});

test('mocked image-processing timeout exits loading without changing the document', async ({ page }) => {
  await openAI(page); const original = await existingDesign(page); const response = await mockImage(page);
  await page.route('**/api/ai/generate', (route) => fulfillImage(route, response));
  await page.clock.install();
  await page.evaluate(() => {
    HTMLImageElement.prototype.decode = function () {
      document.documentElement.setAttribute('data-mocked-pending-decode', 'true');
      return new Promise<void>(() => {});
    };
  });
  await fillPrompt(page);
  await page.getByRole('button', { name: 'Generate design', exact: true }).click();
  await expect(page.getByText('Creating your design…', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-mocked-pending-decode', 'true');
  await page.clock.fastForward(185001);
  await expect(page.getByRole('alert')).toContainText('Generation timed out. Your design is unchanged.');
  await expect(page.getByRole('button', { name: 'Generate design', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Use this design', exact: true })).toHaveCount(0);
  expect(await documentJSON(page)).toBe(original);
});

test('mocked timeout during image decoding clears loading and removes the abandoned asset', async ({ page }) => {
  await openAI(page); const original = await existingDesign(page); const response = await mockImage(page);
  await page.route('**/api/ai/generate', (route) => fulfillImage(route, response));
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await new Promise<void>((resolve) => { Object.defineProperty(window, 'releaseMockedDecode', { value: resolve, configurable: true }); });
      await decode.call(this);
    };
  });
  await fillPrompt(page); await page.clock.install();
  await page.getByRole('button', { name: 'Generate design', exact: true }).click();
  await page.waitForFunction(() => 'releaseMockedDecode' in window);
  await page.clock.fastForward(185_001);
  await page.evaluate(() => (window as unknown as { releaseMockedDecode: () => void }).releaseMockedDecode());
  await expect(page.getByRole('alert')).toContainText('Generation timed out. Your design is unchanged.');
  await expect(page.getByRole('button', { name: 'Generate design', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Use this design', exact: true })).toHaveCount(0);
  await expect.poll(() => assetRecords(page)).toEqual([]);
  expect(await documentJSON(page)).toBe(original);
});

test('mocked generated design retains editable text when its persisted artwork is missing', async ({ page }) => {
  await openAI(page); const response = await mockImage(page);
  await page.route('**/api/ai/generate', (route) => fulfillImage(route, response));
  await fillPrompt(page); await fillContent(page);
  await page.getByRole('button', { name: 'Generate design', exact: true }).click();
  await page.getByRole('button', { name: 'Use this design', exact: true }).click(); await saved(page);
  const applied = await project(page);
  await page.evaluate(async (assetId) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('frameflow-assets'); open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result; const transaction = database.transaction('assets', 'readwrite');
      transaction.objectStore('assets').delete(assetId);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  }), applied.variants[0].background!.assetId);
  await page.reload(); await saved(page);
  await expect(page.getByRole('alert')).toContainText('Artwork could not be recovered. Your text is safe.');
  expect(await project(page)).toEqual(applied);
  expect((await artworkState(page)).texts.map((node) => node.text)).toEqual(Object.values(exactContent));
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('list', { name: 'Text elements' }).getByRole('button').first().click();
  await expect(page.getByLabel('Text content')).toHaveValue(exactContent.eyebrow);
});
