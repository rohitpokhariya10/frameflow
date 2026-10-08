import { createHash } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { API, executionOf as execution, imageCalls, openWizard, runOf, started, writesOf } from './wizard.helpers';
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
const ownImage = async (bytes: Buffer) => sharp(bytes).composite([{ input: { create: { width: 6, height: 6, channels: 3, background: `#${createHash('sha256').update(crypto.randomUUID()).digest('hex').slice(0, 6)}` } }, left: 0, top: 0 }]).png().toBuffer();
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
  await expect(panel.getByRole('region', { name: 'Draft changes', exact: true })).toContainText('Everything is inherited as detected');
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
  expect(preview).not.toMatch(/all visible text/);
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
  await expect(panel.getByText('AI check passed', { exact: false })).toBeVisible();
  const useImage = panel.getByRole('button', { name: 'Use this image', exact: true });
  await expect(useImage).toBeDisabled();
  await panel.getByRole('checkbox', { name: /I checked the image/ }).check();
  await panel.getByRole('radio', { name: /Simpler grouping/ }).check();
  await useImage.click();
  await expect(panel.getByRole('button', { name: 'Open in Editor', exact: true })).toBeEnabled({ timeout: 90_000 });
  await expect(panel.getByRole('term')).toContainText(['Structure analysis', 'Image analysis', 'Change resolution', 'Image generation', 'AI check of the result', 'Decomposition planner']);
  expect(await imageCalls(request, token)).toBe(1);
  expect(errors).toEqual([]);
});

test('Generate creative template: a confirmed subject in new scenes, one failure kept apart, an explicit regeneration, and its own exact layers with no extraction', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One full journey on desktop; phone layouts are checked below.');
  test.setTimeout(180_000);
  const token = `variant-${Date.now().toString(36)}`;
  const template = await bootstrapTemplate(request), panel = await customize(page, template, await ownImage(await (await request.get('/__test__/reference.png')).body()));
  await panel.getByRole('button', { name: 'Generate creative template', exact: true }).click();
  const studio = panel.getByRole('region', { name: 'Generate creative template', exact: true });
  await expect(studio).toBeVisible({ timeout: 30_000 });
  await expect(studio.getByRole('checkbox', { name: /Smartphone/ })).toBeChecked();
  // A direction that asks for text is refused before anything is sent.
  await studio.getByLabel('Creative direction', { exact: true }).fill('a banner that says SALE');
  await expect(studio.getByRole('alert')).toContainText('text-free');
  await expect(studio.getByRole('button', { name: /^Generate \d creative/ })).toBeDisabled();
  await studio.getByLabel('Creative direction', { exact: true }).fill(`calm studio failure drill ${token}`);
  await studio.getByRole('checkbox', { name: /Surprise me/ }).check();
  await studio.getByLabel('Number of variants', { exact: true }).selectOption('3');
  await studio.getByRole('button', { name: 'Generate 3 creatives', exact: true }).click();
  await expect(studio.getByRole('status')).toContainText('Ready', { timeout: 90_000 });
  const card = (n: number) => studio.getByRole('article', { name: new RegExp(`^Variant ${n}:`) });
  await expect(card(1)).toContainText('Ready');
  await expect(card(2)).toContainText('Fixture variant failure');
  await expect(card(3)).toContainText('Ready');
  await expect(card(1)).toContainText('Subject: your image\'s own pixels');
  await expect(card(1)).toContainText('AI check passed');
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('variants-desktop.png') });
  // Each variant was sent once; the failure was not resent.
  expect(await imageCalls(request, token)).toBe(3);
  await card(2).getByLabel('Variant 2 scene', { exact: true }).fill(`rooftop at dusk with glossy puddles ${token}`);
  await card(2).getByRole('button', { name: 'Regenerate · 1 paid call', exact: true }).click();
  await expect(card(2)).toContainText('Ready', { timeout: 60_000 });
  expect(await imageCalls(request, token)).toBe(4);
  // The chosen variant continues through review; its plan choices never include the old saved plan.
  await card(1).getByRole('button', { name: 'Use this creative', exact: true }).click();
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
  expect(run.outputLayers.map((l: { name: string }) => l.name)).toEqual(['New scenery', 'Contact shadow', 'Smartphone (exact source pixels)']);
  // Nothing of this image went to Seedream.
  const composite = (await (await request.get(`${API}/template-executions/${e.id}/images/edited`)).body());
  expect((await (await request.get(`/__test__/extractions?image=${createHash('sha256').update(composite).digest('hex')}`)).json()).count).toBe(0);
});

for (const width of [390, 320]) test(`${width}px: smart controls and the variant studio stack without horizontal overflow`, async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The phone viewport is set here.');
  test.setTimeout(120_000);
  const template = await bootstrapTemplate(request), image = await ownImage(template.bytes);
  // An analysis an earlier session made: the page finds it by the image's hash (a read).
  await request.post(`${API}/scene-analyses`, { multipart: { templateId: template.id, templateVersion: String(template.version), idempotencyKey: crypto.randomUUID(), image: { name: 'own.png', mimeType: 'image/png', buffer: image } } });
  await page.setViewportSize({ width, height: 800 });
  const panel = await customize(page, template, image);
  await expect(panel.getByRole('heading', { name: 'What\'s in your image', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole('region', { name: 'Resolved changes', exact: true })).toBeVisible();
  expect(await fitsWidth(panel)).toBe(true);
  await panel.getByRole('button', { name: 'Generate creative template', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Generate creative template', exact: true })).toBeVisible();
  expect(await fitsWidth(panel)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`smart-${width}.png`), fullPage: true });
});
