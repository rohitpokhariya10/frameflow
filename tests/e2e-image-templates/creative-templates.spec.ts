import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import sharp from 'sharp';
import { describeTemplateSlots, type TemplateVersion } from '@frameflow/shared';
import { API, executionOf as execution, imageCalls, openWizard, runOf, started, writesOf } from './wizard.helpers';
// Every provider count here is this test's own (a unique prompt token, its page's requests, its executions' records):
// other specs may use the shared fixture server at the same time.
test.use({ extraHTTPHeaders: { origin: 'http://127.0.0.1:3317' } });
/** A saved template made through the API, as an earlier session would have left it. */
async function bootstrapTemplate(request: APIRequestContext) {
  const bytes = await (await request.get('/__test__/reference.png')).body();
  const created = await (await request.post(`${API}/template-executions`, { multipart: { mode: 'CREATE_TEMPLATE', idempotencyKey: crypto.randomUUID(), image: { name: 'bootstrap.png', mimeType: 'image/png', buffer: bytes } } })).json();
  await expect.poll(async () => (await execution(request, created.id)).state, { timeout: 90000 }).toBe('done');
  return (await execution(request, created.id)).template as { id: string; name: string; version: number };
}
const fitsWidth = (panel: Locator) => panel.locator('.ws-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1);
const loaded = (image: Locator) => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);
const generatedState = (request: APIRequestContext, id: string) => expect.poll(async () => (await execution(request, id)).state, { timeout: 90000 });
const session = (panel: Locator, id: string) => panel.getByRole('region', { name: 'Saved template executions' }).locator(`button:has(img[src*="${id}"])`);

test('Journeys C + A: create a template card → customize its saved slots → one generated image → review, regenerate, reopen → approve → saved-plan decomposition → editor', async ({ page, request }, testInfo) => {
  test.setTimeout(150000);
  const errors: string[] = [], detections: string[] = [], token = `${testInfo.project.name}-${Date.now().toString(36)}`;
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().endsWith('/template-executions/inspect')) detections.push(r.url()); });
  const panel = await openWizard(page);
  const next = () => panel.getByRole('button', { name: 'Next', exact: true }).click();
  const back = () => panel.getByRole('button', { name: 'Back', exact: true }).click();
  const useImage = panel.getByRole('button', { name: 'Use this image', exact: true });
  await expect(panel.getByRole('combobox')).toHaveCount(0);
  await expect(panel.getByRole('region', { name: 'Template library', exact: true })).toBeVisible();

  // C: + Create New Template → upload → planner 1, no image generation → the new card in the library.
  await panel.getByRole('button', { name: 'Create New Template', exact: true }).first().click();
  const bytes = await (await request.get('/__test__/reference.png')).body();
  await panel.getByLabel('Creative image', { exact: true }).setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: bytes });
  await expect(panel.getByText('first.png', { exact: true })).toBeVisible();
  // A refresh cannot keep file bytes: the step and choice survive, and the user is asked for the file again.
  await page.reload(); await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await panel.getByRole('tab', { name: 'Create Template', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Reselect first.png');
  await expect(panel.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await panel.getByLabel('Creative image', { exact: true }).setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: bytes });
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await next();
  await expect(panel.getByRole('button', { name: /Generate Creative|Regenerate/ })).toHaveCount(0);
  const creating = await started(page, request, () => panel.getByRole('button', { name: 'Create Template & Decompose', exact: true }).click());
  await expect(panel.getByRole('heading', { name: 'Template saved to your library' })).toBeVisible({ timeout: 90000 });
  const first = await execution(request, creating.id);
  expect(first.usage).toMatchObject({ plannerCalls: 1, imageGenerationCalls: 0, imageGenerationCalled: false });
  expect((await runOf(request, first.runId)).calls).toMatchObject({ planner: 1, seedreamInitial: 1 });
  await panel.getByRole('button', { name: 'Back to template library', exact: true }).click();
  const select = panel.getByRole('button', { name: `Select ${first.template.name} v1`, exact: true });
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  const card = panel.getByRole('article', { name: `${first.template.name} v1`, exact: true });
  await expect(card.getByRole('heading', { name: new RegExp(first.template.name) })).toBeVisible();
  // The thumbnail is fetched after the card appears (the shared fixture server may be busy with another spec's run).
  await expect.poll(() => loaded(card.getByRole('img')), { timeout: 15_000 }).toBe(true);
  // The card's thumbnail stays inside its own box and never covers the name.
  const [thumb, title] = await Promise.all([card.locator('.tw-template-image').boundingBox(), card.getByRole('heading').boundingBox()]);
  expect(thumb!.y + thumb!.height).toBeLessThanOrEqual(title!.y);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('wizard-library-desktop.png') });

  // A: Customize shows one field per saved slot and the base prompt with those fields marked; the final prompt compiles locally.
  const writes = writesOf(page), phone = `Green smartphone ${token}`;
  await next();
  const version: TemplateVersion = await (await request.get(`${API}/templates/${first.template.id}/versions/1`)).json();
  const slots = describeTemplateSlots(version), base = panel.getByLabel('Base template prompt', { exact: true });
  for (const slot of slots) {
    await expect(panel.getByLabel(`${slot.label} content`, { exact: true })).toBeVisible();
    await expect(base.getByRole('button', { name: `{${slot.label}}`, exact: true })).toBeVisible();
  }
  await expect(base).toContainText('Do not add any other new text, prices, discounts, product specifications, brand names or logos.');
  await expect(panel.getByLabel('Call to action content', { exact: true })).toHaveCount(0);
  // A marked part of the prompt leads to its field.
  await base.getByRole('button', { name: '{Main product}', exact: true }).click();
  await expect(panel.getByLabel('Main product content', { exact: true })).toBeFocused();
  // The same phone in another finish: the saved decomposition plan still fits, so nothing extra is asked later.
  await panel.getByRole('radio', { name: 'Change details', exact: true }).check();
  await panel.getByLabel('Main product content', { exact: true }).fill(phone);
  await panel.getByLabel('Background content', { exact: true }).fill('Warm studio backdrop');
  await expect(panel.getByRole('region', { name: 'What will change' }).getByRole('listitem')).toHaveText([/Restyle\s*Background: Warm studio backdrop$/, new RegExp(`Change details\\s*Main product: ${phone}$`)]);
  await expect(panel.getByLabel('Final prompt preview', { exact: true })).toHaveValue(/Green smartphone.*Warm studio backdrop|Warm studio backdrop.*Green smartphone/);
  const preview = await panel.getByLabel('Final prompt preview', { exact: true }).inputValue();
  expect(preview).not.toContain('{{edit_instruction}}');
  expect(writes).toEqual([]);
  await panel.getByText('Final prompt · exactly what is sent', { exact: true }).click();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('wizard-customize-desktop.png') });
  expect(await panel.locator('.ws-body').evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await next(); await back();
  await expect(panel.getByLabel('Main product content', { exact: true })).toHaveValue(phone);
  await panel.getByRole('tab', { name: 'Saved Runs', exact: true }).click(); await panel.getByRole('tab', { name: 'Create Template', exact: true }).click();
  await expect(panel.getByLabel('Background content', { exact: true })).toHaveValue('Warm studio backdrop');
  await page.reload(); await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await panel.getByRole('tab', { name: 'Create Template', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Make it your own' })).toBeVisible();
  await expect(panel.getByLabel('Main product content', { exact: true })).toHaveValue(phone);
  await expect(panel.getByRole('radio', { name: 'Change details', exact: true })).toBeChecked();
  await expect(panel.getByLabel('Final prompt preview', { exact: true })).toHaveValue(preview);
  expect(writes).toEqual([]); expect(await imageCalls(request, token)).toBe(0);

  // Changed content cannot skip generation; one click (even a double one) makes exactly one image request.
  await next();
  await expect(panel.getByRole('button', { name: 'Use original image', exact: true })).toBeDisabled();
  const generating = await started(page, request, () => panel.getByRole('button', { name: 'Generate Creative', exact: true }).dblclick());
  await generatedState(request, generating.id).toBe('generated');
  await expect(useImage).toBeEnabled({ timeout: 30000 });
  const generated = await execution(request, generating.id);
  expect(generated).toMatchObject({ state: 'generated', usage: { plannerCalls: 0, imageGenerationCalls: 1, promptGenerationCalled: false } });
  expect(generated.runId).toBeUndefined(); expect(generated.inspection).toBeUndefined(); expect(generated.edit.prompt).toBe(preview);
  expect(generated.compatibility).toMatchObject({ status: 'compatible' }); expect(generated.editOptions).toEqual({ mainProduct: { mode: 'details' } });
  expect(await imageCalls(request, token)).toBe(1);
  expect(writes).toEqual([`POST ${API}/template-executions`]);
  await expect(panel.getByText('Prompt planning:')).toContainText('0 calls · ₹0');
  await expect(panel.getByText('Image generation:')).toContainText('1 call ·');
  expect(await loaded(panel.getByRole('img', { name: 'Generated creative', exact: true }))).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('wizard-generated-desktop.png') });

  // Regenerate: exactly one more image request, a new saved candidate, still no decomposition.
  const regenerating = await started(page, request, () => panel.getByRole('button', { name: 'Regenerate', exact: true }).dblclick());
  expect(regenerating.id).not.toBe(generated.id);
  await generatedState(request, regenerating.id).toBe('generated');
  await expect(useImage).toBeEnabled({ timeout: 30000 });
  const regenerated = await execution(request, regenerating.id);
  expect(regenerated).toMatchObject({ state: 'generated', usage: { plannerCalls: 0, imageGenerationCalls: 1 } });
  expect(regenerated.edit.prompt).toBe(preview);
  expect((await execution(request, generated.id)).state).toBe('generated');
  expect(await imageCalls(request, token)).toBe(2);
  expect(writes).toEqual([`POST ${API}/template-executions`, `POST ${API}/template-executions`]);

  // Refresh reopens the persisted review, without another image or decomposition request.
  await page.reload(); await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await panel.getByRole('tab', { name: 'Create Template', exact: true }).click();
  await expect(useImage).toBeEnabled();
  expect(await loaded(panel.getByRole('img', { name: 'Generated creative', exact: true }))).toBe(true);
  // Saved Runs reopens the same review step.
  await panel.getByRole('tab', { name: 'Saved Runs', exact: true }).click();
  await expect(session(panel, regenerated.id)).toContainText('Waiting for your review');
  await session(panel, regenerated.id).click();
  await expect(panel.getByRole('heading', { name: 'Review your creative' })).toBeVisible();
  await expect(useImage).toBeEnabled();
  expect(await imageCalls(request, token)).toBe(2); expect(writes).toHaveLength(2);

  // Approval starts the decomposition of the approved image, with the saved plan and no planner.
  await started(page, request, () => useImage.click(), `${API}/template-executions/${regenerated.id}/decompose`);
  await expect(panel.getByRole('heading', { name: 'Turn your creative into layers' }).or(panel.getByRole('heading', { name: 'Editor-ready layers' }))).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Open in Editor', exact: true })).toBeEnabled({ timeout: 90000 });
  const done = await execution(request, regenerated.id);
  expect(done.usage).toMatchObject({ plannerCalls: 0, imageGenerationCalls: 1, generationPromptSource: 'saved-template', decompositionPlanSource: 'saved-template' });
  expect(await imageCalls(request, token)).toBe(2);
  const run = await runOf(request, done.runId);
  expect(run.calls).toMatchObject({ planner: 0, seedreamInitial: 1 });
  const decomposed = await (await request.get(`${API}/runs/${done.runId}/files/${run.original.file}`)).body();
  expect(decomposed.equals(await (await request.get(`${API}/template-executions/${regenerated.id}/images/edited`)).body())).toBe(true);
  expect(decomposed.equals(bytes)).toBe(false);
  const d = await (await request.get(`${API}/runs/${done.runId}/diagnostics`)).json();
  expect(d.stages.find((s: { id: string }) => s.id === 'planner').calls).toEqual([]);
  expect(d.stages.find((s: { id: string }) => s.id === 'reference').calls).toEqual([]);
  expect(d.stages.find((s: { id: string }) => s.id === 'generation').cost).toEqual(done.generationCost);
  const costs = panel.getByRole('definition');
  await expect(panel.getByRole('term')).toContainText(['Structure analysis', 'Prompt planning', 'Image generation', 'Decomposition planner', 'Layer extraction (Seedream)']);
  await expect(costs.nth(0)).toHaveText('0 calls'); await expect(costs.nth(1)).toHaveText('0 calls · ₹0');
  await expect(costs.nth(2)).toContainText('1 call ·'); await expect(costs.nth(3)).toHaveText('0 calls · ₹0');
  await panel.getByText('Preview layers', { exact: true }).click();
  await expect(panel.locator('.cti-layer-previews img').first()).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('wizard-layers-desktop.png') });
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  await expect(panel).toHaveCount(0); await expect(page.getByLabel('Open design').locator('option')).toHaveCount(2);
  await page.reload(); await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await panel.getByRole('tab', { name: 'Saved Runs', exact: true }).click();
  await expect(session(panel, regenerated.id)).toContainText('Layers ready');
  await session(panel, regenerated.id).click();
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  await expect(page.getByLabel('Open design').locator('option')).toHaveCount(2);
  expect(detections).toEqual([]); expect(errors).toEqual([]);
});

test('Journey B: no changes → Use original image → zero image calls; wrong-template warning; new dynamic card; explicit Plan fresh', async ({ page, request }, testInfo) => {
  test.setTimeout(150000);
  const template = await bootstrapTemplate(request);
  page.on('dialog', d => void d.accept());
  const panel = await openWizard(page), writes = writesOf(page);
  const next = () => panel.getByRole('button', { name: 'Next', exact: true }).click();
  const back = () => panel.getByRole('button', { name: 'Back', exact: true }).click();
  const useOriginal = panel.getByRole('button', { name: 'Use original image', exact: true });
  await panel.getByRole('button', { name: `Select ${template.name} v1`, exact: true }).click(); await next(); await next();
  await expect(panel.getByRole('note')).toContainText('No changes');
  expect(writes).toEqual([]);
  const reusing = await started(page, request, () => useOriginal.click());
  await expect(panel.getByRole('button', { name: 'Open in Editor', exact: true })).toBeEnabled({ timeout: 90000 });
  const original = await execution(request, reusing.id);
  expect(original).toMatchObject({ mode: 'REUSE_TEMPLATE_ORIGINAL', usage: { plannerCalls: 0, imageGenerationCalls: 0, imageGenerationCalled: false } });
  expect(original.edit).toBeUndefined();
  // The decomposition itself may clean the background; no image generation or planner request was made.
  const d = await (await request.get(`${API}/runs/${original.runId}/diagnostics`)).json();
  for (const id of ['generation', 'planner', 'reference']) expect(d.stages.find((s: { id: string }) => s.id === id).calls).toEqual([]);
  expect((await runOf(request, original.runId)).calls).toMatchObject({ planner: 0, seedreamInitial: 1 });

  // A clearly different canvas warns locally, keeps the selection, and spends nothing until the user decides.
  await back(); await back();
  const wide = await (await request.get('/__test__/reference.png?shape=wide')).body();
  const refused = async () => {
    const [response] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === `${API}/template-executions` && r.request().method() === 'POST'), useOriginal.click()]);
    expect(response.status()).toBeGreaterThanOrEqual(400); expect((await response.json()).error.code).toBe('TEMPLATE_MAY_NOT_FIT');
    await expect(panel.getByRole('alert')).toContainText('Selected template may not fit this image');
  };
  await panel.getByLabel('Creative image', { exact: true }).setInputFiles({ name: 'different-layout.png', mimeType: 'image/png', buffer: wide });
  await next(); await refused();
  await expect(panel.getByText(`${template.name} · v1`, { exact: true })).toBeVisible();
  const continuing = await started(page, request, () => panel.getByRole('button', { name: 'Continue with selected template', exact: true }).click());
  await expect(panel.getByRole('button', { name: 'Open in Editor', exact: true })).toBeEnabled({ timeout: 90000 });
  const continued = await execution(request, continuing.id);
  expect(continued).toMatchObject({ mode: 'REUSE_TEMPLATE_ORIGINAL', template: { id: template.id }, usage: { plannerCalls: 0, imageGenerationCalls: 0 } });
  expect(continued.warnings.join(' ')).toContain('TEMPLATE_FIT_WARNING');

  // The same warning offers Create New Template, which plans the distinct layout once and adds its card.
  await back(); await back();
  await panel.getByLabel('Creative image', { exact: true }).setInputFiles({ name: 'different-layout.png', mimeType: 'image/png', buffer: wide });
  await next(); await refused();
  await panel.getByRole('alert').getByRole('button', { name: 'Create New Template', exact: true }).click();
  await next();
  const creating = await started(page, request, () => panel.getByRole('button', { name: 'Create Template & Decompose', exact: true }).click());
  await expect(panel.getByRole('heading', { name: 'Template saved to your library' })).toBeVisible({ timeout: 90000 });
  const second = await execution(request, creating.id); expect(second.usage.plannerCalls).toBe(1); expect(second.template.id).not.toBe(template.id);
  await panel.getByRole('button', { name: 'Back to template library', exact: true }).click();
  await expect(panel.getByRole('button', { name: `Select ${second.template.name} v1`, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('button', { name: `Select ${template.name} v1`, exact: true })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('wizard-template-library.png') });

  // Plan fresh is an explicit Advanced choice: one planner call. The upload differs from every other test's by one pixel,
  // so it is never joined to another spec's creation of the same image on the shared server.
  await panel.getByRole('button', { name: `Select ${template.name} v1`, exact: true }).click(); await next();
  const reference = await sharp(await (await request.get('/__test__/reference.png')).body()).raw().toBuffer({ resolveWithObject: true });
  reference.data[0] = (reference.data[0] + 1 + Date.now() % 250) % 256;
  await panel.getByLabel('Creative image', { exact: true }).setInputFiles({ name: 'plan-fresh.png', mimeType: 'image/png', buffer: await sharp(reference.data, { raw: reference.info }).png().toBuffer() });
  await panel.getByText('Advanced · planning experiments', { exact: true }).click();
  const fresh = await started(page, request, () => panel.getByRole('button', { name: 'Plan fresh & decompose', exact: true }).click());
  await expect(panel.getByRole('heading', { name: 'Template saved to your library' })).toBeVisible({ timeout: 90000 });
  expect(await execution(request, fresh.id)).toMatchObject({ plannerReason: 'plan-fresh', usage: { plannerCalls: 1 } });
});

test('a failed regeneration keeps the previous image, which approval then decomposes', async ({ page, request }, testInfo) => {
  test.setTimeout(120000);
  const template = await bootstrapTemplate(request), token = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const panel = await openWizard(page);
  const next = panel.getByRole('button', { name: 'Next', exact: true }), useImage = panel.getByRole('button', { name: 'Use this image', exact: true });
  await panel.getByRole('button', { name: `Select ${template.name} v1`, exact: true }).click(); await next.click();
  // The fixture fails the second image request for a prompt carrying this phrase (the token makes the prompt this test's own).
  await panel.getByRole('radio', { name: 'Change details', exact: true }).check();
  await panel.getByLabel('Main product content', { exact: true }).fill(`Regenerate failure test ${token}`); await next.click();
  const keeping = await started(page, request, () => panel.getByRole('button', { name: 'Generate Creative', exact: true }).click());
  await generatedState(request, keeping.id).toBe('generated');
  await expect(useImage).toBeEnabled({ timeout: 30000 });
  const failing = await started(page, request, () => panel.getByRole('button', { name: 'Regenerate', exact: true }).click());
  await expect(panel.getByRole('alert')).toContainText('Your previous image is kept', { timeout: 30000 });
  expect(await imageCalls(request, token)).toBe(2);
  const failed = await execution(request, failing.id);
  expect(failed).toMatchObject({ state: 'failed', usage: { imageGenerationCalls: 1 } }); expect(failed.id).not.toBe(keeping.id);
  await expect(useImage).toBeEnabled();
  await expect(panel.getByRole('img', { name: 'Generated creative', exact: true })).toHaveAttribute('src', new RegExp(`${keeping.id}/images/edited`));
  await useImage.click();
  await expect(panel.getByRole('button', { name: 'Open in Editor', exact: true })).toBeEnabled({ timeout: 90000 });
  expect(await execution(request, keeping.id)).toMatchObject({ state: 'done', usage: { plannerCalls: 0, imageGenerationCalls: 1 } });
  expect((await execution(request, failed.id)).runId).toBeUndefined();
  expect(await imageCalls(request, token)).toBe(2);
});

test('a corrupt upload fails before any provider call and creates no execution or template', async ({ page, request }) => {
  const panel = await openWizard(page), writes = writesOf(page);
  await panel.getByRole('button', { name: 'Create New Template', exact: true }).first().click();
  await panel.getByLabel('Creative image', { exact: true }).setInputFiles({ name: 'corrupt.png', mimeType: 'image/png', buffer: Buffer.from('not a PNG') });
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  const [response] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === `${API}/template-executions` && r.request().method() === 'POST'),
    panel.getByRole('button', { name: 'Create Template & Decompose', exact: true }).click()]);
  expect(response.status()).toBe(400); expect((await response.json()).error.code).toBe('UNSUPPORTED_IMAGE');
  await expect(panel.getByRole('alert')).toContainText('Upload a PNG, JPEG or WebP image.');
  await expect(panel.getByRole('button', { name: 'Create Template & Decompose', exact: true })).toBeEnabled();
  expect(writes).toEqual([`POST ${API}/template-executions`]);
  const all = (await (await request.get(`${API}/template-executions`)).json()).executions as { upload: { originalName?: string } }[];
  expect(all.some(e => e.upload.originalName === 'corrupt.png')).toBe(false);
});

test('Journey D: 390px and 320px phones keep cards, prompts, the generated preview and the step footer usable without horizontal overflow', async ({ page, request }, testInfo) => {
  test.setTimeout(150000);
  const template = await bootstrapTemplate(request);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    // Each phone starts a fresh session (the previous width's draft would reopen its finished result).
    if (width === 320) await page.evaluate(() => sessionStorage.clear());
    const panel = await openWizard(page);
    const next = panel.getByRole('button', { name: 'Next', exact: true });
    const footer = async () => {
      expect(await fitsWidth(panel), `${width}px fits`).toBe(true);
      const box = await panel.locator('.tw-footer').boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(844); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    };
    const select = panel.getByRole('button', { name: `Select ${template.name} v1`, exact: true });
    await select.scrollIntoViewIfNeeded(); await select.click(); await expect(next).toBeEnabled(); await footer();
    const card = panel.getByRole('article', { name: `${template.name} v1`, exact: true });
    const [thumb, title] = await Promise.all([card.locator('.tw-template-image').boundingBox(), card.getByRole('heading').boundingBox()]);
    expect(thumb!.y + thumb!.height, 'card name is not covered or squashed').toBeLessThanOrEqual(title!.y);
    expect((await card.boundingBox())!.height).toBeGreaterThan(thumb!.height + title!.height + 40);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`wizard-library-${width}.png`) });
    await next.click();
    await panel.getByLabel('Main product content', { exact: true }).fill(`Phone at ${width}`);
    const prompt = panel.getByLabel('Final prompt preview', { exact: true });
    await prompt.scrollIntoViewIfNeeded(); await expect(prompt).toHaveValue(new RegExp(`Phone at ${width}`));
    expect((await prompt.boundingBox())!.width).toBeGreaterThan(width - 90);
    await footer(); await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`wizard-customize-${width}.png`) });
    await next.click();
    await panel.getByRole('button', { name: 'Generate Creative', exact: true }).click();
    const useImage = panel.getByRole('button', { name: 'Use this image', exact: true });
    // A replaced product waits for a person to look and for a plan choice; both fit a phone screen.
    const review = panel.getByRole('region', { name: 'Image review' }), plan = panel.getByRole('group', { name: 'How to extract layers' });
    await expect(review).toBeVisible({ timeout: 30000 }); await expect(plan).toBeVisible();
    await expect(useImage).toBeDisabled();
    const generatedImage = panel.getByRole('img', { name: 'Generated creative', exact: true });
    expect(await loaded(generatedImage)).toBe(true);
    expect((await generatedImage.boundingBox())!.width).toBeGreaterThan(80);
    await review.getByRole('checkbox').check();
    await plan.getByRole('radio', { name: /Use saved plan/ }).check();
    await expect(useImage).toBeEnabled();
    await footer(); await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`wizard-generated-${width}.png`) });
    if (width === 390) {
      await useImage.click();
      await expect(panel.getByRole('button', { name: 'Open in Editor', exact: true })).toBeEnabled({ timeout: 30000 });
      await footer(); await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`wizard-done-${width}.png`) });
    }
  }
});

test('Journey E: earbuds-style replacement → BOAT SPEAKER: a kept product is flagged, the corrected request replaces it, a fal 422 keeps the image and an explicit simpler retry finishes', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One full replacement journey; phones cover the review and plan panels in Journey D.');
  test.setTimeout(180000);
  const template = await bootstrapTemplate(request), token = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const panel = await openWizard(page);
  const next = panel.getByRole('button', { name: 'Next', exact: true }), useImage = panel.getByRole('button', { name: 'Use this image', exact: true });
  await panel.getByRole('button', { name: `Select ${template.name} v1`, exact: true }).click(); await next.click();

  // Replace (the default): brand and product type are separate; the prompt removes the original and allows a new silhouette.
  const product = panel.getByLabel('Main product content', { exact: true });
  await expect(panel.getByRole('radio', { name: 'Replace product', exact: true })).toBeChecked();
  await product.fill(`SPEAKER Kept product test ${token}`);
  await panel.getByLabel('Brand (optional)', { exact: true }).fill('BOAT');
  const changes = panel.getByRole('region', { name: 'What will change' });
  await expect(changes.getByRole('listitem')).toHaveText([new RegExp(`Replace\\s*Main product: BOAT SPEAKER Kept product test ${token}$`)]);
  await expect(changes.getByRole('note')).toContainText('After you review the image, you choose');
  // Fields and their prompt parts point at each other.
  await panel.getByLabel('Background content', { exact: true }).focus();
  await expect(panel.getByLabel('Base template prompt', { exact: true }).getByRole('button', { name: '{Background}', exact: true })).toHaveClass(/is-linked/);
  const prompt = panel.getByLabel('Final prompt preview', { exact: true });
  await expect(prompt).toHaveValue(new RegExp(`Replace the main product in the center with "BOAT SPEAKER Kept product test ${token}"\\. Remove the original main product completely: no part of it may remain\\. The new product may have a different shape, size and silhouette`));
  await expect(prompt).not.toHaveValue(/Do not add or remove elements/);
  await expect(prompt).toHaveValue(/do not invent logos, model numbers or specifications/);
  const keptPrompt = await prompt.inputValue();

  // The fixture's model keeps the phone for this prompt: the local review flags it, and nothing proceeds unseen.
  await next.click();
  const kept = await started(page, request, () => panel.getByRole('button', { name: 'Generate Creative', exact: true }).dblclick());
  await generatedState(request, kept.id).toBe('generated');
  const review = panel.getByRole('region', { name: 'Image review' });
  await expect(review.getByRole('alert')).toContainText('Main product may not have been replaced', { timeout: 30000 });
  await expect(review).toContainText('Local pixel comparison only');
  await expect(useImage).toBeDisabled();
  const keptExecution = await execution(request, kept.id);
  expect(keptExecution.edit.prompt).toBe(keptPrompt);
  expect(keptExecution).toMatchObject({ compatibility: { status: 'structural-change' }, edit: { review: { method: 'source-layer-masks', requiresAcknowledgement: true } } });
  expect(await imageCalls(request, token)).toBe(1);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('replacement-kept-flagged.png') });

  // Back to the request: a corrected product with a product photo (the second input image). The flagged image is not used.
  await review.getByRole('button', { name: 'Edit the request or add a product photo', exact: true }).click();
  await product.fill(`SPEAKER Extraction 422 test ${token}`);
  const photo = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#1d1d1f' } }).png().toBuffer();
  await panel.getByLabel('Product reference image', { exact: true }).setInputFiles({ name: 'speaker.png', mimeType: 'image/png', buffer: photo });
  await expect(prompt).toHaveValue(/Match the new product to the second attached image \(the product reference\)/);
  const replacedPrompt = await prompt.inputValue();
  await next.click();
  const replaced = await started(page, request, () => panel.getByRole('button', { name: 'Generate Creative', exact: true }).click());
  await generatedState(request, replaced.id).toBe('generated');
  await expect(review).toBeVisible({ timeout: 30000 });
  await expect(review).not.toContainText('may not have been replaced');
  const generated = await execution(request, replaced.id);
  expect(generated.edit.prompt).toBe(replacedPrompt);
  expect(generated.edit.reference).toMatchObject({ file: 'product-reference.png' });
  expect(generated.edit.review.checks.filter((c: { id: string }) => c.id === 'object-unchanged')).toEqual([]);
  expect(await imageCalls(request, token)).toBe(2);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('replacement-speaker-generated.png') });

  // Explicit decisions: a person looked, and a plan was chosen. Then fal refuses the first extraction (422).
  await expect(useImage).toBeDisabled();
  await review.getByRole('checkbox').check();
  await expect(useImage).toBeDisabled();
  await panel.getByRole('group', { name: 'How to extract layers' }).getByRole('radio', { name: /Use saved plan/ }).check();
  await started(page, request, () => useImage.click(), `${API}/template-executions/${replaced.id}/decompose`);
  const recovery = panel.getByRole('region', { name: 'Extraction recovery' });
  await expect(recovery.getByRole('alert')).toContainText('Layer extraction failed. Your generated creative is kept.', { timeout: 60000 });
  await expect(recovery.getByRole('alert')).toContainText('fal rejected the extraction request (HTTP 422)');
  await expect(recovery).toContainText('billed 0 units');
  await expect(panel.getByRole('button', { name: 'Resume saved result', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('img', { name: 'Creative to decompose', exact: true })).toHaveAttribute('src', new RegExp(`${replaced.id}/images/edited`));
  const failed = await execution(request, replaced.id);
  expect(failed).toMatchObject({ state: 'failed', error: { code: 'PROVIDER_DECOMPOSITION_REJECTED', state: 'decomposing' }, planDecision: { choice: 'saved' }, edit: { image: generated.edit.image } });
  expect(failed.error.message).toContain('Seedream did not produce a valid decomposition'); expect(failed.error.message).not.toContain('at intake');
  const image = generated.edit.image.sha256, extractions = async () => ((await (await request.get(`/__test__/extractions?image=${image}`)).json()) as { count: number }).count;
  expect(await extractions()).toBe(1);
  await page.waitForTimeout(1500);
  expect(await extractions()).toBe(1); expect(await imageCalls(request, token)).toBe(2);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('replacement-422-recovery.png') });

  // One explicit retry with a simpler grouping: one new Seedream request on the same image, no image call, no planner.
  await started(page, request, () => recovery.getByRole('button', { name: /^Retry with simpler grouping/ }).click(), `${API}/template-executions/${replaced.id}/retry-extraction`);
  await expect(panel.getByRole('button', { name: 'Open in Editor', exact: true })).toBeEnabled({ timeout: 90000 });
  const done = await execution(request, replaced.id);
  expect(done).toMatchObject({ state: 'done', planDecision: { choice: 'simple' }, extractionAttempts: [{ runId: failed.runId, plan: 'saved', error: { code: 'PROVIDER_DECOMPOSITION_REJECTED' } }], usage: { plannerCalls: 0, imageGenerationCalls: 1 } });
  expect(await extractions()).toBe(2); expect(await imageCalls(request, token)).toBe(2);
  expect((await runOf(request, done.runId)).templateExecution).toMatchObject({ plan: 'simple', input: { source: 'approved-generated', sha256: image } });
  await expect(panel.getByText('Earlier extraction attempts (1)', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
