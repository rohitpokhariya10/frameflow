import { expect, test, type Page } from '@playwright/test';
import type { ProjectDocument } from '@frameflow/shared';

// The review build hides the earlier generic "Image to layers" flow: VITE_LEGACY_IMAGE_TO_LAYERS is off unless set, and
// this suite runs without it. Its three entry points are not on the page, nothing of it is requested, and everything
// beside it is where it was. No provider: every /api request is blocked and recorded.
const LEGACY = /\/api\/decomposition\b/;
async function blockApi(page: Page) {
  const requests: string[] = [];
  await page.route(url => url.pathname.startsWith('/api/'), (route) => { requests.push(new URL(route.request().url()).pathname); return route.abort(); });
  return requests;
}
/** A saved design that was once opened from an "Image to layers" job: the link to that job is still in the document. */
const opened: ProjectDocument = {
  schemaVersion: 1, id: 'opened-from-image-to-layers', name: 'Opened from Image to layers', createdAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z',
  variants: [{ id: 'original', name: 'Original', revision: 0, canvas: { width: 1080, height: 1350, backgroundColor: '#fffefa' }, elements: [], decomposition: { jobId: 'job-from-the-earlier-flow', mode: 'blank' }, layers: [
    { id: 'panel', name: 'Orange panel', type: 'shape', shapeType: 'rounded-rectangle', x: 100, y: 400, width: 850, height: 700, rotation: 0, opacity: 1, visible: true, locked: false, fill: '#ff6a00', radius: 50 },
  ] }],
};

test('flag off: there is no "Image to layers" button; the other launchers sit side by side from the corner', async ({ page }) => {
  const requests = await blockApi(page);
  await page.goto('/');
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Image to layers' })).toHaveCount(0);
  await expect(page.locator('.decomp-launch')).toHaveText(['OpenAI + Seedream test', 'Create Own Template']);
  // No gap is left where the button was: the first launcher is in the corner, the second right beside it, not overlapping.
  const [first, second] = await Promise.all([page.getByRole('button', { name: 'OpenAI + Seedream test' }).boundingBox(), page.getByRole('button', { name: 'Create Own Template' }).boundingBox()]);
  const width = page.viewportSize()!.width;
  expect(width - (first!.x + first!.width)).toBeLessThanOrEqual(24);
  expect(second!.x + second!.width).toBeLessThanOrEqual(first!.x);
  expect(first!.x - (second!.x + second!.width)).toBeLessThanOrEqual(24);
  expect(Math.abs(first!.y - second!.y)).toBeLessThanOrEqual(1);
  expect(requests.filter(path => LEGACY.test(path))).toEqual([]);
});

test('flag off: the AI panel offers Generate and Adapt format, and no Decompose', async ({ page }) => {
  const requests = await blockApi(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  const operations = page.getByRole('group', { name: 'AI operation' });
  await expect(operations.getByRole('button')).toHaveText(['Generate', 'Adapt format']);
  await expect(page.getByRole('button', { name: 'Decompose' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Open image to layers/ })).toHaveCount(0);
  // The two remaining operations switch as before.
  await operations.getByRole('button', { name: 'Adapt format' }).click();
  await expect(operations.getByRole('button', { name: 'Adapt format' })).toHaveAttribute('aria-pressed', 'true');
  await operations.getByRole('button', { name: 'Generate' }).click();
  await expect(operations.getByRole('button', { name: 'Generate' })).toHaveAttribute('aria-pressed', 'true');
  expect(requests.filter(path => LEGACY.test(path))).toEqual([]);
});

test('flag off: a design once opened from Image to layers shows no "Detected layers" tray and asks the earlier API nothing', async ({ page }) => {
  const requests = await blockApi(page);
  await page.goto('/');
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.evaluate(document => localStorage.setItem('frameflow:project:v1', JSON.stringify(document)), opened);
  await page.reload();
  // The design itself is there and editable, with its layers list, in every state of the properties panel.
  await expect(page.getByRole('region', { name: 'Layers', exact: true })).toBeVisible();
  await expect(page.locator('.workspace-heading')).toContainText('1 layer');
  await expect(page.getByRole('region', { name: 'Detected layers' })).toHaveCount(0);
  await page.getByRole('list', { name: 'Design layers' }).locator('[data-layer-id="panel"]').click();
  await expect(page.getByRole('region', { name: 'Layers', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Detected layers' })).toHaveCount(0);
  await expect(page.getByText('Detected layers')).toHaveCount(0);
  // The link to the job stays in the saved design: nothing is removed, so the tray is back when the flag is on.
  expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('frameflow:project:v1')!) as ProjectDocument).variants[0].decomposition)).toEqual({ jobId: 'job-from-the-earlier-flow', mode: 'blank' });
  expect(requests.filter(path => LEGACY.test(path))).toEqual([]);
});

test('flag off: the template review flow and Create Own Template open as before', async ({ page }) => {
  const requests = await blockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Create Template', exact: true }).click();
  for (const name of ['Create Template A', 'Create Template B', 'Create Template C']) await expect(panel.getByRole('button', { name })).toBeVisible();
  await panel.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Create Own Template' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // Only the template flow's own API was asked for anything; the earlier one was not.
  expect(requests.every(path => path.startsWith('/api/layerize-experiment/'))).toBe(true);
  expect(requests.filter(path => LEGACY.test(path))).toEqual([]);
});
