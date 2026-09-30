import { describe, expect, it } from 'vitest';
import { emptyMask } from '../image/masks.js';
import type { Mask } from '../image/types.js';
import { estimateTextStyle, fitShape, suggestText, type SourcePixels } from './elementReconstruction.js';

const W = 300, H = 240;
function mask(inside: (x: number, y: number) => boolean): Mask { const m = emptyMask(W, H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside(x + 0.5, y + 0.5)) m.data[y * W + x] = 255; return m; }
function pixels(color: (x: number, y: number) => [number, number, number]): SourcePixels {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b] = color(x, y); data.set([r, g, b, 255], (y * W + x) * 4); }
  return { data, width: W, height: H };
}
const orange = pixels(() => [240, 110, 30]);

describe('shape reconstruction', () => {
  it('fits a solid rectangle', () => {
    const fit = fitShape(mask((x, y) => x >= 40 && x < 240 && y >= 30 && y < 180), orange);
    expect(fit).toMatchObject({ shapeType: 'rectangle', bbox: { x: 40, y: 30, width: 200, height: 150 }, fill: '#f06e1e', confidence: 0.9 });
    expect(fit.gradient).toBeUndefined();
  });

  it('fits a rounded rectangle and recovers its radius', () => {
    const r = 30, box = { x: 40, y: 30, w: 200, h: 150 };
    const fit = fitShape(mask((x, y) => { const dx = Math.max(box.x + r - x, 0, x - (box.x + box.w - r)), dy = Math.max(box.y + r - y, 0, y - (box.y + box.h - r)); return x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h && dx * dx + dy * dy <= r * r; }), orange);
    expect(fit.shapeType).toBe('rounded-rectangle');
    expect(Math.abs(fit.radius! - r)).toBeLessThanOrEqual(2);
    expect(fit.fitIoU).toBeGreaterThan(0.97);
  });

  it('fits an ellipse', () => {
    expect(fitShape(mask((x, y) => ((x - 150) / 100) ** 2 + ((y - 120) / 70) ** 2 <= 1), orange).shapeType).toBe('ellipse');
  });

  it('detects a linear gradient fill (the orange panel case)', () => {
    const gradient = pixels((x, y) => [255, Math.round(90 + ((x + y) / (W + H)) * 110), 20]);
    const fit = fitShape(mask((x, y) => x >= 40 && x < 240 && y >= 30 && y < 180), gradient);
    expect(fit.shapeType).toBe('rectangle');
    expect(fit.gradient).toMatchObject({ angle: 45 });
  });

  it('keeps irregular geometry or textured fills as a raster instead of guessing a vector', () => {
    expect(fitShape(mask((x, y) => (x >= 40 && x < 240 && y >= 30 && y < 80) || (x >= 40 && x < 90 && y >= 30 && y < 200)), orange)).toMatchObject({ shapeType: 'raster', reasons: ['GEOMETRY_NOT_SIMPLE'] });
    const noisy = pixels((x, y) => [((x * 73 + y * 151) % 255), ((x * 31) % 255), ((y * 97) % 255)]);
    expect(fitShape(mask((x, y) => x >= 40 && x < 240 && y >= 30 && y < 180), noisy)).toMatchObject({ shapeType: 'raster', reasons: ['TEXTURED_FILL'] });
  });
});

describe('text reconstruction', () => {
  // Descriptions as returned live by Seedream for the poster.
  it.each([
    ['PRO headline', 'Uppercase PRO text title with an orange gradient, separate from all other elements.', 'PRO'],
    ['Designer signature', 'Handwritten-style signature text reading Design By Akash below the body text.', 'Design By Akash'],
    ['Bottom specification text group', 'Four specification texts on the bottom panel: A19 PRO CHIP, 18MP CENTER STAGE CAMERA, 4K DOLBY VISION VIDEO, APPLE INTELLIGENCE. Preserve the original text content.', 'A19 PRO CHIP\n18MP CENTER STAGE CAMERA\n4K DOLBY VISION VIDEO\nAPPLE INTELLIGENCE'],
    ['Product name tag', 'Rounded rectangle text tag reading iphone 17 Pro, positioned at the top right of the main panel.', 'iphone 17 Pro'],
    ['Sale banner', 'A banner with the words "50% OFF" in white', '50% OFF'],
  ])('%s → suggestion', (label, description, text) => {
    expect(suggestText(label, description)).toEqual({ text, textConfidence: 'low', suggestionSource: 'provider-description' });
  });

  it('never invents text without provider wording, and never claims more than low confidence', () => {
    expect(suggestText('Product description body text', 'English product description paragraph at the bottom right of the main panel.')).toEqual({ text: '', textConfidence: 'none' });
    expect(suggestText('SALE sticker', '')).toEqual({ text: 'SALE', textConfidence: 'low', suggestionSource: 'provider-label' });
  });

  it('estimates colour, size and weight from glyph pixels', () => {
    const glyphs = mask((x, y) => y >= 100 && y < 150 && x >= 50 && x < 250 && (Math.floor(x / 10) % 2 === 0));
    const style = estimateTextStyle(glyphs, pixels(() => [250, 120, 20]));
    expect(style).toMatchObject({ color: '#fa7814', fontSize: 40, fontWeight: 700 });
  });
});

describe('occlusion-aware shape fill', () => {
  it('samples a panel colour around a person standing in front of it, instead of rejecting it as texture', () => {
    const panelMask = mask((x, y) => x >= 40 && x < 260 && y >= 30 && y < 210);
    const person = mask((x, y) => ((x - 150) / 45) ** 2 + ((y - 130) / 90) ** 2 <= 1);
    // Orange panel pixels with a photo-like person painted over them.
    const scene = pixels((x, y) => ((x - 150) / 45) ** 2 + ((y - 130) / 90) ** 2 <= 1 ? [((x * 73 + y * 151) % 255), ((x * 31) % 255), ((y * 97) % 255)] : [240, 110, 30]);
    expect(fitShape(panelMask, scene).shapeType).toBe('raster');
    expect(fitShape(panelMask, scene, person)).toMatchObject({ shapeType: 'rectangle', fill: '#f06e1e' });
    // A shape that is almost entirely hidden cannot be coloured confidently.
    expect(fitShape(panelMask, scene, panelMask)).toMatchObject({ shapeType: 'raster', reasons: expect.arrayContaining(['SHAPE_MOSTLY_OCCLUDED']) });
  });
});
