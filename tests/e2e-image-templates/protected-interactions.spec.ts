import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Runs only in playwright.offline.config.ts, against the real API and runner with injected local providers. Seedream's
// fake answers are the splits seen live and its base has everything baked in; for the woman holding a phone the fake
// image edit also fails the way gpt-image-2 did live (a black silhouette). The people stay intact layers, and hiding or
// moving them must reveal a clean, usable background.
test.describe.configure({ mode: 'serial' });

/** Uploads an image to the OpenAI + Seedream test panel (Template B, recursive cleanup on) and waits for its run. */
async function decompose(page: Page, request: APIRequestContext, image: string, file: string) {
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.goto('/');
  const headers = { Origin: new URL(page.url()).origin };
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.locator('label', { hasText: 'Template:' }).locator('select').selectOption('template-b');
  await panel.getByLabel('Image to decompose').setInputFiles({ name: file, mimeType: 'image/png', buffer: await (await request.get(image)).body() });
  await expect(panel.getByRole('checkbox', { name: /Recursive cleanup \+ clean background/ })).toBeChecked();
  const runButton = panel.getByRole('button', { name: /^Run: generate prompt/ });
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
  return { panel, runId: runId!, run: await (await request.get(`/api/layerize-experiment/runs/${runId}`, { headers })).json() };
}

test('a person holding a phone stays one intact layer; hiding or moving her reveals a clean white-and-yellow background, not a silhouette', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The fixture server is shared by every project and runs one decomposition at a time; one journey is enough.');
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { panel, runId, run } = await decompose(page, request, '/__test__/holding-phone.png', 'holding-phone.png');

  // Debug view: two protected groups; the AI edit's black silhouette rejected; the continuation of the design used.
  const debug = panel.getByTestId('refinement-debug');
  await expect(debug.getByTestId('refinement-protected-groups')).toHaveText('2 (9 → 5 layers)');
  await expect(debug.getByTestId('refinement-background')).toHaveText('Fallback: continued from the surrounding background (not AI reconstructed)');
  await expect(debug.getByTestId('refinement-background-quality')).toHaveText(/^usable · hard-large-occlusion · mask [\d.]+%, largest region [\d.]+%$/);
  await expect(debug.getByTestId('background-candidates')).toContainText('ai-reconstruction failed (black-region');
  await expect(debug.getByTestId('background-candidates')).toContainText('graphic-fill usable ✓ used');
  await expect(debug.getByTestId('refinement-calls')).toHaveText('planner 1 · initial Seedream 1 · residual Seedream 0 · background edit 1');
  await expect(panel.getByText(/^Kept together \(hand holding object\): Woman base — parent; Smartphone with white screen — held object; Green success badge on the screen — object content; Foreground gripping finger fragments — finger fragment$/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('1-protected-run.png'), fullPage: true });

  expect(run.interactions).toMatchObject({ layersBefore: 9, layersAfter: 5, groups: 2 });
  expect(run.refinement.background).toMatchObject({ status: 'fallback', method: 'graphic-fill', quality: 'usable', fallbackUsed: true, aiTried: true });
  // Where the woman, her hand and the phone were, the background is the white field and the yellow curve: no black.
  const check = await (await request.get(`/__test__/background-check?run=${runId}&creative=holding`)).json();
  expect(check).toMatchObject({ file: 'clean-background.png', black: 0 });
  expect(check.matchShare).toBeGreaterThanOrEqual(0.9);

  // The editor: the person with the phone moves and hides as one; the rest stays editable.
  await panel.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(panel).toHaveCount(0);
  const layers = page.getByRole('list', { name: 'Design layers' });
  await expect(layers.locator('li')).toHaveCount(6);
  for (const name of ['Black headline text', 'Small white GET text', 'Navy rounded CTA pill + White CTA chevron']) await expect(layers.locator('.layer-select').filter({ hasText: name })).toHaveCount(1);
  await expect(layers.locator('.layer-select').filter({ hasText: /^Foreground gripping finger fragments/ })).toHaveCount(0);
  await expect(layers.locator('.layer-select').filter({ hasText: 'Background (fallback fill) (z0)' })).toHaveCount(1);
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
  await page.screenshot({ path: testInfo.outputPath('4-restored.png') });
  expect(errors).toEqual([]);
});

test('worn bangles stay with their hands; hiding the hands reveals the red field, with no gold ghosts', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The fixture server is shared by every project and runs one decomposition at a time; one journey is enough.');
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { panel, runId, run } = await decompose(page, request, '/__test__/bangles.png', 'bangles.png');
  const groups = run.outputLayers.filter((layer: { grouping?: { members: { role: string }[] } }) => layer.grouping?.members.some(m => m.role === 'worn_ornament'));
  expect(groups).toHaveLength(3);
  const names: string[] = run.outputLayers.map((layer: { name: string }) => layer.name);
  expect(names).toEqual(expect.arrayContaining(['Standalone gold bangle product', '"BANGLES OF INDIA" headline']));
  expect(names.filter(name => /bangle (stack|cluster)/.test(name) && !name.includes('+'))).toEqual([]);
  expect(run.refinement.background).toMatchObject({ quality: 'usable' });
  const check = await (await request.get(`/__test__/background-check?run=${runId}&creative=bangles`)).json();
  expect(check.black).toBe(0);
  expect(check.matchShare).toBeGreaterThanOrEqual(0.95);
  await panel.getByRole('button', { name: 'Open in editor', exact: true }).click();
  const layers = page.getByRole('list', { name: 'Design layers' });
  await expect(layers.locator('li')).toHaveCount(run.outputLayers.length);
  const left = layers.locator('.layer-select').filter({ hasText: 'Left paired hands + Left Coorgi gold bangle stack' });
  await left.click();
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('bangles-hidden.png') });
  expect(errors).toEqual([]);
});
