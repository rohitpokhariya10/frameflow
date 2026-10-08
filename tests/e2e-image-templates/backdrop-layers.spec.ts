import { expect, test, type Locator, type Page } from '@playwright/test';
import { API, createTemplate, executionOf, fixture, openWizard, reuseOriginal, runOf, writesOf } from './wizard.helpers';

// Offline fixture server, fake providers. The panel creative is a person in front of a rounded orange panel on a white
// canvas, the live case where the panel was folded into the background: the base, the panel and the person must be
// three editor layers, and hiding or moving the panel must show the white base, never a copy of the panel.
test.use({ extraHTTPHeaders: { origin: 'http://127.0.0.1:3317' } });
test.describe.configure({ mode: 'serial' });

/** The editor stage's colour at a design point (its own coordinates, whatever the zoom). */
const designPixel = (page: Page, x: number, y: number) => page.evaluate(([x, y]) => {
  type Stage = { find: (selector: string) => unknown[]; toCanvas: () => HTMLCanvasElement; scaleX: () => number; width: () => number };
  const stage = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages.find(s => s.find('.design-layer').length)!;
  const canvas = stage.toCanvas(), ratio = canvas.width / stage.width(), scale = stage.scaleX() * ratio;
  const d = canvas.getContext('2d')!.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}, [x, y] as const);
const close = (pixel: number[], rgb: number[], tolerance = 18) => rgb.every((v, c) => Math.abs(pixel[c] - v) <= tolerance) && pixel[3] === 255;
const WHITE = [0xfb, 0xfb, 0xfa], ORANGE_TOP_LEFT = [0xf5, 0x8d, 0x3d];
/** Panel points the person never covers (design pixels), and where they are after the panel moves 200px right. */
const PANEL_POINT: [number, number] = [70, 220];
let templateName = '';

async function selectLayer(layers: Locator, name: string) {
  const item = layers.locator('.layer-select').filter({ hasText: name });
  await item.click();
  await expect(item).toHaveAttribute('aria-pressed', 'true');
}

test('a white base and an orange panel are separate layers on creation and on saved-plan reuse; in the editor, hiding or moving the panel shows the white base', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One journey on the shared fixture server; it deletes its own template afterwards.');
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const panel = await openWizard(page);
  const created = await createTemplate(page, panel, request, { name: 'panel.png', buffer: await fixture(request, '/__test__/panel.png') });
  templateName = created.template.name;
  expect(created.usage).toMatchObject({ plannerCalls: 1, imageGenerationCalls: 0 });
  const run = await runOf(request, created.runId);
  expect(run.outputLayers.map((l: { name: string }) => l.name)).toEqual(['Background', 'Rounded orange gradient panel backdrop', 'Person presenting']);
  expect(run.refinement.backdrops).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Rounded orange gradient panel backdrop', component: true, basis: 'plan', role: 'backdrop' })]));
  expect(run.refinement.background).toMatchObject({ method: 'provider-base', status: 'provider-clean' });
  expect(run.calls).toMatchObject({ planner: 1, seedreamInitial: 1, seedreamResidual: 0, backgroundReconstruction: 0 });
  expect(run.warnings.filter((w: string) => w.startsWith('PLANNED_LAYER_'))).toEqual([]);
  const version = await (await request.get(`${API}/templates/${created.template.id}/versions/1`)).json();
  expect(version.structure.layers.map((l: { role: string; independent: boolean }) => [l.role, l.independent])).toEqual([['background', true], ['backdrop', true], ['primary_subject', true]]);

  // Reuse with the saved plan: planner 0, the same three layers.
  const reused = await reuseOriginal(page, panel, request, created.template);
  expect(reused.usage).toMatchObject({ plannerCalls: 0, decompositionPlanSource: 'saved-template' });
  const reuseRun = await runOf(request, reused.runId);
  expect(reuseRun.outputLayers.map((l: { name: string }) => l.name)).toEqual(['Background', 'Rounded orange gradient panel backdrop', 'Person presenting']);
  expect(reused.warnings).toEqual([]);

  // The editor: three layers; the panel hides and moves on its own over a clean white base.
  await panel.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  await expect(panel).toHaveCount(0);
  const layers = page.getByRole('list', { name: 'Design layers' });
  await expect(layers.locator('li')).toHaveCount(3);
  await expect.poll(() => designPixel(page, ...PANEL_POINT)).toEqual(expect.arrayContaining([255]));
  expect(close(await designPixel(page, ...PANEL_POINT), ORANGE_TOP_LEFT, 30)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('1-editor-panel-shown.png') });
  await selectLayer(layers, 'Rounded orange gradient panel backdrop');
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => close(await designPixel(page, ...PANEL_POINT), WHITE)).toBe(true);
  // The person stays, in front of the white base.
  expect(close(await designPixel(page, 380, 300), [0xe0, 0xb3, 0x9a], 24)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('2-editor-panel-hidden.png') });
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect.poll(async () => close(await designPixel(page, ...PANEL_POINT), ORANGE_TOP_LEFT, 30)).toBe(true);
  const x = page.getByRole('spinbutton', { name: 'X', exact: true }), start = Number(await x.inputValue());
  await x.fill(String(start + 200)); await x.blur();
  await expect(x).toHaveValue(String(start + 200));
  // Where the panel was: white base. Where it went: the panel.
  await expect.poll(async () => close(await designPixel(page, ...PANEL_POINT), WHITE)).toBe(true);
  expect(close(await designPixel(page, PANEL_POINT[0] + 200, PANEL_POINT[1]), ORANGE_TOP_LEFT, 30)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('3-editor-panel-moved.png') });
  expect(errors).toEqual([]);
});

test('template CRUD: view details, rename with validation, save plan settings as a new version, delete with confirmation; saved runs survive', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Uses the template the previous journey created on the shared fixture server.');
  test.setTimeout(180_000);
  expect(templateName).not.toBe('');
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const panel = await openWizard(page), writes = writesOf(page);
  const details = () => panel.getByRole('button', { name: `Details of ${templateName} v1`, exact: true });
  await details().click();
  const view = panel.getByRole('region', { name: 'Template details' });
  await expect(view.getByLabel('Template name', { exact: true })).toHaveValue(templateName);
  await expect.poll(() => view.getByRole('img', { name: `${templateName} source creative` }).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(view.getByRole('list', { name: 'Template layers' }).getByRole('listitem')).toHaveCount(3);
  await expect(view.getByRole('note')).toContainText('The plan names every layer its runs show');
  await expect(view.getByText(/v1 · .* · 2 runs/)).toBeVisible();
  expect(writes).toEqual([]);

  // Rename: an empty name is refused before anything is sent; a valid one is saved and shown on the card.
  const name = view.getByLabel('Template name', { exact: true }), save = view.getByRole('button', { name: 'Save name and description', exact: true });
  await name.fill('   ');
  await expect(view.getByRole('alert')).toContainText('A name is 1–60 characters.');
  await expect(save).toBeDisabled();
  await name.fill('Presenter on orange panel');
  await view.getByLabel('Template description', { exact: true }).fill('A person in front of a rounded panel on a plain canvas.');
  await save.click();
  await expect(view.getByRole('status')).toHaveText('Name and description saved.');

  // Plan settings: keeping the backdrop with the background is a new version; v1 and its runs are unchanged.
  await view.getByRole('checkbox', { name: 'Backdrop or frame (backdrop) is its own layer' }).uncheck();
  await view.getByRole('button', { name: 'Save settings as a new version', exact: true }).click();
  await expect(view.getByRole('status')).toHaveText('Saved as v2. Runs that used v1 keep it.');
  await expect(view.getByText(/v2 · .* · from v1: backdrop: kept with another layer/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('4-template-details.png') });

  // Persisted: after a reload the library card shows the new name and version.
  await page.reload(); await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await panel.getByRole('tab', { name: 'Create Template', exact: true }).click();
  const card = panel.getByRole('article', { name: 'Presenter on orange panel v2', exact: true });
  await expect(card).toBeVisible();
  const template = (await (await request.get(`${API}/templates`)).json()).templates.find((t: { name: string }) => t.name === 'Presenter on orange panel');
  expect(template).toMatchObject({ currentVersion: 2, versions: [1, 2] });
  const history = (await (await request.get(`${API}/template-executions`)).json()).executions.filter((e: { template?: { id: string } }) => e.template?.id === template.id);
  expect(history.map((e: { template: { version: number } }) => e.template.version)).toEqual([1, 1]);

  // Delete: Cancel keeps it; confirming removes it from the library, never its saved runs.
  await panel.getByRole('button', { name: 'Details of Presenter on orange panel v2', exact: true }).click();
  await view.getByRole('button', { name: 'Delete template', exact: true }).click();
  const dialog = panel.getByRole('alertdialog', { name: 'Delete “Presenter on orange panel”?' });
  await expect(dialog).toContainText('Saved runs, their images and layers');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await view.getByRole('button', { name: 'Delete template', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('5-delete-confirmation.png') });
  await dialog.getByRole('button', { name: 'Delete template', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Template deleted. Its saved runs stay in Saved Runs.');
  await expect(panel.getByRole('article', { name: /Presenter on orange panel/ })).toHaveCount(0);
  expect((await request.get(`${API}/templates/${template.id}`)).status()).toBe(404);
  await page.reload(); await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await panel.getByRole('tab', { name: 'Create Template', exact: true }).click();
  await expect(panel.getByRole('article', { name: /Presenter on orange panel/ })).toHaveCount(0);
  // The saved runs still open, with their layers, from Saved Runs.
  for (const e of history) expect(await executionOf(request, e.id)).toMatchObject({ state: 'done', template: { id: template.id, version: 1 } });
  await panel.getByRole('tab', { name: 'Saved Runs', exact: true }).click();
  await panel.getByRole('region', { name: 'Saved template executions' }).locator(`button:has(img[src*="${history[0].id}"])`).click();
  await expect(panel.getByRole('heading', { name: /Your (template|creative) is ready/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Open in Editor', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
