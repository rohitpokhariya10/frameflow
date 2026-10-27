/**
 * The closest offer font (shared/src/offerFonts.ts) for a scanned line of text, chosen by comparing letter shapes: each
 * candidate face draws the line's words with its own file, scaled so their ink is as tall as the poster's, and the
 * drawings are compared with the poster's ink pixels (overlap of the shapes, and how wide the words come out). The family
 * is the one whose letters overlap best; its weight and style the face whose stroke weight (the share of the word's box
 * that is ink) is closest to the poster's, as overlap alone favours heavier strokes wherever shapes are slightly off. The
 * chosen face gives the words' size, and where each word's text starts and sits (origin and baseline), measured from the
 * same files the browser draws with. A choice is an estimate the administrator reviews.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import opentype, { type Font } from 'opentype.js';
import { OFFER_FONTS, type OfferFontFace } from '@frameflow/shared';
import { BUNDLED_DIR } from '../templateStudio/fonts/library.js';
import { pathData } from '../templateStudio/compose/text.js';
import type { Rgba } from '../decomposition/protectedTemplates/pixels.js';
import type { PixelBox } from './measure.js';

const require = createRequire(import.meta.url);
const FONTSOURCE_DIR = dirname(dirname(require.resolve('@fontsource/inter/package.json')));
const fonts = new Map<string, Font>();
/** The parsed file of a face (cached): Template Studio's .ttf, or the editor's fontsource .woff. */
export function offerFontFile(face: OfferFontFace): Font {
  const path = face.root === 'studio' ? join(BUNDLED_DIR, face.file) : join(FONTSOURCE_DIR, `${face.file}.woff`);
  let font = fonts.get(path);
  if (!font) {
    const b = readFileSync(path);
    font = opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    // opentype.js 2.0 cannot apply some contextual substitution formats (Inter's, Lora's) and throws on them. Glyph
    // substitution changes no Latin offer copy here (no ligatures are drawn by the editor either: Konva sets text per
    // line), so the table is left out: shapes and advances come from the glyphs themselves.
    try { font.getPath('Offer fi', 0, 0, 10, { kerning: true }); } catch { (font as unknown as { tables: Record<string, unknown> }).tables.gsub = undefined; }
    fonts.set(path, font);
  }
  return font;
}

type Cmd = { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number };
/** The ink bounds of a path (curves sampled, so control points never widen it). */
export function pathBounds(commands: Cmd[]) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, cx = 0, cy = 0;
  const add = (x: number, y: number) => { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; };
  for (const c of commands) {
    if (c.type === 'M' || c.type === 'L') { add(c.x!, c.y!); cx = c.x!; cy = c.y!; }
    else if (c.type === 'Q') { for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; add(u * u * cx + 2 * u * t * c.x1! + t * t * c.x!, u * u * cy + 2 * u * t * c.y1! + t * t * c.y!); } cx = c.x!; cy = c.y!; }
    else if (c.type === 'C') { for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; add(u ** 3 * cx + 3 * u * u * t * c.x1! + 3 * u * t * t * c.x2! + t ** 3 * c.x!, u ** 3 * cy + 3 * u * u * t * c.y1! + 3 * u * t * t * c.y2! + t ** 3 * c.y!); } cx = c.x!; cy = c.y!; }
  }
  return Number.isFinite(x1) ? { x1, y1, x2, y2 } : undefined;
}
const missingGlyph = (font: Font, text: string) => [...text].some(ch => !/\s/.test(ch) && font.charToGlyphIndex(ch) === 0);

/** One word as a face draws it at `size`: ink bounds relative to its origin and baseline, and its advance. */
export function wordMetrics(font: Font, text: string, size: number) {
  const path = font.getPath(text, 0, 0, size, { kerning: true });
  return { bounds: pathBounds(path.commands), advance: font.getAdvanceWidth(text, size, { kerning: true }), commands: path.commands };
}

const MASK_H = 40;
/** The poster's ink of one word as a mask of MASK_H rows (box resampled): pixels near the word's ink colour. */
async function sourceMask(source: Rgba, box: PixelBox, ink: string): Promise<{ mask: Uint8Array; w: number; ink: number }> {
  const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y)), width = Math.max(1, Math.min(source.width - x, Math.ceil(box.width))), height = Math.max(1, Math.min(source.height - y, Math.ceil(box.height)));
  const c = [1, 3, 5].map(i => parseInt(ink.slice(i, i + 2), 16)), full = new Uint8Array(width * height);
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const k = ((y + j) * source.width + x + i) * 4;
    full[j * width + i] = Math.max(Math.abs(source.data[k] - c[0]), Math.abs(source.data[k + 1] - c[1]), Math.abs(source.data[k + 2] - c[2])) <= 70 ? 255 : 0;
  }
  const w = Math.max(4, Math.round(MASK_H * width / height));
  // One channel out (sharp otherwise widens a single-channel raw image to three), so pixels line up with the face's.
  const { data } = await sharp(Buffer.from(full), { raw: { width, height, channels: 1 } }).resize(w, MASK_H, { fit: 'fill' }).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  const mask = Uint8Array.from(data, v => (v >= 128 ? 1 : 0));
  return { mask, w, ink: inkShare(mask) };
}
/** A face's drawing of a word as a mask of the same size as the source mask (its ink box stretched to it). */
async function faceMask(commands: Cmd[], bounds: { x1: number; y1: number; x2: number; y2: number }, w: number): Promise<Uint8Array> {
  const sx = w / Math.max(1e-6, bounds.x2 - bounds.x1), sy = MASK_H / Math.max(1e-6, bounds.y2 - bounds.y1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${MASK_H}"><rect width="100%" height="100%" fill="#000"/><path fill="#fff" transform="scale(${sx} ${sy}) translate(${-bounds.x1} ${-bounds.y1})" d="${pathData(commands)}"/></svg>`;
  const { data } = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer({ resolveWithObject: true });
  return Uint8Array.from(data, v => (v >= 128 ? 1 : 0));
}
const iou = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) throw new Error(`Font match masks differ in size (${a.length} and ${b.length}).`);
  let i = 0, u = 0; for (let k = 0; k < a.length; k++) { if (a[k] && b[k]) i++; if (a[k] || b[k]) u++; } return u ? i / u : 0;
};
/** The share of a mask that is ink: the stroke weight of a word drawn to fill its box. */
const inkShare = (m: Uint8Array) => { let n = 0; for (const v of m) n += v; return n / Math.max(1, m.length); };
/** Letters carry a face's identity; figures and punctuation differ between faces more by spacing than by design. */
const letterCount = (text: string) => (text.match(/\p{L}/gu) ?? []).length;

export interface LineWordInput { text: string; box: PixelBox }
export interface WordPlacement { fontSize: number; baseline: number; originDx: number; letterSpacing: number }
export interface LineFontMatch {
  family: string; weight: 400 | 600 | 700; style: 'normal' | 'italic';
  /** 0..1: shape overlap of the best face; `runnerUp` the next family's, for how clear the choice was. */
  score: number; runnerUp?: { family: string; score: number };
  words: WordPlacement[];
}
/**
 * The best offer face for one line of words, and each word's size, baseline (from its box top), origin (from its box
 * left) and letter spacing in that face. `italicHint`: the poster's letters lean (a measured shear), favouring italics.
 */
export async function matchLineFont(source: Rgba, words: LineWordInput[], ink: string, options: { italicHint?: boolean; families?: string[] } = {}): Promise<LineFontMatch | undefined> {
  const usable = words.filter(w => w.text.trim() && w.box.width >= 3 && w.box.height >= 3);
  if (!usable.length) return undefined;
  // The words with the most letters carry the most shape (three are enough to tell faces apart), each counted by its
  // letters, so a figure string such as "3-6-9-12" barely sways the choice.
  const sample = [...usable].sort((a, b) => letterCount(b.text) - letterCount(a.text) || b.box.width - a.box.width).slice(0, 3);
  const masks = await Promise.all(sample.map(w => sourceMask(source, w.box, ink)));
  const faces = OFFER_FONTS.filter(f => !options.families || options.families.includes(f.family)).flatMap(f => f.faces.map(face => ({ family: f.family, face })));
  const scored: { family: string; face: OfferFontFace; score: number; stroke: number }[] = [];
  for (const { family, face } of faces) {
    const font = offerFontFile(face);
    let total = 0, stroke = 0, weight = 0, ok = true;
    for (const [k, w] of sample.entries()) {
      if (missingGlyph(font, w.text)) { ok = false; break; }
      const m = wordMetrics(font, w.text, 100);
      if (!m.bounds) { ok = false; break; }
      const drawn = await faceMask(m.commands, m.bounds, masks[k].w), shape = iou(masks[k].mask, drawn);
      // How wide the face draws the word at the poster's ink height, against the poster's width.
      const width = (m.bounds.x2 - m.bounds.x1) * (w.box.height / Math.max(1e-6, m.bounds.y2 - m.bounds.y1));
      const ratio = Math.abs(Math.log(width / w.box.width)), q = letterCount(w.text) + 1;
      total += (shape - 0.6 * ratio) * q; weight += q;
      stroke += Math.abs(Math.log(Math.max(1e-3, inkShare(drawn)) / Math.max(1e-3, masks[k].ink))) * q;
    }
    if (!ok || !weight) continue;
    const italicBonus = options.italicHint === undefined ? 0 : (face.style === 'italic') === options.italicHint ? 0.04 : -0.04;
    scored.push({ family, face, score: total / weight + italicBonus, stroke: stroke / weight });
  }
  if (!scored.length) return undefined;
  // Each family at its own best weight (shape and stroke together), so a family never wins on a face heavier than the
  // poster's letters; then the family whose face of that weight matches the letters best.
  const perFamily = [...new Set(scored.map(s => s.family))].map(f => scored.filter(s => s.family === f).sort((a, b) => (b.score - b.stroke) - (a.score - a.stroke))[0]).sort((a, b) => b.score - a.score);
  const best = perFamily[0], family = best.family, runner = perFamily[1], font = offerFontFile(best.face);
  // Each word in the chosen face: its size from its ink height, one size for the line (the median), then each word's
  // baseline and origin from that size, and a letter spacing only where the width is clearly off (kerning is lost with it).
  const sizes = usable.map(w => { const m = wordMetrics(font, w.text, 100); return m.bounds ? 100 * w.box.height / Math.max(1e-6, m.bounds.y2 - m.bounds.y1) : undefined; }).filter((v): v is number => !!v);
  const size = [...sizes].sort((a, b) => a - b)[sizes.length >> 1] ?? usable[0].box.height;
  const placements = words.map(w => {
    let fontSize = size, m = wordMetrics(font, w.text || ' ', fontSize);
    if (!m.bounds) return { fontSize: size, baseline: w.box.height * 0.8, originDx: 0, letterSpacing: 0 };
    const n = [...w.text].length, drawn = m.bounds.x2 - m.bounds.x1, error = (w.box.width - drawn) / Math.max(1, w.box.width);
    let letterSpacing = n > 1 && Math.abs(error) > 0.03 ? Math.max(-0.08 * size, Math.min(0.08 * size, (w.box.width - drawn) / (n - 1))) : 0;
    // Never drawn into the next word of its line: no further than the next word's start less a word space (an eighth of
    // the size, or most of the creative's own gap); the line's last word no wider than its own box (3 % and a pixel of
    // slack). A face wider than the creative's own ran into the next word ("LGproducts") or out of its plate ("CHATURTH").
    // (Its own box was the limit for every word at first: a box narrower than its glyph — an AI box cutting a "9" in
    // half — then drew a figure 40 % smaller, like a subscript, with room to spare before the next word.)
    // First the letters close up a little more (to −10 % of the size), then this word alone is drawn smaller, on the
    // same baseline; the line's other words keep their size.
    const next = words.filter(o => o !== w && o.box.x > w.box.x).sort((p, q) => p.box.x - q.box.x)[0];
    const limit = next ? Math.max(w.box.width * 1.03 + 1, next.box.x - w.box.x - Math.max(0.15 * size, 0.6 * (next.box.x - w.box.x - w.box.width))) : w.box.width * 1.03 + 1, inkAt = (sz: number, ls: number) => { const b = wordMetrics(font, w.text, sz).bounds; return b ? b.x2 - b.x1 + ls * Math.max(0, n - 1) : 0; };
    if (inkAt(fontSize, letterSpacing) > limit && n > 1) letterSpacing = Math.max(-0.1 * fontSize, Math.min(letterSpacing, (limit - drawn) / (n - 1)));
    for (let k = 0; k < 3 && inkAt(fontSize, letterSpacing) > limit; k++) { const f = limit / inkAt(fontSize, letterSpacing); fontSize *= f; letterSpacing *= f; }
    if (fontSize !== size) m = wordMetrics(font, w.text || ' ', fontSize);
    const bounds = m.bounds ?? { x1: 0, y2: w.box.height * 0.2 };
    return { fontSize: Math.round(fontSize * 10) / 10, baseline: Math.round((w.box.height - bounds.y2) * 10) / 10, originDx: Math.round(-bounds.x1 * 10) / 10, letterSpacing: Math.round(letterSpacing * 100) / 100 };
  });
  return { family, weight: best.face.weight, style: best.face.style, score: Math.round(best.score * 1000) / 1000, ...(runner ? { runnerUp: { family: runner.family, score: Math.round(runner.score * 1000) / 1000 } } : {}), words: placements };
}
