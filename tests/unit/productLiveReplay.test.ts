/**
 * The REAL answer of the one approved live detection (gpt-5.6-sol, 2026-10-22, $0.2177; tests/fixtures/recorded/),
 * replayed offline through detection and preparation: free, no network. It locks in the fixes the real answer exposed
 * (a text block naming more than 8 objects, the brand mark on the artwork kept as the LG logo, an unclear bank logo
 * flagged, a TV's sound-system parts kept in the TV's layer). Not a measure of model accuracy on other creatives.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { decodeRgba } from '../../server/src/decomposition/protectedTemplates/pixels.js';
import { detectProduct } from '../../server/src/decomposition/protectedTemplates/product/detect.js';
import { prepareProduct } from '../../server/src/decomposition/protectedTemplates/product/prepare.js';
import { replayProductAnalyzer } from '../../server/src/decomposition/protectedTemplates/product/analyzer.js';
import { findSheetCreatives } from '../../server/src/decomposition/protectedTemplates/product/sheet.js';
import { fakeRecognizer } from '../../server/src/textRecognition/recognizer.js';
import { HAS_PRIVATE_FIXTURES } from './privateFixtures.js';

const RECORDED = 'tests/fixtures/recorded/ganesh-lg-gpt-5.6-sol-2026-10-22';
describe('the recorded live AI answer for the LG Ganesh creative, replayed', { timeout: 120_000 }, () => {
  it.skipIf(!HAS_PRIVATE_FIXTURES)('becomes a complete detection: every word, 18 logo overlays, Ganesha and 8 products; prepared with nothing blocking', async () => {
    const sheet = readFileSync('Ganesh-Chaturthi.png'), crop = findSheetCreatives(await decodeRgba(sheet)).boxes[0];
    expect(crop).toEqual({ x: 50, y: 158, width: 607, height: 606 });
    const creative = await sharp(sheet).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).png({ compressionLevel: 9 }).toBuffer();
    const png = await sharp(creative).png().toBuffer(), source = await decodeRgba(creative);
    const analyzer = replayProductAnalyzer({ response: JSON.parse(readFileSync(`${RECORDED}.response.json`, 'utf8')), model: 'gpt-5.6-sol', imageSha256: createHash('sha256').update(png).digest('hex') });
    const r = await detectProduct({ template: { id: 'pt-replay', source: { sha256: 'replay' } } as never, source, png, recognizer: fakeRecognizer([]), analyzer, store: () => undefined, save: () => undefined, at: '2026-10-22T00:00:00.000Z' });
    expect(r.ai).toMatchObject({ status: 'done', model: 'gpt-5.6-sol (recorded answer, replayed)', costUsd: 0 });
    // Every word on its own, in its five blocks.
    expect(r.analysis.words).toHaveLength(42);
    const block = (category: string) => r.analysis.groups.filter(g => g.category === category).map(g => g.label);
    expect(block('headline')).toEqual(['A grand welcome for Bappa calls for equally grand savings.']);
    expect(r.analysis.groups.map(g => g.label)).toEqual(expect.arrayContaining(['Get 26% cashback up to ₹26,000 on all LG products.', 'Validity: Till 30th September 2026']));
    // Logos: LG (a brand mark on the artwork) and Pine Labs kept as brand logos; 16 bank/payment logos; the unclear one flagged.
    const logos = r.analysis.logoSlots;
    expect(logos).toHaveLength(18);
    expect(logos.filter(l => l.category === 'brand-logo').map(l => l.label).sort()).toEqual(['LG logo', 'pine labs logo']);
    expect(logos.filter(l => l.review.status === 'needs-review').map(l => l.label)).toEqual(['Unclear red-and-black bank logo']);
    // Objects: Ganesha; 12 products — the TV's soundbar, subwoofer and two satellite speakers are advertised one by one, so
    // each is its own (merged into the TV they could not be moved apart); the background structure.
    expect(r.objects.filter(o => o.kind === 'character').map(o => o.label)).toEqual(['Illustrated deity mascot']);
    const products = r.objects.filter(o => o.kind === 'product');
    expect(products).toHaveLength(12);
    expect(products.map(o => o.label)).toEqual(expect.arrayContaining(['OLED television', 'Soundbar']));
    // Prepared locally. The answer placed the soundbar's box on the speakers below the TV (its box holds nothing of it):
    // that is blocking, said plainly — nothing is merged away silently.
    const accepted = r.objects.map(o => ({ ...o, review: { status: 'accepted' as const, by: 'user' as const } }));
    const first = await prepareProduct({ source, analysis: r.analysis, objects: accepted, paidApproved: false, save: () => undefined });
    const soundbar = accepted.find(o => o.label === 'Soundbar')!;
    expect(first.quality.issues.filter(i => i.blocking).map(i => i.id)).toEqual([`empty-${soundbar.id}`]);
    // The reviewer draws its box again where it is (under the screen, measured): nothing blocking, every element a layer.
    const corrected = accepted.map(o => (o.id === soundbar.id ? { ...o, box: { x: 290, y: 345, width: 66, height: 8 } } : o));
    const prepared = await prepareProduct({ source, analysis: r.analysis, objects: corrected, paidApproved: false, save: () => undefined });
    expect(prepared.quality.issues.filter(i => i.blocking)).toEqual([]);
    expect(prepared.cutouts).toHaveLength(13);
    expect(prepared.quality.issues.filter(i => i.id.startsWith('fill-')).length).toBeLessThanOrEqual(6);

    // Visual regression on the real creative (compared with the earlier output, test-results/product-v5/evidence/):
    // 1 behind the objects: rebuilt, never a transparent hole, and no ghost of the object left there.
    const base = await decodeRgba(prepared.base), n = base.width * base.height;
    let transparent = 0; for (let i = 0; i < n; i++) if (base.data[i * 4 + 3] < 255) transparent++;
    expect(transparent).toBe(0);
    expect(prepared.quality.reconstructedPercent).toBeGreaterThan(5);
    for (const cut of prepared.cutouts) {
      const px = await decodeRgba(cut.png); let inside = 0, same = 0;
      for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) {
        const i = (y * px.width + x) * 4; if (px.data[i + 3] < 250) continue;
        const j = ((y + cut.placement.y) * base.width + x + cut.placement.x) * 4; inside++;
        if (Math.max(...[0, 1, 2].map(c => Math.abs(px.data[i + c] - base.data[j + c]))) <= 12) same++;
      }
      expect(same / Math.max(1, inside), `ghost of ${cut.id} left in the background`).toBeLessThan(0.35);
    }
    // 2 the validity pill: its text taken out completely (no letter remnants), its colour kept.
    const clean = await decodeRgba(prepared.clean);
    let marks = 0; for (let y = 576; y < 588; y++) for (let x = 236; x < 366; x++) { const i = (y * clean.width + x) * 4; if (Math.max(Math.abs(clean.data[i] - 10), Math.abs(clean.data[i + 1] - 109), Math.abs(clean.data[i + 2] - 101)) > 30) marks++; }
    expect(marks).toBe(0);
    // 3 the words as drawn: every character has a glyph in its face, and no word of a line runs into the next one.
    const { offerFace } = await import('@frameflow/shared'), { offerFontFile } = await import('../../server/src/textRecognition/fontMatch.js');
    for (const g of r.analysis.groups) for (const l of g.lines) {
      const ws = l.wordIds.map(x => r.analysis.words.find(w => w.id === x)!).sort((a, b) => a.box.x - b.box.x);
      for (const [i, w] of ws.entries()) {
        const file = offerFontFile(offerFace(w.style.fontFamily, w.style.fontWeight, w.style.fontStyle)!);
        for (const ch of w.text) expect(file.charToGlyph(ch).index, `“${ch}” of “${w.text}” in ${w.style.fontFamily}`).toBeGreaterThan(0);
        const next = ws[i + 1]; if (!next) continue;
        const start = w.box.x + (w.style.originDx ?? 0), end = start + file.getAdvanceWidth(w.text, w.style.fontSize) + w.style.letterSpacing * ([...w.text].length - 1);
        expect(end, `“${w.text}” runs into “${next.text}”`).toBeLessThanOrEqual(next.box.x + (next.style.originDx ?? 0) + 2);
      }
    }
  });
});
