import { describe, expect, it } from 'vitest';
import { createTextElement, type TextElement } from '@frameflow/shared';
import { autoLayout, boundsFit, textOverflows, type MeasureText } from './autoLayout';
import { fontFloor, safeRegion } from './constants';

const canvas = { width: 1080, height: 1350 };
const region = safeRegion(canvas);
const element = (changes: Partial<TextElement> = {}): TextElement => ({
  ...createTextElement('heading', canvas, 'text'), text: 'Wedding', x: 100, y: 100, width: 600, fontSize: 48, ...changes,
});
// Deliberately simple, deterministic test double for policy tests only.
// Production never estimates glyph widths; browser tests below exercise actual Konva/fonts.
const measure: MeasureText = (text) => {
  const glyphWidth = text.fontSize / 2;
  const lines = text.text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(Array.from(line).length * glyphWidth / text.width)), 0);
  return { width: text.width, height: lines * text.fontSize * text.lineHeight, lines, complete: glyphWidth <= text.width };
};
function fitted(input: TextElement, size = canvas) {
  const result = autoLayout(input, size, measure);
  expect(result.status).toBe('fitted');
  expect(result.element.text).toBe(input.text);
  expect(boundsFit(result.element, measure(result.element), safeRegion(size))).toBe(true);
  return result;
}

describe('deterministic Auto Layout', () => {
  it('leaves Wedding unchanged when it already fits', () => {
    const input = element();
    expect(autoLayout(input, canvas, measure)).toEqual({ status: 'unchanged', element: input });
    expect(autoLayout(input, canvas, measure).element).toBe(input);
  });
  it('wraps a phrase into a narrow target without rewriting it', () => {
    const input = element({ text: 'The Royal Wedding Celebration', width: 900 });
    const target = { x: 20, y: 20, width: 400, height: 500 };
    const result = autoLayout(input, canvas, measure, target);
    expect(result.status).toBe('fitted');
    expect(result.element.text).toBe(input.text);
    expect(boundsFit(result.element, measure(result.element), target)).toBe(true);
    if (result.status === 'fitted') expect(result.changes).toContain('wrapped');
  });
  it('fits the long venue at readable size without losing words', () => {
    const result = fitted(element({ text: 'The Grand Royal Wedding Palace, Connaught Place, New Delhi, India', x: 900, y: 1250 }));
    expect(result.element.fontSize).toBe(48);
  });
  it('moves a right-edge box only as far as necessary', () => {
    const result = fitted(element({ x: 1000 }));
    expect(result.element).toMatchObject({ x: region.x + region.width - 600, y: 100, fontSize: 48, width: 600 });
    if (result.status === 'fitted') expect(result.changes).toEqual(['moved']);
  });
  it('moves up from the bottom before reducing font size', () => {
    const result = fitted(element({ y: 1340 }));
    expect(result.element.y).toBeCloseTo(region.y + region.height - measure(result.element).height);
    expect(result.element.fontSize).toBe(48);
  });
  it('widens an extremely narrow overflowing box at original font size', () => {
    const result = fitted(element({ width: 1 }));
    expect(result.element.width).toBeGreaterThan(300);
    expect(result.element.fontSize).toBe(48);
    if (result.status === 'fitted') expect(result.changes).toContain('widened');
  });
  it('preserves newlines, whitespace and grapheme sequences exactly', () => {
    fitted(element({ text: '  Line one\nLine two 👩🏽‍🎨\n\nLine three\n', x: -20, y: -10 }));
  });
  it('handles a long unbroken token with finite geometry', () => {
    const result = fitted(element({ text: 'SupercalifragilisticexpialidociousWeddingVenue123456789', width: 32, y: 1300 }));
    expect(Object.values({ x: result.element.x, y: result.element.y, width: result.element.width, fontSize: result.element.fontSize }).every(Number.isFinite)).toBe(true);
  });
  it('leaves an impossible original untouched', () => {
    const input = Object.freeze(element({ text: 'Line\n'.repeat(200) }));
    const result = autoLayout(input, { width: 256, height: 256 }, measure);
    expect(result.status).toBe('unresolved');
    expect(result.element).toBe(input);
  });
  it('is idempotent after a successful font reduction', () => {
    const input = element({ text: 'Celebration '.repeat(100), fontSize: 100 });
    const result = fitted(input);
    expect(result.element.fontSize).toBeLessThan(input.fontSize);
    expect(result.element.fontSize).toBeGreaterThanOrEqual(fontFloor(canvas, input.fontSize));
    expect(autoLayout(result.element, canvas, measure)).toEqual({ status: 'unchanged', element: result.element });
    // The finite search is within 0.01 px of the largest fitting size for this fixture.
    expect(boundsFit({ ...result.element, fontSize: result.element.fontSize + 0.01 }, measure({ ...result.element, fontSize: result.element.fontSize + 0.01 }), region)).toBe(false);
  });
  it('no-ops on empty text without invoking measurement', () => {
    const input = element({ text: '', x: -100 });
    expect(autoLayout(input, canvas, () => { throw new Error('must not measure'); }).status).toBe('unchanged');
    expect(textOverflows(input, region, measure)).toBe(false);
  });
  it('does not mutate any input property', () => {
    const input = Object.freeze(element({ x: 999, y: 1340 }));
    const snapshot = { ...input };
    fitted(input);
    expect(input).toEqual(snapshot);
  });
  it('never enlarges a font intentionally below the automatic floor', () => {
    expect(fitted(element({ fontSize: 8, x: -10 })).element.fontSize).toBe(8);
  });
  it('includes wrapped height in derived overflow and uses one-pixel tolerance', () => {
    expect(textOverflows(element({ text: 'Long '.repeat(100), width: 100 }), region, measure)).toBe(true);
    expect(textOverflows(element({ x: region.x - 1 }), region, measure)).toBe(false);
    expect(textOverflows(element({ x: region.x - 1.1 }), region, measure)).toBe(true);
  });
  it.each([{ x: NaN }, { y: Infinity }, { width: 0 }, { fontSize: -1 }, { lineHeight: 0 }, { letterSpacing: NaN }])('rejects invalid input %o safely', (changes) => {
    expect(autoLayout(element(changes), canvas, measure).status).toBe('unresolved');
  });
  it('rejects invalid canvas, target, or unavailable measurements', () => {
    expect(autoLayout(element(), { width: NaN, height: 10 }, measure).status).toBe('unresolved');
    expect(autoLayout(element(), canvas, measure, { x: 0, y: 0, width: 0, height: 10 }).status).toBe('unresolved');
    expect(autoLayout(element(), canvas, () => { throw new Error('No canvas'); }).status).toBe('unresolved');
    expect(autoLayout(element(), canvas, () => ({ width: NaN, height: 1, lines: 1, complete: true })).status).toBe('unresolved');
  });
  it('rejects a candidate if final remeasurement disagrees', () => {
    let calls = 0;
    const unstable: MeasureText = (text) => ++calls >= 3 ? { width: 1, height: Infinity, lines: 1, complete: true } : measure(text);
    expect(autoLayout(element({ x: -10 }), canvas, unstable).status).toBe('unresolved');
  });
  it('bounds policy constants at canvas extremes', () => {
    expect(safeRegion({ width: 256, height: 256 })).toEqual({ x: 12, y: 12, width: 232, height: 232 });
    expect(safeRegion({ width: 4096, height: 4096 }).x).toBe(96);
    expect(fontFloor({ width: 256, height: 256 }, 72)).toBe(10);
    expect(fontFloor({ width: 4096, height: 4096 }, 72)).toBe(32);
  });
});
