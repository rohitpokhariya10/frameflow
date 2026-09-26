import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, test, type Page } from '@playwright/test';
import type { DecompositionJobSummary, SceneGraph } from '@frameflow/shared';

/**
 * Opening separated layers in the editor: on a blank canvas (no original image underneath) or on the original image,
 * choosing only some detected layers, and adding the rest later from "Detected layers". Runs on the isolated E2E
 * stack (no provider key; deterministic fake segmentation). The synthetic poster is a flat beige image with a green
 * footer bar, so exported pixels show exactly whether the original image is on the canvas.
 */
const shots = process.env.DECOMP_E2E_SHOTS ?? 'artifacts/decomposition/ux';
const data = () => process.env.DECOMP_E2E_DATA!;
const fakeCalls = (jobId: string) => { const file = join(data(), 'e2e-fake-calls.log'); return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(line => line.includes(jobId)) : []; };
const getJob = async (page: Page, id: string): Promise<DecompositionJobSummary> => (await page.request.get(`/api/decomposition/jobs/${id}`)).json();
const exact = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const layerRow = (page: Page, name: string) => page.locator('.ws-layer').filter({ has: page.locator('.ws-layer-name', { hasText: exact(name) }) });
const designLayers = (page: Page) => page.locator('ul[aria-label="Design layers"] > li');
const tray = (page: Page) => page.getByRole('region', { name: 'Detected layers' });
const trayItem = (page: Page, name: string) => tray(page).locator('li[data-detected]').filter({ has: page.locator('.detected-name', { hasText: exact(name) }) });
const BEIGE = [244, 239, 232], GREEN = [47, 111, 94];
const WANTED = { 'PRO headline': 'add', 'Footer bar': 'add', 'Woman holding phone': 'add', 'Orange main panel': 'later', Phone: 'later', Sticker: 'later' } as const;
let jobId = '';

async function openFixture(page: Page, name: string) {
  const fixtures = JSON.parse(readFileSync(join(data(), 'e2e-state-jobs.json'), 'utf8')) as Record<string, string>;
  await page.goto('/');
  await page.getByRole('button', { name: 'Image to layers' }).click();
  await page.locator(`[data-job-id="${fixtures[name]}"]`).getByRole('button', { name: 'Continue', exact: true }).click();
  return fixtures[name];
}
/** Reopen the workspace on the finished design, from the remembered job or from Recent designs. */
async function openReady(page: Page) {
  await page.getByRole('button', { name: 'Image to layers' }).click();
  const ready = page.getByRole('heading', { name: 'Your editable design is ready' }), recent = page.locator(`[data-job-id="${jobId}"]`);
  await expect(ready.or(recent)).toBeVisible();
  if (!await ready.isVisible()) await recent.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(ready).toBeVisible();
}
async function selectLayer(page: Page, name: string) {
  await page.locator('section[aria-label="Layers"] .layer-select').filter({ has: page.locator('.layer-name', { hasText: exact(name) }) }).click();
  return page.locator('.layer-inspector');
}
async function position(page: Page, name: string) {
  const inspector = await selectLayer(page, name);
  return { x: Number(await inspector.getByLabel('X', { exact: true }).inputValue()), y: Number(await inspector.getByLabel('Y', { exact: true }).inputValue()), width: Number(await inspector.getByLabel('Width', { exact: true }).inputValue()), height: Number(await inspector.getByLabel('Height', { exact: true }).inputValue()) };
}
/** Export the active version and read pixels from the PNG a customer would download. */
async function exportedPixels(page: Page) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG' }).click();
  const file = await (await download).path();
  const { data: raw, info } = await sharp(readFileSync(file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return (x: number, y: number) => [...raw.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
}
const near = (actual: number[], rgb: number[]) => actual.slice(0, 3).every((v, i) => Math.abs(v - rgb[i]) <= 6) && actual[3] === 255;

test.describe.configure({ mode: 'serial' });
// One browser profile for the whole file, like a returning customer: the editor keeps its design in browser storage.
let page: Page;
test.beforeAll(async ({ browser }, info) => { page = await (await browser.newContext({ baseURL: info.project.use.baseURL, viewport: info.project.use.viewport, acceptDownloads: true })).newPage(); });
test.afterAll(async () => { await page.context().close(); });

test('A. choose 3 of 6 detected layers, exclude the background, open on a blank canvas: no original image underneath', async () => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  jobId = await openFixture(page, 'editor-modes');
  await expect(page.getByRole('heading', { name: 'Review detected layers' })).toBeVisible();
  // All detected layers are listed; the background is a separate, optional row that starts excluded.
  for (const name of Object.keys(WANTED)) await expect(layerRow(page, name)).toHaveCount(1);
  await layerRow(page, 'Background').locator('.ws-layer-main').click();
  await expect(page.getByRole('radio', { name: 'Exclude background' })).toHaveAttribute('aria-checked', 'true');
  for (const [name, choice] of Object.entries(WANTED)) {
    await layerRow(page, name).locator('.ws-layer-main').click();
    await page.getByRole('radio', { name: choice === 'add' ? 'Add to editor' : 'Leave for later', exact: true }).click();
    await expect(layerRow(page, name)).toHaveAttribute('data-choice', choice);
  }
  await expect(page.getByTestId('editor-selection-count')).toHaveText('3 of 6 selected for the editor · 3 left for later');
  await layerRow(page, 'Phone').locator('.ws-layer-main').click();
  await expect(page.getByText('Saved in your design. Add it to the editor any time from “Detected layers”.')).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: `${shots}/20-review-selected-layers.png` });

  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Refine selection' })).toBeVisible({ timeout: 60_000 });
  // Only the image layer added to the editor is segmented; layers left for later are never processed.
  await expect(page.locator('.ws-layer-name')).toHaveText(['Woman holding phone']);
  await page.getByRole('button', { name: 'Looks good' }).click();
  await expect(page.getByRole('heading', { name: 'Check the edges' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Looks good' }).click();
  await expect(page.getByRole('heading', { name: 'Your editable design is ready' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('left-for-later')).toHaveText('3 more detected layers are saved for later. Add them any time from “Detected layers” in the editor.');
  const blank = page.getByRole('region', { name: 'Open on blank canvas' }), original = page.getByRole('region', { name: 'Keep original background' });
  await expect(blank).toBeVisible(); await expect(original).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: `${shots}/21-open-choice.png` });
  await blank.getByRole('button', { name: 'Open on blank canvas' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  // The editor: a transparent canvas holding only the three chosen layers, each at its original position.
  await expect(page.getByTestId('canvas-frame')).toHaveAttribute('data-transparent', 'true');
  await expect(designLayers(page)).toHaveCount(3);
  const graph = (await getJob(page, jobId)).sceneGraph as SceneGraph;
  for (const layer of graph.layers.filter(l => l.type !== 'background')) {
    expect(await position(page, layer.name)).toEqual({ x: layer.bbox.x, y: layer.bbox.y, width: layer.bbox.width, height: layer.bbox.height });
  }
  expect(graph.layers.filter(l => l.type !== 'background').map(l => l.name).sort()).toEqual(['Footer bar', 'PRO headline', 'Woman holding phone']);

  // Move the footer up: its old place is empty (transparent), not a baked copy of the original image.
  const footer = await position(page, 'Footer bar');
  const inspector = await selectLayer(page, 'Footer bar');
  await inspector.getByLabel('Y', { exact: true }).fill(String(footer.y - 300));
  await page.waitForTimeout(300);
  const pixel = await exportedPixels(page);
  expect(pixel(400, 940)[3], 'where the footer was: nothing underneath').toBe(0);
  expect(pixel(780, 500)[3], 'an area no layer covers: no original image').toBe(0);
  expect(near(pixel(400, 940 - 300), GREEN), 'the moved footer is drawn at its new place').toBe(true);
  await page.locator('.canvas-viewport').click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(300);
  await page.screenshot({ animations: 'disabled', path: `${shots}/22-blank-canvas-editor.png` });
  expect(errors).toEqual([]);
});

test('C + E. layers left for later stay available: add one from "Detected layers" without AI; mode and choices survive reload', async () => {
  await page.goto('/');
  await expect(page.getByTestId('canvas-frame')).toHaveAttribute('data-transparent', 'true');
  await expect(tray(page)).toBeVisible();
  const items = tray(page).locator('li[data-detected]');
  await expect(items).toHaveCount(6);
  await expect(tray(page)).toContainText('3 not on the canvas yet.');
  for (const name of ['Orange main panel', 'Phone', 'Sticker']) await expect(trayItem(page, name)).toContainText('Left for later');
  await expect(trayItem(page, 'Footer bar')).toContainText('On canvas');
  await page.screenshot({ animations: 'disabled', path: `${shots}/23-detected-layers-tray.png` });

  // Preview, then add "Phone": cut from the original image at its original position. No AI is called.
  const before = fakeCalls(jobId);
  await tray(page).getByRole('button', { name: 'Preview Phone' }).click();
  await expect(tray(page).getByRole('img', { name: 'Phone preview' })).toBeVisible();
  const phoneTarget = (await getJob(page, jobId)).proposalTargets!.find(t => t.label === 'Phone')!;
  await tray(page).getByRole('button', { name: 'Add Phone to canvas' }).click();
  await expect(designLayers(page)).toHaveCount(4);
  await expect(trayItem(page, 'Phone')).toContainText('On canvas');
  const expected = await (await page.request.post(`/api/decomposition/jobs/${jobId}/detected/${phoneTarget.id}/cutout`, { headers: { Origin: new URL(page.url()).origin, 'X-FrameFlow-CSRF': '1' }, data: { strokes: [] } })).json() as { bbox: { x: number; y: number; width: number; height: number } };
  expect(await position(page, 'Phone')).toEqual(expected.bbox);
  expect(fakeCalls(jobId), 'adding a detected layer never calls AI').toEqual(before);

  // Rename in the tray renames the layer on the canvas too; removing from the list keeps it saved and restorable.
  await tray(page).getByRole('button', { name: 'Rename Sticker' }).click();
  await tray(page).getByRole('textbox', { name: 'Rename Sticker' }).fill('NEW badge');
  await tray(page).getByRole('textbox', { name: 'Rename Sticker' }).press('Enter');
  await expect(trayItem(page, 'NEW badge')).toHaveCount(1);
  await tray(page).getByRole('button', { name: 'Remove NEW badge from this list' }).click();
  await expect(items).toHaveCount(5);
  await tray(page).getByRole('button', { name: 'Show 1 removed layer' }).click();
  await tray(page).getByRole('button', { name: 'Restore NEW badge' }).click();
  await expect(items).toHaveCount(6);

  // Reload: the blank-canvas version, the added layer and the tray all come back; the job still holds every detected layer.
  await page.reload();
  await expect(page.getByTestId('canvas-frame')).toHaveAttribute('data-transparent', 'true');
  await expect(designLayers(page)).toHaveCount(4);
  await expect(trayItem(page, 'Phone')).toContainText('On canvas');
  await expect(trayItem(page, 'NEW badge')).toHaveCount(1);
  const saved = await getJob(page, jobId);
  const choice = (label: string) => { const t = saved.proposalTargets!.find(t => t.label === label)!; return t.rejected ? 'remove' : t.approved ? 'add' : 'later'; };
  for (const [name, wanted] of Object.entries(WANTED)) expect(choice(name), name).toBe(wanted);
  await openReady(page);
  await expect(page.getByRole('region', { name: 'Open on blank canvas' })).toContainText('Last opened this way');
});

test('B. the same layers on the original background: the original image is there underneath', async () => {
  await page.goto('/');
  await openReady(page);
  await page.getByRole('region', { name: 'Keep original background' }).getByRole('button', { name: 'Keep original background' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByTestId('canvas-frame')).not.toHaveAttribute('data-transparent', 'true');
  await expect(designLayers(page)).toHaveCount(3);
  const footer = await position(page, 'Footer bar');
  await (await selectLayer(page, 'Footer bar')).getByLabel('Y', { exact: true }).fill(String(footer.y - 300));
  await page.waitForTimeout(300);
  const pixel = await exportedPixels(page);
  expect(near(pixel(780, 500), BEIGE), 'the original image fills the canvas').toBe(true);
  expect(near(pixel(400, 940), GREEN), 'moving the footer reveals the original footer underneath').toBe(true);
  await page.locator('.canvas-viewport').click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(300);
  await page.screenshot({ animations: 'disabled', path: `${shots}/24-original-background-editor.png` });
});
