/**
 * Display stands (the pedestals and platforms products stand on) on their own layers, separate from the products and
 * from the shared podium, completed where products hide them; the administrator's "Podium or stand" boxes correct what
 * was found. A drawn scene (its truth known: drawn again without what is hidden) and the REAL LG creative (the recorded
 * live answer of 2026-10-22, replayed: free, no network): hiding or moving each product leaves a whole stand and an
 * opaque background behind it and changes nothing else.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import type { ProductObject } from '@frameflow/shared';
import { decodeRgba } from '../../server/src/decomposition/protectedTemplates/pixels.js';
import { prepareProduct, type PrepareResult } from '../../server/src/decomposition/protectedTemplates/product/prepare.js';
import { detectProduct } from '../../server/src/decomposition/protectedTemplates/product/detect.js';
import { replayProductAnalyzer } from '../../server/src/decomposition/protectedTemplates/product/analyzer.js';
import { findSheetCreatives } from '../../server/src/decomposition/protectedTemplates/product/sheet.js';
import { fakeRecognizer } from '../../server/src/textRecognition/recognizer.js';
import { fakeProductAnalyzer } from '../../server/src/decomposition/protectedTemplates/product/productPoster.fixture.js';
import { setup } from '../../server/src/decomposition/protectedTemplates/product/productServer.fixture.js';
import { HAS_PRIVATE_FIXTURES } from './privateFixtures.js';

type Box = { x: number; y: number; width: number; height: number };
const W = 600, H = 400;
const PRODUCTS: Record<string, Box> = { a: { x: 112, y: 150, width: 76, height: 92 }, b: { x: 172, y: 236, width: 48, height: 86 }, c: { x: 340, y: 196, width: 60, height: 96 }, d: { x: 430, y: 246, width: 40, height: 46 } };
const PODIUM = { x: 0, y: 330, width: 600, height: 70 };
/** The scene: stripes, a podium, a mint cylinder (products a, b), a pink platform (c, d), a cream riser with nothing on it;
 * on a larger canvas when asked (moved by `at`). */
const scene = (show: { products?: string[]; stands?: boolean; canvas?: { width: number; height: number; at: { x: number; y: number } }; scale?: number } = {}) => {
  const products = show.products ?? Object.keys(PRODUCTS), stands = show.stands ?? true, c = show.canvas ?? { width: W, height: H, at: { x: 0, y: 0 } }, k = show.scale ?? 1;
  const product = (k: string) => { const b = PRODUCTS[k]; return `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="3" fill="#1f2937"/><rect x="${b.x + 6}" y="${b.y + 6}" width="${b.width - 12}" height="${Math.round(b.height * 0.45)}" fill="#475569"/><circle cx="${b.x + b.width / 2}" cy="${b.y + b.height * 0.75}" r="${Math.min(b.width, b.height) * 0.16}" fill="#94a3b8"/>`; };
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${c.width * k}" height="${c.height * k}" viewBox="0 0 ${c.width} ${c.height}">
    <defs><pattern id="s" width="40" height="40" patternUnits="userSpaceOnUse"><rect width="40" height="40" fill="#fef3c7"/><rect width="20" height="40" fill="#fde68a"/></pattern>
      <linearGradient id="mint"><stop offset="0" stop-color="#d1fae5"/><stop offset="1" stop-color="#6ee7b7"/></linearGradient>
      <linearGradient id="pink"><stop offset="0" stop-color="#fce7f3"/><stop offset="1" stop-color="#f472b6"/></linearGradient></defs>
    <rect width="${c.width}" height="${c.height}" fill="url(#s)"/><g transform="translate(${c.at.x} ${c.at.y})">
    <ellipse cx="300" cy="334" rx="300" ry="18" fill="#f5e6c8"/><rect x="0" y="334" width="600" height="66" fill="#c2410c"/><rect x="0" y="352" width="600" height="6" fill="#fbbf24"/>
    ${stands ? `<rect x="100" y="236" width="100" height="96" fill="url(#mint)"/><ellipse cx="150" cy="236" rx="50" ry="7" fill="#ecfdf5"/>
    <rect x="300" y="288" width="200" height="36" fill="url(#pink)"/><ellipse cx="400" cy="288" rx="100" ry="8" fill="#fdf2f8"/>
    <rect x="525" y="280" width="50" height="44" fill="#fde2c4"/><rect x="560" y="280" width="15" height="44" fill="#f5c79a"/>` : ''}
    ${products.map(product).join('')}</g>
  </svg>`)).png().toBuffer();
};
const object = (id: string, kind: ProductObject['kind'], box: Box, z: number, extra: Partial<ProductObject> = {}): ProductObject =>
  ({ id, kind, label: kind === 'product' ? `Product ${id.slice(-1)}` : kind === 'podium' ? 'Podium' : id, box, confidence: 0.9, z, covers: [], origin: 'ai', review: { status: 'accepted', by: 'user' }, ...extra });
const objects = (extra: ProductObject[] = []) => [object('po-podium0000', 'podium', PODIUM, 0), ...extra, ...Object.entries(PRODUCTS).map(([k, b], i) => object(`po-product000${k}`, 'product', b, 10 + i))];
const prepare = async (list: ProductObject[]) => prepareProduct({ source: await decodeRgba(await scene()), analysis: undefined, objects: list, paidApproved: false, save: () => undefined });
const raw = async (png: Buffer) => (await sharp(png).removeAlpha().raw().toBuffer());
/** The template's layers drawn back to front: the base, the stands, the objects; some hidden or moved. */
async function compose(r: PrepareResult, hide: Set<string> = new Set(), move: Record<string, { dx: number; dy: number }> = {}) {
  const layers = [...r.stands.map((s, k) => ({ id: `stand-${k}`, png: s.png, at: s.placement })), ...r.cutouts.map(c => ({ id: c.id, png: c.png, at: c.placement }))];
  const png = await sharp(r.base).composite(layers.filter(l => !hide.has(l.id)).map(l => ({ input: l.png, left: l.at.x + (move[l.id]?.dx ?? 0), top: l.at.y + (move[l.id]?.dy ?? 0) }))).png().toBuffer();
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let transparent = 0; for (let i = 0; i < info.width * info.height; i++) if (data[i * info.channels + 3] !== undefined && info.channels === 4 && data[i * 4 + 3] < 255) transparent++;
  return { rgb: await raw(png), transparent, w: info.width, h: info.height };
}
const changedOutside = (a: Uint8Array, b: Uint8Array, w: number, h: number, boxes: Box[]) => {
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (boxes.some(r => x >= r.x - 1 && x <= r.x + r.width && y >= r.y - 1 && y <= r.y + r.height)) continue;
    const i = (y * w + x) * 3; if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  }
  return n;
};

describe('display stands on their own layers', { timeout: 180_000 }, () => {
  it('finds each stand under its products, completes it behind them, and keeps the podium in the background', async () => {
    const r = await prepare(objects());
    // The mint cylinder (under a and b) and the pink platform (under c and d); the cream riser has nothing on it.
    expect(r.stands).toHaveLength(2);
    const [mint, pink] = [...r.stands].sort((p, q) => p.placement.x - q.placement.x);
    expect(mint.under.sort()).toEqual(['po-product000a', 'po-product000b']);
    expect(pink.under.sort()).toEqual(['po-product000c', 'po-product000d']);
    expect(Math.abs(mint.placement.x - 100)).toBeLessThanOrEqual(3); expect(Math.abs(mint.placement.x + mint.placement.width - 200)).toBeLessThanOrEqual(3);
    expect(Math.abs(pink.placement.x - 300)).toBeLessThanOrEqual(3); expect(Math.abs(pink.placement.x + pink.placement.width - 500)).toBeLessThanOrEqual(3);
    expect(mint.completedPixels).toBeGreaterThan(1000);
    expect(r.quality.issues.find(i => i.id === 'stands')?.blocking).toBe(false);
    // The podium stays in the background (its band is in the base, untouched).
    const base = await raw(r.base), clean = await raw(r.clean);
    let same = 0, all = 0; for (let y = 345; y < 395; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; all++; if (Math.abs(base[i] - clean[i]) + Math.abs(base[i + 1] - clean[i + 1]) + Math.abs(base[i + 2] - clean[i + 2]) < 6) same++; }
    expect(same / all).toBeGreaterThan(0.99);
    // Recombined, it is the creative.
    expect(r.quality.original.visiblePercent).toBeLessThan(1);

    // Each product hidden: what was behind it is the scene without it (the stand completed), within a small error; nothing
    // else changes; no transparent pixel.
    const full = await compose(r);
    for (const [k, box] of Object.entries(PRODUCTS)) {
      const id = `po-product000${k}`, hidden = await compose(r, new Set([id])), truth = await raw(await scene({ products: Object.keys(PRODUCTS).filter(x => x !== k) }));
      expect(hidden.transparent, k).toBe(0);
      expect(changedOutside(full.rgb, hidden.rgb, W, H, [r.cutouts.find(c => c.id === id)!.placement]), k).toBe(0);
      // On the stand behind it: close to the truth (its colours continued).
      const on = (x: number, y: number) => r.stands.some(s => x >= s.placement.x + 2 && x < s.placement.x + s.placement.width - 2 && y >= s.placement.y + 10 && y < s.placement.y + s.placement.height - 3);
      let sum = 0, count = 0;
      for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) { if (!on(x, y)) continue; const i = (y * W + x) * 3; sum += Math.max(...[0, 1, 2].map(c => Math.abs(hidden.rgb[i + c] - truth[i + c]))); count++; }
      if (count) expect(sum / count, `stand behind ${k}`).toBeLessThan(14);
    }
    // Moved up, a product leaves its neighbours as they were.
    const moved = await compose(r, new Set(), { 'po-product000b': { dx: 0, dy: -40 } }), b = r.cutouts.find(c => c.id === 'po-product000b')!.placement;
    expect(changedOutside(full.rgb, moved.rgb, W, H, [b, { ...b, y: b.y - 40 }])).toBe(0);
    // Every product and stand hidden: the background (stripes rebuilt where they stood), opaque, none of the stands' colours left.
    const bare = await compose(r, new Set([...r.cutouts.map(c => c.id), 'stand-0', 'stand-1']));
    expect(bare.transparent).toBe(0);
    let pinkLeft = 0; for (let y = 292; y < 322; y++) for (let x = 305; x < 495; x++) { const i = (y * W + x) * 3; if (bare.rgb[i] > 200 && bare.rgb[i + 2] > 150 && bare.rgb[i + 1] < 160) pinkLeft++; }
    expect(pinkLeft).toBeLessThan(60);
  });

  it('follows the administrator: a box kept in the background, and a stand marked as its own layer', async () => {
    // "Part of the background" over the pink platform: only the mint cylinder is separated.
    const kept = await prepare(objects([object('po-hintback00', 'podium', { x: 296, y: 280, width: 210, height: 48 }, 1, { layer: 'background', origin: 'user' })]));
    expect(kept.stands.map(s => s.under.sort())).toEqual([['po-product000a', 'po-product000b']]);
    // "Its own layer" over the cream riser nothing stands on: separated too, named by its box.
    const marked = await prepare(objects([object('po-hintown000', 'podium', { x: 522, y: 276, width: 56, height: 50 }, 1, { layer: 'own', origin: 'user', label: 'Cream riser' })]));
    const cream = marked.stands.find(s => s.hint === 'po-hintown000')!;
    expect(cream).toMatchObject({ source: 'user', label: 'Cream riser' });
    expect(Math.abs(cream.placement.x - 525)).toBeLessThanOrEqual(3);
    expect(cream.visiblePixels).toBeGreaterThan(1800);
    expect(marked.stands).toHaveLength(3);
  });

  it('a large picture (the scene at 4×, 2400×1600): analysed on a working copy, each layer at full size, the same stands, nothing else changed', async () => {
    const k = 4, Wk = W * k, Hk = H * k, big = (b: Box) => ({ x: b.x * k, y: b.y * k, width: b.width * k, height: b.height * k });
    const started = Date.now();
    const r = await prepareProduct({ source: await decodeRgba(await scene({ scale: k })), analysis: undefined, objects: objects().map(o => ({ ...o, box: big(o.box) })), paidApproved: false, save: () => undefined });
    const ms = Date.now() - started;
    expect(r.stands).toHaveLength(2);
    const [mint, pink] = [...r.stands].sort((p, q) => p.placement.x - q.placement.x);
    expect(mint.under.sort()).toEqual(['po-product000a', 'po-product000b']);
    expect(pink.under.sort()).toEqual(['po-product000c', 'po-product000d']);
    for (const [st, x0, x1] of [[mint, 100, 200], [pink, 300, 500]] as const) {
      expect(Math.abs(st.placement.x - x0 * k)).toBeLessThanOrEqual(3 * k); expect(Math.abs(st.placement.x + st.placement.width - x1 * k)).toBeLessThanOrEqual(3 * k);
    }
    expect(r.quality.original.visiblePercent).toBeLessThan(1);
    const full = await compose(r);
    for (const [key, b] of Object.entries(PRODUCTS)) {
      // The cut-out's edges are the drawn product's at full size, with its one-pixel margin; where two products of the same
      // colour meet (b over a) nothing in the picture tells them apart, and the working copy's edge (one working pixel,
      // 4 px here) decides.
      const id = `po-product000${key}`, c = r.cutouts.find(x => x.id === id)!, B = big(b), tolerance = key === 'b' ? k + 1 : 2;
      expect(Math.abs(c.placement.x - B.x), key).toBeLessThanOrEqual(tolerance); expect(Math.abs(c.placement.y - B.y), key).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(c.placement.x + c.placement.width - B.x - B.width), key).toBeLessThanOrEqual(tolerance);
      // Hidden: nothing outside its own place changes, never a transparent pixel, the stand behind it close to the truth.
      const hidden = await compose(r, new Set([id])), truth = await raw(await scene({ products: Object.keys(PRODUCTS).filter(x => x !== key), scale: k }));
      expect(hidden.transparent, key).toBe(0);
      expect(changedOutside(full.rgb, hidden.rgb, Wk, Hk, [c.placement]), key).toBe(0);
      let sum = 0, count = 0;
      for (const st of r.stands) for (let y = Math.max(B.y, st.placement.y + 10 * k); y < Math.min(B.y + B.height, st.placement.y + st.placement.height - 3 * k); y++) for (let x = Math.max(B.x, st.placement.x + 2 * k); x < Math.min(B.x + B.width, st.placement.x + st.placement.width - 2 * k); x++) {
        const i = (y * Wk + x) * 3; sum += Math.max(...[0, 1, 2].map(ch => Math.abs(hidden.rgb[i + ch] - truth[i + ch]))); count++;
      }
      if (count) expect(sum / count, `stand behind ${key}`).toBeLessThan(14);
    }
    // Bounded (an analysis of all 3.84 million pixels took minutes on a real creative).
    expect(ms).toBeLessThan(60_000);
  });

  it.skipIf(!HAS_PRIVATE_FIXTURES)('on the real LG creative: six stands; each product or Ganesha hidden or moved leaves everything else as it was', async () => {
    const RECORDED = 'tests/fixtures/recorded/ganesh-lg-gpt-5.6-sol-2026-10-22';
    const sheet = readFileSync('Ganesh-Chaturthi.png'), crop = findSheetCreatives(await decodeRgba(sheet)).boxes[0];
    const png = await sharp(await sharp(sheet).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).png({ compressionLevel: 9 }).toBuffer()).png().toBuffer(), source = await decodeRgba(png);
    const analyzer = replayProductAnalyzer({ response: JSON.parse(readFileSync(`${RECORDED}.response.json`, 'utf8')), model: 'gpt-5.6-sol', imageSha256: createHash('sha256').update(png).digest('hex') });
    const d = await detectProduct({ template: { id: 'pt-replay', source: { sha256: 'replay' } } as never, source, png, recognizer: fakeRecognizer([]), analyzer, store: () => undefined, save: () => undefined, at: '2026-10-22T00:00:00.000Z' });
    // (The soundbar's box drawn again where it is, under the screen, as in the review: the answer put it on the speakers.)
    const list = d.objects.map(o => ({ ...o, review: { status: 'accepted' as const, by: 'user' as const }, ...(o.label === 'Soundbar' ? { box: { x: 290, y: 345, width: 66, height: 8 } } : {}) }));
    const r = await prepareProduct({ source, analysis: d.analysis, objects: list, paidApproved: false, save: () => undefined });
    const label = (id: string) => list.find(o => o.id === id)!.label;
    // Under the microwave, the purifier, the dishwasher, the AC (a tall cylinder), the TV's sound set, the washer and fridge.
    expect(r.stands).toHaveLength(6);
    const on = r.stands.map(s => s.under.map(label));
    for (const product of ['Microwave oven', 'Air purifier', 'Refrigerator or tall kitchen appliance', 'Split air conditioner indoor unit', 'Tower speaker', 'Front-load washing machine', 'Multi-door refrigerator'])
      expect(on.some(u => u.includes(product)), product).toBe(true);
    // The shared podium is no stand: every stand ends above its front band.
    const podium = list.find(o => o.kind === 'podium')!.box;
    for (const s of r.stands) expect(s.placement.y + s.placement.height).toBeLessThanOrEqual(podium.y + 4);
    expect(r.quality.issues.filter(i => i.blocking)).toEqual([]);
    const W0 = source.width, H0 = source.height, full = await compose(r);
    expect(full.transparent).toBe(0);
    for (const c of r.cutouts) {
      const hidden = await compose(r, new Set([c.id]));
      expect(changedOutside(full.rgb, hidden.rgb, W0, H0, [c.placement]), `hiding ${label(c.id)}`).toBe(0);
      const moved = await compose(r, new Set(), { [c.id]: { dx: 0, dy: -50 } });
      expect(changedOutside(full.rgb, moved.rgb, W0, H0, [c.placement, { ...c.placement, y: c.placement.y - 50 }]), `moving ${label(c.id)}`).toBe(0);
    }
    // Each stand moved or hidden on its own: nothing changes outside its old and new places (the products standing on it
    // stay put), nothing is transparent, and the background under it holds no copy of it.
    const clean = await raw(r.clean), base = await raw(r.base);
    for (const [k, s] of r.stands.entries()) {
      for (const [dx, dy] of [[0, -30], [24, 0]]) {
        const moved = await compose(r, new Set(), { [`stand-${k}`]: { dx, dy } });
        expect(moved.transparent, s.label).toBe(0);
        expect(changedOutside(full.rgb, moved.rgb, W0, H0, [s.placement, { ...s.placement, x: s.placement.x + dx, y: s.placement.y + dy }]), `moving ${s.label}`).toBe(0);
      }
      const { data, info } = await sharp(s.png).raw().toBuffer({ resolveWithObject: true });
      let seen = 0, same = 0;
      for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
        const a = (y * info.width + x) * 4; if (data[a + 3] < 250) continue;
        const i = ((y + s.placement.y) * W0 + x + s.placement.x) * 3; if (Math.max(...[0, 1, 2].map(c => Math.abs(clean[i + c] - data[a + c]))) > 2) continue;
        seen++; if (Math.max(...[0, 1, 2].map(c => Math.abs(base[i + c] - data[a + c]))) <= 12) same++;
      }
      expect(same / Math.max(1, seen), `a copy of ${s.label} left in the background`).toBeLessThan(0.35);
    }
    // The shared podium stays in the background, untouched: its band is the clean picture's own pixels wherever no
    // product, character or stand was taken out, and no stand reaches into it.
    let band = 0, kept = 0;
    for (let y = podium.y + 6; y < Math.min(H0, podium.y + podium.height); y++) for (let x = 0; x < W0; x++) {
      if ([...r.cutouts.map(c => c.placement), ...r.stands.map(t => t.placement)].some(b => x >= b.x - 2 && x < b.x + b.width + 2 && y >= b.y - 2 && y < b.y + b.height + 2)) continue;
      const i = (y * W0 + x) * 3; band++; if (base[i] === clean[i] && base[i + 1] === clean[i + 1] && base[i + 2] === clean[i + 2]) kept++;
    }
    expect(band).toBeGreaterThan(15000);
    expect(kept / band).toBe(1);
    // With every product and character hidden, the stands are whole: where products stood on them, the stand (not the
    // striped background) shows: the stand's layer is opaque over the product's place.
    for (const s of r.stands.filter(x => x.completedPixels > 100)) {
      const { data, info } = await sharp(s.png).raw().toBuffer({ resolveWithObject: true });
      let opaque = 0; for (let i = 0; i < info.width * info.height; i++) if (data[i * 4 + 3] === 255) opaque++;
      expect(opaque, s.label).toBeGreaterThanOrEqual((s.visiblePixels + s.completedPixels) * 0.9);
    }
  });

  it('through the service: stands prepared as layers, saved in the revision, in a creative under the products; corrected in the review', async () => {
    // On the fixture's canvas (its fake word reader's words fall on the stripes, away from the scene).
    const canvas = { width: 1000, height: 1200, at: { x: 200, y: 500 } }, frac = (b: Box) => ({ x: (b.x + canvas.at.x) / canvas.width, y: (b.y + canvas.at.y) / canvas.height, w: b.width / canvas.width, h: b.height / canvas.height, certainty: 'tight' });
    const thing = (id: string, kind: string, category: string, b: Box) => ({ id, kind, importance: kind === 'product' ? 'main' : 'supporting', category, description: category, box: frac(b), occluded: false, properties: [], identity: { brand: '', model: '', evidence: '', confidence: 0, markings: 'none' }, confidence: 0.9 });
    const answer = { summary: 'Four appliances on stands on a podium.', objects: [...Object.entries(PRODUCTS).map(([k, b]) => thing(`product_${k}`, 'product', `appliance ${k}`, b)), thing('furniture_1', 'furniture', 'podium', PODIUM)],
      relations: [], marks: [], text_overlays: [], lighting: { direction: 'front', quality: 'soft', color: 'warm' }, main_candidates: [], advertised_ids: [], uncertainties: [] };
    const s = await setup({ analyzer: fakeProductAnalyzer(answer) });
    try {
      const at = (b: Box) => ({ x: b.x + canvas.at.x, y: b.y + canvas.at.y, width: b.width, height: b.height });
      const made = await s.form('', await scene({ canvas }), { name: 'Stands' });
      let v = await s.detected(made.body.template.id);
      const id = v.template.id;
      expect(v.product.objects.filter(o => o.kind === 'product')).toHaveLength(4);
      const reviewOf = (extra: object[] = []) => ({ expectedRevision: v.template.revision, objects: [...v.product.objects.filter(o => o.kind !== 'podium' || !o.layer).map(o => ({ id: o.id, kind: o.kind, label: o.label, box: o.box, accepted: true })), ...extra], texts: [], logos: [], dismissMissingText: true });
      const prepareNow = async () => { expect((await s.send('POST', `/${id}/prepare`, { expectedRevision: v.template.revision })).status).toBe(202); v = await s.prepared(id); expect(v.stage, JSON.stringify(v.product.preparing)).toBe('prepared'); return v.product.prepared!; };
      v = (await s.send('PUT', `/${id}/review`, reviewOf())).body;
      let p = await prepareNow();
      // Two stands, each its own layer under every product, its picture stored.
      expect(p.stands).toHaveLength(2);
      const lowest = Math.min(...v.product.objects.filter(o => o.kind === 'product').map(o => o.z));
      for (const st of p.stands!) {
        expect(st).toMatchObject({ kind: 'podium', layer: 'own', origin: 'local', cutout: { method: 'local' } });
        expect(st.id).toMatch(/^po-[a-f0-9]{10}$/);
        expect(st.z).toBeLessThan(lowest);
        expect((await s.fetchFile(id, st.cutout!.file)).headers.get('content-type')).toBe('image/png');
      }
      expect(p.stands!.map(st => st.stand.under.length)).toEqual([2, 2]);
      // Saved: the revision has the four products and the two stands; a creative draws the stands under the products.
      v = (await s.send('POST', `/${id}/approve`, { expectedRevision: v.template.revision, acknowledge: p.quality.issues.map(i => i.id) })).body;
      v = (await s.send('POST', `/${id}/publish`, { expectedRevision: v.template.revision })).body;
      const r1 = (await s.call<{ objects: { id: string; kind: string; z: number; cutout?: object }[] }>(`/${id}/revisions/1`)).body;
      expect(r1.objects.filter(o => o.kind === 'podium')).toHaveLength(2);
      expect(r1.objects.filter(o => o.kind === 'product')).toHaveLength(4);
      const creative = (await s.send<{ objects: { objectId: string; kind: string; z: number; hidden: boolean }[] }>('POST', `/${id}/creatives`, {})).body;
      const stands = creative.objects.filter(o => o.kind === 'podium'), products = creative.objects.filter(o => o.kind === 'product');
      expect(stands).toHaveLength(2);
      expect(Math.max(...stands.map(o => o.z))).toBeLessThan(Math.min(...products.map(o => o.z)));
      // Corrected in the review: the pink platform kept in the background; the cream riser marked as its own layer.
      const pink = p.stands!.find(st => st.box.x > canvas.at.x + 250)!;
      v = (await s.send('PUT', `/${id}/review`, reviewOf([
        { kind: 'podium', label: 'Pink platform (background)', box: { x: pink.box.x - 2, y: pink.box.y - 2, width: pink.box.width + 4, height: pink.box.height + 4 }, accepted: true, layer: 'background' },
        { kind: 'podium', label: 'Cream riser', box: at({ x: 522, y: 276, width: 56, height: 50 }), accepted: true, layer: 'own' }]))).body;
      expect(v.product.objects.filter(o => o.layer).map(o => [o.label, o.layer])).toEqual(expect.arrayContaining([['Pink platform (background)', 'background'], ['Cream riser', 'own']]));
      p = await prepareNow();
      const hint = v.product.objects.find(o => o.label === 'Cream riser')!;
      expect(p.stands!.map(st => st.label).sort()).toEqual(['Cream riser', 'Stand under the Appliance a and Appliance b']);
      expect(p.stands!.find(st => st.label === 'Cream riser')).toMatchObject({ id: hint.id, origin: 'user' });
    } finally { await s.close(); }
  });
});
