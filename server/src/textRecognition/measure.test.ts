import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { decodeRgba } from '../decomposition/protectedTemplates/pixels.js';
import { labelHints, closestFont } from './analyse.js';
import { detectLogoTiles, inkBounds, inkEmShare, measureWord } from './measure.js';
import { mergeReadings, plausibleWord, type RecognizedWord } from './recognizer.js';
import { VARIATION_TILES, variationPosterPng } from './variationPoster.fixture.js';

const rgba = async (svg: string, w: number, h: number) => decodeRgba(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${svg}</svg>`)).png().toBuffer());

describe('word measurements', () => {
  it('measures colour, size and weight from the ink, and tells an italic from an upright word', async () => {
    const poster = await decodeRgba(await variationPosterPng());
    const emi = measureWord(poster, { x: 76, y: 226, width: 730, height: 300 }, 'EMI');
    expect(emi.color).toBe('#03595a');
    expect(emi.fontWeight).toBe(700);
    expect(emi.fontSize).toBeGreaterThan(330); expect(emi.fontSize).toBeLessThan(470);
    expect(emi.italic).toBe(false);
    const easy = measureWord(poster, { x: 76, y: 92, width: 264, height: 124 }, 'Easy');
    expect(easy.italic).toBe(true);
    expect(inkEmShare('Easy')).toBeGreaterThan(inkEmShare('EMI'));
  });
  it('shrinks a box to its own ink, leaving out a smaller word inside it, and never grows it', async () => {
    const image = await rgba('<rect width="400" height="300" fill="#ffffff"/><rect x="20" y="20" width="100" height="40" fill="#000"/><rect x="40" y="120" width="300" height="140" fill="#000"/>', 400, 300);
    expect(inkBounds(image, { x: 10, y: 10, width: 380, height: 280 }, [{ x: 15, y: 15, width: 110, height: 50 }])).toEqual({ x: 40, y: 120, width: 300, height: 140 });
    const tight = inkBounds(image, { x: 50, y: 130, width: 100, height: 50 });
    expect(tight.width).toBeLessThanOrEqual(100); expect(tight.height).toBeLessThanOrEqual(50);
  });
});

describe('logo tiles', () => {
  it('finds each card of a grid of light logo cards, at the grid\'s size', async () => {
    const poster = await decodeRgba(await variationPosterPng());
    const tiles = detectLogoTiles(poster, { x: 60, y: 800, width: 700, height: 120 });
    expect(tiles.map(t => ({ x: Math.round(t.x), y: Math.round(t.y), width: t.width, height: t.height }))).toEqual(VARIATION_TILES);
  });
  it('finds no grid in a region of plain copy', async () => {
    const poster = await decodeRgba(await variationPosterPng());
    expect(detectLogoTiles(poster, { x: 60, y: 80, width: 780, height: 590 })).toEqual([]);
  });
});

describe('readings', () => {
  const w = (text: string, confidence: number, x0: number, mode = 'block'): RecognizedWord => ({ text, confidence, box: { x0, y0: 0, x1: x0 + 50, y1: 20 }, mode });
  it('keeps a word found by both readings once, the more confident one', () => {
    expect(mergeReadings([w('Easy', 0.9, 0), w('EM1', 0.4, 100)], [w('EMI', 0.93, 102, 'sparse'), w('available.', 0.95, 300, 'sparse')]).map(x => x.text)).toEqual(['Easy', 'EMI', 'available.']);
    expect(plausibleWord({ text: '|', confidence: 0.9 })).toBe(false); expect(plausibleWord({ text: 'EMI', confidence: 0.2 })).toBe(false);
  });
  it('reads hints from the region description and picks a catalogue font', () => {
    expect(labelHints('Main offer copy: italic serif “Easy,” very large bold “EMI,” and “available.”', 'Easy')).toMatchObject({ italic: true, serif: true });
    expect(labelHints('Main offer copy: italic serif “Easy,” very large bold “EMI,” and “available.”', 'EMI')).toMatchObject({ bold: true, italic: false });
    expect(closestFont({ serif: true, italic: true, script: false, condensed: false, widthRatio: 1 })).toBe('Fraunces');
    expect(closestFont({ serif: false, italic: false, script: false, condensed: false, widthRatio: 1 })).toBe('Inter');
  });
});
