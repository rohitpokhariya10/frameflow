import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { fixture, ownImage } from './wizard.helpers';

// Every Template Studio screen with real saved data (made through the API with the offline fixture's MOCKED provider),
// at desktop and phone widths: nothing overflows sideways, and each screen is captured for review.
test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` } });
const API = '/api/template-studio';
const SHOTS = process.env.STUDIO_SCREENSHOTS;

async function settle(request: APIRequestContext, jobId: string) {
  for (let i = 0; i < 300; i++) {
    const job = (await (await request.get(`${API}/jobs/${jobId}`)).json()).job;
    if (job.terminal) return job;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`job ${jobId} did not finish`);
}
async function asset(request: APIRequestContext, path: string, role: string, label: string) {
  const res = await request.post(`${API}/assets`, { multipart: { role, label, file: { name: `${label}.png`, mimeType: 'image/png', buffer: await ownImage(await fixture(request, path)) } } });
  return (await res.json()).asset as { id: string };
}
/** A brand kit with a logo, a ready template and one generated poster: the data the screens show. */
async function seed(request: APIRequestContext) {
  const kit = (await (await request.post(`${API}/brand-kits`, { data: { name: 'Demo Brand', rules: (await (await request.get('/__test__/studio-brand-rules')).json()) } })).json()).kit;
  const logo = await asset(request, '/__test__/studio-logo.png', 'logo', 'Demo Brand logo');
  await request.post(`${API}/brand-kits/${kit.id}/logos`, { data: { assetId: logo.id, kind: 'primary', name: 'Demo Brand · navy', colourName: 'Studio Navy' } });
  const ref = await asset(request, '/__test__/studio-reference.png', 'reference', 'Blue studio ad');
  const created = await (await request.post(`${API}/templates`, { data: { idempotencyKey: crypto.randomUUID(), name: 'Blue studio podiums', brandKitId: kit.id, referenceAssetIds: [ref.id] } })).json();
  await settle(request, created.jobId);
  const product = await asset(request, '/__test__/studio-product.png', 'subject', 'Mixer Pro');
  const started = await (await request.post(`${API}/campaigns`, { data: { idempotencyKey: crypto.randomUUID(), templateId: created.templateId, subjects: [{ assetId: product.id, name: 'Mixer Pro' }],
    copy: { headline: 'Upgrade your kitchen', offer: 'No-cost EMI from ₹1,999/month', cta: 'Visit your nearest store', footer: 'T&C apply.' }, formatId: 'portrait-4-5' } })).json();
  const job = await settle(request, started.jobId);
  return { templateId: created.templateId as string, posterId: job.result.posterId as string };
}
const fits = (panel: Locator) => panel.locator('.ws-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1);
async function shot(page: Page, name: string) { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, animations: 'disabled' }); }

test('every Template Studio screen fits desktop and phone widths with saved data', async ({ page, request }) => {
  test.setTimeout(180_000);
  await seed(request);
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  for (const [width, height, label] of [[1440, 900, 'desktop'], [390, 844, 'mobile']] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
    const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
    await panel.getByRole('tab', { name: 'Template Studio', exact: true }).click();
    const sections = [['Templates', 'Templates'], ['Create Template', 'What kind of template is it?'], ['Generate Image', 'Generate image'], ['Generation History', 'Generation history'], ['Assets', 'Assets'], ['Brand Kits', 'Brand kits'], ['Setup & Usage', 'Setup & usage']] as const;
    for (const [tab, heading] of sections) {
      await panel.getByRole('tab', { name: tab, exact: true }).click();
      await expect(panel.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await fits(panel), `${tab} fits ${label}`).toBe(true);
      await shot(page, `${label}-${tab.replace(/[^a-z]+/gi, '-').toLowerCase()}`);
    }
    // The generated result and the template's learned style.
    await panel.getByRole('tab', { name: 'Generation History', exact: true }).click();
    await panel.getByRole('button', { name: /Open Upgrade your kitchen/ }).first().click();
    await expect(panel.getByRole('heading', { name: 'Review', exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await fits(panel), `result fits ${label}`).toBe(true);
    await shot(page, `${label}-result`);
    await panel.locator('.ts-result-side').scrollIntoViewIfNeeded();
    await shot(page, `${label}-result-review`);
    await panel.getByRole('tab', { name: 'Templates', exact: true }).click();
    await panel.locator('.ts-template-card').filter({ hasText: 'Blue studio podiums' }).first().getByRole('button', { name: 'View style' }).click();
    await expect(panel.getByRole('heading', { name: 'What the AI learned about this design' })).toBeVisible();
    expect(await fits(panel), `template fits ${label}`).toBe(true);
    await shot(page, `${label}-template-style`);
    // The decomposition tabs keep their own layout.
    for (const tab of ['Overview', 'Decompose/Test', 'Saved Runs']) {
      await panel.getByRole('tab', { name: tab, exact: true }).click();
      expect(await fits(panel), `${tab} fits ${label}`).toBe(true);
      await shot(page, `${label}-${tab.replace(/[^a-z]+/gi, '-').toLowerCase()}`);
    }
  }
});
