import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * A non-technical customer's journey through "Image to layers", against the isolated E2E stack (no provider key;
 * deterministic fake discovery/segmentation). Screenshots of each state land in artifacts/decomposition/ux/.
 */
const shots = 'artifacts/decomposition/ux';
const data = () => process.env.DECOMP_E2E_DATA!;
const uploadImage = () => join(data(), 'upload-source.png');
type FakeCall = { model: string; points: number; box: boolean };
const fakeCalls = (): FakeCall[] => { const file = join(data(), 'e2e-fake-calls.log'); return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as FakeCall) : []; };
const TECHNICAL = /\b(proposal|target|SAM|Seedream|BiRefNet|IMAGE_OBJECT|ownership|phase \d|mask|candidate|revision|provider|alpha)\b/i;

const workspace = (page: Page) => page.getByRole('dialog');
const body = (page: Page) => page.locator('.ws-body');
const exact = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const layerRow = (page: Page, name: RegExp | string) => page.locator('.ws-layer').filter({ has: page.locator('.ws-layer-name', { hasText: typeof name === 'string' ? exact(name) : name }) });
async function expectPlainLanguage(page: Page) {
  // Everything a customer sees (Developer details stays collapsed and outside the body).
  const text = await body(page).innerText();
  expect(text, 'no developer terminology in the default workspace').not.toMatch(TECHNICAL);
  expect(await page.locator('.ws-dev[open]').count()).toBe(0);
}
async function openWorkspace(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Image to layers' }).click();
  await expect(workspace(page)).toBeVisible();
}
/** Resume the unfinished design: automatically for a saved project, otherwise from "Continue where you left off". */
async function resume(page: Page, heading: string) {
  const target = page.getByRole('heading', { name: heading }), card = page.getByRole('region', { name: 'Continue where you left off' });
  await expect(target.or(card)).toBeVisible();
  if (await card.isVisible()) await card.getByRole('button', { name: 'Continue' }).click();
  await expect(target).toBeVisible();
}
async function clickOnce(page: Page, button: Locator) {
  const posts: string[] = [];
  const listener = (r: { method(): string; url(): string }) => { if (r.method() === 'POST' && r.url().includes('/review')) posts.push(r.url()); };
  page.on('request', listener);
  const response = page.waitForResponse(r => r.url().includes('/review') && r.request().method() === 'POST');
  await button.dblclick();
  expect((await response).ok()).toBe(true);
  await page.waitForTimeout(300);
  page.off('request', listener);
  expect(posts, 'a double click submits exactly once').toHaveLength(1);
}

test.describe.configure({ mode: 'serial' });

test('upload → processing → review layers: combine, split, rename, remove, choose type, resume after reload', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await openWorkspace(page);
  await expect(page.getByRole('heading', { name: 'Turn any image into an editable design' })).toBeVisible();
  await expect(page.getByText('Upload a poster, social graphic or product creative.')).toBeVisible();
  const separate = page.getByRole('button', { name: 'Separate layers' });
  await expect(separate).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Recent designs' })).toContainText('Waiting for your review');
  await page.screenshot({ animations: 'disabled', path: `${shots}/01-upload.png` });
  // Friendly validation for an unusable file.
  await page.getByLabel('Choose image').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.getByRole('alert')).toHaveText('Please choose a PNG, JPEG or WebP image.');
  await expectPlainLanguage(page);

  // Upload the poster and start.
  await page.getByLabel('Choose image').setInputFiles(uploadImage());
  await expect(page.getByRole('img', { name: 'Selected image' })).toBeVisible();
  await expect(separate).toBeEnabled();
  await page.screenshot({ animations: 'disabled', path: `${shots}/01b-upload-selected.png` });
  await separate.click();
  await expect(page.getByRole('heading', { name: 'Preparing your design…' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('status').filter({ hasText: 'Understanding design' })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: `${shots}/02-processing.png` });

  // Review detected layers.
  await expect(page.getByRole('heading', { name: 'Review detected layers' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.ws-layer').first()).toBeVisible();
  await expectPlainLanguage(page);
  await page.screenshot({ animations: 'disabled', path: `${shots}/03-review.png` });
  const names = await page.locator('.ws-layer-name').allInnerTexts();
  const person = names.find(n => /woman|person/i.test(n))!, phone = names.find(n => /phone/i.test(n) && !/woman|person/i.test(n))!;
  const headline = names.find(n => /PRO|headline/i.test(n) && n !== person && n !== phone)!;
  expect([person, phone, headline].every(Boolean)).toBe(true);

  // Selecting a layer highlights it in the preview; arrow keys move through the list.
  await layerRow(page, person).locator('.ws-layer-main').click();
  await expect(page.locator('.ws-preview-label')).toHaveText(person);
  await expect(page.locator('.ws-highlight').first()).toBeAttached();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.ws-layer.is-active .ws-layer-name')).not.toHaveText(person);

  // Combine is unavailable until two layers are selected.
  await layerRow(page, person).getByRole('checkbox').check();
  await expect(page.getByText('1 layer selected')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Combine layers' })).toBeDisabled();
  await layerRow(page, phone).getByRole('checkbox').check();
  await expect(page.getByText('2 layers selected')).toBeVisible();
  await page.getByRole('button', { name: 'Combine layers' }).click();
  await page.getByLabel('Name (optional)').fill('Woman with phone');
  await page.screenshot({ animations: 'disabled', path: `${shots}/03b-combine.png` });
  await page.getByRole('button', { name: 'Combine', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Combined 2 layers into “Woman with phone”' })).toBeVisible();
  await expect(layerRow(page, 'Woman with phone')).toContainText('Combined');
  await expect(layerRow(page, person)).toHaveCount(0);

  // Split it back, then combine again.
  await page.getByRole('button', { name: 'Split layer' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Split into 2 layers' })).toBeVisible();
  await expect(layerRow(page, person)).toHaveCount(1); await expect(layerRow(page, phone)).toHaveCount(1);
  await layerRow(page, person).getByRole('checkbox').check(); await layerRow(page, phone).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Combine layers' }).click();
  await page.getByLabel('Name (optional)').fill('Woman with phone');
  await page.getByRole('button', { name: 'Combine', exact: true }).click();

  // Rename the headline; remove one layer.
  await layerRow(page, headline).locator('.ws-layer-main').click();
  await page.getByLabel('Layer name').fill('PRO');
  await expect(layerRow(page, /^PRO$/)).toHaveCount(1);
  const removable = names.find(n => /signature|footer|bar/i.test(n))!;
  await layerRow(page, removable).locator('.ws-layer-main').click();
  await page.getByRole('radio', { name: 'Remove' }).click();
  await expect(layerRow(page, removable)).toContainText('Removed');

  // An ambiguous layer blocks Continue until its type is chosen.
  const continueButton = page.getByRole('button', { name: 'Continue' });
  const ambiguous = page.locator('.ws-layer').filter({ hasText: 'Choose type' }).first();
  await expect(ambiguous).toBeVisible();
  await expect(continueButton).toBeDisabled();
  await expect(page.locator('.ws-footer-status')).toContainText('Choose a type for');
  await ambiguous.locator('.ws-layer-main').click();
  await expect(page.getByText('AI wasn\'t sure what this is. Choose a type to continue.')).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: `${shots}/03c-choose-type.png` });
  await page.getByRole('radio', { name: 'Text' }).click();
  await expect(continueButton).toBeEnabled();

  // Reload: the choices come back (resume from the same job and draft).
  await page.reload();
  await page.getByRole('button', { name: 'Image to layers' }).click();
  await resume(page, 'Review detected layers');
  await expect(layerRow(page, 'Woman with phone')).toHaveCount(1);
  await expect(layerRow(page, /^PRO$/)).toHaveCount(1);
  await expect(layerRow(page, removable)).toContainText('Removed');
  await expect(page.locator('.ws-layer').filter({ hasText: 'Choose type' })).toHaveCount(0);

  // "Save for later" stores the choices on the server (any browser or device can continue), clicked once.
  await clickOnce(page, page.getByRole('button', { name: 'Save for later' }));
  await expect(page.getByRole('heading', { name: 'Review detected layers' })).toBeVisible({ timeout: 60_000 });
  await expect(layerRow(page, 'Woman with phone')).toContainText('Combined');
  await expect(layerRow(page, /^PRO$/)).toHaveCount(1);
  await expect(layerRow(page, removable)).toContainText('Removed');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  expect(errors).toEqual([]);
});

async function paint(page: Page, tool: 'Add area' | 'Remove area', from: [number, number], to: [number, number]) {
  await page.getByRole('button', { name: tool }).click();
  const stage = page.locator('.paint-stage');
  await stage.evaluate(el => el.scrollIntoView({ block: 'center' }));
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 6 }); await page.mouse.up();
}

test('continue → refine selection with the brush and AI refine → check edges → ready → open in editor', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await openWorkspace(page);
  await resume(page, 'Review detected layers');
  const before = fakeCalls().length;
  await clickOnce(page, page.getByRole('button', { name: 'Continue' }));
  await expect(page.getByRole('heading', { name: 'Preparing your design…' })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: `${shots}/04-processing-after-review.png` });

  // Refine selection: only image layers are refined; plain-language status.
  await expect(page.getByRole('heading', { name: 'Refine selection' })).toBeVisible({ timeout: 60_000 });
  expect(fakeCalls().slice(before).every(c => c.model === 'sam3')).toBe(true);
  await expect(page.locator('.ws-layer-name')).toHaveText(['Woman with phone']);
  await expect(page.getByRole('button', { name: 'Add area' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove area' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add area' })).toHaveAttribute('title', 'Paint over parts that should be included.');
  await expect(page.getByRole('button', { name: 'Remove area' })).toHaveAttribute('title', 'Paint over areas that should not be included.');
  await expect(page.getByRole('button', { name: 'AI refine' })).toHaveAttribute('title', 'Let AI clean the selection boundary and recover missed details.');
  await expect(page.locator('.ws-status-card')).toBeVisible();
  await expectPlainLanguage(page);
  await page.screenshot({ animations: 'disabled', path: `${shots}/05-refine.png` });

  // "Save my changes" is unavailable until something is painted; saving applies the brush without AI.
  await expect(page.getByRole('button', { name: 'Save my changes' })).toBeDisabled();
  await paint(page, 'Remove area', [0.22, 0.42], [0.3, 0.46]);
  await expect(page.locator('.ws-layer')).toContainText('Unsaved edits');
  const beforeSave = fakeCalls().length;
  await clickOnce(page, page.getByRole('button', { name: 'Save my changes' }));
  await expect(page.getByRole('heading', { name: 'Refine selection' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.ws-status-card')).toContainText('You edited this selection');
  expect(fakeCalls().length, 'saving painted changes never calls AI').toBe(beforeSave);

  // AI refine uses painted areas as hints: exactly one AI request.
  await paint(page, 'Add area', [0.5, 0.5], [0.55, 0.55]);
  await expect(page.getByText('AI will use your painted areas as hints.')).toBeVisible();
  const beforeRefine = fakeCalls().length;
  await clickOnce(page, page.getByRole('button', { name: 'AI refine' }));
  await expect(page.getByRole('heading', { name: 'Refine selection' })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => fakeCalls().slice(beforeRefine).filter(c => c.model === 'sam3' && c.points > 0).length).toBe(1);
  await expect(page.locator('.ws-status-card')).not.toContainText('You edited this selection');
  await page.screenshot({ animations: 'disabled', path: `${shots}/05b-refine-after-ai.png` });

  // Looks good → edge check.
  await clickOnce(page, page.getByRole('button', { name: 'Looks good' }));
  await expect(page.getByRole('heading', { name: 'Check the edges' })).toBeVisible({ timeout: 60_000 });
  await expectPlainLanguage(page);
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('.ws-surface-dark')).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: `${shots}/06-edges.png` });
  // Unsaved edge edits block "Looks good" until saved.
  await paint(page, 'Remove area', [0.3, 0.3], [0.32, 0.31]);
  await expect(page.getByRole('button', { name: 'Looks good' })).toBeDisabled();
  await expect(page.locator('.ws-footer-status')).toHaveText('Save your edge changes before continuing.');
  await clickOnce(page, page.getByRole('button', { name: 'Save my changes' }));
  await expect(page.getByRole('heading', { name: 'Check the edges' })).toBeVisible({ timeout: 60_000 });
  await clickOnce(page, page.getByRole('button', { name: 'Looks good' }));

  // Ready.
  await expect(page.getByRole('heading', { name: 'Your editable design is ready' })).toBeVisible({ timeout: 60_000 });
  const stats = page.locator('.ws-ready-stats');
  await expect(stats).toContainText('editable layers'); await expect(stats).toContainText('background');
  await expectPlainLanguage(page);
  await page.getByRole('button', { name: 'Review layers' }).click();
  await expect(page.getByRole('list', { name: 'Layers in your design' })).toContainText('Woman with phone');
  await page.screenshot({ animations: 'disabled', path: `${shots}/07-ready.png` });
  await page.getByRole('button', { name: 'Open in editor' }).click();
  await expect(workspace(page)).toBeHidden();

  // Editor: the layers panel, image transform, shape styling and text conversion.
  const layers = page.locator('section[aria-label="Layers"]');
  await expect(layers).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ animations: 'disabled', path: `${shots}/08-editor.png` });
  await layers.locator('.layer-select').filter({ hasText: 'Woman with phone' }).click();
  const inspector = page.locator('.layer-inspector');
  const x = Number(await inspector.getByLabel('X').inputValue());
  await inspector.getByLabel('X').fill(String(x + 120));
  await inspector.getByLabel('Rotation').fill('-6');
  await page.waitForTimeout(300);
  await page.screenshot({ animations: 'disabled', path: `${shots}/08b-editor-moved-layer.png` });
  const text = layers.locator('.layer-select').filter({ hasText: /^PRO/ });
  await text.click();
  await inspector.getByRole('button', { name: 'Make text editable' }).click();
  await expect(page.getByLabel('Text content')).toBeVisible();
  await page.getByLabel('Text content').fill('PRO MAX');
  await page.waitForTimeout(300);
  await page.screenshot({ animations: 'disabled', path: `${shots}/08c-editor-text.png` });
  expect(errors).toEqual([]);
});
