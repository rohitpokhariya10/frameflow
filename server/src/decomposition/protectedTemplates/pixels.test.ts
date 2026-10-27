import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { ProtectedElement } from '@frameflow/shared';
import { baseChecks, decodeRgba, extractRaster, flattenRgb, ingestImage, localFill, reconstruct, type ProtectedVisual } from './pixels.js';

const W = 800, H = 1000;
const svg = (body: string, w = W, h = H) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)).png().toBuffer();
const GRADIENT = '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b6e79"/><stop offset="1" stop-color="#14a3a8"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>';
const LOGO = '<rect x="60" y="60" width="220" height="90" rx="14" fill="#f4f1e8"/><circle cx="110" cy="105" r="28" fill="#c8102e"/><rect x="150" y="90" width="110" height="30" fill="#1d2a6b"/>';
const HEADLINE = '<text x="60" y="420" font-family="Helvetica, Arial, sans-serif" font-size="64" font-weight="700" fill="#ffffff">Easy EMI</text>';
const element = (id: string, box: ProtectedElement['box'], over: Partial<ProtectedElement> = {}): ProtectedElement => ({ id, kind: 'logo', label: id, box, normalized: { x: 0, y: 0, width: 0, height: 0 }, zIndex: 0,
  representation: 'raster', mask: { mode: 'difference', threshold: 24 }, locked: true, replaceable: true, origin: 'admin', review: { status: 'approved' }, ...over });
const logo = element('pe-0000000001', { x: 50, y: 50, width: 240, height: 110, rotation: 0 });
const headline = element('pe-0000000002', { x: 50, y: 360, width: 330, height: 80, rotation: 0 }, { kind: 'text', zIndex: 1 });

describe('protected pixels', () => {
  it('refuses unreadable and too-small images before anything else, and applies EXIF orientation once', async () => {
    await expect(ingestImage(Buffer.from('not an image'), 'source creative')).rejects.toMatchObject({ code: 'UNREADABLE_IMAGE' });
    await expect(ingestImage(await svg(GRADIENT, 200, 200), 'source creative', { minSide: 256 })).rejects.toMatchObject({ code: 'IMAGE_TOO_SMALL' });
    const rotated = await sharp(await svg(GRADIENT, 600, 900)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const ingested = await ingestImage(rotated, 'source creative', { seedream: true });
    expect(ingested).toMatchObject({ width: 900, height: 600, orientationNormalized: true });
  });

  it('keeps every fully protected pixel exact and unmixes anti-aliased edges against a clean base (measured, not assumed)', async () => {
    const source = await decodeRgba(await svg(GRADIENT + LOGO + HEADLINE)), base = await decodeRgba(await svg(GRADIENT));
    for (const e of [logo, headline]) {
      const raster = await extractRaster(source, base, e), alpha = await decodeRgba(raster.png);
      expect(raster.placement).toEqual({ x: e.box.x, y: e.box.y, width: e.box.width, height: e.box.height });
      let opaque = 0, exact = 0, worst = 0;
      const over = flattenRgb(base), src = flattenRgb(source);
      for (let y = 0; y < raster.placement.height; y++) for (let x = 0; x < raster.placement.width; x++) {
        const j = (y * raster.placement.width + x) * 4, i = ((raster.placement.y + y) * W + raster.placement.x + x);
        const a = alpha.data[j + 3] / 255;
        if (alpha.data[j + 3] === 255) { opaque++; if ([0, 1, 2].every(c => alpha.data[j + c] === source.data[i * 4 + c])) exact++; }
        // Composited over the clean base, the raster reproduces the source (edges within a measured bound).
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(Math.round(alpha.data[j + c] * a + over[i * 3 + c] * (1 - a)) - src[i * 3 + c]));
      }
      expect(opaque).toBeGreaterThan(200);
      expect(exact).toBe(opaque);
      // Largest channel error of the restored region over its clean base. Measured 2026-10-19: logo 1, anti-aliased
      // headline 11 (mean 0.011) at threshold 24; the margin allows for font rasterisation on other machines.
      expect(worst).toBeLessThanOrEqual(e === logo ? 2 : 16);
      expect(raster.protectedPercent).toBeLessThan(e === logo ? 95 : 40);
    }
  });

  it('gives a rotated region alpha 0 outside its polygon and never resamples the pixels it keeps', async () => {
    const source = await decodeRgba(await svg(GRADIENT + LOGO)), base = await decodeRgba(await svg(GRADIENT));
    const raster = await extractRaster(source, base, { box: { x: 60, y: 60, width: 220, height: 90, rotation: 30 }, mask: { mode: 'opaque', threshold: 24 } });
    const px = await decodeRgba(raster.png);
    expect(px.data[3]).toBe(0); // the rectangle's top-left corner lies outside the rotated box
    const cx = Math.floor(raster.placement.width / 2), cy = Math.floor(raster.placement.height / 2), j = (cy * raster.placement.width + cx) * 4, i = ((raster.placement.y + cy) * W + raster.placement.x + cx) * 4;
    expect([px.data[j], px.data[j + 1], px.data[j + 2], px.data[j + 3]]).toEqual([source.data[i], source.data[i + 1], source.data[i + 2], 255]);
  });

  it('continues a plain gradient under protected regions as trusted, and marks a textured background as an estimate', async () => {
    const plain = await localFill(await decodeRgba(await svg(GRADIENT + LOGO + HEADLINE)), [logo, headline]);
    expect(plain.regions.map(r => [r.method, r.trusted])).toEqual([['plain-field', true], ['plain-field', true]]);
    // The fill matches the true background closely where the logo was.
    const truth = flattenRgb(await decodeRgba(await svg(GRADIENT))), filled = flattenRgb(await decodeRgba(plain.png));
    let worst = 0; for (let y = 60; y < 150; y++) for (let x = 60; x < 280; x++) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(filled[(y * W + x) * 3 + c] - truth[(y * W + x) * 3 + c]));
    expect(worst).toBeLessThanOrEqual(6);
    const noise = Buffer.alloc(W * H * 3); let seed = 7;
    for (let i = 0; i < noise.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noise[i] = 60 + (seed % 140); }
    const photo = await sharp(noise, { raw: { width: W, height: H, channels: 3 } }).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${LOGO}</svg>`) }]).png().toBuffer();
    const textured = await localFill(await decodeRgba(photo), [logo]);
    expect(textured.regions).toEqual([expect.objectContaining({ method: 'smooth-fill', trusted: false, elementIds: [logo.id] })]);
    expect(textured.regions[0].reason).toMatch(/unknown/);
  });

  it('distrusts a fill whose box cuts through the text it should cover, and says to enlarge it', async () => {
    // The headline's box stops halfway through its letters: their lower halves remain at its edge.
    const cut = await localFill(await decodeRgba(await svg(GRADIENT + HEADLINE)), [{ id: 'pe-0000000009', box: { x: 50, y: 330, width: 330, height: 50, rotation: 0 } }]);
    expect(cut.regions[0]).toMatchObject({ trusted: false });
    expect(cut.regions[0].edgeContentPercent).toBeGreaterThan(3);
    expect(cut.regions[0].reason).toMatch(/Enlarge it to cover the whole element/);
    const whole = await localFill(await decodeRgba(await svg(GRADIENT + HEADLINE)), [headline]);
    expect(whole.regions[0]).toMatchObject({ trusted: true, edgeContentPercent: 0 });
  });

  it('notices a "clean" base that still contains the protected content', async () => {
    const source = await decodeRgba(await svg(GRADIENT + LOGO + HEADLINE));
    const clean = baseChecks(source, await decodeRgba(await svg(GRADIENT)), [logo, headline]);
    expect(clean.checks.map(c => c.differsFromSource)).toEqual([true, true]);
    expect(clean.outsideMeanDiff).toBe(0);
    const stillHasLogo = baseChecks(source, await decodeRgba(await svg(GRADIENT + LOGO)), [logo, headline]);
    expect(stillHasLogo.checks.map(c => c.differsFromSource)).toEqual([false, true]);
  });

  it('reconstructs Seedream layers plus protected visuals, measures them, and suspects a duplicate when Seedream redraws a removed logo', async () => {
    const sourcePng = await svg(GRADIENT + LOGO + HEADLINE), source = await decodeRgba(sourcePng), base = await decodeRgba(await svg(GRADIENT));
    const visuals: ProtectedVisual[] = [];
    for (const e of [logo, headline]) { const r = await extractRaster(source, base, e); visuals.push({ element: e, png: r.png, placement: { kind: 'raster', rect: r.placement } }); }
    const faithful = await reconstruct({ source, base, seedream: base, visuals, elements: [logo, headline] });
    for (const p of faithful.metrics.protected) expect(p.opaqueExactPercent).toBe(100);
    expect(faithful.metrics.outsideProtected.meanAbsDiff).toBe(0);
    expect(faithful.duplicates.every(d => !d.suspected)).toBe(true);
    // Seedream returned the logo inside its own layers although it was removed from the base.
    const redrawn = await reconstruct({ source, base, seedream: await decodeRgba(await svg(GRADIENT + LOGO)), visuals, elements: [logo, headline] });
    expect(redrawn.duplicates.find(d => d.elementId === logo.id)?.suspected).toBe(true);
    expect(redrawn.duplicates.find(d => d.elementId === headline.id)?.suspected).toBe(false);
  });

  it('places an original logo file inside its box without distorting it', async () => {
    const source = await decodeRgba(await svg(GRADIENT)), asset = await svg('<rect width="200" height="100" fill="#c8102e"/>', 200, 100);
    const box = { x: 100, y: 100, width: 300, height: 300, rotation: 0 };
    const { png } = await reconstruct({ source, base: source, seedream: source, visuals: [{ element: { ...logo, box, representation: 'source-asset' }, png: asset, placement: { kind: 'box', box } }], elements: [] });
    const out = flattenRgb(await decodeRgba(png)), red = (x: number, y: number) => out[(y * W + x) * 3] > 180 && out[(y * W + x) * 3 + 1] < 40;
    // Contain: 300×150, centred vertically in the 300×300 box.
    expect(red(250, 180)).toBe(true); expect(red(250, 320)).toBe(true); expect(red(250, 160)).toBe(false); expect(red(250, 340)).toBe(false);
  });
});
