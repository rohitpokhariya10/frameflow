import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { Stage } from 'konva/lib/Stage';
import type { Group } from 'konva/lib/Group';
import type { Text } from 'konva/lib/shapes/Text';
const BASE = '/api/layerize-experiment/image-templates';
type Event = { kind: string; source: string; prompt?: string; size?: string; inputs?: string[] };
async function fixture(request: APIRequestContext, seed: string, fail = false) {
  const image = await request.get(`/__test__/offer-reference.png?seed=${encodeURIComponent(seed)}${fail ? '&failAnalysis=1' : ''}`);
  return { buffer: await image.body(), source: image.headers()['x-fixture-source'] };
}
async function events(request: APIRequestContext, source: string): Promise<Event[]> { return (await request.get(`/__test__/reference-events?source=${source}`)).json(); }
const canvas = (page: Page) => page.evaluate(() => {
  const frame = document.querySelector('[data-testid="template-canvas"]')!;
  const stage = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages.find(s => frame.contains(s.container()))!;
  return stage.find<Group>('.template-element').map(n => ({ id: n.id(), x: n.x(), y: n.y(), width: n.offsetX() * 2, height: n.offsetY() * 2,
    rotation: n.rotation(), texts: n.find<Text>('.template-text').map(t => ({ text: t.text(), font: t.fontFamily(), size: t.fontSize(), color: t.fill() })) }));
});
async function enter(page: Page, manual = false) {
  page.on('dialog', dialog => void dialog.accept());
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.goto('/'); await page.getByRole('button', { name: 'Create Own Template', exact: true }).click();
  const studio = page.getByRole('dialog', { name: 'Create Own Template' });
  if (manual) { await studio.getByRole('button', { name: '+ Heading', exact: true }).click(); await expect(studio.locator('.tpl-main')).not.toHaveAttribute('data-fonts-state', 'loading'); }
  await studio.getByRole('button', { name: 'Create from Reference Image', exact: true }).click();
  return page.getByRole('dialog', { name: 'Create from Reference Image', exact: true });
}
async function upload(page: Page, buffer: Buffer, name = 'headphones.png') {
  await page.getByLabel('Reference creative image', { exact: true }).setInputFiles({ name, mimeType: 'image/png', buffer });
  await expect(page.getByRole('button', { name: 'Analyze reference', exact: true })).toBeEnabled();
}
async function analyze(page: Page) {
  await page.getByRole('button', { name: 'Analyze reference', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Detected reference style' })).toContainText('Minimal blue premium electronics creative', { timeout: 15000 });
  await expect(page.getByLabel('Product / Object', { exact: true })).toBeVisible();
}
async function generated(page: Page) {
  for (const id of ['1x1', '4x5', '16x9']) await expect(page.getByTestId(`status-${id}`)).toHaveText('Generated', { timeout: 20000 });
}

test('reference product campaign: one analysis, three canonical two-image requests, association, history, save/reload and editor', async ({ page, request }, testInfo) => {
  test.setTimeout(60000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const dialog = await enter(page, true), originalCanvas = await canvas(page);
  const ref = await fixture(request, `core-${testInfo.project.name}`); await upload(page, ref.buffer);
  expect(await events(request, ref.source)).toEqual([]);
  await analyze(page);
  await dialog.locator('.reference-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('reference-overview.png'), fullPage: true });
  expect(await dialog.locator('.reference-scroll').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const detected = dialog.getByRole('region', { name: 'Detected reference style' });
  await detected.getByText('Composition and business zones', { exact: true }).click();
  await expect(detected.getByText('Typography mood', { exact: true })).toBeVisible();
  await detected.getByText('Card / panel geometry', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('reference-blueprint.png'), fullPage: true });
  await detected.getByText('Composition and business zones', { exact: true }).click();
  await dialog.getByLabel('Campaign name', { exact: true }).fill(`Samsung launch ${testInfo.project.name}`);
  await dialog.getByLabel('Product / Object', { exact: true }).fill('Samsung Galaxy phone');
  await dialog.getByRole('button', { name: 'Add Diwali theme', exact: true }).click();
  const product = await request.get('/__test__/reference.png'), bytes = await product.body();
  await dialog.getByLabel('Replacement product image', { exact: true }).setInputFiles({ name: 'phone.png', mimeType: 'image/png', buffer: bytes });
  await expect(dialog.getByAltText('Replacement product', { exact: true })).toBeVisible();
  await dialog.getByText('Advanced · Full editable prompt', { exact: false }).click();
  await expect(dialog.getByLabel('Full prompt', { exact: true })).toHaveValue(/Samsung Galaxy phone/);
  await page.screenshot({ path: testInfo.outputPath('reference-guided.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Draft saved' })).toBeVisible();
  expect((await events(request, ref.source)).map(e => e.kind)).toEqual(['analysis']);
  const start = page.waitForResponse(r => r.url().endsWith('/generate') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Generate 3 variants', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  const group = await (await start).json(); await generated(page);
  const calls = await events(request, ref.source); expect(calls.filter(e => e.kind === 'analysis')).toHaveLength(1);
  const images = calls.filter(e => e.kind === 'generation'); expect(images).toHaveLength(3);
  expect(images.map(e => e.size)).toEqual(['1024x1024','1216x1520','1536x864']);
  for (const e of images) { expect(e.inputs).toEqual([ref.source, createHash('sha256').update(bytes).digest('hex')]); expect(e.prompt).toContain('Product / Object: Samsung Galaxy phone'); }
  await dialog.getByRole('button', { name: 'Use Generated Set', exact: true }).click();
  expect(await canvas(page)).toEqual(originalCanvas);
  await dialog.getByRole('button', { name: 'Back to template', exact: true }).click();
  const studio = page.getByRole('dialog', { name: 'Create Own Template' });
  await expect(studio.getByRole('button', { name: 'Open reference campaign', exact: true })).toBeVisible();
  await studio.getByRole('group', { name: 'Template history' }).getByRole('button', { name: /Undo/ }).click();
  await expect(studio.getByRole('button', { name: 'Create from Reference Image', exact: true })).toBeVisible();
  expect(await canvas(page)).toEqual(originalCanvas);
  await studio.getByRole('group', { name: 'Template history' }).getByRole('button', { name: /Redo/ }).click();
  expect(await canvas(page)).toEqual(originalCanvas);
  await studio.getByRole('button', { name: 'Save Template', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: 'Create Own Template', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Template', exact: true }).click();
  await page.getByRole('button', { name: 'Open reference campaign', exact: true }).click();
  await expect(dialog.getByTestId('status-1x1')).toHaveText('Generated');
  expect((await events(request, ref.source)).filter(e => e.kind === 'generation')).toHaveLength(3);
  const card = dialog.getByRole('article', { name: '1:1 result', exact: true });
  await card.getByRole('button', { name: 'Decompose into layers', exact: true }).click();
  await expect(card.getByTestId('status-1x1')).toHaveText('Decomposed', { timeout: 20000 });
  await dialog.getByRole('button', { name: 'Decompose all (2)', exact: true }).click();
  for (const id of ['1x1', '4x5', '16x9']) await expect(dialog.getByTestId(`status-${id}`)).toHaveText('Decomposed', { timeout: 20000 });
  await card.getByText('Preview layers', { exact: true }).click(); await expect(card.locator('.cti-layer-previews img')).toHaveCount(2);
  await dialog.getByRole('region', { name: 'Campaign results' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('reference-results.png'), fullPage: true });
  await card.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole('list', { name: 'Design layers' }).locator('li')).toHaveCount(2);
  expect((await request.get(`${BASE}/${group.id}`, { headers: { origin: new URL(page.url()).origin } })).ok()).toBe(true); expect(errors).toEqual([]);
});

test('festival changes preserve style locally; custom mode stays exact and retry only sends failed portrait', async ({ page, request }, testInfo) => {
  const dialog = await enter(page), ref = await fixture(request, `festival-${testInfo.project.name}`);
  await upload(page, ref.buffer); await analyze(page);
  await dialog.getByRole('button', { name: 'Add Diwali theme', exact: true }).click();
  await expect(dialog.getByLabel('Festival', { exact: true })).toHaveValue('Diwali');
  await dialog.getByLabel('Background', { exact: true }).fill('warm gold atmospheric gradient');
  await dialog.getByText('Advanced · Full editable prompt', { exact: false }).click();
  const prompt = dialog.getByLabel('Full prompt', { exact: true }), guided = await prompt.inputValue();
  expect(guided).toContain('Festival: Diwali'); expect(guided).toContain('Layout, hierarchy and spacing'); expect(guided).toContain('Diyas, gold bokeh');
  const custom = `${guided} Portrait retry test.`; await prompt.fill(custom);
  await expect(dialog.getByRole('status')).toContainText('Custom prompt edited');
  await dialog.getByLabel('Theme / Mood', { exact: true }).fill('Minimal Holi campaign'); await expect(prompt).toHaveValue(custom);
  expect((await events(request, ref.source)).map(e => e.kind)).toEqual(['analysis']);
  await dialog.getByRole('button', { name: 'Generate 3 variants', exact: true }).click();
  await expect(dialog.getByTestId('status-1x1')).toHaveText('Generated', { timeout: 15000 });
  await expect(dialog.getByTestId('status-4x5')).toHaveText('Failed');
  await expect(dialog.getByTestId('status-16x9')).toHaveText('Generated');
  const before = await events(request, ref.source); expect(before.filter(e => e.kind === 'generation')).toHaveLength(3);
  expect(before.filter(e => e.kind === 'generation').every(e => e.prompt?.startsWith(custom))).toBe(true);
  await dialog.getByRole('article', { name: '4:5 result', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('reference-partial-failure.png'), fullPage: true });
  await dialog.getByRole('article', { name: '4:5 result', exact: true }).getByRole('button', { name: 'Try again', exact: true }).click(); await generated(page);
  const after = await events(request, ref.source); expect(after.filter(e => e.kind === 'generation')).toHaveLength(4);
  expect(after.at(-1)?.size).toBe('1216x1520'); expect(after.filter(e => e.kind === 'analysis')).toHaveLength(1);
});

test('source replacement ignores a late generation, clears analysis, and preserves existing canvas', async ({ page, request }, testInfo) => {
  page.on('dialog', dialog => void dialog.accept());
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.goto('/'); await page.getByRole('button', { name: 'Create Own Template', exact: true }).click();
  const studio = page.getByRole('dialog', { name: 'Create Own Template' });
  await studio.getByRole('button', { name: '+ Heading', exact: true }).click();
  await studio.getByRole('button', { name: 'Create from Reference Image', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create from Reference Image', exact: true });
  const a = await fixture(request, `stale-a-${testInfo.project.name}`), b = await fixture(request, `stale-b-${testInfo.project.name}`);
  await upload(page, a.buffer); await analyze(page);
  await dialog.getByLabel('Product / Object', { exact: true }).fill('Slow phone');
  const start = page.waitForResponse(r => r.url().endsWith('/generate') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Generate 3 variants', exact: true }).click(); const old = await (await start).json();
  await upload(page, b.buffer, 'new-reference.png');
  await expect(dialog.getByRole('region', { name: 'Detected reference style' })).toHaveCount(0);
  await expect.poll(async () => (await (await request.get(`${BASE}/${old.id}`, { headers: { origin: new URL(page.url()).origin } })).json()).variants.every((v: { status: string }) => v.status === 'done'), { timeout: 20000 }).toBe(true);
  await expect(dialog.getByRole('article')).toHaveCount(0); await expect(dialog.getByRole('button', { name: 'Analyze reference', exact: true })).toBeEnabled();
  expect(await events(request, b.source)).toEqual([]);
  await analyze(page); await dialog.getByRole('button', { name: 'Generate 3 variants', exact: true }).click(); await generated(page);
  expect((await events(request, b.source)).filter(e => e.kind === 'generation').map(e => e.inputs)).toEqual([[b.source], [b.source], [b.source]]);
  await dialog.getByRole('button', { name: 'Back to template', exact: true }).click();
  await expect(studio.locator('.tpl-layers li')).toHaveCount(1);
});

test('analysis failure keeps upload, explicit retry then saved custom draft reloads without a new call', async ({ page, request }, testInfo) => {
  const dialog = await enter(page), ref = await fixture(request, `analysis-fail-${testInfo.project.name}`, true);
  await upload(page, ref.buffer); await dialog.getByRole('button', { name: 'Analyze reference', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Retry analysis', exact: true })).toBeVisible();
  await expect(dialog.getByAltText('Uploaded creative reference')).toBeVisible();
  await dialog.getByRole('button', { name: 'Retry analysis', exact: true }).click();
  await expect(dialog.getByLabel('Product / Object', { exact: true })).toBeVisible();
  await dialog.getByText('Advanced · Full editable prompt', { exact: false }).click();
  const custom = 'Use the original blue creative with a silver phone and preserve its panel layout.';
  await dialog.getByLabel('Full prompt', { exact: true }).fill(custom); await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Draft saved' })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Create Own Template', exact: true }).click(); await page.getByRole('button', { name: 'Create from Reference Image', exact: true }).click();
  await dialog.getByText('Advanced · Full editable prompt', { exact: false }).click(); await expect(dialog.getByLabel('Full prompt', { exact: true })).toHaveValue(custom);
  expect((await events(request, ref.source)).map(e => e.kind)).toEqual(['analysis', 'analysis']);
  await dialog.getByRole('button', { name: 'Rebuild from fields', exact: true }).click();
  await expect(dialog.getByLabel('Full prompt', { exact: true })).toHaveValue(/Keep subject: AirPods Max/);
  expect((await events(request, ref.source)).filter(e => e.kind === 'generation')).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Generate 3 variants', exact: true }).click(); await generated(page);
  const rebuilt = await dialog.getByLabel('Full prompt', { exact: true }).inputValue();
  expect((await events(request, ref.source)).filter(e => e.kind === 'generation').every(e => e.prompt?.startsWith(rebuilt))).toBe(true);
});

test('closing a session invalidates a pending status response before a new source is opened', async ({ page, request }, testInfo) => {
  const dialog = await enter(page), a = await fixture(request, `close-a-${testInfo.project.name}`), b = await fixture(request, `close-b-${testInfo.project.name}`);
  await upload(page, a.buffer); await analyze(page); await dialog.getByLabel('Product / Object', { exact: true }).fill('Slow phone');
  const start = page.waitForResponse(r => r.url().endsWith('/generate') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Generate 3 variants', exact: true }).click(); const old = await (await start).json();
  let release!: () => void, arrived = false, completed!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), delivered = new Promise<void>(resolve => { completed = resolve; });
  await page.route(`**${BASE}/${old.id}`, async route => {
    const response = await route.fetch(); arrived = true; await held; await route.fulfill({ response }); completed();
  }, { times: 1 });
  await expect.poll(() => arrived).toBe(true);
  await dialog.getByRole('button', { name: 'Back to template', exact: true }).click();
  await page.getByRole('button', { name: 'Create from Reference Image', exact: true }).click();
  await expect(dialog.getByLabel('Product / Object', { exact: true })).toHaveValue('Slow phone');
  await upload(page, b.buffer, 'campaign-b.png'); release(); await delivered;
  await expect(dialog.getByRole('article')).toHaveCount(0); await expect(dialog.getByRole('region', { name: 'Detected reference style' })).toHaveCount(0);
  await analyze(page); await expect(dialog.getByLabel('Product / Object', { exact: true })).toHaveValue('');
  expect((await events(request, b.source)).map(e => e.kind)).toEqual(['analysis']);
});
