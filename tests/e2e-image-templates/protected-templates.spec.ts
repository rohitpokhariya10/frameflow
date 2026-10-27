import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Stage } from 'konva/lib/Stage';
import type { Text } from 'konva/lib/shapes/Text';
import { fixture } from './wizard.helpers';

test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` } });

// Protected templates on the offline fixture: real routes, storage, editor and export; fal is faked (Seedream answers
// with the clean base and its phone), every other model is counted and must stay unused. Nothing leaves this machine.
const API = '/api/layerize-experiment';
/** A template's runs, and how many Seedream submissions carried each run's exact uploaded image (exact while other specs run). */
async function seedreamOf(request: APIRequestContext, templateId: string) {
  expect(templateId).toMatch(/^pt-[a-f0-9]{12}$/);
  const template = await (await request.get(`${API}/protected-templates/${templateId}`)).json() as { runs: { runId: string }[] };
  const runs = await Promise.all(template.runs.map(async r => (await request.get(`${API}/runs/${r.runId}`)).json() as Promise<{ id: string; providerImage?: { provider: { sha256: string } } }>));
  const submissions = await Promise.all(runs.map(async r => r.providerImage ? ((await (await request.get(`/__test__/extractions?image=${r.providerImage.provider.sha256}`)).json()) as { count: number }).count : 0));
  return { runs: runs.map(r => r.id), submissions: submissions.reduce((a, b) => a + b, 0) };
}
/** Every model a run's diagnostics record a call to (the planner and image edit appear only if called). */
async function modelsOf(request: APIRequestContext, runId: string) {
  const d = await (await request.get(`${API}/runs/${runId}/diagnostics`)).json() as { stages: { id: string; status: string; calls: { kind: string; model?: string }[] }[] };
  return { called: [...new Set(d.stages.flatMap(st => st.calls.map(c => `${c.kind}:${c.model ?? '?'}`)))], planner: d.stages.find(st => st.id === 'planner')?.status };
}
const templateIdOf = (page: Page) => page.evaluate(() => [...document.querySelectorAll('img, svg.pt-canvas image')].map(i => i.getAttribute('src') ?? i.getAttribute('href') ?? '').map(src => /protected-templates\/(pt-[a-f0-9]{12})\//.exec(src)?.[1]).find(Boolean)!);
const upload = (name: string, buffer: Buffer) => ({ name, mimeType: 'image/png', buffer });

async function openProtected(page: Page) {
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Protected Templates', exact: true }).click();
  return panel;
}
/** A source-pixel point as a screen point, through the region editor's own SVG transform. */
const screenOf = (page: Page, x: number, y: number) => page.evaluate(([sx, sy]) => {
  const svg = document.querySelector<SVGSVGElement>('svg.pt-canvas')!, p = svg.createSVGPoint(); p.x = sx; p.y = sy;
  const q = p.matrixTransform(svg.getScreenCTM()!); return { x: q.x, y: q.y };
}, [x, y] as const);
async function draw(page: Page, panel: Locator, kind: string, from: [number, number], to: [number, number]) {
  await panel.getByLabel('Kind of new region').selectOption(kind);
  await panel.getByRole('button', { name: 'Draw region' }).click();
  await panel.locator('svg.pt-canvas').scrollIntoViewIfNeeded();
  const a = await screenOf(page, ...from), b = await screenOf(page, ...to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2); await page.mouse.move(b.x, b.y); await page.mouse.up();
  await panel.getByRole('button', { name: 'Select', exact: true }).click();
}
async function geometry(panel: Locator, box: [number, number, number, number]) {
  for (const [label, value] of [['X', box[0]], ['Y', box[1]], ['Width', box[2]], ['Height', box[3]]] as const) await panel.getByRole('spinbutton', { name: `${label} (source pixels)` }).fill(String(value));
}
const reviewed = (panel: Locator) => panel.getByRole('checkbox', { name: /^Reviewed/ }).check();

test('an administrator protects logos and copy, decomposes the rest with Seedream only, and reuses the template in the editor', async ({ page, request }, testInfo) => {
  test.setTimeout(240_000);
  const panel = await openProtected(page);
  const seed = crypto.randomUUID(), name = `EMI offers ${seed.slice(0, 6)}`;
  await panel.getByLabel('Source creative').setInputFiles(upload('emi-poster.png', await fixture(request, `/__test__/protected-source.png?seed=${seed}`)));
  await panel.getByLabel('Template name').fill(name);
  await panel.getByRole('button', { name: 'Create protected template' }).click();
  await expect(panel.getByRole('heading', { name: new RegExp(name) })).toBeVisible();
  await expect(panel.getByText('Mark protected content').first()).toBeVisible();
  const templateId = await templateIdOf(page);

  // Draw each region on the creative, then set its exact source pixels (the drawn box lands where it was drawn).
  await draw(page, panel, 'logo', [60, 60], [260, 140]);
  for (const [label, expected] of [['X', 60], ['Y', 60], ['Width', 200], ['Height', 80]] as const) expect(Math.abs(Number(await panel.getByRole('spinbutton', { name: `${label} (source pixels)` }).inputValue()) - expected)).toBeLessThanOrEqual(2);
  await panel.getByLabel('Name', { exact: true }).fill('Bank A logo'); await geometry(panel, [60, 60, 200, 80]); await reviewed(panel);
  await draw(page, panel, 'logo', [300, 50], [400, 150]);
  await panel.getByLabel('Name', { exact: true }).fill('Bank B logo'); await geometry(panel, [300, 50, 100, 100]); await reviewed(panel);
  await draw(page, panel, 'text', [50, 310], [410, 400]);
  await panel.getByLabel('Name', { exact: true }).fill('Headline'); await geometry(panel, [50, 310, 360, 90]);
  await panel.getByRole('radio', { name: /Editable text/ }).check();
  await panel.getByLabel('Text, exactly as it appears').fill('Easy EMI');
  await panel.getByLabel('Font family', { exact: true }).fill('Inter');
  await panel.getByLabel('Font size (source pixels)').fill('72');
  await panel.getByLabel('Font weight').selectOption('700');
  await panel.getByLabel('Text colour').fill('#ffffff');
  await reviewed(panel);
  await draw(page, panel, 'legal', [50, 1128], [770, 1160]);
  await panel.getByLabel('Name', { exact: true }).fill('Fine print'); await geometry(panel, [50, 1128, 720, 32]);
  await panel.getByLabel('Text, exactly as it appears').fill('T&C apply. EMI on select bank cards. Offer valid till 31 Oct 2026.');
  await panel.getByLabel('Font size (source pixels)').fill('18');
  await panel.getByLabel('Text colour').fill('#e8f4f4');
  await reviewed(panel);
  await expect(panel.getByRole('list', { name: 'Protected elements' }).getByRole('button')).toHaveCount(4);
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByText('Saved.', { exact: true })).toBeVisible();
  await expect(panel.getByTestId('normalized')).toContainText('x 0.0556');
  await panel.locator('svg.pt-canvas').scrollIntoViewIfNeeded();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('protected-regions.png') });

  // The banks' original logo files, stored byte for byte.
  for (const [label, file] of [['Bank A logo', 'protected-logo-a.png'], ['Bank B logo', 'protected-logo-b.png']] as const) {
    await panel.getByRole('list', { name: 'Protected elements' }).getByRole('button', { name: new RegExp(label) }).click();
    await panel.getByLabel(`Original file for ${label}`).setInputFiles(upload(file, await fixture(request, `/__test__/${file}`)));
    await expect(panel.getByText('Original file stored byte for byte.')).toBeVisible();
    await expect(panel.getByRole('radio', { name: /Original file/ })).toBeChecked();
  }
  await panel.getByRole('button', { name: 'Confirm protected regions' }).click();
  await expect(panel.getByText('Protected regions confirmed.')).toBeVisible();

  // The clean artwork, checked against the source, shown as exactly what Seedream will get, then approved.
  await panel.getByLabel('Clean artwork').setInputFiles(upload('emi-clean.png', await fixture(request, `/__test__/protected-clean.png?seed=${seed}`)));
  await expect(panel.getByText('Checks passed')).toBeVisible();
  await expect(panel.getByRole('img', { name: 'The exact image proposed for Seedream' })).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Base checks' }).getByText('removed from the base')).toHaveCount(4);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('protected-base.png'), fullPage: false });
  await panel.getByRole('button', { name: 'Approve this base' }).click();

  // One paid request to Seedream, confirmed with its cost; nothing else.
  const checks = panel.getByRole('list', { name: 'Checks before the paid request' });
  await expect(checks.getByText(/Only bytedance\/seedream\/v5\/pro\/layerize \(one request\)/)).toBeVisible();
  await panel.getByRole('button', { name: 'Decompose with Seedream…' }).click();
  await expect(panel.getByText(/Send the prepared base to bytedance\/seedream\/v5\/pro\/layerize\?/)).toBeVisible();
  await expect(panel.getByRole('group', { name: 'Confirm the paid request' })).toContainText('up to $0.57');
  await panel.getByRole('button', { name: 'Send to Seedream (paid)' }).click();
  await expect(panel.getByRole('table')).toContainText('Measured against the source', { timeout: 60_000 });
  // One Seedream submission of the clean base; the run's diagnostics record no planner and no other model.
  const sent = await seedreamOf(request, templateId);
  expect(sent).toMatchObject({ submissions: 1 }); expect(sent.runs).toHaveLength(1);
  expect(await modelsOf(request, sent.runs[0])).toEqual({ called: ['seedream:bytedance/seedream/v5/pro/layerize'], planner: 'Skipped' });

  // Review: the restored pixels are exact where fully protected; then approve.
  const metrics = panel.getByRole('table');
  await expect(metrics.getByRole('row', { name: /Fine print/ })).toContainText('100%');
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('protected-review.png') });
  await panel.getByRole('checkbox', { name: 'I checked the notes above.' }).check();
  await panel.getByRole('button', { name: 'Approve template' }).click();
  await expect(panel.getByText('Approved template').first()).toBeVisible();

  // The editor: Seedream's layers under the protected slots, at their source pixels.
  await panel.getByRole('button', { name: 'Open in editor' }).click();
  await expect(panel).toBeHidden();
  const layers = page.getByRole('list', { name: 'Design layers' });
  await expect(layers.locator('.layer-name')).toHaveText(['Protected legal / fine print · Fine print (original pixels)', 'Protected logo · Bank B logo (original file)', 'Protected logo · Bank A logo (original file)', 'Phone (z1)', 'Seedream base (z0)']);
  const field = (label: string) => page.getByRole('spinbutton', { name: label, exact: true });
  await layers.locator('.layer-select').filter({ hasText: 'Bank A logo' }).click();
  await expect(page.getByTestId('protected-slot')).toContainText('Protected logo slot: an image file');
  expect(await Promise.all(['X', 'Y', 'Width', 'Height'].map(async l => Number(await field(l).inputValue())))).toEqual([60, 60, 200, 80]);
  const texts = await page.evaluate(() => (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0].find<Text>('.editable-text').map(n => ({ text: n.text(), x: n.x(), y: n.y(), draggable: n.draggable() })));
  expect(texts).toEqual([{ text: 'Easy EMI', x: 50, y: 310, draggable: false }]);

  // Replace Bank B's logo in its slot: same box, new picture.
  await layers.locator('.layer-select').filter({ hasText: 'Bank B logo' }).click();
  await page.getByLabel('Replacement image').setInputFiles(upload('new-bank.png', await fixture(request, '/__test__/protected-logo-new.png')));
  expect(await Promise.all(['X', 'Y', 'Width', 'Height'].map(async l => Number(await field(l).inputValue())))).toEqual([300, 50, 100, 100]);
  await expect(layers.locator('.layer-name').nth(1)).toHaveText('Protected logo · Bank B logo (replaced)');
  // Edit the protected headline's copy; it stays locked in place until unlocked.
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await page.getByRole('list', { name: 'Text elements' }).getByRole('button').first().click();
  await expect(page.getByTestId('protected-slot')).toContainText('Locked on the canvas');
  await page.getByLabel('Text content').fill('No-cost EMI');

  // Export: the source's own size, Bank A's original logo pixels where they were, the new logo in Bank B's slot.
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG', exact: true }).click();
  const file = await waiting, bytes = await readFile((await file.path())!);
  const pixels = await page.evaluate(async (base64) => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
    const at = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { width: image.naturalWidth, height: image.naturalHeight, bankA: at(100, 100), bankB: at(310, 100), aboveB: at(350, 62), phone: at(650, 700) };
  }, bytes.toString('base64'));
  expect(pixels).toMatchObject({ width: 900, height: 1200, bankA: [200, 16, 46], phone: [159, 183, 217] });
  // The replacement (200×80) is fitted in the 100×100 slot without distortion (100×40, centred): its orange on the slot's
  // centre row, and above it the clean background, not the old green logo (no duplicate).
  expect(pixels.bankB[0]).toBeGreaterThan(230); expect(pixels.bankB[1]).toBeGreaterThan(90); expect(pixels.bankB[1]).toBeLessThan(130); expect(pixels.bankB[2]).toBeLessThan(60);
  expect(Math.abs(pixels.aboveB[0] - 11) + Math.abs(pixels.aboveB[1] - 111) + Math.abs(pixels.aboveB[2] - 123)).toBeLessThan(30);

  // Reopen: the design and its slots come back from this device's storage.
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('list', { name: 'Design layers' }).locator('.layer-name')).toHaveCount(5);
  await page.getByRole('list', { name: 'Design layers' }).locator('.layer-select').filter({ hasText: 'Bank B logo' }).click();
  await expect(page.getByTestId('protected-slot')).toContainText('Protected logo slot');
  const reopened = await page.evaluate(() => (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0].find<Text>('.editable-text').map(n => n.text()));
  expect(reopened).toEqual(['No-cost EMI']);

  // Reuse: new copy and a new logo in their saved slots, as a new design, with no decomposition and no AI call.
  const again = await openProtected(page);
  await again.getByRole('article', { name: `Protected template ${name}` }).getByRole('button', { name: 'Open' }).click();
  const reuse = again.getByRole('region', { name: 'Reuse with new content' });
  await reuse.getByLabel('What to do with Headline').selectOption('text');
  await reuse.getByLabel('New text for Headline').fill('Diwali EMI from ₹999');
  await reuse.getByLabel('New picture for Bank A logo').setInputFiles(upload('new-bank.png', await fixture(request, '/__test__/protected-logo-new.png')));
  await reuse.getByLabel('Design name').fill('Diwali EMI reuse');
  await reuse.getByRole('button', { name: 'Create a new design' }).click();
  await expect(again).toBeHidden();
  await expect(page.getByRole('list', { name: 'Design layers' }).locator('.layer-name').nth(2)).toHaveText('Protected logo · Bank A logo (replaced)');
  expect(await page.evaluate(() => (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0].find<Text>('.editable-text').map(n => n.text()))).toEqual(['Diwali EMI from ₹999']);
  expect(await seedreamOf(request, templateId)).toEqual(sent);
});

test('a provider refusal is shown as it came, the same base is never sent again, and no other model is offered', async ({ page, request }) => {
  test.setTimeout(180_000);
  const panel = await openProtected(page);
  const seed = crypto.randomUUID(), name = `Refused ${seed.slice(0, 6)}`;
  await panel.getByLabel('Source creative').setInputFiles(upload('refused.png', await fixture(request, `/__test__/protected-source.png?refuse=1&seed=${seed}`)));
  await panel.getByLabel('Template name').fill(name);
  await panel.getByRole('button', { name: 'Create protected template' }).click();
  await expect(panel.getByRole('heading', { name: new RegExp(name) })).toBeVisible();
  const templateId = await templateIdOf(page);
  await panel.getByLabel('Kind of new region').selectOption('logo');
  await panel.getByRole('button', { name: 'Add logo' }).click();
  await geometry(panel, [60, 60, 200, 80]); await reviewed(panel);
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByText('Saved.', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Confirm protected regions' }).click();
  await panel.getByLabel('Clean artwork').setInputFiles(upload('refused-clean.png', await fixture(request, `/__test__/protected-clean.png?refuse=1&seed=${seed}`)));
  await panel.getByRole('button', { name: 'Approve this base' }).click();
  await panel.getByRole('button', { name: 'Decompose with Seedream…' }).click();
  await panel.getByRole('button', { name: 'Send to Seedream (paid)' }).click();
  const status = panel.getByRole('status', { name: 'Latest decomposition' });
  await expect(status.getByRole('alert')).toContainText('Seedream\'s provider refused the prepared base (HTTP 422, partner_validation_failed, billed 0 units)', { timeout: 60_000 });
  await expect(status).toContainText('flagged by a content checker');
  await expect(panel.getByText('Decomposition failed').first()).toBeVisible();
  // A second attempt with the same base is refused by the server before anything is sent.
  await panel.getByRole('button', { name: 'Decompose again…' }).click();
  await panel.getByRole('checkbox', { name: /Send it again as a new paid request/ }).check();
  await panel.getByRole('button', { name: 'Send to Seedream (paid)' }).click();
  await expect(panel.getByRole('alert').filter({ hasText: 'The same image is not sent again' }).first()).toBeVisible();
  expect(await seedreamOf(request, templateId)).toMatchObject({ submissions: 1 });
  expect((await seedreamOf(request, templateId)).runs).toHaveLength(1);
  // The run's dashboard: the refusal and its zero charge; no Qwen, no plan retry, a way back to the template.
  await status.getByRole('button', { name: 'View run, costs and diagnostics' }).click();
  await expect(panel.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Protected template · Seedream only')).toBeVisible();
  await expect(panel.getByText(/Seedream is the only model a protected template uses/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Try Qwen layers' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Retry extraction' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Open protected template' }).click();
  await expect(panel.getByText('Decomposition failed').first()).toBeVisible();
});

test('a reused reference is labelled as such everywhere, and protecting it keeps its text out of a Seedream-only decomposition', async ({ page, request }) => {
  test.setTimeout(240_000);
  const panel = await openProtected(page);
  // Template Studio: a template from the synthetic reference poster (MOCKED analysis), then Match Reference with nothing to
  // change, which reuses the reference itself: no image is generated.
  await panel.getByRole('tab', { name: 'Template Studio', exact: true }).click();
  await panel.getByRole('tab', { name: 'Create Template', exact: true }).click();
  // Create Template asks for the template type first; this is a Product + Text template.
  await panel.getByRole('button', { name: /Product \+ Text/ }).click();
  const seed = crypto.randomUUID(), name = `Reuse ${seed.slice(0, 6)}`;
  const reference = await (await import('sharp')).default(await fixture(request, '/__test__/studio-reference.png')).composite([{ input: { create: { width: 6, height: 6, channels: 3, background: `#${seed.replace(/-/g, '').slice(0, 6)}` } }, left: 1070, top: 1340 }]).png().toBuffer();
  await panel.getByLabel('Upload reference posters').setInputFiles(upload('reference.png', reference));
  await panel.getByLabel('Template name').fill(name);
  await panel.getByRole('button', { name: /Create template & analyse/ }).click();
  await expect(panel.getByText('Template saved.')).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('tab', { name: 'Templates', exact: true }).click();
  await panel.locator('.ts-template-card').filter({ hasText: name }).getByRole('button', { name: 'Generate image' }).click();
  await expect(panel.getByText(/no AI image will be generated and nothing is charged for it: the template's original reference is copied unchanged, with its products, raster text and logos/)).toBeVisible();
  await panel.getByRole('button', { name: 'Generate image', exact: true }).click();
  await expect(panel.getByText('Local reference reuse · no AI image generated.')).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText(/This image is the original reference, copied unchanged/)).toBeVisible();
  // A plain decomposition says exactly what it would send.
  await panel.getByRole('button', { name: 'Approve this image' }).click();
  await panel.getByRole('button', { name: 'Decompose Image into Editable Layers' }).click();
  await expect(panel.getByRole('group', { name: 'Confirm decomposition' })).toContainText('original reference, copied unchanged');
  await expect(panel.getByRole('group', { name: 'Confirm decomposition' })).toContainText('with its raster text and logos');
  await panel.getByRole('button', { name: 'Cancel' }).click();

  // Protect its text instead: the saved analysis's text regions arrive as suggestions to review.
  await panel.getByRole('button', { name: /Protect text & logos, then decompose with Seedream only/ }).click();
  await expect(panel.getByRole('tab', { name: 'Protected Templates', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Reused reference, not a generated image.')).toBeVisible();
  const list = panel.getByRole('list', { name: 'Protected elements' });
  await expect(list.getByRole('button')).toHaveCount(2);
  await expect(list).toContainText('Yellow offer banner');
  await expect(panel.getByRole('button', { name: 'Confirm protected regions' })).toBeDisabled();
  for (const label of ['Yellow offer banner', 'White sub-headline bar']) {
    await list.getByRole('button', { name: new RegExp(label) }).click();
    await expect(panel.getByText(/Suggested from the template's earlier saved analysis/)).toBeVisible();
    await reviewed(panel);
  }
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await panel.getByRole('button', { name: 'Confirm protected regions' }).click();
  await expect(panel.getByText('Protected regions confirmed.')).toBeVisible();
  const templateId = await templateIdOf(page);

  // A flattened image: the regions are continued from their surroundings, shown, and accepted explicitly as an estimate.
  await panel.getByRole('button', { name: 'Fill the regions from their surroundings (local, no AI)' }).click();
  await expect(panel.getByText('Estimate: check it')).toBeVisible();
  await expect(panel.getByRole('img', { name: /Filled areas/ })).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Base checks' })).toContainText('continued (plain field');
  await expect(panel.getByRole('button', { name: 'Approve this base' })).toBeDisabled();
  await panel.getByRole('checkbox', { name: /What lies under the protected content is an estimate/ }).check();
  await panel.getByRole('button', { name: 'Approve this base' }).click();
  await panel.getByRole('button', { name: 'Decompose with Seedream…' }).click();
  await panel.getByRole('button', { name: 'Send to Seedream (paid)' }).click();
  await expect(panel.getByRole('table')).toContainText('Measured against the source', { timeout: 60_000 });
  const sent = await seedreamOf(request, templateId);
  expect(sent.submissions).toBe(1);
  expect(await modelsOf(request, sent.runs[0])).toEqual({ called: ['seedream:bytedance/seedream/v5/pro/layerize'], planner: 'Skipped' });
  // What Seedream got has no banner: the yellow is gone from the prepared base it was sent.
  const base = await (await request.get(`${API}/runs/${sent.runs[0]}`)).json() as { input: { file: string } };
  const pixel = await (await import('sharp')).default(Buffer.from(await (await request.get(`${API}/runs/${sent.runs[0]}/files/${base.input.file}`)).body())).extract({ left: 540, top: 170, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  expect(pixel[0]).toBeLessThan(120); expect(pixel[2]).toBeGreaterThan(150);
  for (const box of await panel.getByRole('checkbox', { name: /I checked/ }).all()) await box.check();
  await panel.getByRole('button', { name: 'Approve template' }).click();
  await expect(panel.getByText('Approved template').first()).toBeVisible();
  await panel.getByRole('button', { name: 'Open in editor' }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole('list', { name: 'Design layers' }).locator('.layer-name').first()).toHaveText('Protected text · White sub-headline bar (original pixels)');
});
