import { createHash } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { API, executionOf as execution, expectEditorLayers, imageCalls, openWizard, ownImage, runOf, started, writesOf } from './wizard.helpers';
// Smart edits and "Generate creative template" against the offline fixture: every model and fal call is faked and
// counted; a test's own counts use its own prompt token. These prove control flow and bindings, not image quality.
test.use({ extraHTTPHeaders: { origin: 'http://127.0.0.1:3317' } });

async function bootstrapTemplate(request: APIRequestContext) {
  const bytes = await (await request.get('/__test__/reference.png')).body();
  const created = await (await request.post(`${API}/template-executions`, { multipart: { mode: 'CREATE_TEMPLATE', idempotencyKey: crypto.randomUUID(), image: { name: 'bootstrap.png', mimeType: 'image/png', buffer: bytes } } })).json();
  await expect.poll(async () => (await execution(request, created.id)).state, { timeout: 90_000 }).toBe('done');
  const template = (await execution(request, created.id)).template as { id: string; name: string };
  const current = (await (await request.get(`${API}/templates/${template.id}`)).json()).template.currentVersion as number;
  return { ...template, version: current, bytes };
}
/**
 * This test's own copy of the reference (one corner block of its own color): its analysis is found by its own hash only,
 * so the saved-template journeys that share the template and its reference never see it.
 */
/** The wizard on Customize for that template, with this test's own image uploaded as the reference. */
async function customize(page: Page, template: { name: string; version: number }, image: Buffer) {
  const panel = await openWizard(page);
  await panel.getByRole('button', { name: `Select ${template.name} v${template.version}`, exact: true }).click();
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await panel.getByLabel('Creative image', { exact: true }).setInputFiles({ name: 'own.png', mimeType: 'image/png', buffer: image });
  await expect(panel.getByText('own.png', { exact: true })).toBeVisible();
  return panel;
}
const fitsWidth = (panel: Locator) => panel.locator('.ws-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1);
const analyze = async (page: Page, panel: Locator) => {
  const answered = page.waitForResponse(r => new URL(r.url()).pathname === `${API}/scene-analyses` && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Analyze image · 1 AI call', exact: true }).click();
  const analysis = await (await answered).json();
  await expect(panel.getByRole('heading', { name: 'What\'s in your image', exact: true })).toBeVisible({ timeout: 30_000 });
  return analysis as { id: string };
};

test('Smart edit: the image\'s own items as controls → an explicit replacement → a resolved plan with inferred changes → exactly that prompt is generated → AI check → decomposition', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One full journey on desktop; phone layouts are checked below.');
  test.setTimeout(150_000);
  const token = `smart-${Date.now().toString(36)}`, errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const template = await bootstrapTemplate(request), panel = await customize(page, template, await ownImage(await (await request.get('/__test__/reference.png')).body())), writes = writesOf(page);
  // Before an analysis: the saved template's fields (the legacy path), and the explicit smart tools. Opening costs nothing.
  await expect(panel.getByLabel('Main product content', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Generate creative template', exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  expect(writes).toEqual([]);
  await analyze(page, panel);
  // Controls come from what was detected in THIS image, with the detected values shown apart from requests.
  const phone = panel.getByRole('article', { name: 'Smartphone', exact: true });
  await expect(phone).toContainText('Lavender smartphone with a dual camera');
  await expect(phone).toContainText('Lumen');
  await expect(phone.getByRole('radio', { name: 'Keep', exact: true })).toBeChecked();
  await expect(panel.getByRole('article', { name: 'Product brand mark', exact: true })).toContainText('printed on Smartphone');
  await expect(panel.getByLabel('Main product content', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('textbox', { name: /headline|offer text|caption/i })).toHaveCount(0);
  await expect(panel.getByRole('region', { name: 'Draft changes', exact: true })).toContainText('Everything is kept as detected: with no changes, use the original image (no image request).');
  // An explicit replacement: draft first, then a resolved plan.
  await phone.getByRole('radio', { name: 'Replace', exact: true }).check();
  await phone.getByLabel('Smartphone: replace with', { exact: true }).fill(`Xiaomi phone ${token}`);
  await expect(panel.getByRole('region', { name: 'Draft changes', exact: true })).toContainText(`Smartphone: Xiaomi phone ${token}`);
  const resolved = panel.getByRole('region', { name: 'Resolved changes', exact: true });
  await resolved.getByRole('button', { name: 'Resolve changes', exact: true }).click();
  await expect(resolved).toContainText('inferred');
  await expect(resolved).toContainText('Product brand mark');
  await expect(resolved).toContainText('a new product carries only its own markings');
  // The brand read from the user's own words is corrected in that item's own fields, never by undoing the replacement.
  await expect(resolved).toContainText('Smartphone · brand: Xiaomi');
  await expect(resolved).toContainText('Edit Smartphone to change it.');
  await expect(resolved).not.toContainText('No brand was given');
  const promptBox = panel.getByLabel('Resolved final prompt text', { exact: true }), preview = await promptBox.inputValue();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('smart-resolved-desktop.png') });
  expect(preview).toContain(`Replace the smartphone in the center with "Xiaomi phone ${token}".`);
  expect(preview).toContain('Show the Xiaomi brand only as this product would plainly carry it.');
  expect(preview).toContain('The only exception is the Xiaomi brand marking on the new smartphone'); // no brand contradiction (B3)
  expect(preview).not.toMatch(/all visible text/);
  // How it will be made: only the changed areas, at the image's own size.
  await expect(resolved.getByRole('note').filter({ hasText: 'How it is made' })).toContainText(/Edits only the changed areas\. Only the areas of Smartphone, Product brand mark .* every other pixel stays your image's own\. The result keeps your image's own size\./);
  // Any edit makes the plan stale; the same draft again is the same key (no new call needed).
  await phone.getByLabel('Smartphone: replace with', { exact: true }).fill(`Oppo phone ${token}`);
  await expect(resolved).toContainText('Your changes are different from the last resolved plan');
  await phone.getByLabel('Smartphone: replace with', { exact: true }).fill(`Xiaomi phone ${token}`);
  await expect(promptBox).toHaveValue(preview);
  // A marked sentence leads back to its control.
  await panel.getByLabel('Resolved final prompt', { exact: true }).getByText(/Replace the smartphone in the center/).click();
  await expect(phone.getByLabel('Smartphone: replace with', { exact: true })).toBeFocused();
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(panel.getByText('Image analysis:')).toContainText('1 call');
  const creative = await started(page, request, () => panel.getByRole('button', { name: 'Generate Creative', exact: true }).click());
  await expect.poll(async () => (await execution(request, creative.id)).state, { timeout: 90_000 }).toBe('generated');
  const generated = await execution(request, creative.id);
  // The request is exactly the previewed, persisted prompt; each kind of call is counted apart.
  expect(generated.edit.prompt).toBe(preview);
  expect(generated.usage).toMatchObject({ analysisCalls: 1, resolutionCalls: 1, imageGenerationCalls: 1, verificationCalls: 1, plannerCalls: 0, generationPromptSource: 'resolved-plan' });
  expect(await imageCalls(request, token)).toBe(1);
  // Only the phone and its mark were painted; the result is the uploaded image's own size, the rest its own pixels.
  const uploaded = await sharp(await (await request.get(`${API}/template-executions/${creative.id}/images/upload`)).body()).metadata();
  expect(generated.edit).toMatchObject({ strategy: { kind: 'local' }, image: { width: uploaded.width, height: uploaded.height }, preservation: { method: 'outside-regions', maxDifferenceOutside: 0 } });
  await expect(panel.getByRole('region', { name: 'Image review', exact: true }).getByRole('note')).toContainText(/Edited only Smartphone, Product brand mark: [\d,]+ pixels \(\d+(\.\d)?% of the image\) are your image's own, unchanged\./);
  await expect(panel.getByText('AI check passed', { exact: false })).toBeVisible();
  const useImage = panel.getByRole('button', { name: 'Use this image', exact: true });
  await expect(useImage).toBeDisabled();
  await panel.getByRole('checkbox', { name: /I checked the image/ }).check();
  await panel.getByRole('radio', { name: /Simpler grouping/ }).check();
  await useImage.click();
  await expect(panel.getByRole('button', { name: 'Open in Editor', exact: true })).toBeEnabled({ timeout: 90_000 });
  await expect(panel.getByRole('term')).toContainText(['Structure analysis', 'Image analysis', 'Change resolution', 'Image generation', 'AI check of the result', 'Decomposition planner']);
  expect(await imageCalls(request, token)).toBe(1);
  // In the editor: exactly the layers its decomposition kept, on the uploaded image's own canvas.
  const finished = await execution(request, creative.id), run = await runOf(request, finished.runId);
  expect(run.canvas).toEqual({ width: uploaded.width, height: uploaded.height });
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.workspace-unit')).toHaveText(`${uploaded.width} × ${uploaded.height} px`);
  await expect(page.getByRole('list', { name: 'Design layers' }).locator('li')).toHaveCount(run.outputLayers.length);
  await expectEditorLayers(page, run);
  expect(errors).toEqual([]);
});

test('A smart edit reopened in a new browser session brings back its own changes and plan (no new call), and Regenerate sends those changes', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One journey on desktop.');
  test.setTimeout(150_000);
  const token = `reopen-${Date.now().toString(36)}`, template = await bootstrapTemplate(request), image = await ownImage(template.bytes);
  // An earlier session (another browser): analysed, resolved and generated through the API.
  const analysis = await (await request.post(`${API}/scene-analyses`, { multipart: { templateId: template.id, templateVersion: String(template.version), idempotencyKey: crypto.randomUUID(), image: { name: 'own.png', mimeType: 'image/png', buffer: image } } })).json();
  await expect.poll(async () => (await (await request.get(`${API}/scene-analyses/${analysis.id}`)).json()).state, { timeout: 30_000 }).toBe('ready');
  const draft = { edits: { smartphone_1: { action: 'replace', value: `Xiaomi phone ${token}` } }, corrections: {} };
  const resolution = await (await request.post(`${API}/scene-analyses/${analysis.id}/resolutions`, { multipart: { draft: JSON.stringify(draft) } })).json();
  expect(resolution).toMatchObject({ state: 'ready', plan: { status: 'clear' } });
  const earlier = await (await request.post(`${API}/template-executions`, { multipart: { mode: 'REUSE_TEMPLATE_WITH_EDIT', idempotencyKey: crypto.randomUUID(), templateId: template.id, templateVersion: String(template.version), reviewBeforeDecompose: 'true',
    analysisId: analysis.id, resolutionId: resolution.id, draft: JSON.stringify(draft), image: { name: 'own.png', mimeType: 'image/png', buffer: image } } })).json();
  await expect.poll(async () => (await execution(request, earlier.id)).state, { timeout: 60_000 }).toBe('generated');
  expect(await imageCalls(request, token)).toBe(1);
  // This browser has never seen it: no session draft. Saved Runs → that session.
  const writes = writesOf(page), panel = await openWizard(page);
  await panel.getByRole('tab', { name: 'Saved Runs', exact: true }).click();
  await panel.getByRole('region', { name: 'Saved template executions' }).locator(`button:has(img[src*="${earlier.id}"])`).click();
  await panel.getByRole('button', { name: 'Edit changes', exact: true }).first().click();
  const phone = panel.getByRole('article', { name: 'Smartphone', exact: true });
  await expect(phone.getByRole('radio', { name: 'Replace', exact: true })).toBeChecked({ timeout: 30_000 });
  await expect(phone.getByLabel('Smartphone: replace with', { exact: true })).toHaveValue(`Xiaomi phone ${token}`);
  // Its resolved plan and exact prompt are back, read from the server: nothing was resolved, analysed or generated again.
  await expect(panel.getByLabel('Resolved final prompt text', { exact: true })).toHaveValue(resolution.prompt);
  expect(writes).toEqual([]);
  // Regenerate sends exactly those changes (the same resolution): one more image request, never an empty draft.
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  const again = await started(page, request, () => panel.getByRole('button', { name: 'Regenerate', exact: true }).click());
  expect(again.resolution).toMatchObject({ id: resolution.id, analysisId: analysis.id });
  await expect.poll(async () => (await execution(request, again.id)).state, { timeout: 60_000 }).toBe('generated');
  expect(await imageCalls(request, token)).toBe(2);
});

test('Generate creative template: one click — the advertised product found automatically, a chosen ratio, different concepts, one failure kept apart, an explicit regeneration, and its own exact layers with no extraction', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One full journey on desktop; phone layouts are checked below.');
  test.setTimeout(180_000);
  const token = `variant-${Date.now().toString(36)}`;
  const template = await bootstrapTemplate(request), panel = await customize(page, template, await ownImage(await (await request.get('/__test__/reference.png')).body()));
  await panel.getByRole('button', { name: 'Generate creative template', exact: true }).click();
  const studio = panel.getByRole('region', { name: 'Generate creative template', exact: true });
  await expect(studio).toBeVisible({ timeout: 30_000 });
  // Nothing to fill in: the product is found and shown, and only the number of creatives and the ratio are asked for.
  await expect(studio.getByRole('status')).toContainText('Keeps exactly: Smartphone · chosen automatically');
  await expect(studio.getByRole('group', { name: 'Number of creatives' }).getByRole('radio', { name: '3', exact: true })).toBeChecked();
  await expect(studio.getByRole('group', { name: 'Aspect ratio' }).getByRole('radio', { name: '1:1', exact: true })).toBeChecked();
  await expect(studio.getByLabel('Creative direction', { exact: true })).toBeHidden();
  await expect(studio.getByRole('button', { name: 'Generate 3 creatives', exact: true })).toBeEnabled();
  await studio.getByRole('group', { name: 'Aspect ratio' }).getByRole('radio', { name: '4:5', exact: true }).check();
  // The optional controls: the automatic choice as checkboxes, and a direction that asks for text is refused before anything is sent.
  await studio.getByText('Advanced (optional)', { exact: true }).click();
  await expect(studio.getByRole('checkbox', { name: /Smartphone/ })).toBeChecked();
  await studio.getByLabel('Creative direction', { exact: true }).fill('a banner that says SALE');
  await expect(studio.getByRole('alert')).toContainText('text-free');
  await expect(studio.getByRole('button', { name: /^Generate \d creative/ })).toBeDisabled();
  await studio.getByLabel('Creative direction', { exact: true }).fill(`calm studio failure drill ${token}`);
  await expect(studio).toContainText('Paid requests: 1 mask request · scene ideas 1 call · 3 image calls · 3 AI checks.');
  await studio.getByRole('button', { name: 'Generate 3 creatives', exact: true }).click();
  await expect(studio.getByRole('status')).toContainText('Ready', { timeout: 90_000 });
  await expect(studio.getByRole('status')).toContainText('4:5');
  // The three most different concepts; the writer's recolours of them are never creatives.
  const cards = studio.getByRole('article'), card = (title: string) => studio.getByRole('article', { name: new RegExp(`^Variant \\d: ${title}$`) });
  await expect(cards).toHaveCount(3);
  await expect(studio).not.toContainText(/Marble studio in rose|Rooftop dusk in teal/);
  await expect(card('Marble studio')).toContainText('Ready');
  await expect(card('Marble studio')).toContainText('studio · precise · open space top');
  await expect(card('Rooftop dusk')).toContainText('Ready');
  await expect(card('Paper shapes')).toContainText('Fixture variant failure');
  // The product is the reference's own pixels: identical where opaque, its soft edge blended as measured.
  await expect(card('Marble studio')).toContainText(/Product: your image's own pixels \([\d,]+ identical, [\d,]+ soft edge pixels blended\)/);
  await expect(card('Marble studio')).toContainText('AI check passed');
  const shown = await card('Marble studio').getByRole('img').evaluate((img: HTMLImageElement) => ({ width: img.naturalWidth, height: img.naturalHeight }));
  expect(shown).toEqual({ width: 1216, height: 1520 });
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('variants-desktop.png') });
  // Each variant was sent once; the failure was not resent.
  expect(await imageCalls(request, token)).toBe(3);
  const failed = card('Paper shapes'), failedNo = (await failed.getAttribute('aria-label'))!.match(/^Variant (\d)/)![1];
  await failed.getByLabel(`Variant ${failedNo} scene`, { exact: true }).fill(`rooftop garden at dusk with glossy puddles ${token}`);
  await failed.getByRole('button', { name: 'Regenerate · 1 paid call', exact: true }).click();
  await expect(failed).toContainText('Ready', { timeout: 60_000 });
  expect(await imageCalls(request, token)).toBe(4);
  // The chosen variant continues through review; its plan choices never include the old saved plan.
  await card('Marble studio').getByRole('button', { name: 'Use this creative', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Back to creative variants', exact: true })).toBeVisible();
  const plan = panel.getByRole('group', { name: 'How to extract layers' });
  await expect(plan.getByRole('radio')).toHaveCount(3);
  await expect(plan).not.toContainText('Use saved plan');
  await plan.getByRole('radio', { name: /Use its own layers/ }).check();
  const approved = page.waitForResponse(r => /\/template-executions\/[^/]+\/decompose$/.test(new URL(r.url()).pathname));
  await panel.getByRole('button', { name: 'Use this image', exact: true }).click();
  const e = await (await approved).json();
  await expect(panel.getByRole('button', { name: 'Open in Editor', exact: true })).toBeEnabled({ timeout: 60_000 });
  const done = await execution(request, e.id), run = await runOf(request, done.runId);
  expect(run.composed).toMatchObject({ extraction: 'none' });
  expect(run.outputLayers.map((l: { name: string }) => l.name)).toEqual(['Generated scene (flattened)', 'Contact shadow · Smartphone', 'Smartphone (exact source pixels)']);
  // The 4:5 creative itself, and nothing of it went to Seedream.
  const composite = (await (await request.get(`${API}/template-executions/${e.id}/images/edited`)).body());
  expect(await sharp(composite).metadata()).toMatchObject({ width: 1216, height: 1520 });
  expect((await (await request.get(`/__test__/extractions?image=${createHash('sha256').update(composite).digest('hex')}`)).json()).count).toBe(0);
  // In the editor: the creative's own layers, back to front as composed, on its 4:5 canvas.
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.workspace-unit')).toHaveText('1216 × 1520 px');
  await expectEditorLayers(page, run);
  await expect(page.getByRole('list', { name: 'Design layers' }).locator('.layer-name')).toHaveText(['Smartphone (exact source pixels) (z2)', 'Contact shadow · Smartphone (z1)', 'Generated scene (flattened) (z0)']);
});

for (const width of [390, 320]) test(`${width}px: smart controls and the variant studio stack without horizontal overflow`, async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The phone viewport is set here.');
  test.setTimeout(120_000);
  const template = await bootstrapTemplate(request), image = await ownImage(template.bytes);
  // An analysis an earlier session made: the page finds it by the image's hash (a read).
  await request.post(`${API}/scene-analyses`, { multipart: { templateId: template.id, templateVersion: String(template.version), idempotencyKey: crypto.randomUUID(), image: { name: 'own.png', mimeType: 'image/png', buffer: image } } });
  await page.setViewportSize({ width, height: 800 });
  const panel = await customize(page, template, image);
  // The template fields stay the way in; the item cards of the found analysis are one click away (a read, no request).
  await panel.getByRole('button', { name: 'Edit what\'s in the image', exact: true }).click({ timeout: 30_000 });
  await expect(panel.getByRole('heading', { name: 'What\'s in your image', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole('region', { name: 'Resolved changes', exact: true })).toBeVisible();
  expect(await fitsWidth(panel)).toBe(true);
  await panel.getByRole('button', { name: 'Generate creative template', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Generate creative template', exact: true })).toBeVisible();
  expect(await fitsWidth(panel)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`smart-${width}.png`), fullPage: true });
});
