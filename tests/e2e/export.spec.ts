import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createTextElement, type ProjectDocument } from '@frameflow/shared';
import { createDocument } from '../../client/src/store/editorSlice';
import type { Stage } from 'konva/lib/Stage';

const key = 'frameflow:project:v1';
async function seed(page: Page, width = 1080, height = 1350, missing = false) {
  await page.route('**/api/ai/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  const doc = createDocument('export-fixture', '2026-09-22T00:00:00.000Z');
  const variant = doc.variants[0];
  variant.canvas = { width, height, backgroundColor: '#fffafa' };
  variant.background = { assetId: 'export-artwork', fit: 'cover', focalPoint: { x: .5, y: .5 } };
  variant.elements = [
    { ...createTextElement('heading', variant.canvas, 'heading'), text: 'Aarav & Meera\nTogether', fill: '#112233' },
    { ...createTextElement('body', variant.canvas, 'venue'), text: '12 December 2026 · 7 PM\nThe Grand Royal Wedding Palace, New Delhi', fill: '#112233' },
  ];
  await page.evaluate(async ({ doc, key, missing }) => {
    if (!missing) {
      const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 200;
      const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fcf8ef'; ctx.fillRect(0, 0, 400, 200);
      ctx.fillStyle = '#b39a60'; ctx.beginPath(); ctx.arc(200, 100, 85, 0, Math.PI * 2); ctx.fill();
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!)));
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('frameflow-assets', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('assets', { keyPath: 'id' });
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('assets', 'readwrite');
          tx.objectStore('assets').put({ id: 'export-artwork', blob, mimeType: 'image/png', createdAt: doc.createdAt });
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
        };
      });
    }
    localStorage.setItem(key, JSON.stringify(doc));
  }, { doc, key, missing });
  await page.reload();
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  return doc;
}
async function download(page: Page) {
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const file = await waiting;
  expect(await file.failure()).toBeNull();
  const bytes = await readFile((await file.path())!);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await expect(page.getByRole('button', { name: 'Export PNG', exact: true })).toBeEnabled();
  return { bytes, filename: file.suggestedFilename() };
}
async function inspect(page: Page, bytes: Buffer) {
  return page.evaluate(async (base64) => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let text = 0, gold = 0, transparent = 0, selection = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] === 17 && pixels[i + 1] === 34 && pixels[i + 2] === 51) text++;
      if (pixels[i] === 179 && pixels[i + 1] === 154 && pixels[i + 2] === 96) gold++;
      if (pixels[i] === 40 && pixels[i + 1] === 84 && pixels[i + 2] === 67) selection++;
      if (pixels[i + 3] !== 255) transparent++;
    }
    return { width: canvas.width, height: canvas.height, text, gold, transparent, selection };
  }, bytes.toString('base64'));
}
const stored = (page: Page) => page.evaluate((key) => localStorage.getItem(key), key);
const transformers = (page: Page) => page.evaluate(() => (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages.reduce((count, stage) => count + stage.find('Transformer').length, 0));

for (const [width, height, format] of [[1080, 1350, 'poster'], [1600, 900, 'landscape'], [1080, 1080, 'square'], [1080, 1920, 'story'], [1000, 1000, 'custom'], [4096, 256, 'custom'], [256, 4096, 'custom']] as const) {
  test(`PNG ${width}x${height} includes artwork/text and excludes selected UI regardless of zoom`, async ({ page }, testInfo) => {
    await seed(page, width, height);
    await page.getByRole('tab', { name: 'Text', exact: true }).click();
    await page.getByRole('button', { name: /Aarav & Meera/ }).click();
    await expect.poll(() => transformers(page)).toBe(1);
    const before = await stored(page), zoom = await page.getByLabel('Current zoom').textContent();
    const selected = await download(page);
    expect(selected.filename).toBe(`frameflow-${format}-${width}x${height}.png`);
    const pixels = await inspect(page, selected.bytes);
    expect(pixels).toMatchObject({ width, height, selection: 0, transparent: 0 }); expect(pixels.text).toBeGreaterThan(10); expect(pixels.gold).toBeGreaterThan(100);
    expect(await stored(page)).toBe(before); expect(await transformers(page)).toBe(1);
    await expect(page.getByLabel('Current zoom')).toHaveText(zoom!);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    expect((await download(page)).bytes).toEqual(selected.bytes);
    await page.locator('#canvas-interaction').focus(); await page.keyboard.press('Escape');
    await expect.poll(() => transformers(page)).toBe(0);
    expect((await download(page)).bytes).toEqual(selected.bytes);
    await page.getByRole('button', { name: /Aarav & Meera/ }).click();
    await page.getByLabel('Text content').fill('Still editable'); await page.getByLabel('Text content').blur();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    if (width === 1080 && height === 1350 || width === 1000) await testInfo.attach('export-preview', { body: selected.bytes, contentType: 'image/png' });
  });
}

test('exports active source and adapted target after switching, including comparison view', async ({ page }) => {
  const doc = await seed(page);
  const source = doc.variants[0];
  doc.variants.push({ ...source, id: 'adapted', name: 'Landscape', sourceVariantId: source.id,
    canvas: { ...source.canvas, width: 1600, height: 900 }, elements: source.elements.map((e) => ({ ...e, x: 720, y: e.y * .6, width: 750, align: 'left' })) });
  await page.evaluate(({ doc, key }) => localStorage.setItem(key, JSON.stringify(doc)), { doc, key }); await page.reload();
  expect((await download(page)).filename).toBe('frameflow-poster-1080x1350.png');
  await page.getByLabel('Active version').selectOption('adapted');
  await page.getByRole('button', { name: 'Compare versions' }).click();
  const target = await download(page); expect(target.filename).toBe('frameflow-landscape-1600x900.png');
  expect(await inspect(page, target.bytes)).toMatchObject({ width: 1600, height: 900 });
  await page.getByLabel('Active version').selectOption(source.id);
  expect((await download(page)).filename).toBe('frameflow-poster-1080x1350.png');
  expect(JSON.parse((await stored(page))!) as ProjectDocument).toEqual(doc);
});

for (const failure of ['missing', 'decode', 'font', 'canvas', 'download'] as const) test(`export ${failure} failure is actionable and preserves editing`, async ({ page }) => {
  await seed(page, 1080, 1350, failure === 'missing');
  const before = await stored(page);
  await page.evaluate((failure) => {
    if (failure === 'decode') HTMLImageElement.prototype.decode = async () => { throw new Error('decode'); };
    if (failure === 'font') document.fonts.load = async () => { throw new Error('fonts'); };
    if (failure === 'canvas') HTMLCanvasElement.prototype.toBlob = function (callback) { callback(null); };
    if (failure === 'download') HTMLAnchorElement.prototype.click = () => { throw new Error('download'); };
  }, failure);
  let downloads = 0; page.on('download', () => { downloads++; });
  await page.getByRole('button', { name: 'Export PNG' }).click();
  await expect(page.locator('.export-error')).toContainText(failure === 'missing' || failure === 'decode' ? 'Artwork could not load' : failure === 'font' ? 'Fonts could not load' : failure === 'canvas' ? 'free memory' : 'Allow downloads');
  await expect(page.getByRole('button', { name: 'Export PNG' })).toBeEnabled();
  expect(downloads).toBe(0); expect(await stored(page)).toBe(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('waits for fonts, prevents duplicate exports and uses the variant snapshot from the click', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    const original = document.fonts.load.bind(document.fonts);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    Object.assign(window, { releaseExportFonts: release });
    document.fonts.load = async (...args) => { await wait; return original(...args); };
  });
  let downloads = 0; page.on('download', () => { downloads++; });
  await page.getByRole('button', { name: 'Export PNG' }).click();
  await expect(page.getByRole('button', { name: 'Exporting…' })).toBeDisabled(); expect(downloads).toBe(0);
  await page.getByRole('button', { name: /^Landscape/ }).click();
  const pending = page.waitForEvent('download');
  await page.evaluate(() => (window as unknown as { releaseExportFonts: () => void }).releaseExportFonts());
  expect((await pending).suggestedFilename()).toBe('frameflow-poster-1080x1350.png');
  await expect(page.getByRole('button', { name: 'Export PNG' })).toBeEnabled(); expect(downloads).toBe(1);
  await expect(page.getByTestId('canvas-dimensions')).toHaveText('1600 × 900 px');
});
