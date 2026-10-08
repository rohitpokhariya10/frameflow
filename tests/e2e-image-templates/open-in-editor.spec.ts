import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API, executionOf, fixture, runOf, writesOf } from './wizard.helpers';

// Offline fixture server, real storage and editor. Opening a decomposed result uses only what is stored and never costs
// a version: each result opens as a design of its own (on its own canvas), the design that was open keeps its versions
// (28 stays 28, 30 stays 30, no limit warning), opening it again switches back to the same design, and a double-click
// makes one design. Opening never calls a provider: the page only reads, plus one "opened" record per open.
test.use({ extraHTTPHeaders: { origin: 'http://127.0.0.1:3317' } });
test.describe.configure({ mode: 'serial' });

/** A finished Create Template execution made through the API (fake providers): a stored result to open. */
async function storedResult(request: APIRequestContext, image: string) {
  const created = await (await request.post(`${API}/template-executions`, { multipart: { mode: 'CREATE_TEMPLATE', idempotencyKey: crypto.randomUUID(), image: { name: 'stored.png', mimeType: 'image/png', buffer: await fixture(request, image) } } })).json();
  await expect.poll(async () => (await executionOf(request, created.id)).state, { timeout: 90_000 }).toBe('done');
  return executionOf(request, created.id);
}
const versions = (page: Page) => page.getByLabel('Active version');
const designs = (page: Page) => page.getByLabel('Open design');
type StoredDocument = { id: string; name: string; variants: { id: string; canvas: { width: number; height: number }; importedFrom?: { resultId: string } }[] };
/** Every design on this device: the open one and the stored ones. */
const onDevice = (page: Page) => page.evaluate(() => {
  const open = JSON.parse(localStorage.getItem('frameflow:project:v1')!) as StoredDocument;
  const index = JSON.parse(localStorage.getItem('frameflow:designs:v1') ?? '[]') as { id: string }[];
  return [open, ...index.map(entry => JSON.parse(localStorage.getItem(`frameflow:design:v1:${entry.id}`)!) as StoredDocument)];
});
/** The open design is "My campaign" with `count` versions. */
async function campaignWith(page: Page, count: number) {
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.goto('/');
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.evaluate(count => { const doc = JSON.parse(localStorage.getItem('frameflow:project:v1')!); doc.name = 'My campaign'; doc.variants = Array.from({ length: count }, (_, i) => ({ ...doc.variants[0], id: `seed-${i}`, name: `Seed ${i}` })); localStorage.setItem('frameflow:project:v1', JSON.stringify(doc)); }, count);
  await page.reload();
  await expect(versions(page).locator('option')).toHaveCount(count);
}
/** Saved Runs → this execution's session → the wizard's finished result. */
async function openSession(page: Page, executionId: string) {
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Saved Runs', exact: true }).click();
  await panel.getByRole('region', { name: 'Saved template executions' }).locator(`button:has(img[src*="${executionId}"])`).click();
  await expect(panel.getByRole('heading', { name: 'Your template is ready' })).toBeVisible();
  return panel;
}
/** The editor shows this result's own design: its name, its canvas, its two layers, one version. */
async function showsResult(page: Page, name: string, size: string) {
  await expect(designs(page).locator('option:checked')).toHaveText(`${name} · original · 1 version`);
  await expect(page.locator('.workspace-unit')).toHaveText(`${size} px`);
  await expect(page.getByRole('list', { name: 'Design layers' }).locator('li')).toHaveCount(2);
  await expect(page.getByRole('list', { name: 'Design layers' }).locator('.layer-select').filter({ hasText: 'Lavender phone' })).toHaveCount(1);
  await expect(versions(page)).toHaveCount(0);
}

test('each result opens as its own design from stored results: the open design keeps its 28 versions, reopening switches back, a double-click makes one design, edits persist, no provider call', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The fixture server is shared by every project and runs one decomposition at a time; one journey is enough.');
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => void dialog.accept());
  await campaignWith(page, 28);
  // The launchers never cover the zoom control, and the legacy generic flow stays hidden.
  const zoom = (await page.getByLabel('Canvas zoom').boundingBox())!;
  for (const launcher of await page.locator('.decomp-launch').all()) {
    const box = (await launcher.boundingBox())!;
    expect(box.x >= zoom.x + zoom.width || box.x + box.width <= zoom.x || box.y >= zoom.y + zoom.height || box.y + box.height <= zoom.y).toBe(true);
  }
  await expect(page.getByRole('button', { name: 'Image to layers', exact: true })).toHaveCount(0);
  const square = await storedResult(request, '/__test__/reference.png'), wide = await storedResult(request, '/__test__/reference.png?shape=wide');
  const runsBefore = await Promise.all([square, wide].map(e => runOf(request, e.runId)));
  // From here on only opening: every request the page makes is recorded.
  const writes = writesOf(page);

  // First open, double-clicked: one new design for the result; no version is added anywhere.
  let panel = await openSession(page, square.id);
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).dblclick();
  await expect(panel).toHaveCount(0);
  await showsResult(page, square.template.name, '1024 × 1024');
  await expect(designs(page).locator('option')).toHaveCount(2);
  await expect(designs(page).locator('option', { hasText: 'My campaign' })).toHaveText('My campaign · 28 versions');
  const squareDesign = await designs(page).inputValue();
  await page.screenshot({ path: testInfo.outputPath('1-square-opened.png') });
  await designs(page).selectOption({ label: 'My campaign · 28 versions' });
  await expect(versions(page).locator('option')).toHaveCount(28);

  // Opening it again switches back to the same design: no new design, no version.
  panel = await openSession(page, square.id);
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await showsResult(page, square.template.name, '1024 × 1024');
  expect(await designs(page).inputValue()).toBe(squareDesign);
  await expect(designs(page).locator('option')).toHaveCount(2);

  // Another result through the same handoff: its own design on its own canvas; the campaign still has 28.
  panel = await openSession(page, wide.id);
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await showsResult(page, wide.template.name, '1400 × 1024');
  await expect(designs(page).locator('option')).toHaveCount(3);
  await expect(designs(page).locator('option', { hasText: 'My campaign' })).toHaveText('My campaign · 28 versions');

  // An edit in an opened design persists across a reload.
  await page.getByRole('list', { name: 'Design layers' }).locator('.layer-select').filter({ hasText: 'Lavender phone' }).click();
  await page.getByRole('spinbutton', { name: 'X', exact: true }).fill('45');
  await page.getByRole('spinbutton', { name: 'X', exact: true }).blur();
  // Reload only once autosave has stored this design, with the edit, as the open one ("Saved" can still show the last save).
  const wideDesign = await designs(page).inputValue();
  await expect.poll(() => page.evaluate(() => { const doc = JSON.parse(localStorage.getItem('frameflow:project:v1')!) as { id: string; variants: { layers: { name?: string; x?: number }[] }[] };
    return [doc.id, doc.variants[0].layers.find(layer => layer.name?.includes('Lavender phone'))?.x]; })).toEqual([wideDesign, 45]);
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.reload();
  await expect(designs(page).locator('option:checked')).toHaveText(`${wide.template.name} · original · 1 version`);
  await page.getByRole('list', { name: 'Design layers' }).locator('.layer-select').filter({ hasText: 'Lavender phone' }).click();
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('45');
  await page.screenshot({ path: testInfo.outputPath('2-both-results.png') });

  // On this device: the campaign with its 28 versions, and one design per result with exactly one version.
  const all = await onDevice(page);
  expect(all).toHaveLength(3);
  expect(all.find(d => d.name === 'My campaign')!.variants).toHaveLength(28);
  expect(all.filter(d => d.name !== 'My campaign').map(d => [d.name, d.variants.length, d.variants[0].importedFrom?.resultId, `${d.variants[0].canvas.width} × ${d.variants[0].canvas.height}`]).sort())
    .toEqual([[`${square.template.name} · original`, 1, 'original', '1024 × 1024'], [`${wide.template.name} · original`, 1, 'original', '1400 × 1024']].sort());
  // Opening spent nothing: one "opened" record per open (the double-click is one), no other write, runs unchanged.
  expect(writes).toEqual([`POST ${API}/template-executions/${square.id}/opened`, `POST ${API}/template-executions/${square.id}/opened`, `POST ${API}/template-executions/${wide.id}/opened`]);
  expect((await Promise.all([square, wide].map(e => runOf(request, e.runId)))).map(r => r.calls)).toEqual(runsBefore.map(r => r.calls));
  expect((await executionOf(request, square.id)).editor).toMatchObject({ runId: square.runId });
  expect(errors).toEqual([]);
});

test('with 30 versions the first open still works, with no limit warning, and the design keeps its 30 versions', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The fixture server is shared by every project and runs one decomposition at a time; one journey is enough.');
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await campaignWith(page, 30);
  const result = await storedResult(request, '/__test__/reference.png');
  const writes = writesOf(page);
  let panel = await openSession(page, result.id);
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByText(/already has (the maximum of )?30|maximum of 30|30-version limit/)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await showsResult(page, result.template.name, '1024 × 1024');
  await expect(designs(page).locator('option', { hasText: 'My campaign' })).toHaveText('My campaign · 30 versions');
  await page.screenshot({ path: testInfo.outputPath('3-at-30-versions.png') });
  const opened = await designs(page).inputValue();
  await designs(page).selectOption({ label: 'My campaign · 30 versions' });
  await expect(versions(page).locator('option')).toHaveCount(30);
  panel = await openSession(page, result.id);
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(await designs(page).inputValue()).toBe(opened);
  await expect(page.getByText(/already has (the maximum of )?30|maximum of 30|30-version limit/)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(writes.every(w => w === `POST ${API}/template-executions/${result.id}/opened`)).toBe(true);
  expect(errors).toEqual([]);
});
