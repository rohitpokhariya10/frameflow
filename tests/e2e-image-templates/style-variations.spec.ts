import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Stage } from 'konva/lib/Stage';
import type { Text } from 'konva/lib/shapes/Text';
import { fixture } from './wizard.helpers';

test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` }, actionTimeout: 15_000 });

// Word-level text and style variations on the offline fixture: the recognizer and the image model are MOCKED (a fixed
// word table and recoloured bases); every call is counted. Nothing leaves this machine.
const API = '/api/layerize-experiment/protected-templates';
const el = (n: number, kind: string, label: string, box: [number, number, number, number]) => ({ id: `pe-${String(n).padStart(10, '0')}`, kind, label, box: { x: box[0], y: box[1], width: box[2], height: box[3], rotation: 0 },
  zIndex: n, representation: 'raster', mask: { mode: 'difference', threshold: 24 }, review: { status: 'approved' }, locked: true, replaceable: true, origin: 'admin' });
const ELEMENTS = [el(1, 'text', 'Main copy: italic serif “Easy”, huge bold “EMI” and “available.”', [60, 80, 780, 590]), el(2, 'text', 'Tenure pill', [70, 680, 540, 100]),
  el(3, 'other', 'Bank cards', [60, 800, 700, 120]), el(4, 'legal', 'T&C line', [60, 1110, 300, 60]), el(5, 'logo', 'Brand logo', [640, 50, 220, 100])];

/** A template with confirmed regions and an approved local-fill base, made through the real routes (all local, free). */
async function readyTemplate(request: APIRequestContext, name: string, seed: string) {
  const ok = async <T>(res: Promise<import('@playwright/test').APIResponse>) => { const r = await res; expect(r.ok(), await r.text()).toBe(true); return r.json() as Promise<T>; };
  let t = await ok<{ id: string; revision: number }>(request.post(API, { multipart: { name, image: { name: 'poster.png', mimeType: 'image/png', buffer: await fixture(request, `/__test__/variation-poster.png?seed=${seed}`) } } }));
  t = await ok(request.put(`${API}/${t.id}/elements`, { data: { expectedRevision: t.revision, elements: ELEMENTS } }));
  t = await ok(request.post(`${API}/${t.id}/confirm-regions`, { data: { expectedRevision: t.revision } }));
  t = await ok(request.post(`${API}/${t.id}/base/local-fill`, { data: { expectedRevision: t.revision } }));
  t = await ok(request.post(`${API}/${t.id}/base/approve`, { data: { expectedRevision: t.revision, acknowledgeUncertain: true } }));
  return t.id;
}
const studioImagePrompts = async (request: APIRequestContext) => ((await (await request.get('/__test__/studio-calls')).json()) as { kind: string; prompt?: string }[]).filter(c => c.kind === 'image').map(c => c.prompt ?? '');
const counts = async (request: APIRequestContext) => (await (await request.get('/__test__/call-counts')).json()) as { openai: number; fal: number; seedream: number };
const editorTexts = (page: Page) => page.evaluate(() => (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0].find<Text>('.editable-text').map(n => ({ text: n.text(), fontStyle: n.fontStyle(), x: n.x() })));

test('words become separate editable texts, and four confirmed style variations keep them outside the AI artwork', async ({ page, request }, testInfo) => {
  test.setTimeout(240_000);
  const seed = crypto.randomUUID(), name = `Variations ${seed.slice(0, 6)}`, templateId = await readyTemplate(request, name, seed);
  const before = { prompts: (await studioImagePrompts(request)).length, calls: await counts(request) };
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Protected Templates', exact: true }).click();
  await panel.getByRole('article', { name: `Protected template ${name}` }).getByRole('button', { name: 'Open' }).click();

  // Step 6: words and logos, read locally; Easy, EMI and available. are three words of one phrase.
  await expect(panel.getByRole('heading', { name: 'Style variations' })).toBeVisible();
  await expect(panel.getByTestId('variations-not-ready').or(panel.getByText('Find and review the words and logos first (step 6).'))).toBeVisible();
  await panel.getByRole('button', { name: 'Find words and logos (local, free)' }).click();
  await expect(panel.getByText('Words and logos found. Review each one.')).toBeVisible();
  const phrases = panel.getByRole('list', { name: 'Phrases' });
  for (const word of ['Easy', 'EMI', 'available.']) await expect(phrases.getByRole('button', { name: `Select word ${word}`, exact: true })).toHaveCount(1);
  await expect(phrases.getByRole('list', { name: /^Line \d of Easy EMI available\.$/ })).toHaveCount(3);
  await expect(panel.getByRole('list', { name: 'Logo slots' }).getByRole('listitem')).toHaveCount(4);
  // Correct the low-confidence word, mark it, approve the rest, save.
  await phrases.getByRole('button', { name: 'Select word apply', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Word apply' })).toContainText('62% confidence');
  await panel.getByLabel('Text, exactly as it appears').fill('apply.');
  await panel.getByRole('button', { name: 'Approve word' }).click();
  await panel.getByRole('button', { name: /Approve all remaining/ }).click();
  await panel.getByRole('button', { name: 'Save words and logos' }).click();
  await expect(panel.getByText('Words and logos saved.')).toBeVisible();
  await expect(panel.getByText('Every word and logo reviewed')).toBeVisible();
  // One bank logo replaced byte for byte; the original pixels stay restorable.
  await panel.getByRole('list', { name: 'Logo slots' }).getByRole('button', { name: /Select logo Bank cards · logo 2/ }).click();
  await panel.getByLabel(/Replacement for Bank cards · logo 2/).setInputFiles({ name: 'new-bank.png', mimeType: 'image/png', buffer: await fixture(request, '/__test__/variation-logo.png') });
  await expect(panel.getByText(/Logo replaced; the original pixels are kept/)).toBeVisible();
  const analysis = (await (await request.get(`${API}/${templateId}`)).json()) as { textAnalysis: { words: { text: string; box: unknown }[]; logoSlots: { replacement?: unknown }[] } };
  expect(analysis.textAnalysis.words.find(w => w.text === 'apply.')).toBeTruthy();
  expect(analysis.textAnalysis.logoSlots.filter(l => l.replacement)).toHaveLength(1);

  // Step 7: four defaults, priced; nothing starts without the explicit confirmation.
  const variations = panel.getByRole('list', { name: 'Variations to make' });
  await expect(variations.getByRole('listitem')).toHaveCount(4);
  await expect(panel.getByRole('region', { name: 'Cost estimate' })).toContainText('for 4 paid image requests');
  await expect(panel.getByRole('region', { name: 'Cost estimate' })).toContainText('Seedream decomposition');
  const generate = panel.getByRole('button', { name: 'Generate 4 variations (4 paid)' });
  await expect(generate).toBeDisabled();
  await panel.getByRole('checkbox', { name: /I confirm 4 paid image requests/ }).check();
  await generate.click();
  const results = panel.getByRole('region', { name: 'Variations' });
  for (const n of [1, 2, 3, 4]) await expect(results.getByRole('article', { name: new RegExp(`^Variation ${n}: `) }).getByText('Ready', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(results.getByText('AI-generated artwork', { exact: true })).toHaveCount(4);
  await expect(results.getByText('No drawn text found in the artwork (local check)')).toHaveCount(4);
  await expect(results.getByText('No overlapping layout boxes (every pair checked)')).toHaveCount(4);
  const prompts = (await studioImagePrompts(request)).slice(before.prompts);
  expect(prompts).toHaveLength(4);
  expect(new Set(prompts).size).toBe(4);
  for (const p of prompts) for (const word of ['Easy', 'EMI', 'available', 'months', 'T&C', 'Bank cards']) expect(p).not.toContain(word);
  // The words are text set by the browser over the artwork, never pixels from the model.
  await expect(results.getByRole('figure', { name: /^Variation 1: .* preview$/ }).locator('.sv-text', { hasText: 'EMI' })).toHaveCount(1);

  // Typography only: no new artwork, no call.
  const card = results.getByRole('article', { name: /^Variation 1: / });
  await card.getByRole('combobox', { name: /^Typography for Variation 1/ }).selectOption('suggested');
  await expect(panel.getByText('Typography changed. No new artwork, no AI call.')).toBeVisible();
  expect((await studioImagePrompts(request)).length).toBe(before.prompts + 4);
  // Adjust one protected word: it needs an explicit confirmation before the variation can be saved.
  // The first result opens its comparison automatically. Exercise closing and reopening it.
  await card.getByRole('button', { name: 'Close comparison' }).click();
  await card.getByRole('button', { name: 'Compare and adjust' }).click();
  const compare = panel.getByRole('region', { name: /^Compare .* with the original$/ });
  // Unsaved edits belong to one variation; switching comparisons must not copy them into another.
  await compare.getByLabel('Text of available.').fill('unsaved draft');
  await results.getByRole('article', { name: /^Variation 2: / }).getByRole('button', { name: 'Compare and adjust' }).click();
  await expect(compare.getByLabel('Text of available.')).toHaveValue('available.');
  await card.getByRole('button', { name: 'Compare and adjust' }).click();
  await expect(compare.getByLabel('Text of available.')).toHaveValue('available.');
  await compare.getByLabel('Text of months').fill('mo.');
  await compare.getByRole('button', { name: 'Apply changes' }).click();
  await expect(card.getByRole('button', { name: 'Save variation' })).toBeDisabled();
  await compare.getByRole('checkbox', { name: /I confirm changing protected duration \/ tenure “months”/ }).check();
  await compare.getByRole('button', { name: 'Apply changes' }).click();
  await expect(card.getByRole('button', { name: 'Save variation' })).toBeEnabled();
  await card.getByRole('button', { name: 'Save variation' }).click();
  await expect(panel.getByText('Variation saved.')).toBeVisible();

  // Open it in the editor: the artwork, the logos, and every word as its own native, editable text.
  await card.getByRole('button', { name: 'Open in editor' }).click();
  await expect(panel).toBeHidden();
  const layers = page.getByRole('list', { name: 'Design layers' });
  await expect(layers).toContainText('Artwork · A · Original-inspired festive · AI-generated artwork');
  await expect(layers).toContainText('Logo · Bank cards · logo 2 (replaced)');
  const texts = await editorTexts(page);
  expect(texts.map(t => t.text)).toEqual(['Easy', 'EMI', 'available.', '3-6-9-12', 'mo.', 'T&Cs', 'apply.']);
  expect(texts.find(t => t.text === 'EMI')!.fontStyle).not.toContain('italic');
  const sourceBefore = await (await request.get(`${API}/${templateId}`)).json();
  const designs = page.getByRole('combobox', { name: 'Open design' });
  const designId = await designs.inputValue(), designCount = await designs.locator('option').count();
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('list', { name: 'Text elements' }).getByRole('button', { name: 'Easy generic-text', exact: true }).click();
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByLabel('Font family', { exact: true }).selectOption('Lora');
  await page.getByRole('spinbutton', { name: 'Font size', exact: true }).fill('64');
  await page.getByRole('spinbutton', { name: 'Font size', exact: true }).blur();
  await page.getByRole('spinbutton', { name: 'Rotation (°)', exact: true }).fill('5');
  await page.getByRole('spinbutton', { name: 'Rotation (°)', exact: true }).blur();
  await expect.poll(() => page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem('frameflow:project:v1')!) as { id: string; variants: { elements: { text: string; fontFamily: string; fontSize: number; rotation?: number }[] }[] };
    const word = doc.variants[0].elements.find(e => e.text === 'Easy');
    return [doc.id, word?.fontFamily, word?.fontSize, word?.rotation];
  })).toEqual([designId, 'Lora', 64, 5]);
  await page.reload();
  await expect(designs).toHaveValue(designId);
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('list', { name: 'Text elements' }).getByRole('button', { name: 'Easy generic-text', exact: true }).click();
  await expect(page.getByLabel('Font family', { exact: true })).toHaveValue('Lora');
  await expect(page.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('64');
  await expect(page.getByRole('spinbutton', { name: 'Rotation (°)', exact: true })).toHaveValue('5');
  await page.screenshot({ path: testInfo.outputPath('variation-editor-reopened.png') });
  // Reopening through the variation returns to this edited document, without importing a duplicate.
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await panel.getByRole('tab', { name: 'Protected Templates', exact: true }).click();
  await panel.getByRole('article', { name: `Protected template ${name}` }).getByRole('button', { name: 'Open' }).click();
  await card.getByRole('button', { name: 'Open in editor' }).click();
  await expect(panel).toBeHidden();
  await expect(designs).toHaveValue(designId);
  await expect(designs.locator('option')).toHaveCount(designCount);
  expect(await (await request.get(`${API}/${templateId}`)).json()).toEqual(sourceBefore);
  // No decomposition and no other model ran for any of this.
  const after = await counts(request);
  expect(after.fal).toBe(before.calls.fal); expect(after.seedream).toBe(before.calls.seedream);
});
