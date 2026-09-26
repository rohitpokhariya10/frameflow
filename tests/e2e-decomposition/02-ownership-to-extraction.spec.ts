import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

const shots = 'artifacts/decomposition/e2e/ownership';
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Image decomposition' });
const proposalReview = (page: Page) => page.locator('section[aria-label="Proposal review"]');
const maskReview = (page: Page) => page.locator('section[aria-label="Mask review"]');
const alphaReview = (page: Page) => page.locator('section[aria-label="Final alpha review"]');
const jobStatus = (page: Page) => page.locator('section[aria-label="Decomposition job"] > .decomp-row > span');
type FakeCall = { model: string; prompt?: string; points: number; box: boolean };
const fakeCalls = (): FakeCall[] => { const file = join(process.env.DECOMP_E2E_DATA!, 'e2e-fake-calls.log'); return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as FakeCall) : []; };
type Job = { id: string; state: string; phase: number; sourceWidth: number; sourceHeight: number; candidates?: { id: string; label: string; qualityTier?: string; qualityChecks?: { code: string }[]; statistics?: { areaFraction: number }; revisionId?: string }[]; refined?: { id: string; revisionId: string; maskRevisionId: string; alphaRevisionId: string; overlayRevisionId: string }[]; artifacts: { relativePath: string; width: number; height: number }[]; proposalTargets?: { id: string; label: string; approved: boolean; baseLayer?: boolean }[] };
const job = async (page: Page) => ((await (await page.request.get('/api/decomposition/jobs')).json()) as { jobs: Job[] }).jobs[0];

async function openJob(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Decompose image' }).click();
  await dialog(page).locator('summary', { hasText: 'Recover jobs' }).click();
  await dialog(page).getByRole('button', { name: /needs_review · phase/ }).first().click();
}
async function submitAndWait(page: Page, button: Locator, state = 'needs review') {
  const response = page.waitForResponse(r => r.url().includes('/review') && r.request().method() === 'POST');
  await button.click();
  expect((await response).ok()).toBe(true);
  await expect(jobStatus(page)).toContainText(state, { timeout: 60_000 });
}
async function canvasBox(section: Locator) {
  const image = section.locator('.decomp-review-image');
  await image.evaluate(el => el.scrollIntoView({ block: 'center' }));
  return (await image.boundingBox())!;
}

test('image objects go to SAM; ownership review, manual and AI corrections, quality status, alpha review and native extraction', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const reviewPosts: string[] = []; page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/review')) reviewPosts.push(r.url()); });
  await openJob(page);
  await expect(proposalReview(page)).toBeVisible();
  const targets = (await job(page)).proposalTargets!;
  const person = targets.find(t => /woman|person/i.test(t.label))!, phone = targets.find(t => /phone/i.test(t.label) && !/woman|person/i.test(t.label))!;
  const button = (label: RegExp) => proposalReview(page).locator('.decomp-row > button').filter({ hasText: label });

  // Group person + phone as one image object; approve the background; everything else keeps its reviewed state.
  await proposalReview(page).getByLabel(`Group ${person.label}`).check();
  await proposalReview(page).getByLabel(`Group ${phone.label}`).check();
  await proposalReview(page).getByRole('button', { name: 'Group selected targets' }).click();
  await proposalReview(page).getByLabel('Target name').fill('woman_with_phone');
  await proposalReview(page).getByRole('button', { name: 'Approve target' }).click();
  await button(/^Background ·/).click();
  await proposalReview(page).getByRole('button', { name: 'Approve target' }).click();
  // Leave only typed elements approved.
  for (const t of (await proposalReview(page).locator('.decomp-row > button').allTextContents()).filter(text => /Type needed · Approved$/.test(text))) {
    await button(new RegExp(`^${t.split(' · ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ·`)).click();
    await proposalReview(page).getByRole('button', { name: 'Reject target' }).click();
  }
  const before = fakeCalls().length;
  await submitAndWait(page, proposalReview(page).getByRole('button', { name: 'Continue to source segmentation' }));

  // SAM handoff: only the image object was segmented (group + two member checks), never text/shape/background.
  await expect(maskReview(page)).toBeVisible();
  const sam = fakeCalls().slice(before);
  expect(sam.every(c => c.model === 'sam3')).toBe(true);
  expect(sam.map(c => c.prompt)).toEqual(['woman with phone', 'woman', 'phone']);
  expect(sam[0].box).toBe(true);
  const options = await maskReview(page).getByLabel('Object').locator('option').allTextContents();
  expect(options).toHaveLength(1); expect(options[0]).toMatch(/^woman_with_phone — /);
  // The tiny high-score index-0 candidate was not chosen; the guided mask was.
  let current = (await job(page)).candidates![0];
  expect(current.qualityTier).not.toBe('FAIL');
  expect(current.statistics!.areaFraction).toBeGreaterThan(0.1);
  await expect(maskReview(page).getByLabel('Ownership status')).toContainText(`Status: ${current.qualityTier}`);
  // Candidate internals stay under Advanced.
  const visible = (await maskReview(page).innerText());
  expect(visible).not.toMatch(/target-|candidate-\d|e2e-fake|sam3/);
  await page.screenshot({ path: `${shots}/01-mask-review.png`, fullPage: true });
  await maskReview(page).locator('.decomp-review-image').screenshot({ path: `${shots}/01b-semantic-mask.png` });

  // Include/exclude: excluding the only object disables confirmation; re-including enables it.
  await maskReview(page).getByLabel('Include this object').uncheck();
  await expect(maskReview(page).getByRole('button', { name: 'Confirm ownership and refine edges' })).toBeDisabled();
  await maskReview(page).getByLabel('Include this object').check();

  // Manual subtract brush: no provider call, new revision, REVIEW status that survives reload.
  await maskReview(page).getByLabel('Correction').selectOption('subtract');
  await maskReview(page).getByLabel('Brush radius (source pixels)').fill('25');
  let box = await canvasBox(maskReview(page));
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.4);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.45, { steps: 5 }); await page.mouse.up();
  const callsBeforeManual = fakeCalls().length, revisionBefore = current.revisionId;
  await submitAndWait(page, maskReview(page).getByRole('button', { name: 'Save manual mask (no AI)' }));
  expect(fakeCalls().length).toBe(callsBeforeManual);
  current = (await job(page)).candidates![0];
  expect(current.revisionId).not.toBe(revisionBefore);
  expect(current.qualityChecks!.map(c => c.code)).toContain('MANUAL_OWNERSHIP');
  await page.reload(); await openJob(page);
  await expect(maskReview(page).getByLabel('Ownership status')).toContainText('Manual edits need visual confirmation');
  // Saved strokes are part of the new revision, not pending edits to re-apply.
  await expect(maskReview(page).locator('.decomp-review-image svg polyline')).toHaveCount(0);
  await maskReview(page).locator('.decomp-review-image').screenshot({ path: `${shots}/02-after-manual-reload.png` });

  // Refine with AI using a negative point: exactly one new SAM request even on a double click; the point is excluded.
  await maskReview(page).getByLabel('Correction').selectOption('negative');
  box = await canvasBox(maskReview(page));
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  const callsBeforeRefine = fakeCalls().length, postsBeforeRefine = reviewPosts.length;
  const response = page.waitForResponse(r => r.url().includes('/review') && r.request().method() === 'POST');
  await maskReview(page).getByRole('button', { name: 'Refine with AI' }).dblclick();
  expect((await response).ok()).toBe(true);
  await expect(jobStatus(page)).toContainText('needs review', { timeout: 60_000 });
  expect(reviewPosts.length - postsBeforeRefine).toBe(1);
  const refineCalls = fakeCalls().slice(callsBeforeRefine);
  expect(refineCalls.filter(c => c.model === 'sam3' && c.points > 0)).toHaveLength(1);
  current = (await job(page)).candidates![0];
  expect(current.qualityChecks!.map(c => c.code)).not.toContain('NEGATIVE_GUIDANCE_LEAK');
  expect(current.qualityChecks!.map(c => c.code)).not.toContain('MANUAL_OWNERSHIP');
  await maskReview(page).locator('.decomp-review-image').screenshot({ path: `${shots}/03-after-guided-refine.png` });

  // Confirm ownership → one constrained BiRefNet call → final alpha review with matching revisions.
  const callsBeforeAlpha = fakeCalls().length;
  await submitAndWait(page, maskReview(page).getByRole('button', { name: 'Confirm ownership and refine edges' }));
  await expect(alphaReview(page)).toBeVisible();
  expect(fakeCalls().slice(callsBeforeAlpha).map(c => c.model)).toEqual(['birefnet']);
  const refined = (await job(page)).refined![0];
  expect(new Set([refined.revisionId, refined.maskRevisionId, refined.alphaRevisionId, refined.overlayRevisionId]).size).toBe(1);
  await expect(alphaReview(page).getByText(`Revision ${refined.revisionId}`)).toBeVisible();
  const trio = alphaReview(page).locator('.decomp-layer-grid img');
  await expect(trio).toHaveCount(3);
  await expect.poll(async () => trio.evaluateAll(imgs => imgs.every(i => (i as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await alphaReview(page).locator('.decomp-layer-grid').screenshot({ path: `${shots}/04-alpha-review-trio.png` });

  // Final review edits: remove an edge strip (no AI), restore the semantic interior (no AI), then go back to semantic
  // correction and re-confirm (one new constrained matte). Every step keeps mask/alpha/overlay on one revision.
  const callsBeforeFinal = fakeCalls().length;
  await alphaReview(page).getByLabel('Correction').selectOption('subtract');
  const alphaBox = await canvasBox(alphaReview(page));
  await page.mouse.move(alphaBox.x + alphaBox.width * 0.3, alphaBox.y + alphaBox.height * 0.3);
  await page.mouse.down(); await page.mouse.move(alphaBox.x + alphaBox.width * 0.35, alphaBox.y + alphaBox.height * 0.32, { steps: 4 }); await page.mouse.up();
  await expect(alphaReview(page).getByRole('button', { name: 'Approve alpha and extract' })).toBeDisabled();
  await submitAndWait(page, alphaReview(page).getByRole('button', { name: 'Save alpha edits (no AI)' }));
  let finalRevision = (await job(page)).refined![0];
  expect(finalRevision.revisionId).not.toBe(refined.revisionId);
  expect(new Set([finalRevision.revisionId, finalRevision.maskRevisionId, finalRevision.alphaRevisionId, finalRevision.overlayRevisionId]).size).toBe(1);
  await alphaReview(page).locator('.decomp-layer-grid').screenshot({ path: `${shots}/04b-alpha-after-edge-edit.png` });
  await submitAndWait(page, alphaReview(page).getByRole('button', { name: 'Restore semantic interior' }));
  expect((await job(page)).refined![0].revisionId).not.toBe(finalRevision.revisionId);
  expect(fakeCalls().length).toBe(callsBeforeFinal);
  await submitAndWait(page, alphaReview(page).getByRole('button', { name: 'Back to semantic correction' }));
  await expect(maskReview(page)).toBeVisible();
  await submitAndWait(page, maskReview(page).getByRole('button', { name: 'Confirm ownership and refine edges' }));
  await expect(alphaReview(page)).toBeVisible();
  expect(fakeCalls().slice(callsBeforeFinal).map(c => c.model)).toEqual(['birefnet']);
  finalRevision = (await job(page)).refined![0];
  await expect(alphaReview(page).getByText(`Revision ${finalRevision.revisionId}`)).toBeVisible();

  // Approve → native-resolution extraction; outputs match the source dimensions.
  await submitAndWait(page, alphaReview(page).getByRole('button', { name: 'Approve alpha and extract' }), 'completed');
  const done = await job(page);
  expect(done.state).toBe('completed'); expect(done.phase).toBe(6);
  const native = done.artifacts.filter(a => /^06-extracted\/object-\d+-native\.png$/.test(a.relativePath));
  expect(native.length).toBeGreaterThan(0);
  for (const a of native) expect([a.width, a.height]).toEqual([done.sourceWidth, done.sourceHeight]);
  await page.screenshot({ path: `${shots}/05-completed.png`, fullPage: true });
  expect(errors).toEqual([]);
});
