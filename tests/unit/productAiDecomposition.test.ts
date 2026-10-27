/**
 * The decomposition core: the OpenAI planner → Seedream Layerize, through the LIVE code of both (aiDecompose.ts) with a
 * fake OpenAI client and a fake fal transport (nothing leaves the machine). On the drawn product poster:
 *
 *   - the picture sent (to the planner and, byte for byte, to fal) has NO text and NO logo in it — the bank logos, the
 *     brand logo kept in the picture by the person, every word — checked on the pixels, not on the prompt;
 *   - the planner gets the reviewed elements (names, kinds, boxes) and counts of what was removed, never a word;
 *   - Seedream gets the planner's prompt; its layers become the elements' masks and its background what is behind them;
 *   - nothing is sent without the approved amount;
 *   - every word (text, place, font, size, colour, rotation) and every logo (its picture, place, size) is kept as it was,
 *     and the editor's run gets them all as layers of their own at their places — none left in the background or in a
 *     decomposed layer.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { DetectedWord, LogoSlot, ProductSnapshot } from '@frameflow/shared';
import { bboxTag, createProductLayerizer, liveDecompositionPlanner, SEEDREAM_LAYERIZE } from '../../server/src/decomposition/protectedTemplates/product/aiDecompose.js';
import type { FalTransport } from '../../server/src/decomposition/providers/falClient.js';
import { PRODUCT_OBJECTS, PRODUCT_TILES, productPosterPng } from '../../server/src/decomposition/protectedTemplates/product/productPoster.fixture.js';
import { setup, type View } from '../../server/src/decomposition/protectedTemplates/product/productServer.fixture.js';

type Box = { x: number; y: number; width: number; height: number };
const MINT = [0xbd, 0xf0, 0xdc];
/** A fake fal: records the upload and the request; answers as Seedream does — the base image first (z_index 0, no box:
 * here the picture with the objects painted over in the panel's colour), then each object's rectangle as a CROP of its
 * own, at twice its size (real layers come at their own resolution), with its box on the base. */
function fakeFal(boxes: Record<string, Box>) {
  const log = { uploads: [] as Buffer[], submits: [] as { endpoint: string; input: Record<string, unknown> }[], files: new Map<string, Buffer>() };
  const transport: FalTransport = {
    async upload(bytes) { log.uploads.push(bytes); return 'https://fal.test/input.png'; },
    async submit(endpoint, input) { log.submits.push({ endpoint, input }); return { requestId: 'req-fake-1' }; },
    async status() { return 'COMPLETED'; },
    async cancel() { /* never */ },
    async download(url) { const b = log.files.get(url); if (!b) throw new Error(`no ${url}`); return b; },
    async result() {
      const sent = await sharp(log.uploads.at(-1)!).removeAlpha().raw().toBuffer({ resolveWithObject: true }), W = sent.info.width, H = sent.info.height;
      const bg = Buffer.from(sent.data);
      for (const b of Object.values(boxes)) for (let y = b.y; y < b.y + b.height; y++) for (let x = b.x; x < b.x + b.width; x++) for (let c = 0; c < 3; c++) bg[(y * W + x) * 3 + c] = MINT[c];
      const layers: { name?: string; png: Buffer; box?: Box }[] = [{ png: await sharp(bg, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer() }];
      for (const [name, b] of Object.entries(boxes)) {
        const crop = await sharp(sent.data, { raw: { width: W, height: H, channels: 3 } }).extract({ left: b.x, top: b.y, width: b.width, height: b.height }).ensureAlpha().resize(b.width * 2, b.height * 2).png().toBuffer();
        layers.push({ name, png: crop, box: b });
      }
      return { layers: layers.map((l, k) => { const url = `https://fal.test/layer-${k}.png`; log.files.set(url, l.png); return { image: { url, content_type: 'image/png' }, z_index: k, ...(l.name ? { name: l.name } : {}),
        ...(l.box ? { bounding_box: { absolute: [l.box.x, l.box.y, l.box.x + l.box.width, l.box.y + l.box.height], normalized: [Math.round(1000 * l.box.x / W), Math.round(1000 * l.box.y / H), Math.round(1000 * (l.box.x + l.box.width) / W), Math.round(1000 * (l.box.y + l.box.height) / H)] } } : {}) }; }) };
    },
  };
  return { transport, log };
}
/** A fake OpenAI Responses client: records the request; plans one layer per element chosen, named as given. */
function fakeOpenAI() {
  const calls: { instructions: string; input: { content: { type: string; text?: string; image_url?: string }[] }[]; text: { format: { name: string; strict: boolean } } }[] = [];
  return { calls, client: { responses: { async create(request: unknown) {
    const r = request as (typeof calls)[number]; calls.push(r);
    const body = JSON.parse(r.input[0].content.find(c => c.type === 'input_text')!.text!) as { elements: { id: string; name: string; decompose: boolean }[] };
    const chosen = body.elements.filter(e => e.decompose);
    const plan = { prompt: `Separate layers, front to back: ${chosen.map(e => e.name).join('; ')}. Everything else is one background layer.`, layers: chosen.map(e => ({ element_id: e.id, name: e.name, description: e.name })), background: 'The mint panel and the page.', warnings: [] };
    return { id: 'resp-fake-1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(plan) }] }], output_text: JSON.stringify(plan), usage: { input_tokens: 1000, output_tokens: 300, total_tokens: 1300 } };
  } } } };
}
/**
 * In a box, the share of the original's ink a picture still has: a word's ink is its own colour (a panel's pattern
 * continued under it is not the word); a logo's, the pixels unlike what is just around its box (2 px out).
 */
function inkLeft(source: { data: Buffer; width: number }, other: Buffer, b: Box, channels = 3, colour?: string): number {
  if (colour) {
    const c0 = [1, 3, 5].map(k => parseInt(colour.slice(k, k + 2), 16)); let ink = 0, same = 0;
    for (let y = b.y; y < b.y + b.height; y++) for (let x = b.x; x < b.x + b.width; x++) {
      const i = (y * source.width + x) * 3, o = (y * source.width + x) * channels; if (Math.max(...c0.map((v, c) => Math.abs(source.data[i + c] - v))) > 60) continue;
      ink++; if (Math.max(...[0, 1, 2].map(c => Math.abs(source.data[i + c] - other[o + c]))) <= 24) same++;
    }
    return ink ? same / ink : 0;
  }
  const at = (buf: Buffer, ch: number, x: number, y: number) => [0, 1, 2].map(c => buf[(y * source.width + x) * ch + c]);
  const ring: number[][] = [[], [], []], X0 = Math.max(0, b.x - 2), Y0 = Math.max(0, b.y - 2), X1 = b.x + b.width + 1, Y1 = b.y + b.height + 1;
  for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) if (y === Y0 || y === Y1 || x === X0 || x === X1) at(source.data, 3, x, y).forEach((v, c) => ring[c].push(v));
  const med = ring.map(v => { v.sort((p, q) => p - q); return v[v.length >> 1]; });
  let ink = 0, same = 0;
  for (let y = b.y; y < b.y + b.height; y++) for (let x = b.x; x < b.x + b.width; x++) {
    const s = at(source.data, 3, x, y); if (Math.max(...s.map((v, c) => Math.abs(v - med[c]))) <= 40) continue;
    ink++; const o = at(other, channels, x, y); if (Math.max(...s.map((v, c) => Math.abs(v - o[c]))) <= 24) same++;
  }
  return ink ? same / ink : 0;
}

describe('AI decomposition core: OpenAI planner → Seedream Layerize (live code, fake OpenAI and fal)', { timeout: 300_000 }, () => {
  it('sends a picture without any text or logo, uses the plan and the layers, and keeps every word and logo as its own layer', async () => {
    const poster = await productPosterPng(), source = await sharp(poster).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const src = { data: source.data, width: source.info.width };
    const openai = fakeOpenAI(), fal = fakeFal({ Television: PRODUCT_OBJECTS.tv, 'Washing machine': PRODUCT_OBJECTS.washer, Refrigerator: PRODUCT_OBJECTS.fridge, Mascot: PRODUCT_OBJECTS.mascot });
    const layerizer = createProductLayerizer({ planner: liveDecompositionPlanner({ client: openai.client as never, model: 'gpt-test-planner' }), transport: () => fal.transport, sleep: async () => undefined, pollIntervalMs: 0 });
    const s = await setup({ analyzer: true, layerizer });
    try {
      const made = await s.form<View>('', poster, { name: 'AI decomposition' });
      let v = await s.detected(made.body.template.id);
      const id = v.template.id, stored = () => JSON.parse(readFileSync(join(s.protectedDir, id, 'template.json'), 'utf8'));
      v = (await s.send<View>('PUT', `/${id}/review`, { expectedRevision: v.template.revision, objects: v.product.objects.map(o => ({ ...o, accepted: true })), texts: [], logos: [], dismissMissingText: true })).body;
      // The person keeps the ACME brand logo in the picture: it stays in the background, and is still never sent.
      const acme = v.logos.find(l => /ACME/i.test(l.label))!;
      expect(acme).toBeTruthy();
      v = (await s.send<View>('PUT', `/${id}/selection`, { expectedRevision: v.template.revision, objects: v.product.objects.map(o => ({ id: o.id, decompose: o.kind === 'product' || o.kind === 'character' })), logos: [{ slotId: acme.id, separate: false }] })).body;
      const before = stored().textAnalysis as { words: DetectedWord[]; logoSlots: LogoSlot[] };

      // The cost first: nothing is sent without the approved amount.
      const estimate = (await s.call<{ ai: { configured: boolean; maxUsd: number; expectedUsd: number; elements: number; requests: number } }>(`/${id}/prepare-estimate`)).body.ai;
      expect(estimate).toMatchObject({ configured: true, elements: 4, requests: 2 });
      expect(estimate.maxUsd).toBeGreaterThan(estimate.expectedUsd);
      const refused = await s.send<{ error: { code: string } }>('POST', `/${id}/prepare`, { expectedRevision: v.template.revision, engine: 'ai' });
      expect(refused.status).toBe(400); expect(JSON.stringify(refused.body)).toContain('APPROVAL_REQUIRED');
      expect(openai.calls).toHaveLength(0); expect(fal.log.uploads).toHaveLength(0);
      expect((await s.send('POST', `/${id}/prepare`, { expectedRevision: v.template.revision, engine: 'ai', approveUsd: estimate.maxUsd })).status).toBe(202);
      v = await s.prepared(id);
      expect(v.stage, v.product.preparing?.error).toBe('prepared');

      // One planner request, one Seedream request, the planner's prompt to Seedream.
      expect(openai.calls).toHaveLength(1); expect(fal.log.submits).toHaveLength(1);
      const plannerText = openai.calls[0].input[0].content.find(c => c.type === 'input_text')!.text!;
      expect(fal.log.submits[0].endpoint).toBe(SEEDREAM_LAYERIZE);
      expect(fal.log.submits[0].input.prompt).toBe(JSON.parse(readFileSync(join(s.protectedDir, id, 'prepare-ai-plan.json'), 'utf8')).prompt);
      // Each element chosen goes to Seedream with its reviewed place as a <bbox> tag (the fake planner wrote none: added).
      const elementsSent = JSON.parse(readFileSync(join(s.protectedDir, id, 'prepare-ai-elements.json'), 'utf8')).elements as { label: string; box: Box; decompose: boolean }[];
      for (const e of elementsSent.filter(x => x.decompose)) expect(String(fal.log.submits[0].input.prompt), e.label).toContain(bboxTag(e.box, source.info.width, source.info.height));
      // The planner never gets a word of the text: only elements, and counts and logo names of what was removed.
      for (const w of before.words) expect(plannerText.includes(`"${w.text}"`), w.text).toBe(false);
      expect(JSON.parse(plannerText).removed_before).toMatchObject({ words: before.words.filter(w => w.review.status !== 'rejected').length });
      // The picture sent (planner and fal: the same pixels) has none of the text or logos, the kept brand logo included.
      const sent = await sharp(fal.log.uploads[0]).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([sent.info.width, sent.info.height]).toEqual([source.info.width, source.info.height]);
      const plannerImage = Buffer.from(openai.calls[0].input[0].content.find(c => c.type === 'input_image')!.image_url!.split(',')[1], 'base64');
      expect(Buffer.compare(await sharp(plannerImage).removeAlpha().raw().toBuffer(), sent.data)).toBe(0);
      const liveWords = before.words.filter(w => w.review.status !== 'rejected'), logoBoxes = before.logoSlots.filter(l => l.review.status !== 'rejected').map(l => l.box as Box);
      const px = (b: Box) => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
      expect(logoBoxes.length).toBe(PRODUCT_TILES.length + 1);
      for (const w of liveWords) expect(inkLeft(src, sent.data, px(w.box), 3, w.style.color), w.text).toBeLessThan(0.1);
      for (const b of logoBoxes) expect(inkLeft(src, sent.data, px(b)), JSON.stringify(b)).toBeLessThan(0.2);
      expect(inkLeft(src, sent.data, acme.box)).toBeLessThan(0.2);
      // (The check before sending saw every word and logo gone.)
      expect(JSON.parse(readFileSync(join(s.protectedDir, id, 'prepare-ai-input-check.json'), 'utf8'))).toMatchObject({ stillVisible: [], logosKeptInPicture: ['ACME logo'] });

      // Seedream's layers became the elements' masks; its background is behind them (marked as an AI estimate).
      const p = v.product.prepared!;
      expect(p.separation).toMatchObject({ method: 'seedream', requests: 2, ai: { planner: 'gpt-test-planner', engine: SEEDREAM_LAYERIZE, offline: false, requestId: 'req-fake-1', layers: 5, unmatched: [] } });
      expect(p.separation.ai!.matched).toHaveLength(4);
      expect(v.product.objects.filter(o => o.cutout).map(o => o.cutout!.method)).toEqual(['seedream', 'seedream', 'seedream', 'seedream']);
      expect(p.quality.issues.map(i => i.id)).toContain('ai-background');
      const file = async (f: string) => sharp(Buffer.from(await (await s.fetchFile(id, f)).arrayBuffer()));
      const base = await (await file(p.base.file)).removeAlpha().raw().toBuffer();
      const tv = PRODUCT_OBJECTS.tv, mid = ((tv.y + 60) * source.info.width + tv.x + 110) * 3;
      expect([0, 1, 2].map(c => Math.abs(base[mid + c] - MINT[c])).every(d => d <= 12)).toBe(true);

      // Every word and every logo kept as it was (text, place, font, size, colour, rotation; picture, place, size).
      const after = stored().textAnalysis as { words: DetectedWord[]; logoSlots: LogoSlot[] };
      expect(after.words.map(w => ({ id: w.id, text: w.text, box: w.box, style: w.style }))).toEqual(before.words.map(w => ({ id: w.id, text: w.text, box: w.box, style: w.style })));
      expect(after.logoSlots.map(l => ({ id: l.id, box: l.box, original: l.original }))).toEqual(before.logoSlots.map(l => ({ id: l.id, box: l.box, original: l.original })));
      // Not in the background, not in any decomposed layer: the layers without the text and logos show none of them
      // (the brand logo kept in the picture is the background's, as chosen).
      const recombinedClean = await (await file(p.previews.recombinedClean)).removeAlpha().raw().toBuffer();
      const overlayLogoBoxes = before.logoSlots.filter(l => l.review.status !== 'rejected' && l.id !== acme.id).map(l => l.box as Box);
      for (const w of liveWords) expect(inkLeft(src, recombinedClean, px(w.box), 3, w.style.color), w.text).toBeLessThan(0.1);
      for (const b of overlayLogoBoxes) expect(inkLeft(src, recombinedClean, px(b)), JSON.stringify(b)).toBeLessThan(0.2);
      expect(inkLeft(src, base, acme.box)).toBeGreaterThan(0.8);

      // Saved as the master; a creative of it opened for the editor: every word a text of its own at its place and style,
      // every overlay logo a picture layer of its own at its place, above the decomposed layers.
      v = (await s.send<View>('POST', `/${id}/approve`, { expectedRevision: v.template.revision, acknowledge: p.quality.issues.map(i => i.id) })).body;
      expect((await s.send<View>('POST', `/${id}/publish`, { expectedRevision: v.template.revision })).status).toBe(201);
      const snapshot = JSON.parse(readFileSync(join(s.protectedDir, id, 'product-r1.json'), 'utf8')) as ProductSnapshot;
      // (The saved version keeps the words in use; a word removed in the review is not part of it.)
      expect(snapshot.words.map(w => w.id)).toEqual(after.words.filter(w => w.review.status !== 'rejected').map(w => w.id));
      const creative = (await s.send<{ id: string }>('POST', `/${id}/creatives`, {})).body;
      const opened = (await s.send<{ runId: string }>('POST', `/${id}/creatives/${creative.id}/open`, {})).body;
      const run = JSON.parse(readFileSync(join(s.root, 'runs', opened.runId, 'run.json'), 'utf8'));
      const live = after.words.filter(w => w.review.status !== 'rejected');
      expect(run.creative.texts).toHaveLength(live.length);
      for (const w of live) {
        const t = (run.creative.texts as { wordId: string; text: string; x: number; baselineY: number; rotation?: number; style: { fontFamily: string; fontSize: number; color: string } }[]).find(x => x.wordId === w.id)!;
        expect(t, w.text).toBeTruthy();
        expect(t).toMatchObject({ text: w.text, style: { fontFamily: w.style.fontFamily, color: w.style.color } });
        expect(t.style.fontSize).toBeCloseTo(w.style.fontSize, 1);
        expect(t.x).toBeCloseTo(w.box.x + (w.style.originDx ?? 0), 1); expect(t.baselineY).toBeCloseTo(w.box.y + w.style.baseline, 1);
      }
      const logoLayers = (run.creative.layers as { kind: string; elementIds: string[] }[]).filter(l => l.kind === 'image');
      const images = ((await s.call<{ images: { id: string; slotId: string | null; box: Box; asset: { kind: string } }[] }>(`/${id}/creatives/${creative.id}`)).body).images;
      const overlaySlots = before.logoSlots.filter(l => l.review.status !== 'rejected' && l.id !== acme.id);
      expect(logoLayers.map(l => images.find(i => i.id === l.elementIds[0])!.slotId).sort()).toEqual(overlaySlots.map(l => l.id).sort());
      // (Each at its slot's place and size, its own picture: the template's logo, not a crop of a decomposed layer.)
      for (const slot of overlaySlots) { const i = images.find(x => x.slotId === slot.id)!; expect(i.asset.kind, slot.label).toBe('master'); for (const k of ['x', 'y', 'width', 'height'] as const) expect(i.box[k]).toBeCloseTo(slot.box[k], 0); }
      const objectLayers = (run.creative.layers as { kind: string; z: number }[]).filter(l => l.kind === 'object');
      expect(objectLayers).toHaveLength(4);
      expect(Math.min(...logoLayers.map(l => (l as unknown as { z: number }).z))).toBeGreaterThan(Math.max(...objectLayers.map(l => l.z)));
      expect(run.creative.provenance.textLayersSentToProviders).toBe(0);
    } finally { await s.close(); }
  });
});
