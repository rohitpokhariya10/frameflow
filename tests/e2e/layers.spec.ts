import { expect, test, type Page } from '@playwright/test';
import type { ProjectDocument } from '@frameflow/shared';
import type { Group } from 'konva/lib/Group';
import type { Shape } from 'konva/lib/Shape';
import type { Stage } from 'konva/lib/Stage';

const fixture: ProjectDocument = {
  schemaVersion: 1, id: 'local-layer-fixture', name: 'Layer editing', createdAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z',
  variants: [{ id: 'original', name: 'Original', revision: 0, canvas: { width: 1080, height: 1350, backgroundColor: '#fffefa' }, elements: [], layers: [
    { id: 'panel', name: 'Orange panel', type: 'shape', shapeType: 'rounded-rectangle', x: 100, y: 400, width: 850, height: 700, rotation: 0, opacity: 1, visible: true, locked: false, fill: '#ff6a00', radius: 50, gradient: { from: '#ff6a00', to: '#ffb060', angle: 45 } },
    { id: 'circle', name: 'Green circle', type: 'shape', shapeType: 'ellipse', x: 550, y: 750, width: 280, height: 280, rotation: 0, opacity: 1, visible: true, locked: false, fill: '#285443', radius: 0 },
    { id: 'image', name: 'Local artwork', type: 'image', assetId: 'layer-fixture-image', x: 140, y: 140, width: 300, height: 300, rotation: 0, opacity: 1, visible: true, locked: false },
  ] }],
};

async function seed(page: Page) {
  // Seed a recovered document and an existing local asset: no generation or provider calls.
  await page.goto('/');
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.evaluate(async document => {
    const canvas = window.document.createElement('canvas'); canvas.width = 80; canvas.height = 80;
    const context = canvas.getContext('2d')!; context.fillStyle = '#668aee'; context.fillRect(0, 0, 80, 80);
    context.fillStyle = '#ffffff'; context.fillRect(20, 20, 40, 40);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('frameflow-assets', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('assets', { keyPath: 'id' });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result, transaction = database.transaction('assets', 'readwrite');
        transaction.objectStore('assets').put({ id: 'layer-fixture-image', blob, mimeType: blob.type, createdAt: document.createdAt });
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
      };
    });
    localStorage.setItem('frameflow:project:v1', JSON.stringify(document));
  }, fixture);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Layers', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Something good/ })).toHaveCount(0);
  await expect(page.locator('.workspace-heading')).toContainText('3 layers');
}
const rows = (page: Page) => page.getByRole('list', { name: 'Design layers' });
const row = (page: Page, id: string) => rows(page).locator(`[data-layer-id="${id}"]`);
const order = (page: Page) => rows(page).locator('.layer-name').allTextContents();
async function canvasState(page: Page) {
  return page.evaluate(() => {
    const stage = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0];
    const rect = stage.container().getBoundingClientRect();
    return { left: rect.x, top: rect.y, zoom: stage.scaleX(), transformers: stage.find('.layer-transformer').length,
      layers: stage.find<Group>('.design-layer').map(node => {
        const shape = node.findOne<Shape>('.layer-shape');
        return { id: node.id(), x: node.x(), y: node.y(), draggable: node.draggable(), fill: shape?.fill(), gradient: shape?.fillLinearGradientColorStops(), start: shape?.fillLinearGradientStartPoint(), end: shape?.fillLinearGradientEndPoint() };
      }),
    };
  });
}
async function savedLayers(page: Page) {
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  return page.evaluate(() => (JSON.parse(localStorage.getItem('frameflow:project:v1')!) as ProjectDocument).variants[0].layers!);
}

test('layer thumbnails, lock/unlock and visibility reflect canvas state and survive reload', async ({ page }, testInfo) => {
  await seed(page);
  await expect(row(page, 'image').locator('.layer-thumbnail img')).toBeVisible();
  await expect.poll(() => row(page, 'image').locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(row(page, 'panel').locator('linearGradient stop')).toHaveCount(2);
  await expect(row(page, 'circle').locator('.layer-thumbnail ellipse')).toBeVisible();
  await row(page, 'image').locator('.layer-select').click();
  await expect.poll(async () => (await canvasState(page)).transformers).toBe(1);
  await row(page, 'image').getByRole('button', { name: 'Lock Local artwork', exact: true }).click();
  await expect(row(page, 'image').getByRole('button', { name: 'Unlock Local artwork' })).toHaveAttribute('aria-pressed', 'true');
  const locked = await canvasState(page);
  expect(locked.transformers).toBe(0);
  expect(locked.layers.find(layer => layer.id === 'image')?.draggable).toBe(false);
  const x = locked.left + 250 * locked.zoom, y = locked.top + 250 * locked.zoom;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 70, y + 35, { steps: 6 }); await page.mouse.up();
  expect((await canvasState(page)).layers.find(layer => layer.id === 'image')).toMatchObject({ x: 140, y: 140 });
  await savedLayers(page); await page.reload();
  await expect(row(page, 'image').getByRole('button', { name: 'Unlock Local artwork' })).toBeVisible();
  await row(page, 'image').getByRole('button', { name: 'Unlock Local artwork' }).click();
  await row(page, 'image').locator('.layer-select').click();
  await expect.poll(async () => (await canvasState(page)).transformers).toBe(1);
  expect((await canvasState(page)).layers.find(layer => layer.id === 'image')?.draggable).toBe(true);
  await row(page, 'image').getByRole('button', { name: 'Hide Local artwork' }).click();
  expect((await canvasState(page)).layers.some(layer => layer.id === 'image')).toBe(false);
  await row(page, 'image').getByRole('button', { name: 'Show Local artwork' }).click();
  await page.screenshot({ path: testInfo.outputPath('editor-layer-thumbnails.png'), fullPage: true });
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(page.getByRole('complementary', { name: 'Properties' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Properties' })).toBeHidden();
});

test('drag reorder changes canvas stack in one undo step; keyboard reordering persists', async ({ page }) => {
  await seed(page);
  expect(await order(page)).toEqual(['Local artwork', 'Green circle', 'Orange panel']);
  const target = row(page, 'panel'), bounds = (await target.boundingBox())!;
  await row(page, 'image').getByRole('button', { name: 'Reorder Local artwork' }).dragTo(target, { targetPosition: { x: bounds.width / 2, y: bounds.height - 3 } });
  await expect.poll(() => order(page)).toEqual(['Green circle', 'Orange panel', 'Local artwork']);
  expect((await canvasState(page)).layers.map(layer => layer.id)).toEqual(['image', 'panel', 'circle']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await order(page)).toEqual(['Local artwork', 'Green circle', 'Orange panel']);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  const grip = row(page, 'image').getByRole('button', { name: 'Reorder Local artwork' });
  await grip.focus(); await grip.press('ArrowUp');
  expect(await order(page)).toEqual(['Green circle', 'Local artwork', 'Orange panel']);
  await expect(grip).toBeFocused();
  await grip.press('Home'); await grip.press('ArrowUp');
  expect(await order(page)).toEqual(['Local artwork', 'Green circle', 'Orange panel']);
  await grip.press('End'); await grip.press('ArrowDown');
  expect(await order(page)).toEqual(['Green circle', 'Orange panel', 'Local artwork']);
  expect((await savedLayers(page)).map(layer => layer.id)).toEqual(['image', 'panel', 'circle']);
  await page.reload();
  expect(await order(page)).toEqual(['Green circle', 'Orange panel', 'Local artwork']);
});

test('gradient stops and angle update canvas and thumbnail, undo together and persist', async ({ page }, testInfo) => {
  await seed(page);
  await row(page, 'panel').locator('.layer-select').click();
  await expect(page.getByLabel('Fill style')).toHaveValue('gradient');
  await page.getByLabel('Gradient start colour').fill('#123456');
  await page.getByLabel('Gradient end colour').fill('#abcdef');
  const angle = page.getByRole('spinbutton', { name: 'Gradient angle' });
  await angle.fill('60'); await angle.fill('90'); await angle.press('Tab');
  let panel = (await canvasState(page)).layers.find(layer => layer.id === 'panel')!;
  expect(panel.gradient).toEqual([0, '#123456', 1, '#abcdef']);
  expect(panel.start?.x).toBeCloseTo(panel.end!.x);
  expect(panel.end!.y).toBeGreaterThan(panel.start!.y);
  await expect(row(page, 'panel').locator('stop').first()).toHaveAttribute('stop-color', '#123456');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(angle).toHaveValue('45');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(angle).toHaveValue('90');
  await page.getByLabel('Fill style').selectOption('solid');
  await page.getByLabel('Fill', { exact: true }).fill('#563412');
  panel = (await canvasState(page)).layers.find(layer => layer.id === 'panel')!;
  expect(panel.fill).toBe('#563412');
  await expect(row(page, 'panel').locator('.layer-thumbnail rect')).toHaveAttribute('fill', '#563412');
  await page.getByLabel('Fill style').selectOption('gradient');
  await page.getByLabel('Gradient end colour').fill('#ee9966');
  await page.getByRole('spinbutton', { name: 'Gradient angle' }).fill('-45');
  expect((await savedLayers(page)).find(layer => layer.id === 'panel')).toMatchObject({ gradient: { from: '#563412', to: '#ee9966', angle: -45 } });
  await page.reload(); await row(page, 'panel').locator('.layer-select').click();
  await expect(page.getByLabel('Gradient start colour')).toHaveValue('#563412');
  await expect(page.getByLabel('Gradient end colour')).toHaveValue('#ee9966');
  await expect(page.getByRole('spinbutton', { name: 'Gradient angle' })).toHaveValue('-45');
  await page.getByRole('spinbutton', { name: 'Gradient angle' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('spinbutton', { name: 'Gradient angle' })).toBeInViewport();
  await expect(row(page, 'panel')).toBeInViewport();
  const listBounds = (await rows(page).boundingBox())!, launcher = (await page.getByRole('button', { name: 'Image to layers' }).boundingBox())!;
  expect(listBounds.y + listBounds.height).toBeLessThanOrEqual(launcher.y);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('editor-gradient-controls.png'), fullPage: true });
});
