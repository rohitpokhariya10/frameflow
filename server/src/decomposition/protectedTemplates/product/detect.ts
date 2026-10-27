/**
 * Everything in a Product with Text creative, found once:
 *
 *   local    (free) the whole-poster reading of the Text & Graphics scan (scan.ts + analysis.ts): every word with its box,
 *            style and line, text blocks, text plates, logo cards (bank logos), QR codes and brand marks
 *   vision   (one request; the offline test analyser without a key) the creative's scene (smartProviders.ts): every
 *            character, every product on its own, podiums, decorations, and its logos told apart (bank, payment,
 *            merchant, a product's own mark), with each text overlay's role
 *   merged   text and its exact boxes come from the local reading; what each thing is comes from the vision analysis:
 *            text blocks get its roles, words printed on a product or on artwork are left out of the editable text, bank
 *            and payment logos become logo slots (overlays), merchant logos become the brand logo (a visual object)
 *
 * Confident items are accepted at once; the rest are marked for a quick look (with the reason). Nothing here changes the
 * creative: crops of logos are stored as their own files.
 */
import { createHash, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import {
  boxIoU, LOW_WORD_CONFIDENCE, normalizeBox, offerFace, OFFER_FONTS, orderProductObjects, PRODUCT_ATTENTION_BELOW,
  type DetectedWord, type WordGroup, type LogoSlot, type MasterCategory, type PixelRect, type ProductDetection, type ProductObject, type ProductObjectKind, type ProtectedAssetRef, type ProtectedElement, type ProtectedTemplate, type SceneBox, type SceneObject, type SourceBox, type TextAnalysis,
} from '@frameflow/shared';
import { sha256, type Rgba } from '../pixels.js';
import type { WordRecognizer } from '../../../textRecognition/recognizer.js';
import { scanPoster } from '../master/scan.js';
import { buildMasterAnalysis } from '../master/analysis.js';
import type { SceneAnalyzer } from '../../creativeTemplates/smartProviders.js';

import { ProductAnalysisError, type ProductScene } from './analyzer.js';
import { fitSceneWords } from './wordFit.js';
import { measureWord } from '../../../textRecognition/measure.js';
import { productInkBounds } from './typography.js';
import { matchLineFont, offerFontFile } from '../../../textRecognition/fontMatch.js';

const stableId = (prefix: string, source: string | undefined, key: string) => `${prefix}-${createHash('sha256').update(`${source ?? ''}:${key}`).digest('hex').slice(0, 10)}`;
const hexId = (prefix: string) => `${prefix}-${randomBytes(5).toString('hex')}`;
type Box = PixelRect;
const inside = (a: Box, b: Box) => { const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)), iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)); return (ix * iy) / Math.max(1, a.width * a.height); };
const iou = (a: Box, b: Box) => boxIoU({ ...a, rotation: 0 }, { ...b, rotation: 0 });
const pixels = (b: SceneBox, size: { width: number; height: number }): Box => {
  const x = Math.max(0, Math.round(b.x * size.width)), y = Math.max(0, Math.round(b.y * size.height));
  return { x, y, width: Math.max(1, Math.min(size.width - x, Math.round(b.w * size.width))), height: Math.max(1, Math.min(size.height - y, Math.round(b.h * size.height))) };
};
/**
 * The style of one line of words from the creative's own pixels: each word's ink box (its colour), the offer face that
 * draws the line best (fontMatch.ts), each word's size, letter spacing, baseline and origin in it. Detection styles every
 * line so; a word whose box the reviewer corrected is styled again so, alone (service.ts), from where its letters are.
 */
export async function styleLine(source: Rgba, lineWords: { text: string; box: Box }[]): Promise<{ style: DetectedWord['style']; confidence: number }[]> {
  const tight = lineWords.map(w => productInkBounds(source, w.box, measureWord(source, w.box, w.text).color));
  const first = lineWords[0], measured = measureWord(source, tight[0], first.text);
  // Small print (under 16 px) is matched among the sans families only: serifs and display faces were picked for blurry
  // 8–12 px legal lines on the real LG creative.
  // Only faces that draw every character of the line (no missing-glyph boxes, e.g. for ₹); small print (under 16 px)
  // among the sans families only (serif and display faces were picked for blurry 8–12 px legal lines).
  // "Under 16 px" on a creative about 600 px across: a share of its long side (2.6 %), so a full-size upload's small print
  // (74 px at 4096 px) is small print too.
  const small = [...tight.map(b => b.height)].sort((a, b) => a - b)[tight.length >> 1] < Math.max(16, 0.026 * Math.max(source.width, source.height)), chars = [...new Set([...lineWords.map(w => w.text).join('')])];
  const families = OFFER_FONTS.filter(f => (!small || f.category === 'sans') && chars.every(ch => offerFontFile(f.faces[0]).charToGlyph(ch).index > 0)).map(f => f.family);
  const font = await matchLineFont(source, lineWords.map((w, i) => ({ text: w.text, box: tight[i] })), measured.color, families.length ? { families } : {});
  // Each word drawn no wider than its own measured box (words of 4+ letters decide): a face a little wider than the
  // creative's own made neighbours collide ("equallygrand"). First the letters close up (to −7 % of the size), then
  // the line's size shrinks together (to 90 % at most): the words keep the creative's height.
  let fit = 1, tighten = 0;
  const face = font && offerFace(font.family, font.weight, font.style);
  if (face) {
    const file = offerFontFile(face);
    for (const [i, w] of lineWords.entries()) {
      const size = font.words[i]?.fontSize ?? 0, n = [...w.text].length, adv = size ? file.getAdvanceWidth(w.text, size) + (font.words[i]?.letterSpacing ?? 0) * (n - 1) : 0;
      if (n < 4 || adv <= tight[i].width * 1.03 + 1) continue;
      const spacing = Math.max(-0.07 * size, (tight[i].width * 1.02 + 1 - adv) / (n - 1));
      tighten = Math.min(tighten, spacing);
      const left = adv + spacing * (n - 1);
      if (left > tight[i].width * 1.03 + 1) fit = Math.min(fit, (tight[i].width * 1.03 + 1) / left);
    }
  }
  fit = Math.max(0.9, fit);
  const baselines = font?.words.map((p,i) => tight[i].y+p.baseline).sort((a,b)=>a-b);
  const commonBaseline = baselines?.[baselines.length >> 1];
  return lineWords.map((w, i) => {
    const m = measureWord(source, tight[i], w.text), place = font?.words[i];
    return { confidence: Math.min(m.confidence, Math.max(0, font?.score ?? m.confidence)),
      style: { fontFamily: font?.family ?? 'Inter', fontMatch: 'estimated', fontSize: (place?.fontSize ?? m.fontSize) * fit, fontWeight: font?.weight ?? m.fontWeight,
        fontStyle: font?.style ?? 'normal', color: m.color, opacity: 1, lineHeight: 1.2, letterSpacing: ((place?.letterSpacing ?? 0) + tighten) * fit,
        baseline: commonBaseline !== undefined ? commonBaseline - w.box.y : tight[i].y - w.box.y + m.baseline, align: 'left', ...(place ? { originDx: tight[i].x - w.box.x + place.originDx } : {}) } };
  });
}

/**
 * The model's FRACTIONAL boxes (objects, logos, text blocks) can sit in a slightly scaled frame of the picture while its
 * word boxes (in pixels) are right: on the live 4096 px LG creative (two answers), x ≈ 0.96·x + 40 and y ≈ 0.983·y − 6 —
 * boxes up to ~100 px off toward the right and bottom: logos half outside their boxes, products cut and their pixels left
 * in the background, product parts taken for stands. The frame is measured on the text blocks against their own words
 * (both edges, each axis: a scale and a shift, least squares, the points far off the fit — a block drawn round its
 * pill — dropped once) and applied to every fractional box when it is well supported (three blocks or more, spread over
 * a third of the picture each way, fitting within 1 % of it) and moves something by half a percent of it or more.
 */
export function calibrateScene(scene: ProductScene, size: { width: number; height: number }): { scene: ProductScene; fit?: { x: { k: number; b: number }; y: { k: number; b: number }; blocks: number } } {
  const W = size.width, H = size.height, words = scene.words ?? [], long = Math.max(W, H);
  const xs: [number, number][] = [], ys: [number, number][] = [], spanX: number[] = [], spanY: number[] = [];
  let blocks = 0;
  for (const ov of scene.overlays) {
    const b = { x: ov.box.x * W, y: ov.box.y * H, w: ov.box.w * W, h: ov.box.h * H }, ty = Math.max(8, b.h * 0.75, 0.012 * long), tx = 0.02 * W;
    const mine = words.filter(w => { const cx = w.box.x + w.box.width / 2, cy = w.box.y + w.box.height / 2; return cx >= b.x - tx && cx <= b.x + b.w + tx && cy >= b.y - ty && cy <= b.y + b.h + ty; });
    if (!mine.length) continue;
    blocks++;
    const u = { x0: Math.min(...mine.map(w => w.box.x)), y0: Math.min(...mine.map(w => w.box.y)), x1: Math.max(...mine.map(w => w.box.x + w.box.width)), y1: Math.max(...mine.map(w => w.box.y + w.box.height)) };
    xs.push([b.x, u.x0], [b.x + b.w, u.x1]); ys.push([b.y, u.y0], [b.y + b.h, u.y1]); spanX.push(b.x, b.x + b.w); spanY.push(b.y, b.y + b.h);
  }
  const line = (pts: [number, number][]) => {
    const fit = (q: [number, number][]) => { const n = q.length, ma = q.reduce((s, p) => s + p[0], 0) / n, mt = q.reduce((s, p) => s + p[1], 0) / n; let sxy = 0, sxx = 0; for (const [a, t] of q) { sxy += (a - ma) * (t - mt); sxx += (a - ma) ** 2; } const k = sxx ? sxy / sxx : 1; return { k, b: mt - k * ma }; };
    let f = fit(pts); const res = (p: [number, number]) => Math.abs(f.k * p[0] + f.b - p[1]), med = [...pts].map(res).sort((a, b) => a - b)[pts.length >> 1];
    const kept = pts.filter(p => res(p) <= Math.max(2.5 * med, 0.004 * long)); if (kept.length >= 4) f = fit(kept);
    const rms = Math.sqrt(kept.reduce((s, p) => s + (f.k * p[0] + f.b - p[1]) ** 2, 0) / Math.max(1, kept.length));
    return { ...f, rms };
  };
  if (blocks < 3 || Math.max(...spanX) - Math.min(...spanX) < W / 3 || Math.max(...spanY) - Math.min(...spanY) < H / 3) return { scene };
  const fx = line(xs), fy = line(ys), moved = Math.max(Math.abs(fx.b), Math.abs(fx.k * W + fx.b - W), Math.abs(fy.b), Math.abs(fy.k * H + fy.b - H));
  if (fx.rms > 0.01 * long || fy.rms > 0.01 * long || Math.abs(fx.k - 1) > 0.1 || Math.abs(fy.k - 1) > 0.1 || moved < 0.005 * long) return { scene };
  const map = (b: SceneBox): SceneBox => {
    const x0 = Math.min(W, Math.max(0, fx.k * b.x * W + fx.b)), x1 = Math.min(W, Math.max(0, fx.k * (b.x + b.w) * W + fx.b)), y0 = Math.min(H, Math.max(0, fy.k * b.y * H + fy.b)), y1 = Math.min(H, Math.max(0, fy.k * (b.y + b.h) * H + fy.b));
    return { ...b, x: x0 / W, y: y0 / H, w: Math.max(1, x1 - x0) / W, h: Math.max(1, y1 - y0) / H };
  };
  const round = (v: number) => Math.round(v * 10000) / 10000;
  return { scene: { ...scene, objects: scene.objects.map(o => ({ ...o, box: map(o.box) })), marks: scene.marks.map(m => ({ ...m, box: map(m.box) })), overlays: scene.overlays.map(t => ({ ...t, box: map(t.box) })) },
    fit: { x: { k: round(fx.k), b: round(fx.b) }, y: { k: round(fy.k), b: round(fy.b) }, blocks } };
}

/** What a scene object is for the template (null: the background scenery itself, which is the base). */
export function objectKindOf(o: Pick<SceneObject, 'kind' | 'category' | 'label' | 'description' | 'id'>, advertised: Set<string>): ProductObjectKind | null {
  // What it is (its category and name), not where it is: the description of an air conditioner "above the stepped
  // podium" once made the appliance a podium, left in the background.
  const words = `${o.category} ${o.label}`.toLowerCase();
  if (o.kind === 'scenery') return null;
  if (o.kind === 'character' || o.kind === 'person' || o.kind === 'animal') return 'character';
  if (/podium|plinth|pedestal|platform|stage|display stand|riser/.test(words)) return 'podium';
  if (o.kind === 'product' || advertised.has(o.id)) return 'product';
  if (/frame|border|arch|gate/.test(words)) return 'frame';
  return 'decoration';
}

export interface ProductDetectInput {
  template: Pick<ProtectedTemplate, 'id' | 'source'>;
  source: Rgba; png: Buffer;
  recognizer: WordRecognizer; analyzer?: SceneAnalyzer;
  previous?: TextAnalysis;
  /** Stores a file of the template (logo crops) and a JSON of the analysis requests. */
  store: (file: string, png: Buffer) => void; save: (file: string, value: object) => void;
  at: string;
  /** The answer's boxes are exact (a variation's own composition): never calibrated or snapped onto the picture's ink. */
  exact?: boolean;
}
export interface ProductDetectResult {
  analysis: TextAnalysis; elements: ProtectedElement[]; objects: ProductObject[];
  local: { words: number; blocks: number; logos: number; qr: number; durationMs: number };
  ai: NonNullable<ProductDetection['ai']>;
  missingText: { text: string; box: Box }[];
  written: string[];
  /** Each logo on the artwork where the AI put it, before it was placed on the logo (snapLogoBoxes), by its label. */
  aiLogoBoxes: { label: string; box: Box }[];
  /** Each object as the AI drew it (before calibrateScene), by its label and kind; `absorbed`: now part of its holder. */
  aiObjectBoxes: { label: string; kind: ProductObjectKind; box: Box; absorbed?: boolean }[];
}

export async function detectProduct(input: ProductDetectInput): Promise<ProductDetectResult> {
  const { source, at } = input, size = { width: source.width, height: source.height }, started = Date.now(), written: string[] = [], aiLogoBoxes: ProductDetectResult['aiLogoBoxes'] = [], aiObjectBoxes: ProductDetectResult['aiObjectBoxes'] = [];
  // Preserve partial local evidence, but report skipped/failed AI separately; preparation is gated by the service.
  let scene: ProductScene | undefined, ai: ProductDetectResult['ai'] = { status: 'skipped' };
  if (input.analyzer) {
    try { scene = await input.analyzer.analyze(input.png, 'image/png', input.save); if (!scene.words && !input.analyzer.model.startsWith('offline')) throw new Error('AI word-level manifest missing. Retry with the Product with Text analyzer.'); ai = { status: 'done', model: input.analyzer.model, ...(input.analyzer.model.startsWith('offline') ? { offline: true } : {}), objects: scene.objects.length, costUsd: scene.analysisUsage?.costUsd }; }
    catch (error) {
      scene = undefined;
      const known = error instanceof ProductAnalysisError ? error : undefined;
      ai = { status: 'failed', model: input.analyzer.model, error: error instanceof Error ? error.message.slice(0, 400) : String(error), ...(known ? { code: known.code, costUsd: known.usage?.costUsd, ...(known.details?.httpStatus ? { httpStatus: known.details.httpStatus } : {}), ...(known.details?.elapsedMs !== undefined ? { elapsedMs: known.details.elapsedMs } : {}), ...(known.details?.sent ? { sent: known.details.sent } : {}) } : {}) };
    }
  }
  // The model's word boxes moved onto their letters before anything is measured from them or calibrated against them
  // (wordFit.ts: read by the on-device recognizer, else by the letter strokes; kept when unsure). What each line did is
  // saved beside the analysis.
  if (scene?.words && !input.exact) {
    const fit = await fitSceneWords(source, scene.words, input.recognizer);
    scene = { ...scene, words: fit.words };
    input.save('product.word-fit.json', { note: 'The analysis\'s word boxes fitted to their letters in the picture, line by line (letters: read on this computer; strokes: by the picture\'s letter strokes; kept: left as given).', lines: fit.lines });
  }
  // The model's fractional frame corrected (calibrateScene); the boxes as it gave them kept, to tell later which ones a
  // review left untouched.
  const rawBoxes = new Map<string, SceneBox>();
  if (scene) {
    for (const o of scene.objects) rawBoxes.set(`o:${o.id}`, o.box);
    for (const m of scene.marks) rawBoxes.set(`m:${m.id}`, m.box);
    const calibrated = input.exact ? { scene, fit: undefined } : calibrateScene(scene, size);
    if (calibrated.fit) { scene = calibrated.scene; input.save('product.calibration.json', { ...calibrated.fit, note: 'The fractional boxes were moved by this fit (measured on the text blocks against their words).' }); }
  }
  const empty: TextAnalysis = { version: 1, revision: (input.previous?.revision ?? 0) + 1, analyzedAt: at, updatedAt: at,
    engine: { ...input.recognizer.engine, local: true }, basis: { sourceSha256: input.template.source.sha256, regionsKey: 'product-ai-manifest' }, words: [], groups: [], logoSlots: [], plates: [], history: [] };
  let local: { analysis: TextAnalysis; elements: ProtectedElement[] } = { analysis: empty, elements: [] };
  if (!scene?.words) {
    try { const scan = await scanPoster(source, input.recognizer); local = await buildMasterAnalysis({ template: input.template, source, scan, recognizer: input.recognizer, previous: input.previous, store: (f, png) => { input.store(f, png); written.push(f); }, at }); }
    catch (error) { input.save('local-reading-error.json', { error: String(error) }); }
  }
  const analysis = local.analysis, elements = local.elements;
  const localStats = { words: analysis.words.length, blocks: analysis.groups.length, logos: analysis.logoSlots.length, qr: 0, durationMs: Date.now() - started };
  const objects: ProductObject[] = [];
  const review = (confidence: number, reason?: string): ProductObject['review'] => (confidence >= PRODUCT_ATTENTION_BELOW && !reason ? { status: 'accepted', at, by: 'auto' } : { status: 'attention', reason: reason ?? `Found with ${Math.round(confidence * 100)}% certainty.`, at, by: 'auto' });
  // (Products the analysis names as advertised one by one are each their own, wherever their boxes lie.)
  const ownProduct = new Set<ProductObject>();
  const add = (kind: ProductObjectKind, label: string, box: Box, confidence: number, origin: ProductObject['origin'], reason?: string, own = false) => {
    objects.push({ id: hexId('po'), kind, label: label.slice(0, 80), box, confidence: Math.round(confidence * 100) / 100, z: 0, covers: [], origin, review: review(confidence, reason) });
    if (own) ownProduct.add(objects[objects.length - 1]);
  };
  if (scene) {
    // Logos on the artwork placed on what they name (snapLogoBoxes); marks on products stay as given.
    const overlayMarks = scene.marks.filter(m => m.overlay), raw = overlayMarks.map(m => pixels(rawBoxes.get(`m:${m.id}`) ?? m.box, size));
    const snapped = new Map((input.exact ? raw : fitLogosToInk(source, snapLogoBoxes(source, raw))).map((b, k) => [overlayMarks[k], b]));
    // Kept out of every provider's input: where the AI put each mark, and where it really is, both.
    analysis.sourceExclusions = scene.marks.map(m => { const a = pixels(m.box, size), b = snapped.get(m) ?? a, x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y, rotation: 0 }; });
    const advertised = new Set(scene.advertised ?? []);
    // What a character holds or wears (a modak in Ganesha's hand), or a part attached to an object, is that object's: as a
    // decoration of its own it took those pixels to the background and left a hole in the character. Only when it is
    // small and inside the holder's box: the model's "holds" can be wrong (a badge beside a character, a microwave behind).
    const held = new Map<string, Box>();
    for (const r of scene.relations) {
      const pair = r.relation === 'holds' || r.relation === 'wears' ? [r.source, r.target] : r.relation === 'attached_to' || r.relation === 'part_of' ? [r.target, r.source] : undefined;
      const holder = pair && scene.objects.find(o => o.id === pair[0]), item = pair && scene.objects.find(o => o.id === pair[1]);
      if (!holder || !item) continue;
      const hk = objectKindOf(holder, advertised), ik = objectKindOf(item, advertised), hb = pixels(holder.box, size), ib = pixels(item.box, size);
      if ((hk !== 'character' && hk !== 'product') || (ik !== 'decoration' && ik !== 'frame') || inside(ib, hb) < 0.7 || ib.width * ib.height > hb.width * hb.height * 0.15) continue;
      held.set(item.id, ib);
      const b = held.get(holder.id) ?? hb, x = Math.min(b.x, ib.x), y = Math.min(b.y, ib.y);
      held.set(holder.id, { x, y, width: Math.max(b.x + b.width, ib.x + ib.width) - x, height: Math.max(b.y + b.height, ib.y + ib.height) - y });
    }
    for (const o of scene.objects.filter(x => !x.ignored)) {
      const kind = objectKindOf(o, advertised);
      if (!kind) continue;
      if ((kind === 'decoration' || kind === 'frame') && held.has(o.id)) { aiObjectBoxes.push({ label: (o.label || o.category).slice(0, 80), kind, box: pixels(rawBoxes.get(`o:${o.id}`) ?? o.box, size), absorbed: true }); continue; }
      const box = (kind === 'character' || kind === 'product') && held.has(o.id) ? held.get(o.id)! : pixels(o.box, size);
      aiObjectBoxes.push({ label: (o.label || o.category).slice(0, 80), kind, box: pixels(rawBoxes.get(`o:${o.id}`) ?? o.box, size) });
      add(kind, o.label || o.category, box, o.confidence, 'ai', o.occluded ? 'Partly overlapped: check the object boundary and any hidden parts.' : box.width * box.height < size.width * size.height * 0.0015 ? 'Very small: check that it is a separate thing.' : undefined, kind === 'product' && advertised.has(o.id));
    }
    // A part: a product lying inside a larger product's box that the analysis does not advertise on its own (a TV's stand
    // or its remote) is that product's, kept in its layer (and named in its review note). A product advertised on its own
    // (earbuds in front of a laptop, a soundbar and speakers with a TV) is its own layer, in front of the larger one (the
    // object order): merged, it vanished into the other's layer.
    const area = (b: Box) => b.width * b.height;
    for (const small of [...objects].filter(o => o.kind === 'product' && !ownProduct.has(o)).sort((a, b) => area(a.box) - area(b.box))) {
      const host = objects.filter(o => o !== small && o.kind === 'product' && area(o.box) >= area(small.box) * 4).find(o => inside(small.box, o.box) >= 0.7);
      if (!host) continue;
      objects.splice(objects.indexOf(small), 1);
      const parts = [...(host.review.reason?.match(/^Includes (.*?) found inside it/)?.[1]?.split(', ') ?? []), small.label];
      host.review = { status: 'attention', at, by: 'auto', reason: `Includes ${parts.join(', ')} found inside it: kept as one layer with it. Draw a box to make one of them its own product.` };
    }
    objects.forEach((o, i) => { o.id = stableId('po', input.template.source.sha256, `${o.kind}:${i}:${o.box.x}:${o.box.y}`); });
    // Two of a kind on the same place may be one thing found twice.
    for (const a of objects) for (const b of objects) if (a !== b && a.kind === b.kind && a.review.status === 'accepted' && iou(a.box, b.box) > 0.6) a.review = { status: 'attention', reason: `Overlaps “${b.label}”: one thing found twice, or two things close together?`, at, by: 'auto' };
    // AI identity and tight boxes are authoritative. Local colour tiles can be single green letters.
    // Never promote those fragments to logos when the scene does not identify them.
    analysis.logoSlots = [];
    for (const m of scene.marks) {
      // A mark printed on a product is part of the product; a mark placed on the artwork (overlay) is a logo overlay,
      // whatever its kind: a brand's own mark on the poster (product_brand / merchant) is the brand logo.
      if (!m.overlay) continue;
      const box = snapped.get(m) ?? pixels(m.box, size), category: MasterCategory = m.kind === 'merchant_logo' || m.kind === 'product_brand' ? 'brand-logo' : 'partner-logo';
      // Identified only when the analysis read a name; "unclear …" or "unknown …" names and other_logo marks need a look.
      const unsure = !m.text || m.kind === 'other_logo' || /\b(unclear|unknown|unidentified|unreadable|illegible)\b/i.test(m.text);
      const made = await logoSlot(source, box, m.text && !unsure ? `${m.text.slice(0, 40)} logo` : m.text ? m.text.slice(0, 60) : m.label || 'Unidentified logo', category, input.store, analysis.logoSlots.length);
      made.confidence = unsure ? 0.5 : 0.9;
      made.review = { status: unsure ? 'needs-review' : 'approved', at };
      made.id = stableId('pl', input.template.source.sha256, `${m.kind}:${box.x}:${box.y}`);
      aiLogoBoxes.push({ label: made.label, box: pixels(rawBoxes.get(`m:${m.id}`) ?? m.box, size) });
      written.push(made.original.file); analysis.logoSlots.push(made);
    }
  } else {
    for (const slot of analysis.logoSlots) { slot.confidence = Math.min(slot.confidence, 0.5); slot.review = { status: 'needs-review', at }; }
  }
  if (scene?.words) {
    const words: DetectedWord[] = [], groups = new Map<string, WordGroup>();
    const lines = new Map<string, NonNullable<ProductScene['words']>>();
    for (const word of scene.words) {
      const key = `${word.group}:${word.line}`; lines.set(key, [...(lines.get(key) ?? []), word]);
    }
    for (const [lineKey, lineWords] of lines) {
      const styled = await styleLine(source, lineWords);
      for (const [i, w] of lineWords.entries()) {
        const previous = input.previous?.words.find(p => iou(p.box, w.box) > 0.65);
        const groupId = stableId('pg', input.template.source.sha256, w.group), lineId = stableId('pn', input.template.source.sha256, lineKey);
        const elementId = stableId('pe', input.template.source.sha256, w.group), st = styled[i];
        const role = w.role === 'legal' ? 'legal' : w.role === 'offer' ? 'claim' : 'copy';
        const word: DetectedWord = { id: previous?.id ?? stableId('pw', input.template.source.sha256, w.id), text: w.text,
          recognized: { text: w.text, confidence: w.confidence, mode: 'ai-word-manifest' }, box: { ...w.box }, normalized: normalizeBox(w.box, size),
          elementId, groupId, lineId, order: words.length, confidence: w.confidence, styleConfidence: st.confidence, role, protected: role !== 'copy', origin: 'ai', locked: false,
          style: st.style,
          review: { status: w.confidence >= LOW_WORD_CONFIDENCE ? 'approved' : 'needs-review', at } };
        words.push(word);
        let g = groups.get(groupId);
        if (!g) { g = { id: groupId, elementId, label: '', lines: [], align: 'left', category: ['headline', 'offer', 'legal', 'cta'].includes(w.role) ? w.role as MasterCategory : 'supporting' }; groups.set(groupId, g); }
        let line = g.lines.find(l => l.id === lineId); if (!line) { line = { id: lineId, wordIds: [] }; g.lines.push(line); }
        line.wordIds.push(word.id); g.label = `${g.label} ${word.text}`.trim().slice(0, 200);
      }
    }
    analysis.words = words; analysis.groups = [...groups.values()]; analysis.plates = [];
  }
  // Words printed on a product or on artwork (a TV's brand, a badge's lettering, the brand logo's own wordmark) are part
  // of it, not editable text, unless the analysis lists them as advertising text.
  const overlayBoxes = (scene?.overlays ?? []).map(t => pixels(t.box, size));
  const owners = objects.filter(o => o.kind === 'character' || o.kind === 'product');
  for (const w of analysis.words) {
    const b = { x: w.box.x, y: w.box.y, width: w.box.width, height: w.box.height };
    if (analysis.logoSlots.some(l => inside(b, l.box) >= 0.6)) { w.review = { status: 'rejected', at }; continue; }
    if (scene?.words || overlayBoxes.some(t => inside(b, t) >= 0.5)) continue;
    const on = owners.find(o => inside(b, o.box) >= 0.8);
    if (on) w.review = { status: 'rejected', at };
  }
  // Text blocks take the analysis's roles; confident words are accepted at once.
  const roleCategory: Record<string, MasterCategory> = { headline: 'headline', offer: 'offer', price: 'offer', legal: 'legal', cta: 'cta', caption: 'supporting', other: 'supporting' };
  for (const g of analysis.groups) {
    const ws = analysis.words.filter(w => w.groupId === g.id && w.review.status !== 'rejected');
    if (!ws.length) continue;
    const gb = { x: Math.min(...ws.map(w => w.box.x)), y: Math.min(...ws.map(w => w.box.y)), width: 0, height: 0 };
    gb.width = Math.max(...ws.map(w => w.box.x + w.box.width)) - gb.x; gb.height = Math.max(...ws.map(w => w.box.y + w.box.height)) - gb.y;
    const t = (scene?.overlays ?? []).map((o, i) => ({ o, s: inside(gb, overlayBoxes[i]) })).filter(x => x.s >= 0.5).sort((a, b) => b.s - a.s)[0];
    if (t) g.category = roleCategory[t.o.role] ?? g.category;
  }
  for (const w of analysis.words) if (w.review.status === 'needs-review' && w.confidence >= LOW_WORD_CONFIDENCE) w.review = { status: 'approved', at };
  for (const s of analysis.logoSlots) if (s.review.status === 'needs-review' && s.confidence >= PRODUCT_ATTENTION_BELOW) s.review = { status: 'approved', at };
  // Text the analysis saw that the reading did not: for a quick check.
  const missingText = (scene?.overlays ?? []).flatMap((t, i) => {
    const box = overlayBoxes[i];
    return analysis.words.some(w => w.review.status !== 'rejected' && inside({ x: w.box.x, y: w.box.y, width: w.box.width, height: w.box.height }, box) >= 0.5) || !t.text.trim() ? [] : [{ text: t.text.slice(0, 300), box }];
  });
  // Back to front (supports behind what stands on them); an object in front covers the ones it overlaps.
  const ordered = orderProductObjects(objects);
  objects.splice(0, objects.length, ...ordered);
  objects.forEach((o, i) => { o.z = i; });
  for (const o of objects) o.covers = objects.filter(p => p.z < o.z && iou(o.box, p.box) > 0 && inside(p.box, o.box) > 0).map(p => p.id);
  // Immutable source evidence survives review edits and is also used by the provider exclusion gate.
  for (const w of analysis.words) {
    const b = w.box, rect = { left: Math.max(0, Math.floor(b.x)), top: Math.max(0, Math.floor(b.y)), width: Math.max(1, Math.ceil(b.width)), height: Math.max(1, Math.ceil(b.height)) };
    rect.width = Math.min(rect.width, source.width - rect.left); rect.height = Math.min(rect.height, source.height - rect.top);
    const crop = await sharp(input.png).extract(rect).png().toBuffer(), file = `word-${w.id}-${sha256(crop).slice(0, 12)}.png`;
    input.store(file, crop); written.push(file);
    w.source = { box: { ...b }, crop: file, z: scene?.words?.find(v => v.text === w.recognized.text && iou(v.box, b) > 0.5)?.z ?? w.order };
  }
  for (const o of objects) {
    o.category = o.label;
    const png = await sharp(input.png).extract({ left: o.box.x, top: o.box.y, width: o.box.width, height: o.box.height }).png().toBuffer();
    const hash = sha256(png), file = `object-source-${o.id}-${hash.slice(0,12)}.png`;
    input.store(file, png); written.push(file); o.source = { crop: file, box: { ...o.box }, sha256: hash };
  }
  return { analysis, elements, objects, local: localStats, ai, missingText, written, aiLogoBoxes, aiObjectBoxes };
}

/** A logo slot of the source's exact pixels inside `box` (stored as its own file), as the Text & Graphics analysis makes them. */
/**
 * A box fitted to what it holds: within the box grown by 3 px (never into another logo's box), the pixels that differ from
 * the colour just around it.
 * Unchanged when that is not a clear thing (less than a third of the box).
 */
export function snapToContent(source: Rgba, box: Box | SourceBox, avoid: (Box | SourceBox)[] = []): Box {
  const { width: w, height: h, data } = source, g = 3, x0 = Math.max(0, Math.floor(box.x) - g), y0 = Math.max(0, Math.floor(box.y) - g), x1 = Math.min(w, Math.ceil(box.x + box.width) + g), y1 = Math.min(h, Math.ceil(box.y + box.height) + g);
  const ring: number[][] = [[], [], []];
  for (let y = Math.max(0, y0 - 3); y < Math.min(h, y1 + 3); y++) for (let x = Math.max(0, x0 - 3); x < Math.min(w, x1 + 3); x++) {
    if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
    const i = (y * w + x) * 4; for (let c = 0; c < 3; c++) ring[c].push(data[i + c]);
  }
  const keep: Box = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  if (!ring[0].length) return keep;
  const bg = ring.map(v => { v.sort((a, b) => a - b); return v[v.length >> 1]; });
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  const other = (x: number, y: number) => avoid.some(b => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; if (other(x, y)) continue; if (Math.max(Math.abs(data[i] - bg[0]), Math.abs(data[i + 1] - bg[1]), Math.abs(data[i + 2] - bg[2])) > 24) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; } }
  if (bx1 < 0 || (bx1 - bx0 + 1) * (by1 - by0 + 1) < box.width * box.height / 3) return keep;
  return { x: bx0, y: by0, width: bx1 - bx0 + 1, height: by1 - by0 + 1 };
}

/**
 * The AI's logo boxes placed on the logos they name. The model's boxes can sit half a logo's height off (a 4096 px
 * creative's bank logos came back about 1.2 % of the height too low and 1–2 % to the right, live on 2026-10-22: half of
 * each logo stayed in the picture, the overlay gate refused to prepare, and each logo's overlay was half a logo).
 *
 *   rows     logos side by side (their boxes overlapping in height) share the model's offset: it is found for the row at
 *            once — where, all together, the boxes hold the most of what stands out from the background around each and
 *            cut the least of it at their edges (so no box drifts onto a brighter neighbour); a lone logo, by itself
 *   each     then around that by itself (its error can grow along the row), never onto the middle of a neighbour (the
 *            neighbour at the row's offset, less 15 % of it each side); then grown to its card's edge where the logo
 *            plainly goes on
 *   bounds   at most 60 % of a box's height up or down and a fifth of its width sideways; sizes kept; moved only for a
 *            clear gain. Started from the model's own boxes, not its corrected frame (calibrateScene): that is right only
 *            within ~1 %, and a logo already right must stay right.
 */
export function snapLogoBoxes(source: Rgba, boxes: Box[]): Box[] {
  const W = source.width, H = source.height, n = boxes.length, out = boxes.map(b => ({ ...b }));
  // Rows: boxes overlapping by half the smaller one's height.
  const parent = boxes.map((_, i) => i), root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const a = boxes[i], b = boxes[j]; if (Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) >= Math.min(a.height, b.height) * 0.5) parent[root(i)] = root(j); }
  const rows = new Map<number, number[]>(); for (let i = 0; i < n; i++) { const r = root(i); rows.set(r, [...(rows.get(r) ?? []), i]); }
  for (const row of rows.values()) {
    const med = (v: number[]) => [...v].sort((p, q) => p - q)[v.length >> 1];
    const my = Math.round(0.6 * med(row.map(i => boxes[i].height))), mx = Math.round(0.2 * med(row.map(i => boxes[i].width)));
    // Each box's view: what stands out from its background (the median along its searched area's border), as running sums.
    const views = row.map(i => {
      const box = boxes[i], bw = Math.max(1, Math.round(box.width)), bh = Math.max(1, Math.round(box.height)), t = Math.max(2, Math.round(bh * 0.12)), gy = Math.max(2, Math.round(bh * 0.15)), gx = Math.max(2, Math.round(bw * 0.06));
      const X0 = Math.max(0, Math.floor(box.x) - mx - Math.max(gx, Math.round(W * 0.015)) - t), Y0 = Math.max(0, Math.floor(box.y) - my - gy - t), X1 = Math.min(W, Math.ceil(box.x + box.width) + mx + Math.max(gx, Math.round(W * 0.015)) + t), Y1 = Math.min(H, Math.ceil(box.y + box.height) + my + gy + t), RW = X1 - X0, RH = Y1 - Y0;
      const border: number[][] = [[], [], []];
      for (let x = X0; x < X1; x++) for (const y of [Y0, Y1 - 1]) { const k = (y * W + x) * 4; for (let c = 0; c < 3; c++) border[c].push(source.data[k + c]); }
      for (let y = Y0; y < Y1; y++) for (const x of [X0, X1 - 1]) { const k = (y * W + x) * 4; for (let c = 0; c < 3; c++) border[c].push(source.data[k + c]); }
      const bg = border.map(v => med(v)), S = new Int32Array((RW + 1) * (RH + 1));
      for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
        const k = ((y + Y0) * W + x + X0) * 4, on = Math.max(Math.abs(source.data[k] - bg[0]), Math.abs(source.data[k + 1] - bg[1]), Math.abs(source.data[k + 2] - bg[2])) > 40 ? 1 : 0;
        S[(y + 1) * (RW + 1) + x + 1] = on + S[y * (RW + 1) + x + 1] + S[(y + 1) * (RW + 1) + x] - S[y * (RW + 1) + x];
      }
      const sum = (x0: number, y0: number, x1: number, y1: number) => { x0 = Math.max(0, x0 - X0); y0 = Math.max(0, y0 - Y0); x1 = Math.min(RW, x1 - X0); y1 = Math.min(RH, y1 - Y0); return x1 <= x0 || y1 <= y0 ? 0 : S[y1 * (RW + 1) + x1] - S[y0 * (RW + 1) + x1] - S[y1 * (RW + 1) + x0] + S[y0 * (RW + 1) + x0]; };
      const at = (dx: number, dy: number) => { const x0 = Math.round(box.x) + dx, y0 = Math.round(box.y) + dy, inside = sum(x0, y0, x0 + bw, y0 + bh); return inside - 2 * (sum(x0 - t, y0 - t, x0 + bw + t, y0 + bh + t) - inside); };
      return { i, box, bw, bh, gx, gy, sum, at };
    });
    // The row's offset.
    const total = (dx: number, dy: number) => views.reduce((s, v) => s + v.at(dx, dy), 0), here = total(0, 0);
    let best = { dx: 0, dy: 0, s: here };
    for (let dy = -my; dy <= my; dy++) for (let dx = -mx; dx <= mx; dx++) { const s = total(dx, dy); if (s > best.s || (s === best.s && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy))) best = { dx, dy, s }; }
    if (best.s - here < views.reduce((s, v) => s + v.bw * v.bh, 0) * 0.08) best = { dx: 0, dy: 0, s: here };
    const cores = views.map(v => ({ i: v.i, x: Math.round(v.box.x) + best.dx + v.bw * 0.15, y: Math.round(v.box.y) + best.dy + v.bh * 0.15, width: v.bw * 0.7, height: v.bh * 0.7 }));
    for (const v of views) {
      const clear = (x: number, y: number, w: number, h: number) => cores.every(q => q.i === v.i || Math.min(x + w, q.x + q.width) <= Math.max(x, q.x) || Math.min(y + h, q.y + q.height) <= Math.max(y, q.y));
      // Around the row's offset, by itself (only when the row moved: an unmoved box stays as the model drew it).
      const wx = Math.max(v.gx, Math.round(W * 0.015));
      let d = { dx: best.dx, dy: best.dy, s: clear(Math.round(v.box.x) + best.dx, Math.round(v.box.y) + best.dy, v.bw, v.bh) ? v.at(best.dx, best.dy) : -Infinity };
      if (best.dx || best.dy) for (let dy = best.dy - v.gy; dy <= best.dy + v.gy; dy++) for (let dx = best.dx - wx; dx <= best.dx + wx; dx++) {
        if (Math.abs(dx) > mx + v.gx || !clear(Math.round(v.box.x) + dx, Math.round(v.box.y) + dy, v.bw, v.bh)) continue;
        const s = v.at(dx, dy); if (s > d.s) d = { dx, dy, s };
      }
      if (!Number.isFinite(d.s)) d = { dx: 0, dy: 0, s: 0 };
      if (!d.dx && !d.dy) continue;
      let x0 = Math.round(v.box.x) + d.dx, y0 = Math.round(v.box.y) + d.dy, x1 = x0 + v.bw, y1 = y0 + v.bh;
      // Out to its edge where the logo goes on past the box — enough of what stands out just outside continues what stands
      // out just inside (a card's edge, an icon's tip; a logo wider than the model's box, up to 12 % of its width) —
      // never into a neighbour.
      const growY = Math.max(2, Math.round(v.bh * 0.08)), growX = Math.max(2, Math.round(v.bw * 0.12)), free = (x: number, y: number, w: number, h: number) => cores.every(q => q.i === v.i || Math.min(x + w, q.x + q.width) <= Math.max(x, q.x) || Math.min(y + h, q.y + q.height) <= Math.max(y, q.y));
      const on = (x: number, y: number) => v.sum(x, y, x + 1, y + 1) > 0;
      const goesOnY = (outer: number, inner: number) => { let n = 0; for (let x = x0; x < x1; x++) if (on(x, outer) && on(x, inner)) n++; return n >= Math.max(3, (x1 - x0) * 0.02); };
      const goesOnX = (outer: number, inner: number) => { let n = 0; for (let y = y0; y < y1; y++) if (on(outer, y) && on(inner, y)) n++; return n >= Math.max(3, (y1 - y0) * 0.02); };
      for (let k = 0; k < growY && y0 > 0 && goesOnY(y0 - 1, y0); k++) y0--;
      for (let k = 0; k < growY && y1 < H && goesOnY(y1, y1 - 1); k++) y1++;
      for (let k = 0; k < growX && x0 > 0 && goesOnX(x0 - 1, x0) && free(x0 - 1, y0, 1, y1 - y0); k++) x0--;
      for (let k = 0; k < growX && x1 < W && goesOnX(x1, x1 - 1) && free(x1, y0, 1, y1 - y0); k++) x1++;
      x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
      out[v.i] = { ...v.box, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
  }
  return out;
}

/**
 * Logos in rows on a plain background, fitted to their own ink after snapping: the row's ink in pieces, the pieces in
 * logos by how close they are (an icon beside its name, the words of a name, letters on a card), and each box the union of
 * the logos it holds most of. (A box drawn a logo's icon off to the right left
 * the icon and its first letter in the clean picture, and took part of the next logo.) Rows over artwork stay as snapped.
 */
export function fitLogosToInk(source: Rgba, boxes: Box[]): Box[] {
  const W = source.width, H = source.height, n = boxes.length, out = boxes.map(b => ({ ...b }));
  const parent = boxes.map((_, i) => i), root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const a = boxes[i], b = boxes[j]; if (Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) >= Math.min(a.height, b.height) * 0.5) parent[root(i)] = root(j); }
  const rows = new Map<number, number[]>(); for (let i = 0; i < n; i++) { const r = root(i); rows.set(r, [...(rows.get(r) ?? []), i]); }
  const med = (v: number[]) => [...v].sort((p, q) => p - q)[v.length >> 1];
  for (const row of rows.values()) {
    if (row.length < 2) continue;
    const bh = med(row.map(i => boxes[i].height)), padX = Math.round(bh * 0.6), padY = Math.round(bh * 0.3);
    const X0 = Math.max(0, Math.floor(Math.min(...row.map(i => boxes[i].x))) - padX), Y0 = Math.max(0, Math.floor(Math.min(...row.map(i => boxes[i].y))) - padY);
    const X1 = Math.min(W, Math.ceil(Math.max(...row.map(i => boxes[i].x + boxes[i].width))) + padX), Y1 = Math.min(H, Math.ceil(Math.max(...row.map(i => boxes[i].y + boxes[i].height))) + padY), RW = X1 - X0, RH = Y1 - Y0;
    if (RW < 4 || RH < 4) continue;
    // Plain: the region's border mostly one colour.
    const border: number[][] = [[], [], []];
    for (let x = X0; x < X1; x++) for (const y of [Y0, Y1 - 1]) { const k = (y * W + x) * 4; for (let c = 0; c < 3; c++) border[c].push(source.data[k + c]); }
    for (let y = Y0; y < Y1; y++) for (const x of [X0, X1 - 1]) { const k = (y * W + x) * 4; for (let c = 0; c < 3; c++) border[c].push(source.data[k + c]); }
    const bg = border.map(med); let near = 0;
    for (let k = 0; k < border[0].length; k++) if (Math.max(...[0, 1, 2].map(c => Math.abs(border[c][k] - bg[c]))) <= 20) near++;
    if (near < border[0].length * 0.8) continue;
    // Ink, and its pieces: joined across gaps of up to 4 % of the logo height (the letters of a word).
    const ink = new Uint8Array(RW * RH);
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) { const k = ((y + Y0) * W + x + X0) * 4; if (Math.max(Math.abs(source.data[k] - bg[0]), Math.abs(source.data[k + 1] - bg[1]), Math.abs(source.data[k + 2] - bg[2])) > 40) ink[y * RW + x] = 1; }
    const j = Math.max(1, Math.round(bh * 0.04)), label = new Int32Array(RW * RH).fill(-1), pieces: { x0: number; y0: number; x1: number; y1: number; px: number[] }[] = [];
    for (let s0 = 0; s0 < RW * RH; s0++) {
      if (!ink[s0] || label[s0] >= 0) continue;
      const piece = { x0: RW, y0: RH, x1: -1, y1: -1, px: [] as number[] }, stack = [s0]; label[s0] = pieces.length;
      while (stack.length) {
        const q = stack.pop()!, qx = q % RW, qy = (q - qx) / RW; piece.px.push(q);
        piece.x0 = Math.min(piece.x0, qx); piece.x1 = Math.max(piece.x1, qx); piece.y0 = Math.min(piece.y0, qy); piece.y1 = Math.max(piece.y1, qy);
        for (let dy = -j; dy <= j; dy++) for (let dx = -j; dx <= j; dx++) { const X = qx + dx, Y = qy + dy; if (X < 0 || Y < 0 || X >= RW || Y >= RH) continue; const t = Y * RW + X; if (ink[t] && label[t] < 0) { label[t] = pieces.length; stack.push(t); } }
      }
      pieces.push(piece);
    }
    // Pieces into logos: pieces closer than a quarter of the logo height (an icon beside its name, the two halves of an
    // icon, the words of a name), or one within another (letters on a card), are one logo; logos sit farther apart.
    const tau = bh * 0.25, up = pieces.map((_, k) => k), find = (k: number): number => (up[k] === k ? k : (up[k] = find(up[k])));
    // (Specks — a few pixels of a soft edge — join the logo nearest them but never bridge two logos.)
    const minPx = Math.max(12, Math.round(bh * bh * 0.002)), big = (k: number) => pieces[k].px.length >= minPx;
    const gap = (p: typeof pieces[number], q: typeof pieces[number]) => Math.max(Math.max(q.x0 - p.x1, p.x0 - q.x1, 0), Math.max(q.y0 - p.y1, p.y0 - q.y1, 0));
    const within = (o: typeof pieces[number], i: typeof pieces[number]) => i.x0 >= o.x0 && i.x1 <= o.x1 && i.y0 >= o.y0 && i.y1 <= o.y1;
    for (let a = 0; a < pieces.length; a++) for (let b = a + 1; b < pieces.length; b++) {
      if (!big(a) || !big(b)) continue;
      const p = pieces[a], q = pieces[b];
      if (within(p, q) || within(q, p) || gap(p, q) <= tau) up[find(a)] = find(b);
    }
    pieces.forEach((p, k) => { if (big(k)) return; let best = -1, d = tau; pieces.forEach((q, j) => { if (!big(j)) return; const g = within(q, p) ? 0 : gap(p, q); if (g <= d) { d = g; best = j; } }); if (best >= 0) up[find(k)] = find(best); });
    const groups = new Map<number, number[]>(); pieces.forEach((_, k) => { const r = find(k); groups.set(r, [...(groups.get(r) ?? []), k]); });
    // Each logo to the box holding most of it (at least 40 % of its ink); a box takes all its logos' pieces.
    const owner = pieces.map(() => -1);
    for (const ks of groups.values()) {
      let total = 0; const count = new Map<number, number>();
      for (const k of ks) { const p = pieces[k]; total += p.px.length; for (const q of p.px) { const x = q % RW + X0, y = Math.floor(q / RW) + Y0;
        for (const i of row) { const b = boxes[i]; if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) count.set(i, (count.get(i) ?? 0) + 1); } } }
      let best = -1, most = total * 0.4; for (const [i, c] of count) if (c > most) { most = c; best = i; }
      if (best >= 0) for (const k of ks) owner[k] = best;
    }
    const unionOf = (i: number) => { const mine = pieces.filter((_, k) => owner[k] === i); if (!mine.length) return undefined;
      const x0 = Math.min(...mine.map(p => p.x0)) + X0, y0 = Math.min(...mine.map(p => p.y0)) + Y0, x1 = Math.max(...mine.map(p => p.x1)) + X0 + 1, y1 = Math.max(...mine.map(p => p.y1)) + Y0 + 1;
      // (Two pixels past the ink: a card's soft edge.)
      return { x: Math.max(0, x0 - 2), y: Math.max(0, y0 - 2), width: Math.min(W, x1 + 2) - Math.max(0, x0 - 2), height: Math.min(H, y1 + 2) - Math.max(0, y0 - 2) }; };
    for (const i of row) {
      const u = unionOf(i), old = boxes[i]; if (!u) continue;
      // Kept sane: still over the model's logo, at most twice as wide.
      const overlap = Math.max(0, Math.min(u.x + u.width, old.x + old.width) - Math.max(u.x, old.x)) * Math.max(0, Math.min(u.y + u.height, old.y + old.height) - Math.max(u.y, old.y));
      if (overlap < old.width * old.height * 0.3 || u.width > old.width * 2 || u.height > old.height * 1.6) continue;
      out[i] = { ...old, ...u };
    }
  }
  return out;
}

export async function logoSlot(source: Rgba, box: Box, label: string, category: MasterCategory, store: (file: string, png: Buffer) => void, order: number): Promise<LogoSlot> {
  const size = { width: source.width, height: source.height }, rect = { x: Math.max(0, Math.floor(box.x)), y: Math.max(0, Math.floor(box.y)), width: 0, height: 0 };
  rect.width = Math.min(size.width, Math.ceil(box.x + box.width)) - rect.x; rect.height = Math.min(size.height, Math.ceil(box.y + box.height)) - rect.y;
  const png = await sharp(source.data, { raw: { width: source.width, height: source.height, channels: 4 } }).extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height }).png({ compressionLevel: 9 }).toBuffer();
  const id = hexId('pl'), hash = sha256(png), file = `logo-${id}-${hash.slice(0, 12)}.png`, b: SourceBox = { ...rect, rotation: 0 };
  store(file, png);
  const original: ProtectedAssetRef & { placement: typeof rect } = { file, sha256: hash, mime: 'image/png', width: rect.width, height: rect.height, bytes: png.length, hasAlpha: true, placement: rect };
  return { id, label: label.slice(0, 80), elementId: '', box: b, normalized: normalizeBox(b, size), original, detection: 'admin', confidence: 0.8, order, locked: false, replaceable: true, review: { status: 'approved' }, category };
}
