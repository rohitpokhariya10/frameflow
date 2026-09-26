// Focused built-client review interaction check. All decomposition HTTP is mocked; no inference.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const candidates = Array.from({ length: 6 }, (_, i) => ({ id: `candidate-${i + 1}`, label: `Object ${i + 1}`, maskArtifactId: `mask-${i}`, selected: true, warnings: [], statistics: { area: 100, areaFraction: i === 5 ? 0.345 : 0.01 } }));
  candidates.push({ id: 'semantic-proposal-1', label: 'Proposal group proposal-1', source: 'synthesized', proposalId: 'proposal-1', sourceCandidateIds: ['candidate-1', 'candidate-2'], maskArtifactId: 'group-mask', selected: false, warnings: [], statistics: { area: 300, areaFraction: 0.45 } });
  let job = { id: 'review-ui-fixture', sourceId: 'source', state: 'needs_review', phase: 4, revision: 14, options: {}, warnings: [], artifacts: [], callsUsed: 2, sourcePreviewArtifactId: 'source', sourceWidth: 256, sourceHeight: 256, candidates, review: { message: 'Overlapping candidates', actions: ['accept-masks'] }, reviewSubmission: { objects: candidates.map(c => ({ id: c.id, candidateId: c.id, label: c.label, selected: true, points: [], strokes: [] })) } };
  let requests = 0, fail = true;
  await page.route('**/api/decomposition/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body;
    if (path.endsWith('/capabilities')) body = { enabled: true, configured: true, authenticated: true, providerMode: 'live', limits: { maxObjects: 6, retentionDays: 7 } };
    else if (path.endsWith('/review')) {
      requests++;
      const payload = route.request().postDataJSON();
      assert.equal(payload.expectedRevision, 14);
      assert.equal(payload.action, 'accept-masks');
      assert.deepEqual(payload.objects.filter(o => o.selected).map(o => [o.candidateId, o.label]), [['candidate-6', 'person']]);
      assert.deepEqual(payload.objects.find(o => o.selected).points.map(p => p.label), [1, 0]);
      await new Promise(resolve => setTimeout(resolve, 300));
      if (fail) return route.fulfill({ status: 409, json: { error: { message: 'Review changed. Reload the latest masks before applying corrections.' } } });
      job = { ...job, state: 'running', phase: 4, revision: 15, progress: 'Phase 5 of 6 — Checking selected masks and refining edges' };
      body = job;
    } else if (path.endsWith('/jobs')) body = { jobs: [job] };
    else if (path.includes('/artifacts/')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="white"/></svg>' });
    else body = job;
    await route.fulfill({ json: body });
  });
  await page.goto(process.env.FRAMEFLOW_TEST_URL || 'http://localhost:3001');
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: 'Decompose', exact: true }).click();
  await page.getByText('Recover jobs (1)', { exact: true }).click();
  await page.getByRole('button', { name: /review-u/ }).click();
  const review = page.getByRole('region', { name: 'Mask review' });
  await review.locator('select').nth(0).selectOption('semantic-proposal-1');
  await review.getByRole('button', { name: 'Use only this candidate' }).click();
  assert.match(await review.innerText(), /Included \(1\): Proposal group proposal-1 \(semantic-proposal-1\)/);
  assert.match(await review.innerText(), /Synthesized from candidate-1, candidate-2; Qwen proposal-1/);
  await review.locator('select').nth(0).selectOption('candidate-6');
  await page.getByRole('button', { name: 'Use only this candidate' }).click();
  await page.getByLabel('Name', { exact: true }).fill('person');
  const image = page.locator('.decomp-review-image');
  await image.click({ position: { x: 40, y: 40 } });
  await page.getByRole('region', { name: 'Mask review' }).locator('select').nth(1).selectOption('negative');
  await image.click({ position: { x: 5, y: 5 } });
  const confirm = page.getByRole('button', { name: 'Confirm visible masks', exact: true });
  // Two synchronous clicks exercise the lock before React can render disabled.
  await confirm.evaluate(button => { button.click(); button.click(); });
  await page.getByRole('button', { name: 'Submitting review…' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Submitting review…' }).isDisabled(), true);
  await page.getByRole('alert').filter({ hasText: 'Review changed' }).waitFor();
  assert.equal(requests, 1);
  fail = false;
  await confirm.click();
  await page.getByRole('heading', { name: /Phase 5 of 6 — Checking/ }).waitFor();
  assert.equal(requests, 2);
  console.log('PASS: candidate-6 payload, per-object points, inline 409, submitting state, duplicate suppression, running Phase 5 response. No paid calls.');
} finally { await browser.close(); }
