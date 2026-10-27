import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { OFFER_FONTS } from '@frameflow/shared';
import { decodeRgba, type Rgba } from '../pixels.js';
import { pathData } from '../../../templateStudio/compose/text.js';
import { offerFontFile, wordMetrics } from '../../../textRecognition/fontMatch.js';
import { removalMask } from './removal.js';
import { cleanBackground } from './patternFill.js';
import { unreadInk } from './scan.js';

const face = (family: string, weight = 700) => offerFontFile(OFFER_FONTS.find(f => f.family === family)!.faces.find(f => f.weight === weight && f.style === 'normal')!);
/** Text drawn with a bundled face: its SVG path and its ink box in the image. */
function text(family: string, words: string, x: number, baseline: number, size: number, fill: string) {
  const m = wordMetrics(face(family), words, size), b = m.bounds!;
  return { svg: `<path fill="${fill}" transform="translate(${x} ${baseline})" d="${pathData(m.commands)}"/>`, ink: { x: x + b.x1, y: baseline + b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 } };
}
const image = async (w: number, h: number, body: string) => decodeRgba(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)).png().toBuffer());
const dark = (s: Rgba, i: number) => s.data[i * 4] < 100 && s.data[i * 4 + 1] < 100 && s.data[i * 4 + 2] < 100;

describe('clean background: what is removed', () => {
  it('removes whole letters and their soft edge although the box covers only their middle (ascenders, i-dots, a full stop)', async () => {
    const word = text('Poppins', 'available.', 40, 140, 76, '#000000');
    const s = await image(900, 260, `<rect width="100%" height="100%" fill="#ffffff"/>${word.svg}<circle cx="820" cy="120" r="40" fill="none" stroke="#000000" stroke-width="6"/>`);
    // A reading's box around the x-height only: the tops of "l", "b", "l", the i-dot and the full stop are outside it.
    const xHeight = { x: word.ink.x, y: word.ink.y + word.ink.height * 0.3, width: word.ink.width * 0.97, height: word.ink.height * 0.7 };
    const mask = removalMask(s, { lines: [{ box: xHeight, ink: '#000000', lineHeight: xHeight.height }], plates: [], logos: [] });
    let left = 0, kept = 0;
    for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
      const i = y * s.width + x;
      if (x < 700 && dark(s, i) && !mask[i]) left++;
      if (x >= 760 && mask[i]) kept++;
    }
    expect(left).toBe(0);
    // The ring of the same black further along is artwork: untouched.
    expect(kept).toBe(0);
  });
  it('removes only a free-standing mark from its slot, not the background inside the box', async () => {
    const s = await image(400, 200, '<rect width="100%" height="100%" fill="#ffffff"/><circle cx="200" cy="100" r="30" fill="#e11d48"/>');
    const mask = removalMask(s, { lines: [], plates: [], logos: [{ box: { x: 60, y: 20, width: 280, height: 160 }, category: 'brand-logo' }] });
    let inBox = 0;
    for (let y = 20; y < 180; y++) for (let x = 60; x < 340; x++) inBox += mask[y * 400 + x];
    expect(mask[100 * 400 + 200]).toBe(1);
    expect(inBox).toBeLessThan(Math.PI * 34 * 34 * 1.2);
    // A partner logo tile is its whole box.
    const tile = removalMask(s, { lines: [], plates: [], logos: [{ box: { x: 60, y: 20, width: 280, height: 160 }, category: 'partner-logo' }] });
    expect(tile[30 * 400 + 70]).toBe(1);
  });
  it('removes nothing for a text box with no letters of its colour (an empty “Text” placeholder over artwork), so nothing there is filled', async () => {
    // Tent-Card-1 revision 1: an older clean-up filled such a box smoothly, a smear across the leaves at the top.
    const lattice = '<pattern id="d" width="60" height="40" patternUnits="userSpaceOnUse"><path d="M0 20 L30 0 L60 20 L30 40 Z" fill="none" stroke="#2f7d4f" stroke-width="5"/></pattern>';
    const s = await image(600, 300, `<defs>${lattice}</defs><rect width="100%" height="100%" fill="#b8f0d6"/><rect width="100%" height="100%" fill="url(#d)"/>`);
    const mask = removalMask(s, { lines: [{ box: { x: 200, y: 80, width: 172, height: 93 }, ink: '#000000', lineHeight: 93 }], plates: [], logos: [] });
    expect(mask.reduce((n, v) => n + v, 0)).toBe(0);
    const clean = await decodeRgba(await sharp((await cleanBackground(s, mask)).png).png().toBuffer());
    expect(Buffer.from(clean.data).equals(Buffer.from(s.data))).toBe(true);
  });
});

describe('clean background: continuing what is around a hole', () => {
  it('continues a white margin and a patterned panel each on its own side of a hole across both', async () => {
    // A white margin above y=200, a mint panel with a diamond lattice below; a badge-sized hole across the edge.
    const lattice = '<pattern id="d" width="60" height="40" patternUnits="userSpaceOnUse"><path d="M0 20 L30 0 L60 20 L30 40 Z" fill="none" stroke="#fdf6c8" stroke-width="3"/></pattern>';
    const s = await image(600, 500, `<defs>${lattice}</defs><rect width="100%" height="100%" fill="#ffffff"/><rect y="200" width="600" height="300" fill="#b8f0d6"/><rect y="200" width="600" height="300" fill="url(#d)"/><circle cx="300" cy="210" r="90" fill="#7c3aed"/>`);
    const remove = new Uint8Array(600 * 500);
    for (let y = 0; y < 500; y++) for (let x = 0; x < 600; x++) if ((x - 300) ** 2 + (y - 210) ** 2 <= 94 ** 2) remove[y * 600 + x] = 1;
    const clean = await decodeRgba(await sharp((await cleanBackground(s, remove)).png).png().toBuffer());
    const at = (x: number, y: number) => { const i = (y * 600 + x) * 4; return [clean.data[i], clean.data[i + 1], clean.data[i + 2]]; };
    const white = (p: number[]) => p.every(v => v > 245), purple = (p: number[]) => p[0] < 160 && p[2] > 180 && p[1] < 120;
    // Above the edge: white; below it: the panel (never white blocks copied from the margin, never the badge).
    expect(white(at(300, 150)) && white(at(260, 180))).toBe(true);
    let whiteBelow = 0, n = 0, badge = 0;
    for (let y = 215; y < 295; y += 3) for (let x = 230; x < 370; x += 3) { if ((x - 300) ** 2 + (y - 210) ** 2 > 88 ** 2) continue; n++; if (white(at(x, y))) whiteBelow++; if (purple(at(x, y))) badge++; }
    expect(whiteBelow / n).toBeLessThan(0.05);
    expect(badge).toBe(0);
  });
});

describe('scan: text the whole-poster reading missed', () => {
  it('finds unread text of a line’s colour beside the words it read (light figures on a dark pill)', async () => {
    const digits = text('Poppins', '3-6-9-12-18-24', 80, 92, 60, '#cede59');
    const read = text('Poppins', 'months', digits.ink.x + digits.ink.width + 28, 92, 60, '#cede59');
    const s = await image(1000, 140, `<rect width="100%" height="100%" fill="#b8f0d6"/><rect x="30" y="20" width="940" height="100" rx="50" fill="#000000"/>${digits.svg}${read.svg}`);
    const pieces = unreadInk(s, read.ink, read.ink.height, '#cede59', [read.ink]);
    expect(pieces).toHaveLength(1);
    const p = pieces[0];
    expect(p.x).toBeLessThanOrEqual(digits.ink.x + 2); expect(p.x + p.width).toBeGreaterThanOrEqual(digits.ink.x + digits.ink.width - 2);
    // Nothing is found where there is no more text of that colour.
    expect(unreadInk(s, digits.ink, digits.ink.height, '#cede59', [digits.ink, read.ink])).toEqual([]);
  });
});
