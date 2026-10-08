import { expect, test, type APIRequestContext } from '@playwright/test';
import { API, createTemplate, executionOf, fixture, openWizard, runDetails, runOf, started } from './wizard.helpers';

// Offline fixture server, injected local providers. Seedream's fake answers are the splits seen live, with everything
// baked into the base; the planner answers with the analyses recorded live. People stay intact layers whether the
// template is being created (planner) or reused (saved plan), and hiding or moving them reveals a clean background.
test.use({ extraHTTPHeaders: { origin: 'http://127.0.0.1:3317' } });
test.describe.configure({ mode: 'serial' });

/** Where the people (and what they hold or wear) were, the run's background matches the true scene, with no black. */
const backgroundCheck = async (request: APIRequestContext, runId: string, creative: 'holding' | 'bangles') => (await request.get(`/__test__/background-check?run=${runId}&creative=${creative}`)).json();
const WOMAN_GROUP = [['Woman base', 'parent'], ['Smartphone with white screen', 'held_object'], ['Green success badge on the screen', 'object_content'], ['Foreground gripping finger fragments', 'finger_fragment']];

async function holdingProtected(request: APIRequestContext, runId: string, planner: number) {
  const run = await runOf(request, runId);
  expect(run.calls).toEqual({ planner, seedreamInitial: 1, seedreamResidual: 0, backgroundReconstruction: 0 });
  expect(run.interactions).toMatchObject({ layersBefore: 9, layersAfter: 5, groups: 2 });
  const woman = run.outputLayers.find((l: { grouping?: { protectedInteraction?: string } }) => l.grouping?.protectedInteraction === 'hand_holding_object');
  expect(woman.grouping.members.map((m: { name: string; role: string }) => [m.name, m.role])).toEqual(WOMAN_GROUP);
  expect(run.outputLayers.filter((l: { name: string; grouping?: unknown }) => /finger|Smartphone|badge/i.test(l.name) && !l.grouping)).toEqual([]);
  // The yellow curved field is a backdrop of its own (the plan's role), so the base under it is the plain white canvas.
  expect(run.outputLayers.map((l: { name: string }) => l.name)).toContain('Bright yellow curved decorative field');
  expect(run.refinement.backdrops).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Bright yellow curved decorative field', component: true, basis: 'plan' })]));
  expect(run.refinement.background).toMatchObject({ status: 'continued-clean', method: 'plain-field', quality: 'usable', fallbackUsed: false, aiTried: false });
  const check = await backgroundCheck(request, runId, 'holding');
  expect(check).toMatchObject({ file: 'clean-background.png', black: 0 });
  expect(check.matchShare).toBeGreaterThanOrEqual(0.9);
}

test('a person holding a phone stays one intact layer on creation and reuse; its held object stays editable content; moving or hiding her reveals a clean background', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The fixture server is shared by every project and runs one decomposition at a time; one journey is enough.');
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const panel = await openWizard(page);
  const image = await fixture(request, '/__test__/holding-phone.png');

  // Create New Template (planner 1): the planner and Seedream split the grip; protection keeps the person whole.
  const created = await createTemplate(page, panel, request, { name: 'holding-phone.png', buffer: image });
  expect(created.usage).toMatchObject({ plannerCalls: 1, imageGenerationCalls: 0 });
  await holdingProtected(request, created.runId, 1);
  await runDetails(panel);
  await expect(panel.getByRole('region', { name: 'Background' })).toContainText('Clean');
  await expect(panel.getByRole('region', { name: 'Background' })).toContainText('AI calls: 0');
  await expect(panel.getByTestId('layer-story')).toHaveText('10 → 6');
  // A plain white canvas under the field and the person is trusted to a local continuation: no reconstruction call.
  await panel.getByText('Why each recovery step ran or was skipped', { exact: true }).click();
  await expect(panel.getByRole('list', { name: 'Background recovery steps' })).toContainText('Local continuation: chosen');
  await expect(panel.getByRole('list', { name: 'Background recovery steps' })).toContainText('AI reconstruction: skipped');
  await expect(panel.getByText(/^Local continuation trusted: /)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('1-protected-run.png'), fullPage: true });

  // The saved template keeps the phone grouped with the person for decomposition, yet its content is still editable.
  await panel.getByRole('tab', { name: 'Create Template', exact: true }).click();
  await panel.getByRole('button', { name: 'Back to template library', exact: true }).click();
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  const held = panel.getByLabel('Held object content', { exact: true });
  await expect(panel.locator('.tw-fields label').filter({ hasText: /^Held object/ })).toContainText('Stays grouped with the primary subject');
  await held.fill('red smartphone');
  await expect(panel.getByLabel('Final prompt preview', { exact: true })).toHaveValue(/Replace the held object[^.]* with "red smartphone"\. Remove the original completely; keep the grip natural\./);
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Use original image', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Edit changes', exact: true }).click();
  await held.fill('');

  // Reuse with the original image (planner 0, no image call): the same protection from the saved plan.
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  const reused = await started(page, request, () => panel.getByRole('button', { name: 'Use original image', exact: true }).click());
  await expect(panel.getByRole('button', { name: 'Open in Editor', exact: true })).toBeEnabled({ timeout: 90_000 });
  expect((await executionOf(request, reused.id)).usage).toMatchObject({ plannerCalls: 0, imageGenerationCalls: 0 });
  await holdingProtected(request, (await executionOf(request, reused.id)).runId, 0);

  // The editor: the person with the phone moves and hides as one; the rest stays editable.
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  await expect(panel).toHaveCount(0);
  const layers = page.getByRole('list', { name: 'Design layers' });
  await expect(layers.locator('li')).toHaveCount(6);
  for (const name of ['Black headline text', 'Small white GET text', 'Navy rounded CTA pill + White CTA chevron', 'Bright yellow curved decorative field', 'Clean background (z0)']) await expect(layers.locator('.layer-select').filter({ hasText: name })).toHaveCount(1);
  // The yellow field hides on its own, over the white base.
  const field = layers.locator('.layer-select').filter({ hasText: 'Bright yellow curved decorative field' });
  await field.click();
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('2-field-hidden.png') });
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(layers.locator('.layer-select').filter({ hasText: /^Foreground gripping finger fragments/ })).toHaveCount(0);
  const person = layers.locator('.layer-select').filter({ hasText: 'Woman base + Smartphone with white screen' });
  await person.click();
  await expect(person).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('spinbutton', { name: 'X', exact: true }).fill('-300');
  await page.getByRole('spinbutton', { name: 'X', exact: true }).blur();
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('-300');
  await page.screenshot({ path: testInfo.outputPath('2-moved.png') });
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('3-hidden.png') });
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'X', exact: true }).fill('0');
  await page.getByRole('spinbutton', { name: 'X', exact: true }).blur();
  await expect(page.getByRole('button', { name: 'Hide', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('worn bangles stay with their hands; hiding the hands reveals the red field, with no gold ghosts', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The fixture server is shared by every project and runs one decomposition at a time; one journey is enough.');
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const panel = await openWizard(page);
  const created = await createTemplate(page, panel, request, { name: 'bangles.png', buffer: await fixture(request, '/__test__/bangles.png') });
  expect(created.usage).toMatchObject({ plannerCalls: 1, imageGenerationCalls: 0 });
  const run = await runOf(request, created.runId);
  const worn = run.outputLayers.filter((layer: { grouping?: { members: { role: string }[] } }) => layer.grouping?.members.some(m => m.role === 'worn_ornament'));
  expect(worn.map((layer: { name: string }) => layer.name)).toEqual(['Left paired hands + Left Coorgi gold bangle stack', 'Center crossed hands + Center South-Indian gold bangle cluster', 'Right paired hands + Right Bengali gold bangle stack']);
  const names: string[] = run.outputLayers.map((layer: { name: string }) => layer.name);
  expect(names).toEqual(expect.arrayContaining(['Standalone gold bangle product', '"BANGLES OF INDIA" headline']));
  expect(names.filter(name => /bangle (stack|cluster)/.test(name) && !name.includes('+'))).toEqual([]);
  expect(run.refinement.background).toMatchObject({ quality: 'usable', contaminated: false });
  const check = await backgroundCheck(request, created.runId, 'bangles');
  expect(check.black).toBe(0);
  expect(check.matchShare).toBeGreaterThanOrEqual(0.95);
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  const layers = page.getByRole('list', { name: 'Design layers' });
  await expect(layers.locator('li')).toHaveCount(run.outputLayers.length);
  await layers.locator('.layer-select').filter({ hasText: 'Left paired hands + Left Coorgi gold bangle stack' }).click();
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('bangles-hidden.png') });
  expect(errors).toEqual([]);
});

test('API check: reused plans keep the same worn-ornament protection', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One fixture journey is enough.');
  test.setTimeout(120_000);
  const image = await fixture(request, '/__test__/bangles.png');
  const created = await (await request.post(`${API}/template-executions`, { multipart: { mode: 'CREATE_TEMPLATE', idempotencyKey: crypto.randomUUID(), image: { name: 'bangles.png', mimeType: 'image/png', buffer: image } } })).json();
  await expect.poll(async () => (await executionOf(request, created.id)).state, { timeout: 90_000 }).toBe('done');
  const template = (await executionOf(request, created.id)).template;
  const reuse = await (await request.post(`${API}/template-executions`, { multipart: { mode: 'REUSE_TEMPLATE_ORIGINAL', templateId: template.id, idempotencyKey: crypto.randomUUID(), image: { name: 'bangles.png', mimeType: 'image/png', buffer: image } } })).json();
  await expect.poll(async () => (await executionOf(request, reuse.id)).state, { timeout: 90_000 }).toBe('done');
  const done = await executionOf(request, reuse.id), run = await runOf(request, done.runId);
  expect(done.usage).toMatchObject({ plannerCalls: 0, imageGenerationCalls: 0 });
  expect(run.outputLayers.filter((l: { grouping?: { members: { role: string }[] } }) => l.grouping?.members.some(m => m.role === 'worn_ornament'))).toHaveLength(3);
});
