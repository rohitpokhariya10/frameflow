/**
 * Live AI detection of a full-size creative, free (recorded answers, no network):
 *
 * - the REAL answer of 2026-10-22 19:36 IST for the user's own 4096 px LG Ganesh upload (27 objects: 12 products, 6
 *   decorations, 4 furniture, 4 scenery, 1 character) was complete and billed, and FrameFlow threw it away with "The
 *   analysis must list 1–24 objects." (the general scene limit). It is accepted now, up to the template's own limit;
 *   past it the least important objects are left out, never the whole answer. Other flows keep their limit.
 * - an answer already received can be read again with today's checks ("Use the answer already received"): no new
 *   request, nothing spent; one for another picture is refused.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { parseSceneDescription, PRODUCT_LIMITS } from '@frameflow/shared';
import { liveProductAnalyzer, parseProductScene } from '../../server/src/decomposition/protectedTemplates/product/analyzer.js';
import { decodeRgba } from '../../server/src/decomposition/protectedTemplates/pixels.js';
import { detectProduct } from '../../server/src/decomposition/protectedTemplates/product/detect.js';
import { prepareProduct } from '../../server/src/decomposition/protectedTemplates/product/prepare.js';
import { findSheetCreatives } from '../../server/src/decomposition/protectedTemplates/product/sheet.js';
import { recordedResponsesClient } from '../../server/src/decomposition/protectedTemplates/product/responsesClient.fixture.js';
import { fakeRecognizer } from '../../server/src/textRecognition/recognizer.js';
import { PRODUCT_SCENE_ANSWER, productPosterPng } from '../../server/src/decomposition/protectedTemplates/product/productPoster.fixture.js';
import { setup } from '../../server/src/decomposition/protectedTemplates/product/productServer.fixture.js';
import { HAS_PRIVATE_FIXTURES } from './privateFixtures.js';

const recorded = (name: string) => JSON.parse(readFileSync(`tests/fixtures/recorded/${name}.response.json`, 'utf8')) as { output_text: string; status: string; usage: object };
const live = (HAS_PRIVATE_FIXTURES ? recorded('ganesh-lg-4096-gpt-5.6-sol-2026-10-22') : undefined) as ReturnType<typeof recorded>;

describe.skipIf(!HAS_PRIVATE_FIXTURES)('live AI detection of a full-size creative (recorded answers, no network)', { timeout: 120_000 }, () => {
  it('the real 27-object answer for the 4096 px upload is accepted; other flows keep their own limit', () => {
    const answer = JSON.parse(live.output_text);
    expect(answer.objects).toHaveLength(27);
    const scene = parseProductScene(answer, { width: 2048, height: 2048 });
    expect(scene.objects.filter(o => o.kind === 'product')).toHaveLength(12);
    expect(scene.objects.filter(o => o.kind === 'character')).toHaveLength(1);
    expect(scene.words?.length).toBe(43);
    expect(() => parseSceneDescription(answer)).toThrow('The analysis must list 1–24 objects.');
  });

  it('past the template limit the least important objects are left out, with the relations and owners naming them', () => {
    const base = JSON.parse(live.output_text) as { objects: { id: string; kind: string; confidence: number }[]; relations: unknown[]; marks: { owner_id?: string }[] };
    const extra = Array.from({ length: PRODUCT_LIMITS.maxObjects + 10 - base.objects.length }, (_, k) => ({ ...base.objects.find(o => o.kind === 'decoration')!, id: `decoration_extra_${k}`, confidence: 0.3 }));
    const answer = { ...base, objects: [...base.objects, ...extra],
      relations: [...base.relations, { source: `decoration_extra_${extra.length - 1}`, relation: 'next_to', target: base.objects[0].id, evidence: 'beside', confidence: 0.5 }],
      marks: [...base.marks.slice(0, 1).map(m => ({ ...m, id: 'mark_extra', owner_id: `decoration_extra_${extra.length - 2}` })), ...base.marks] };
    const scene = parseProductScene(answer, { width: 2048, height: 2048 });
    expect(scene.objects.filter(o => o.kind === 'product')).toHaveLength(12);
    expect(scene.objects.filter(o => o.kind === 'character')).toHaveLength(1);
    expect(scene.objects.filter(o => o.kind !== 'scenery' || o.importance !== 'background').length).toBeLessThanOrEqual(PRODUCT_LIMITS.maxObjects);
  });

  it('a relation naming an object the answer does not list, and text-block boxes a line off their words, do not throw the answer away', () => {
    // The live answer of 20:06 IST: "obj_ganesha holds decor_modak_implied" (not an object), and the EMI block's box ~25 px off its words.
    const answer = JSON.parse(recorded('ganesh-lg-4096-c-gpt-5.6-sol-2026-10-22').output_text);
    const scene = parseProductScene(answer, { width: 2048, height: 2048 });
    expect(scene.relations.length).toBe(answer.relations.length - 1);
    expect(scene.words?.length).toBe(43);
    expect(scene.objects.filter(o => o.kind === 'product').length).toBeGreaterThan(8);
  });

  it('the AI’s bank-logo boxes (half a logo too low) are placed on the logos: none is cut, preparing passes the overlay gate', async () => {
    // The live answer of 20:26 IST for the 4096 px upload, on the same creative (the sheet's crop enlarged to 4096 px).
    const response = recorded('ganesh-lg-4096-b-gpt-5.6-sol-2026-10-22'), sheet = readFileSync('Ganesh-Chaturthi.png'), c = findSheetCreatives(await decodeRgba(sheet)).boxes[0];
    const png = await sharp(sheet).extract({ left: c.x, top: c.y, width: c.width, height: c.height }).resize(4096, null, { kernel: 'lanczos3' }).png().toBuffer(), source = await decodeRgba(png);
    const d = await detectProduct({ template: { id: 'pt-logos', source: { sha256: 'logos' } } as never, source, png, recognizer: fakeRecognizer([]), analyzer: liveProductAnalyzer({ client: recordedResponsesClient(response, { width: 2048, height: 2048 }) }), store: () => undefined, save: () => undefined, at: new Date().toISOString() });
    expect(d.ai.status).toBe('done');
    const marks = JSON.parse(response.output_text).marks as { text: string; overlay: boolean; box: { x: number; y: number } }[];
    const W = source.width, H = source.height, stands = (x: number, y: number) => { const i = (y * W + x) * 4; return Math.min(source.data[i], source.data[i + 1], source.data[i + 2]) < 215; };
    const bankLogos = d.analysis.logoSlots.filter(l => l.box.y > H * 0.8);
    expect(bankLogos.length).toBeGreaterThanOrEqual(15);
    for (const l of bankLogos) {
      // Nothing of the logo just above or below its box (the AI's box cut through the logo: half of it was outside).
      const b = l.box, line = (y: number) => { let n = 0; for (let x = Math.round(b.x); x < Math.round(b.x + b.width); x++) if (stands(x, y)) n++; return n / Math.round(b.width); };
      expect(Math.max(line(Math.round(b.y) - 3), line(Math.round(b.y + b.height) + 2)), l.label).toBeLessThan(0.1);
    }
    const idfc = d.analysis.logoSlots.find(l => /IDFC/.test(l.label))!, ai = marks.find(m => /IDFC/.test(m.text))!;
    expect(idfc.box.y).toBeLessThan(ai.box.y * H - 25);
    // Preparing: every text and logo area passes the gate; text and logos stay overlays of their own.
    const p = await prepareProduct({ source, analysis: d.analysis, objects: d.objects.map(o => ({ ...o, review: { status: 'accepted' as const, by: 'user' as const } })), paidApproved: false, save: () => undefined });
    expect(p.overlays.length).toBeGreaterThan(0);
    expect(p.quality.original.visiblePercent).toBeLessThan(5);
    // The microwave inside Ganesha's over-wide box, the satellite speakers inside the TV's: each its own cut-out (they came
    // out empty — "Nothing of … was found inside its box" — blocking approval).
    expect(p.quality.issues.filter(i => i.blocking).map(i => i.id)).toEqual([]);
    for (const o of d.objects.filter(x => x.kind === 'product' || x.kind === 'character')) expect(p.cutouts.some(c => c.id === o.id), o.label).toBe(true);
    expect(d.objects.some(o => /Microwave/.test(o.label))).toBe(true);
  });

  it('“Use the answer already received”: detection completes from the saved answer, with no request and no cost; another picture’s answer is refused', async () => {
    const s = await setup({ analyzer: false });
    try {
      const made = await s.form('', await productPosterPng(), { name: 'Saved answer', useAi: 'false' });
      let v = await s.detected(made.body.template.id);
      const id = v.template.id, dir = join(s.protectedDir, id), activity = v.product.activity;
      expect(v.product.detection?.ai?.status).not.toBe('done');
      // Nothing received yet: refused at once, plainly.
      const none = await s.send<{ error?: { code?: string } }>('POST', `/${id}/detect`, { force: true, useAi: false, savedAnswer: true });
      expect(none.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(none.body)).toContain('NO_SAVED_ANSWER');
      // A completed answer saved with the template, for this very picture (as every live request saves it).
      const answer = { ...PRODUCT_SCENE_ANSWER, text_overlays: [], words: [] };
      const sent = await sharp(readFileSync(join(dir, v.template.source.inputFile))).png().toBuffer();
      writeFileSync(join(dir, 'analysis-product-response.json'), JSON.stringify({ status: 'completed', output_text: JSON.stringify(answer), output: [], usage: { input_tokens: 4201, output_tokens: 10332 } }));
      writeFileSync(join(dir, 'analysis-product-request.json'), JSON.stringify({ model: 'gpt-5.6-sol', input: { sourceBytes: sent.length } }));
      expect((await s.send('POST', `/${id}/detect`, { force: true, useAi: false, savedAnswer: true })).status).toBe(202);
      v = await s.detected(id);
      expect(v.product.detection?.ai).toMatchObject({ status: 'done', model: 'gpt-5.6-sol (recorded answer, replayed)' });
      expect(v.counts.products).toBeGreaterThan(0);
      expect(v.product.activity.aiCalls).toBe(activity.aiCalls);
      expect(v.product.activity.costUsd).toBe(activity.costUsd);
      // A review save that changes no logo marks none as corrected (each save sends every logo's box, label and category).
      const logos = (await s.call<{ logos: { id: string; box: object; label: string; category?: string }[] }>(`/${id}`)).body.logos;
      expect(logos.length).toBeGreaterThan(0);
      v = (await s.send('PUT', `/${id}/review`, { expectedRevision: v.template.revision, objects: v.product.objects.map(o => ({ ...o, accepted: true })), texts: [], logos: logos.map(l => ({ slotId: l.id, box: l.box, label: l.label, ...(l.category ? { category: l.category } : {}) })), dismissMissingText: true })).body;
      const stored = JSON.parse(readFileSync(join(dir, 'template.json'), 'utf8')) as { textAnalysis: { logoSlots: { corrected?: object }[] } };
      expect(stored.textAnalysis.logoSlots.filter(l => l.corrected)).toHaveLength(0);
      // An answer saved for another version of the picture is not used.
      writeFileSync(join(dir, 'analysis-product-request.json'), JSON.stringify({ model: 'gpt-5.6-sol', input: { sourceBytes: sent.length + 1 } }));
      expect((await s.send('POST', `/${id}/detect`, { force: true, useAi: false, savedAnswer: true })).status).toBe(202);
      v = await s.detected(id);
      expect(v.product.detection?.status).toBe('failed');
      expect(v.product.detection?.error).toContain('another version of this picture');
    } finally { await s.close(); }
  });
});
