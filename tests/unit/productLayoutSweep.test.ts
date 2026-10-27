import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { ProductCreative, TextAnalysis } from '@frameflow/shared';
import { fillOverlayPixels, overlayMask } from '../../server/src/decomposition/protectedTemplates/product/prepare.js';
import { applyRatioLayout, planRatio, ratioBackground } from '../../server/src/decomposition/protectedTemplates/product/ratioLayout.js';
import { wrapToGroup } from '../../server/src/decomposition/protectedTemplates/product/variations.js';
import { fontMeasure } from '../../server/src/decomposition/protectedTemplates/product/ratioLayout.js';
import { decodeRgba } from '../../server/src/decomposition/protectedTemplates/pixels.js';

const rgba = async (svg: string) => decodeRgba(await sharp(Buffer.from(svg)).png().toBuffer());
const word = (id: string, text: string, box: { x: number; y: number; width: number; height: number }) => ({ id, text, box: { ...box, rotation: 0 }, origin: 'ai', review: { status: 'approved' }, groupId: 'g', lineId: 'l', order: 0,
  style: { color: '#ffffff', fontFamily: 'Inter', fontSize: 14, fontWeight: 600, fontStyle: 'normal', baseline: 11, letterSpacing: 0, lineHeight: 1.2, opacity: 1, align: 'left', fontMatch: 'estimated' } });

describe('clean template: text on a plain plate leaves no marks', () => {
  it('sweeps anti-aliased edges and punctuation outside tight word boxes; dividers and artwork beside the plate stay', async () => {
    // A teal pill with white text: the AI boxes are tight and the ink colour was measured as a blend of the small text's
    // edges (as on an 8 px line), so the ink mask alone misses the letters' white cores; a divider and an ornament beside it.
    const source = await rgba(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><rect width="240" height="60" fill="#ffffff"/><rect x="10" y="10" width="220" height="40" rx="20" fill="#0f6b5c"/>
      <text x="30" y="36" font-family="Helvetica" font-weight="700" font-size="16" fill="#ffffff">Validity: Till</text><rect x="140" y="20" width="2" height="20" fill="#9aa5a3"/><circle cx="200" cy="30" r="6" fill="#f59e0b"/></svg>`);
    const blend = (w: ReturnType<typeof word>) => ({ ...w, style: { ...w.style, color: '#8fbcb4' } });
    // The words' real ink (columns with white in them); the first box starts 7 px right of its ink ("Va" outside it, as
    // with the handmade Ganesh boxes), the rest 2 px tighter than the ink.
    const inkCols = Array.from({ length: 240 }, (_, x) => Array.from({ length: 24 }, (_, k) => source.data[((18 + k) * 240 + x) * 4] > 200 && source.data[((18 + k) * 240 + x) * 4 + 2] > 200).some(Boolean));
    const cols = inkCols.flatMap((on, x) => (on && x > 15 && x < 135 ? [x] : [])), gaps = cols.slice(1).map((x, i) => ({ at: cols[i], size: x - cols[i] })).sort((a, b) => b.size - a.size);
    const split = gaps[0].at, left = cols[0], right = cols.at(-1)!, next = cols.find(x => x > split)!;
    const analysis = { words: [blend(word('w1', 'Validity:', { x: left + 7, y: 24, width: split - left - 9, height: 14 })), blend(word('w2', 'Till', { x: next + 2, y: 24, width: right - next - 4, height: 14 }))],
      groups: [{ id: 'g', lines: [{ id: 'l', wordIds: ['w1', 'w2'] }] }], logoSlots: [], plates: [] } as unknown as TextAnalysis;
    const o = overlayMask(source, analysis);
    expect(o.sweep).toHaveLength(1);
    const rgb = new Uint8Array(source.width * source.height * 3);
    for (let i = 0; i < source.width * source.height; i++) rgb.set(source.data.subarray(i * 4, i * 4 + 3), i * 3);
    const filled = fillOverlayPixels(rgb, source.width, source.height, o.mask, [...analysis.words.map(w => ({ id: w.id, box: w.box })), ...o.sweep]);
    // Inside the pill, from the text's left edge to before the divider: only the pill's teal remains.
    let marks = 0;
    for (let y = 18; y < 42; y++) for (let x = 24; x < 134; x++) { const i = (y * 240 + x) * 3; if (Math.max(Math.abs(filled.rgb[i] - 0x0f), Math.abs(filled.rgb[i + 1] - 0x6b), Math.abs(filled.rgb[i + 2] - 0x5c)) > 16) marks++; }
    expect(marks).toBe(0);
    // The divider and the ornament are the plate's own: unchanged.
    for (const [x, y] of [[140, 30], [141, 25], [200, 30]]) { const i = (y * 240 + x) * 3; expect([...filled.rgb.subarray(i, i + 3)]).toEqual([...rgb.subarray(i, i + 3)]); }
  });
  it('on busy artwork takes only marks in the text\'s ink colour joined to its letters, never the artwork', async () => {
    const stripes = Array.from({ length: 24 }, (_, i) => `<rect x="${i * 10}" y="0" width="5" height="60" fill="#e5f5c0"/>`).join('');
    const source = await rgba(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><rect width="240" height="60" fill="#c8e88a"/>${stripes}<text x="30" y="36" font-family="Helvetica" font-size="16" fill="#1f2937">Get 26%</text></svg>`);
    const analysis = { words: [{ ...word('w1', 'Get', { x: 30, y: 24, width: 28, height: 14 }), style: { ...word('w1', '', { x: 0, y: 0, width: 1, height: 1 }).style, color: '#1f2937' } }], groups: [{ id: 'g', lines: [{ id: 'l', wordIds: ['w1'] }] }], logoSlots: [], plates: [] } as unknown as TextAnalysis;
    // "26%" is drawn but not in the analysis (missed letters joined to "Get"); the stripes are artwork.
    const { mask } = overlayMask(source, analysis);
    let artwork = 0, ink = 0;
    for (let i = 0; i < source.width * source.height; i++) {
      if (!mask[i]) continue;
      const [r, g, b] = [source.data[i * 4], source.data[i * 4 + 1], source.data[i * 4 + 2]];
      if (Math.max(Math.abs(r - 0xe5), Math.abs(g - 0xf5), Math.abs(b - 0xc0)) <= 6 || Math.max(Math.abs(r - 0xc8), Math.abs(g - 0xe8), Math.abs(b - 0x8a)) <= 6) artwork++;
      else ink++;
    }
    expect(ink).toBeGreaterThan(50);
    // Only the 1 px soft rim the ink mask always adds around letters may touch stripe pixels; no stripe is taken.
    expect(artwork / Math.max(1, ink + artwork)).toBeLessThan(0.45);
    let stripeTaken = 0; for (let y = 0; y < 60; y++) for (let x = 150; x < 240; x++) if (mask[y * 240 + x]) stripeTaken++;
    expect(stripeTaken).toBe(0);
  });
  it('on artwork, refills only where the marks it added are, not the line\'s padded band', async () => {
    // The band reaches a quarter line above and below the words: on a pill whose rim is near its text, past the rim into the
    // page, whose colour was then read into the letters (mint letters on the orange "What to expect this Onam?" pill).
    const stripes = Array.from({ length: 24 }, (_, i) => `<rect x="${i * 10}" y="0" width="5" height="60" fill="#e5f5c0"/>`).join('');
    const source = await rgba(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><rect width="240" height="60" fill="#c8e88a"/>${stripes}<text x="30" y="36" font-family="Helvetica" font-size="16" fill="#1f2937">Get 26%</text></svg>`);
    const analysis = { words: [{ ...word('w1', 'Get', { x: 30, y: 24, width: 28, height: 14 }), style: { ...word('w1', '', { x: 0, y: 0, width: 1, height: 1 }).style, color: '#1f2937' } }], groups: [{ id: 'g', lines: [{ id: 'l', wordIds: ['w1'] }] }], logoSlots: [], plates: [] } as unknown as TextAnalysis;
    const { sweep } = overlayMask(source, analysis);
    // The rows of the line's ink ("Get 26%"): the area to refill lies within them (a pixel of soft edge either side).
    const inkRows = Array.from({ length: 60 }, (_, y) => Array.from({ length: 240 }, (_, x) => source.data[(y * 240 + x) * 4] < 0x70).some(Boolean)).flatMap((on, y) => (on ? [y] : []));
    const area = sweep.find(s => !s.plain);
    expect(area).toBeDefined();
    expect(area!.box.y).toBeGreaterThanOrEqual(inkRows[0] - 2);
    expect(area!.box.y + area!.box.height).toBeLessThanOrEqual(inkRows.at(-1)! + 3);
  });
});

describe('variations in other aspect ratios: nothing stretched, plain margins lengthened, the rest flagged', () => {
  const page = (busyEdges: boolean) => rgba(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#ffffff"/>
    <rect x="${busyEdges ? 0 : 20}" y="40" width="${busyEdges ? 200 : 160}" height="120" fill="#bdf0dc"/>${busyEdges ? Array.from({ length: 10 }, (_, i) => `<rect x="0" y="${i * 20}" width="200" height="10" fill="#ff7700"/>`).join('') : ''}</svg>`);
  it('lengthens the white header and footer for 9:16 (exact) and spreads what sat in them evenly', async () => {
    const base = await page(false), layout = planRatio(base, '9:16');
    expect(layout).toMatchObject({ method: 'plain-bands', axis: 'y', target: { width: 200, height: 356 }, bands: { start: 40, end: 160 } });
    expect(layout.extra.before + layout.extra.after).toBe(156);
    const bg = await ratioBackground(await sharp(base.data, { raw: { width: 200, height: 200, channels: 4 } }).png().toBuffer(), layout);
    const px = await decodeRgba(bg.png);
    expect([px.width, px.height, bg.filledPercent]).toEqual([200, 356, 0]);
    const at = (x: number, y: number) => [...px.data.subarray((y * 200 + x) * 4, (y * 200 + x) * 4 + 3)];
    expect(at(100, 5)).toEqual([255, 255, 255]); expect(at(100, 350)).toEqual([255, 255, 255]);
    expect(at(100, 40 + layout.extra.before + 60)).toEqual([0xbd, 0xf0, 0xdc]);
    // A logo in the header, a product on the panel, two footer rows: the header logo ends centred in its longer header.
    const c = { canvas: { width: 200, height: 200 }, groups: [], texts: [], shapes: [], objects: [{ id: 'po-a', objectId: 'po-a', kind: 'product', label: 'P', asset: { kind: 'template', file: 'p.png' }, box: { x: 80, y: 80, width: 40, height: 60 }, hidden: false, z: 0 }],
      images: [{ id: 'ci-1', box: { x: 10, y: 10, width: 40, height: 20, rotation: 0 } }, { id: 'ci-2', box: { x: 10, y: 165, width: 40, height: 10, rotation: 0 } }, { id: 'ci-3', box: { x: 10, y: 182, width: 40, height: 10, rotation: 0 } }] } as unknown as ProductCreative;
    const out = applyRatioLayout(c, layout);
    expect(out.canvas).toEqual({ width: 200, height: 356 });
    expect(out.objects[0].box.y).toBe(80 + layout.extra.before);
    const header = out.images[0].box, top = header.y, below = 40 + layout.extra.before - (header.y + header.height);
    expect(Math.abs(top - below)).toBeLessThanOrEqual(12);
    expect(out.images[1].box.y).toBeLessThan(out.images[2].box.y);
    expect(out.images[2].box.y + out.images[2].box.height).toBeLessThanOrEqual(356);
    expect(out.layout).toMatchObject({ aspectRatio: '9:16', axis: 'y', sourceCanvas: { width: 200, height: 200 } });
  });
  it('adds plain margins (flagged in the share) when the artwork reaches the edges; a thin border is never stretched', async () => {
    const base = await page(true), layout = planRatio(base, '16:9');
    const framed = await rgba('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#bdf0dc"/><rect x="3" y="3" width="194" height="194" fill="none" stroke="#ff7700" stroke-width="6"/><circle cx="100" cy="100" r="60" fill="#334155"/></svg>');
    expect(planRatio(framed, '9:16').method).toBe('letterbox');
    expect(layout).toMatchObject({ method: 'letterbox', axis: 'x', target: { width: 356, height: 200 } });
    const bg = await ratioBackground(await sharp(base.data, { raw: { width: 200, height: 200, channels: 4 } }).png().toBuffer(), layout);
    expect(bg.filledPercent).toBeGreaterThan(40);
    expect(planRatio(base, 'original').method).toBe('template');
    expect(planRatio(base, '1:1').method).toBe('template');
  });
  it('wraps a typed headline to the group\'s width, over its own number of lines', () => {
    const style = { fontFamily: 'Poppins', fontWeight: 700 as const, fontStyle: 'normal' as const, fontSize: 24, letterSpacing: 0, color: '#ffffff', opacity: 1 };
    const t = (id: string, text: string, line: number, x: number) => ({ id, wordId: null, groupId: 'g', line, order: 0, text, x, baselineY: 100 + line * 28, rotation: 0, style, hidden: false, locked: false, z: 0 });
    const c = { groups: [{ id: 'g', label: '', category: 'headline', masterGroupId: null, align: 'left' }],
      texts: [t('a', 'A', 0, 250), t('b', 'grand', 0, 275), t('c', 'welcome', 1, 150), t('d', 'for', 1, 270), t('e', 'Bappa', 1, 310), t('f', 'calls', 1, 395), t('g', 'for', 2, 146), t('h', 'equally', 2, 187), t('i', 'grand', 2, 285), t('j', 'savings.', 2, 366)] } as unknown as ProductCreative;
    const wrapped = wrapToGroup(c, 'g', 'A grand welcome for Bappa brings bigger savings', fontMeasure);
    expect(wrapped.split('\n').length).toBeGreaterThanOrEqual(2);
    expect(wrapped.replace(/\n/g, ' ')).toBe('A grand welcome for Bappa brings bigger savings');
    const widest = Math.max(...wrapped.split('\n').map(l => fontMeasure(l, style)));
    expect(widest).toBeLessThanOrEqual((366 + fontMeasure('savings.', style) - 146) * 1.02);
    expect(wrapToGroup(c, 'g', 'Line one\nLine two', fontMeasure)).toBe('Line one\nLine two');
  });
});
