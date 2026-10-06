import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Runs only in playwright.offline.config.ts, against the real API, storage and editor with injected local providers.
// Opening a decomposed result must use only what is stored and never cost a version: each result opens as a design of
// its own (every ratio through the same handoff), the design that was open keeps its versions (28 stays 28, 30 stays
// 30, no limit warning), opening it again switches back to the same design, and a double-click makes one design.
test.describe.configure({ mode: 'serial' });

const RATIOS = [['1:1', '1x1', '1024 × 1024'], ['4:5', '4x5', '1216 × 1520'], ['16:9', '16x9', '1536 × 864']] as const;
const counts = async (request: APIRequestContext) => (await request.get('/__test__/call-counts')).json() as Promise<{ openai: number; fal: number; seedream: number }>;
type Template = { id: string; name: string; promptGeneration?: { attempts: number }; variants: { id: string; status: string; attempts: number; decompositions: { runId: string }[]; decomposition?: { state: string } }[] };
/**
 * What the shared fixture server is doing: every template's generation and decomposition history, the runs, and whether
 * anything is on its way. Other spec files run beside this one; only when nothing of theirs moved are the global provider
 * counters this test's own.
 */
async function activity(request: APIRequestContext, headers: Record<string, string>) {
  const templates = ((await (await request.get('/api/layerize-experiment/image-templates', { headers })).json()).templates ?? []) as Template[];
  const runs = await (await request.get('/api/layerize-experiment/runs', { headers })).json() as { active: string | null; runs: unknown[] };
  const busy = !!runs.active || templates.some(t => t.variants.some(v => ['queued', 'generating'].includes(v.status) || ['waiting', 'running'].includes(v.decomposition?.state ?? '')));
  return { templates, busy, signature: JSON.stringify([runs.runs.length, templates.map(t => [t.id, t.promptGeneration?.attempts, t.variants.map(v => [v.attempts, v.decompositions.length])])]) };
}
/** This template's provider history: prompt analyses, image generations and decomposition runs. */
const historyOf = (templates: Template[], name: string) => { const t = templates.find(item => item.name === name)!; return { prompt: t.promptGeneration?.attempts, results: t.variants.map(v => [v.id, v.attempts, v.decompositions.map(d => d.runId)]) }; };
const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'Create Template from Image' });
/** The dialog again, on this template (other specs add templates to the shared server, so never just the newest). */
async function openDialog(page: Page, name: string) {
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await page.getByRole('dialog', { name: 'OpenAI + Seedream test' }).getByRole('button', { name: 'Create Template from Image' }).click();
  await dialogOf(page).getByRole('complementary', { name: 'Your templates' }).getByRole('button').filter({ hasText: name }).click();
  await expect(dialogOf(page).getByRole('heading', { name, exact: true })).toBeVisible();
}
/** A template in 1:1, 4:5 and 16:9, generated and decomposed through the real routes (fake providers). */
async function decomposedTemplate(page: Page, request: APIRequestContext, name: string) {
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await page.getByRole('dialog', { name: 'OpenAI + Seedream test' }).getByRole('button', { name: 'Create Template from Image' }).click();
  const dialog = dialogOf(page);
  await dialog.getByRole('button', { name: 'New template' }).click();
  await dialog.getByLabel('Template name').fill(name);
  await dialog.getByLabel('Reference image', { exact: true }).setInputFiles({ name: 'mom-and-child.png', mimeType: 'image/png', buffer: await (await request.get('/__test__/reference.png')).body() });
  await dialog.getByRole('button', { name: 'Generate prompt from image' }).click();
  await expect(dialog.getByLabel('Generated prompt')).toHaveValue(/lavender/, { timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Generate selected templates (3)' }).click();
  for (const [, id] of RATIOS) await expect(dialog.getByTestId(`status-${id}`)).toHaveText('Generated', { timeout: 15_000 });
  for (const [ratio, id] of RATIOS) {
    await dialog.getByRole('article', { name: `${ratio} result` }).getByRole('button', { name: 'Decompose into layers' }).click();
    await expect(dialog.getByTestId(`status-${id}`)).toHaveText('Decomposed', { timeout: 30_000 });
  }
  return dialog;
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
  await page.goto('/');
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.evaluate(count => { const doc = JSON.parse(localStorage.getItem('frameflow:project:v1')!); doc.name = 'My campaign'; doc.variants = Array.from({ length: count }, (_, i) => ({ ...doc.variants[0], id: `seed-${i}`, name: `Seed ${i}` })); localStorage.setItem('frameflow:project:v1', JSON.stringify(doc)); }, count);
  await page.reload();
  await expect(versions(page).locator('option')).toHaveCount(count);
}
/** The editor shows this result's own design: its name, its canvas, its two layers, one version. */
async function showsResult(page: Page, name: string, ratio: string, size: string) {
  await expect(designs(page).locator('option:checked')).toHaveText(`${name} · ${ratio} · 1 version`);
  await expect(page.locator('.workspace-unit')).toHaveText(`${size} px`);
  await expect(page.getByRole('list', { name: 'Design layers' }).locator('li')).toHaveCount(2);
  await expect(page.getByRole('list', { name: 'Design layers' }).locator('.layer-select').filter({ hasText: 'Lavender phone' })).toHaveCount(1);
  await expect(versions(page)).toHaveCount(0);
}

test('1/2/3/5/6/7. every ratio opens as its own design from stored results: the open design keeps its 28 versions, reopening switches back, a double-click makes one design, no provider call', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The fixture server is shared by every project and runs one decomposition at a time; one journey is enough.');
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => void dialog.accept());
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await campaignWith(page, 28);
  const name = `Mom and child ${Date.now()}`, headers = { Origin: new URL(page.url()).origin };
  let dialog = await decomposedTemplate(page, request, name);
  // From here on only opening: count every provider request and every write the page makes.
  const start = await activity(request, headers), before = await counts(request), writes: string[] = [];
  page.on('request', r => { if (r.method() !== 'GET') writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });

  // 1/6. The 4:5 result, first open, double-clicked: the editor opens on the 4:5 design; no version is added anywhere.
  const fourFive = dialog.getByRole('article', { name: '4:5 result' });
  await expect(fourFive.getByTestId('status-4x5')).toHaveText('Decomposed');
  await fourFive.getByRole('button', { name: 'Open in editor', exact: true }).dblclick();
  await expect(dialog).toHaveCount(0);
  await showsResult(page, name, '4:5', '1216 × 1520');
  await expect(designs(page).locator('option')).toHaveCount(2);
  await expect(designs(page).locator('option', { hasText: 'My campaign' })).toHaveText('My campaign · 28 versions');
  const fourFiveDesign = await designs(page).inputValue();
  await page.screenshot({ path: testInfo.outputPath('1-4x5-opened.png') });

  // The campaign is exactly as it was: 28 → 28.
  await designs(page).selectOption({ label: 'My campaign · 28 versions' });
  await expect(versions(page).locator('option')).toHaveCount(28);

  // 2. "Open in editor again" switches back to the same 4:5 design: no new design, no version.
  await openDialog(page, name);
  dialog = dialogOf(page);
  await expect(dialog.getByTestId('status-4x5')).toHaveText('Ready in editor');
  await dialog.getByRole('article', { name: '4:5 result' }).getByRole('button', { name: 'Open in editor again', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await showsResult(page, name, '4:5', '1216 × 1520');
  expect(await designs(page).inputValue()).toBe(fourFiveDesign);
  await expect(designs(page).locator('option')).toHaveCount(2);

  // 3/7. 1:1 and 16:9 through the same handoff, each its own design on its own canvas; the campaign still 28.
  for (const [ratio, , size] of RATIOS.filter(([ratio]) => ratio !== '4:5')) {
    const count = await designs(page).locator('option').count();
    await openDialog(page, name);
    await dialogOf(page).getByRole('article', { name: `${ratio} result` }).getByRole('button', { name: 'Open in editor', exact: true }).click();
    await expect(dialogOf(page)).toHaveCount(0);
    await showsResult(page, name, ratio, size);
    await expect(designs(page).locator('option')).toHaveCount(count + 1);
    await expect(designs(page).locator('option', { hasText: 'My campaign' })).toHaveText('My campaign · 28 versions');
  }
  await page.screenshot({ path: testInfo.outputPath('2-all-ratios.png') });

  // On this device: the campaign with its 28 versions, and one design per result with exactly one version.
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  const all = await onDevice(page);
  expect(all).toHaveLength(4);
  expect(all.find(d => d.name === 'My campaign')!.variants).toHaveLength(28);
  expect(all.filter(d => d.name !== 'My campaign').map(d => [d.name, d.variants.length, d.variants[0].importedFrom?.resultId, `${d.variants[0].canvas.width} × ${d.variants[0].canvas.height}`]).sort())
    .toEqual([[`${name} · 16:9`, 1, '16x9', '1536 × 864'], [`${name} · 1:1`, 1, '1x1', '1024 × 1024'], [`${name} · 4:5`, 1, '4x5', '1216 × 1520']]);
  // 5. Opening spent nothing. This template: no new prompt analysis, image generation or decomposition run. The page:
  // only reads, and one "opened" record per result. The provider counters (OpenAI, fal, Seedream): unchanged, whenever
  // no other spec's provider work shared the window (run alone, always).
  const end = await activity(request, headers), after = await counts(request);
  expect(historyOf(end.templates, name)).toEqual(historyOf(start.templates, name));
  expect(writes.filter(w => !w.endsWith('/opened'))).toEqual([]);
  expect(writes).toHaveLength(3);
  if (!start.busy && !end.busy && start.signature === end.signature) expect(after).toEqual(before);
  else testInfo.annotations.push({ type: 'shared-server', description: `Other specs used providers meanwhile (${JSON.stringify(before)} → ${JSON.stringify(after)}); this template's own history and the page's requests show no provider call.` });
  expect(errors).toEqual([]);
});

test('4. with 30 versions the first open still works, with no limit warning, and the design keeps its 30 versions', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The fixture server is shared by every project and runs one decomposition at a time; one journey is enough.');
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => void dialog.accept());
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await campaignWith(page, 30);
  const name = `Full design ${Date.now()}`, headers = { Origin: new URL(page.url()).origin };
  const dialog = await decomposedTemplate(page, request, name);
  const start = await activity(request, headers), before = await counts(request);
  const fourFive = dialog.getByRole('article', { name: '4:5 result' });
  await fourFive.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/already has (the maximum of )?30|maximum of 30|30-version limit/)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await showsResult(page, name, '4:5', '1216 × 1520');
  await expect(designs(page).locator('option', { hasText: 'My campaign' })).toHaveText('My campaign · 30 versions');
  await page.screenshot({ path: testInfo.outputPath('3-at-30-versions.png') });
  // 30 → 30, and reopening the result from there switches back to the same design.
  const result = await designs(page).inputValue();
  await designs(page).selectOption({ label: 'My campaign · 30 versions' });
  await expect(versions(page).locator('option')).toHaveCount(30);
  await openDialog(page, name);
  await dialogOf(page).getByRole('article', { name: '4:5 result' }).getByRole('button', { name: 'Open in editor again', exact: true }).click();
  await expect(dialogOf(page)).toHaveCount(0);
  expect(await designs(page).inputValue()).toBe(result);
  await expect(page.getByText(/already has (the maximum of )?30|maximum of 30|30-version limit/)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const end = await activity(request, headers);
  if (!start.busy && !end.busy && start.signature === end.signature) expect(await counts(request)).toEqual(before);
  expect(errors).toEqual([]);
});
