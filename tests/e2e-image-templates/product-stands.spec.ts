/**
 * Display stands in the browser, on the RECORDED real AI answer for the LG Ganesh creative (FRAMEFLOW_PRODUCT_REFERENCE=1
 * FRAMEFLOW_PRODUCT_RECORDED=1; replayed, no network): prepared, the stands are layers of their own under the products;
 * hiding and dragging products in the try-out shows whole stands; one stand put back into the background (prepared
 * again); the review's own-layer choice; saved; the stands reach a creative, the Run Dashboard and the editor as their own
 * layers; a stand moved in the editor changes the export only where it was and is, and stays moved after a reload. The
 * Prepare step at 390 px has no sideways scrolling.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import type { ProductCreative, ProjectDocument } from '@frameflow/shared';
import type { ProductView } from '../../client/src/features/productTemplates/api';
const API = '/api/layerize-experiment/product-templates', OUT = 'test-results/product-v6/stands-browser';
test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` } });
test.setTimeout(300000);
test.use({ actionTimeout: 20000 });

const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const standsOf = (panel: Locator) => panel.getByRole('region', { name: 'Display stands' });

test('recorded real answer: display stands are layers of their own, checked, corrected and carried to the editor', async ({ page, request }, info) => {
  test.skip(process.env.FRAMEFLOW_PRODUCT_RECORDED !== '1' || info.project.name !== 'desktop', 'Needs the recorded real answer (FRAMEFLOW_PRODUCT_RECORDED=1).');
  mkdirSync(OUT, { recursive: true });
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', r => r.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByRole('tab', { name: 'Offer Templates', exact: true }).click();
  await panel.getByRole('button', { name: 'New product template' }).click();
  await panel.getByLabel('Creative to upload').setInputFiles({ name: 'Ganesh-Chaturthi.png', mimeType: 'image/png', buffer: readFileSync('Ganesh-Chaturthi.png') });
  await expect(panel.getByText('This picture has 4 creatives')).toBeVisible();
  await panel.getByLabel('Template name').fill('LG Ganesh · stands');
  await panel.getByRole('checkbox', { name: /Find characters and products with AI/ }).check();
  const created = page.waitForResponse(r => r.url().endsWith(API) && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Upload and find elements' }).click();
  const id = ((await (await created).json()) as ProductView).template.id;
  await expect(panel.getByRole('heading', { name: 'Here’s what we found' })).toBeVisible({ timeout: 120000 });
  // The answer put the soundbar's box on the speakers below the TV (nothing of it inside: blocking). The reviewer draws it
  // again where it is, under the screen (by numbers): the soundbar becomes a layer of its own, not part of the TV's.
  await panel.getByRole('region', { name: 'Products', exact: true }).getByRole('button', { name: /^Soundbar/ }).click();
  for (const [k, v] of [['width', 66], ['height', 8], ['x', 290], ['y', 345]] as const) await panel.getByRole('complementary', { name: 'Selected element' }).getByLabel(`Box ${k}`).fill(String(v));
  await panel.getByRole('button', { name: 'Save and choose what to decompose' }).click();
  await expect(panel.getByRole('heading', { name: 'Choose what to decompose' })).toBeVisible();
  await panel.getByRole('button', { name: 'Continue to Decomposition' }).click();
  await expect(panel.getByRole('heading', { name: 'Inspect the layers and the background' })).toBeVisible({ timeout: 120000 });

  // Six stands, their own layers, listed with how much of each was continued; the two tall cylinders flagged.
  const stands = standsOf(panel);
  await expect(stands.getByRole('heading', { name: 'Display stands (6)' })).toBeVisible();
  await expect(stands.getByText('Mostly hidden: check it')).toHaveCount(2);
  let view = await (await request.get(`${API}/${id}`)).json() as ProductView;
  const labels = view.product.prepared!.stands!.map(s => s.label);
  // (Named after what stands on each, in the products' front-to-back order: compared as sets.)
  const standing = labels.map(l => l.replace(/^Stand under the /, '').split(/, | and /).sort().join(' + '));
  expect(standing).toEqual(expect.arrayContaining(['Air purifier + Microwave oven', 'Front-load washing machine + Multi-door refrigerator']));
  const mintLabel = labels[standing.indexOf('Front-load washing machine + Multi-door refrigerator')];
  // The pink platform under the television and its speakers (the soundbar, subwoofer and satellites stand on it too).
  const pinkLabel = labels.find(l => /OLED television/.test(l) && /Tower speaker/.test(l))!;
  expect(pinkLabel).toBeTruthy();
  await page.screenshot({ path: `${OUT}/01-prepared-stands.png` });
  await stands.scrollIntoViewIfNeeded(); await stands.screenshot({ path: `${OUT}/01b-stands-list.png` });

  // Every product and Ganesha hidden: the stands stay, whole, on the rebuilt background.
  const layers = panel.locator('.prt-layer-list');
  const things = view.product.objects.filter(o => o.cutout).map(o => o.label);
  for (const label of things) await layers.getByRole('button', { name: label, exact: true }).click();
  const stage = panel.locator('.prt-layers');
  for (const label of labels) await expect(stage.getByRole('img', { name: label, exact: true })).toBeVisible();
  for (const label of things) await expect(stage.getByRole('img', { name: label, exact: true })).toHaveCount(0);
  await stage.screenshot({ path: `${OUT}/02-products-hidden.png` });
  await layers.getByRole('button', { name: 'Put everything back' }).click();
  // The washing machine dragged up: its stand stays where it was.
  await stage.scrollIntoViewIfNeeded();
  await stage.evaluate(el => el.scrollIntoView({ block: 'center' }));
  const washer = stage.getByRole('img', { name: 'Front-load washing machine', exact: true }), standBox = await stage.getByRole('img', { name: mintLabel, exact: true }).boundingBox();
  const b = (await washer.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - 90, { steps: 8 }); await page.mouse.up();
  expect((await washer.boundingBox())!.y).toBeLessThan(b.y - 60);
  expect(await stage.getByRole('img', { name: mintLabel, exact: true }).boundingBox()).toEqual(standBox);
  await stage.screenshot({ path: `${OUT}/03-washer-moved.png` });
  await layers.getByRole('button', { name: 'Put everything back' }).click();
  // The stand dragged on its own (by its front edge, below the products): the washer and fridge stay where they were.
  const mint = stage.getByRole('img', { name: mintLabel, exact: true }), fridge = stage.getByRole('img', { name: 'Multi-door refrigerator', exact: true });
  await stage.evaluate(el => el.scrollIntoView({ block: 'center' }));
  const m = (await mint.boundingBox())!, before = { washer: await washer.boundingBox(), fridge: await fridge.boundingBox() };
  await page.mouse.move(m.x + m.width / 2, m.y + m.height * 0.85); await page.mouse.down(); await page.mouse.move(m.x + m.width / 2 + 60, m.y + m.height * 0.85 - 10, { steps: 8 }); await page.mouse.up();
  expect((await mint.boundingBox())!.x).toBeGreaterThan(m.x + 40);
  expect({ washer: await washer.boundingBox(), fridge: await fridge.boundingBox() }).toEqual(before);
  await stage.screenshot({ path: `${OUT}/03b-stand-moved.png` });
  await layers.getByRole('button', { name: 'Put everything back' }).click();

  // At 390 px the step reads without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(stands.getByRole('heading', { name: 'Display stands (6)' })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await page.screenshot({ path: `${OUT}/04-stands-390.png` });
  await stands.scrollIntoViewIfNeeded(); await stands.screenshot({ path: `${OUT}/04b-stands-list-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });

  // One stand put back into the background (asked first), prepared again: five stands.
  const row = stands.getByRole('listitem').filter({ hasText: pinkLabel });
  await row.getByRole('button', { name: 'Keep in background' }).click();
  await row.getByRole('button', { name: 'Yes, prepare again' }).click();
  await expect(standsOf(panel).getByRole('heading', { name: 'Display stands (5)' })).toBeVisible({ timeout: 120000 });
  view = await (await request.get(`${API}/${id}`)).json() as ProductView;
  expect(view.product.prepared!.stands!.map(s => s.label)).not.toContain(pinkLabel);
  expect(view.product.objects.some(o => o.kind === 'podium' && o.layer === 'background' && o.label.startsWith(pinkLabel))).toBe(true);
  await page.screenshot({ path: `${OUT}/05-one-kept-in-background.png` });

  // In the review, a podium box offers the choice of its own layer or the background (the shared podium: background).
  await panel.getByRole('button', { name: 'Back to the review' }).click();
  await panel.getByRole('region', { name: 'Background & decorations', exact: true }).getByRole('button', { name: /Display podium/ }).click();
  const inspector = panel.getByRole('complementary', { name: 'Selected element' });
  await expect(inspector.getByRole('group', { name: 'How should it be kept?' })).toBeVisible();
  await expect(inspector.getByRole('radio', { name: /Part of the background/ })).toBeChecked();
  await page.screenshot({ path: `${OUT}/06-review-podium-choice.png` });
  await panel.getByRole('button', { name: 'Save and choose what to decompose' }).click();
  await expect(panel.getByRole('heading', { name: 'Choose what to decompose' })).toBeVisible();
  await panel.getByRole('button', { name: 'Continue to Decomposition' }).click();
  await expect(standsOf(panel).getByRole('heading', { name: 'Display stands (5)' })).toBeVisible({ timeout: 120000 });

  // Saved; a creative lists the stands; sent to the Run Dashboard and opened in the editor, each stand is its own layer.
  for (const c of await panel.getByRole('complementary', { name: 'Checks' }).getByRole('checkbox').all()) await c.check();
  await panel.getByRole('button', { name: 'Save master template' }).click();
  await panel.getByRole('button', { name: 'Use this template' }).click();
  await panel.getByRole('button', { name: 'New creative' }).click();
  await expect(panel.getByRole('region', { name: 'Display stands' }).getByRole('listitem')).toHaveCount(5);
  await page.screenshot({ path: `${OUT}/07-creative-stands.png` });
  const creatives = (await (await request.get(`${API}/${id}/creatives`)).json()).creatives as { id: string }[];
  const creative = await (await request.get(`${API}/${id}/creatives/${creatives[0].id}`)).json() as ProductCreative;
  const standObjects = creative.objects.filter(o => o.kind === 'podium');
  expect(standObjects).toHaveLength(5);
  expect(Math.max(...standObjects.map(o => o.z))).toBeLessThan(Math.min(...creative.objects.filter(o => o.kind === 'product').map(o => o.z)));
  const sent = page.waitForResponse(r => r.url().endsWith('/open') && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Send to Decomposition', exact: true }).click();
  const { runId } = await (await sent).json() as { runId: string };
  await expect(panel.getByRole('heading', { name: 'Image to editor layers', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(panel).toBeHidden();
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('frameflow:project:v1')!) as ProjectDocument);
  await expect.poll(async () => (await stored()).variants.some(v => v.importedFrom?.runId === runId)).toBe(true);
  const design = (await stored()).variants.find(v => v.importedFrom?.runId === runId)!;
  for (const s of standObjects) expect(design.layers!.some(l => l.name === s.label), s.label).toBe(true);
  await page.screenshot({ path: `${OUT}/08-editor.png` });
  // In the editor: exported, one stand moved 20 px, exported again: only the stand's old and new places differ.
  const exportPng = async (name: string) => { const d = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export PNG', exact: true }).click(); await (await d).saveAs(`${OUT}/${name}`); return sharp(`${OUT}/${name}`).removeAlpha().raw().toBuffer({ resolveWithObject: true }); };
  const first = await exportPng('09-export-before.png');
  expect([first.info.width, first.info.height]).toEqual([607, 606]);
  const standName = mintLabel, standLayer = design.layers!.find(l => l.name === standName)!;
  const others = design.layers!.filter(l => l.id !== standLayer.id);
  await page.locator('.layer-select', { hasText: standName }).first().click();
  await page.getByLabel('X', { exact: true }).fill(String(standLayer.x + 20));
  await page.getByLabel('X', { exact: true }).blur();
  await expect.poll(async () => (await stored()).variants.find(v => v.id === design.id)!.layers!.find(l => l.id === standLayer.id)!.x).toBe(standLayer.x + 20);
  expect((await stored()).variants.find(v => v.id === design.id)!.layers!.filter(l => l.id !== standLayer.id)).toEqual(others);
  const second = await exportPng('10-export-stand-moved.png');
  let outside = 0, inside = 0;
  for (let y = 0; y < 606; y++) for (let x = 0; x < 607; x++) {
    const i = (y * 607 + x) * 3, differs = Math.max(...[0, 1, 2].map(c => Math.abs(first.data[i + c] - second.data[i + c]))) > 8;
    const near = x >= standLayer.x - 2 && x < standLayer.x + standLayer.width + 22 && y >= standLayer.y - 2 && y < standLayer.y + standLayer.height + 2;
    if (differs && near) inside++; else if (differs) outside++;
  }
  expect(inside).toBeGreaterThan(50);
  expect(outside).toBe(0);
  await page.screenshot({ path: `${OUT}/11-editor-stand-moved.png` });
  // Reloaded and reopened from Saved Runs: the moved stand is where it was put; the export is the same picture.
  await page.reload();
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  await panel.getByRole('tab', { name: 'Saved Runs', exact: true }).click();
  await panel.getByRole('article', { name: `Saved run ${runId}`, exact: true }).getByRole('button', { name: /View run/ }).click();
  await panel.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect(panel).toBeHidden();
  const reopened = (await stored()).variants.find(v => v.id === design.id)!;
  expect(reopened.layers!.find(l => l.id === standLayer.id)!.x).toBe(standLayer.x + 20);
  const third = await exportPng('12-export-reopened.png');
  let changed = 0; for (let i = 0; i < third.data.length; i++) if (Math.abs(third.data[i] - second.data[i]) > 8) changed++;
  expect(changed).toBe(0);
  writeFileSync(`${OUT}/evidence.json`, JSON.stringify({ answer: 'recorded real gpt-5.6-sol answer, replayed (no network)', templateId: id, runId, stands: labels, keptInBackground: pinkLabel,
    editor: { standMoved: [standLayer.x, standLayer.x + 20], exportPixelsChangedInside: inside, exportPixelsChangedOutside: outside, reopenedExportChangedPixels: changed } }, null, 2));
});
