import { expect, test } from '@playwright/test';

test('family product flow: new layout, local reuse, dynamic fields, reload, original, generated reuse and drift, fresh plan, dashboard and narrow layout', async ({ page, request }, testInfo) => {
  test.setTimeout(240_000);
  page.on('dialog', d => void d.accept());
  // Viewport projects share one offline server: names are per project, and the dialog is pointed at this project's creative.
  const headphones = `Family headphones ${testInfo.project.name}`, iphone = `Family iPhone ${testInfo.project.name}`;
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.goto('/');
  // The experiment API answers only the app's own origin.
  const headers = { Origin: new URL(page.url()).origin };
  const api = async (path: string) => (await request.get(`/api/layerize-experiment${path}`, { headers })).json();
  const open = async () => {
    await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
    await page.getByRole('tab', { name: 'Create Template', exact: true }).click();
    await page.getByRole('button', { name: 'Create Template from Image', exact: true }).click();
  };
  await open();
  const dialog = page.getByRole('dialog', { name: 'Create Template from Image' });
  const upload = async (creative: string, name: string) => {
    await dialog.getByRole('button', { name: 'New template' }).click();
    await dialog.getByLabel('Creative name', { exact: true }).fill(name);
    const image = await request.get(`/__test__/family/${creative}`);
    await dialog.getByLabel('Reference creative', { exact: true }).setInputFiles({ name: `${creative}.png`, mimeType: 'image/png', buffer: await image.body() });
    await dialog.getByRole('button', { name: 'Upload reference · no API call' }).click();
    await dialog.getByRole('button', { name: 'Detect layout', exact: true }).click();
    await expect(dialog.getByRole('region', { name: 'Layout fields' })).toBeVisible();
  };
  const before = await (await request.get('/__test__/family-calls')).json();
  await upload('headphonesBlue', headphones);
  const first = (await api('/image-templates')).templates.find((t: { name: string }) => t.name === headphones);
  // It is new in an isolated run, or already cached when this project follows another viewport.
  expect(['created', 'reused']).toContain(first.family.detection.outcome);
  await request.post(`/__test__/family-active/${first.family.ref.familyId}`);
  const afterFirst = await (await request.get('/__test__/family-calls')).json();
  expect(afterFirst.structure.length - before.structure.length).toBeLessThanOrEqual(1);
  const familiesBefore = (await api('/template-families')).families.length;
  await upload('iphoneRed', iphone);
  const afterSecond = await (await request.get('/__test__/family-calls')).json();
  expect(afterSecond.structure).toEqual(afterFirst.structure);
  await expect(dialog.getByText('Saved layout matched', { exact: false })).toBeVisible();
  const fields = dialog.getByRole('region', { name: 'Layout fields' });
  await fields.getByLabel('Product', { exact: true }).fill('iPhone');
  await fields.getByLabel('Background', { exact: true }).fill('Red gradient');
  await fields.getByLabel('Headline', { exact: true }).fill('Mega Sale');
  await fields.getByLabel('Button text', { exact: true }).fill('Buy Now');
  await dialog.getByText('Locally compiled generation prompt', { exact: true }).click();
  await expect(fields.locator('pre')).toContainText('iPhone');
  await expect(fields.locator('pre')).not.toContainText('headphones');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('button', { name: 'Generate changed creative' })).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('family-mobile.png') });
  await page.reload(); await open();
  await dialog.getByRole('button', { name: iphone }).click();
  await expect(dialog.getByRole('region', { name: 'Layout fields' }).getByLabel('Product', { exact: true })).toHaveValue('iPhone');
  await dialog.getByRole('button', { name: 'Use original unchanged · no image call' }).click();
  const card = (ratio: string) => dialog.getByRole('article', { name: `${ratio} result` });
  await expect(card('original').getByRole('img', { name: `${iphone}, original`, exact: true })).toBeVisible();
  await card('original').getByRole('button', { name: 'Decompose into layers', exact: true }).click();
  await expect(card('original').getByTestId('status-original')).toHaveText('Decomposed', { timeout: 60000 });
  const group = async () => (await api('/image-templates')).templates.find((t: { name: string }) => t.name === iphone);
  const runOf = async (variantId: string) => (await group()).variants.find((v: { id: string }) => v.id === variantId).decomposition.runId as string;
  const stage = (diagnostics: { stages: { id: string; calls: unknown[] }[] }, id: string) => diagnostics.stages.find(s => s.id === id)!.calls;
  const runId = await runOf('original');
  const diagnostics = await api(`/runs/${runId}/diagnostics`);
  // The uploaded original: no image generation, so no generated-image check either.
  expect(diagnostics.reuse).toMatchObject({ analysisReused: true, generationPromptTemplateReused: false, decompositionPlanReused: true, avoided: { analysis: 1, planner: 1 } });
  expect(diagnostics.reuse.imageValidation).toBeUndefined();
  expect(stage(diagnostics, 'generation')).toEqual([]);
  expect(stage(diagnostics, 'planner')).toEqual([]);

  // Generated images. The fixture's square image keeps the family's layout; its 4:5 image is a different composition.
  await expect(dialog.getByLabel('1:1', { exact: true })).toBeChecked();
  await expect(dialog.getByLabel('4:5', { exact: true })).toBeChecked();
  const ratiosSaved = page.waitForResponse(r => r.request().method() === 'PATCH' && r.ok());
  await dialog.getByLabel('16:9', { exact: true }).uncheck();
  await ratiosSaved;
  await dialog.getByRole('button', { name: 'Generate changed creative' }).click();
  for (const [ratio, id] of [['1:1', '1x1'], ['4:5', '4x5']]) await expect(card(ratio).getByTestId(`status-${id}`)).toHaveText('Generated', { timeout: 60000 });
  const generated = await group();
  // Generated from the saved template compiled with this creative's values, pinned to the detected version.
  expect(generated.prompt).toContain('Mega Sale');
  expect(generated.prompt).not.toMatch(/headphones|Summer Sale/i);
  expect(generated.family.generation.ref).toEqual(generated.family.ref);
  for (const [ratio, id] of [['1:1', '1x1'], ['4:5', '4x5']]) {
    await card(ratio).getByRole('button', { name: 'Decompose into layers', exact: true }).click();
    await expect(card(ratio).getByTestId(`status-${id}`)).toHaveText('Decomposed', { timeout: 60000 });
  }
  const square = await api(`/runs/${await runOf('1x1')}/diagnostics`);
  expect(square.reuse).toMatchObject({ version: generated.family.ref.version, analysisReused: true, generationPromptTemplateReused: true, decompositionPlanReused: true,
    imageValidation: { passed: true, problems: [] }, avoided: { analysis: 1, planner: 1 } });
  expect(stage(square, 'generation')).toHaveLength(1);
  expect(stage(square, 'planner')).toEqual([]);
  const driftRunId = await runOf('4x5'), drifted = await api(`/runs/${driftRunId}/diagnostics`);
  expect(drifted.reuse).toMatchObject({ generationPromptTemplateReused: true, decompositionPlanReused: false, planNotReusedReason: 'generated-image-drift', imageValidation: { passed: false }, avoided: { analysis: 1, planner: 0 } });
  expect(drifted.reuse.imageValidation.problems.length).toBeGreaterThan(0);
  expect(stage(drifted, 'planner')).toHaveLength(1);
  await expect(card('4:5').getByTestId('drift-4x5')).toContainText('drifted from the saved layout');
  await expect(card('1:1').getByTestId('drift-1x1')).toHaveCount(0);

  // An explicit fresh plan uses the planner even though the square image matches; the version stays pinned.
  const squareRun = await runOf('1x1');
  await card('1:1').getByRole('button', { name: 'Plan fresh & decompose', exact: true }).click();
  await expect.poll(() => runOf('1x1'), { timeout: 60000 }).not.toBe(squareRun);
  await expect(card('1:1').getByTestId('status-1x1')).toHaveText('Decomposed', { timeout: 60000 });
  const fresh = await api(`/runs/${await runOf('1x1')}/diagnostics`);
  expect(fresh.reuse).toMatchObject({ version: generated.family.ref.version, decompositionPlanReused: false, planNotReusedReason: 'plan-fresh', avoided: { planner: 0 } });
  expect(fresh.reuse.imageValidation).toBeUndefined();
  expect(stage(fresh, 'planner')).toHaveLength(1);
  // Retries and fresh plans add no family and no structure analysis.
  expect((await api('/template-families')).families.length).toBe(familiesBefore);
  expect((await (await request.get('/__test__/family-calls')).json()).structure).toEqual(afterFirst.structure);

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await page.getByRole('tab', { name: /Saved Runs/ }).click();
  await page.getByRole('article', { name: `Saved run ${runId}`, exact: true }).getByRole('button', { name: 'View run' }).click();
  const reuse = page.getByRole('region', { name: 'Reusable template' });
  await expect(reuse).toContainText('2 planning calls avoided');
  await expect(reuse).toContainText('Reused · ₹0');
  await page.getByRole('tab', { name: /Saved Runs/ }).click();
  await page.getByRole('article', { name: `Saved run ${driftRunId}`, exact: true }).getByRole('button', { name: 'View run' }).click();
  await expect(reuse).toContainText('Generated image drifted from the layout');
  await expect(reuse).toContainText('Saved template · locally compiled · ₹0');
  await expect(reuse).toContainText('1 planning call avoided');
  expect(errors).toEqual([]);
  expect((await (await request.get('/__test__/family-calls')).json()).liveProviders).toBe(0);
});
