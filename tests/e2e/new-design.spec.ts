import { expect, test, type Page } from '@playwright/test';
import type { ImageResponse } from '@frameflow/shared';
const key = 'frameflow:project:v1';
const saved = (page: Page) => expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
const documentJSON = (page: Page) => page.evaluate((key) => localStorage.getItem(key), key);
async function assetIds(page: Page) {
  return page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const request = indexedDB.open('frameflow-assets');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('assets'), read = tx.objectStore('assets').getAllKeys();
      tx.oncomplete = () => { db.close(); resolve(read.result as string[]); };
      tx.onabort = () => reject(tx.error);
    };
  }));
}
async function setup(page: Page) {
  await page.route('**/api/health', route => route.fulfill({ json: { status: 'ok', provider: 'cloudflare', aiConfigured: true, aiAvailable: true } }));
  // Catch-all guarantees that no provider request escapes any reset test.
  await page.route('**/api/ai/**', route => route.abort());
  await page.goto('/'); await saved(page);
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 200;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#d6be87'; ctx.fillRect(0, 0, 160, 200);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const response: ImageResponse = { requestId: 'mocked-reset', image: { base64, mimeType: 'image/png', width: 160, height: 200 },
    generation: { mode: 'live', provider: 'cloudflare', model: 'mocked', requestedAspectRatio: '4:5', promptUsed: 'Artwork only' } };
  await page.route('**/api/ai/generate', route => route.fulfill({ json: response }));
  await page.route('**/api/ai/adapt', route => route.fulfill({ json: response }));
  return response;
}
async function source(page: Page) {
  await page.getByRole('textbox', { name: 'Design name', exact: true }).fill('Keep this project');
  await page.getByRole('textbox', { name: 'Design name', exact: true }).press('Enter');
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await page.getByLabel('Artwork direction').fill('Gold geometry, no lettering');
  await page.getByLabel('Event title', { exact: true }).fill('FitnessHUB');
  await page.getByRole('button', { name: 'Generate design', exact: true }).click();
  await page.getByRole('button', { name: 'Use this design', exact: true }).click(); await saved(page);
}
async function confirmReset(page: Page) {
  await page.getByRole('button', { name: 'New design', exact: true }).click();
  await page.getByRole('button', { name: 'Start new design', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); await saved(page);
}
async function fresh(page: Page) {
  await expect(page.getByRole('textbox', { name: 'Design name', exact: true })).toHaveValue('New design');
  await expect(page.getByTestId('canvas-dimensions')).toHaveText('1080 × 1350 px');
  await expect(page.getByLabel('Active version')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await expect(page.getByText('No selection', { exact: true })).toBeVisible();
  const doc = JSON.parse((await documentJSON(page))!);
  expect(doc.name).toBe('New design'); expect(doc.variants).toHaveLength(1);
  expect(doc.variants[0].elements).toEqual([]); expect(doc.variants[0].background).toBeUndefined();
  await expect(page.getByRole('tab', { name: 'Design', exact: true })).toHaveAttribute('aria-selected', 'true');
}

test('confirmed new design removes applied variants and preview assets, persists and remains usable', async ({ page }, info) => {
  await setup(page); await source(page);
  await page.getByRole('button', { name: 'Adapt format', exact: true }).click();
  await page.getByRole('button', { name: 'Adapt artwork', exact: true }).click();
  await page.getByRole('button', { name: 'Use this version', exact: true }).click(); await saved(page);
  await page.getByRole('button', { name: 'Adapt artwork', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this version', exact: true })).toBeEnabled();
  expect(await assetIds(page)).toHaveLength(3);
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    localStorage.setItem('unrelated-setting', 'preserve');
    const request = indexedDB.open('frameflow-assets');
    request.onsuccess = () => { const db = request.result, tx = db.transaction('assets', 'readwrite');
      tx.objectStore('assets').put({ id: 'unrelated-art', blob: new Blob(['unrelated'], { type: 'image/png' }) });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); };
  }));
  const before = await documentJSON(page);
  await page.getByRole('button', { name: 'New design', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Start a new design?' });
  await expect(dialog).toBeVisible(); await expect(dialog).toHaveAccessibleDescription(/cannot be undone/);
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(page.getByRole('button', { name: 'Start new design', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.screenshot({ path: info.outputPath('new-design-confirmation.png') });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await documentJSON(page)).toBe(before); expect(await assetIds(page)).toHaveLength(4);
  await expect(page.getByRole('button', { name: 'New design', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'New design', exact: true }).click(); await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); expect(await documentJSON(page)).toBe(before);
  await expect(page.getByRole('button', { name: 'Use this version', exact: true })).toBeEnabled();
  await confirmReset(page); await fresh(page);
  expect(await assetIds(page)).toEqual(['unrelated-art']);
  expect(await page.evaluate(() => localStorage.getItem('unrelated-setting'))).toBe('preserve');
  const reset = await documentJSON(page); expect(JSON.parse(reset!).id).not.toBe(JSON.parse(before!).id);
  await page.keyboard.press('ControlOrMeta+z'); expect(await documentJSON(page)).toBe(reset);
  await page.screenshot({ path: info.outputPath('new-design-fresh.png') });
  await page.reload(); await saved(page); await fresh(page); expect(await documentJSON(page)).toBe(reset);
  await page.getByRole('button', { name: 'Add heading', exact: true }).click();
  await page.getByLabel('Text content').fill('A fresh start'); await page.getByLabel('Text content').blur(); await saved(page);
  await expect(page.getByLabel('Text content')).toHaveValue('A fresh start');
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('frameflow-poster-1080x1350.png');
});

for (const operation of ['generate', 'adapt'] as const) test(`reset invalidates a delayed ${operation} response without reviving artwork`, async ({ page }) => {
  const response = await setup(page);
  if (operation === 'adapt') { await source(page); await page.getByRole('button', { name: 'Adapt format', exact: true }).click(); }
  else { await page.getByRole('tab', { name: 'AI', exact: true }).click(); await page.getByLabel('Artwork direction').fill('No text, gold shapes'); }
  let release!: () => void; let started = false, completed = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/ai/${operation}`, async route => { started = true; await gate; await route.fulfill({ json: response }).catch(() => undefined); completed = true; });
  await page.getByRole('button', { name: operation === 'generate' ? 'Generate design' : 'Adapt artwork', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await confirmReset(page); const reset = await documentJSON(page); release(); await expect.poll(() => completed).toBe(true);
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await expect(page.getByLabel('Artwork direction')).toHaveValue('');
  await expect(page.getByLabel('Event title', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Generate design', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Use this (design|version)/ })).toHaveCount(0);
  expect(await documentJSON(page)).toBe(reset);
  if (operation === 'adapt') expect(await assetIds(page)).toEqual([]);
  await page.reload(); await saved(page); await fresh(page); expect(await documentJSON(page)).toBe(reset);
});

test('reset saves fresh state before old debounced edits and reports storage failure without deleting the project', async ({ page }) => {
  await setup(page); await source(page); const before = await documentJSON(page), ids = await assetIds(page);
  await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
    if (key === 'frameflow:project:v1' && JSON.parse(value).name === 'New design') throw new Error('blocked');
    return original.call(this, key, value);
  }; });
  await page.getByRole('button', { name: 'New design', exact: true }).click();
  await page.getByRole('button', { name: 'Start new design', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Your current project is unchanged');
  expect(await documentJSON(page)).toBe(before); expect(await assetIds(page)).toEqual(ids);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.reload(); await saved(page);
  await page.getByRole('textbox', { name: 'Design name', exact: true }).fill('Pending old name');
  await page.getByRole('textbox', { name: 'Design name', exact: true }).press('Enter');
  await confirmReset(page); const reset = await documentJSON(page);
  await page.reload(); await saved(page); await fresh(page); expect(await documentJSON(page)).toBe(reset);
});

test('unapplied generation is cleared and failed asset cleanup can be retried safely', async ({ page }) => {
  await setup(page);
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await page.getByLabel('Artwork direction').fill('Gold geometry');
  await page.getByLabel('Event title', { exact: true }).fill('Preview only');
  await page.getByRole('button', { name: 'Generate design', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this design', exact: true })).toBeVisible();
  expect(await assetIds(page)).toHaveLength(1);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.delete; let fail = true;
    IDBObjectStore.prototype.delete = function(key) {
      const request = original.call(this, key);
      if (fail) { fail = false; this.transaction.abort(); }
      return request;
    };
  });
  await page.getByRole('button', { name: 'New design', exact: true }).click();
  await page.getByRole('button', { name: 'Start new design', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Your new design is ready');
  const reset = await documentJSON(page); expect(JSON.parse(reset!).name).toBe('New design');
  expect(await assetIds(page)).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry cleanup', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); await fresh(page);
  expect(await assetIds(page)).toEqual([]); expect(await documentJSON(page)).toBe(reset);
});
