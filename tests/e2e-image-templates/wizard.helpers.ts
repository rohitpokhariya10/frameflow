import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/** Shared steps of the Template → Customize → Generate → Decompose wizard, against the offline fixture server. */
export const API = '/api/layerize-experiment';
export const executionOf = async (request: APIRequestContext, id: string) => (await request.get(`${API}/template-executions/${id}`)).json();
export const runOf = async (request: APIRequestContext, id: string) => (await request.get(`${API}/runs/${id}`)).json();
export const fixture = async (request: APIRequestContext, path: string) => (await request.get(path)).body();
/** Image requests whose prompt carries `token`: exact while other specs share the server. */
export const imageCalls = async (request: APIRequestContext, token: string) => ((await (await request.get(`/__test__/image-calls?contains=${encodeURIComponent(token)}`)).json()) as { count: number }).count;

/** The OpenAI + Seedream test panel on its Create Template tab. Nothing leaves this machine. */
export async function openWizard(page: Page): Promise<Locator> {
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Create Template', exact: true }).click();
  return panel;
}
/** Every non-GET request the page makes from now on: everything it could have spent or changed. */
export function writesOf(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', r => { if (r.method() !== 'GET') writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  return writes;
}
/** The execution a wizard click starts, read from its own POST response. */
export async function started(page: Page, request: APIRequestContext, click: () => Promise<void>, path = `${API}/template-executions`) {
  const [response] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === 'POST'), click()]);
  expect(response.status(), await response.text()).toBeLessThan(300);
  return executionOf(request, (await response.json()).id);
}
/** + Create New Template → upload → Create Template & Decompose, until the template is saved (one planner call). */
export async function createTemplate(page: Page, panel: Locator, request: APIRequestContext, file: { name: string; buffer: Buffer }) {
  await panel.getByRole('button', { name: 'Create New Template', exact: true }).first().click();
  await panel.getByLabel('Creative image', { exact: true }).setInputFiles({ ...file, mimeType: 'image/png' });
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  const execution = await started(page, request, () => panel.getByRole('button', { name: 'Create Template & Decompose', exact: true }).click());
  await expect(panel.getByRole('heading', { name: 'Template saved to your library' })).toBeVisible({ timeout: 90_000 });
  return executionOf(request, execution.id);
}
/** From a finished creation: back to the library, the new card selected, then Customize → Generate → Use original image. */
export async function reuseOriginal(page: Page, panel: Locator, request: APIRequestContext, template: { name: string; version: number }) {
  await panel.getByRole('button', { name: 'Back to template library', exact: true }).click();
  await expect(panel.getByRole('button', { name: `Select ${template.name} v${template.version}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  const execution = await started(page, request, () => panel.getByRole('button', { name: 'Use original image', exact: true }).click());
  await expect(panel.getByRole('button', { name: 'Open in Editor', exact: true })).toBeEnabled({ timeout: 90_000 });
  return executionOf(request, execution.id);
}
/** The run dashboard of the wizard's current result (Overview tab). */
export async function runDetails(panel: Locator) {
  await panel.getByRole('button', { name: 'Run details', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(/READY FOR EDITOR|PARTIAL/, { timeout: 30_000 });
}
