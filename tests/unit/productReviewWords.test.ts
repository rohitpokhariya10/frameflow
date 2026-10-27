/**
 * Word-by-word review on the RECORDED real AI answer for the LG Ganesh creative (replayed, free): words corrected,
 * resized, regrouped and removed; missing text added; an object relabelled; a logo replaced and moved. Every correction
 * goes through preparation, the saved master, a creative and its decomposition run, and survives detection run again.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ProductCreative, ProductSnapshot } from '@frameflow/shared';
import { decodeRgba } from '../../server/src/decomposition/protectedTemplates/pixels.js';
import { replayProductAnalyzer } from '../../server/src/decomposition/protectedTemplates/product/analyzer.js';
import { findSheetCreatives } from '../../server/src/decomposition/protectedTemplates/product/sheet.js';
import { setup, type View } from '../../server/src/decomposition/protectedTemplates/product/productServer.fixture.js';
import { HAS_PRIVATE_FIXTURES } from './privateFixtures.js';

type Block = View['texts'][number] & { wordList: { id: string; text: string; line: number; box: { x: number; y: number; width: number; height: number }; removed: boolean; corrected: boolean }[] };
const RECORDED = 'tests/fixtures/recorded/ganesh-lg-gpt-5.6-sol-2026-10-22.response.json';

describe('word-by-word review on the recorded real answer', { timeout: 300_000 }, () => {
  it.skipIf(!HAS_PRIVATE_FIXTURES)('keeps every correction through prepare, master, creative, decomposition run and a second detection', async () => {
    const sheet = readFileSync('Ganesh-Chaturthi.png'), crop = findSheetCreatives(await decodeRgba(sheet)).boxes[0];
    const creative = await sharp(sheet).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).png({ compressionLevel: 9 }).toBuffer();
    const analyzer = replayProductAnalyzer({ response: JSON.parse(readFileSync(RECORDED, 'utf8')), model: 'gpt-5.6-sol', imageSha256: createHash('sha256').update(await sharp(creative).png().toBuffer()).digest('hex') });
    const s = await setup({ analyzer });
    try {
      const made = await s.form<View>('', sheet, { name: 'LG Ganesh (recorded answer)', crop: JSON.stringify(crop) });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      let v = await s.detected(made.body.template.id);
      const id = v.template.id;
      expect(v.product.detection).toMatchObject({ status: 'done', ai: { model: 'gpt-5.6-sol (recorded answer, replayed)' } });
      // (12 products: the TV's soundbar, subwoofer and two satellites are advertised one by one, so each is its own.)
      expect(v.counts).toMatchObject({ characters: 1, products: 12, words: 42, text: 5, logos: 18 });
      const blocks = v.texts as Block[], headline = blocks.find(b => b.category === 'headline')!, offer = blocks.find(b => b.text.startsWith('Get 26%'))!;
      expect(headline.wordList.map(w => w.text)).toEqual('A grand welcome for Bappa calls for equally grand savings.'.split(' '));
      const calls = headline.wordList.find(w => w.text === 'calls')!, savings = headline.wordList.find(w => w.text === 'savings.')!, products = offer.wordList.find(w => w.text === 'products.')!;
      const purifier = v.product.objects.find(o => /purifier/i.test(o.label))!, lg = v.logos.find(l => l.label === 'LG logo')!, unclear = v.logos.find(l => /Unclear/.test(l.label))!;
      // A replacement picture for the unclear bank logo, uploaded for the review.
      const f = new FormData(); f.append('image', new Blob([new Uint8Array(await sharp({ create: { width: 60, height: 20, channels: 4, background: '#1d4ed8' } }).png().toBuffer())], { type: 'image/png' }), 'dbs.png');
      const asset = await s.call<{ file: string }>(`/${id}/review-assets`, { method: 'POST', body: f });
      expect(asset.status).toBe(201);
      const box = { x: 420, y: 588, width: 120, height: 14 }; // on the white footer, beside the validity pill
      const saved = await s.send<View>('PUT', `/${id}/review`, { expectedRevision: v.template.revision,
        // (The soundbar's box drawn again where it is, under the screen: the answer put it on the speakers below.)
        objects: v.product.objects.map(o => ({ id: o.id, kind: o.kind, label: o.id === purifier.id ? 'Water purifier' : o.label, box: o.label === 'Soundbar' ? { x: 290, y: 345, width: 66, height: 8 } : o.box, accepted: true })),
        texts: [], logos: [{ slotId: lg.id, box: { ...lg.box, x: lg.box.x + 2 } }, { slotId: unclear.id, label: 'DBS Bank logo', replacement: asset.body.file, accepted: true }],
        words: [{ wordId: calls.id, text: 'brings', box: { ...calls.box, width: calls.box.width + 6 } }, { wordId: savings.id, groupId: 'new' }, { wordId: products.id, removed: true }],
        newTexts: [{ text: 'Offer ends soon', box, category: 'cta' }], dismissMissingText: true });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      v = saved.body;
      const after = v.texts as Block[], head2 = after.find(b => b.id === headline.id)!;
      expect(head2.wordList.filter(w => !w.removed).map(w => w.text)).toEqual('A grand welcome for Bappa brings for equally grand'.split(' '));
      expect(head2.wordList.find(w => w.id === calls.id)).toMatchObject({ corrected: true, box: { ...calls.box, width: calls.box.width + 6 } });
      expect(after.find(b => b.wordList.some(w => w.id === savings.id) && b.id !== headline.id)!.text).toBe('savings.');
      expect(after.find(b => b.text === 'Offer ends soon')).toMatchObject({ category: 'cta', words: 3 });
      expect(after.find(b => b.id === offer.id)!.text).not.toContain('products.');
      expect(v.logos.find(l => l.id === unclear.id)).toMatchObject({ label: 'DBS Bank logo', file: asset.body.file, attention: false });
      expect(v.logos.find(l => l.id === lg.id)!.box.x).toBe(lg.box.x + 2);
      expect(v.product.objects.find(o => o.id === purifier.id)!.label).toBe('Water purifier');
      // Prepared, approved and saved: the master has the corrections.
      await s.send('POST', `/${id}/prepare`, { expectedRevision: v.template.revision });
      v = await s.prepared(id);
      expect(v.product.prepared!.quality.issues.filter(i => i.blocking)).toEqual([]);
      v = (await s.send<View>('POST', `/${id}/approve`, { expectedRevision: v.template.revision, acknowledge: v.product.prepared!.quality.issues.map(i => i.id) })).body;
      expect((await s.send('POST', `/${id}/publish`, { expectedRevision: v.template.revision })).status).toBe(201);
      const snap = (await s.call<ProductSnapshot>(`/${id}/revisions/1`)).body;
      expect(snap.words.find(w => w.id === calls.id)).toMatchObject({ text: 'brings', corrected: { text: true, box: true } });
      expect(snap.words.some(w => w.id === products.id)).toBe(false);
      expect(snap.logoSlots.find(l => l.id === unclear.id)!.replacement!.file).toBe(asset.body.file);
      // A creative and its decomposition run: native words (the corrected one, the added text), the replaced logo.
      const c = (await s.send<ProductCreative>('POST', `/${id}/creatives`, {})).body;
      expect(c.texts.map(t => t.text)).toEqual(expect.arrayContaining(['brings', 'Offer', 'ends', 'soon', 'savings.']));
      expect(c.texts.map(t => t.text)).not.toContain('calls');
      expect(c.images.find(i => i.slotId === unclear.id)!.asset).toMatchObject({ kind: 'master', file: asset.body.file });
      const opened = await s.call<{ runId: string }>(`/${id}/creatives/${c.id}/open`, { method: 'POST' });
      const run = JSON.parse(readFileSync(join(s.root, 'runs', opened.body.runId, 'run.json'), 'utf8'));
      expect(run.creative.texts.map((t: { text: string }) => t.text)).toEqual(expect.arrayContaining(['brings', 'Offer', 'ends', 'soon']));
      // Each character and product its own layer (13), and each display stand under them its own layer.
      const objectLayers = run.creative.layers.filter((l: { kind: string }) => l.kind === 'object').map((l: { file: string }) => l.file);
      const stands = objectLayers.filter((f: string) => /-stand\.png$/.test(f)).length;
      expect(objectLayers.filter((f: string) => /-(product|character)\.png$/.test(f))).toHaveLength(13);
      expect(stands).toBeGreaterThanOrEqual(5);
      expect(objectLayers).toHaveLength(13 + stands);
      // Detection run again: the corrections win over what is found again at their place.
      const before = analyzer.calls;
      expect((await s.send('POST', `/${id}/detect`, { force: true, useAi: true })).status).toBe(202);
      v = await s.detected(id);
      expect(analyzer.calls).toBe(before + 1);
      // Kept: the 6 corrected words (1 retyped and resized, 1 moved, 1 removed, 3 added), the 2 changed logos, the accepted
      // objects (12 products, Ganesha and 4 podiums).
      expect(v.product.detection!.kept).toMatchObject({ words: 6, logos: 2, objects: 17 });
      const again = v.texts as Block[];
      expect(again.flatMap(b => b.wordList).filter(w => !w.removed).map(w => w.text)).toEqual(expect.arrayContaining(['brings', 'Offer', 'ends', 'soon']));
      expect(again.flatMap(b => b.wordList).filter(w => !w.removed).map(w => w.text)).not.toContain('calls');
      expect(again.flatMap(b => b.wordList).find(w => w.text === 'products.')?.removed ?? true).toBe(true);
      expect(v.logos.find(l => l.label === 'DBS Bank logo')!.file).toBe(asset.body.file);
      expect(v.product.objects.some(o => o.label === 'Water purifier')).toBe(true);
    } finally { await s.close(); }
  });
});
