import { expect, test } from '@playwright/test';
import { API, createTemplate, fixture, openWizard, runOf, writesOf } from './wizard.helpers';

// Offline fixture server, injected local providers. The curation creative's fake Seedream answer has 13 raw candidates
// (an empty layer, a scene plate, a translucent shadow, a text outline, a helper, near-empty noise, a duplicate phone…),
// of which 6 are worth editing. Template creation shows, imports and reopens only those 6; the run dashboard keeps the
// rest for diagnosis, and reading it never calls a provider.
test.use({ extraHTTPHeaders: { origin: 'http://127.0.0.1:3317' } });

test('Create New Template stores 13 raw candidates but previews, imports and reopens only 6 curated layers; Saved Runs and the dashboard read them without provider calls', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One full route journey; viewport regressions are covered separately.');
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const panel = await openWizard(page);
  const created = await createTemplate(page, panel, request, { name: 'mint-phone.png', buffer: await fixture(request, '/__test__/curation.png') });
  expect(created.usage).toMatchObject({ plannerCalls: 1, imageGenerationCalls: 0 });
  const runId: string = created.runId;
  await panel.getByText('Preview layers', { exact: true }).click();
  await expect(panel.locator('.cti-layer-previews img')).toHaveCount(6);

  const run = await runOf(request, runId);
  expect(run.refinement.curation.counts).toMatchObject({ rawLayers: 13, editorLayers: 6 });
  expect(run.calls).toMatchObject({ planner: 1, seedreamResidual: 0, backgroundReconstruction: 0 });
  expect(run.editorLayerFiles).toEqual(run.outputLayers.map((l: { file: string }) => l.file));
  expect(run.outputLayers.filter((l: { placement: { kind: string } }) => l.placement.kind === 'base')).toHaveLength(1);
  for (const fragment of ['Seated model', 'Oversized phone product', 'Headline', 'Pro badge', 'Chinese secondary text'])
    expect(run.outputLayers.some((l: { name: string }) => l.name.includes(fragment)), fragment).toBe(true);
  for (const name of ['Layer 0', 'Scene plate', 'Translucent oversized-phone shadow', 'Headline outline', 'Fallback helper', 'Layer 12', 'Duplicate phone product'])
    expect(run.outputLayers.some((l: { name: string }) => l.name === name), name).toBe(false);
  const debug = await (await request.get(`${API}/runs/${runId}/files/decomposition-debug.json`)).json();
  expect(debug.rawLayers).toHaveLength(13);
  const technical = debug.curation.entries.filter((e: { editorVisible: boolean }) => !e.editorVisible).map((e: { file: string }) => `/files/${e.file}`);
  expect(technical.length).toBeGreaterThan(0);

  // The editor imports only the 6 curated layers and never downloads a technical one.
  const fetched: string[] = [];
  page.on('request', r => fetched.push(new URL(r.url()).pathname));
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  await expect(panel).toHaveCount(0);
  const layers = page.getByRole('list', { name: 'Design layers' });
  await expect(layers.locator('li')).toHaveCount(6);
  await expect(layers).not.toContainText(/Layer 0|Fallback helper|Layer 12|Duplicate phone/);
  expect(fetched.filter(url => technical.some((path: string) => url.endsWith(path)))).toEqual([]);
  await expect(page.getByLabel('Open design').locator('option:checked')).toHaveText(`${created.template.name} · original · 1 version`);
  await page.screenshot({ path: testInfo.outputPath('curated-editor.png') });
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.reload();
  await expect(layers.locator('li')).toHaveCount(6);
  await expect(page.getByLabel('Active version')).toHaveCount(0);

  // Saved Runs and the run dashboard only read persisted facts: the page sends no request that could spend anything.
  const writes = writesOf(page), before = await runOf(request, runId);
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await panel.getByRole('tab', { name: 'Saved Runs' }).click();
  await panel.getByRole('textbox', { name: 'Search saved runs' }).fill(runId);
  await panel.getByLabel('Filter runs by status').selectOption('READY FOR EDITOR');
  await expect(panel.getByRole('article')).toHaveCount(1);
  await expect(panel.getByRole('article', { name: `Saved run ${runId}`, exact: true })).toContainText(created.template.name);
  await panel.getByRole('textbox', { name: 'Search saved runs' }).fill('no-such-run');
  await expect(panel.getByRole('heading', { name: 'No matching runs' })).toBeVisible();
  await panel.getByRole('button', { name: 'Clear filters' }).click();
  await page.screenshot({ path: testInfo.outputPath('saved-runs-desktop.png') });
  await panel.getByRole('article', { name: `Saved run ${runId}`, exact: true }).getByRole('button', { name: 'View run' }).click();
  await expect(panel.getByRole('status')).toHaveText('READY FOR EDITOR');
  await expect(panel.getByTestId('run-cost')).toHaveText('Calculated ₹49.71');
  await expect(panel.getByTestId('cost-planner')).toContainText('₹10.22');
  await expect(panel.getByTestId('cost-seedream')).toContainText('₹39.49');
  for (const stage of ['reference', 'generation', 'residual', 'background']) await expect(panel.getByTestId(`cost-${stage}`)).toContainText('₹0.00');
  await expect(panel.getByTestId('layer-story')).toHaveText('13 → 6');
  await expect(panel.getByTestId('cost-target')).toContainText('Above ₹33 target by ₹16.71');
  await expect(panel.getByRole('region', { name: 'Reusable template' })).toContainText('Planner: new structure');
  await expect(panel.getByTestId('editor-layer-grid').locator('img')).toHaveCount(6);
  await expect(panel.getByTestId('raw-layer-grid')).toHaveCount(0);
  // Why each background step ran or was skipped, and why the recursion stopped: in words, with no paid call.
  await panel.getByText('Why each recovery step ran or was skipped', { exact: true }).click();
  const steps = panel.getByRole('list', { name: 'Background recovery steps' });
  await expect(steps.getByRole('listitem')).toHaveCount(4);
  await expect(steps).toContainText('Seedream scene layers: chosen');
  await expect(steps).toContainText('AI reconstruction: skipped');
  await expect(steps).not.toContainText('paid call');
  await expect(panel.getByTestId('recursion-decision')).toContainText('Why:');
  await panel.getByText('Why each recovery step ran or was skipped', { exact: true }).click();
  await expect(panel.getByText('offline-planner-request', { exact: false })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('dashboard-desktop.png') });
  await panel.getByText('Raw / internal layers (13)', { exact: true }).click();
  await expect(panel.getByTestId('raw-layer-grid').locator('img')).toHaveCount(13);
  await expect(panel.getByTestId('raw-layer-grid')).toContainText('Translucent oversized-phone shadow');
  await panel.getByText('Raw / internal layers (13)', { exact: true }).click();
  await panel.getByText('Planner instructions', { exact: true }).click();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await panel.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  await panel.getByText('Planner instructions', { exact: true }).click();
  await panel.getByText('Developer details', { exact: true }).click();
  await expect(panel.getByText('offline-planner-request', { exact: false })).toBeVisible();
  await panel.getByText('Developer details', { exact: true }).click();

  // Narrow screens: the dashboard and Saved Runs fit without horizontal scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.locator('.ws-body').evaluate(el => { el.scrollTop = 0; });
  await expect(panel.getByTestId('run-cost')).toBeVisible();
  expect(await panel.locator('.ws-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('dashboard-narrow.png') });
  await panel.getByRole('tab', { name: 'Saved Runs' }).click();
  expect(await panel.locator('.ws-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(panel.getByRole('article', { name: `Saved run ${runId}`, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('saved-runs-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await panel.getByRole('tab', { name: 'Saved Runs' }).click();
  await panel.getByRole('article', { name: `Saved run ${runId}`, exact: true }).getByRole('button', { name: 'View run' }).click();
  await expect(panel.getByTestId('layer-story')).toHaveText('13 → 6');
  expect(writes).toEqual([]);
  expect((await runOf(request, runId)).calls).toEqual(before.calls);

  // A persisted failure shows the known subtotal plus an unknown potential charge.
  const failure = await (await request.post(`/__test__/dashboard-failure/${runId}`)).json();
  await page.reload();
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await panel.getByRole('tab', { name: 'Saved Runs' }).click();
  await panel.getByRole('article', { name: `Saved run ${failure.id}`, exact: true }).getByRole('button', { name: 'View run' }).click();
  await expect(panel.getByRole('status')).toHaveText('FAILED');
  await expect(panel.getByTestId('run-cost')).toHaveText('₹10.22 known + unknown');
  await expect(panel.getByTestId('cost-seedream')).toContainText('Unknown');
  await expect(panel.getByRole('alert')).toContainText('could not produce a valid decomposition');
  await expect(panel.getByTestId('editor-layer-grid').locator('img')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('dashboard-failure.png') });
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
