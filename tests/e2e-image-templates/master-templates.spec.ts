import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { Stage } from 'konva/lib/Stage';
import type { Text } from 'konva/lib/shapes/Text';
import type { CreativeInstance, MasterSnapshot } from '@frameflow/shared';
import { fixture } from './wizard.helpers';

test.use({ extraHTTPHeaders: { origin: `http://127.0.0.1:${process.env.FRAMEFLOW_OFFLINE_E2E_PORT ?? 3317}` } });
// Text & Graphics master templates on the offline fixture: real routes, storage, REAL local OCR (tesseract, counted),
// editor and export; Seedream is faked (it echoes a master's clean background). Nothing leaves this machine.
test.describe.configure({ timeout: 300_000 });
// A step that cannot find its control fails within half a minute instead of waiting for the whole test's timeout.
test.use({ actionTimeout: 30_000 });
const API = '/api/layerize-experiment/master-templates';
// One master's own activity (its scans, OCR reads and Seedream requests): tests running beside it in the other worker
// never change these, unlike the fixture's global call counters.
const counts = async (request: APIRequestContext, id: string) => {
  const { activity } = await (await request.get(`${API}/${id}`)).json() as { activity: { scans: number; ocrReads: number; seedreamRequests: number } };
  return { scans: activity.scans, ocr: activity.ocrReads, seedream: activity.seedreamRequests };
};
const masterIdOf = (page: Page) => page.evaluate(() => [...document.querySelectorAll('img, image')].map(i => i.getAttribute('src') ?? i.getAttribute('href') ?? '').map(src => /protected-templates\/(pt-[a-f0-9]{12})\//.exec(src)?.[1]).find(Boolean)!);
const editorTexts = (page: Page) => page.evaluate(() => (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0].find<Text>('.editable-text')
  .map(n => ({ text: n.text(), fill: n.fill() as string, family: n.fontFamily().split(',')[0].replace(/"/g, ''), x: n.x(), y: n.y() })));
/** Sets a colour input the way a picker does (React listens to input events). */
const pickColour = (page: Page, label: string | RegExp, value: string) => page.getByLabel(label).first().evaluate((el, v) => {
  const input = el as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
  input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
}, value);

async function openWorkspace(page: Page) {
  await page.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'OpenAI + Seedream test' }).click();
  return page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
}
/** Upload → scan (real OCR) → review: returns the master id once its elements are listed. */
async function createMaster(page: Page, poster: Buffer, name: string, fileName = 'poster.png') {
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  await panel.getByLabel('Offer creative').setInputFiles({ name: fileName, mimeType: fileName.endsWith('png') ? 'image/png' : 'image/jpeg', buffer: poster });
  await panel.getByLabel('Template name').fill(name);
  await panel.getByRole('button', { name: 'Upload and scan' }).click();
  await expect(panel.getByText('Detected elements')).toBeVisible({ timeout: 180_000 });
  return masterIdOf(page);
}
async function approveAndPrepare(page: Page, beforeClean?: () => Promise<void>) {
  const panel = page.getByRole('dialog', { name: 'OpenAI + Seedream test' });
  const approved = page.waitForResponse(r => r.url().includes('/review/approve-all') && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Approve all confident' }).click();
  await approved;
  // What remains is uncertain: approved together after a look (the confirmation names how many).
  const all = panel.getByRole('button', { name: 'Approve all', exact: true });
  if (await all.isEnabled()) { page.once('dialog', d => void d.accept()); const again = page.waitForResponse(r => r.url().includes('/review/approve-all')); await all.click(); await again; }
  // Approving never leaves the review by itself: the user moves on.
  await panel.getByRole('button', { name: 'Continue: prepare the background' }).click();
  await beforeClean?.();
  await panel.getByRole('button', { name: /Make the clean background/ }).click();
  await expect(panel.getByTestId('background-preview')).toBeVisible({ timeout: 240_000 });
  const ack = panel.getByRole('checkbox', { name: /I checked the clean background/ });
  if (await ack.count()) await ack.check();
  await panel.getByRole('button', { name: 'Approve background' }).click();
  // The fixture server is one process: another test's scan or background can hold it for a while.
  await expect(panel.getByText('Approved', { exact: true })).toBeVisible({ timeout: 60_000 });
}

test('Create Template asks for the type first: Text & Graphics opens the master flow, Product + Text the existing form', async ({ page }) => {
  const panel = await openWorkspace(page);
  await panel.getByRole('tab', { name: 'Template Studio' }).click();
  await panel.getByRole('tab', { name: 'Create Template' }).click();
  await expect(panel.getByRole('group', { name: 'Template type' })).toBeVisible();
  // Nothing of the Product + Text form before a type is chosen.
  await expect(panel.getByRole('heading', { name: 'Create a template' })).toHaveCount(0);
  await panel.getByRole('button', { name: /Product \+ Text/ }).click();
  await expect(panel.getByRole('heading', { name: 'Create a template' })).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Create template steps' })).toBeVisible();
  await panel.getByRole('button', { name: 'change type' }).click();
  await expect(panel.getByRole('heading', { name: 'Create a template' })).toHaveCount(0);
  await panel.getByRole('button', { name: /Text & Graphics/ }).click();
  await expect(panel.getByRole('tab', { name: 'Offer Templates', selected: true })).toBeVisible();
  await expect(panel.getByLabel('Offer creative')).toBeVisible();
});

test('a different poster becomes a master, is reused word by word and logo by logo, edited in the editor and reopened, with no OCR, decomposition or AI call', async ({ page, request }, info) => {
  const panel = await openWorkspace(page);
  await panel.getByRole('tab', { name: 'Offer Templates' }).click();
  await panel.getByRole('button', { name: 'New template' }).first().click();
  await expect(panel.getByRole('group', { name: 'Template type' })).toBeVisible();
  // Its own name: the same test runs at once in other projects, each with its own master.
  const name = `Super SALE ${info.project.name} ${Date.now()}`;
  const id = await createMaster(page, await fixture(request, '/__test__/master-poster.png'), name);
  const scanned = await counts(request, id);
  expect(scanned.scans).toBe(1); expect(scanned.ocr).toBeGreaterThan(0);
  // Every word on its own, by category; selecting one highlights only that one.
  const list = panel.getByLabel('Detected elements');
  // Real OCR: the words it reads clearly on this poster, each on its own (small light-on-dark copy may be missed and added by hand).
  for (const word of ['Super', 'SALE', 'today.', 'cards.', 'T&Cs']) await expect(list.getByRole('button', { name: new RegExp(`^${word.replace(/[.%&]/g, m => `\\${m}`)}`) }).first()).toBeVisible();
  await list.getByRole('button', { name: /^SALE/ }).first().click();
  await expect(panel.locator('rect.ot-box.is-selected')).toHaveCount(1);
  await expect(panel.locator('rect.ot-box.is-selected')).toHaveAttribute('data-label', 'SALE');
  await expect(list.getByRole('heading', { name: 'Bank & partner logos' }).or(list.getByText('Bank & partner logos'))).toBeVisible();
  // Corrections: a word's text, and a word the scan missed drawn by hand over the poster. Neither repeats the scan.
  await list.getByRole('button', { name: /^cards\./ }).first().click();
  await panel.getByLabel('Word text').fill('cards!');
  await panel.getByRole('button', { name: 'Add text' }).click();
  const svg = panel.getByRole('img', { name: 'Poster with detected elements' }), at = (x: number, y: number) => svg.evaluate((el, [sx, sy]) => {
    const p = (el as SVGSVGElement).createSVGPoint(); p.x = sx; p.y = sy; const q = p.matrixTransform((el as SVGSVGElement).getScreenCTM()!); return { x: q.x, y: q.y };
  }, [x, y] as const);
  const from = await at(560, 712), to = await at(700, 778);
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 6 }); await page.mouse.up();
  await panel.getByLabel('Word text').fill('OFFER');
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByText('Changes saved.')).toBeVisible();
  await expect(list.getByRole('button', { name: /^OFFER/ })).toBeVisible();
  expect((await counts(request, id)).ocr).toBe(scanned.ocr);
  await approveAndPrepare(page);
  // The optional decomposition: one confirmed (fake) Seedream request with the clean background only.
  await request.post(`/__test__/seedream-echo/${id}`);
  await panel.getByRole('button', { name: /Decompose with Seedream/ }).click();
  await expect(panel.getByText(/One paid request to/)).toBeVisible();
  await panel.getByRole('button', { name: 'Send to Seedream (paid)' }).click();
  await expect(panel.getByText(/Seedream returned 1 layers/)).toBeVisible({ timeout: 60_000 });
  // The choice is saved first (the radio follows the saved master).
  await panel.getByRole('radio', { name: /Split it into layers with Seedream/ }).click();
  await expect(panel.getByRole('radio', { name: /Split it into layers with Seedream/ })).toBeChecked();
  await panel.getByRole('button', { name: 'Save master' }).click();
  await expect(panel.getByText('Master saved').first()).toBeVisible();
  const published = await counts(request, id);
  expect(published.seedream).toBe(scanned.seedream + 1);
  expect(published.ocr).toBe(scanned.ocr);
  const master = await (await request.get(`${API}/${id}`)).json() as { latestRevision: { revision: number; sha256: string }; master: { revisions: unknown[] } };
  const snapshot = await (await request.get(`${API}/${id}/revisions/${master.latestRevision.revision}`)).json() as MasterSnapshot;
  expect(snapshot.layers).toHaveLength(1);

  // Reuse: the saved artwork with every word, logo and plate on top; no scan, decomposition or AI. From here on the page
  // writes only to this master's creatives.
  const writes: string[] = [];
  page.on('request', r => { const path = new URL(r.url()).pathname; if (r.method() !== 'GET' && path.startsWith('/api/')) writes.push(path); });
  // This page's own creative (the narrow-window test may add one to this master while this runs).
  const made = page.waitForResponse(r => new URL(r.url()).pathname === `${API}/${id}/creatives` && r.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Reuse Template' }).click();
  const { id: creativeId, name: creativeName } = await (await made).json() as CreativeInstance;
  await expect(panel.getByTestId('creative-preview')).toBeVisible();
  await expect(panel.getByTestId('reuse-facts')).toContainText('No new scan');
  await expect(panel.getByTestId('word-field')).toHaveCount(snapshot.words.filter(w => w.review.status !== 'rejected').length);
  await expect(panel.getByTestId('logo-slot')).toHaveCount(snapshot.logoSlots.length);
  // Teal to black, everywhere it is used.
  await pickColour(page, /^Replace colour #0/, '#000000');
  // New offer copy with more words than the master's headline: every word its own text.
  const headline = panel.getByTestId('text-group').filter({ hasText: 'Super' }).first();
  await headline.getByRole('button', { name: 'Rewrite' }).click();
  await headline.getByRole('textbox', { name: /New copy/ }).fill('Mega\nFESTIVE SALE\nends today');
  await headline.getByRole('button', { name: 'Apply' }).click();
  await expect(panel.getByLabel('Word “FESTIVE”')).toBeVisible();
  // One logo replaced: only its slot changes.
  await panel.getByLabel('Replace Logo 2').setInputFiles({ name: 'new-bank.png', mimeType: 'image/png', buffer: await fixture(request, '/__test__/master-logo.png') });
  await expect(panel.getByText(/Logo 2 · replaced/)).toBeVisible();
  await expect(panel.getByTestId('creative-save-state')).toHaveText(/Saved · revision/, { timeout: 30_000 });
  let creative = await (await request.get(`${API}/${id}/creatives/${creativeId}`)).json() as CreativeInstance;
  expect(creative.texts.filter(t => t.groupId === snapshot.words.find(w => w.text === 'SALE')!.groupId).map(t => t.text)).toEqual(['Mega', 'FESTIVE', 'SALE', 'ends', 'today']);
  expect(creative.images.filter(i => i.asset.kind === 'creative').map(i => i.label)).toEqual(['Logo 2']);
  expect(creative.texts.find(t => t.text === 'FESTIVE')!.style.color).toBe('#000000');

  // The editor: each word its own Konva text, the logos and artwork as layers; a font change saved back to the creative.
  await panel.getByRole('button', { name: 'Open in Editor' }).click();
  await expect(page.getByRole('button', { name: 'Save creative' })).toBeVisible();
  const texts = await editorTexts(page);
  expect(texts.map(t => t.text).sort()).toEqual(creative.texts.filter(t => !t.hidden && t.text).map(t => t.text).sort());
  expect(texts.find(t => t.text === 'FESTIVE')!.fill).toBe('#000000');
  const layerNames = await page.getByRole('list', { name: 'Design layers' }).locator('.layer-name').allTextContents();
  expect(layerNames.filter(n => /^Logo \d/.test(n))).toHaveLength(snapshot.logoSlots.filter(l => l.category === 'partner-logo').length);
  // Select "Mega" on the canvas list and set it in Lora.
  await page.getByRole('tab', { name: 'Text' }).click();
  await page.getByRole('button', { name: /Mega/ }).first().click();
  await page.getByLabel('Font family').selectOption('Lora');
  await page.getByRole('button', { name: 'Save creative' }).click();
  await expect(page.getByText(/Saved to creative · revision/)).toBeVisible();
  creative = await (await request.get(`${API}/${id}/creatives/${creativeId}`)).json() as CreativeInstance;
  expect(creative.texts.find(t => t.text === 'Mega')!.style.fontFamily).toBe('Lora');
  // Export at the master's own size.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG' }).click();
  const png = await (await download).path();
  expect(await sharp(png!).metadata().then(m => [m.width, m.height])).toEqual([snapshot.canvas.width, snapshot.canvas.height]);

  // Reload and reopen: the same creative, the same design (no duplicate), the master unchanged.
  await page.reload();
  const again = await openWorkspace(page);
  await again.getByRole('tab', { name: 'Offer Templates' }).click();
  const card = again.getByRole('article', { name: `Template ${name}` });
  await card.getByRole('button', { name: 'Creatives' }).click();
  await card.getByRole('button', { name: new RegExp(creativeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
  await expect(again.getByLabel('Word “Mega”')).toBeVisible();
  await again.getByRole('button', { name: 'Open in Editor' }).click();
  await expect(page.getByRole('button', { name: 'Save creative' })).toBeVisible();
  const reopened = await editorTexts(page);
  expect(reopened.length).toBe(texts.length);
  expect(reopened.find(t => t.text === 'Mega')!.family).toBe('Lora');
  const finalCounts = await counts(request, id);
  expect(finalCounts.ocr).toBe(published.ocr);
  expect(finalCounts.seedream).toBe(published.seedream);
  expect(writes.filter(w => !w.startsWith(`${API}/${id}/creatives`))).toEqual([]);
  const masterAfter = await (await request.get(`${API}/${id}`)).json() as { latestRevision: { revision: number; sha256: string }; stage: string };
  expect(masterAfter.latestRevision).toEqual(master.latestRevision);
  expect(masterAfter.stage).toBe('ready');
});

// The supplied Easy EMI posters, when they are on this machine (FRAMEFLOW_MASTER_REFERENCE_DIR, default ~/Downloads/pL-Templates).
const EASY_EMI = 'ec78f1988a6949bb7bed3b5b9e4504911c00cfb7.jpg', EASY_EMI_BLACK = 'T1.jpg', TENT_CARD = 'Tent-Card-3.jpg';
test('Easy EMI: the teal master recreated as the black version by recolouring its editable text, at full resolution, without OCR or Seedream', async ({ page, request }, info) => {
  const source = await request.get(`/__test__/reference-poster/${EASY_EMI}`);
  test.skip(!source.ok(), 'The Easy EMI reference posters are not on this machine.');
  test.skip(info.project.name !== 'desktop', 'One run is enough for the real poster.');
  const panel = await openWorkspace(page);
  await panel.getByRole('tab', { name: 'Offer Templates' }).click();
  await panel.getByRole('button', { name: 'New template' }).first().click();
  const id = await createMaster(page, await source.body(), `Easy EMI ${Date.now()}`, 'easy-emi.jpg');
  type Box = { x: number; y: number; width: number; height: number };
  const analysis = (await (await request.get(`${API}/${id}`)).json() as { template: { textAnalysis: { words: { text: string; groupId: string; box: Box }[]; logoSlots: { category: string; box: Box }[]; plates: { box: Box }[] } } }).template.textAnalysis;
  const word = (t: string) => analysis.words.find(w => w.text === t)!;
  expect([word('Easy'), word('EMI'), word('available.')].every(Boolean)).toBe(true);
  expect(new Set([word('Easy'), word('EMI'), word('available.')].map(w => w.box.y)).size).toBe(3);
  expect(analysis.logoSlots.filter(l => l.category === 'partner-logo')).toHaveLength(10);
  expect(analysis.logoSlots.filter(l => l.category === 'brand-logo')).toHaveLength(2);
  await approveAndPrepare(page);
  await panel.getByRole('button', { name: 'Save master' }).click();
  await expect(panel.getByText('Master saved').first()).toBeVisible();
  const published = await counts(request, id);
  await panel.getByRole('button', { name: 'Reuse Template' }).click();
  await expect(panel.getByTestId('creative-preview')).toBeVisible();
  await pickColour(page, /^Replace colour #0/, '#000000');
  await expect(panel.getByTestId('creative-save-state')).toHaveText(/Saved · revision 2/, { timeout: 30_000 });
  await page.screenshot({ path: info.outputPath('easy-emi-reuse-black.png') });
  await panel.getByRole('button', { name: 'Open in Editor' }).click();
  await expect(page.getByRole('button', { name: 'Save creative' })).toBeVisible();
  const texts = await editorTexts(page);
  for (const t of ['Easy', 'EMI', 'available.']) expect(texts.filter(x => x.text === t), t).toHaveLength(1);
  expect(texts.find(t => t.text === 'EMI')!.fill).toBe('#000000');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PNG' }).click();
  const file = (await (await download).path())!;
  const exported = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  expect([exported.info.width, exported.info.height]).toEqual([1820, 2420]);
  // No teal letters left under the black ones: inside the master's word boxes, almost no pixel is the old teal.
  let teal = 0, n = 0;
  for (const w of [word('Easy'), word('EMI'), word('available.')]) for (let y = w.box.y; y < w.box.y + w.box.height; y += 2) for (let x = w.box.x; x < w.box.x + w.box.width; x += 2) {
    const i = (Math.round(y) * exported.info.width + Math.round(x)) * 3; n++;
    if (Math.abs(exported.data[i] - 3) < 30 && Math.abs(exported.data[i + 1] - 89) < 30 && Math.abs(exported.data[i + 2] - 90) < 30) teal++;
  }
  expect(teal / n).toBeLessThan(0.002);
  // Compared with the source and the supplied black reference (Image B). Raw pixel averages are dominated by the letter
  // shapes of the closest bundled font (the poster's own font is not available), so the checks measure what changed:
  //   artwork   outside every text, plate and logo box the export is the master's own artwork (Image A's pixels)
  //   text      inside each word's box, dark ink covers about what the teal ink covered in A and the black ink in B
  const original = await sharp(await source.body()).removeAlpha().raw().toBuffer();
  const boxes = [...analysis.words.map(w => w.box), ...analysis.logoSlots.map(l => l.box), ...analysis.plates.map(p => p.box)];
  const inside = (x: number, y: number) => boxes.some(b => x >= b.x - 24 && x <= b.x + b.width + 24 && y >= b.y - 24 && y <= b.y + b.height + 24);
  let artDiff = 0, artN = 0;
  for (let y = 0; y < 2420; y += 3) for (let x = 0; x < 1820; x += 3) {
    if (inside(x, y)) continue;
    const i = (y * 1820 + x) * 3; artDiff += Math.max(...[0, 1, 2].map(c => Math.abs(exported.data[i + c] - original[i + c]))); artN++;
  }
  info.annotations.push({ type: 'artwork outside the replaceable boxes: mean difference from the source (0–255)', description: (artDiff / artN).toFixed(2) });
  expect(artDiff / artN).toBeLessThan(3);
  const share = (data: Buffer, box: { x: number; y: number; width: number; height: number }, test: (r: number, g: number, b: number) => boolean) => {
    let hit = 0, n = 0;
    for (let y = box.y; y < box.y + box.height; y += 2) for (let x = box.x; x < box.x + box.width; x += 2) { const i = (Math.round(y) * 1820 + Math.round(x)) * 3; n++; if (test(data[i], data[i + 1], data[i + 2])) hit++; }
    return hit / Math.max(1, n);
  };
  const isBlack = (r: number, g: number, b: number) => Math.max(r, g, b) < 70, isTeal = (r: number, g: number, b: number) => Math.abs(r - 3) < 40 && Math.abs(g - 89) < 40 && Math.abs(b - 90) < 40;
  const reference = await request.get(`/__test__/reference-poster/${EASY_EMI_BLACK}`), black = reference.ok() ? await sharp(await reference.body()).removeAlpha().raw().toBuffer() : undefined;
  for (const t of ['Easy', 'EMI', 'available.']) {
    const box = word(t).box, now = share(exported.data, box, isBlack), before = share(original, box, isTeal);
    info.annotations.push({ type: `“${t}” ink share`, description: `export black ${(now * 100).toFixed(1)}% · source teal ${(before * 100).toFixed(1)}%${black ? ` · Image B black ${(share(black, box, isBlack) * 100).toFixed(1)}%` : ''}` });
    expect(now / before, t).toBeGreaterThan(0.7); expect(now / before, t).toBeLessThan(1.4);
    if (black) { const b = share(black, box, isBlack); expect(now / b, `${t} against Image B`).toBeGreaterThan(0.7); expect(now / b, `${t} against Image B`).toBeLessThan(1.4); }
  }
  if (black) {
    let diff = 0, m = 0;
    for (let y = 0; y < 1250; y += 4) for (let x = 0; x < 1820; x += 4) { const i = (y * 1820 + x) * 3; diff += Math.max(...[0, 1, 2].map(c => Math.abs(exported.data[i + c] - black[i + c]))); m++; }
    info.annotations.push({ type: 'top half mean difference from Image B (0–255; letter shapes of the substitute fonts dominate it)', description: (diff / m).toFixed(1) });
  }
  const final = await counts(request, id);
  expect(final.ocr).toBe(published.ocr);
  expect(final.seedream).toBe(published.seedream);
});

test('a structurally different poster (QR code, badge, other copy) is detected, saved and reused without Easy EMI assumptions', async ({ page, request }, info) => {
  const source = await request.get(`/__test__/reference-poster/${TENT_CARD}`);
  test.skip(!source.ok(), 'The Tent Card reference poster is not on this machine.');
  test.skip(info.project.name !== 'desktop', 'One run is enough for the real poster.');
  const panel = await openWorkspace(page);
  await panel.getByRole('tab', { name: 'Offer Templates' }).click();
  await panel.getByRole('button', { name: 'New template' }).first().click();
  const id = await createMaster(page, await source.body(), `Golden Onam ${Date.now()}`, 'tent-card.jpg');
  const a = (await (await request.get(`${API}/${id}`)).json() as { template: { textAnalysis: { words: { text: string }[]; groups: { category: string }[]; logoSlots: { category: string }[] } } }).template.textAnalysis;
  expect(a.logoSlots.map(l => l.category).sort()).toEqual(expect.arrayContaining(['qr', 'badge', 'brand-logo']));
  expect(a.logoSlots.filter(l => l.category === 'partner-logo')).toHaveLength(0);
  expect(a.groups.map(g => g.category)).toEqual(expect.arrayContaining(['headline', 'cta', 'legal']));
  for (const t of ['CASHBACK', 'UPI', 'Scan']) expect(a.words.some(w => w.text === t), t).toBe(true);
  await approveAndPrepare(page);
  await panel.getByRole('button', { name: 'Save master' }).click();
  await expect(panel.getByText('Master saved').first()).toBeVisible();
  const published = await counts(request, id);
  await panel.getByRole('button', { name: 'Reuse Template' }).click();
  await expect(panel.getByTestId('creative-preview')).toBeVisible();
  await panel.getByLabel('Replace QR code').setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: await fixture(request, '/__test__/master-logo.png') });
  await expect(panel.getByText(/QR code · replaced/)).toBeVisible();
  await expect(panel.getByTestId('creative-save-state')).toHaveText(/Saved · revision/, { timeout: 30_000 });
  await panel.getByRole('button', { name: 'Open in Editor' }).click();
  await expect(page.getByRole('button', { name: 'Save creative' })).toBeVisible();
  expect((await editorTexts(page)).some(t => t.text === 'CASHBACK')).toBe(true);
  const final = await counts(request, id);
  expect(final.ocr).toBe(published.ocr);
  expect(final.seedream).toBe(published.seedream);
});

test('the reuse screen fits a narrow window: preview above the content panel', async ({ page, request }) => {
  await page.setViewportSize({ width: 820, height: 1100 });
  const panel = await openWorkspace(page);
  await panel.getByRole('tab', { name: 'Offer Templates' }).click();
  const masters = (await (await request.get(API)).json() as { masters: { id: string; latestRevision: number | null }[] }).masters.filter(m => m.latestRevision);
  test.skip(!masters.length, 'Needs a saved master from the other tests.');
  await panel.getByRole('article').filter({ has: page.getByRole('button', { name: 'Reuse Template' }) }).first().getByRole('button', { name: 'Reuse Template' }).click();
  const preview = panel.getByTestId('creative-preview'), content = panel.getByLabel('Creative content');
  await expect(preview).toBeVisible();
  const p = await preview.boundingBox(), c = await content.boundingBox();
  expect(p!.y + p!.height).toBeLessThanOrEqual(c!.y + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('Scan Again: explained first, then suggestions beside the original design, applied only as chosen, usable at 390px', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'desktop', 'One run covers the flow; it also runs at 390px.');
  test.setTimeout(240_000);
  type View = { template: { id: string; revision: number; textAnalysis: { revision: number; words: { id: string; text: string; style: Record<string, unknown> }[]; groups: unknown[]; logoSlots: unknown[]; plates?: unknown[] } }; stage: string };
  const ok = async <T,>(res: Promise<import('@playwright/test').APIResponse>) => { const r = await res; expect(r.ok(), await r.text()).toBe(true); return await r.json() as T; };
  // A saved template with a creative, and a font the administrator picked by hand (the scan suggests another).
  const name = `Rescan ${Date.now()}`;
  let v = await ok<View>(request.post(API, { multipart: { name, image: { name: 'poster.png', mimeType: 'image/png', buffer: await fixture(request, '/__test__/master-poster.png') } } }));
  const id = v.template.id;
  await expect.poll(async () => (v = await ok<View>(request.get(`${API}/${id}`))).stage, { timeout: 120_000 }).not.toBe('scanning');
  v = await ok<View>(request.post(`${API}/${id}/review/approve-all`, { data: { expectedRevision: v.template.revision, includeUncertain: true } }));
  v = await ok<View>(request.post(`${API}/${id}/prepare`, { data: { expectedRevision: v.template.revision } }));
  v = await ok<View>(request.post(`${API}/${id}/background/approve`, { data: { expectedRevision: v.template.revision, acknowledgeEstimate: true } }));
  v = await ok<View>(request.post(`${API}/${id}/publish`, { data: { expectedRevision: v.template.revision } }));
  const creative = await ok<CreativeInstance>(request.post(`${API}/${id}/creatives`, { data: {} }));
  const a = v.template.textAnalysis, sale = a.words.find(w => w.text === 'SALE')!;
  await ok<View>(request.put(`${API}/${id}/review`, { data: { expectedRevision: v.template.revision, expectedAnalysisRevision: a.revision, groups: a.groups, logoSlots: a.logoSlots, plates: a.plates,
    words: a.words.map(w => w.id === sale.id ? { ...w, style: { ...w.style, fontFamily: 'Anton', fontWeight: 400, fontMatch: 'admin' } } : w) } }));
  const before = await counts(request, id);

  const panel = await openWorkspace(page);
  await panel.getByRole('tab', { name: 'Offer Templates' }).click();
  await panel.getByRole('article', { name: `Template ${name}` }).getByRole('button', { name: 'Edit master' }).click();
  // Step 1: what it does, before anything runs.
  await panel.getByRole('button', { name: 'Scan Again' }).click();
  const rescan = panel.getByRole('region', { name: /Scan your original design again|Checking your design|Review the suggestions|Apply the selected changes/ });
  await expect(panel.getByRole('heading', { name: 'Scan your original design again' })).toBeFocused();
  await expect(rescan).toContainText('Your saved creatives stay exactly as they are.');
  await page.screenshot({ path: info.outputPath('rescan-1-explained.png') });
  await panel.getByRole('button', { name: 'Start scan' }).click();
  await expect(panel.getByText('Finding the text and comparing fonts.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('rescan-2-scanning.png') });
  // Step 2: suggestions beside the original; the hand-picked font is offered, not ticked.
  const review = panel.getByRole('heading', { name: 'Review the suggestions' });
  await expect(review).toBeVisible({ timeout: 120_000 });
  await expect(review).toBeFocused();
  const saleRow = panel.getByRole('listitem').filter({ has: page.getByRole('checkbox', { name: /“SALE”/ }) });
  await expect(saleRow.getByRole('checkbox')).not.toBeChecked();
  await expect(saleRow).toContainText('You picked this font yourself');
  await expect(saleRow.getByRole('img', { name: '“SALE” in your original design' })).toBeVisible();
  await expect(saleRow).toContainText('Now Anton Regular');
  await page.screenshot({ path: info.outputPath('rescan-3-review.png'), fullPage: true });
  // At 390px: nothing scrolls sideways; ticked with the keyboard.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await panel.locator('.ws-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await saleRow.getByRole('checkbox').focus();
  await page.keyboard.press('Space');
  await expect(saleRow.getByRole('checkbox')).toBeChecked();
  await page.screenshot({ path: info.outputPath('rescan-4-review-390.png'), fullPage: true });
  // Step 3: exactly what changes, then apply.
  await panel.getByRole('button', { name: /^Continue with \d+ changes?$/ }).click();
  await expect(panel.getByRole('heading', { name: 'Apply the selected changes?' })).toBeFocused();
  await expect(rescan).toContainText('“SALE”');
  await expect(rescan).toContainText('every saved creative');
  await page.screenshot({ path: info.outputPath('rescan-5-confirm-390.png'), fullPage: true });
  await panel.getByRole('button', { name: 'Apply selected changes' }).click();
  await expect(panel.getByText(/Done: updated the font on \d+ lines?\. To use (it|them) in new creatives, press Save master below/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Scan Again' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('rescan-6-done-390.png'), fullPage: true });

  const after = await ok<View>(request.get(`${API}/${id}`));
  const saleAfter = after.template.textAnalysis.words.find(w => w.id === sale.id)!;
  expect(saleAfter.style.fontFamily).not.toBe('Anton');
  expect(after.stage).toBe('changed');
  expect(await ok<CreativeInstance>(request.get(`${API}/${id}/creatives/${creative.id}`))).toEqual(creative);
  const now = await counts(request, id);
  expect(now.scans).toBe(before.scans + 1); expect(now.seedream).toBe(before.seedream);
});

test('Tent-Card-1 (black text, light figures on a dark pill): every line, the figures and the pill leave the clean background; the artwork stays', async ({ page, request }, info) => {
  const source = await request.get(`/__test__/reference-poster/${EASY_EMI_BLACK}`);
  test.skip(!source.ok(), 'The Tent-Card-1 reference poster is not on this machine.');
  test.skip(info.project.name !== 'desktop', 'One run is enough for the real poster.');
  test.setTimeout(240_000);
  const panel = await openWorkspace(page);
  await panel.getByRole('tab', { name: 'Offer Templates' }).click();
  await panel.getByRole('button', { name: 'New template' }).first().click();
  const id = await createMaster(page, await source.body(), `Tent-Card-1 ${Date.now()}`, 'tent-card-1.jpg');
  type Box = { x: number; y: number; width: number; height: number };
  const a = (await (await request.get(`${API}/${id}`)).json() as { template: { textAnalysis: { words: { text: string; box: Box; style: { color: string } }[]; plates?: { box: Box }[]; logoSlots: { box: Box }[] } } }).template.textAnalysis;
  // The figures the whole-poster reading skips (light on a dark pill) are found beside "months", with the pill.
  expect(a.words.some(w => /3-6-9-12-18-24/.test(w.text))).toBe(true);
  expect(a.plates ?? []).toHaveLength(1);
  // Before cleaning: what will be removed is shown, with what to do about anything left out.
  await approveAndPrepare(page, async () => {
    await expect(panel.getByTestId('removal-preview')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await expect(panel.getByTestId('removal-preview')).toBeVisible();
    await expect(panel.getByTestId('clean-check-hint')).toContainText('not');
    await page.screenshot({ path: info.outputPath('tent-card-1-what-will-be-cleaned.png') });
  });
  const view = await (await request.get(`${API}/${id}`)).json() as { template: { base: { file: string } } };
  const clean = await sharp(await (await request.get(`/api/layerize-experiment/protected-templates/${id}/files/${view.template.base.file}`)).body()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const original = await sharp(await source.body()).removeAlpha().raw().toBuffer({ resolveWithObject: true }), W = clean.info.width;
  await sharp(clean.data, { raw: { width: W, height: clean.info.height, channels: 3 } }).png().toFile(info.outputPath('tent-card-1-clean.png'));
  const px = (b: Buffer, x: number, y: number) => { const i = (y * W + x) * 3; return [b[i], b[i + 1], b[i + 2]]; };
  // No figure of the pill is left (lime), and no dark ink is left where any word was.
  const pill = a.plates![0].box;
  let lime = 0;
  for (let y = Math.floor(pill.y); y < pill.y + pill.height; y++) for (let x = Math.floor(pill.x); x < pill.x + pill.width; x++) { const p = px(clean.data, x, y); if (Math.abs(p[0] - 206) < 50 && Math.abs(p[1] - 222) < 50 && Math.abs(p[2] - 89) < 60) lime++; }
  expect(lime, 'lime figures left in the pill').toBeLessThan(40);
  for (const w of a.words.filter(x => x.style.color !== '#cede59')) {
    let ink = 0, n = 0;
    for (let y = Math.floor(w.box.y); y < w.box.y + w.box.height; y += 2) for (let x = Math.floor(w.box.x); x < w.box.x + w.box.width; x += 2) { n++; const p = px(clean.data, x, y); if (p[0] < 60 && p[1] < 60 && p[2] < 60) ink++; }
    expect(ink / n, `ink left where "${w.text}" was`).toBeLessThan(0.002);
  }
  // Outside what was removed (each word, the pill and the logo slots, with a margin), the artwork is the source's.
  const out = [...a.words.map(w => w.box), ...(a.plates ?? []).map(p => p.box), ...a.logoSlots.map(l => l.box)].map(b => ({ x: b.x - 50, y: b.y - 50, width: b.width + 100, height: b.height + 100 }));
  let diff = 0, m = 0;
  for (let y = 0; y < clean.info.height; y += 4) for (let x = 0; x < W; x += 4) {
    if (out.some(b => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height)) continue;
    const p = px(clean.data, x, y), q = px(original.data, x, y); diff += Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2])); m++;
  }
  expect(diff / m, 'artwork outside the removed content').toBeLessThan(2);
});

