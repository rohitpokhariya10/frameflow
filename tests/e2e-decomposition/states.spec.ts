import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { DecompositionJobSummary } from '@frameflow/shared';

const shots = process.env.DECOMP_E2E_SHOTS ?? 'artifacts/decomposition/ux';
const jobUrl = (id: string) => `/api/decomposition/jobs/${id}`;
const getJob = async (page: Page, id: string): Promise<DecompositionJobSummary> => (await page.request.get(jobUrl(id))).json();
const mutationHeaders = (page: Page) => ({ Origin: new URL(page.url()).origin, 'X-FrameFlow-CSRF': '1' });

async function openFixture(page: Page, name: string) {
  const fixtures = JSON.parse(readFileSync(join(process.env.DECOMP_E2E_DATA!, 'e2e-state-jobs.json'), 'utf8')) as Record<string, string>;
  const id = fixtures[name];
  // Directly opening a saved job avoids competing with this suite's intentionally rate-limited upload journey.
  await page.goto('/');
  await page.getByRole('button', { name: 'Image to layers' }).click();
  await expect(page.getByRole('heading', { name: 'Turn any image into an editable design' })).toBeVisible();
  const row = page.locator(`[data-job-id="${id}"]`);
  await row.getByRole('button', { name: 'Continue', exact: true }).click();
  return getJob(page, id);
}

async function failedUpload(page: Page, name = 'retry') {
  const failed = await openFixture(page, name);
  await expect(page.getByRole('heading', { name: 'The AI service is busy' })).toBeVisible();
  expect(failed.state).toBe('failed');
  expect(failed.retry).toEqual({ available: true, attempt: 0, limit: 1 });
  return failed;
}

test('provider error offers one retry, then recovery without bypassing the server limit', async ({ page }) => {
  const failed = await failedUpload(page);
  await expect(page.getByRole('alert')).toContainText('Nothing you did was lost. Try again in a moment.');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start a new attempt' })).toHaveCount(0);
  await page.screenshot({ animations: 'disabled', path: `${shots}/09-error-retry-available.png` });

  const retry = page.waitForResponse(response => response.url().endsWith(`${jobUrl(failed.id)}/retry`));
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  const accepted = await retry;
  expect(accepted.status()).toBe(200);
  expect((await accepted.json() as DecompositionJobSummary).retry).toEqual({ available: false, reason: 'RETRY_LIMIT', attempt: 1, limit: 1 });
  await expect(page.getByRole('heading', { name: 'This attempt can’t be retried' })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start a new attempt' })).toBeEnabled();
  await expect(page.getByRole('alert')).toContainText('Your previous attempt stays in Recent designs.');
  await page.screenshot({ animations: 'disabled', path: `${shots}/10-retry-exhausted.png` });

  // This is the real retry route and current revision: the repository must still reject a second explicit retry.
  const exhausted = await getJob(page, failed.id);
  const refused = await page.request.post(`${jobUrl(failed.id)}/retry`, { headers: mutationHeaders(page), data: { expectedRevision: exhausted.revision } });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ error: { code: 'RETRY_LIMIT' } });
  expect(await getJob(page, failed.id)).toMatchObject({ revision: exhausted.revision, retry: exhausted.retry });

  const created = page.waitForResponse(response => response.url().endsWith('/api/decomposition/jobs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start a new attempt' }).click();
  const fresh = await (await created).json() as DecompositionJobSummary;
  expect(fresh.id).not.toBe(failed.id);
  expect(fresh.sourceId).toBe(failed.sourceId);
  expect(fresh.retry?.attempt).toBe(0);
  expect((await getJob(page, failed.id)).retry).toEqual(exhausted.retry);
  await expect(page.getByRole('heading', { name: 'The AI service is busy' })).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Use a different image' }).click();
  await expect(page.getByRole('region', { name: 'Recent designs' }).locator(`[data-job-id="${failed.id}"]`)).toBeVisible();
});

test('stale page receives a real 409 and refreshes to retry exhausted', async ({ page }) => {
  const old = await failedUpload(page, 'stale');
  // Another client uses the one allowed retry while this failed page stays open at the earlier revision.
  const otherClient = await page.request.post(`${jobUrl(old.id)}/retry`, { headers: mutationHeaders(page), data: { expectedRevision: old.revision } });
  expect(otherClient.status()).toBe(200);
  await expect.poll(async () => (await getJob(page, old.id)).state, { timeout: 45_000 }).toBe('failed');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  const refused = page.waitForResponse(response => response.url().endsWith(`${jobUrl(old.id)}/retry`));
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  const conflict = await refused;
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: 'STALE_REVISION' } });
  await expect(page.getByRole('heading', { name: 'This attempt can’t be retried' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start a new attempt' })).toBeEnabled();
  await page.screenshot({ animations: 'disabled', path: `${shots}/11-stale-page-refreshed.png` });
});

test('empty discovery offers manual selection and saves without AI', async ({ page }) => {
  const created = await openFixture(page, 'empty');
  await expect(page.getByRole('heading', { name: 'Review detected layers' })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('status').filter({ hasText: 'AI couldn’t find separate layers' })).toBeVisible();
  expect((await getJob(page, created.id)).proposals).toEqual([]);
  await page.screenshot({ animations: 'disabled', path: `${shots}/12-empty-discovery.png` });
  await page.getByLabel('Layer name').fill('Main subject');
  await page.getByRole('button', { name: 'Adjust area', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Adjust the area of Main subject' })).toBeVisible();
  const stage = (await page.locator('.paint-stage').boundingBox())!;
  await page.mouse.move(stage.x + stage.width * 0.4, stage.y + stage.height * 0.4);
  await page.mouse.down(); await page.mouse.move(stage.x + stage.width * 0.5, stage.y + stage.height * 0.5, { steps: 6 }); await page.mouse.up();
  const calls = () => { const path = join(process.env.DECOMP_E2E_DATA!, 'e2e-fake-calls.log'); return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(line => line.includes(created.id)) : []; };
  const beforeSave = calls();
  await page.getByRole('button', { name: 'Save for later' }).click();
  await expect(page.getByRole('heading', { name: 'Review detected layers' })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByLabel('Layer name')).toHaveValue('Main subject');
  await expect.poll(async () => (await getJob(page, created.id)).proposalTargets?.[0].label).toBe('Main subject');
  expect(calls()).toEqual(beforeSave);
});

test('D. layer limit: up to the allowed count go to the editor, only extra editor picks are blocked, and no detected layer is lost', async ({ page }) => {
  const created = await openFixture(page, 'limit');
  await expect(page.getByRole('heading', { name: 'Review detected layers' })).toBeVisible();
  const limit = created.options.maxObjects, detected = created.proposalTargets!.filter(t => !t.baseLayer).length;
  expect(detected).toBeGreaterThan(limit);
  const added = page.locator('.ws-layer[data-choice="add"]'), later = page.locator('.ws-layer[data-choice="later"]');
  // Nothing is blocked by default: the first layers fill the limit and the rest are left for later, with a clear message.
  await expect(added).toHaveCount(limit);
  await expect(later).toHaveCount(detected - limit);
  await expect(page.getByTestId('editor-selection-count')).toHaveText(`${limit} of ${limit} selected for the editor · ${detected - limit} left for later`);
  await expect(page.getByText(`You can open up to ${limit} editable layers at once. Others stay here — add them later.`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save for later' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Add a layer' })).toBeEnabled();
  // A further editor pick is blocked (and explained); leaving it for later or removing it are not.
  await later.first().locator('.ws-layer-main').click();
  const add = page.getByRole('radio', { name: 'Add to editor', exact: true });
  await expect(add).toBeDisabled();
  await expect(add).toHaveAttribute('title', `You can open up to ${limit} editable layers at once. Leave another layer for later first.`);
  await expect(page.getByRole('radio', { name: 'Remove', exact: true })).toBeEnabled();
  await page.screenshot({ animations: 'disabled', path: `${shots}/25-layer-limit.png` });
  // Swap: leave one editor layer for later, then add the other.
  const swapIn = (await later.first().locator('.ws-layer-name').innerText()), swapOut = (await added.first().locator('.ws-layer-name').innerText());
  await added.first().locator('.ws-layer-main').click();
  await page.getByRole('radio', { name: 'Leave for later', exact: true }).click();
  await page.locator('.ws-layer').filter({ hasText: swapIn }).first().locator('.ws-layer-main').click();
  await expect(add).toBeEnabled();
  await add.click();
  await expect(added).toHaveCount(limit);
  // A new layer at the limit is left for later rather than refused.
  await page.getByRole('button', { name: 'Add a layer' }).click();
  await expect(page.locator('.ws-layer.is-active')).toHaveAttribute('data-choice', 'later');
  // Saved on the server: every detected layer is still there; nothing was deleted or removed to fit the limit.
  const submitted = page.waitForResponse(response => response.url().endsWith(`${jobUrl(created.id)}/review`));
  await page.getByRole('button', { name: 'Save for later' }).click();
  expect((await submitted).ok()).toBe(true);
  await expect.poll(async () => (await getJob(page, created.id)).state).toBe('needs_review');
  const saved = (await getJob(page, created.id)).proposalTargets!.filter(t => !t.baseLayer);
  expect(saved).toHaveLength(detected + 1);
  expect(saved.filter(t => t.rejected)).toEqual([]);
  expect(saved.filter(t => t.approved).map(t => t.label).sort()).toEqual(created.proposalTargets!.filter(t => !t.baseLayer).slice(0, limit).map(t => t.label).map(l => l === swapOut ? swapIn : l).sort());
});

test('failed layer-limit review preserves choices and accepts a correction without retry or AI', async ({ page }) => {
  const failed = await openFixture(page, 'failed-limit');
  const retryRequests: string[] = [];
  page.on('request', request => { if (request.url().endsWith(`${jobUrl(failed.id)}/retry`)) retryRequests.push(request.url()); });
  const fakeCallsForJob = () => { const path = join(process.env.DECOMP_E2E_DATA!, 'e2e-fake-calls.log'); return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(line => line.includes(failed.id)) : []; };
  const callsBefore = fakeCallsForJob();
  await expect(page.getByRole('heading', { name: 'Review detected layers' })).toBeVisible();
  await expect(page.getByLabel('Layer name')).toHaveValue('Saved custom name');
  await expect(page.getByRole('radio', { name: 'Shape', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.ws-layer').filter({ hasText: failed.reviewSubmission!.targets![1].label })).toContainText('Removed');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save for later' })).toBeDisabled();
  // Server validation rejects an unchanged over-limit correction synchronously, without consuming revision/attempt.
  const rejected = await page.request.post(`${jobUrl(failed.id)}/review`, { headers: mutationHeaders(page), data: { ...failed.reviewSubmission, expectedRevision: failed.revision } });
  expect(rejected.status()).toBe(409);
  expect(await rejected.json()).toMatchObject({ error: { code: 'TARGET_LIMIT' } });
  expect((await getJob(page, failed.id)).revision).toBe(failed.revision);
  const kept = page.locator('.ws-layer[data-choice="add"]');
  await expect(page.locator('.ws-footer-status')).toContainText(`You can open up to ${failed.options.maxObjects} editable layers at once.`);
  while (await kept.count() > failed.options.maxObjects) {
    await kept.last().locator('.ws-layer-main').click();
    await page.getByRole('radio', { name: 'Leave for later', exact: true }).click();
  }
  await page.screenshot({ animations: 'disabled', path: `${shots}/14-failed-layer-limit-corrected.png` });
  const submitted = page.waitForResponse(response => response.url().endsWith(`${jobUrl(failed.id)}/review`));
  await page.getByRole('button', { name: 'Save for later' }).click();
  expect((await submitted).ok()).toBe(true);
  await expect.poll(async () => (await getJob(page, failed.id)).state).toBe('needs_review');
  const saved = await getJob(page, failed.id);
  expect(saved.retry?.attempt).toBe(1);
  expect(saved.callsUsed).toBe(failed.callsUsed);
  expect(fakeCallsForJob()).toEqual(callsBefore);
  expect(retryRequests).toEqual([]);
  expect(saved.proposalTargets?.[0]).toMatchObject({ label: 'Saved custom name', role: 'shape' });
  expect(saved.proposalTargets?.[1]).toMatchObject({ approved: false, rejected: true });
  // Continue the recovered job with editable shapes/text only: completing this path must require no inference.
  await expect(page.getByRole('heading', { name: 'Review detected layers' })).toBeVisible({ timeout: 15_000 });
  await kept.nth(1).locator('.ws-layer-main').click();
  await page.getByRole('radio', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your editable design is ready' })).toBeVisible({ timeout: 45_000 });
  const completed = await getJob(page, failed.id);
  expect(completed.state).toBe('completed');
  expect(completed.retry?.attempt).toBe(1);
  expect(completed.callsUsed).toBe(failed.callsUsed);
  expect(fakeCallsForJob()).toEqual(callsBefore);
  expect(retryRequests).toEqual([]);
  await page.screenshot({ animations: 'disabled', path: `${shots}/14b-recovered-without-ai.png` });
});

test('narrow workspace stacks panes and keeps manual editing and actions reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await openFixture(page, 'narrow');
  await expect(page.getByRole('heading', { name: 'Review detected layers' })).toBeVisible({ timeout: 45_000 });
  const dialog = page.getByRole('dialog');
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.locator('.ws-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const list = (await page.getByRole('complementary', { name: 'Detected layers' }).boundingBox())!;
  const preview = (await page.getByRole('region', { name: 'Design preview' }).boundingBox())!;
  const inspector = (await page.getByRole('complementary', { name: 'Layer settings' }).boundingBox())!;
  expect(preview.y).toBeGreaterThanOrEqual(list.y + list.height - 1);
  expect(inspector.y).toBeGreaterThanOrEqual(preview.y + preview.height - 1);
  await page.screenshot({ animations: 'disabled', path: `${shots}/13-narrow-review.png` });
  await page.getByRole('button', { name: 'Add a layer' }).click();
  await page.getByLabel('Layer name').fill('Hand-drawn detail');
  await page.getByRole('button', { name: 'Remove area', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove area', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Save for later' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Save for later' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeInViewport();
  expect(await page.locator('.ws-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: `${shots}/13b-narrow-controls.png` });
  await page.getByRole('button', { name: 'Save for later' }).click();
  await expect(page.getByRole('heading', { name: 'Review detected layers' })).toBeVisible({ timeout: 45_000 });
  expect(errors).toEqual([]);
});
