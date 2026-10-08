import { expect, test, type APIRequestContext } from '@playwright/test';
import { API, createTemplate, fixture, openWizard, reuseOriginal, runDetails, runOf } from './wizard.helpers';

// Offline fixture server, injected local providers. The complex offer's first Seedream pass misses the speaker and power
// bank and leaves every product baked into its base; one residual pass finds both (plus a duplicate of the headphones),
// and the plain gradient behind them is continued locally, so no background edit is needed. Template creation learns
// the plan with one planner call; reusing the saved template repeats the recursion with none.
test.use({ extraHTTPHeaders: { origin: 'http://127.0.0.1:3317' } });
const OBJECTS = ['Display pedestal', 'Gift box', 'Bluetooth speaker', 'Power bank', 'Wireless headphones', 'Earbuds', 'Smartwatch', 'Confetti', 'MEGA SALE headline'];

/** One run's recursion: each object once, the two missed ones from residual pass 1, one clean background, every artifact. */
async function recursed(request: APIRequestContext, runId: string, planner: number) {
  const run = await runOf(request, runId);
  expect(run.calls).toEqual({ planner, seedreamInitial: 1, seedreamResidual: 1, backgroundReconstruction: 0 });
  expect(run.refinement).toMatchObject({ passesExecuted: 2, stopReason: 'clean', planCoverage: { complete: true } });
  const names: string[] = run.outputLayers.map((layer: { name: string }) => layer.name);
  expect(names).toHaveLength(10);
  for (const name of OBJECTS) expect(names.filter(n => n === name), name).toHaveLength(1);
  const pass = (name: string) => run.outputLayers.find((layer: { name: string }) => layer.name === name).provenance.sourcePass;
  expect([pass('Bluetooth speaker'), pass('Power bank'), pass('Wireless headphones'), pass('Smartwatch')]).toEqual([1, 1, 0, 0]);
  expect(run.refinement.passes[0].rejected).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Wireless headphones', reason: expect.stringMatching(/^(duplicate|inside-extracted-region)$/) })]));
  expect(run.outputLayers[0]).toMatchObject({ file: 'clean-background.png', rawFile: 'layer-00.png', cleanBackground: { status: 'continued-clean', method: 'plain-field' } });
  for (const file of ['clean-background.png', 'foreground-mask.png', 'residual-pass-1.png', 'reconstructed.png', 'contact-sheet.png', 'decomposition-debug.json']) {
    expect((await request.get(`${API}/runs/${runId}/files/${file}`)).status(), file).toBe(200);
  }
}

test('recursive decomposition of a complex offer: missed products found once, one clean background, on creation and on saved-plan reuse, then editable layers', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The fixture server is shared by every project and runs one decomposition at a time; one journey is enough.');
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const panel = await openWizard(page);
  const offer = await fixture(request, '/__test__/complex-offer.png');

  // Create New Template: one planner call learns the plan; the recursion recovers what the first pass missed.
  const created = await createTemplate(page, panel, request, { name: 'complex-offer.png', buffer: offer });
  expect(created.usage).toMatchObject({ plannerCalls: 1, imageGenerationCalls: 0 });
  await recursed(request, created.runId, 1);
  await runDetails(panel);
  await expect(panel.getByRole('region', { name: 'Recursive cleanup' })).toContainText(/1 \/ \d passes used/);
  await expect(panel.getByRole('region', { name: 'Background' })).toContainText('Clean');
  await expect(panel.getByRole('region', { name: 'Background' })).toContainText('AI calls: 0');
  await expect(panel.getByTestId('editor-layer-grid').locator('figure')).toHaveCount(10);
  await expect(panel.getByTestId('editor-layer-grid').getByText('Seedream pass 1', { exact: true })).toHaveCount(2);
  await expect(panel.getByAltText('Reconstruction')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('1-created-run.png'), fullPage: true });

  // Reuse the saved template on the same creative: planner 0, and the recursion still finds the missed products.
  await panel.getByRole('tab', { name: 'Create Template', exact: true }).click();
  const reused = await reuseOriginal(page, panel, request, created.template);
  expect(reused).toMatchObject({ mode: 'REUSE_TEMPLATE_ORIGINAL', template: created.template, usage: { plannerCalls: 0, imageGenerationCalls: 0 } });
  await recursed(request, reused.runId, 0);
  const diagnostics = await (await request.get(`${API}/runs/${reused.runId}/diagnostics`)).json();
  expect(diagnostics.stages.find((s: { id: string }) => s.id === 'planner').calls).toEqual([]);
  expect(diagnostics.stages.find((s: { id: string }) => s.id === 'residual').calls).toHaveLength(1);

  // The editor: the clean background plus every object as its own selectable, movable, hideable layer.
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  await expect(panel).toHaveCount(0);
  const layers = page.getByRole('list', { name: 'Design layers' });
  await expect(layers.locator('li')).toHaveCount(10);
  for (const name of ['Clean background (z0)', 'Display pedestal (z1)', 'Bluetooth speaker · pass 1 (z2)', 'Power bank · pass 1 (z3)', 'Wireless headphones (z5)']) await expect(layers.locator('.layer-select').filter({ hasText: name })).toHaveCount(1);
  await expect(layers.locator('.layer-select').filter({ hasText: /Generated base/ })).toHaveCount(0);
  const speaker = layers.locator('.layer-select').filter({ hasText: 'Bluetooth speaker' });
  await speaker.click();
  await expect(speaker).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('spinbutton', { name: 'X', exact: true }).fill('120');
  await page.getByRole('spinbutton', { name: 'X', exact: true }).blur();
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('120');
  const headphones = layers.locator('.layer-select').filter({ hasText: 'Wireless headphones' });
  await headphones.click();
  await expect(headphones).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('2-editor.png') });
  expect(errors).toEqual([]);
});
