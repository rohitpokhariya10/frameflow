import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ProjectDocument, ProtectedTemplateView, StyleVariationView, VariationEstimate } from '@frameflow/shared';
import type { Stage } from 'konva/lib/Stage';
import type { Text } from 'konva/lib/shapes/Text';
import { fixture } from './wizard.helpers';

const fixtureDir = process.env.FRAMEFLOW_SAVED_VARIATION_FIXTURE;
test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` }, actionTimeout: 15_000 });
test('saved poster keeps ten independent bank slots and editable words through variation save and reopen', async ({ page, request }, testInfo) => {
  test.skip(!fixtureDir || !existsSync(join(fixtureDir, 'verification.json')), 'Prepare the local poster copy with tests/fixtures/prepareSavedVariation.ts.');
  test.setTimeout(120_000);
  const { templateId, name } = JSON.parse(readFileSync(join(fixtureDir!, 'verification.json'), 'utf8')) as { templateId: string; name: string };
  const templateUrl = `/api/layerize-experiment/protected-templates/${templateId}`;
  const original = await (await request.get(templateUrl)).json() as ProtectedTemplateView;
  const banks = original.textAnalysis!.logoSlots.filter(l => l.detection === 'tile-grid');
  expect(banks).toHaveLength(10);
  const path = `/api/template-studio/protected/${templateId}/variations`;
  const variationRequest = { slots: [{ presetId: 'premium-minimal', source: 'ai' }], typographyMode: 'match', quality: 'medium' };
  const estimate = await (await request.post(`${path}/estimate`, { data: { request: variationRequest } })).json() as VariationEstimate;
  expect(estimate.model).toBe('gpt-image-2');
  // This server injects FakeProvider and blocks external fetch. The confirmation exercises the real API gate only.
  const result = await request.post(path, { data: { idempotencyKey: crypto.randomUUID(), request: variationRequest,
    confirm: { paid: true, estimateMicroUsd: estimate.confirmMicroUsd } } });
  expect(result.ok(), await result.text()).toBe(true);
  const batch = await result.json() as { batch: { variationIds: string[] } };
  const variationUrl = `/api/template-studio/variations/${batch.batch.variationIds[0]}`;
  await expect.poll(async () => ((await (await request.get(variationUrl)).json()) as { variation: StyleVariationView }).variation.status, { timeout: 60_000 }).toMatch(/^(ready|needs_review)$/);
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.goto('/');
  const open = async () => {
    await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
    const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
    await panel.getByRole('tab', { name: 'Protected Templates', exact: true }).click();
    await panel.getByRole('article', { name: `Protected template ${name}` }).getByRole('button', { name: 'Open' }).click();
    const card = panel.getByRole('article', { name: /^Variation 1:/ }).first();
    await expect(card.getByTestId('measured-text-overflow')).toBeVisible();
    await card.getByRole('button', { name: 'Open in editor' }).click();
    await expect(panel).toBeHidden();
  };
  await open();
  const texts = await page.evaluate(() => (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0].find<Text>('.editable-text').map(n => n.text()));
  for (const word of ['Easy', 'EMI', 'available.']) expect(texts.filter(t => t === word)).toHaveLength(1);
  const layers = page.getByRole('list', { name: 'Design layers' });
  for (const bank of banks) {
    await layers.locator('.layer-select').filter({ hasText: `Logo · ${bank.label} (replaced)` }).getByText(`Logo · ${bank.label} (replaced)`, { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Replace image', exact: true })).toBeVisible();
  }
  const readDocument = () => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!) as ProjectDocument);
  await expect.poll(async () => (await readDocument()).variants[0].importedFrom?.runId).toBe(batch.batch.variationIds[0]);
  const before = await readDocument(), id = before.id;
  const lastBank = banks[banks.length - 1];
  const beforeLayer = before.variants[0].layers!.find(l => l.protectedSlot?.logoSlotId === lastBank.id)!;
  await page.getByLabel('Replacement image', { exact: true }).setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: await fixture(request, '/__test__/variation-logo.png') });
  await expect.poll(async () => {
    const layer = (await readDocument()).variants[0].layers!.find(l => l.id === beforeLayer.id);
    return layer?.type === 'image' ? layer.assetId : null;
  }).not.toBe(beforeLayer.type === 'image' ? beforeLayer.assetId : null);
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('list', { name: 'Text elements' }).getByRole('button', { name: 'Easy generic-text', exact: true }).click();
  await page.getByLabel('Font family', { exact: true }).selectOption('Lora');
  await page.getByRole('spinbutton', { name: 'Font size', exact: true }).fill('55');
  await page.getByRole('spinbutton', { name: 'Font size', exact: true }).blur();
  await expect.poll(async () => (await readDocument()).variants[0].elements.find(e => e.text === 'Easy')?.fontSize).toBe(55);
  // Correct the measured tenure overflow using the actual editor, with no new image generation.
  await page.getByRole('list', { name: 'Text elements' }).getByRole('button', { name: '3-6-9-12-18-24 generic-text', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Font size', exact: true }).fill('40');
  await page.getByRole('spinbutton', { name: 'Font size', exact: true }).blur();
  await expect.poll(() => page.evaluate(() => {
    const nodes = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0].find<Text>('.editable-text');
    const tenure = nodes.find(n => n.text() === '3-6-9-12-18-24')!, months = nodes.find(n => n.text() === 'months')!;
    return tenure.x() + tenure.getTextWidth() <= months.x();
  })).toBe(true);
  await expect.poll(async () => (await readDocument()).variants[0].elements.find(e => e.text === '3-6-9-12-18-24')?.fontSize).toBe(40);
  const saved = await readDocument();
  await page.screenshot({ path: testInfo.outputPath('saved-poster-editor.png') });
  await page.reload();
  await open();
  await expect.poll(async () => (await readDocument()).id).toBe(id);
  expect((await readDocument()).variants[0]).toEqual(saved.variants[0]);
  expect(await (await request.get(templateUrl)).json()).toEqual(original);
  await page.screenshot({ path: testInfo.outputPath('saved-poster-reopened.png') });
});
