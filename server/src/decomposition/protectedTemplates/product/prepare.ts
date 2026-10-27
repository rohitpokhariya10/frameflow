import { creativeStyleOf, decomposesObject } from '@frameflow/shared';
import { svgPng, textInkExact, textSvg } from '../../../templateStudio/masterCreatives/render.js';
/**
 * A Product with Text template prepared from its reviewed elements, locally except for one optional, approved step:
 *
 *   1 overlays out   every editable overlay (text ink, text plates, bank and payment logos, QR codes) removed and the
 *                    background continued behind it (the template's own structure: a plain page, a panel's repeating
 *                    pattern; else the clean background's fill): the CLEAN picture
 *   2 gate           the clean picture is checked before anything may see it: where an overlay was, its pixels must be
 *                    gone (blocking). Each provider input is separately cropped, masked and checked for excluded pixels.
 *   3 objects        each approved character and product on its own: SAM-3 masks (one request per
 *                    object, $0.01 each, only when the administrator approved it) or the local estimate (what is not the
 *                    background's own colours inside the object's box; an object in front claims what it overlaps)
 *   3b stands        the display stands products stand on (risers, pedestals, a shared platform: risers.ts) on their
 *                    own layers, out of the products' masks and out of the background, completed where products hide
 *                    them; the shared podium stays in the background
 *   4 cut-outs       each object's pixels with its true transparency at its rim (against what is behind it: a stand, or
 *                    the base); each stand's seen pixels and its completed part
 *   5 base           the clean picture with every object and stand taken out and the background continued behind them
 *   6 checks         the creative recombined (base, objects, overlays) against the original, the clean picture against
 *                    base + objects, and each object on its own (coverage, overlaps, an estimated background behind it)
 *
 * What is behind an object or a removed overlay can only be estimated from one flattened picture: every known pixel is
 * kept, only hidden ones are filled, and the share that is an estimate is reported, never claimed exact.
 */
import sharp from 'sharp';
import type { LogoSlot, PixelRect, ProductAiSeparation, ProductObject, ProductQuality, ProductQualityIssue, TextAnalysis } from '@frameflow/shared';
import { flattenRgb, sha256, type Rgba } from '../pixels.js';
import { removalMask } from '../master/removal.js';
import { extendLineToInk } from '../master/scan.js';
import { measureWord } from '../../../textRecognition/measure.js';
import { cleanBackground } from '../master/patternFill.js';
import { fillLevels, levelsOf, unmix } from '../master/artworkRebuild.js';
import { groundColours, groundMask } from '../master/artworkObjects.js';
import { inpaint } from './inpaint.js';
import { fullSizeFill, guidedFill, type BackgroundGuide, type GuidedFill } from './backgroundGuide.js';
import { burstAtFullSize } from './burst.js';
import { findRisers, type Riser } from './risers.js';
import { binDown, dilate, maskDown, sampleRgb, upsampleLabels, workIndex, workSize, type WorkSize } from './multiscale.js';
import { sentSize, type AiDecomposition, type ProductLayerizer } from './aiDecompose.js';
import { refineMasks } from './segment.js';
import { artworkGroups, restoreArtworkRaw } from './artworkText.js';
import type { Segmenter } from '../../creativeTemplates/segmenter.js';

type Box = PixelRect;
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
export class OverlayGateError extends Error { constructor(message: string, readonly areas: Box[]) { super(message); this.name = 'OverlayGateError'; } }

/**
 * The AI words' ink measured again where their letters are (measureWord: against the nearest of the colours around each
 * word), for the removal mask. A stored colour measured as a mix of two backgrounds, or at another place, masks the
 * background and leaves the letters: white "Festive" on an orange-over-green badge was stored as the green, its letters
 * stayed in the picture and the band of green under them was streaked. A word too faint to measure keeps its colour.
 */
export function withMeasuredInk(source: Rgba, analysis: TextAnalysis): TextAnalysis {
  return { ...analysis, words: analysis.words.map(w => {
    if (w.origin !== 'ai' || w.review.status === 'rejected' || w.box.rotation) return w;
    const m = measureWord(source, w.source?.box ?? w.box, w.text);
    return m.evidence.separation >= 0.25 && m.color !== w.style.color ? { ...w, style: { ...w.style, color: m.color } } : w;
  }) };
}

/**
 * A word's own ink pixels inside `padded` (its box grown by the mask's pad): the marks of its ink colour of a word's size.
 * A mark of that colour much taller or wider than the word — a badge's white ring passing its ends, a rule through the
 * line — is the artwork's and stays (masked, it was filled with streaks over the badge's border).
 */
export function wordLetters(source: Rgba, ink: number[], padded: { x0: number; y0: number; x1: number; y1: number }, box: Box): [number, number][] {
  const { width: W, height: H, data } = source, lh = Math.max(1, box.height);
  // The marks are followed a line's height past the word in every direction, to see how far they reach.
  const wx0 = Math.max(0, padded.x0 - lh), wy0 = Math.max(0, padded.y0 - lh), wx1 = Math.min(W, padded.x1 + lh), wy1 = Math.min(H, padded.y1 + lh), ww = wx1 - wx0, wh = wy1 - wy0;
  const isInk = (x: number, y: number) => { const i = (y * W + x) * 4; return Math.max(Math.abs(data[i] - ink[0]), Math.abs(data[i + 1] - ink[1]), Math.abs(data[i + 2] - ink[2])) <= 70; };
  const seen = new Uint8Array(ww * wh), out: [number, number][] = [];
  for (let y = padded.y0; y < padded.y1; y++) for (let x = padded.x0; x < padded.x1; x++) {
    const k = (y - wy0) * ww + x - wx0;
    if (seen[k] || !isInk(x, y)) continue;
    const stack = [k], comp: number[] = []; seen[k] = 1;
    let minX = x, maxX = x, minY = y, maxY = y;
    while (stack.length) {
      const q = stack.pop()!, qx = q % ww + wx0, qy = Math.floor(q / ww) + wy0; comp.push(q);
      if (qx < minX) minX = qx; if (qx > maxX) maxX = qx; if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = qx + dx, ny = qy + dy; if (nx < wx0 || ny < wy0 || nx >= wx1 || ny >= wy1) continue;
        const nk = (ny - wy0) * ww + nx - wx0; if (seen[nk] || !isInk(nx, ny)) continue; seen[nk] = 1; stack.push(nk);
      }
    }
    // A letter (or letters joined by their edges): no taller than the line with its pad, no wider than the word and a line.
    if (maxY - minY + 1 > box.height * 1.35 + 2 * (padded.y1 - padded.y0 - box.height) / 2 + 2 || maxX - minX + 1 > box.width + lh) continue;
    for (const q of comp) { const qx = q % ww + wx0, qy = Math.floor(q / ww) + wy0; if (qx >= padded.x0 && qx < padded.x1 && qy >= padded.y0 && qy < padded.y1) out.push([qx, qy]); }
  }
  return out;
}

/** The overlays' removal mask: text ink of every kept word's line, text plates, bank/payment logos and QR codes. */
export function overlayMask(source: Rgba, given: TextAnalysis | undefined): { mask: Uint8Array; areas: { id: string; box: Box }[]; sweep: { id: string; box: Box; plain: boolean }[] } {
  const areas: { id: string; box: Box }[] = [];
  if (!given) return { mask: new Uint8Array(source.width * source.height), areas, sweep: [] };
  const analysis = withMeasuredInk(source, given);
  const lines: { box: Box; ink: string; lineHeight: number }[] = [];
  for (const g of analysis.groups) for (const l of g.lines) {
    const words = l.wordIds.map(id => analysis.words.find(w => w.id === id)).filter((w): w is NonNullable<typeof w> => !!w && w.review.status !== 'rejected').map(w => ({ ...w, box: w.source?.box ?? w.box }));
    if (!words.length) continue;
    const x0 = Math.min(...words.map(w => w.box.x)), y0 = Math.min(...words.map(w => w.box.y)), x1 = Math.max(...words.map(w => w.box.x + w.box.width)), y1 = Math.max(...words.map(w => w.box.y + w.box.height));
    const h = Math.max(...words.map(w => w.box.height)), ink = words[0].style.color, box = words.every(w => w.origin === 'ai') ? { x: Math.floor(x0), y: Math.floor(y0), width: Math.ceil(x1) - Math.floor(x0), height: Math.ceil(y1) - Math.floor(y0) } : extendLineToInk(source, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, h, ink);
    if (!words.every(w => w.origin === 'ai')) lines.push({ box, ink, lineHeight: h });
    areas.push({ id: g.id, box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } });
  }
  const keptGroups = new Set(analysis.groups.filter(g => analysis.words.some(w => w.groupId === g.id && w.review.status !== 'rejected')).map(g => g.id));
  const plates = (analysis.plates ?? []).filter(p => p.review.status !== 'rejected' && keptGroups.has(p.groupId)).map(p => ({ box: p.box, strokeWidth: p.stroke?.width ?? 0 }));
  const logos = overlayLogos(analysis).map(l => ({ box: l.box, category: l.category === 'qr' ? 'qr' : 'partner-logo' }));
  for (const l of overlayLogos(analysis)) areas.push({ id: l.id, box: { x: Math.round(l.box.x), y: Math.round(l.box.y), width: Math.round(l.box.width), height: Math.round(l.box.height) } });
  const mask = removalMask(source, { lines, plates, logos });
  for (const word of analysis.words.filter(w => w.review.status !== 'rejected')) {
    const b = word.source?.box ?? word.box;
    if (word.origin === 'ai') {
      // The ink and its soft edge: a letter's anti-aliasing is wider in a bigger picture (3–4 px at 4096 px), so the ink is
      // widened by a share of the word's height (1 px for small print; faint letter outlines were left on the rays).
      const ink = [1,3,5].map(i => parseInt(word.style.color.slice(i,i+2),16)), r = Math.max(1, Math.round(b.height * 0.08)), pad = r + 1;
      const px0 = Math.max(0, Math.floor(b.x) - pad), py0 = Math.max(0, Math.floor(b.y) - pad), px1 = Math.min(source.width, Math.ceil(b.x + b.width) + pad), py1 = Math.min(source.height, Math.ceil(b.y + b.height) + pad);
      for (const [x, y] of wordLetters(source, ink, { x0: px0, y0: py0, x1: px1, y1: py1 }, b))
        for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++)if(x+dx>=0&&y+dy>=0&&x+dx<source.width&&y+dy<source.height)mask[(y+dy)*source.width+x+dx]=1;
      continue;
    }
    for (let y = Math.max(0, Math.floor(b.y) - 1); y < Math.min(source.height, Math.ceil(b.y + b.height) + 1); y++)
      for (let x = Math.max(0, Math.floor(b.x) - 1); x < Math.min(source.width, Math.ceil(b.x + b.width) + 1); x++) mask[y * source.width + x] = 1;
  }
  const sweep = sweepPlainLines(source, analysis, mask);
  return { mask, areas, sweep };
}

/**
 * Text on a plain plate (a banner, a pill, a white page): a word's measured ink colour misses its anti-aliased edges,
 * and a tight word box misses its punctuation (a colon, the dot of an i), which then stay as marks in the clean picture.
 * Around each line of AI-measured words (padded by a third of its height), where what surrounds the line is one colour,
 * every pixel that is not that colour is the line's ink and is removed with it. Lines on busy artwork are left to the
 * ink-colour mask (nothing of the artwork is swept). Returns the swept areas (to be filled).
 */
export function sweepPlainLines(source: Rgba, analysis: TextAnalysis, mask: Uint8Array): { id: string; box: Box; plain: boolean }[] {
  const { width: w, height: h, data } = source, out: { id: string; box: Box; plain: boolean }[] = [];
  for (const g of analysis.groups) for (const l of g.lines) {
    const words = l.wordIds.map(id => analysis.words.find(x => x.id === id)).filter((x): x is NonNullable<typeof x> => !!x && x.review.status !== 'rejected');
    if (!words.length || !words.every(x => x.origin === 'ai')) continue;
    const boxes = words.map(x => x.source?.box ?? x.box), lh = Math.max(...boxes.map(b => b.height));
    const px = Math.max(3, Math.round(lh * 0.35)), py = Math.max(2, Math.round(lh * 0.25));
    const x0 = Math.max(0, Math.floor(Math.min(...boxes.map(b => b.x))) - px), y0 = Math.max(0, Math.floor(Math.min(...boxes.map(b => b.y))) - py);
    const x1 = Math.min(w, Math.ceil(Math.max(...boxes.map(b => b.x + b.width))) + px), y1 = Math.min(h, Math.ceil(Math.max(...boxes.map(b => b.y + b.height))) + py);
    // What surrounds the line: 3 px strips just above and below the padded box (its ends may meet the plate's own ends).
    const ring: number[][] = [[], [], []];
    for (let y = Math.max(0, y0 - 3); y < Math.min(h, y1 + 3); y++) for (let x = x0; x < x1; x++) {
      if (y >= y0 && y < y1) continue;
      const i = (y * w + x) * 4; for (let c = 0; c < 3; c++) ring[c].push(data[i + c]);
    }
    if (ring[0].length < 12) continue;
    const bg = ring.map(v => [...v].sort((a, b) => a - b)[v.length >> 1]);
    let near = 0; for (let k = 0; k < ring[0].length; k++) if (Math.max(...[0, 1, 2].map(c => Math.abs(ring[c][k] - bg[c]))) <= 20) near++;
    // Plain: three quarters of it one colour (a plate's soft rim may fall in the strips); stripes or artwork are not. On
    // artwork, only marks in the text's own ink colour joined to its letters are taken (the badge ribbon's leftover "g").
    const plain = near >= ring[0].length * 0.75, ink = [1, 3, 5].map(k => parseInt(words[0].style.color.slice(k, k + 2), 16));
    let swept = 0;
    // Only around each word (padded): a divider or ornament between words on the same plate is the plate's, not text.
    if (plain) for (const b of boxes) for (let y = Math.max(y0, Math.floor(b.y) - py); y < Math.min(y1, Math.ceil(b.y + b.height) + py); y++) for (let x = Math.max(x0, Math.floor(b.x) - px); x < Math.min(x1, Math.ceil(b.x + b.width) + px); x++) {
      const i = y * w + x, p = i * 4;
      if (Math.max(Math.abs(data[p] - bg[0]), Math.abs(data[p + 1] - bg[1]), Math.abs(data[p + 2] - bg[2])) > 16) { if (!mask[i]) swept++; mask[i] = 1; }
    }
    // Letters a box missed at the line's ends ("Va" left of a box drawn a little to the right): marks within the line's
    // band, each no wider than a letter or two and no taller than the line, joined letter by letter to the line's text.
    // A rule or an ornament (wider, or reaching past the line's band) is the plate's own and stays.
    const bx0 = Math.max(0, Math.floor(x0 - 2 * lh)), bx1 = Math.min(w, Math.ceil(x1 + 2 * lh)), bw = bx1 - bx0, bh = y1 - y0, label = new Int32Array(bw * bh).fill(-1);
    const off = (i: number) => { const p = i * 4; return plain ? Math.max(Math.abs(data[p] - bg[0]), Math.abs(data[p + 1] - bg[1]), Math.abs(data[p + 2] - bg[2])) > 16 : Math.max(Math.abs(data[p] - ink[0]), Math.abs(data[p + 1] - ink[1]), Math.abs(data[p + 2] - ink[2])) <= 60; };
    const comps: { x0: number; x1: number; y0: number; y1: number; px: number[]; masked: number }[] = [];
    for (let y = y0; y < y1; y++) for (let x = bx0; x < bx1; x++) {
      const k = (y - y0) * bw + x - bx0; if (label[k] >= 0 || !off(y * w + x)) continue;
      const comp = { x0: x, x1: x, y0: y, y1: y, px: [] as number[], masked: 0 }, stack = [k]; label[k] = comps.length;
      while (stack.length) {
        const q = stack.pop()!, qx = q % bw + bx0, qy = Math.floor(q / bw) + y0, i = qy * w + qx;
        comp.px.push(i); if (mask[i]) comp.masked++;
        comp.x0 = Math.min(comp.x0, qx); comp.x1 = Math.max(comp.x1, qx); comp.y0 = Math.min(comp.y0, qy); comp.y1 = Math.max(comp.y1, qy);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx, ny = qy + dy; if (nx < bx0 || nx >= bx1 || ny < y0 || ny >= y1) continue;
          const nk = (ny - y0) * bw + nx - bx0; if (label[nk] >= 0 || !off(ny * w + nx)) continue; label[nk] = comps.length; stack.push(nk);
        }
      }
      comps.push(comp);
    }
    // Inside the line's band; a letter or two wide, or (letters joined by their soft edges into a word) mostly text already.
    const inBand = (c: typeof comps[number]) => c.y0 > y0 && c.y1 < y1 - 1, letter = (c: typeof comps[number]) => inBand(c) && c.x1 - c.x0 + 1 <= 1.5 * lh;
    const accepted = new Set(comps.filter(c => c.masked && (letter(c) || (inBand(c) && c.masked >= c.px.length * 0.3))));
    for (let grew = true; grew;) {
      grew = false;
      for (const c of comps) if (!accepted.has(c) && letter(c) && [...accepted].some(a => Math.max(a.x0 - c.x1, c.x0 - a.x1) <= 0.6 * lh)) { accepted.add(c); grew = true; }
    }
    let ends = 0;
    for (const c of accepted) for (const i of c.px) if (!mask[i]) { mask[i] = 1; ends++; }
    if (swept || ends) {
      const xs = [...accepted].flatMap(c => [c.x0, c.x1 + 1]), ex0 = Math.min(x0, ...xs), ex1 = Math.max(x1, ...xs);
      // On artwork, the area to fill is only what the marks cover: the padded band reaches past a pill's rim into the page
      // around it, whose colour was then read into the letters (mint letters on an orange "What to expect" pill).
      const ys = [...accepted].flatMap(c => [c.y0, c.y1 + 1]);
      const box = plain || !ys.length ? { x: ex0, y: y0, width: ex1 - ex0, height: y1 - y0 } : { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      out.push({ id: `${g.id}:${l.id}`, box, plain });
    }
  }
  return out;
}
/** The logos that are layers of their own (taken out of the picture): all but rejected ones and those kept in the picture. */
export const overlayLogos = (a: TextAnalysis | undefined): LogoSlot[] => (a?.logoSlots ?? []).filter(s => s.review.status !== 'rejected' && !s.inBackground);

/** What is behind `mask`, continued: from the picture's structure where it has one, else the clean background's fill. */
export async function rebuildBehind(rgb: Uint8Array, w: number, h: number, mask: Uint8Array, noBlur = false, guide?: BackgroundGuide): Promise<{ rgb: Uint8Array; structural: number; estimated: number; trustedPercent: number; unknown: Uint8Array; patched: Uint8Array;
  /** What the scene's structure filled (backgroundGuide.ts), and where the background's own levels did (1). */ guided?: GuidedFill; levels?: Uint8Array }> {
  const n = w * h, levels = levelsOf(rgb, w, h, mask), rebuilt = fillLevels(rgb, w, h, mask, levels), out = Uint8Array.from(rebuilt.out), rest = new Uint8Array(n);
  let structural = 0, left = 0, trusted = 100, patched = rest, guided: GuidedFill | undefined;
  for (let i = 0; i < n; i++) if (mask[i]) { if (rebuilt.filled[i]) structural++; else { rest[i] = 1; left++; } }
  if (left && noBlur) {
    // Rebuilt from the surrounding artwork's own patches (inpaint.ts): no hole, no blur, no invented object. An estimate
    // of pixels that were never visible, reported as such (`unknown` is that area). First what the scene's structure says
    // (the floor under the stands, a symmetric layout's mirror: backgroundGuide.ts); the patches continue the rest.
    let left2 = rest;
    if (guide) { guided = guidedFill(out, w, h, rest, guide); out.set(guided.rgb); const g = guided; left2 = Uint8Array.from(rest, (v, i) => (v && !g.filled[i] ? 1 : 0)); }
    patched = left2;
    const exclude = guide?.oneOff?.length ? new Uint8Array(w * h) : undefined;
    for (const b of guide?.oneOff ?? []) for (let y = Math.max(0, Math.floor(b.y)); y < Math.min(h, Math.ceil(b.y + b.height)); y++) for (let x = Math.max(0, Math.floor(b.x)); x < Math.min(w, Math.ceil(b.x + b.width)); x++) exclude![y * w + x] = 1;
    const standing = [...(guide?.stage ? [guide.stage] : []), ...(guide?.stands ?? [])];
    if (standing.length) {
      // First what lies outside the stage's and the stands' boxes, from anything but them (the stage's gold bands were
      // stacked up the wall where a character stood); then their own parts, from their own pixels only (patches of the
      // wall's rays had left a product-shaped window in a pink block behind the products).
      // (Inside the boxes, only pixels of the stand's own colours are sources: a box holds other things too — a speaker
      // in front of a platform was copied into a satellite speaker's place.)
      // (Sources inside a box: each hidden part's own surroundings — the colours seen just around it, nearby. A box holding
      // several structures, a mint cylinder beside pink blocks, has no one colour: its median filled a dishwasher's place
      // with mint and pink blobs.)
      const boxes = new Uint8Array(n), standLike = new Uint8Array(n), bucket = (i: number) => (out[i * 3] >> 4 << 8) | (out[i * 3 + 1] >> 4 << 4) | (out[i * 3 + 2] >> 4);
      for (const b of standing) {
        const x0 = Math.max(0, Math.floor(b.x)), x1 = Math.min(w, Math.ceil(b.x + b.width)), y0 = Math.max(0, Math.floor(b.y)), y1 = Math.min(h, Math.ceil(b.y + b.height));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) boxes[y * w + x] = 1;
        // Each connected hidden part in the box: its ring (seen pixels within 3 of it), its window (its extent and half as much again).
        const seenPart = new Uint8Array(n), r = 3;
        for (let ys = y0; ys < y1; ys++) for (let xs = x0; xs < x1; xs++) {
          const s0 = ys * w + xs; if (!left2[s0] || seenPart[s0]) continue;
          const part = [s0], stack = [s0]; seenPart[s0] = 1; let px0 = xs, py0 = ys, px1 = xs, py1 = ys;
          while (stack.length) { const i = stack.pop()!, x = i % w, y = (i - x) / w; if (x < px0) px0 = x; if (x > px1) px1 = x; if (y < py0) py0 = y; if (y > py1) py1 = y;
            for (const [X, Y] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) { if (X < x0 || Y < y0 || X >= x1 || Y >= y1) continue; const j = Y * w + X; if (left2[j] && !seenPart[j]) { seenPart[j] = 1; part.push(j); stack.push(j); } } }
          const counts = new Map<number, number>(); let ring = 0;
          for (let y = Math.max(y0, py0 - r); y < Math.min(y1, py1 + r + 1); y++) for (let x = Math.max(x0, px0 - r); x < Math.min(x1, px1 + r + 1); x++) {
            const i = y * w + x; if (left2[i] || mask[i]) continue;
            let near = false; for (let dy = -r; dy <= r && !near; dy++) for (let dx = -r; dx <= r && !near; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h && seenPart[Y * w + X] && left2[Y * w + X]) near = true; }
            if (near) { counts.set(bucket(i), (counts.get(bucket(i)) ?? 0) + 1); ring++; }
          }
          if (!ring) continue;
          const dominant = new Set([...counts].filter(([, c]) => c >= ring * 0.05).map(([k]) => k));
          const ofRing = (i: number) => { const k = bucket(i), R = k >> 8, G = (k >> 4) & 15, B = k & 15; for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) if (dominant.has(((R + dr) << 8) | ((G + dg) << 4) | (B + db))) return true; return false; };
          const mx = Math.max(px1 - px0, py1 - py0) >> 1, wx0 = Math.max(x0, px0 - mx), wx1 = Math.min(x1, px1 + mx + 1), wy0 = Math.max(y0, py0 - mx), wy1 = Math.min(y1, py1 + mx + 1);
          for (let y = wy0; y < wy1; y++) for (let x = wx0; x < wx1; x++) { const i = y * w + x; if (!left2[i] && !mask[i] && ofRing(i)) standLike[i] = 1; }
        }
      }
      const outer = Uint8Array.from(left2, (v, i) => (v && !boxes[i] ? 1 : 0)), inner = Uint8Array.from(left2, (v, i) => (v && boxes[i] ? 1 : 0));
      out.set(inpaint(out, w, h, outer, { exclude: Uint8Array.from(exclude ?? new Uint8Array(n), (v, i) => (v || boxes[i] ? 1 : 0)) }));
      out.set(inpaint(out, w, h, inner, { exclude: Uint8Array.from(exclude ?? new Uint8Array(n), (v, i) => (v || !boxes[i] || !standLike[i] ? 1 : 0)) }));
    } else out.set(inpaint(out, w, h, left2, exclude ? { exclude } : {}));
    trusted = 0;
  } else if (left) {
    const rgba = Buffer.alloc(n * 4); for (let i = 0; i < n; i++) { rgba[i * 4] = out[i * 3]; rgba[i * 4 + 1] = out[i * 3 + 1]; rgba[i * 4 + 2] = out[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
    const clean = await cleanBackground({ data: rgba, width: w, height: h }, rest), fill = await sharp(clean.png).removeAlpha().raw().toBuffer();
    for (let i = 0; i < n; i++) if (rest[i]) for (let c = 0; c < 3; c++) out[i * 3 + c] = fill[i * 3 + c];
    trusted = clean.trustedPercent;
  }
  return { rgb: out, structural, estimated: Math.round(left * (100 - trusted) / 100), trustedPercent: trusted, unknown: noBlur ? rest : new Uint8Array(n), patched, ...(guided ? { guided } : {}), levels: rebuilt.filled };
}

/** Overlay-only fill. Narrow source boxes; copy the surrounding flat colour when there is one (judged on a ring just
 * outside the box: inside it, a logo's own edges are not the background), otherwise interpolate each masked scanline
 * and report the area as uncertain (refillPatterned then continues the pattern there). Never blur a surrounding region. */
export function fillOverlayPixels(rgb: Uint8Array, w: number, h: number, mask: Uint8Array, areas: { id: string; box: Box; plate?: boolean }[]) {
  const out = Uint8Array.from(rgb), uncertain: { id: string; box: Box }[] = [], patterned: { id: string; box: Box }[] = [];
  for (const area of areas) {
    const b = area.box, buckets = new Map<string, number[][]>();
    const x0 = Math.max(0, Math.floor(b.x) - 3), y0 = Math.max(0, Math.floor(b.y) - 3), x1 = Math.min(w, Math.ceil(b.x + b.width) + 3), y1 = Math.min(h, Math.ceil(b.y + b.height) + 3);
    const R = Math.max(6, Math.round(b.height * 0.15)), rx0 = Math.max(0, x0 - R), ry0 = Math.max(0, y0 - R), rx1 = Math.min(w, x1 + R), ry1 = Math.min(h, y1 + R);
    let samples = 0;
    const sample = (i: number) => { const c = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]], key = c.map(v => v >> 4).join(','); let bucket = buckets.get(key); if (!bucket) buckets.set(key, bucket = []); bucket.push(c); samples++; };
    if (!area.plate) for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) { if (x >= x0 && x < x1 && y >= y0 && y < y1) continue; const i = y * w + x; if (!mask[i]) sample(i); }
    // On a plate, too little ring (at the picture's edge, or text on text): what is not masked inside, as before.
    if (samples < 20) { buckets.clear(); samples = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * w + x; if (!mask[i]) sample(i); } }
    const ranked = [...buckets.values()].sort((a,b) => b.length - a.length), dominant = ranked[0] ?? [];
    // A two-colour pattern around it (the stripes of a radial burst): continued by refillPatterned, not by one colour.
    const second = ranked[1]?.length ?? 0, twoTone = dominant.length >= samples * 0.2 && second >= samples * 0.2 && dominant.length + second >= samples * 0.75;
    const flat = dominant.length / Math.max(1, samples) >= 0.7;
    const color = [0,1,2].map(c => { const v = dominant.map(p => p[c]).sort((a,b) => a-b); return v[v.length >> 1] ?? 255; });
    if (!flat) uncertain.push(area);
    // (Also when the box is mostly one stripe: the letters crossing into the other one would take the wrong colour.)
    if (twoTone && !area.plate) patterned.push(area);
    for (let y = y0; y < y1; y++) for (let x = x0, left = -1, right = -1; x < x1; x++) {
      const i = y * w + x; if (!mask[i]) continue;
      if (flat) { for (let c=0;c<3;c++) out[i*3+c] = color[c]; continue; }
      // The masked run this pixel is in, found once per run (a scan per pixel is quadratic in the run's length).
      if (x >= right) { left = x - 1; while (left >= 0 && mask[y*w+left]) left--; right = x + 1; while (right < w && mask[y*w+right]) right++; }
      for (let c=0;c<3;c++) out[i*3+c] = left >= 0 && right < w ? Math.round(rgb[(y*w+left)*3+c] + (rgb[(y*w+right)*3+c] - rgb[(y*w+left)*3+c]) * (x-left)/(right-left)) : color[c];
    }
  }
  return { rgb: out, uncertain, patterned };
}

/**
 * Text and logos taken off a patterned background (a radial burst, a badge's artwork): the pattern continued into their
 * pixels from its own patches around them (inpaint.ts), every other text and logo kept out of the sources — a single
 * colour there left letter-shaped blocks of the other stripe, and row interpolation streaks. Local: one crop per group
 * of nearby areas; only the masked pixels inside those areas change.
 */
export function refillPatterned(rgb: Uint8Array, w: number, h: number, mask: Uint8Array, areas: { id: string; box: Box }[]): number {
  const crops = areas.map(a => { const m = Math.max(24, Math.round(a.box.height)); return { x0: Math.max(0, Math.floor(a.box.x) - m), y0: Math.max(0, Math.floor(a.box.y) - m), x1: Math.min(w, Math.ceil(a.box.x + a.box.width) + m), y1: Math.min(h, Math.ceil(a.box.y + a.box.height) + m), areas: [a] }; });
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < crops.length && !merged; i++) for (let j = i + 1; j < crops.length && !merged; j++) {
      const p = crops[i], q = crops[j];
      if (p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1) { crops[i] = { x0: Math.min(p.x0, q.x0), y0: Math.min(p.y0, q.y0), x1: Math.max(p.x1, q.x1), y1: Math.max(p.y1, q.y1), areas: [...p.areas, ...q.areas] }; crops.splice(j, 1); merged = true; }
    }
  }
  let changed = 0;
  for (const c of crops) {
    const cw = c.x1 - c.x0, ch = c.y1 - c.y0, crop = new Uint8Array(cw * ch * 3), hole = new Uint8Array(cw * ch), exclude = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = (y + c.y0) * w + x + c.x0, k = y * cw + x; for (let ch3 = 0; ch3 < 3; ch3++) crop[k * 3 + ch3] = rgb[i * 3 + ch3];
      if (!mask[i]) continue;
      const X = x + c.x0, Y = y + c.y0;
      if (c.areas.some(a => X >= a.box.x - 3 && X < a.box.x + a.box.width + 3 && Y >= a.box.y - 3 && Y < a.box.y + a.box.height + 3)) hole[k] = 1; else exclude[k] = 1;
    }
    let known = 0; for (let k = 0; k < cw * ch; k++) if (!hole[k] && !exclude[k]) known++;
    if (known < cw * ch * 0.3) continue;
    const filled = inpaint(crop, cw, ch, hole, { exclude });
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const k = y * cw + x; if (!hole[k]) continue; const i = (y + c.y0) * w + x + c.x0; for (let ch3 = 0; ch3 < 3; ch3++) rgb[i * 3 + ch3] = filled[k * 3 + ch3]; changed++; }
  }
  return changed;
}

/**
 * The colours around a box, from its ring's pixels (per channel: `ring[c]`): each colour covering a tenth of the ring or
 * more when there are two or more (text on a badge split in two colours), else the ring's median.
 */
export function ringColours(ring: number[][]): number[][] {
  const n = ring[0]?.length ?? 0, buckets = new Map<number, number[]>();
  for (let k = 0; k < n; k++) { const key = (ring[0][k] >> 4 << 8) | (ring[1][k] >> 4 << 4) | (ring[2][k] >> 4); const b = buckets.get(key); if (b) b.push(k); else buckets.set(key, [k]); }
  const med = (v: number[]) => { const s = [...v].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };
  const major = [...buckets.values()].filter(b => b.length >= n * 0.1).sort((a, b) => b.length - a.length).slice(0, 4);
  return major.length >= 2 ? major.map(b => [0, 1, 2].map(c => med(b.map(k => ring[c][k])))) : [[0, 1, 2].map(c => med(ring[c]))];
}
/** How far an RGB pixel (`rgb` at `q`) is from the nearest of `colours` (largest channel difference). */
const nearestColour = (rgb: Uint8Array, q: number, colours: number[][]) => Math.min(...colours.map(c => Math.max(Math.abs(rgb[q] - c[0]), Math.abs(rgb[q + 1] - c[1]), Math.abs(rgb[q + 2] - c[2]))));

/**
 * The gate: where an overlay was, the clean picture must not still show it. An overlay's own pixels are the ones of its
 * removal mask that stand out from what is just around its area (text ink, a logo card); most of them must have changed.
 * A picture that still keeps over half of any overlay's pixels is refused, and nothing is sent anywhere.
 */
export function assertOverlaysGone(source: Uint8Array, clean: Uint8Array, mask: Uint8Array, w: number, areas: { id: string; box: Box }[]): void {
  const h = source.length / 3 / w, failed: Box[] = [];
  const far = (a: Uint8Array, i: number, c: number[], t: number) => Math.abs(a[i * 3] - c[0]) > t || Math.abs(a[i * 3 + 1] - c[1]) > t || Math.abs(a[i * 3 + 2] - c[2]) > t;
  for (const a of areas) {
    // What is around the area: the median of a 4 px ring outside it (not itself an overlay).
    const ring: number[][] = [[], [], []], x0 = Math.max(0, a.box.x - 4), y0 = Math.max(0, a.box.y - 4), x1 = Math.min(w, a.box.x + a.box.width + 4), y1 = Math.min(h, a.box.y + a.box.height + 4);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (x >= a.box.x && x < a.box.x + a.box.width && y >= a.box.y && y < a.box.y + a.box.height) continue;
      const i = y * w + x; if (mask[i]) continue;
      for (let c = 0; c < 3; c++) ring[c].push(source[i * 3 + c]);
    }
    const around = ringColours(ring);
    let own = 0, kept = 0;
    for (let y = a.box.y; y < Math.min(h, a.box.y + a.box.height); y++) for (let x = a.box.x; x < Math.min(w, a.box.x + a.box.width); x++) {
      const i = y * w + x;
      if (!mask[i] || nearestColour(source, i * 3, around) <= 40) continue;
      own++; if (!far(clean, i, [source[i * 3], source[i * 3 + 1], source[i * 3 + 2]], 8)) kept++;
    }
    if (own >= 20 && kept / own > 0.5) failed.push(a.box);
  }
  if (failed.length) throw new OverlayGateError(`${failed.length} text or logo area(s) are still in the picture; nothing is sent until they are removed.`, failed);
}

/**
 * Each object's mask (1 = its pixels): the local estimate. Inside an object's box, what is not the background's own
 * colours is the object's. Where boxes overlap (a mascot beside a podium, a product standing on it), a pixel goes to the
 * object its colour is most typical of (from where no other box reaches), the one in front when it is as typical of
 * both. A box drawn a little tight is no limit: the object's pixels continue a short way past it (5 %, at most 32 px).
 */
function localMasks(rgb: Uint8Array, w: number, h: number, objects: ProductObject[]): Map<string, Uint8Array> {
  const n = w * h, grounds = groundColours(rgb, w, h), ground = groundMask(rgb, w, h, grounds), out = new Map<string, Uint8Array>();
  const front = [...objects].sort((a, b) => b.z - a.z), within = (b: Box, x: number, y: number) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
  const reach = front.map(o => { const m = Math.min(32, Math.max(4, Math.round(Math.max(o.box.width, o.box.height) * 0.05))); return { x: o.box.x - m, y: o.box.y - m, width: o.box.width + 2 * m, height: o.box.height + 2 * m }; });
  const bucket = (i: number) => (rgb[i * 3] >> 4 << 8) | (rgb[i * 3 + 1] >> 4 << 4) | (rgb[i * 3 + 2] >> 4);
  // Each object's colours: a histogram (4 bits a channel) of its pixels no other object can reach (else: that no other
  // box holds; else, its box lying wholly inside others' — a microwave inside a character's over-wide box, speakers inside
  // a TV's — all of its box), as shares.
  const histograms = front.map((o, k) => {
    const counts = new Float32Array(4096); let total = 0;
    for (const others of [reach, front.map(p => p.box), [] as Box[]]) {
      for (let y = Math.max(0, o.box.y); y < Math.min(h, o.box.y + o.box.height); y++) for (let x = Math.max(0, o.box.x); x < Math.min(w, o.box.x + o.box.width); x++) {
        const i = y * w + x; if (ground[i] || others.some((b, j) => j !== k && within(b, x, y))) continue;
        counts[bucket(i)]++; total++;
      }
      if (total >= 50) break;
      counts.fill(0); total = 0;
    }
    // Smoothed over neighbouring buckets (a colour one step off is still the object's).
    const smooth = new Float32Array(4096);
    if (total) for (let r = 0; r < 16; r++) for (let g = 0; g < 16; g++) for (let b = 0; b < 16; b++) {
      let sum = 0; for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) { const R = r + dr, G = g + dg, B = b + db; if (R >= 0 && G >= 0 && B >= 0 && R < 16 && G < 16 && B < 16) sum += counts[(R << 8) | (G << 4) | B]; }
      smooth[(r << 8) | (g << 4) | b] = sum / total;
    }
    return { smooth, total };
  });
  // What is just around each object's reach (its surroundings): past its box, a colour as common there is not the object's.
  const around = front.map((_, k) => {
    const counts = new Float32Array(4096), r = reach[k], m = 6; let total = 0;
    for (let y = Math.max(0, r.y - m); y < Math.min(h, r.y + r.height + m); y++) for (let x = Math.max(0, r.x - m); x < Math.min(w, r.x + r.width + m); x++) {
      if (within(r, x, y)) continue; const i = y * w + x; if (ground[i]) continue; counts[bucket(i)]++; total++;
    }
    return { counts, total };
  });
  const aroundShare = (k: number, i: number) => { const a = around[k]; if (!a.total) return 0; const b = bucket(i), r = b >> 8, g = (b >> 4) & 15, bl = b & 15; let sum = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) { const R = r + dr, G = g + dg, B = bl + db; if (R >= 0 && G >= 0 && B >= 0 && R < 16 && G < 16 && B < 16) sum += a.counts[(R << 8) | (G << 4) | B]; }
    return sum / a.total; };
  const owner = new Int16Array(n).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (ground[i]) continue;
    let pick = -1, pickP = 0, pickIn = false;
    for (let k = 0; k < front.length; k++) {
      if (!within(reach[k], x, y)) continue;
      const inBox = within(front[k].box, x, y), p = histograms[k].total ? histograms[k].smooth[bucket(i)] : inBox ? 1e-6 : 0;
      // Past its box only a colour of its own counts; inside, the front object keeps a pixel unless it is far more typical of another.
      if (!inBox && (p < 0.004 || aroundShare(k, i) * 3 > p)) continue;
      if (pick < 0 || p > pickP * 2 || (inBox && !pickIn && p >= pickP * 0.5)) { pick = k; pickP = p; pickIn = inBox; }
    }
    if (pick >= 0) owner[i] = pick;
  }
  const claimed = new Uint8Array(n);
  for (const [k, o] of front.entries()) {
    const m = new Uint8Array(n), b = o.box, r = reach[k];
    for (let y = Math.max(0, b.y); y < Math.min(h, b.y + b.height); y++) for (let x = Math.max(0, b.x); x < Math.min(w, b.x + b.width); x++) { const i = y * w + x; if (owner[i] === k) m[i] = 1; }
    // Past the box: its own pixels connected to what is inside.
    const queue: number[] = [];
    for (let i = 0; i < n; i++) if (m[i]) queue.push(i);
    while (queue.length) { const i = queue.pop()!, x = i % w, y = (i - x) / w; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h || !within(r, X, Y)) continue; const j = Y * w + X; if (m[j] || owner[j] !== k) continue; m[j] = 1; queue.push(j); } }
    // A character in front of busy artwork: artwork that reaches into its box from the box's edge, in colours far more
    // typical of the box's edges and surroundings than of the box's middle (where the character is), is not the character.
    // (Not for products: one reaching past its box — a TV's speakers — took its own outside part for surroundings.)
    if (o.kind === 'character') {
      const bx0 = Math.max(0, b.x), by0 = Math.max(0, b.y), bx1 = Math.min(w, b.x + b.width), by1 = Math.min(h, b.y + b.height), BW = bx1 - bx0, BH = by1 - by0;
      const fg = new Float32Array(4096), bg = new Float32Array(4096); let nf = 0, nb = 0;
      for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
        const i = y * w + x; if (!m[i]) continue;
        const inner = x >= bx0 + BW * 0.25 && x < bx1 - BW * 0.25 && y >= by0 + BH * 0.2 && y < by1 - BH * 0.2, edge = x < bx0 + 4 || x >= bx1 - 4 || y < by0 + 4 || y >= by1 - 4;
        if (inner) { fg[bucket(i)]++; nf++; } else if (edge) { bg[bucket(i)]++; nb++; }
      }
      const a = around[k]; for (let q = 0; q < 4096; q++) bg[q] += a.counts[q]; nb += a.total;
      const share = (hist: Float32Array, total: number, i: number) => { if (!total) return 0; const q = bucket(i), r = q >> 8, g = (q >> 4) & 15, bl = q & 15; let sum = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) { const R = r + dr, G = g + dg, B = bl + db; if (R >= 0 && G >= 0 && B >= 0 && R < 16 && G < 16 && B < 16) sum += hist[(R << 8) | (G << 4) | B]; }
        return sum / total; };
      const artwork = (i: number) => { const s = share(bg, nb, i); return s > 0.01 && s > 1.5 * share(fg, nf, i); };
      if (nf && nb) {
        const seen = new Uint8Array(BW * BH), stack: number[] = [];
        for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) if ((x === bx0 || y === by0 || x === bx1 - 1 || y === by1 - 1) && m[y * w + x] && artwork(y * w + x)) { seen[(y - by0) * BW + x - bx0] = 1; stack.push(y * w + x); }
        while (stack.length) {
          const i = stack.pop()!, x = i % w, y = (i - x) / w; m[i] = 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < bx0 || Y < by0 || X >= bx1 || Y >= by1) continue; const j = Y * w + X, l = (Y - by0) * BW + X - bx0; if (seen[l] || !m[j] || !artwork(j)) continue; seen[l] = 1; stack.push(j); }
        }
        // What the pruning left outside the box (its reach) and no longer touching the character goes too.
        const keep = new Uint8Array(n), q: number[] = [];
        for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) { const i = y * w + x; if (m[i] && x >= bx0 + BW * 0.25 && x < bx1 - BW * 0.25 && y >= by0 + BH * 0.2 && y < by1 - BH * 0.2) { keep[i] = 1; q.push(i); } }
        while (q.length) { const i = q.pop()!, x = i % w; for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < n && m[j] && !keep[j]) { keep[j] = 1; q.push(j); } }
        for (let i = 0; i < n; i++) if (m[i] && !keep[i]) m[i] = 0;
      }
    }
    // Ground enclosed by the object (a white face on a product, a gap between its parts) is the object's; what another
    // object's pixels enclose is not.
    const X0 = Math.max(0, r.x), Y0 = Math.max(0, r.y), W = Math.min(w, r.x + r.width) - X0, H = Math.min(h, r.y + r.height) - Y0, open = new Uint8Array(W * H), seeds: number[] = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y + Y0) * w + x + X0; if (m[i]) continue; if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || (owner[i] >= 0 && owner[i] !== k)) { open[y * W + x] = 1; seeds.push(y * W + x); } }
    while (seeds.length) { const q = seeds.pop()!, x = q % W, y = (q - x) / W; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue; const j = Y * W + X; if (open[j] || m[(Y + Y0) * w + X + X0]) continue; open[j] = 1; seeds.push(j); } }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!open[y * W + x]) m[(y + Y0) * w + x + X0] = 1;
    for (let i = 0; i < n; i++) if (m[i]) { if (claimed[i]) m[i] = 0; else claimed[i] = 1; }
    out.set(o.id, m);
  }
  for (const o of objects.filter(o => o.kind === 'product')) {
    const m=out.get(o.id)!, b=o.box;
    const neutral = (i: number) => Math.min(rgb[i*3],rgb[i*3+1],rgb[i*3+2]) > 145 && Math.max(rgb[i*3],rgb[i*3+1],rgb[i*3+2])-Math.min(rgb[i*3],rgb[i*3+1],rgb[i*3+2]) < 25;
    let ring=0, pale=0;
    for(let y=Math.max(0,b.y-4);y<Math.min(h,b.y+b.height+4);y++)for(let x=Math.max(0,b.x-4);x<Math.min(w,b.x+b.width+4);x++)if(x<b.x||y<b.y||x>=b.x+b.width||y>=b.y+b.height) {ring++;if(neutral(y*w+x))pale++;}
    if (pale/Math.max(1,ring)>0.2) continue;
    const queue: number[]=[];
    for(let y=b.y;y<b.y+b.height;y++)for(let x=b.x;x<b.x+b.width;x++)if(m[y*w+x])queue.push(y*w+x);
    while(queue.length){ const i=queue.pop()!,x=i%w,y=Math.floor(i/w);
      for(const [X,Y] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]) {
        if(X<b.x||Y<b.y||X>=b.x+b.width||Y>=b.y+b.height)continue;
        const j=Y*w+X;if(m[j]||claimed[j]||!neutral(j))continue;
        m[j]=1;claimed[j]=1;queue.push(j);
      }
    }
  }
  return out;
}

/** Conservative exclusion: full source boxes, including overlaps and removed overlays. */
export function providerExclusionMask(source: Rgba, analysis: TextAnalysis | undefined): Uint8Array {
  const mask = new Uint8Array(source.width * source.height);
  const boxes: (Box & { rotation?: number })[] = [...(analysis?.sourceExclusions ?? []), ...(analysis?.words ?? []).map(w => w.source?.box ?? w.box), ...(analysis?.logoSlots ?? []).map(l => l.original.placement)];
  const bounds = boxes.map(b => {
    if (!b.rotation) return b;
    // Enclose both common rotation anchors conservatively; never leak rotated overlay corners.
    const angle = b.rotation * Math.PI / 180, points = [];
    for (const [cx, cy] of [[b.x, b.y], [b.x + b.width / 2, b.y + b.height / 2]])
      for (const [x, y] of [[b.x,b.y], [b.x+b.width,b.y], [b.x,b.y+b.height], [b.x+b.width,b.y+b.height]])
        points.push({ x: cx + (x-cx)*Math.cos(angle) - (y-cy)*Math.sin(angle), y: cy + (x-cx)*Math.sin(angle) + (y-cy)*Math.cos(angle) });
    const x = Math.min(b.x, ...points.map(p => p.x)), y = Math.min(b.y, ...points.map(p => p.y));
    return { x, y, width: Math.max(b.x+b.width, ...points.map(p => p.x))-x, height: Math.max(b.y+b.height, ...points.map(p => p.y))-y };
  });
  for (const b of bounds) for (let y = Math.max(0, Math.floor(b.y) - 2); y < Math.min(source.height, Math.ceil(b.y + b.height) + 2); y++)
    for (let x = Math.max(0, Math.floor(b.x) - 2); x < Math.min(source.width, Math.ceil(b.x + b.width) + 2); x++) mask[y * source.width + x] = 1;
  return mask;
}
/** Build and decode the actual PNG we will send; excluded pixels have zero RGB as well as zero alpha. */
export async function isolatedObjectInput(source: Rgba, target: ProductObject, mask: Uint8Array, excluded: Uint8Array): Promise<Buffer> {
  const b = target.box;
  if (!['character', 'product'].includes(target.kind) || target.review.status !== 'accepted' ||
    ![b.x, b.y, b.width, b.height].every(Number.isSafeInteger) || b.x < 0 || b.y < 0 || b.width < 1 || b.height < 1 || b.x + b.width > source.width || b.y + b.height > source.height ||
    mask.length !== source.width * source.height || excluded.length !== mask.length)
    throw new OverlayGateError('Invalid isolated decomposition target. Only approved characters and products are allowed.', [b]);
  const rgba = Buffer.alloc(b.width * b.height * 4); let visible = 0, removed = 0;
  for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
    const i = (y + b.y) * source.width + x + b.x, j = (y * b.width + x) * 4;
    if (!mask[i]) continue;
    if (excluded[i]) { removed++; continue; }
    source.data.copy(rgba, j, i * 4, i * 4 + 4); visible++;
  }
  if (visible < 16 || visible / (b.width * b.height) < 0.05 || removed / Math.max(1, visible + removed) > 0.25)
    throw new OverlayGateError(`Cannot isolate “${target.label}” reliably. Correct its box or supply a clean cutout; nothing is sent for this object.`, [b]);
  const png = await sharp(rgba, { raw: { width: b.width, height: b.height, channels: 4 } }).png().toBuffer();
  const decoded = await sharp(png).ensureAlpha().raw().toBuffer();
  for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
    const i = (y + b.y) * source.width + x + b.x, j = (y * b.width + x) * 4;
    if ((!mask[i] || excluded[i]) && decoded.subarray(j, j + 4).some(v => v !== 0)) throw new OverlayGateError('Excluded pixels in provider input; request blocked.', [b]);
  }
  return png;
}

/** Steps 3 (the local masks, unless the provider's are given) and 3b (display stands) on one picture size. */
function separateObjects(clean: Uint8Array, w: number, h: number, objects: ProductObject[], given?: Map<string, Uint8Array>): { masks: Map<string, Uint8Array>; risers: Riser[]; guide: BackgroundGuide } {
  const n = w * h, method: 'sam3' | 'local' = given ? 'sam3' : 'local';
  const live = objects.filter(decomposesObject).sort((a, b) => a.z - b.z);
  let masks: Map<string, Uint8Array>;
  // A background area the administrator drew over a product (below) does not compete for pixels like an object.
  const inside = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)) / Math.max(1, a.width * a.height);
  const areas = objects.filter(o => !o.hidden && o.origin === 'user' && (o.kind === 'frame' || o.kind === 'decoration') && live.some(l => inside(o.box, l.box) >= 0.5));
  if (given) masks = new Map(given);
  else {
    const sceneMasks = localMasks(clean, w, h, objects.filter(o => !o.hidden && !areas.includes(o)));
    masks = new Map(live.map(o => [o.id, sceneMasks.get(o.id)!]));
    // Refined (segment.ts): each mask completed where its colours missed it, scenery taken out, front to back.
    {
      const others = objects.filter(o => !o.hidden && !live.includes(o) && o.kind !== 'podium' && o.kind !== 'decoration').map(o => o.box);
      // (Display blocks kept in the background: their colour inside a product's mask is theirs.)
      const blocks = objects.filter(o => !o.hidden && o.kind === 'podium' && o.layer !== 'own').map(o => o.box);
      masks = refineMasks(clean, w, h, live.map(o => ({ id: o.id, kind: o.kind, box: o.box, z: o.z })), masks, others, blocks).masks;
    }
  }
  // Stray pieces of a local mask (bits of the artwork around a character, a border dot under its feet) are background:
  // each object keeps its largest connected part and the parts at least 15 % of its size.
  // (A part beside a background area the administrator drew — a sound bar in front of the wall taken out — is kept.)
  const beside = new Uint8Array(n);
  const keepMain = (m: Uint8Array) => {
    const label = new Int32Array(n).fill(-1), sizes: number[] = [], near: boolean[] = [];
    for (let i = 0; i < n; i++) {
      if (!m[i] || label[i] >= 0) continue;
      const stack = [i], k = sizes.length; label[i] = k; let count = 0, touches = false;
      while (stack.length) { const q = stack.pop()!, x = q % w; count++; if (beside[q]) touches = true;
        for (const j of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, q - w, q + w, x > 0 ? q - w - 1 : -1, x < w - 1 ? q - w + 1 : -1, x > 0 ? q + w - 1 : -1, x < w - 1 ? q + w + 1 : -1])
          if (j >= 0 && j < n && m[j] && label[j] < 0) { label[j] = k; stack.push(j); } }
      sizes.push(count); near.push(touches);
    }
    if (sizes.length < 2) return m;
    const largest = sizes.reduce((a, b) => Math.max(a, b), 0), kept = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (m[i] && (sizes[label[i]] >= largest * 0.15 || near[label[i]])) kept[i] = 1;
    return kept;
  };
  if (method === 'local') for (const [oid, m] of masks) masks.set(oid, keepMain(m));
  // A character's local mask keeps no scenery: a smooth region (colours stepping by little) that mostly continues outside
  // its box and never reaches its middle (a podium's band behind its feet, the podium's top beside it, a frame line) is
  // the scene's, not the character's.
  if (method === 'local') for (const o of live.filter(x => x.kind === 'character')) {
    const m = masks.get(o.id)!, b = o.box, margin = Math.max(8, Math.round(Math.max(b.width, b.height) * 0.15));
    const X0 = Math.max(0, b.x - margin), Y0 = Math.max(0, b.y - margin), X1 = Math.min(w, b.x + b.width + margin), Y1 = Math.min(h, b.y + b.height + margin);
    const core = { x: b.x + b.width * 0.15, y: b.y + b.height * 0.15, width: b.width * 0.7, height: b.height * 0.7 }, inBox = (x: number, y: number) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
    const seen = new Uint8Array(n); let removed = 0;
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      const s0 = y * w + x; if (seen[s0] || !m[s0]) continue;
      const px = [s0], stack = [s0]; seen[s0] = 1;
      while (stack.length) {
        const i = stack.pop()!, xx = i % w, yy = (i - xx) / w;
        for (const [X, Y] of [[xx - 1, yy], [xx + 1, yy], [xx, yy - 1], [xx, yy + 1]]) {
          if (X < X0 || Y < Y0 || X >= X1 || Y >= Y1) continue; const j = Y * w + X;
          if (seen[j] || Math.max(Math.abs(clean[i * 3] - clean[j * 3]), Math.abs(clean[i * 3 + 1] - clean[j * 3 + 1]), Math.abs(clean[i * 3 + 2] - clean[j * 3 + 2])) > 6) continue;
          seen[j] = 1; px.push(j); stack.push(j);
        }
      }
      if (px.length < 20) continue;
      let outside = 0, middle = 0; for (const i of px) { const xx = i % w, yy = (i - xx) / w; if (!inBox(xx, yy)) outside++; else if (xx >= core.x && xx < core.x + core.width && yy >= core.y && yy < core.y + core.height) middle++; }
      if (outside >= px.length * 0.35 && middle < px.length * 0.05) for (const i of px) if (m[i]) { m[i] = 0; removed++; }
    }
    if (removed) masks.set(o.id, keepMain(m));
  }
  // A background area the administrator drew over a product (a wall behind a TV, a panel it hangs on): the area's own
  // colour — the product's pixels its border runs through (the wall reaches out to it; what hangs on the wall is inside)
  // — is the background's where it is a large patch or reaches the area's edge; a small detail of that colour (a white
  // logo on a screen) and what stands in front (a sound bar, speakers) stay with the product.
  for (const a of areas) {
    const X0 = Math.max(0, Math.floor(a.box.x)), Y0 = Math.max(0, Math.floor(a.box.y)), X1 = Math.min(w, Math.ceil(a.box.x + a.box.width)), Y1 = Math.min(h, Math.ceil(a.box.y + a.box.height));
    if (X1 - X0 < 3 || Y1 - Y0 < 3) continue;
    const over = live.filter(o => inside(a.box, o.box) > 0).map(o => masks.get(o.id)!), inMask = (i: number) => over.some(m => m[i]);
    const ring: number[] = []; for (let x = X0; x < X1; x++) ring.push(Y0 * w + x, (Y1 - 1) * w + x); for (let y = Y0 + 1; y < Y1 - 1; y++) ring.push(y * w + X0, y * w + X1 - 1);
    const onProduct = ring.filter(inMask); if (onProduct.length < 10) continue;
    // The most common colour there (its median): where the border crosses other things too (a platform below), the wall's.
    const counts = new Map<number, number[]>();
    for (const i of onProduct) { const k = (clean[i * 3] >> 4 << 8) | (clean[i * 3 + 1] >> 4 << 4) | (clean[i * 3 + 2] >> 4); let l = counts.get(k); if (!l) counts.set(k, l = []); l.push(i); }
    const top = [...counts.values()].sort((p, q) => q.length - p.length)[0];
    const own = [0, 1, 2].map(c => top.map(i => clean[i * 3 + c]).sort((p, q) => p - q)[top.length >> 1]);
    const ofOwn = (i: number) => Math.max(Math.abs(clean[i * 3] - own[0]), Math.abs(clean[i * 3 + 1] - own[1]), Math.abs(clean[i * 3 + 2] - own[2])) <= 40;
    const seen = new Uint8Array(n), area = new Uint8Array(n), minPatch = (X1 - X0) * (Y1 - Y0) * 0.02;
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      const s0 = y * w + x; if (seen[s0] || !inMask(s0) || !ofOwn(s0)) continue;
      const part = [s0], stack = [s0]; seen[s0] = 1; let edge = false;
      while (stack.length) {
        const i = stack.pop()!, xx = i % w, yy = (i - xx) / w; if (xx === X0 || yy === Y0 || xx === X1 - 1 || yy === Y1 - 1) edge = true;
        for (const [X, Y] of [[xx - 1, yy], [xx + 1, yy], [xx, yy - 1], [xx, yy + 1]]) {
          if (X < X0 || Y < Y0 || X >= X1 || Y >= Y1) continue; const j = Y * w + X;
          if (seen[j] || !inMask(j) || !ofOwn(j) || Math.max(Math.abs(clean[i * 3] - clean[j * 3]), Math.abs(clean[i * 3 + 1] - clean[j * 3 + 1]), Math.abs(clean[i * 3 + 2] - clean[j * 3 + 2])) > 10) continue;
          seen[j] = 1; part.push(j); stack.push(j);
        }
      }
      if (edge || part.length >= minPatch) for (const i of part) area[i] = 1;
    }
    for (const m of over) for (let i = 0; i < n; i++) if (area[i]) m[i] = 0;
    for (let i = 0; i < n; i++) if (area[i]) { const x = i % w; for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < n && !area[j]) beside[j] = 1; }
  }
  // A band of the podium running into a character's box from the podium's side (ornamented, so not one smooth region): on
  // the podium's rows (its top included), walking in from the mask's end on the side facing the podium's middle, the
  // pixels of the colours the band shows on the same rows — sampled a little past the mask, beyond the character's own
  // soft edge — are the podium's (at most 30 % of the box's width; a pass that would take more than an eighth of the
  // character, or cut parts of it off, is undone).
  const podiumBox = objects.filter(o => !o.hidden && o.kind === 'podium' && o.layer !== 'own').sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0]?.box;
  if (method === 'local' && podiumBox) for (const o of live.filter(x => x.kind === 'character')) {
    const m = masks.get(o.id)!, b = o.box, cap = Math.max(3, Math.round(b.width * 0.3)), probe = Math.max(4, Math.round(w * 0.013)), others = live.filter(x => x !== o).map(x => x.box);
    const inOther = (x: number, y: number) => others.some(q => x >= q.x && x < q.x + q.width && y >= q.y && y < q.y + q.height);
    const before = Uint8Array.from(m), size = m.reduce((s, v) => s + v, 0); let removed = 0;
    const dir = b.x + b.width / 2 < podiumBox.x + podiumBox.width / 2 ? 1 : -1;
    // Each of the podium's rows where the mask ends with the band free just past it (no other object there), and the
    // band's pixels there (this row and its neighbours).
    const rows = Array.from({ length: Math.max(0, Math.min(h, b.y + b.height, podiumBox.y + podiumBox.height) - Math.max(0, b.y, Math.round(podiumBox.y - podiumBox.height * 0.35))) }, (_, k) => Math.max(0, b.y, Math.round(podiumBox.y - podiumBox.height * 0.35)) + k);
    const bandAt = new Map<number, number[]>();
    for (const y of rows) {
      let end = -1; for (let x = dir > 0 ? Math.min(w - 1, b.x + b.width + cap) : Math.max(0, b.x - cap); dir > 0 ? x >= b.x : x < b.x + b.width; x -= dir) if (m[y * w + x]) { end = x; break; }
      if (end < 0) continue;
      const band: number[] = [];
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) for (let d = Math.max(2, probe >> 1); d <= 2 * probe; d++) { const x = end + dir * d; if (x < 0 || x >= w || m[yy * w + x] || inOther(x, yy)) continue; band.push(yy * w + x); }
      if (band.length < probe) continue;
      bandAt.set(y, [end, ...band]);
    }
    const near = (i: number, j: number) => Math.max(Math.abs(clean[i * 3] - clean[j * 3]), Math.abs(clean[i * 3 + 1] - clean[j * 3 + 1]), Math.abs(clean[i * 3 + 2] - clean[j * 3 + 2])) <= 36;
    for (const [y, [end, ...band]] of bandAt) {
      const ofBand = (i: number) => band.some(j => near(i, j));
      // One odd pixel (a glint of the ornament) does not end the band, nor a short gap in the mask; two odd ones in a row,
      // or a long gap, do.
      const run: number[] = [];
      for (let x = end, k = 0, miss = 0, gap = 0; k < cap && x >= 0 && x < w; x -= dir, k++) {
        const i = y * w + x; if (!m[i]) { if (++gap > 3) break; continue; } gap = 0;
        if (ofBand(i)) { miss = 0; run.push(i); } else if (++miss > 1) break; else run.push(i);
      }
      while (run.length && !ofBand(run[run.length - 1])) run.pop();
      for (const i of run) { m[i] = 0; removed++; }
    }
    // Never at the cost of the character itself: too much taken, or parts of it cut off by the pass, and it is undone.
    const kept = removed && removed <= size / 8 ? keepMain(m) : before;
    masks.set(o.id, kept.reduce((s, v) => s + v, 0) < (size - removed) * 0.97 ? before : kept);
  }
  // 3b Display stands: found under the products (and in the administrator's "its own layer" boxes, not in their "part of
  // the background" ones), taken out of the products' and characters' masks; the shared podium stays in the background.
  const podiums = objects.filter(o => !o.hidden && o.kind === 'podium');
  let floor: Uint8Array | undefined;
  const sharedPodium = podiums.filter(o => o.layer !== 'own').sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
  const risers = findRisers(clean, w, h, {
    objects: live.map(o => ({ box: o.box, kind: o.kind as 'product' | 'character', mask: masks.get(o.id) })), podium: sharedPodium?.box,
    ground: groundMask(clean, w, h, groundColours(clean, w, h)), hints: podiums.filter(o => o.layer).map(o => ({ box: o.box, layer: o.layer!, id: o.id })),
    structures: objects.filter(o => !o.hidden && (o.kind === 'decoration' || o.kind === 'frame')).map(o => o.box),
    onFloor: px => { floor = new Uint8Array(n); for (const i of px) floor[i] = 1; },
  }).sort((a, b) => a.seenBottom - b.seenBottom);
  if (risers.length) {
    const taken = new Uint8Array(n); for (const r of risers) for (let i = 0; i < n; i++) if (r.visible[i]) taken[i] = 1;
    for (const [oid, m] of masks) { let removed = 0; for (let i = 0; i < n; i++) if (m[i] && taken[i]) { m[i] = 0; removed++; } if (removed) masks.set(oid, keepMain(m)); }
  }
  // An object's outline left just past its mask (a frame's light border, an edge line; on the analysed picture, as its
  // thresholds are in pixels): walking out from its edge, up to
  // 3 px, the pixels that stand out from the background 4 px out and are of the object's own edge colour go with the
  // object, with the soft pixel after them (else a thin line of it stays in the background when it is moved or hidden).
  {
    const owner = new Int32Array(n).fill(-1), list = [...masks.values()], taken = new Uint8Array(n);
    list.forEach((m, k) => { for (let i = 0; i < n; i++) if (m[i]) owner[i] = k; });
    for (const r of risers) for (let i = 0; i < n; i++) if (r.visible[i]) taken[i] = 1;
    const dc = (i: number, j: number) => Math.max(Math.abs(clean[i * 3] - clean[j * 3]), Math.abs(clean[i * 3 + 1] - clean[j * 3 + 1]), Math.abs(clean[i * 3 + 2] - clean[j * 3 + 2]));
    const add: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      if (owner[i] < 0) continue;
      const x = i % w, y = (i - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ox = x + 4 * dx, oy = y + 4 * dy; if (ox < 0 || oy < 0 || ox >= w || oy >= h) continue;
        const o = oy * w + ox; if (owner[o] >= 0 || taken[o]) continue;
        const q = [1, 2, 3].map(d => (y + d * dy) * w + x + d * dx);
        if (owner[q[0]] >= 0 || q.some(j => taken[j] || (owner[j] >= 0 && owner[j] !== owner[i]))) continue;
        let far = 0; for (let d = 0; d < 3; d++) { const out = dc(q[d], o); if (out > 20 && dc(q[d], i) <= 24) far = d + 1; }
        if (!far) continue;
        if (far < 3 && dc(q[far], o) > 8) far++;
        for (let d = 0; d < far; d++) add.push([q[d], owner[i]]);
      }
    }
    for (const [q, k] of add) if (owner[q] < 0) { owner[q] = k; list[k][q] = 1; }
  }
  // What the background rebuild may lean on: the floor, reaching a little behind the farthest stand seen standing on it;
  // decorations are one-offs (never mirrored).
  let floorTop: number | undefined;
  if (floor) {
    // The floor is the podium's top: a band just above its front, never higher than 60 % of the podium's height over it
    // (a cream stand joined to it at the working size is not floor; filling up to it painted the back wall cream).
    const cut = sharedPodium ? Math.round(sharedPodium.box.y - sharedPodium.box.height * 0.6) : 0;
    for (let i = 0; i < cut * w && i < n; i++) floor[i] = 0;
    const rows: number[] = []; for (let i = 0; i < n; i++) if (floor[i]) { rows.push(Math.floor(i / w)); break; }
    // Where stands are seen standing, a little behind the farthest of them; the floor's own first row is often a stand's
    // top joined to it (painted up to there, every product's place took the stand's colour well above the stands).
    const seen = risers.filter(r => r.bottomSeen).map(r => r.seenBottom);
    floorTop = Math.max(cut, (seen.length ? Math.min(...seen) : Math.min(...rows)) - Math.round(0.01 * h));
  }
  return { masks, risers, guide: { ...(floor ? { floor, floorTop } : {}), oneOff: objects.filter(o => !o.hidden && o.kind === 'decoration').map(o => o.box), ...(sharedPodium ? { stage: sharedPodium.box } : {}),
    stands: podiums.filter(o => o.layer !== 'own').map(o => o.box) } };
}

const scaleBox = (b: Box, ws: WorkSize): Box => {
  const x = Math.floor(b.x * ws.fx), y = Math.floor(b.y * ws.fy);
  return { x, y, width: Math.max(1, Math.ceil((b.x + b.width) * ws.fx) - x), height: Math.max(1, Math.ceil((b.y + b.height) * ws.fy) - y) };
};
/** Bilinear value (0..1) of a working mask at a full-size pixel. */
const maskAt = (m: Uint8Array, ws: WorkSize, x: number, y: number) => {
  const u = Math.min(ws.w - 1, Math.max(0, (x + 0.5) * ws.fx - 0.5)), v = Math.min(ws.h - 1, Math.max(0, (y + 0.5) * ws.fy - 0.5));
  const x0 = Math.floor(u), y0 = Math.floor(v), x1 = Math.min(ws.w - 1, x0 + 1), y1 = Math.min(ws.h - 1, y0 + 1), tx = u - x0, ty = v - y0;
  return (m[y0 * ws.w + x0] * (1 - tx) + m[y0 * ws.w + x1] * tx) * (1 - ty) + (m[y1 * ws.w + x0] * (1 - tx) + m[y1 * ws.w + x1] * tx) * ty;
};

/**
 * 3 and 3b for a large picture: decided on the working copy (the sizes the analysis was tuned on); each object's and
 * stand's pixels then taken at full size, their edges following the full-size picture (multiscale.ts). A stand's
 * completed part (an estimate) is the working one, sampled up; what it shows is the full-size picture's own.
 */
function separateLarge(clean: Uint8Array, w: number, h: number, wclean: Uint8Array, ws: WorkSize, objects: ProductObject[], given?: Map<string, Uint8Array>): { masks: Map<string, Uint8Array>; risers: Riser[]; guide: BackgroundGuide } {
  const n = w * h, nw = ws.w * ws.h;
  const work = separateObjects(wclean, ws.w, ws.h, objects.map(o => ({ ...o, box: scaleBox(o.box, ws) })), given && new Map([...given].map(([id, m]) => [id, maskDown(m, w, h, ws)])));
  const live = objects.filter(decomposesObject).sort((a, b) => a.z - b.z);
  const labels = new Int32Array(nw).fill(-1);
  live.forEach((o, k) => { const m = work.masks.get(o.id); if (m) for (let q = 0; q < nw; q++) if (m[q]) labels[q] = k; });
  work.risers.forEach((r, j) => { for (let q = 0; q < nw; q++) if (r.visible[q]) labels[q] = live.length + j; });
  const full = upsampleLabels(labels, wclean, ws, clean, w, h);
  const masks = new Map<string, Uint8Array>();
  live.forEach((o, k) => {
    const m = new Uint8Array(n), g = given?.get(o.id);
    // The provider's own mask, less the stands; else the object's label.
    if (g) { for (let i = 0; i < n; i++) if (g[i] && full[i] < live.length) m[i] = 1; } else for (let i = 0; i < n; i++) if (full[i] === k) m[i] = 1;
    masks.set(o.id, m);
  });
  const px = [0, 0, 0];
  const risers = work.risers.map((r, j): Riser => {
    const own = live.length + j, visible = new Uint8Array(n), shape = new Uint8Array(n), completedW = Uint8Array.from(r.shape, (v, q) => (v && !r.visible[q] ? 1 : 0));
    const X0 = Math.max(0, Math.floor((r.box.x - 2) / ws.fx)), Y0 = Math.max(0, Math.floor((r.box.y - 2) / ws.fy)), X1 = Math.min(w, Math.ceil((r.box.x + r.box.width + 2) / ws.fx)), Y1 = Math.min(h, Math.ceil((r.box.y + r.box.height + 2) / ws.fy));
    let x0 = w, y0 = h, x1 = -1, y1 = -1, seen = 0, completed = 0;
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      const i = y * w + x;
      if (full[i] === own) { visible[i] = 1; seen++; } else if (full[i] < 0 || maskAt(completedW, ws, x, y) < 0.5) continue; else completed++;
      shape[i] = 1; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const box = x1 < 0 ? { x: 0, y: 0, width: 1, height: 1 } : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }, rgb = new Uint8Array(box.width * box.height * 3);
    // Its working colours on the working canvas, to sample from.
    const wrgb = new Uint8Array(nw * 3);
    for (let y = 0; y < r.box.height; y++) for (let x = 0; x < r.box.width; x++) { const q = (y + r.box.y) * ws.w + x + r.box.x, o = (y * r.box.width + x) * 3; for (let c = 0; c < 3; c++) wrgb[q * 3 + c] = r.rgb[o + c]; }
    for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
      const i = y * w + x, o = ((y - box.y) * box.width + x - box.x) * 3; if (!shape[i]) continue;
      if (visible[i]) { for (let c = 0; c < 3; c++) rgb[o + c] = clean[i * 3 + c]; continue; }
      if (sampleRgb(wrgb, ws, x, y, px, q => r.shape[q] === 1)) for (let c = 0; c < 3; c++) rgb[o + c] = px[c];
      else { shape[i] = 0; completed--; }
    }
    return { ...r, box, visible, shape, rgb, visiblePixels: seen, completedPixels: completed };
  });
  // The guide stays on the working grid: the background is rebuilt there (rebuildLarge).
  return { masks, risers, guide: work.guide };
}

/**
 * Fragments of an object left out of its mask, between its cut-out and what is rebuilt behind it (the gold edge of a
 * shawl on a gold stage, a speck of a dhoti on a white page): pieces of the picture inside its box that its mask mostly
 * surrounds, of a colour near the object's just beside them, join it (up to 2 % of the object) — a gap between an arm and
 * the body shows the wall, and stays background.
 */
export function absorbFragments(rgb: Uint8Array, w: number, h: number, live: ProductObject[], masks: Map<string, Uint8Array>): number {
  const n = w * h, taken = new Uint8Array(n);
  for (const m of masks.values()) for (let i = 0; i < n; i++) if (m[i]) taken[i] = 1;
  let absorbed = 0;
  for (const o of live) {
    const m = masks.get(o.id); if (!m) continue;
    let area = 0; for (let i = 0; i < n; i++) if (m[i]) area++;
    if (!area) continue;
    // (Searched a little past its box: a box drawn a little low leaves the object's top edge outside it.)
    const pad = Math.max(8, Math.round(Math.max(o.box.width, o.box.height) * 0.06));
    const x0 = Math.max(0, o.box.x - pad), y0 = Math.max(0, o.box.y - pad), x1 = Math.min(w, o.box.x + o.box.width + pad), y1 = Math.min(h, o.box.y + o.box.height + pad);
    const bw = x1 - x0, bh = y1 - y0, label = new Int32Array(bw * bh).fill(-1);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const k = (y - y0) * bw + x - x0, i = y * w + x; if (label[k] >= 0 || taken[i]) continue;
      // One piece of the picture (8-connected, not any object's): its pixels, and what is around it.
      const px: number[] = [], stack = [k]; label[k] = k; let border = false, byMask = 0, around = 0; const c = [0, 0, 0], cm = [0, 0, 0];
      while (stack.length) {
        const q = stack.pop()!, qx = q % bw + x0, qy = Math.floor(q / bw) + y0, j = qy * w + qx; px.push(j);
        for (let ch = 0; ch < 3; ch++) c[ch] += rgb[j * 3 + ch];
        if (qx === x0 || qy === y0 || qx === x1 - 1 || qy === y1 - 1) border = true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue; const X = qx + dx, Y = qy + dy; if (X < x0 || Y < y0 || X >= x1 || Y >= y1) continue;
          const nk = (Y - y0) * bw + X - x0, ni = Y * w + X;
          if (taken[ni]) { if (dx === 0 || dy === 0) { around++; if (m[ni]) { byMask++; for (let ch = 0; ch < 3; ch++) cm[ch] += rgb[ni * 3 + ch]; } } continue; }
          if (label[nk] < 0) { label[nk] = k; stack.push(nk); }
        }
        if (px.length > area * 0.02) break;
      }
      if (border || px.length > area * 0.02 || !around || byMask < around * 0.6) continue;
      const mine = c.map(v => v / px.length), beside = cm.map(v => v / Math.max(1, byMask)), apart = Math.max(...mine.map((v, ch) => Math.abs(v - beside[ch])));
      // Small (up to 0.25 % of the object): of a colour near the object's beside it (within 60); larger: nearer (30) and
      // enclosed more (75 %). (A podium seen through a gap between a mascot's arm and body: 0.5 % of it, 43 apart, stays.)
      if (px.length > area * 0.0025 ? !(apart <= 30 && byMask >= around * 0.75) : apart > 60) continue;
      for (const j of px) { m[j] = 1; taken[j] = 1; }
      absorbed += px.length;
    }
    // Remnants attached to it: a piece of one colour (smooth steps), the object's (within 45 of it beside the piece) and
    // unlike everything else around it (50 or more from it, soft edges included), touching it along a fifth of its edge or
    // more, and small (at most 10 % of it) — a microwave's dark top edge (7 % of it) left on the wall's rays. (A gold shawl's tip on a gold stage is like
    // what is around it: it stays.)
    const region = new Int32Array(bw * bh).fill(-1);
    const step = (i: number, j: number) => Math.max(Math.abs(rgb[i * 3] - rgb[j * 3]), Math.abs(rgb[i * 3 + 1] - rgb[j * 3 + 1]), Math.abs(rgb[i * 3 + 2] - rgb[j * 3 + 2]));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const k = (y - y0) * bw + x - x0, i = y * w + x; if (region[k] >= 0 || taken[i]) continue;
      const px: number[] = [], stack = [k]; region[k] = k; let byMask = 0, others = 0, border = false; const c = [0, 0, 0], cm = [0, 0, 0], co = [0, 0, 0];
      while (stack.length) {
        const q = stack.pop()!, qx = q % bw + x0, qy = Math.floor(q / bw) + y0, j = qy * w + qx; px.push(j);
        for (let ch = 0; ch < 3; ch++) c[ch] += rgb[j * 3 + ch];
        if (qx === x0 || qy === y0 || qx === x1 - 1 || qy === y1 - 1) border = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const X = qx + dx, Y = qy + dy; if (X < x0 || Y < y0 || X >= x1 || Y >= y1) continue;
          const nk = (Y - y0) * bw + X - x0, ni = Y * w + X;
          if (m[ni]) { byMask++; for (let ch = 0; ch < 3; ch++) cm[ch] += rgb[ni * 3 + ch]; continue; }
          if (taken[ni]) continue;
          if (region[nk] === k) continue;
          if (region[nk] < 0 && step(j, ni) <= 24) { region[nk] = k; stack.push(nk); continue; }
          others++; for (let ch = 0; ch < 3; ch++) co[ch] += rgb[ni * 3 + ch];
        }
        if (px.length > area * 0.1) break;
      }
      if (border || px.length > area * 0.1 || !others || byMask < (byMask + others) * 0.2) continue;
      const mine = c.map(v => v / px.length), beside = cm.map(v => v / byMask), rest = co.map(v => v / others);
      const apart = (p: number[], q: number[]) => Math.max(...p.map((v, ch) => Math.abs(v - q[ch])));
      if (apart(mine, beside) > 45 || apart(mine, rest) < 50) continue;
      for (const j of px) { m[j] = 1; taken[j] = 1; }
      absorbed += px.length;
    }
  }
  return absorbed;
}

/** 5 for a large picture: rebuilt on the working copy wherever anything was taken out; elsewhere the full-size pixels. */
async function rebuildLarge(clean: Uint8Array, w: number, h: number, hole: Uint8Array, wclean: Uint8Array, ws: WorkSize, noBlur: boolean, guide: BackgroundGuide): Promise<Awaited<ReturnType<typeof rebuildBehind>>> {
  const n = w * h, whole = dilate(maskDown(hole, w, h, ws, 0), ws.w, ws.h, 1), work = await rebuildBehind(wclean, ws.w, ws.h, whole, noBlur, guide);
  // The structure at full size (backgroundGuide.ts fullSizeFill): what the working copy found (the floor, the burst, the
  // mirror's axis and where it applies), drawn from full-size pixels; an enlarged working fill made every rebuilt area
  // about five times blurrier than the creative. The working fill stays only where nothing structural applied.
  let fine: GuidedFill | undefined;
  if (work.guided) {
    const up = (b: Box): Box => ({ x: Math.round(b.x / ws.fx), y: Math.round(b.y / ws.fy), width: Math.round(b.width / ws.fx), height: Math.round(b.height / ws.fy) });
    const floor = guide.floor ? new Uint8Array(n) : undefined;
    if (floor) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (guide.floor![workIndex(x, y, ws)]) floor[y * w + x] = 1;
    const full: BackgroundGuide = { ...(floor ? { floor } : {}), ...(guide.floorTop !== undefined ? { floorTop: Math.round((guide.floorTop + 0.5) / ws.fy - 0.5) } : {}),
      oneOff: (guide.oneOff ?? []).map(up), ...(guide.stage ? { stage: up(guide.stage) } : {}), stands: (guide.stands ?? []).map(up),
      burst: work.guided.burstUsed ? burstAtFullSize(work.guided.burstUsed, ws.fx, ws.fy) : null };
    const levels = work.levels, inside = Uint8Array.from(hole, (v, i) => (v && !(levels && levels[workIndex(i % w, Math.floor(i / w), ws)]) ? 1 : 0));
    fine = fullSizeFill(clean, w, h, inside, full, { filled: work.guided.filled, ...(work.guided.axis ? { axis: work.guided.axis } : {}), ws });
  }
  const out = Uint8Array.from(clean), unknown = new Uint8Array(n), patched = new Uint8Array(n), px = [0, 0, 0];
  let inHole = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!hole[i]) continue; inHole++;
    const q = workIndex(x, y, ws); if (work.unknown[q]) unknown[i] = 1;
    if (fine?.filled[i]) { for (let c = 0; c < 3; c++) out[i * 3 + c] = fine.rgb[i * 3 + c]; continue; }
    sampleRgb(work.rgb, ws, x, y, px); for (let c = 0; c < 3; c++) out[i * 3 + c] = px[c];
    if (work.patched[q]) patched[i] = 1;
  }
  const k = inHole / Math.max(1, whole.reduce((s, v) => s + v, 0));
  return { rgb: out, structural: Math.round(work.structural * k), estimated: Math.round(work.estimated * k), trustedPercent: work.trustedPercent, unknown, patched };
}

/**
 * The AI decomposition (aiDecompose.ts) of the picture without text and overlay logos, on a copy under Seedream's higher
 * price tier: the reviewed elements in that copy's pixels, the planner and Seedream called once, then each returned layer
 * given to the element it lies on (most of its pixels inside the element's box; the planner's name for the element breaks
 * ties). Each pixel belongs to the front-most layer seen there; the elements' labels are taken back to full size along
 * the creative's own edges (multiscale.ts upsampleLabels), each kept to its box (6 % slack). The lowest layer covering
 * most of the canvas is the background, at full size.
 */
async function aiLayers(layerizer: ProductLayerizer, rgb: Uint8Array, clean: Uint8Array, w: number, h: number, objects: ProductObject[], ask: ProductObject[], analysis: TextAnalysis | undefined, save: (file: string, value: object) => void, saveImage?: (file: string, png: Buffer) => void, verifiedComposition = false) {
  const s = sentSize(w, h), W = s.width, H = s.height, N = W * H, ws: WorkSize = { w: W, h: H, fx: W / w, fy: H / h };
  const down = async (px: Uint8Array) => Uint8Array.from(await sharp(Buffer.from(px), { raw: { width: w, height: h, channels: 3 } }).resize(W, H, { fit: 'fill' }).raw().toBuffer());
  const scale = (b: Box): Box => ({ x: Math.round(b.x * ws.fx), y: Math.round(b.y * ws.fy), width: Math.max(1, Math.round(b.width * ws.fx)), height: Math.max(1, Math.round(b.height * ws.fy)) });
  // The decomposition input: the picture without its text and overlay logos (`clean`, the overlay gate passed), and
  // without the logos kept in the picture either (filled here, on this copy only: the saved background keeps them).
  // No word and no logo — brand, bank, payment, QR, badge — is ever sent, whatever the prompt says.
  const small = await down(clean), source = await down(rgb);
  const words = (analysis?.words ?? []).filter(x => x.review.status !== 'rejected'), logos = (analysis?.logoSlots ?? []).filter(l => l.review.status !== 'rejected');
  const kept = logos.filter(l => l.inBackground);
  if (kept.length) {
    const hole = new Uint8Array(N);
    for (const l of kept) { const b = scale(l.box); for (let y = Math.max(0, b.y - 1); y < Math.min(H, b.y + b.height + 1); y++) for (let x = Math.max(0, b.x - 1); x < Math.min(W, b.x + b.width + 1); x++) hole[y * W + x] = 1; }
    small.set(inpaint(small, W, H, hole));
  }
  // The check before anything is sent: in every word's and every logo's box, the ink of the original (pixels unlike what
  // is just around the box, 2 px out: a logo card's own outline is the card's) must be gone from the input — else
  // nothing is sent.
  // Native compositions are rendered without text/image overlays and hash-verified by the service.
  // The source-ink heuristic otherwise mistakes unchanged scene texture under an overlay for retained lettering.
  // Uploaded creatives and legacy compositions without this proof still require the pixel gate.
  const still: string[] = [];
  // (A word's letters are where its source box is: a box moved in the review moves its live text, not its pixels.)
  for (const [label, b0] of (verifiedComposition ? [] : [...words.map(x => [`“${x.text}”`, x.source?.box ?? x.box] as const), ...logos.map(l => [l.label, l.box] as const)])) {
    const b = scale(b0), x0 = Math.max(0, b.x), y0 = Math.max(0, b.y), x1 = Math.min(W, b.x + b.width), y1 = Math.min(H, b.y + b.height); if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    const ring: number[][] = [[], [], []], X0 = Math.max(0, x0 - 2), Y0 = Math.max(0, y0 - 2), X1 = Math.min(W - 1, x1 + 1), Y1 = Math.min(H - 1, y1 + 1);
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) if (y === Y0 || y === Y1 || x === X0 || x === X1) for (let c = 0; c < 3; c++) ring[c].push(source[(y * W + x) * 3 + c]);
    const around = ringColours(ring);
    let ink = 0, same = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const q = (y * W + x) * 3; if (nearestColour(source, q, around) <= 40) continue; ink++; if (Math.max(...[0, 1, 2].map(c => Math.abs(source[q + c] - small[q + c]))) <= 24) same++; }
    if (ink >= 6 && same > ink * 0.3) still.push(label);
  }
  save('ai-input-check.json', { proof: verifiedComposition ? 'hash-verified server-rendered composition excluding text and logo layers' : 'pixel comparison against source overlay ink', sent: { width: W, height: H }, words: words.length, logos: logos.length, logosKeptInPicture: kept.map(l => l.label), stillVisible: still });
  if (still.length) throw new OverlayGateError(`Not sent to AI decomposition: ${still.slice(0, 4).join(', ')}${still.length > 4 ? ` and ${still.length - 4} more` : ''} still show${still.length === 1 ? 's' : ''} in the picture it would get (text and logos are never sent). Correct their boxes in the review.`, []);
  const image = await sharp(Buffer.from(small), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  saveImage?.('ai-input.png', image);
  const elements = objects.filter(o => !o.hidden && o.kind !== 'brand-logo').map(o => ({ id: o.id, kind: o.kind, label: o.label, box: scale(o.box), decompose: ask.includes(o) }));
  const excluded = { textBlocks: analysis?.groups.length ?? 0, words: (analysis?.words ?? []).filter(x => x.review.status !== 'rejected').length, logos: overlayLogos(analysis).map(l => l.label) };
  // (The planner's source of truth, as sent: the reviewed elements in the sent picture's pixels, and what was removed.)
  save('ai-elements.json', { sent: { width: W, height: H, sha256: sha256(image) }, elements, excluded });
  const result: AiDecomposition = await layerizer.decompose({ image, width: W, height: H, elements, excluded }, save);
  const layers = await Promise.all(result.layers.map(async l => ({ ...l, data: await sharp(l.png).ensureAlpha().resize(W, H, { fit: 'fill' }).raw().toBuffer() })));
  const opaque = layers.map(l => { let c = 0; for (let q = 0; q < N; q++) if (l.data[q * 4 + 3] >= 128) c++; return c; });
  const bgIndex = layers.findIndex((_, k) => opaque[k] >= N * 0.6);
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), byName = new Map(result.plan.layers.map(l => [norm(l.name), l.element_id]));
  const owner = new Int32Array(N).fill(-1);
  layers.forEach((l, k) => { if (k !== bgIndex) for (let q = 0; q < N; q++) if (l.data[q * 4 + 3] >= 128) owner[q] = k; });
  const chosen = elements.filter(e => e.decompose), assigned = new Map<number, string>();
  layers.forEach((l, k) => {
    if (k === bgIndex || !opaque[k]) return;
    const named = l.name ? byName.get(norm(l.name)) : undefined;
    let best: string | undefined, bestScore = 0;
    for (const e of chosen) {
      let inside = 0; for (let y = e.box.y; y < Math.min(H, e.box.y + e.box.height); y++) for (let x = e.box.x; x < Math.min(W, e.box.x + e.box.width); x++) if (l.data[(y * W + x) * 4 + 3] >= 128) inside++;
      const share = inside / opaque[k], score = share + (named === e.id && share > 0.2 ? 0.5 : 0);
      if (share >= 0.5 || named === e.id) if (score > bestScore) { bestScore = score; best = e.id; }
    }
    if (best) assigned.set(k, best);
  });
  const ids = chosen.map(e => e.id), labels = new Int32Array(N).fill(-1);
  for (let q = 0; q < N; q++) { const k = owner[q]; const id = k >= 0 ? assigned.get(k) : undefined; if (id) labels[q] = ids.indexOf(id); }
  const full = W < w ? upsampleLabels(labels, small, ws, clean, w, h) : Int32Array.from({ length: w * h }, (_, i) => labels[Math.min(H - 1, Math.floor((Math.floor(i / w) + 0.5) * ws.fy)) * W + Math.min(W - 1, Math.floor(((i % w) + 0.5) * ws.fx))]);
  const masks = new Map<string, Uint8Array>(), unmatched: string[] = [];
  ids.forEach((id, k) => {
    const o = objects.find(x => x.id === id)!, sx = Math.round(o.box.width * 0.06), sy = Math.round(o.box.height * 0.06), m = new Uint8Array(w * h); let count = 0;
    for (let y = Math.max(0, o.box.y - sy); y < Math.min(h, o.box.y + o.box.height + sy); y++) for (let x = Math.max(0, o.box.x - sx); x < Math.min(w, o.box.x + o.box.width + sx); x++) if (full[y * w + x] === k) { m[y * w + x] = 1; count++; }
    if (count >= Math.max(16, o.box.width * o.box.height * 0.01)) masks.set(id, m); else unmatched.push(id);
  });
  let background: { rgb: Uint8Array; alpha: Uint8Array } | undefined;
  if (bgIndex >= 0) {
    // Retain the provider's actual background for diagnosis; a reconstructed base alone cannot show which stage
    // introduced a residual product. The service writes this as a separate content-addressed asset.
    saveImage?.('ai-background.png', layers[bgIndex].png);
    const { data } = await sharp(layers[bgIndex].png).ensureAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    const rgb = new Uint8Array(w * h * 3), alpha = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) { for (let c = 0; c < 3; c++) rgb[i * 3 + c] = data[i * 4 + c]; alpha[i] = data[i * 4 + 3]; }
    background = { rgb, alpha };
  }
  save('ai-mapping.json', { sent: { width: W, height: H }, background: bgIndex >= 0 ? { source: 'seedream-layer', sha256: sha256(layers[bgIndex].png), z: layers[bgIndex].zIndex } : null, layers: layers.map((l, k) => ({ z: l.zIndex, name: l.name ?? null, opaquePixels: opaque[k], role: k === bgIndex ? 'background' : assigned.get(k) ?? 'unassigned' })), matched: [...masks.keys()], unmatched });
  return { result, masks, unmatched, background, sent: { width: W, height: H } };
}

export interface PrepareInput {
  source: Rgba; analysis: TextAnalysis | undefined; objects: ProductObject[];
  /** A segmentation provider, used only when `paidApproved`; its inputs are individually masked character/product crops. */
  segmenter?: Segmenter; paidApproved: boolean;
  /**
   * The AI decomposition core (aiDecompose.ts: the OpenAI planner, then Seedream Layerize), used only when `paidApproved`:
   * it gets the picture without text and overlay logos, and the reviewed elements; its layers become the elements' masks
   * and its background what is behind them. An element it does not return keeps the local cut-out.
   */
  layerizer?: ProductLayerizer;
  /** Where the picture sent to the AI decomposition is kept (an audit of exactly what was sent). */
  saveImage?: (file: string, png: Buffer) => void;
  save: (file: string, value: object) => void;
  /** The working copy's long side for a large picture (multiscale.ts; default PRODUCT_WORK_SIDE). */
  workSide?: number;
  /** A requested paid variation must not pass quality checks on local fallback cutouts. */
  requireAiMatches?: boolean;
  /**
   * A template made from a generated variation (variationTemplate.ts): its background, its picture without text and logos
   * (exact), and each element's layer at its place. An element whose box is still its layer's keeps that layer — its
   * pixels and its mask — and what is behind it is the variation's own background; anything else is decomposed as usual.
   */
  known?: { verifiedComposition?: boolean; background: Rgba; clean: Rgba; layers: { label: string; kind: ProductObject['kind']; box: Box; png: Buffer }[]; plates?: { box: Box; png: Buffer }[] };
}
export interface PreparedCutout { id: string; png: Buffer; placement: Box; method: 'sam3' | 'local' | 'layer' | 'seedream'; coverage: number; quality: 'good' | 'check'; note?: string; contactY: number }
/** A display stand on its own layer: `key` names it (its place), `hint` the administrator's box it came from. */
export interface PreparedStand { key: string; label: string; png: Buffer; placement: Box; under: string[]; visiblePixels: number; completedPixels: number; uncertain: boolean; source: 'auto' | 'user'; hint?: string }
export interface PrepareResult {
  clean: Buffer; base: Buffer; overlayMask: Buffer; overlays: Buffer; recombined: Buffer; recombinedClean: Buffer;
  /** Where the background is an estimate (amber: guessed by patches; blue: the scene's structure continued), over clear. */
  estimated: Buffer;
  cutouts: PreparedCutout[]; stands: PreparedStand[]; quality: ProductQuality;
  separation: { method: 'sam3' | 'local' | 'seedream'; requests: number; costUsd: number; inputSha256?: string; ai?: ProductAiSeparation };
}

export async function prepareProduct(input: PrepareInput): Promise<PrepareResult> {
  const { source } = input, w = source.width, h = source.height, n = w * h, rgb = flattenRgb(source), issues: ProductQualityIssue[] = [];
  // 1 Overlays out, 2 the gate.
  const overlays = overlayMask(source, input.analysis);
  // Text on a plain plate (a pill, a banner): the plate's colour, judged inside it. A ring around a small line reaches past
  // the plate's rim into the page around it — taken for a two-colour pattern, or the page's white for the plate's colour.
  const plates = overlays.sweep.filter(s => s.plain).map(s => s.box), onPlate = (b: Box) => plates.some(p => b.x >= p.x - 1 && b.y >= p.y - 1 && b.x + b.width <= p.x + p.width + 1 && b.y + b.height <= p.y + p.height + 1);
  const fillAreas = [
    ...(input.analysis?.words ?? []).filter(w => w.review.status !== 'rejected').map(w => ({ id: w.id, box: w.source?.box ?? w.box })),
    ...overlayLogos(input.analysis).map(l => ({ id: l.id, box: l.original.placement })),
    // Lines on plain plates swept of their anti-aliased edges and punctuation: filled with the plate's colour.
    ...overlays.sweep.map(s => ({ id: s.id, box: s.box })),
  ].map(a => onPlate(a.box) ? { ...a, plate: true } : a);
  const overlayFill = fillOverlayPixels(rgb, w, h, overlays.mask, fillAreas);
  if (input.analysis?.words.some(w => w.origin === 'ai')) refillPatterned(overlayFill.rgb, w, h, overlays.mask, overlayFill.patterned);
  // Preserve the established pattern-aware fill for OCR-only legacy fixtures. AI word manifests use narrow patches.
  const cleanFill = input.analysis?.words.some(w => w.origin === 'ai')
    ? { rgb: overlayFill.rgb, structural: 0, estimated: overlays.mask.reduce((n,v) => n+v,0), trustedPercent: overlayFill.uncertain.length ? 0 : 100 }
    : await rebuildBehind(rgb, w, h, overlays.mask);
  // (Letter-shaped holes are not inpainted from patches: tried on the real LG creative, it drew ghost letters on the
  // badge and copied podium colours into the white footer; the narrow fill above is cleaner there.)
  // (A variation's picture without its text and logos is known exactly: nothing behind them is estimated.)
  const clean = input.known ? flattenRgb(input.known.clean) : cleanFill.rgb;
  // One check per text block (or logo), not one per word: where the background behind it was continued, an estimate.
  const logoIds = new Set(overlayLogos(input.analysis).map(l => l.id));
  const blockOf = (id: string) => (logoIds.has(id) ? 'logos' : input.analysis?.words.find(w => w.id === id)?.groupId ?? id.split(':')[0]);
  // A decoration's own lettering (a badge's words): its artwork (artworkText.ts) — the original's pixels are put back in
  // the base after the text removal, and its words are never drawn again as live text over it.
  const artwork = artworkGroups({ width: w, height: h }, input.objects.filter(o => !o.hidden && o.kind === 'decoration').map(o => ({ label: o.label, box: o.box })),
    (input.analysis?.words ?? []).filter(x => x.review.status !== 'rejected').map(x => ({ groupId: x.groupId, box: x.source?.box ?? x.box })));
  const artworkIds = new Set(artwork.map(g => g.groupId));
  const fills = new Map<string, Box[]>();
  for (const a of input.known ? [] : overlayFill.uncertain) fills.set(blockOf(a.id), [...(fills.get(blockOf(a.id)) ?? []), a.box]);
  for (const [block, boxes] of fills) {
    if (artworkIds.has(block)) continue;
    const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y)), what = block === 'logos' ? `the ${boxes.length} logo${boxes.length === 1 ? '' : 's'}` : `“${(input.analysis?.groups.find(g => g.id === block)?.label ?? 'this text').slice(0, 50)}”`;
    issues.push({ id: `fill-${block}`, area: { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height: Math.max(...boxes.map(b => b.y + b.height)) - y }, blocking: false,
      message: `Behind ${what} the artwork was continued where ${block === 'logos' ? 'they were' : 'the text was'} (an estimate, not the original pixels). Inspect it; correct the detection or supply clean artwork if needed.` });
  }
  assertOverlaysGone(rgb, clean, overlays.mask, w, overlays.areas);
  const cleanPng = await sharp(Buffer.from(clean), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  for (const area of overlays.areas) {
    const overlap = input.objects.find(o => decomposesObject(o) &&
      Math.min(o.box.x + o.box.width, area.box.x + area.box.width) > Math.max(o.box.x, area.box.x) &&
      Math.min(o.box.y + o.box.height, area.box.y + area.box.height) > Math.max(o.box.y, area.box.y));
    if (overlap) issues.push({ id: `overlay-overlap-${area.id}`, area: area.box, elementId: overlap.id, blocking: false,
      message: `Text or logo overlaps ${overlap.label}. Hidden object pixels are estimated; inspect this area or replace the object with a clean cutout.` });
  }
  // 3 Objects: masks from the provider (approved) or the local estimate.
  if (input.objects.some(o => !o.hidden && o.kind === 'brand-logo')) throw new OverlayGateError('Brand logos must be preserved as logo overlays. Review this older template before preparing.', input.objects.filter(o => o.kind === 'brand-logo').map(o => o.box));
  const live = input.objects.filter(decomposesObject).sort((a, b) => a.z - b.z);
  let masks = new Map<string, Uint8Array>(), method: 'sam3' | 'local' | 'seedream' = 'local', requests = 0, inputSha256: string | undefined;
  let ai: Awaited<ReturnType<typeof aiLayers>> | undefined;
  // A variation's own layers: each element (or stand) whose box is still its layer's (same kind, the boxes 85 % the same;
  // the same name first among several). Not by name alone: a name can change on the way — a renamed element, or the
  // scene parser's 40-character names ("Home-theater satellite speaker · center 1" came back "… · center · bottom 1"),
  // and two small speakers were cut out of the picture again instead of keeping their layers.
  // A verified composition's products keep their layers with the AI decomposition too (after it, which still runs as
  // approved): each is the product's complete picture (the photo that was uploaded), so one standing partly behind another
  // object, the character or a stand is whole when moved — never cut to what showed, never estimated. Only where the layer
  // is what the picture shows (at least half of it, as drawn): a picture redrawn by an image model keeps Seedream's cut-out.
  const complete = new Map<string, { box: Box; png: Buffer; mask: Uint8Array; cover: Uint8Array; count: number; bottom: number; seen: Uint8Array; hidden: number }>();
  const known = new Map<string, { box: Box; png: Buffer; mask: Uint8Array; cover: Uint8Array; count: number; bottom: number; seen: Uint8Array; hidden: number }>(), usedLayers = new Set<number>();
  const iou = (a: Box, b: Box) => { const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)), iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)); return (ix * iy) / Math.max(1, a.width * a.height + b.width * b.height - ix * iy); };
  if (input.known) {
    for (const o of input.objects.filter(o => ((!input.layerizer || (input.known!.verifiedComposition && o.kind === 'product')) && decomposesObject(o)) || (!o.hidden && o.kind === 'podium' && o.layer === 'own'))) {
      const later = !!input.layerizer && o.kind === 'product';
      let li = -1, best = -1;
      input.known.layers.forEach((x, k) => { if (usedLayers.has(k) || x.kind !== o.kind) return; const score = iou(x.box, o.box); if (score < 0.85) return; const rank = score + (x.label === o.label ? 1 : 0); if (rank > best) { best = rank; li = k; } });
      if (li < 0) continue;
      const l: NonNullable<PrepareInput['known']>['layers'][number] = input.known.layers[li]; usedLayers.add(li);
      // Its mask (at least half opaque) and everything it covers at all (its soft edge too); where it shows in the picture (its opaque pixels drawn as they are) and where something in front hides it.
      const { data, info } = await sharp(l.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), m = new Uint8Array(n), cover = new Uint8Array(n), seen = new Uint8Array(n);
      let count = 0, bottom = l.box.y, hidden = 0;
      for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
        const q = (y * info.width + x) * 4, X: number = l.box.x + x, Y: number = l.box.y + y, a = data[q + 3]; if (X < 0 || Y < 0 || X >= w || Y >= h || !a) continue;
        const i = Y * w + X; cover[i] = 1;
        if (a < 128) continue;
        m[i] = 1; count++; bottom = Math.max(bottom, Y);
        if (a < 250 || Math.max(Math.abs(rgb[i * 3] - data[q]), Math.abs(rgb[i * 3 + 1] - data[q + 1]), Math.abs(rgb[i * 3 + 2] - data[q + 2])) <= 40) seen[i] = 1; else hidden++;
      }
      if (count && later) { if (hidden < count * 0.5) complete.set(o.id, { box: l.box, png: l.png, mask: m, cover, count, bottom, seen, hidden }); else usedLayers.delete(li); continue; }
      if (count) known.set(o.id, { box: l.box, png: l.png, mask: m, cover, count, bottom, seen, hidden });
    }
  }
  if (input.paidApproved && input.segmenter && live.length) {
    const excluded = providerExclusionMask(source, input.analysis);
    const seeds = localMasks(clean, w, h, input.objects.filter(o => !o.hidden)), claimed = new Uint8Array(n);
    const audit: { id: string; kind: string; sha256: string; box: Box }[] = [];
    const inputs: { object: ProductObject; image: Buffer }[] = [];
    for (const o of [...live].reverse()) {
      if (o.review.status !== 'accepted') throw new OverlayGateError(`Review “${o.label}” before segmentation.`, [o.box]);
      const asset = await isolatedObjectInput(source, o, seeds.get(o.id)!, excluded);
      inputs.push({ object: o, image: asset });
    }
    // Validate the whole batch before the first billable request.
    for (const { object: o, image: asset } of inputs) {
      audit.push({ id: o.id, kind: o.kind, sha256: sha256(asset), box: o.box });
      const result = await input.segmenter.segment({ image: asset, width: o.box.width, height: o.box.height,
        targets: [{ label: o.label, box: { x: 0, y: 0, width: o.box.width, height: o.box.height } }] }, (file, value) => input.save(`${o.id}-${file}`, value));
      requests += result.requestIds.length; method = 'sam3';
      const mask = result.masks?.[0] ?? result.mask;
      if (!mask) throw new OverlayGateError(`No mask returned for “${o.label}”.`, [o.box]);
      const decoded = await sharp(mask).greyscale().raw().toBuffer({ resolveWithObject: true });
      if (decoded.info.width !== o.box.width || decoded.info.height !== o.box.height) throw new OverlayGateError(`Invalid mask dimensions for “${o.label}”.`, [o.box]);
      const m = new Uint8Array(n);
      for (let y = 0; y < o.box.height; y++) for (let x = 0; x < o.box.width; x++) {
        const i = (y + o.box.y) * w + x + o.box.x;
        if (decoded.data[y * o.box.width + x] >= 128 && !claimed[i] && !excluded[i] && seeds.get(o.id)![i]) { m[i] = 1; claimed[i] = 1; }
      }
      masks.set(o.id, m);
    }
    input.save('isolated-inputs.json', { policy: 'character|product', inputs: audit });
    inputSha256 = sha256(Buffer.from(JSON.stringify(audit)));
  }
  // 3 (AI) The decomposition core, when approved: the planner and Seedream on the picture without text and overlay logos
  // (`clean`); an explicitly selected AI engine does not bypass segmentation using known cutouts.
  if (input.paidApproved && input.layerizer && method === 'local' && live.some(o => !known.has(o.id))) {
    ai = await aiLayers(input.layerizer, rgb, clean, w, h, input.objects, live.filter(o => !known.has(o.id)), input.analysis, input.save, input.saveImage, input.known?.verifiedComposition);
    method = 'seedream'; requests = 2; inputSha256 = ai.result.seedream.imageSha256;
  }
  // 3 (local masks) and 3b (display stands): on the picture as it is or, a large one, on its working copy with each
  // layer then taken at full size (multiscale.ts).
  const ws = workSize(w, h, input.workSide), wclean = ws ? binDown(clean, w, h, ws) : undefined;
  // (A stand with its own layer is that layer: not looked for again.)
  const toSeparate = input.objects.filter(o => !(o.kind === 'podium' && known.has(o.id)));
  let separated = ws ? separateLarge(clean, w, h, wclean!, ws, toSeparate, method === 'sam3' ? masks : undefined) : separateObjects(clean, w, h, toSeparate, method === 'sam3' ? masks : undefined);
  // (Seedream's masks for the elements it returned, the local ones for the rest; the stands found again around them.)
  if (ai?.masks.size) { const merged = new Map(separated.masks); for (const [id, m] of ai.masks) merged.set(id, m); separated = ws ? separateLarge(clean, w, h, wclean!, ws, toSeparate, merged) : separateObjects(clean, w, h, toSeparate, merged); }
  masks = separated.masks;
  absorbFragments(clean, w, h, live, masks);
  for (const [id, k] of complete) known.set(id, k);
  // Known layers win: their masks are their own, and no other mask keeps the pixels where they show (where something in
  // front hides a product, those pixels stay that thing's: the character before a product keeps its whole outline).
  const knownAll = new Uint8Array(n); for (const k of known.values()) for (let i = 0; i < n; i++) if (k.seen[i]) knownAll[i] = 1;
  for (const o of live) {
    const k = known.get(o.id); if (!k || o.kind !== 'product' || k.hidden < Math.max(50, k.count * 0.005)) continue;
    const front = live.filter(p => p !== o && Math.min(p.box.x + p.box.width, k.box.x + k.box.width) > Math.max(p.box.x, k.box.x) && Math.min(p.box.y + p.box.height, k.box.y + k.box.height) > Math.max(p.box.y, k.box.y)).map(p => p.label);
    issues.push({ id: `complete-${o.id}`, area: { ...k.box }, elementId: o.id, blocking: false,
      message: `“${o.label}”: ${Math.max(1, Math.round(100 * k.hidden / k.count))}% of it is hidden${front.length ? ` behind ${front.slice(0, 3).join(', ')}` : ''} in the picture. Its layer is its complete picture (the photo used in the creative), so moving it shows all of it — nothing estimated.` });
  }
  if (known.size) for (const [oid, m] of masks) { const k = known.get(oid); if (k) masks.set(oid, Uint8Array.from(k.mask)); else for (let i = 0; i < n; i++) if (knownAll[i]) m[i] = 0; }
  const overlapOf = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)) / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
  const knownStands = input.objects.filter(o => o.kind === 'podium' && known.has(o.id));
  const risers = separated.risers.filter(r => !knownStands.some(o => overlapOf(r.box, known.get(o.id)!.box) > 0.3)), ownHints = input.objects.filter(o => !o.hidden && o.kind === 'podium' && o.layer === 'own');
  // A decomposed object's pixels and its soft edge (its own colours mixed with what is behind: a few pixels at a large
  // size) are no stand's: a stand layer that kept them showed a satellite speaker twice, and drew a dark outline of every
  // product hidden in front of it. They are taken out of the stands' seen pixels and continued there with the stand's
  // colour from just beyond.
  const rimR = Math.max(1, Math.round(Math.max(w, h) / 1500)), objectMask = new Uint8Array(n);
  for (const m of masks.values()) for (let i = 0; i < n; i++) if (m[i]) objectMask[i] = 1;
  const rimBand = rimR > 1 ? dilate(objectMask, w, h, rimR) : objectMask;
  for (const r of risers) for (let y = r.box.y; y < r.box.y + r.box.height; y++) for (let x = r.box.x; x < r.box.x + r.box.width; x++) {
    const i = y * w + x; if (!r.visible[i] || !rimBand[i]) continue;
    // The nearest seen stand pixel past the band, along the row or the column.
    let src = -1;
    for (let d = rimR + 1; d <= 3 * rimR + 2 && src < 0; d++) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
      const X = x + dx, Y = y + dy; if (X < r.box.x || Y < r.box.y || X >= r.box.x + r.box.width || Y >= r.box.y + r.box.height) continue;
      const j = Y * w + X; if (r.visible[j] && !rimBand[j]) { src = j; break; }
    }
    r.visible[i] = 0; r.visiblePixels--; r.completedPixels++;
    if (src >= 0) { const o = ((y - r.box.y) * r.box.width + x - r.box.x) * 3; for (let c = 0; c < 3; c++) r.rgb[o + c] = clean[src * 3 + c]; }
  }
  // 5 The base: the clean picture without any object or stand.
  const all = new Uint8Array(n);
  for (const m of masks.values()) for (let i = 0; i < n; i++) if (m[i]) all[i] = 1;
  for (const r of risers) for (let i = 0; i < n; i++) if (r.visible[i]) all[i] = 1;
  for (const o of knownStands) { const k = known.get(o.id)!; for (let i = 0; i < n; i++) if (k.mask[i]) all[i] = 1; }
  // (The objects' soft edges beyond their first pixel, at a large size, are rebuilt with what is behind them.)
  if (rimR > 1) for (let i = 0; i < n; i++) if (!all[i] && rimBand[i]) all[i] = 2;
  // Each object's soft rim (1 px) is taken with it.
  for (let i = 0; i < n; i++) if (!all[i]) { const x = i % w; if ((x > 0 && all[i - 1] === 1) || (x < w - 1 && all[i + 1] === 1) || (i >= w && all[i - w] === 1) || (i + w < n && all[i + w] === 1)) all[i] = 2; }
  const hole = Uint8Array.from(all, v => (v ? 1 : 0)), noBlur = !!input.analysis?.words.some(w => w.origin === 'ai');
  const baseFill = ws ? await rebuildLarge(clean, w, h, hole, wclean!, ws, noBlur, separated.guide) : await rebuildBehind(clean, w, h, hole, noBlur, separated.guide), base = baseFill.rgb;
  // Behind a known layer — everything it covers, its soft edge too — is the variation's own background: exact, never an
  // estimate (the layer is drawn over it as it is).
  const exact = new Uint8Array(n);
  if (known.size) {
    // What is behind them: the variation's background, its plates and every element of it not decomposed (a stand left in
    // the background stays under the television standing on it).
    const under = await sharp(Buffer.from(input.known!.background.data), { raw: { width: w, height: h, channels: 4 } })
      .composite([...(input.known!.plates ?? []).map(p => ({ input: p.png, left: p.box.x, top: p.box.y })), ...input.known!.layers.filter((_, k) => !usedLayers.has(k)).map(l => ({ input: l.png, left: l.box.x, top: l.box.y }))]).removeAlpha().raw().toBuffer();
    const covered = new Uint8Array(n); for (const k of known.values()) for (let i = 0; i < n; i++) if (k.cover[i] || k.mask[i]) covered[i] = 1;
    const behindKnown = rimR > 1 ? dilate(covered, w, h, rimR) : dilate(covered, w, h, 1), bg = new Uint8Array(under);
    for (let i = 0; i < n; i++) if ((hole[i] && behindKnown[i]) || covered[i]) { for (let c = 0; c < 3; c++) base[i * 3 + c] = bg[i * 3 + c]; baseFill.unknown[i] = 0; baseFill.patched[i] = 0; exact[i] = 1; }
  }
  // Behind the elements Seedream returned (and their soft edges): Seedream's own background layer, its colours matched to
  // the creative's just around them (a ring 2–5 px out) — an AI estimate, marked as such; elsewhere the local rebuild.
  const aiFilled = new Uint8Array(n);
  if (ai?.background) {
    const bg = ai.background, owned = new Uint8Array(n); for (const id of ai.masks.keys()) { const m = masks.get(id); if (m) for (let i = 0; i < n; i++) if (m[i]) owned[i] = 1; }
    const near = dilate(owned, w, h, Math.max(2, rimR + 1)), ring = dilate(owned, w, h, Math.max(5, rimR + 4)), d: number[][] = [[], [], []];
    for (let i = 0; i < n; i += 3) if (ring[i] && !near[i] && !hole[i] && bg.alpha[i] >= 128) for (let c = 0; c < 3; c++) d[c].push(clean[i * 3 + c] - bg.rgb[i * 3 + c]);
    const off = d.map(v => { v.sort((p, q) => p - q); return v.length ? v[v.length >> 1] : 0; });
    for (let i = 0; i < n; i++) if (hole[i] && near[i] && bg.alpha[i] >= 128 && !exact[i]) {
      for (let c = 0; c < 3; c++) base[i * 3 + c] = Math.max(0, Math.min(255, bg.rgb[i * 3 + c] + off[c]));
      baseFill.patched[i] = 0; baseFill.unknown[i] = 1; aiFilled[i] = 1;
    }
  }
  // Saved compositions have an authoritative background underneath their native objects. Use that reference
  // behind the matching selected objects while retaining Seedream's masks (never report these pixels as AI output).
  if (ai && input.known?.verifiedComposition) {
    const selected = input.known.layers.filter(l => live.some(o => o.kind === l.kind && iou(o.box, l.box) > .85));
    if (selected.length) {
      const under = await sharp(Buffer.from(input.known.background.data), { raw: { width: w, height: h, channels: 4 } })
        .composite([...(input.known.plates ?? []).map(p => ({ input: p.png, left: p.box.x, top: p.box.y })), ...input.known.layers.filter(l => !selected.includes(l) && !usedLayers.has(input.known!.layers.indexOf(l))).map(l => ({ input: l.png, left: l.box.x, top: l.box.y }))]).removeAlpha().raw().toBuffer();
      for (const l of selected) for (let y = Math.max(0, Math.floor(l.box.y) - 1); y < Math.min(h, Math.ceil(l.box.y + l.box.height) + 1); y++) for (let x = Math.max(0, Math.floor(l.box.x) - 1); x < Math.min(w, Math.ceil(l.box.x + l.box.width) + 1); x++) {
        const i = y * w + x;
        for (let c = 0; c < 3; c++) base[i * 3 + c] = under[i * 3 + c];
        exact[i] = 1; aiFilled[i] = 0; baseFill.unknown[i] = 0; baseFill.patched[i] = 0;
      }
      input.save('ai-native-background-reference.json', { source: 'saved variation composition, not Seedream output', elements: selected.map(l => l.label) });
      issues.push({ id: 'native-background-reference', area: { x: 0, y: 0, width: w, height: h }, blocking: false, message: 'Behind the saved variation’s selected objects, the original composition background is retained as reference. Object masks come from Seedream; these background pixels are not new Seedream output.' });
    }
  }
  if (ai) {
    const filled = aiFilled.reduce((s2, v) => s2 + v, 0);
    if (filled) issues.push({ id: 'ai-background', area: { x: 0, y: 0, width: w, height: h }, blocking: false, message: `Behind the elements Seedream decomposed, ${round(100 * filled / n, 1)}% of the canvas is Seedream's own reconstruction of the background (an AI estimate, never the original pixels): it shows only when they are moved or hidden. Inspect Background only.` });
    for (const id of ai.unmatched) { const o = input.objects.find(x => x.id === id)!; issues.push({ id: `ai-missing-${id}`, area: o.box, elementId: id, blocking: !!input.requireAiMatches, message: `Seedream returned no layer for “${o.label}”: it was cut out on this computer instead. Check its edges.` }); }
  }
  if (artwork.length && !input.known) restoreArtworkRaw(rgb, base, 3, w, h, artwork);
  // Opaque everywhere: what was behind the objects is rebuilt (an estimate), never a transparent hole.
  const baseRgba=Buffer.alloc(n*4);
  for(let i=0;i<n;i++){ for(let c=0;c<3;c++)baseRgba[i*4+c]=base[i*3+c];baseRgba[i*4+3]=255; }
  const basePng=await sharp(baseRgba,{raw:{width:w,height:h,channels:4}}).png().toBuffer();
  // A mask's edge should be the object's: the share of it with no visible edge (alike inside and just outside).
  const edgeless = (m: Uint8Array) => {
    let edge = 0, flat = 0;
    for (let i = 0; i < n; i++) {
      if (!m[i]) continue;
      const x = i % w, y = (i - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h || m[Y * w + X]) continue;
        const ox = x + 2 * dx, oy = y + 2 * dy, ix = x - dx, iy = y - dy; if (ox < 0 || oy < 0 || ox >= w || oy >= h || ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
        const a = (iy * w + ix) * 3, b = (oy * w + ox) * 3; edge++;
        if (Math.max(Math.abs(clean[a] - clean[b]), Math.abs(clean[a + 1] - clean[b + 1]), Math.abs(clean[a + 2] - clean[b + 2])) < 18) flat++;
        break;
      }
    }
    return edge ? flat / edge : 0;
  };
  // What is behind each object: a stand where one is (completed), else the base.
  const behind = Uint8Array.from(base);
  for (const r of risers) for (let y = 0; y < r.box.height; y++) for (let x = 0; x < r.box.width; x++) {
    const i = (y + r.box.y) * w + x + r.box.x; if (!r.shape[i]) continue; const o = (y * r.box.width + x) * 3;
    for (let c = 0; c < 3; c++) behind[i * 3 + c] = r.rgb[o + c];
  }
  // 4 Cut-outs: each object's pixels; at its rim, its colour over what is behind it at the opacity both colours give. A
  // stand also carries its completed part (opaque, the estimate).
  const cutOut = async (m: Uint8Array, back: Uint8Array, completed?: { shape: Uint8Array; box: Box; rgb: Uint8Array }) => {
    let x0 = w, y0 = h, x1 = -1, y1 = -1, count = 0;
    for (let i = 0; i < n; i++) if (m[i] || completed?.shape[i]) { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (m[i]) count++; }
    if (!count) return undefined;
    x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(w - 1, x1 + 1); y1 = Math.min(h - 1, y1 + 1);
    const W = x1 - x0 + 1, H = y1 - y0 + 1, px = Buffer.alloc(W * H * 4);
    const inner = (i: number) => { const x = i % w; return m[i] && (x === 0 || m[i - 1]) && (x === w - 1 || m[i + 1]) && (i < w || m[i - w]) && (i + w >= n || m[i + w]); };
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * w + x, o4 = ((y - y0) * W + (x - x0)) * 4, colour = [clean[i * 3], clean[i * 3 + 1], clean[i * 3 + 2]];
      if (completed && completed.shape[i] && !m[i]) {
        const o = ((y - completed.box.y) * completed.box.width + x - completed.box.x) * 3;
        px[o4] = completed.rgb[o]; px[o4 + 1] = completed.rgb[o + 1]; px[o4 + 2] = completed.rgb[o + 2]; px[o4 + 3] = 255; continue;
      }
      if (method === 'local' && input.analysis?.words.some(word => word.origin === 'ai')) {
        // The hidden background is uncertain: alpha unmixing against it discolours product rims.
        // Preserve visible source colours, including a one-pixel edge, and flag the local estimate.
        const adjacent = (x > 0 && m[i-1]) || (x < w-1 && m[i+1]) || (y > 0 && m[i-w]) || (y < h-1 && m[i+w]);
        if (m[i] || (all[i] === 2 && adjacent)) { px[o4] = colour[0]; px[o4+1] = colour[1]; px[o4+2] = colour[2]; px[o4+3] = 255; }
        continue;
      }
      if (m[i] && inner(i)) { px[o4] = colour[0]; px[o4 + 1] = colour[1]; px[o4 + 2] = colour[2]; px[o4 + 3] = 255; continue; }
      if (!m[i] && all[i] !== 2) continue;
      // A rim pixel: against what is behind it and the object's own colour just inside.
      let k = -1; for (const j of [i - 1, i + 1, i - w, i + w, i - w - 1, i - w + 1, i + w - 1, i + w + 1]) if (j >= 0 && j < n && m[j] && inner(j)) { k = j; break; }
      if (k < 0) { if (m[i]) { px[o4] = colour[0]; px[o4 + 1] = colour[1]; px[o4 + 2] = colour[2]; px[o4 + 3] = 255; } continue; }
      const u = unmix(colour, [back[i * 3], back[i * 3 + 1], back[i * 3 + 2]], [clean[k * 3], clean[k * 3 + 1], clean[k * 3 + 2]]);
      px[o4] = u.rgb[0]; px[o4 + 1] = u.rgb[1]; px[o4 + 2] = u.rgb[2]; px[o4 + 3] = Math.round(u.alpha * 255);
    }
    let contactY = y0; for (let y = y1; y >= y0 && contactY === y0; y--) for (let x = x0; x <= x1; x++) if (m[y * w + x]) { contactY = y; break; }
    return { png: await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer(), placement: { x: x0, y: y0, width: W, height: H }, count, contactY };
  };
  // A product that other decomposed objects stand in front of (a TV behind its soundbar and speakers, a laptop behind phones
  // and earbuds): the part of it they hide — within its own outline — is continued from its own pixels (an estimate,
  // reported), so moving or hiding them shows the product, not a hole of background in it. Not done when they hide as
  // much as half of it (too much would be invented).
  const completions = new Map<string, { shape: Uint8Array; box: Box; rgb: Uint8Array; pixels: number; by: string[] }>();
  for (const o of live.filter(x => x.kind === 'product' && !known.has(x.id))) {
    // Where it is hidden: inside the extent of its own visible pixels (a little inside) — the detected box can run past
    // it (a microwave's box over the top of the purifier in front of it), and its outline cannot say it, as what stands
    // in front covers its edges (phones over a laptop's corner).
    const m = masks.get(o.id)!, hidden = new Uint8Array(n), by: string[] = [];
    let count = 0, own = 0, vx0 = w, vy0 = h, vx1 = -1, vy1 = -1;
    for (let i = 0; i < n; i++) if (m[i]) { own++; const x = i % w, y = (i - x) / w; if (x < vx0) vx0 = x; if (x > vx1) vx1 = x; if (y < vy0) vy0 = y; if (y > vy1) vy1 = y; }
    if (!own) continue;
    const inset = Math.max(1, Math.round(Math.min(vx1 - vx0, vy1 - vy0) * 0.01));
    for (const p of live.filter(x => x !== o && x.z > o.z && (x.kind === 'product' || x.kind === 'character'))) {
      const pm = masks.get(p.id)!; let k = 0;
      for (let y = vy0 + inset; y <= vy1 - inset; y++) for (let x = vx0 + inset; x <= vx1 - inset; x++) { const i = y * w + x; if (pm[i] && !m[i] && !hidden[i]) { hidden[i] = 1; k++; } }
      if (k >= Math.max(20, own * 0.005)) by.push(p.label);
      count += k;
    }
    if (!count || !by.length || count > own * 0.5) continue;
    // Filled from its own pixels nearest along the row and the column (inverse-distance blend): a panel stays its plain
    // colour behind a soundbar; patches from anywhere in it had copied the screen's colours there.
    let sx0 = w, sy0 = h, sx1 = -1, sy1 = -1; for (let i = 0; i < n; i++) if (hidden[i]) { const x = i % w, y = (i - x) / w; sx0 = Math.min(sx0, x); sy0 = Math.min(sy0, y); sx1 = Math.max(sx1, x); sy1 = Math.max(sy1, y); }
    const box = { x: sx0, y: sy0, width: sx1 - sx0 + 1, height: sy1 - sy0 + 1 }, rgbC = new Uint8Array(box.width * box.height * 3);
    const near = (x: number, y: number, dx: number, dy: number): [number, number] | undefined => {
      for (let d = 1, X = x + dx, Y = y + dy; X >= vx0 && X <= vx1 && Y >= vy0 && Y <= vy1; d++, X += dx, Y += dy) { const j = Y * w + X; if (m[j]) return [j, d]; }
      return undefined;
    };
    for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
      const i = y * w + x; if (!hidden[i]) continue;
      const found = [near(x, y, -1, 0), near(x, y, 1, 0), near(x, y, 0, -1), near(x, y, 0, 1)].filter((f): f is [number, number] => !!f);
      const oo = ((y - box.y) * box.width + x - box.x) * 3; let wsum = 0; const acc = [0, 0, 0];
      for (const [j, d] of found) { const wt = 1 / (d * d); wsum += wt; for (let c = 0; c < 3; c++) acc[c] += clean[j * 3 + c] * wt; }
      if (wsum) for (let c = 0; c < 3; c++) rgbC[oo + c] = Math.round(acc[c] / wsum); else hidden[i] = 0;
    }
    completions.set(o.id, { shape: hidden, box, rgb: rgbC, pixels: count, by });
    issues.push({ id: `completed-${o.id}`, area: o.box, elementId: o.id, blocking: false,
      message: `“${o.label}”: the part of it hidden behind ${by.slice(0, 3).join(', ')}${by.length > 3 ? ' and more' : ''} (${Math.round(100 * count / own)}% of it) was continued from its own pixels — an estimate. It shows only when they are moved or hidden.` });
  }
  const cutouts: PreparedCutout[] = [];
  for (const o of live) {
    // A known layer is the cut-out as it is (its own pixels and transparency).
    const k = known.get(o.id);
    if (k) { cutouts.push({ id: o.id, png: k.png, placement: { ...k.box }, method: 'layer', coverage: round(Math.min(1, k.count / Math.max(1, o.box.width * o.box.height))), quality: 'good', contactY: k.bottom }); continue; }
    const m = masks.get(o.id)!, made = await cutOut(m, behind, completions.get(o.id));
    if (!made) { issues.push({ id: `empty-${o.id}`, area: o.box, message: `Nothing of “${o.label}” was found inside its box: draw its box again, or remove it.`, blocking: true, elementId: o.id }); continue; }
    const { count } = made;
    const coverage = Math.min(1, count / Math.max(1, o.box.width * o.box.height)), overlapsOthers = live.some(p => p !== o && Math.min(p.box.x + p.box.width, o.box.x + o.box.width) - Math.max(p.box.x, o.box.x) > o.box.width * 0.1 && Math.min(p.box.y + p.box.height, o.box.y + o.box.height) - Math.max(p.box.y, o.box.y) > o.box.height * 0.1);
    const localCut = method === 'local' || (method === 'seedream' && !ai?.masks.has(o.id));
    const note = edgeless(m) > 0.35 ? 'Its edge does not follow the object everywhere: it may include background or miss a part.' : coverage < 0.08 ? 'Covers very little of its box: parts may be missing.' : localCut && overlapsOthers ? 'Overlaps another object: check the edge between them.' : localCut ? 'Local colour-based cutout: inspect for background fragments and missing product details.' : undefined;
    if (note) issues.push({ id: `cutout-${o.id}`, area: o.box, message: `${o.label}: ${note}`, blocking: false, elementId: o.id });
    cutouts.push({ id: o.id, png: made.png, placement: made.placement, method: ai ? (ai.masks.has(o.id) ? 'seedream' : 'local') : method === 'seedream' ? 'local' : method, coverage: round(coverage), quality: note ? 'check' : 'good', ...(note ? { note } : {}), contactY: made.contactY });
  }
  // Each stand's layer, named after what stands on it (or the administrator's box).
  const stands: PreparedStand[] = [];
  for (const o of knownStands) { const k = known.get(o.id)!; stands.push({ key: `${k.box.x},${k.box.y},${k.box.width},${k.box.height}`, label: o.label.slice(0, 80), png: k.png, placement: { ...k.box }, under: [], visiblePixels: k.count, completedPixels: 0, uncertain: false, source: 'user', hint: o.id }); }
  for (const r of risers) {
    const made = await cutOut(r.visible, base, r); if (!made) continue;
    const on = r.under.map(j => live[j].label), hint = r.hint ? ownHints.find(o => o.id === r.hint) : undefined;
    const label = hint?.label && hint.label !== 'podium' ? hint.label : on.length ? `Stand under the ${on.length > 2 ? `${on.slice(0, 2).join(', ')} and ${on.length - 2} more` : on.join(' and ')}` : 'Display stand';
    stands.push({ key: `${r.box.x},${r.box.y},${r.box.width},${r.box.height}`, label: label.slice(0, 80), png: made.png, placement: made.placement, under: r.under.map(j => live[j].id),
      visiblePixels: r.visiblePixels, completedPixels: r.completedPixels, uncertain: r.uncertain, source: r.source, ...(r.hint ? { hint: r.hint } : {}) });
  }
  if (stands.length) {
    const x = Math.min(...stands.map(s => s.placement.x)), y = Math.min(...stands.map(s => s.placement.y)), unsure = stands.filter(s => s.uncertain);
    issues.push({ id: 'stands', area: { x, y, width: Math.max(...stands.map(s => s.placement.x + s.placement.width)) - x, height: Math.max(...stands.map(s => s.placement.y + s.placement.height)) - y }, blocking: false,
      message: `${stands.length} display stand${stands.length === 1 ? ' was' : 's were'} made ${stands.length === 1 ? 'its own layer' : 'their own layers'}, under the products (the big podium stays in the background). Where products hid ${stands.length === 1 ? 'it' : 'them'}, the stand was continued (an estimate)${unsure.length ? `; mostly hidden, so check ${unsure.length === 1 ? 'it' : 'them'} first: ${unsure.map(s => `“${s.label}”`).join(', ')}` : ''}. Hide or drag the products to look. A wrong one can be put back into the background.` });
  }
  // The preview uses the same native word renderer and logo assets as composed runs; never source-text pixels.
  const overlayParts: string[] = [];
  for (const logo of overlayLogos(input.analysis)) {
    const b = logo.original.placement;
    const png = await sharp(source.data, { raw: { width: w, height: h, channels: 4 } }).extract({ left: b.x, top: b.y, width: b.width, height: b.height }).png().toBuffer();
    overlayParts.push(`<image x="${logo.box.x}" y="${logo.box.y}" width="${logo.box.width}" height="${logo.box.height}" href="data:image/png;base64,${png.toString('base64')}"/>`);
  }
  for (const word of input.analysis?.words ?? []) if (word.review.status !== 'rejected' && !artworkIds.has(word.groupId)) overlayParts.push(textSvg({
    id: word.id, wordId: word.id, groupId: word.groupId, line: 0, order: word.order, text: word.text,
    x: word.box.x + (word.style.originDx ?? 0), baselineY: word.box.y + word.style.baseline, rotation: word.box.rotation,
    style: creativeStyleOf(word.style), hidden: false, locked: false, z: word.order }, 0, 0));
  const editableOverlays = await svgPng(w, h, overlayParts.join(''));
  // The text as it is set again, word by word, against the creative's own letters (warnings: the review corrects them).
  //   together   on a line, two words drawn closer than an eighth of the size (a space lost: "LGproducts")
  //   different  a word's letters drawn where the original's are not, or the other way round (a quarter of either ink out
  //              of a stroke's reach of the other): its face, size or box is off ("CHATURTHI" drawn twice the height)
  {
    const live = (input.analysis?.words ?? []).filter(x => x.review.status !== 'rejected' && !artworkIds.has(x.groupId));
    const asText = (x: (typeof live)[number]) => ({ id: x.id, wordId: x.id, groupId: x.groupId, line: 0, order: x.order, text: x.text, x: x.box.x + (x.style.originDx ?? 0), baselineY: x.box.y + x.style.baseline, rotation: x.box.rotation, style: creativeStyleOf(x.style), hidden: false, locked: false, z: x.order });
    const inkOf = (x: (typeof live)[number]) => textInkExact(asText(x));
    const together: string[] = [], different = new Map<string, string[]>();
    for (const g of input.analysis?.groups ?? []) for (const l of g.lines) {
      const ws = l.wordIds.map(id => live.find(x => x.id === id)).filter((x): x is (typeof live)[number] => !!x && !x.box.rotation).sort((p, q) => p.box.x - q.box.x);
      for (let k = 0; k + 1 < ws.length; k++) { const a1 = inkOf(ws[k]), b1 = inkOf(ws[k + 1]); if (a1 && b1 && b1.x - (a1.x + a1.width) < 0.125 * Math.min(ws[k].style.fontSize, ws[k + 1].style.fontSize)) together.push(`“${ws[k].text} ${ws[k + 1].text}”`); }
    }
    for (const x of live) {
      if ([...x.text].filter(ch => /[\p{L}\p{N}]/u.test(ch)).length < 4 || x.box.rotation) continue;
      const ink = inkOf(x); if (!ink) continue;
      const X0 = Math.max(0, Math.floor(Math.min(x.box.x, ink.x))), Y0 = Math.max(0, Math.floor(Math.min(x.box.y, ink.y))), X1 = Math.min(w, Math.ceil(Math.max(x.box.x + x.box.width, ink.x + ink.width))), Y1 = Math.min(h, Math.ceil(Math.max(x.box.y + x.box.height, ink.y + ink.height)));
      if (X1 - X0 < 4 || Y1 - Y0 < 4) continue;
      const drawn = await sharp(await svgPng(X1 - X0, Y1 - Y0, textSvg(asText(x), X0, Y0))).ensureAlpha().raw().toBuffer();
      const c = [1, 3, 5].map(k => parseInt(x.style.color.slice(k, k + 2), 16));
      // Each ink within a stroke's reach of the other's (8 % of the size): another face with letters in the same places passes.
      const CW = X1 - X0, CH = Y1 - Y0, orig = new Uint8Array(CW * CH), now = new Uint8Array(CW * CH), r = Math.max(2, Math.round(x.style.fontSize * 0.08));
      for (let y = Y0; y < Y1; y++) for (let xx = X0; xx < X1; xx++) {
        const i = y * w + xx, q = (y - Y0) * CW + xx - X0, inBox = xx >= x.box.x && xx < x.box.x + x.box.width && y >= x.box.y && y < x.box.y + x.box.height;
        if (inBox && Math.max(Math.abs(source.data[i * 4] - c[0]), Math.abs(source.data[i * 4 + 1] - c[1]), Math.abs(source.data[i * 4 + 2] - c[2])) <= 60) orig[q] = 1;
        if (drawn[q * 4 + 3] >= 128) now[q] = 1;
      }
      const near = (m: Uint8Array) => { const o = new Uint8Array(CW * CH); for (let y = 0; y < CH; y++) for (let xx = 0; xx < CW; xx++) { if (!m[y * CW + xx]) continue; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const X = xx + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < CW && Y < CH) o[Y * CW + X] = 1; } } return o; };
      const nearOrig = near(orig), nearNow = near(now); let o = 0, oHit = 0, d = 0, dHit = 0;
      for (let q = 0; q < CW * CH; q++) { if (orig[q]) { o++; if (nearNow[q]) oHit++; } if (now[q]) { d++; if (nearOrig[q]) dHit++; } }
      if (o >= 30 && d >= 30 && (oHit / o < 0.75 || dHit / d < 0.75)) { const list = different.get(x.groupId) ?? []; list.push(`“${x.text}”`); different.set(x.groupId, list); }
    }
    if (together.length) issues.push({ id: 'text-together', area: { x: 0, y: 0, width: w, height: h }, blocking: false,
      message: `Set again, ${together.length === 1 ? 'two words run' : `${together.length} pairs of words run`} together: ${together.slice(0, 4).join(', ')}. Check the spacing in the review.` });
    for (const [gid, list] of different) issues.push({ id: `text-different-${gid}`, area: input.analysis?.groups.find(g => g.id === gid) ? overlays.areas.find(a => a.id === gid)?.box ?? { x: 0, y: 0, width: w, height: h } : { x: 0, y: 0, width: w, height: h }, blocking: false,
      message: `${list.slice(0, 4).join(', ')} ${list.length === 1 ? 'is' : 'are'} drawn quite differently from the creative's own letters (another font, size or place): in the review, select the word and draw its box round its letters only — its font and size are then found again from them — or change its font in the editor.` });
  }
  // 6 Checks: recombined against the original (overlays as their own pixels) and against the clean picture.
  const recombine = async (withOverlays: boolean) => {
    let img = sharp(basePng);
    const layers = [...stands, ...cutouts].map(c => ({ input: c.png, left: c.placement.x, top: c.placement.y }));
    let png = layers.length ? await sharp(await img.toBuffer()).composite(layers).png().toBuffer() : await img.toBuffer();
    if (withOverlays) png = await sharp(png).composite([{ input: editableOverlays, left: 0, top: 0 }]).png().toBuffer();
    img = sharp(png);
    return { png, raw: await img.removeAlpha().raw().toBuffer() };
  };
  const compare = (a: Uint8Array, b: Uint8Array) => { let sum = 0, visible = 0; for (let i = 0; i < n; i++) { const d = Math.max(Math.abs(a[i * 3] - b[i * 3]), Math.abs(a[i * 3 + 1] - b[i * 3 + 1]), Math.abs(a[i * 3 + 2] - b[i * 3 + 2])); sum += d; if (d > 24) visible++; } return { meanDiff: round(sum / n, 3), visiblePercent: round(100 * visible / n, 3) }; };
  const full = await recombine(true), plain = await recombine(false);
  const hidden = overlays.mask.reduce((s, v) => s + v, 0) + all.reduce((s, v) => s + (v ? 1 : 0), 0), estimated = cleanFill.estimated + baseFill.estimated;
  // An object whose background is mostly an estimate: shown for a look (it matters only when the object is moved).
  const rebuiltBehind = baseFill.unknown.reduce((s, v) => s + v, 0);
  if (rebuiltBehind && live.length) issues.push({ id: 'base-estimate', area: { x: 0, y: 0, width: w, height: h }, message: `Behind the products and characters, ${round(100 * rebuiltBehind / n, 1)}% of the canvas was never visible: it was rebuilt from the creative itself (the floor, its mirror image where the layout is symmetric, else the surrounding artwork) — an estimate. It shows only when an object is moved or hidden. Inspect Background only.`, blocking: false });
  // Where nothing in the creative told what is behind an object (no floor, no mirror image, no straight continuation),
  // the patches guessed: said for an object with a large such area (where a stand is behind it, the stand shows).
  const standBehind = new Uint8Array(n); for (const r of risers) for (let i = 0; i < n; i++) if (r.shape[i]) standBehind[i] = 1;
  for (const o of live) {
    const m = masks.get(o.id)!; let inside = 0, guessed = 0;
    for (let i = 0; i < n; i++) if (m[i] && !standBehind[i]) { inside++; if (baseFill.patched[i]) guessed++; }
    if (inside && guessed >= inside * 0.4 && guessed >= n * 0.025) issues.push({ id: `guessed-${o.id}`, area: o.box, elementId: o.id, blocking: false,
      message: `Behind “${o.label}”, ${Math.round(100 * guessed / inside)}% of the background could only be guessed from the artwork around it (nothing elsewhere in the creative shows what is there). Hide “${o.label}” in Background only to judge it; if something specific belongs there (a podium, a wall), draw it in the review.` });
  }
  // Each decomposed object in what shows when it is hidden (the background with the stands on it): still there (its own
  // pixels unchanged over a third of it: shown twice when it is moved — blocking), or its outline showing (where what is
  // around it is smooth, what is rebuilt does not meet it along much of its edge — a silhouette, whatever the picture's
  // overall likeness).
  const standShape = new Uint8Array(n); for (const r of risers) for (let i = 0; i < n; i++) if (r.shape[i]) standShape[i] = 1;
  const residualChecks: { id: string; label: string; comparedPixels: number; unchangedPixels: number; residualFraction: number; smoothEdgePixels: number; seamPixels: number }[] = [];
  for (const o of live) {
    // What shows where it was, when only it is hidden: the objects behind it (their completed parts too), else the stands
    // and the base. (Objects in front of it still cover their pixels: not compared.)
    const below = live.filter(p => p !== o && p.z < o.z), front = live.filter(p => p !== o && p.z > o.z);
    const behindO = (i: number) => below.some(p => masks.get(p.id)![i] || completions.get(p.id)?.shape[i]);
    const seenWhenHidden = (i: number) => !front.some(p => masks.get(p.id)![i]) && (!hole[i] || standShape[i] === 1 || behindO(i));
    const view = (i: number, c: number) => {
      for (const p of below) { const cp = completions.get(p.id); if (cp?.shape[i]) { const x = i % w, y = (i - x) / w; return cp.rgb[((y - cp.box.y) * cp.box.width + x - cp.box.x) * 3 + c]; } if (masks.get(p.id)![i]) return clean[i * 3 + c]; }
      return behind[i * 3 + c]; };
    const m = masks.get(o.id)!, b = o.box, pad = rimR + 3, R = rimR + 1;
    // Its mask widened by R (a square neighbourhood), within its box and pad only.
    const bx0 = Math.max(0, b.x - pad), by0 = Math.max(0, b.y - pad), bx1 = Math.min(w, b.x + b.width + pad), by1 = Math.min(h, b.y + b.height + pad), bw = bx1 - bx0, bh = by1 - by0;
    const rows = new Uint8Array(bw * bh), near = new Uint8Array(bw * bh);
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) { let on = 0; for (let d = -R; d <= R && !on; d++) { const X = x + d; if (X >= 0 && X < w && m[y * w + X]) on = 1; } rows[(y - by0) * bw + x - bx0] = on; }
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { let on = 0; for (let d = -R; d <= R && !on; d++) { const Y = y + d; if (Y >= 0 && Y < bh && rows[Y * bw + x]) on = 1; } near[y * bw + x] = on; }
    const mine = { at: (i: number) => { const x = i % w - bx0, y = Math.floor(i / w) - by0; return x >= 0 && y >= 0 && x < bw && y < bh && near[y * bw + x] === 1; } };
    let inside = 0, same = 0, smooth = 0, seam = 0;
    const far = (a: Uint8Array, i: number, c: Uint8Array, j: number) => Math.max(Math.abs(a[i * 3] - c[j * 3]), Math.abs(a[i * 3 + 1] - c[j * 3 + 1]), Math.abs(a[i * 3 + 2] - c[j * 3 + 2]));
    // What is around it (the median of the pixels just outside its mask, in its box): only its pixels unlike that count
    // for "still there" (a white air conditioner on a rebuilt white wall is not shown twice).
    const ringC: number[][] = [[], [], []];
    for (let y = Math.max(0, b.y - pad); y < Math.min(h, b.y + b.height + pad); y += 2) for (let x = Math.max(0, b.x - pad); x < Math.min(w, b.x + b.width + pad); x += 2) {
      const i = y * w + x; if (m[i] || !mine.at(i)) continue; for (let c = 0; c < 3; c++) ringC[c].push(clean[i * 3 + c]); }
    const around = ringC.map(v => { v.sort((p, q) => p - q); return v.length ? v[v.length >> 1] : 0; });
    const distinct = (i: number) => Math.max(Math.abs(clean[i * 3] - around[0]), Math.abs(clean[i * 3 + 1] - around[1]), Math.abs(clean[i * 3 + 2] - around[2])) > 40;
    for (let y = Math.max(0, b.y - pad); y < Math.min(h, b.y + b.height + pad); y++) for (let x = Math.max(0, b.x - pad); x < Math.min(w, b.x + b.width + pad); x++) {
      const i = y * w + x;
      const fv = (a: number, b2: number) => Math.max(Math.abs(view(a, 0) - view(b2, 0)), Math.abs(view(a, 1) - view(b2, 1)), Math.abs(view(a, 2) - view(b2, 2)));
      if (m[i] && distinct(i) && !behindO(i)) { inside++; if (far(behind, i, clean, i) <= 12) same++; }
      // (The edge of what is rebuilt for it: its mask and its soft edge, `rimR` pixels.)
      if (!hole[i] || standShape[i] || !mine.at(i) || front.some(p => masks.get(p.id)![i])) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy, X2 = x + 2 * dx, Y2 = y + 2 * dy; if (X2 < 0 || Y2 < 0 || X2 >= w || Y2 >= h) continue;
        const j = Y * w + X, k = Y2 * w + X2; if (m[j] || m[k] || !seenWhenHidden(j) || !seenWhenHidden(k)) continue;
        if (fv(j, k) > 12) continue;
        smooth++; if (fv(i, j) > 40) seam++;
        break;
      }
    }
    residualChecks.push({ id: o.id, label: o.label, comparedPixels: inside, unchangedPixels: same, residualFraction: inside ? round(same / inside, 4) : 0, smoothEdgePixels: smooth, seamPixels: seam });
    if (inside >= 200 && same >= inside * 0.35) issues.push({ id: `duplicate-${o.id}`, area: o.box, elementId: o.id, blocking: true,
      message: `“${o.label}” is still in the background (${Math.round(100 * same / inside)}% of it): it would show twice when moved. Draw its box again in the review, or choose not to decompose it.` });
    // (Measured on the LG creative: a flat stand-coloured block where a speaker stood, 97 %; rays and a soft estimate around
    // a hidden microwave, 62 %. Warn from 30 %, block from 75 %.)
    else if (smooth >= 100 && seam >= smooth * 0.3) issues.push({ id: `outline-${o.id}`, area: o.box, elementId: o.id, blocking: seam >= smooth * 0.75,
      message: `The outline of “${o.label}” shows in the background (along ${Math.round(100 * seam / smooth)}% of its edge, the rebuilt background does not meet the background around it). Hide it in the Hide / Move test to judge it.` });
  }
  // Where the background is an estimate, to see: amber where only the patches guessed, blue where the scene's own structure
  // was continued (its rays, mirror image, columns, stage rows, floor).
  const est = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) { if (aiFilled[i]) { est[i * 4] = 139; est[i * 4 + 1] = 92; est[i * 4 + 2] = 246; est[i * 4 + 3] = 120; } else if (baseFill.patched[i]) { est[i * 4] = 245; est[i * 4 + 1] = 158; est[i * 4 + 2] = 11; est[i * 4 + 3] = 140; } else if (baseFill.unknown[i]) { est[i * 4] = 14; est[i * 4 + 1] = 165; est[i * 4 + 2] = 233; est[i * 4 + 3] = 100; } }
  const estimatedPng = await sharp(est, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  if (!input.known && cleanFill.trustedPercent < 50 && overlays.areas.length) issues.push({ id: 'overlay-estimate', area: { x: 0, y: 0, width: w, height: h }, message: `Behind the text and logos, ${Math.round(100 - cleanFill.trustedPercent)}% of what was continued is an estimate: check the clean template.`, blocking: false });
  const quality: ProductQuality = { original: compare(rgb, full.raw), clean: compare(clean, plain.raw), rebuiltPercent: hidden ? round(100 * (cleanFill.structural + baseFill.structural) / hidden, 1) : 100, estimatedPercent: hidden ? round(100 * estimated / hidden, 1) : 0, unavailablePercent: 0, reconstructedPercent: round(100*rebuiltBehind/n,2), issues };
  input.save('background-provenance.json', { baseSha256: sha256(basePng), cleanSha256: sha256(cleanPng),
    sources: { localReconstruction: true, seedreamBackground: !!ai?.background, verifiedComposition: !!input.known?.verifiedComposition },
    // This check includes stands: a clean base must not conceal a duplicate in another layer underneath a product.
    view: 'base plus stands and objects behind each selected object', residualChecks,
    blockingIssues: issues.filter(i => i.blocking).map(i => ({ id: i.id, message: i.message })) });
  const maskPng = await sharp(Buffer.from(overlays.mask.map(v => (v ? 255 : 0))), { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
  return { clean: cleanPng, base: basePng, overlayMask: maskPng, overlays: editableOverlays, estimated: estimatedPng, recombined: full.png, recombinedClean: plain.png, cutouts, stands, quality,
    separation: { method, requests, costUsd: ai ? Math.round((ai.result.planner.costUsd + ai.result.seedream.costUsd) * 10000) / 10000 : round(requests * 0.01, 2), ...(inputSha256 ? { inputSha256 } : {}),
      ...(ai ? { ai: { planner: ai.result.planner.model, engine: ai.result.seedream.endpoint, offline: ai.result.planner.offline || ai.result.seedream.offline, prompt: ai.result.plan.prompt, ...(ai.result.seedream.requestId ? { requestId: ai.result.seedream.requestId } : {}),
        layers: ai.result.seedream.layers, matched: [...ai.masks.keys()], unmatched: ai.unmatched, backgroundPercent: round(100 * aiFilled.reduce((s2, v) => s2 + v, 0) / n, 2), sentSize: ai.sent, warnings: ai.result.plan.warnings } } : {}) } };
}
