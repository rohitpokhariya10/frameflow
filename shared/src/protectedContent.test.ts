import { describe, expect, it } from 'vitest';
import { boundingBox, boxCorners, centreRotationToOrigin, elementProblems, elementsProblems, fromNormalized, geometryChanged, insideBox, mapBox, normalizeBox, onCanvasShare, pixelBounds,
  protectedEditorCanvas, sameAspect, withNormalized, type ProtectedElement, type SourceBox } from './protectedContent.js';

const element = (over: Partial<ProtectedElement> = {}): ProtectedElement => ({ id: 'pe-0123456789', kind: 'logo', label: 'HDFC logo', box: { x: 100, y: 200, width: 300, height: 120, rotation: 0 },
  normalized: { x: 0, y: 0, width: 0, height: 0 }, zIndex: 0, representation: 'raster', mask: { mode: 'difference', threshold: 24 }, locked: true, replaceable: true, origin: 'admin',
  review: { status: 'approved' }, ...over });
const SIZES = { portrait: { width: 1820, height: 2420 }, landscape: { width: 1920, height: 1080 }, square: { width: 1080, height: 1080 } };

describe('protected content coordinates (canonical: source pixels)', () => {
  for (const [name, size] of Object.entries(SIZES)) {
    it(`round-trips source → normalized → source and every export size exactly on a ${name} source`, () => {
      const box: SourceBox = { x: 137.25, y: 401.5, width: 333.75, height: 97.125, rotation: 0 };
      const back = fromNormalized(normalizeBox(box, size), size);
      // Normalized values are stored with 6 decimals: below a thousandth of a pixel on any side up to 6000 px.
      for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(back[key] - box[key])).toBeLessThan(0.006);
      for (const scale of [0.25, 0.5, 1 / 3, 2]) {
        const target = { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
        const mapped = mapBox(box, size, target), restored = mapBox(mapped, target, size);
        for (const key of ['x', 'y', 'width', 'height'] as const) expect(restored[key]).toBeCloseTo(box[key], 9);
        // At the export size, the box sits at the same fraction of the canvas.
        expect(mapped.x / target.width).toBeCloseTo(box.x / size.width, 9);
        expect(mapped.y / target.height).toBeCloseTo(box.y / size.height, 9);
      }
    });
  }
  it('rotates about the box centre and converts to the editor\'s origin rotation without moving the box', () => {
    const box = { x: 100, y: 100, width: 200, height: 100, rotation: 90 };
    const corners = boxCorners(box);
    // A 200×100 box rotated 90° about its centre (200, 150) stands 100 wide and 200 tall.
    expect(boundingBox(box)).toMatchObject({ x: expect.closeTo(150, 9), y: expect.closeTo(50, 9), width: expect.closeTo(100, 9), height: expect.closeTo(200, 9) });
    const origin = centreRotationToOrigin(box);
    expect(origin.x).toBeCloseTo(corners[0][0], 9); expect(origin.y).toBeCloseTo(corners[0][1], 9);
    // An editor layer at that origin rotated 90° about it has its far corner where the source box has it.
    const a = Math.PI / 2, far = [origin.x + box.width * Math.cos(a) - box.height * Math.sin(a), origin.y + box.width * Math.sin(a) + box.height * Math.cos(a)];
    expect(far[0]).toBeCloseTo(corners[2][0], 9); expect(far[1]).toBeCloseTo(corners[2][1], 9);
    expect(insideBox(box, 200, 60)).toBe(true); expect(insideBox(box, 120, 150)).toBe(false);
  });
  it('keeps whole pixels for rasters, clipped to the canvas', () => {
    expect(pixelBounds({ x: 10.2, y: 20.7, width: 30.1, height: 5.2, rotation: 0 }, { width: 100, height: 100 })).toEqual({ x: 10, y: 20, width: 31, height: 6 });
    expect(pixelBounds({ x: 90, y: -5, width: 30, height: 20, rotation: 0 }, { width: 100, height: 100 })).toEqual({ x: 90, y: 0, width: 10, height: 15 });
    expect(pixelBounds({ x: 120, y: 0, width: 10, height: 10, rotation: 0 }, { width: 100, height: 100 })).toBeUndefined();
    expect(onCanvasShare({ x: 90, y: 0, width: 20, height: 10, rotation: 0 }, { width: 100, height: 100 })).toBeCloseTo(0.5, 2);
  });
  it('fits the editor canvas within its limits, scaling down only', () => {
    expect(protectedEditorCanvas({ width: 1820, height: 2420 })).toEqual({ width: 1820, height: 2420, scale: { x: 1, y: 1 } });
    const big = protectedEditorCanvas({ width: 6000, height: 4000 });
    expect(big.width).toBeLessThanOrEqual(4096); expect(big.width * big.height).toBeLessThanOrEqual(12_000_000);
    // Whole-pixel rounding: x and y scales differ by less than one pixel over the canvas.
    expect(Math.abs(big.scale.x - big.scale.y) * 6000).toBeLessThan(1.5);
    expect(sameAspect({ width: 1820, height: 2420 }, { width: 910, height: 1210 })).toBe(true);
    expect(sameAspect({ width: 1820, height: 2420 }, { width: 1080, height: 1350 })).toBe(false);
  });
});

describe('protected element validation', () => {
  const size = SIZES.portrait;
  it('accepts a complete element and derives normalized values from its box only', () => {
    expect(elementProblems(element(), size)).toEqual([]);
    expect(withNormalized(element(), size).normalized).toEqual({ x: 0.054945, y: 0.082645, width: 0.164835, height: 0.049587 });
  });
  it('refuses empty, tiny, mostly off-canvas and incomplete elements with a reason', () => {
    const codes = (e: ProtectedElement) => elementProblems(e, size).filter(p => p.severity === 'error').map(p => p.code);
    expect(codes(element({ box: { x: 10, y: 10, width: 2, height: 50, rotation: 0 } }))).toContain('REGION_TOO_SMALL');
    expect(codes(element({ box: { x: 1800, y: 10, width: 300, height: 50, rotation: 0 } }))).toContain('OFF_CANVAS');
    // 220 of its 300 pixels are on the 1820-wide source: kept, clipped, and said so.
    expect(elementProblems(element({ box: { x: 1600, y: 10, width: 300, height: 50, rotation: 0 } }), size).map(p => p.code)).toEqual(['PARTLY_OFF_CANVAS']);
    expect(codes(element({ box: { x: 10, y: 10, width: 50, height: Number.NaN, rotation: 0 } }))).toEqual(['INVALID_GEOMETRY']);
    expect(codes(element({ label: ' ' }))).toContain('INVALID_LABEL');
    expect(codes(element({ representation: 'native-text', kind: 'text' }))).toContain('TEXT_INCOMPLETE');
    expect(codes(element({ representation: 'source-asset' }))).toContain('SOURCE_ASSET_MISSING');
    const file = { file: 'asset.jpg', sha256: 'a', mime: 'image/jpeg', width: 10, height: 10, bytes: 1, hasAlpha: false };
    expect(elementProblems(element({ representation: 'source-asset', sourceAsset: file }), size).map(p => [p.severity, p.code])).toEqual([['warning', 'OPAQUE_SOURCE_ASSET']]);
  });
  it('flags a font the editor lacks as a fallback, never silently', () => {
    const text = { value: 'Easy EMI', fontFamily: 'Pine Sans', fallbackFamily: 'Inter', fontSize: 64, fontWeight: 700 as const, lineHeight: 1.1, letterSpacing: 0, align: 'left' as const, verticalAlign: 'top' as const, color: '#112233' };
    const problems = elementProblems(element({ kind: 'text', representation: 'native-text', text }), size);
    expect(problems.map(p => [p.severity, p.code])).toEqual([['warning', 'FONT_FALLBACK']]);
    expect(elementProblems(element({ kind: 'text', representation: 'native-text', text: { ...text, fontFamily: 'Inter' } }), size)).toEqual([]);
  });
  it('requires unique ids and order, and reports overlaps as warnings', () => {
    const a = element(), b = element({ id: 'pe-aaaaaaaaaa', label: 'Headline', zIndex: 1, box: { x: 150, y: 220, width: 300, height: 120, rotation: 0 } });
    expect(elementsProblems([a, b], size).map(p => p.code)).toEqual(['OVERLAP']);
    expect(elementsProblems([a, { ...b, zIndex: 0 }], size).map(p => p.code)).toContain('INVALID_ORDER');
    expect(elementsProblems([a, { ...b, id: a.id }], size).map(p => p.code)).toContain('INVALID_IDS');
  });
  it('treats a new region, mask or representation as a change to what is protected, and a label as not', () => {
    expect(geometryChanged(element(), element({ label: 'Renamed', note: 'x' }))).toBe(false);
    expect(geometryChanged(element(), element({ box: { ...element().box, x: 101 } }))).toBe(true);
    expect(geometryChanged(element(), element({ mask: { mode: 'opaque', threshold: 24 } }))).toBe(true);
  });
});
