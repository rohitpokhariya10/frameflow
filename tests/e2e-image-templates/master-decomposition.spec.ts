import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { CreativeInstance, MasterAiBatch } from '@frameflow/shared';
import type { MasterView } from '../../client/src/features/masterTemplates/api';

/**
 * A generated creative sent to decomposition: its own layers in the run dashboard (no AI, no Seedream), then in the editor
 * with native text, edited, saved on this device, reloaded, reopened from Saved Runs and exported at the creative's size.
 */
test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` }, actionTimeout: 30000 });
test.describe.configure({ timeout: 300000 });
const API = '/api/layerize-experiment/master-templates';
async function open(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  return page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
}
async function prepare(request: APIRequestContext, name: string, poster = '/__test__/master-poster.png') {
  const source = await (await request.get(poster)).body();
  const created = await request.post(API, { multipart: { name, image: { name: 'poster.png', mimeType: 'image/png', buffer: source } } });
  expect(created.ok()).toBe(true);
  let v = await created.json() as MasterView; const id = v.template.id;
  await expect.poll(async () => { v = await (await request.get(`${API}/${id}`)).json(); return v.stage; }, { timeout: 120000 }).not.toBe('scanning');
  for (const action of ['review/approve-all', 'prepare', 'background/approve', 'publish']) {
    const r = await request.post(`${API}/${id}/${action}`, { data: { expectedRevision: v.template.revision, includeUncertain: true, acknowledgeEstimate: true } });
    expect(r.ok(), await r.text()).toBe(true); v = await r.json();
  }
  return { id, v };
}
/** One mocked batch of AI style variations in a format, from the page. */
async function generate(page: Page, panel: Locator, id: string, formatId: string) {
  await panel.getByLabel('Aspect ratio').selectOption(formatId);
  await panel.getByRole('button', { name: 'Check generation cost' }).click();
  const queued = page.waitForResponse(r => r.url().endsWith(`/master-creatives/${id}`) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Generate 3 editable creatives' }).click();
  const batch = await (await queued).json() as MasterAiBatch, card = panel.getByRole('region', { name: `AI batch ${batch.job.id}` });
  await expect(card.getByRole('article')).toHaveCount(3, { timeout: 120000 });
  return card;
}
const pngSize = async (path: string) => sharp(path).metadata().then(m => [m.width, m.height]);
const layerButton = (page: Page, name: string) => page.locator('.layer-select', { hasText: name }).first();

test('a generated creative sent to decomposition: free layers, native text in the editor, edits kept after reload and reopen, exact-size export', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'One run of this long flow; the narrow screen is checked inside it.');
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => r.abort());
  const name = `Decompose ${Date.now()}`, { id, v: before } = await prepare(request, name), size = [before.template.source.width, before.template.source.height];
  let panel = await open(page);
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  await panel.getByRole('article', { name: `Template ${name}`, exact: true }).getByRole('button', { name: 'Generate AI Variations', exact: true }).click();
  const own = await generate(page, panel, id, 'master');
  await generate(page, panel, id, 'story-9-16');
  const batches = (await (await request.get(`/api/template-studio/master-creatives/${id}`)).json()).batches as MasterAiBatch[];
  const ownBatch = batches.find(b => b.formatId === 'master')!, cid = ownBatch.creatives[0].id;
  const creative = await (await request.get(`${API}/${id}/creatives/${cid}`)).json() as CreativeInstance, masterBefore = JSON.stringify((await (await request.get(`${API}/${id}`)).json()).template);
  // This master's own counters (other tests run beside this one on the same server).
  const calls = async () => ({ design: (await (await request.get('/__test__/studio-calls')).json() as { schemaName?: string; masterId?: string }[]).filter(c => c.masterId === id).length,
    activity: (await (await request.get(`${API}/${id}`)).json() as MasterView).activity });
  const callsBefore = await calls();
  expect(callsBefore.design).toBe(2);

  // Send to Decomposition: the run dashboard with every element as its own layer, at no cost.
  const sent = page.waitForResponse(r => r.url().endsWith(`/creatives/${cid}/decomposition`));
  await own.getByRole('article', { name: `AI creative ${ownBatch.creatives[0].name}`, exact: true }).getByRole('button', { name: 'Send to Decomposition' }).click();
  const { runId } = await (await sent).json() as { runId: string };
  await expect(panel.getByTestId('creative-run-note')).toContainText(`Made from your saved creative “${creative.name}”`);
  await expect(panel.getByText('Decomposition result · Saved creative · no AI')).toBeVisible();
  const run = await (await request.get(`/api/layerize-experiment/runs/${runId}`)).json();
  await expect(panel.getByTestId('editor-layer-grid').locator('figure')).toHaveCount(run.creative.layers.length);
  await expect(panel.getByTestId('editor-layer-grid')).toContainText('Text · editable');
  await expect(panel.getByTestId('run-cost')).toContainText('₹0.00');
  await panel.screenshot({ path: info.outputPath('decomposition-dashboard.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await panel.locator('.ws-body').evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  await panel.screenshot({ path: info.outputPath('decomposition-dashboard-390.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

  // The editor: pictures as layers, every text native and editable.
  await panel.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(panel).toBeHidden();
  const texts = creative.texts.filter(t => t.text.trim()), word = texts[0], logo = creative.images.find(i => !i.artwork && !i.hidden)!;
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  for (const t of texts.slice(0, 3)) await expect(page.getByRole('button', { name: new RegExp(t.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first()).toBeVisible();
  await page.getByRole('button', { name: new RegExp(word.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click();
  await page.getByLabel('Text content', { exact: true }).fill('Mega');
  await page.keyboard.press('Escape');
  await layerButton(page, logo.label).click();
  const movedX = Math.round(logo.box.x) + 25;
  await page.getByLabel('X', { exact: true }).fill(String(movedX));
  await page.getByLabel('Replacement image').setInputFiles({ name: 'new-bank.png', mimeType: 'image/png', buffer: await (await request.get('/__test__/master-logo.png')).body() });
  await expect(page.getByRole('status').filter({ hasText: 'Saved on this device' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('decomposition-editor.png') });
  const exported = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  expect(await pngSize((await (await exported).path())!)).toEqual(size);

  // Reload: the edited design is still on this device; reopening the run returns to it (no second design).
  await page.reload();
  panel = await open(page);
  await panel.getByRole('tab', { name: 'Saved Runs', exact: true }).click();
  await panel.getByRole('article', { name: `Saved run ${runId}`, exact: true }).getByRole('button', { name: /View run/ }).click();
  await panel.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await expect(page.getByRole('button', { name: /Mega/ }).first()).toBeVisible();
  await layerButton(page, logo.label).click();
  await expect(page.getByLabel('X', { exact: true })).toHaveValue(String(movedX));

  // Another format: a 9:16 variation, sent and exported at 1080 × 1920.
  panel = await open(page);
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  await panel.getByRole('article', { name: `Template ${name}`, exact: true }).getByRole('button', { name: 'Generate AI Variations', exact: true }).click();
  const storyBatch = batches.find(b => b.formatId === 'story-9-16')!;
  await expect(panel.getByRole('region', { name: `AI batch ${storyBatch.job.id}` })).toBeVisible();
  await panel.getByRole('region', { name: `AI batch ${storyBatch.job.id}` }).getByRole('article', { name: `AI creative ${storyBatch.creatives[0].name}`, exact: true }).getByRole('button', { name: 'Send to Decomposition' }).click();
  await expect(panel.getByTestId('creative-run-note')).toContainText(storyBatch.creatives[0].name);
  await panel.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(panel).toBeHidden();
  const storyExport = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  expect(await pngSize((await (await storyExport).path())!)).toEqual([1080, 1920]);

  // Nothing written back: the creative and the master as they were; no AI, Seedream or scan request.
  expect(await (await request.get(`${API}/${id}/creatives/${cid}`)).json()).toEqual(creative);
  expect(JSON.stringify((await (await request.get(`${API}/${id}`)).json()).template)).toBe(masterBefore);
  expect(await calls()).toEqual(callsBefore);
});

test('a decorative template: the background artwork splits into its border and illustrations, each its own layer in the editor', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'One run of this flow.');
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => r.abort());
  const name = `Decorative ${Date.now()}`, { id, v: before } = await prepare(request, name, '/__test__/master-art-poster.png'), size = [before.template.source.width, before.template.source.height];
  const calls = async () => ({ studio: (await (await request.get('/__test__/studio-calls')).json() as { masterId?: string }[]).filter(c => c.masterId === id).length, activity: (await (await request.get(`${API}/${id}`)).json() as MasterView).activity });
  const callsBefore = await calls();
  let panel = await open(page);
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  await panel.getByRole('article', { name: `Template ${name}`, exact: true }).getByRole('button', { name: 'Reuse Template', exact: true }).click();
  await expect(panel.getByTestId('creative-preview')).toBeVisible();
  const cid = (await (await request.get(`${API}/${id}/creatives`)).json()).creatives[0].id, creative = await (await request.get(`${API}/${id}/creatives/${cid}`)).json() as CreativeInstance;
  const sent = page.waitForResponse(r => r.url().endsWith(`/creatives/${cid}/decomposition`), { timeout: 120000 });
  await panel.getByRole('button', { name: 'Send to Decomposition', exact: true }).click({ noWaitAfter: true });
  const { runId } = await (await sent).json() as { runId: string };
  await expect(panel.getByTestId('creative-run-note')).toContainText('the background artwork is split into', { timeout: 60000 });
  await expect(panel.getByTestId('artwork-split-hint')).toBeVisible();
  const run = await (await request.get(`/api/layerize-experiment/runs/${runId}`)).json();
  const artwork = run.creative.layers.filter((l: { kind: string }) => l.kind === 'artwork').map((l: { file: string }) => run.layers.find((x: { file: string }) => x.file === l.file).name) as string[];
  expect(run.creative.artwork).toMatchObject({ method: 'local', objects: artwork.length });
  expect(artwork).toEqual(expect.arrayContaining(['Border', 'Artwork · top right', 'Artwork · bottom right']));
  await expect(panel.getByTestId('editor-layer-grid').locator('figure', { hasText: 'Artwork object' })).toHaveCount(artwork.length);
  await panel.getByTestId('editor-layer-grid').scrollIntoViewIfNeeded();
  await panel.screenshot({ path: info.outputPath('decorative-dashboard.png') });
  // The editor: each object its own picture layer, free to move; the base locked below them.
  await panel.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(panel).toBeHidden();
  for (const n of artwork) await expect(layerButton(page, n)).toBeVisible();
  await expect(layerButton(page, 'Background base')).toContainText('locked');
  await layerButton(page, 'Artwork · top right').click();
  const movedX = Math.round(Number(await page.getByLabel('X', { exact: true }).inputValue())) - 150;
  await page.getByLabel('X', { exact: true }).fill(String(movedX));
  await expect(page.getByRole('status').filter({ hasText: 'Saved on this device' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('decorative-editor.png') });
  const exported = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  expect(await pngSize((await (await exported).path())!)).toEqual(size);
  // Reload and reopen: the same design, the object where it was moved.
  await page.reload();
  panel = await open(page);
  await panel.getByRole('tab', { name: 'Saved Runs', exact: true }).click();
  await panel.getByRole('article', { name: `Saved run ${runId}`, exact: true }).getByRole('button', { name: /View run/ }).click();
  await panel.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(panel).toBeHidden();
  await layerButton(page, 'Artwork · top right').click();
  await expect(page.getByLabel('X', { exact: true })).toHaveValue(String(movedX));
  expect(await (await request.get(`${API}/${id}/creatives/${cid}`)).json()).toEqual(creative);
  expect(await calls()).toEqual(callsBefore);
});
