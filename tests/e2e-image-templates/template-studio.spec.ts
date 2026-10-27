import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Stage } from 'konva/lib/Stage';
import type { Text } from 'konva/lib/shapes/Text';
import { fixture, ownImage, runOf } from './wizard.helpers';

test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` } });

// The client journey on the offline fixture: Template Studio (MOCKED OpenAI answers, synthetic images) → FrameFlow's own
// decomposition (fake planner and Seedream) → the editor. Nothing leaves this machine; no image shown is a real generation.
type StudioCall = { kind: string; schemaName?: string; system?: string; prompt?: string; images?: number; fidelityMode?: string };
const studioCalls = async (request: APIRequestContext) => (await (await request.get('/__test__/studio-calls')).json()) as StudioCall[];
const upload = (name: string, buffer: Buffer) => ({ name, mimeType: 'image/png', buffer });

async function openStudio(page: Page) {
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Template Studio', exact: true }).click();
  return panel;
}

test('create a template, generate a Match Reference image, decompose it with FrameFlow and edit it', async ({ page, request }) => {
  test.setTimeout(180_000);
  // This journey's own brand kit with an approved logo (synthetic), made through the API.
  const kitName = `Journey Brand ${crypto.randomUUID().slice(0, 6)}`;
  const kit = (await (await request.post('/api/template-studio/brand-kits', { data: { name: kitName, rules: await (await request.get('/__test__/studio-brand-rules')).json() } })).json()).kit;
  const logo = (await (await request.post('/api/template-studio/assets', { multipart: { role: 'logo', label: 'Journey logo', file: { name: 'logo.png', mimeType: 'image/png', buffer: await fixture(request, '/__test__/studio-logo.png') } } })).json()).asset;
  expect((await request.post(`/api/template-studio/brand-kits/${kit.id}/logos`, { data: { assetId: logo.id, kind: 'primary', name: 'Journey logo · navy', colourName: 'Studio Navy' } })).ok()).toBe(true);
  const panel = await openStudio(page);
  const name = `Blue studio ${crypto.randomUUID().slice(0, 6)}`;
  // The decomposition tabs are FrameFlow's own, beside the studio.
  // The client sees five tabs: Template Studio in the place of the earlier wizard, the decomposition tabs as they were, and Protected Templates.
  await expect(panel.getByRole('tablist', { name: 'Test sections' }).getByRole('tab')).toHaveText(['Overview', 'Offer Templates', 'Template Studio', 'Decompose/Test', 'Protected Templates', /^Saved Runs/]);

  // Scene 1: create a template from a reference poster (Create Template asks for the type first: Product + Text).
  await panel.getByRole('tab', { name: 'Create Template', exact: true }).click();
  await panel.getByRole('button', { name: /Product \+ Text/ }).click();
  await expect(panel.getByText('AI style analysis: up to')).toBeVisible();
  await panel.getByLabel('Upload reference posters').setInputFiles(upload('blue-studio.png', await ownImage(await fixture(request, '/__test__/studio-reference.png'))));
  await expect(panel.getByRole('list', { name: 'reference posters library' }).getByRole('button', { pressed: true })).toHaveCount(1);
  await panel.getByRole('button', { name: /Create template & analyse/ }).click();
  await expect(panel.getByText('Give the template a name.')).toBeVisible();
  await panel.getByLabel('Template name').fill(name);
  await panel.getByLabel('Brand kit (optional)').selectOption({ label: kitName });
  await panel.getByRole('button', { name: /Create template & analyse/ }).click();
  await expect(panel.getByText('Template saved.')).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole('heading', { name: 'What the AI learned about this design' })).toBeVisible();
  await expect(panel.getByText('Blue studio backdrop').first()).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Always keep (Match Reference holds these)' })).toBeVisible();

  // Scene 2: the template library.
  await panel.getByRole('tab', { name: 'Templates', exact: true }).click();
  const card = panel.locator('.ts-template-card').filter({ hasText: name });
  await expect(card.getByText('Ready')).toBeVisible();
  await card.getByRole('button', { name: 'Generate image' }).click();

  // Scene 3: generate an image, Match Reference by default, with the cost shown before the click.
  await expect(panel.getByRole('tab', { name: 'Generate Image', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('radio', { name: new RegExp(name) })).toBeChecked();
  await expect(panel.getByRole('radio', { name: /Match Reference/ })).toBeChecked();
  await expect(panel.getByRole('radio', { name: /^4:5/ })).toBeChecked();
  await panel.getByLabel('Upload product photos').setInputFiles(upload('mixer.png', await ownImage(await fixture(request, '/__test__/studio-product.png'))));
  const productName = `Mixer Pro ${crypto.randomUUID().slice(0, 6)}`;
  await panel.getByLabel('Product 1 (hero) name').fill(productName);
  await panel.getByRole('textbox', { name: 'Headline', exact: true }).fill('Upgrade your kitchen');
  await panel.getByRole('textbox', { name: 'Offer / price', exact: true }).fill('No-cost EMI from ₹1,999/month');
  await expect(panel.getByText(/Estimated cost: up to ₹/)).toBeVisible();
  const breakdown = panel.getByRole('table').filter({ hasText: 'Estimated total' });
  await expect(breakdown.getByRole('row')).toHaveCount(8);
  await expect(breakdown.getByText('Reference / template analysis')).toBeVisible();
  await expect(breakdown.getByText('cached · no new call')).toBeVisible();
  await panel.getByRole('button', { name: 'Generate image', exact: true }).click();

  // Scene 4: the generated image, its review and its recorded cost.
  await expect(panel.getByRole('heading', { name: /Upgrade your kitchen/ })).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText('Review passed')).toBeVisible();
  const reference = panel.locator('.ts-checks li').filter({ hasText: 'Reference-style similarity' });
  await expect(reference).toContainText('Passed');
  await expect(reference).toContainText('Match Reference score 5/5');
  const cost = panel.getByRole('table').filter({ hasText: 'paid calls' });
  await expect(cost.getByText('Image generation')).toBeVisible();
  await expect(cost.getByText('Calculated from provider usage').first()).toBeVisible();
  // The image model was told to rebuild the reference's scene, never to treat it as loose inspiration.
  // This journey's own image request (the product name is unique to it), exactly one: never repeated by itself.
  const images = (await studioCalls(request)).filter(c => c.kind === 'image' && c.prompt?.includes(`SUBJECT IDENTITY for "${productName}"`));
  expect(images).toHaveLength(1);
  const prompt = images[0].prompt!;
  expect(prompt).toContain('STYLE AND SCENE REFERENCE');
  expect(prompt).toContain('KEEP FROM THE STYLE REFERENCE');
  expect(prompt).not.toContain('look and feel only');
  expect(prompt).not.toContain('loose inspiration');

  // Scene 5: approve, then hand the text-free scene to FrameFlow's existing decomposition.
  await panel.getByRole('button', { name: 'Approve this image' }).click();
  await panel.getByRole('button', { name: 'Decompose Image into Editable Layers' }).click();
  await expect(panel.getByText(/Start FrameFlow decomposition\?/)).toBeVisible();
  const [started] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/layerize-experiment/runs' && r.request().method() === 'POST'), panel.getByRole('button', { name: 'Start decomposition (paid)' }).click()]);
  const runId = (await started.json()).id as string;
  await expect(panel.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  const workflow = panel.getByRole('region', { name: 'Workflow cost' });
  await expect(workflow.getByText('FROM TEMPLATE STUDIO')).toBeVisible();
  await expect(workflow.getByRole('row', { name: /Image generation/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Open in editor' })).toBeEnabled({ timeout: 60_000 });
  await expect(workflow.getByRole('row', { name: /This image: generation \+ decomposition/ })).toContainText('₹');
  const run = await runOf(request, runId);
  expect(run.stage).toBe('done');
  // FrameFlow decomposed exactly the generated text-free scene: 1024×1280 for 4:5.
  expect([run.original.width, run.original.height]).toEqual([1024, 1280]);

  // Scene 6: the layers open in FrameFlow's editor, with the copy restored as native text and the logo-free design.
  await panel.getByRole('button', { name: 'Open in editor' }).click();
  await expect(panel).toBeHidden();
  // FrameFlow's decomposed layers, unchanged, with the approved logo lock-up added on top as one image layer.
  const layerNames = page.getByRole('list', { name: 'Design layers' }).locator('.layer-name');
  await expect(layerNames).toHaveCount(run.editorLayerFiles.length + 1);
  await expect(layerNames.first()).toHaveText('Brand logo (from brand kit)');
  const texts = await page.evaluate(() => (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0].find<Text>('.editable-text').map(node => node.text()));
  expect(texts).toEqual(expect.arrayContaining(['Upgrade your kitchen', 'No-cost EMI from ₹1,999/month']));
});

test('an unrelated scene in Match mode is reported, not regenerated', async ({ page, request }) => {
  test.setTimeout(120_000);
  // The fake reviewer scores copy containing "Drift check" as an unrelated scene (2/5).
  {
    const panel = await openStudio(page);
    await panel.getByRole('tab', { name: 'Create Template', exact: true }).click();
    await panel.getByRole('button', { name: /Product \+ Text/ }).click();
    await panel.getByLabel('Upload reference posters').setInputFiles(upload('drift.png', await ownImage(await fixture(request, '/__test__/studio-reference.png'))));
    await panel.getByLabel('Template name').fill(`Drift ${crypto.randomUUID().slice(0, 6)}`);
    await panel.getByRole('button', { name: /Create template & analyse/ }).click();
    await expect(panel.getByText('Template saved.')).toBeVisible({ timeout: 30_000 });
    await panel.getByRole('button', { name: /Generate image/ }).first().click();
    const headline = `Drift check ${crypto.randomUUID().slice(0, 6)}`;
    await panel.getByRole('textbox', { name: 'Headline', exact: true }).fill(headline);
    await panel.getByRole('button', { name: 'Generate image', exact: true }).click();
    await expect(panel.getByText('Needs review').first()).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByText(/does not match the template \(Match Reference, score 2\/5\)/).first()).toBeVisible();
    await expect(panel.locator('.ts-checks li').filter({ hasText: 'Reference-style similarity' })).toContainText('Problem');
    // Approving a flagged image needs an explicit acknowledgement; nothing is regenerated by itself.
    await expect(panel.getByRole('button', { name: 'Approve this image' })).toBeDisabled();
    const history = (await (await request.get('/api/template-studio/posters')).json()).items as { kind: string; headline: string | null }[];
    expect(history.filter(i => i.kind === 'generate_poster' && i.headline === headline)).toHaveLength(1);
  }
});

test('every Template Studio section opens, and the decomposition tabs keep their content', async ({ page }) => {
  const panel = await openStudio(page);
  for (const [tab, heading] of [['Templates', 'Templates'], ['Create Template', 'What kind of template is it?'], ['Generate Image', 'Generate image'], ['Generation History', 'Generation history'], ['Assets', 'Assets'], ['Brand Kits', 'Brand kits'], ['Setup & Usage', 'Setup & usage']] as const) {
    await panel.getByRole('tab', { name: tab, exact: true }).click();
    await expect(panel.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await expect(panel.getByText('Generation worker')).toBeVisible();
  await panel.getByRole('tab', { name: 'Decompose/Test', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Decompose an image' })).toBeVisible();
  await panel.getByRole('tab', { name: 'Saved Runs', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Saved runs' })).toBeVisible();
});
