import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const shots = 'artifacts/decomposition/e2e/editable-canvas';
type SceneLayer = { id: string; type: string; name: string; bbox: { x: number; y: number; width: number; height: number }; shapeType?: string; text?: string };
type Job = { id: string; state: string; sceneGraph?: { width: number; height: number; layers: SceneLayer[] } };
const layersList = (page: Page) => page.locator('section[aria-label="Layers"]');
const inspector = (page: Page) => page.locator('.layer-inspector');
const layerButton = (page: Page, name: RegExp) => layersList(page).locator('.layer-select').filter({ hasText: name }).first();

test('open a decomposed poster as an editable design: layers move, transform, hide, duplicate, delete, convert text, persist and export', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  const job = ((await (await page.request.get('/api/decomposition/jobs')).json()) as { jobs: Job[] }).jobs[0];
  expect(job.state).toBe('completed');
  const graph = job.sceneGraph!;
  expect(graph.layers[0].type).toBe('background');
  const image = graph.layers.find(l => l.type === 'image')!, text = graph.layers.find(l => l.type === 'text');
  // At least one shape must come back as an editable vector (an unoccluded bar/panel).
  const shape = graph.layers.find(l => l.type === 'shape' && l.shapeType !== 'raster');
  expect(image).toBeTruthy(); expect(shape).toBeTruthy();

  await page.getByRole('button', { name: 'Decompose image' }).click();
  const dialog = page.getByRole('dialog', { name: 'Image decomposition' });
  await dialog.locator('summary', { hasText: 'Recover jobs' }).click();
  await dialog.getByRole('button', { name: /completed · phase 6/ }).first().click();
  const editable = dialog.locator('section[aria-label="Editable design"]');
  await expect(editable).toContainText(`${graph.layers.length} layers at ${graph.width} × ${graph.height} px`);
  await editable.screenshot({ path: `${shots}/01-editable-design-summary.png` });
  await editable.getByRole('button', { name: 'Open as editable design' }).click();
  await expect(dialog).toBeHidden();

  // A new version at native resolution with every non-background scene layer in the Layers list.
  await expect(page.getByTestId('canvas-dimensions')).toContainText(`${graph.width} × ${graph.height}`);
  for (const layer of graph.layers.filter(l => l.type !== 'background')) await expect(layerButton(page, new RegExp(layer.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeVisible();
  await expect(layerButton(page, new RegExp(shape!.name))).toContainText(shape!.shapeType!.replace('-', ' '));
  const frame = page.getByTestId('canvas-frame');
  await page.waitForTimeout(500);
  await frame.screenshot({ path: `${shots}/02-imported-canvas.png` });

  // Select the image layer; move it with the inspector, then drag it on the canvas.
  await layerButton(page, new RegExp(image.name)).click();
  await expect(inspector(page).getByRole('heading', { name: 'Layer' })).toBeVisible();
  await expect(inspector(page).getByLabel('X')).toHaveValue(String(image.bbox.x));
  await inspector(page).getByLabel('X').fill(String(image.bbox.x + 150));
  await expect(inspector(page).getByLabel('X')).toHaveValue(String(image.bbox.x + 150));
  const box = (await frame.boundingBox())!, zoom = box.width / graph.width;
  const cx = box.x + (image.bbox.x + 150 + image.bbox.width / 2) * zoom, cy = box.y + (image.bbox.y + image.bbox.height / 2) * zoom;
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx - 60, cy + 30, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => Number(await inspector(page).getByLabel('X').inputValue())).toBeLessThan(image.bbox.x + 150 - 20);
  await inspector(page).getByLabel('Rotation').fill('-8');
  await inspector(page).getByLabel('Opacity').fill('60');
  await expect(inspector(page)).toContainText('Opacity 60%');
  await page.waitForTimeout(300);
  await frame.screenshot({ path: `${shots}/03-moved-rotated-image-layer.png` });

  // Hide/show, duplicate and delete.
  const count = await layersList(page).locator('li').count();
  await layersList(page).getByRole('button', { name: new RegExp(`^Hide ${image.name}`) }).click();
  await expect(layerButton(page, new RegExp(image.name))).toContainText('hidden');
  await layersList(page).getByRole('button', { name: new RegExp(`^Show ${image.name}`) }).click();
  await layerButton(page, new RegExp(image.name)).click();
  await inspector(page).getByRole('button', { name: 'Duplicate' }).click();
  await expect(layersList(page).locator('li')).toHaveCount(count + 1);
  await expect(inspector(page).getByLabel('Layer name')).toHaveValue(`${image.name} copy`);
  await inspector(page).getByRole('button', { name: 'Delete' }).click();
  await expect(layersList(page).locator('li')).toHaveCount(count);

  // Vector shape: recolour and add a stroke.
  {
    await layerButton(page, new RegExp(shape!.name)).click();
    await inspector(page).getByLabel('Fill').fill('#2255aa');
    await expect(inspector(page).getByLabel('Fill')).toHaveValue('#2255aa');
    await inspector(page).getByLabel('Stroke width').fill('6');
    await page.waitForTimeout(300);
    await frame.screenshot({ path: `${shots}/04-recoloured-shape.png` });
  }

  // Text raster → editable text element with the (unverified) suggestion; then edit the wording.
  if (text) {
    await layerButton(page, new RegExp(text.name)).click();
    await expect(inspector(page)).toContainText('Text image.');
    await inspector(page).getByRole('button', { name: 'Convert to editable text' }).click();
    const content = page.getByLabel('Text content');
    await expect(content).toHaveValue(text.text || 'Edit this text');
    await content.fill('PRO MAX');
    await expect(content).toHaveValue('PRO MAX');
    await page.waitForTimeout(300);
    await frame.screenshot({ path: `${shots}/05-converted-text.png` });
  }

  // Reload: the decomposed version, its layers and edits persist in this browser.
  await page.waitForTimeout(1500);
  await page.reload();
  const versions = page.getByLabel('Active version');
  await versions.selectOption({ label: await versions.locator('option').last().innerText() });
  await expect(page.getByTestId('canvas-dimensions')).toContainText(`${graph.width} × ${graph.height}`);
  await layerButton(page, new RegExp(image.name)).click();
  expect(Number(await inspector(page).getByLabel('X').inputValue())).toBeLessThan(image.bbox.x + 150 - 20);
  await expect(inspector(page).getByLabel('Rotation')).toHaveValue('-8');

  // Export: a PNG at native resolution including layers.
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const file = await waiting;
  expect(await file.failure()).toBeNull();
  const bytes = await readFile((await file.path())!);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([graph.width, graph.height]);
  await file.saveAs(`${shots}/06-export.png`);
  expect(errors).toEqual([]);
});
