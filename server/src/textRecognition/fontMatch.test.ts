import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { OFFER_FONTS } from '@frameflow/shared';
import { decodeRgba } from '../decomposition/protectedTemplates/pixels.js';
import { pathData } from '../templateStudio/compose/text.js';
import { matchLineFont, offerFontFile, wordMetrics } from './fontMatch.js';
import { measureWord } from './measure.js';

const INK = '#03595a', SIZE = 96;
/** One line of words drawn with a bundled offer face on a mint ground, and each word's ink box (as the scan finds it). */
async function line(family: string, weight: number, style: 'normal' | 'italic', words: string[]) {
  const face = OFFER_FONTS.find(f => f.family === family)!.faces.find(f => f.weight === weight && f.style === style)!, font = offerFontFile(face);
  let x = 30; const paths: string[] = [], boxes: { text: string; box: { x: number; y: number; width: number; height: number } }[] = [];
  for (const text of words) {
    const m = wordMetrics(font, text, SIZE), b = m.bounds!;
    paths.push(`<path fill="${INK}" transform="translate(${x} ${40 + SIZE})" d="${pathData(m.commands)}"/>`);
    boxes.push({ text, box: { x: Math.floor(x + b.x1), y: Math.floor(40 + SIZE + b.y1), width: Math.ceil(b.x2 - b.x1) + 1, height: Math.ceil(b.y2 - b.y1) + 1 } });
    x += m.advance + SIZE * 0.3;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(x + 30)}" height="${SIZE * 2}"><rect width="100%" height="100%" fill="#b8f0d6"/>${paths.join('')}</svg>`;
  return { source: await decodeRgba(await sharp(Buffer.from(svg)).png().toBuffer()), words: boxes };
}

describe('font matching', () => {
  it('tells a regular from a bold of the same family by stroke weight', async () => {
    for (const weight of [400, 700] as const) {
      const { source, words } = await line('Poppins', weight, 'normal', ['Scan', 'available', 'offers']);
      const match = await matchLineFont(source, words, INK, { italicHint: false });
      expect(match, `Poppins ${weight}`).toMatchObject({ family: 'Poppins', weight, style: 'normal' });
      expect(match!.score).toBeGreaterThan(0.6);
    }
  });
  it('keeps a strongly drawn italic serif italic, measured from the letters as the scan does', async () => {
    const { source, words } = await line('Lora', 700, 'italic', ['Get', 'instant']);
    const italicHint = words.some(w => measureWord(source, w.box, w.text).italic);
    expect(await matchLineFont(source, words, INK, { italicHint })).toMatchObject({ family: 'Lora', weight: 700, style: 'italic' });
  });
  it('chooses the family by its letters: a string of figures does not decide it', async () => {
    const { source, words } = await line('Poppins', 400, 'normal', ['3-6-9-12-18-24', 'months']);
    expect(await matchLineFont(source, words, INK, { italicHint: false })).toMatchObject({ family: 'Poppins', weight: 400 });
  });
});
