import { expect, test, type Locator, type Page } from '@playwright/test';

const shots = 'artifacts/decomposition/e2e/proposal-review';
const review = (page: Page) => page.locator('section[aria-label="Proposal review"]');
const jobStatus = (page: Page) => page.locator('section[aria-label="Decomposition job"] > .decomp-row > span');
const targetButton = (page: Page, label: RegExp) => review(page).locator('.decomp-row > button').filter({ hasText: label });

async function openSeededJob(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Decompose image' }).click();
  const dialog = page.getByRole('dialog', { name: 'Image decomposition' });
  await dialog.locator('summary', { hasText: 'Recover jobs' }).click();
  await dialog.getByRole('button', { name: /needs_review · phase 3/ }).first().click();
  await expect(review(page).getByRole('heading', { name: 'Review discovered layers' })).toBeVisible();
}

/** Submit a review once and wait until the worker has processed it and the gate is shown again. */
async function saveAndWait(page: Page, button: Locator) {
  const response = page.waitForResponse(r => r.url().includes('/review') && r.request().method() === 'POST');
  await button.click();
  expect((await response).ok()).toBe(true);
  await expect(jobStatus(page)).toContainText('needs review', { timeout: 60_000 });
  await expect(review(page)).toBeVisible();
}

async function imageBox(page: Page) {
  const image = review(page).locator('.decomp-review-image');
  // Raw mouse input does not scroll; bring the whole correction image into the viewport first.
  await image.evaluate(el => el.scrollIntoView({ block: 'center' }));
  const box = await image.boundingBox();
  if (!box) throw new Error('Correction image is not visible.');
  return box;
}

test('proposal review: names, previews, grouping, corrections, persistence, split and background rules', async ({ page }) => {
  const reviewPosts: string[] = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/review')) reviewPosts.push(r.url()); });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));

  await openSeededJob(page);
  const { jobs } = await (await page.request.get('/api/decomposition/jobs')).json() as { jobs: { id: string; proposalTargets: { label: string; description?: string; baseLayer?: boolean }[] }[] };
  const targets = jobs[0].proposalTargets;
  const person = targets.find(t => /woman|person/i.test(t.label))!;
  const phone = targets.find(t => /phone/i.test(t.label) && !/woman|person/i.test(t.label))!;
  const headline = targets.find(t => /pro|headline/i.test(t.label) && t !== person && t !== phone)!;
  const panel = targets.find(t => /panel/i.test(t.label))!;
  const background = targets.find(t => t.baseLayer)!;
  expect([person, phone, headline, panel, background].every(Boolean)).toBe(true);

  // Names and descriptions render; previews load; Advanced inspection is closed by default.
  await expect(review(page).getByRole('heading', { name: 'Discovered elements' })).toBeVisible();
  for (const t of [person, phone, headline, panel]) {
    await expect(review(page).locator('article strong', { hasText: t.label }).first()).toBeVisible();
    if (t.description) await expect(review(page).getByText(t.description).first()).toBeVisible();
  }
  await expect(review(page).getByText('Kept as the background layer. It is not sent to source segmentation.')).toBeVisible();
  const previews = review(page).locator('.decomp-layer-grid article > img');
  await expect.poll(async () => previews.evaluateAll(imgs => imgs.every(i => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0))).toBe(true);
  expect(await previews.count()).toBe(targets.length);
  expect(await review(page).locator('details[open]').count()).toBe(0);
  await expect(review(page).getByText(/proposal-\d/).first()).toBeHidden();
  await page.screenshot({ path: `${shots}/01-discovered-elements.png`, fullPage: true });

  // Background: cannot be grouped, typed or given proposals.
  await expect(review(page).getByLabel(`Group ${background.label}`)).toBeDisabled();
  await targetButton(page, new RegExp(`^${background.label} · Background`)).click();
  await expect(review(page).getByLabel('Element type')).toBeDisabled();
  await expect(review(page).getByRole('button', { name: 'Add to selected target' }).first()).toBeDisabled();

  // Rename + text type, shape type, reject (exclude) one element.
  await targetButton(page, new RegExp(`^${headline.label} ·`)).click();
  await review(page).getByLabel('Target name').fill('PRO');
  await review(page).getByLabel('Element type').selectOption('text');
  await review(page).getByRole('button', { name: 'Approve target' }).click();
  await targetButton(page, new RegExp(`^${panel.label} ·`)).click();
  await review(page).getByLabel('Element type').selectOption('shape');
  await review(page).getByRole('button', { name: 'Reject target' }).click();

  // Group person + phone, rename, approve (include).
  await review(page).getByLabel(`Group ${person.label}`).check();
  await review(page).getByLabel(`Group ${phone.label}`).check();
  await review(page).getByRole('button', { name: 'Group selected targets' }).click();
  await review(page).getByLabel('Target name').fill('woman_with_phone');
  await review(page).getByLabel('Element type').selectOption('object');
  await review(page).getByRole('button', { name: 'Approve target' }).click();

  // Corrections on the group: positive + negative points, add brush, bounding box.
  // Choosing a tool can scroll the page, so the image is measured after every tool change.
  const tool = async (value: string) => { await review(page).getByLabel('Correction').selectOption(value); return imageBox(page); };
  let box = await tool('positive');
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.45);
  box = await tool('negative');

  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.1);
  box = await tool('add');
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.65, { steps: 5 }); await page.mouse.up();
  box = await tool('box');
  await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.12);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.85, { steps: 5 }); await page.mouse.up();
  await expect(review(page).getByText('Saved on this target: 1 positive / 1 negative points.')).toBeVisible();
  await expect(review(page).locator('.decomp-review-image svg rect')).toHaveCount(1);
  await page.screenshot({ path: `${shots}/02-grouped-with-corrections.png`, fullPage: true });
  await review(page).locator('.decomp-review-image').screenshot({ path: `${shots}/02b-corrections-canvas.png` });

  // Double-clicking save submits exactly once.
  const before = reviewPosts.length;
  const save = review(page).getByRole('button', { name: 'Save proposal review (no AI)' });
  const response = page.waitForResponse(r => r.url().includes('/review') && r.request().method() === 'POST');
  await save.dblclick();
  expect((await response).ok()).toBe(true);
  await expect(jobStatus(page)).toContainText('needs review', { timeout: 60_000 });
  expect(reviewPosts.length - before).toBe(1);

  // Reload and resume: everything is restored from the server.
  await page.reload();
  await openSeededJob(page);
  await expect(targetButton(page, /^woman_with_phone · object · Approved$/)).toBeVisible();
  await expect(targetButton(page, /^PRO · text · Approved$/)).toBeVisible();
  await expect(targetButton(page, new RegExp(`^${panel.label} · shape · Rejected$`))).toBeVisible();
  await expect(targetButton(page, new RegExp(`^${person.label} ·`))).toHaveCount(0);
  await targetButton(page, /^woman_with_phone ·/).click();
  // Brush endpoints are persisted as guidance points (add = positive) and folded into the saved provisional mask.
  await expect(review(page).getByText('Saved on this target: 3 positive / 1 negative points.')).toBeVisible();
  await expect(review(page).locator('.decomp-review-image svg rect')).toHaveCount(1);
  await expect(review(page).getByRole('img', { name: 'Selected ownership mask' })).toBeVisible();
  await page.screenshot({ path: `${shots}/03-after-reload.png`, fullPage: true });
  await review(page).locator('.decomp-review-image').screenshot({ path: `${shots}/03b-saved-provisional-mask.png` });

  // Split the group back into its elements; the split survives another reload.
  await review(page).getByRole('button', { name: 'Keep proposals separate' }).click();
  await expect(targetButton(page, /^woman_with_phone ·/)).toHaveCount(0);
  await saveAndWait(page, review(page).getByRole('button', { name: 'Save proposal review (no AI)' }));
  await page.reload();
  await openSeededJob(page);
  await expect(targetButton(page, new RegExp(`^${person.label} ·`))).toBeVisible();
  await expect(targetButton(page, new RegExp(`^${phone.label} ·`))).toBeVisible();
  await expect(targetButton(page, /^woman_with_phone ·/)).toHaveCount(0);
  const saved = (await (await page.request.get('/api/decomposition/jobs')).json() as { jobs: { proposalTargets: { label: string; provenance?: { operation: string; parentLabel?: string } }[] }[] }).jobs[0].proposalTargets;
  expect(saved.find(t => t.label === person.label)?.provenance).toMatchObject({ operation: 'user-split', parentLabel: 'woman_with_phone' });
  expect(saved.find(t => t.label === 'PRO')?.provenance).toMatchObject({ operation: 'discovered', originalLabel: headline.label });
  await page.screenshot({ path: `${shots}/04-after-split-reload.png`, fullPage: true });
  expect(errors).toEqual([]);
});
