import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { createAssetRepository } from '../../client/src/lib/assets/assetRepository';

// Compile the actual standalone repository into the browser test context.
// This tests native IndexedDB in both builds without shipping test hooks in the app.
const source = ts.transpileModule(readFileSync('client/src/lib/assets/assetRepository.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const fixture = readFileSync('tests/fixtures/asset.svg', 'utf8');

test('native IndexedDB preserves a local image Blob across reload and deletes safely', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async ({ source, fixture }) => {
    const module = new Function('exports', source + '; return exports;')({}) as { createAssetRepository: typeof createAssetRepository };
    const repository = module.createAssetRepository('fixture-assets');
    await repository.putAsset('green-square', new Blob([fixture], { type: 'image/svg+xml' }));
    const record = await repository.getAsset('green-square');
    return { exists: await repository.hasAsset('green-square'), mime: record?.mimeType, type: record?.blob.type, contents: await record?.blob.text(), createdAt: record?.createdAt };
  }, { source, fixture });
  expect(result).toMatchObject({ exists: true, mime: 'image/svg+xml', type: 'image/svg+xml', contents: fixture });
  expect(Number.isFinite(Date.parse(result.createdAt!))).toBe(true);
  await page.reload();
  const restored = await page.evaluate(async (source) => {
    const module = new Function('exports', source + '; return exports;')({}) as { createAssetRepository: typeof createAssetRepository };
    const repository = module.createAssetRepository('fixture-assets');
    const text = await (await repository.getAsset('green-square'))?.blob.text();
    await repository.deleteAsset('green-square'); await repository.deleteAsset('already-missing');
    return { text, exists: await repository.hasAsset('green-square'), missing: await repository.getAsset('green-square') };
  }, source);
  expect(restored).toEqual({ text: fixture, exists: false, missing: null });
});

test('asset open and write failures reject safely and preserve prior records', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async ({ source, fixture }) => {
    const module = new Function('exports', source + '; return exports;')({}) as { createAssetRepository: typeof createAssetRepository };
    const errors: string[] = [];
    const unavailable = module.createAssetRepository('unavailable', () => { throw new Error('Unavailable'); });
    try { await unavailable.getAsset('missing'); } catch { errors.push('open'); }
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('newer-version', 2);
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    try { await module.createAssetRepository('newer-version').getAsset('missing'); } catch { errors.push('version'); }
    const repository = module.createAssetRepository('write-failure');
    await repository.putAsset('existing', new Blob([fixture], { type: 'image/svg+xml' }));
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new DOMException('Full', 'QuotaExceededError'); };
    try { await repository.putAsset('existing', new Blob(['replacement'], { type: 'image/svg+xml' })); } catch { errors.push('write'); }
    finally { IDBObjectStore.prototype.put = original; }
    IDBObjectStore.prototype.put = function (value, key) {
      const request = original.call(this, value, key);
      this.transaction.abort();
      return request;
    };
    try { await repository.putAsset('existing', new Blob(['aborted'], { type: 'image/svg+xml' })); } catch { errors.push('abort'); }
    finally { IDBObjectStore.prototype.put = original; }
    return { errors, preserved: await (await repository.getAsset('existing'))?.blob.text(), missing: await repository.getAsset('unreferenced') };
  }, { source, fixture });
  expect(result).toEqual({ errors: ['open', 'version', 'write', 'abort'], preserved: fixture, missing: null });
});
