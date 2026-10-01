import { IMAGE_TEMPLATE_LIMITS } from '@frameflow/shared';
import { expect, test } from '@playwright/test';

// Runs only in playwright.offline.config.ts, against the real API with injected local providers.
test('reviewer journey through real routes: reference → editable prompt → selected sizes → layers → editable editor version', async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => void dialog.accept());
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.goto('/');
  const zoom = page.getByLabel('Canvas zoom');
  const zoomBox = (await zoom.boundingBox())!;
  for (const launcher of await page.locator('.decomp-launch').all()) {
    const box = (await launcher.boundingBox())!;
    expect(box.x >= zoomBox.x + zoomBox.width || box.x + box.width <= zoomBox.x || box.y >= zoomBox.y + zoomBox.height || box.y + box.height <= zoomBox.y).toBe(true);
  }
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('1-launchers.png') });
  await expect(page.getByRole('button', { name: 'Image to layers', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('button', { name: 'Create Template from Image' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Template from Image' });
  await dialog.getByRole('button', { name: 'New template' }).click();
  const name = `Lavender launch ${testInfo.project.name}`;
  await dialog.getByLabel('Template name').fill(name);
  const reference = await request.get('/__test__/reference.png');
  await dialog.getByLabel('Reference image', { exact: true }).setInputFiles({ name: 'lavender-studio.png', mimeType: 'image/png', buffer: await reference.body() });
  // Sizes selected before upload must survive prompt generation.
  await dialog.getByRole('checkbox', { name: '16:9 Landscape' }).uncheck();
  await dialog.getByRole('checkbox', { name: '4:5 Portrait' }).uncheck();
  await dialog.getByRole('button', { name: 'Generate prompt from image' }).click();
  const prompt = dialog.getByLabel('Generated prompt');
  await expect(prompt).toHaveValue(/lavender smartphone/, { timeout: 10_000 });
  expect((await prompt.inputValue()).length).toBeLessThanOrEqual(IMAGE_TEMPLATE_LIMITS.prompt);
  await expect(dialog.locator('.cti-count')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Generate selected templates (1)' })).toBeEnabled();
  await expect(dialog.getByRole('checkbox', { name: '16:9 Landscape' })).not.toBeChecked();
  await prompt.fill(`${await prompt.inputValue()} Warm afternoon lighting.`);
  // A single click immediately after typing must save the edit and generate (blur must not disable the action).
  await page.screenshot({ path: testInfo.outputPath('2-edit-prompt.png') });
  await dialog.getByRole('button', { name: 'Generate selected templates (1)' }).click();
  const card = dialog.getByRole('article', { name: '1:1 result' });
  await expect(card.getByTestId('status-1x1')).toHaveText('Generated', { timeout: 10_000 });
  await expect(dialog.locator('article[data-ratio]')).toHaveCount(1);
  await dialog.getByText('Prompt used (edited)', { exact: true }).click();
  await expect(dialog.getByTestId('prompt-used')).toContainText('Warm afternoon lighting.');
  await card.getByRole('button', { name: 'Decompose into layers' }).click();
  await expect(card.getByTestId('status-1x1')).toHaveText('Decomposed', { timeout: 15_000 });
  await card.getByText('Preview layers', { exact: true }).click();
  await expect(card.locator('.cti-layer-previews img')).toHaveCount(2);
  await expect(card.getByAltText('Lavender phone', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Open in editor', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('3-layers.png') });
  await card.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Active version').locator('option')).toHaveCount(2);
  const layers = page.getByRole('list', { name: 'Design layers' });
  await expect(layers.locator('li')).toHaveCount(2);
  await layers.locator('.layer-select').filter({ hasText: 'Lavender phone' }).click();
  await page.getByRole('spinbutton', { name: 'X', exact: true }).fill('45');
  await page.getByRole('spinbutton', { name: 'X', exact: true }).blur();
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('45');
  await page.screenshot({ path: testInfo.outputPath('4-editor.png') });
  await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('list', { name: 'Design layers' }).locator('li')).toHaveCount(2);
  await page.getByRole('list', { name: 'Design layers' }).locator('.layer-select').filter({ hasText: 'Lavender phone' }).click();
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('45');
  expect(errors).toEqual([]);
});


test('verbose structured analysis succeeds for independent named groups and explicit regeneration', async ({ page, request }, testInfo) => {
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  page.on('dialog', dialog => void dialog.accept());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await page.getByRole('button', { name: 'Create Template from Image', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Create Template from Image' });
  const names: string[] = [];
  for (const length of [3344, 4002]) {
    await d.getByRole('button', { name: 'New template' }).click();
    const name = `Structured ${length} ${testInfo.project.name}`; names.push(name);
    await d.getByLabel('Template name').fill(name);
    const image = await request.get(`/__test__/reference.png?analysis=${length}`);
    await d.getByLabel('Reference image', { exact: true }).setInputFiles({ name: `${length}.png`, mimeType: 'image/png', buffer: await image.body() });
    await d.getByRole('button', { name: 'Generate prompt from image' }).click();
    const prompt = d.getByLabel('Generated prompt');
    await expect(prompt).toHaveValue(/lavender smartphone/, { timeout: 10_000 });
    const generated = await prompt.inputValue();
    expect(generated.length).toBeLessThanOrEqual(IMAGE_TEMPLATE_LIMITS.prompt);
    await expect(d.getByRole('button', { name: /^Generate selected templates/ })).toBeEnabled();
    await prompt.fill(`${generated} Warm afternoon lighting.`);
    await prompt.blur();
    await d.getByRole('button', { name: 'Write again from image' }).click();
    await expect(prompt).toHaveValue(generated, { timeout: 10_000 });
    await expect(d.getByLabel('Template name')).toHaveValue(name);
    const templates = (await (await request.get('/api/layerize-experiment/image-templates', { headers: { Origin: new URL(page.url()).origin } })).json()).templates;
    const group = templates.find((t: { name: string }) => t.name === name);
    expect(group.promptGeneration).toMatchObject({ status: 'done', attempts: 2, responseId: `offline-analysis-${length}` });
    expect(group.variants).toEqual([]);
    expect(group.analysis.hero.identity).toBe('one lavender smartphone');
  }
  await d.getByRole('list').getByRole('button').filter({ hasText: names[0] }).click();
  await expect(d.getByLabel('Template name')).toHaveValue(names[0]);
  await expect(d.getByLabel('Generated prompt')).toHaveValue(/lavender smartphone/);
});


test('corrupt upload fails before analysis and creates no template group', async ({ page, request }, testInfo) => {
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await page.getByRole('button', { name: 'Create Template from Image', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Create Template from Image' });
  await d.getByRole('button', { name: 'New template' }).click();
  const name = `Invalid upload ${testInfo.project.name}`;
  await d.getByLabel('Template name').fill(name);
  await d.getByLabel('Reference image', { exact: true }).setInputFiles({ name: 'corrupt.png', mimeType: 'image/png', buffer: Buffer.from('not a PNG') });
  await d.getByRole('button', { name: 'Generate prompt from image' }).click();
  await expect(d.getByRole('alert')).toContainText('Upload a PNG, JPEG or WebP image.');
  await expect(d.getByRole('button', { name: /^Generate selected templates/ })).toBeDisabled();
  const templates = (await (await request.get('/api/layerize-experiment/image-templates', { headers: { Origin: new URL(page.url()).origin } })).json()).templates;
  expect(templates.some((t: { name: string }) => t.name === name)).toBe(false);
});
