/**
 * A Product with Text creative laid out again for another aspect ratio, without stretching anything:
 *
 *   canvas     the template's width for a taller ratio, its height for a wider one (productCanvasFor): scale 1, so every
 *              picture, word and logo keeps its own pixels and size
 *   bands      where the template has plain margins along the axis that grows (rows, or columns, of one colour, such as
 *              a white header and footer), the extra space goes into them: each margin is made longer (exact: a margin
 *              of one colour stays that colour) and what sat in it is spread over its new length. The artwork between
 *              the margins moves as one block, with everything on it.
 *   letterbox  without plain margins, the artwork is centred and the two new margins are filled with the colour of the
 *              artwork's edge: a plain fill, reported (filledPercent) and flagged for a look, never passed off as artwork
 *
 * Elements move by their centre (a text group as one, so its lines and words keep their places relative to each other).
 * The template's own coordinates stay recoverable: every element keeps its template id (wordId, slotId, objectId) and
 * the creative records the transform (ProductCreativeLayout).
 */
import sharp, { type OverlayOptions } from 'sharp';
import {
  estimateAdvance, offerFace, productCanvasFor, textBounds,
  type CreativeText, type MeasureText, type ProductAspectRatio, type ProductCreative, type ProductCreativeLayout, type SourceSize,
} from '@frameflow/shared';
import { offerFontFile } from '../../../textRecognition/fontMatch.js';
import type { Rgba } from '../pixels.js';

/** A text's advance with the font file the renderer and the browser draw it with (as textInk measures it). */
export const fontMeasure: MeasureText = (text, style) => {
  const face = offerFace(style.fontFamily, style.fontWeight, style.fontStyle);
  if (!face) return estimateAdvance(text, style);
  const font = offerFontFile(face);
  return style.letterSpacing ? [...text].reduce((w, ch) => w + font.getAdvanceWidth(ch, style.fontSize) + style.letterSpacing, 0) : font.getAdvanceWidth(text, style.fontSize, { kerning: true });
};

export interface RatioLayout extends ProductCreativeLayout {
  target: SourceSize;
  method: 'template' | 'plain-bands' | 'letterbox';
  /** Letterbox: the colours of the two new margins. */
  fill?: { before: string; after: string };
}

const hex = (c: number[]) => `#${c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** One row (`row`) or column of the picture: its median colour and whether it is plain (one colour, fully opaque). */
function line(px: Rgba, axis: 'row' | 'col', i: number): { plain: boolean; colour: number[] } {
  const n = axis === 'row' ? px.width : px.height, ch: number[][] = [[], [], []];
  let opaque = true;
  for (let k = 0; k < n; k++) {
    const p = (axis === 'row' ? i * px.width + k : k * px.width + i) * 4;
    if (px.data[p + 3] < 250) opaque = false;
    for (let c = 0; c < 3; c++) ch[c].push(px.data[p + c]);
  }
  const colour = ch.map(v => [...v].sort((a, b) => a - b)[v.length >> 1]);
  if (!opaque) return { plain: false, colour };
  let near = 0;
  for (let k = 0; k < n; k++) if (Math.max(...[0, 1, 2].map(c => Math.abs(ch[c][k] - colour[c]))) <= 14) near++;
  return { plain: near >= n * 0.985, colour };
}

/** The plain margins of a picture along an axis: rows (or columns) of one colour from its start, and from its end. */
export function plainMargins(px: Rgba, axis: 'x' | 'y'): { start: number; end: number; length: number } {
  const length = axis === 'y' ? px.height : px.width, kind = axis === 'y' ? 'row' : 'col';
  let start = 0; while (start < length && line(px, kind, start).plain) start++;
  let end = length; while (end > start && line(px, kind, end - 1).plain) end--;
  return { start, end, length };
}

/** The layout of a template's base (its prepared background, `base`) in an aspect ratio. */
export function planRatio(base: Rgba, ratio: ProductAspectRatio): RatioLayout {
  const source = { width: base.width, height: base.height }, target = productCanvasFor(source, ratio);
  const none: RatioLayout = { aspectRatio: ratio, sourceCanvas: source, target, scale: 1, axis: 'none', extra: { before: 0, after: 0 }, method: 'template' };
  if (target.width === source.width && target.height === source.height) return none;
  const axis: 'x' | 'y' = target.height > source.height ? 'y' : 'x', extra = axis === 'y' ? target.height - source.height : target.width - source.width;
  // A margin shorter than 4 % of the side is an edge stroke or a border, never lengthened.
  const m = plainMargins(base, axis), min = Math.max(8, Math.round(m.length * 0.04));
  const head = m.start >= min ? m.start : 0, tail = m.length - m.end >= min ? m.length - m.end : 0;
  if (head || tail) {
    const before = Math.round(extra * head / (head + tail));
    return { ...none, axis, method: 'plain-bands', extra: { before, after: extra - before }, bands: { start: head, end: m.length - tail } };
  }
  const kind = axis === 'y' ? 'row' : 'col', before = Math.floor(extra / 2);
  return { ...none, axis, method: 'letterbox', extra: { before, after: extra - before },
    fill: { before: hex(line(base, kind, 0).colour), after: hex(line(base, kind, m.length - 1).colour) } };
}

/** The background in the layout: margins made longer (or plain margins added); optionally restyled. */
export async function ratioBackground(basePng: Buffer, layout: RatioLayout, restyle?: { saturation: number; brightness: number }): Promise<{ png: Buffer; filledPercent: number }> {
  const { width: W, height: H } = layout.sourceCanvas, T = layout.target;
  let png: Buffer;
  if (layout.method === 'template') png = await sharp(basePng).ensureAlpha().png().toBuffer();
  else {
    const y = layout.axis === 'y', { before, after } = layout.extra, parts: OverlayOptions[] = [];
    const cut = (from: number, to: number) => sharp(basePng).ensureAlpha().extract(y ? { left: 0, top: from, width: W, height: to - from } : { left: from, top: 0, width: to - from, height: H });
    if (layout.method === 'plain-bands' && layout.bands) {
      const { start, end } = layout.bands, length = y ? H : W;
      // A plain margin is one colour across: made longer, it is still exactly that margin.
      if (start > 0) parts.push({ input: await cut(0, start).resize(y ? { width: W, height: start + before, fit: 'fill' } : { width: start + before, height: H, fit: 'fill' }).png().toBuffer(), left: 0, top: 0 });
      parts.push({ input: await cut(start, end).png().toBuffer(), left: y ? 0 : start + before, top: y ? start + before : 0 });
      if (end < length) parts.push({ input: await cut(end, length).resize(y ? { width: W, height: length - end + after, fit: 'fill' } : { width: length - end + after, height: H, fit: 'fill' }).png().toBuffer(), left: y ? 0 : end + before, top: y ? end + before : 0 });
    } else {
      const fill = layout.fill ?? { before: '#ffffff', after: '#ffffff' };
      if (before > 0) parts.push({ input: { create: { width: y ? W : before, height: y ? before : H, channels: 4, background: fill.before } }, left: 0, top: 0 });
      if (after > 0) parts.push({ input: { create: { width: y ? W : after, height: y ? after : H, channels: 4, background: fill.after } }, left: y ? 0 : W + before, top: y ? H + before : 0 });
      parts.push({ input: await sharp(basePng).ensureAlpha().png().toBuffer(), left: y ? 0 : before, top: y ? before : 0 });
    }
    png = await sharp({ create: { width: T.width, height: T.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(parts).png().toBuffer();
  }
  if (restyle && (restyle.saturation !== 1 || restyle.brightness !== 1)) png = await sharp(png).modulate({ saturation: restyle.saturation, brightness: restyle.brightness }).png().toBuffer();
  const filled = layout.method === 'letterbox' ? (layout.extra.before + layout.extra.after) / (layout.axis === 'y' ? T.height : T.width) : 0;
  return { png, filledPercent: Math.round(filled * 1000) / 10 };
}

type Box = { x: number; y: number; width: number; height: number };
const union = (boxes: Box[]): Box => { const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y)); return { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height: Math.max(...boxes.map(b => b.y + b.height)) - y }; };

/**
 * A creative (in template coordinates) placed in the layout; sizes unchanged (scale 1). The artwork between the margins
 * moves as one block with everything on it. In a lengthened margin, its elements keep their order and size and the extra
 * space is shared out evenly between them (a header's logos sit centred between the canvas edge and the artwork; a
 * footer's rows spread out evenly). A text group moves as one, its plates with it.
 */
export function applyRatioLayout(c: ProductCreative, layout: RatioLayout, measure: MeasureText = fontMeasure): ProductCreative {
  if (layout.method === 'template') return { ...c, layout: undefined };
  const y = layout.axis === 'y', { before, after } = layout.extra;
  const along = (b: Box) => (y ? { a: b.y, b: b.y + b.height } : { a: b.x, b: b.x + b.width });
  // Every element (a text group counts as one) with its extent along the axis.
  const items: { key: string; a: number; b: number }[] = [];
  for (const g of c.groups) {
    const words = c.texts.filter(t => t.groupId === g.id && t.text.trim());
    if (words.length) items.push({ key: `g:${g.id}`, ...along(union(words.map(t => textBounds(t, measure)))) });
  }
  for (const t of c.texts) if (!c.groups.some(g => g.id === t.groupId)) items.push({ key: `t:${t.id}`, ...along(textBounds(t, measure)) });
  for (const s of c.shapes) if (!items.some(i => i.key === `g:${s.groupId}`)) items.push({ key: `s:${s.id}`, ...along(s.box) });
  for (const i of c.images) items.push({ key: `i:${i.id}`, ...along(i.box) });
  for (const o of c.objects) items.push({ key: `o:${o.id}`, ...along(o.box) });
  const shift = new Map<string, number>();
  if (layout.method === 'letterbox' || !layout.bands) for (const it of items) shift.set(it.key, before);
  else {
    const { start, end } = layout.bands, head: typeof items = [], tail: typeof items = [];
    for (const it of items) { const centre = (it.a + it.b) / 2; if (centre < start) head.push(it); else if (centre >= end) tail.push(it); else shift.set(it.key, before); }
    /** A margin's elements in rows (elements that overlap along the axis share a row), the extra space shared between the rows' gaps. */
    const spread = (list: typeof items, offset: number, extra: number) => {
      const rows: { a: number; b: number; keys: string[] }[] = [];
      for (const it of [...list].sort((p, q) => p.a - q.a)) { const last = rows.at(-1); if (last && it.a <= last.b + 2) { last.b = Math.max(last.b, it.b); last.keys.push(it.key); } else rows.push({ a: it.a, b: it.b, keys: [it.key] }); }
      rows.forEach((r, i) => { for (const k of r.keys) shift.set(k, offset + Math.round((i + 1) * extra / (rows.length + 1))); });
    };
    spread(head, 0, before);
    spread(tail, before, after);
  }
  const d = (key: string) => shift.get(key) ?? before;
  const move = <T extends Box>(b: T, by: number): T => (y ? { ...b, y: b.y + by } : { ...b, x: b.x + by });
  const textShift = (t: CreativeText) => (c.groups.some(g => g.id === t.groupId) ? d(`g:${t.groupId}`) : d(`t:${t.id}`));
  const { sourceCanvas, scale, axis, extra, bands, aspectRatio } = layout;
  return { ...c, canvas: { ...layout.target },
    texts: c.texts.map(t => { const by = textShift(t); return y ? { ...t, baselineY: t.baselineY + by } : { ...t, x: t.x + by }; }),
    shapes: c.shapes.map(s => ({ ...s, box: move(s.box, items.some(i => i.key === `g:${s.groupId}`) ? d(`g:${s.groupId}`) : d(`s:${s.id}`)) })),
    images: c.images.map(i => ({ ...i, box: move(i.box, d(`i:${i.id}`)) })),
    objects: c.objects.map(o => { const b = move(o.box, d(`o:${o.id}`)); return { ...o, box: { x: Math.round(b.x), y: Math.round(b.y), width: b.width, height: b.height } }; }),
    layout: { aspectRatio, sourceCanvas, scale, axis, extra, ...(bands ? { bands } : {}) } };
}
