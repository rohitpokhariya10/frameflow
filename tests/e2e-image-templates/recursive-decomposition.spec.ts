import { expect, test } from '@playwright/test';

// Runs only in playwright.offline.config.ts, against the real API and runner with injected local providers: the complex
// offer's first decomposition misses the speaker and power bank, the residual pass finds them (plus a duplicate of the
// headphones), and the background edit is a local fill. No request leaves this machine.
test('recursive decomposition of a complex offer: missed products found once, one clean background, separately editable layers', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The fixture server is shared by every project and runs one decomposition at a time; one journey is enough.');
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.goto('/');
  const headers = { Origin: new URL(page.url()).origin };
  const complexCalls = async () => (await (await request.get('/__test__/provider-calls')).json() as { kind: string; complex?: boolean }[]).filter(call => call.complex).length;
  const complexBefore = await complexCalls();

  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.locator('label', { hasText: 'Template:' }).locator('select').selectOption('template-b');
  const offer = await request.get('/__test__/complex-offer.png');
  await panel.getByLabel('Image to decompose').setInputFiles({ name: 'complex-offer.png', mimeType: 'image/png', buffer: await offer.body() });
  await expect(panel.getByRole('checkbox', { name: /Recursive cleanup \+ clean background/ })).toBeChecked();
  const runButton = panel.getByRole('button', { name: /^Run: generate prompt/ });
  await expect(runButton).toContainText('+ cleanup (≤2 Seedream, ≤1 image edit)');

  // One active run at a time on the shared server: wait until it is idle, then start; another project may get there first.
  let runId: string | undefined;
  for (let attempt = 0; attempt < 30 && !runId; attempt++) {
    // Politely: no run active and no image-template decomposition waiting its turn (it must not be starved by these runs).
    await expect.poll(async () => {
      const busy = (await (await request.get('/api/layerize-experiment/runs', { headers })).json()).active;
      const templates = (await (await request.get('/api/layerize-experiment/image-templates', { headers })).json()).templates as { variants: { decomposition?: { state: string } }[] }[];
      return busy ?? templates.some(t => t.variants.some(v => v.decomposition && ['waiting', 'running'].includes(v.decomposition.state))) ? 'busy' : null;
    }, { timeout: 120_000 }).toBeNull();
    const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/layerize-experiment/runs') && r.request().method() === 'POST'), runButton.click()]);
    if (response.status() === 202) runId = (await response.json()).id;
    else expect(response.status()).toBe(409);
  }
  expect(runId).toBeTruthy();
  await expect(panel.getByText('Stage: done', { exact: true })).toBeVisible({ timeout: 60_000 });

  // Debug view: passes, final layers, residual cleanup, background and every provider call.
  const debug = panel.getByTestId('refinement-debug');
  await expect(debug.getByTestId('refinement-passes')).toHaveText('2 (1 initial + 1 residual, at most 2)');
  await expect(debug.getByTestId('refinement-final-layers')).toHaveText('10');
  await expect(debug.getByTestId('refinement-residual-cleanup')).toHaveText('Performed (stopped: clean)');
  await expect(debug.getByTestId('refinement-background')).toHaveText('AI reconstructed');
  await expect(debug.getByTestId('refinement-calls')).toHaveText('planner 1 · initial Seedream 1 · residual Seedream 1 · background edit 1');
  await expect(debug).toContainText(/Residual pass 1: done · fal offline-\d+ · returned 4 · kept 2 · rejected Wireless headphones \((duplicate|inside-extracted-region)/);
  await expect(panel.getByAltText('Reconstruction')).toBeVisible();
  await expect(panel.getByText('Final output layers (10) — what Open in editor imports')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('1-refined-run.png'), fullPage: true });

  // The run itself: each product once, provenance per pass, the base replaced by the clean background.
  const run = await (await request.get(`/api/layerize-experiment/runs/${runId}`, { headers })).json();
  expect(run.calls).toEqual({ fitCheck: 0, planner: 1, seedreamInitial: 1, seedreamResidual: 1, backgroundReconstruction: 1 });
  expect(await complexCalls() - complexBefore).toBe(2);
  const names = run.outputLayers.map((layer: { name: string }) => layer.name);
  for (const name of ['Display pedestal', 'Gift box', 'Bluetooth speaker', 'Power bank', 'Wireless headphones', 'Earbuds', 'Smartwatch', 'Confetti', 'MEGA SALE headline']) expect(names.filter((n: string) => n === name), name).toHaveLength(1);
  const pass = (name: string) => run.outputLayers.find((layer: { name: string }) => layer.name === name).provenance.sourcePass;
  expect([pass('Bluetooth speaker'), pass('Power bank'), pass('Wireless headphones'), pass('Smartwatch')]).toEqual([1, 1, 0, 0]);
  expect(run.outputLayers[0]).toMatchObject({ file: 'clean-background.png', rawFile: 'layer-00.png', cleanBackground: { status: 'ai-reconstructed', method: 'ai-reconstruction' } });
  for (const file of ['clean-background.png', 'foreground-mask.png', 'residual-pass-1.png', 'reconstructed.png', 'contact-sheet.png', 'decomposition-debug.json']) {
    expect((await request.get(`/api/layerize-experiment/runs/${runId}/files/${file}`, { headers })).status(), file).toBe(200);
  }

  // The editor: the clean background plus every object as its own selectable layer.
  await panel.getByRole('button', { name: 'Open in editor', exact: true }).click();
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
