/**
 * A master template's words, logo slots and text plates (its textAnalysis), and the protected regions that contain them,
 * from the scan of the whole poster (scan.ts):
 *
 *   lines     each line of text is read once more on its own (a tight crop reads stretched or very large lettering better,
 *             "NO-COST" where the whole poster gave "NO-" and "OS"), and the two readings are reconciled: the more
 *             confident one wins, a word only one of them found is kept when it is clearly text
 *   words     each word's box tightened to its own ink; colour and slant measured from its pixels; family, weight, size,
 *             baseline and text origin from the closest offer font (fontMatch.ts), one face per line
 *   groups    a block of lines is one phrase; its category (headline, offer, supporting, CTA, legal) is guessed from its
 *             text, its size against the poster's largest text and whether it sits on a plate
 *   logos     every logo card of a grid, every QR code, badge and brand mark is its own slot with the source's exact pixels
 *
 * Every item starts as needs-review; nothing here is final. Re-scanning keeps the ids of what is found again.
 */
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import {
  boxIoU, guessTextCategory, guessWordRole, normalizeBox, PROTECTED_ROLES, readingOrder, regionsKey, WORD_ANALYSIS_VERSION, withHistory,
  type DetectedWord, type LogoSlot, type MasterCategory, type ProtectedAssetRef, type ProtectedElement, type ProtectedTemplate, type SourceBox, type TextAnalysis, type TextPlate, type WordGroup, type WordStyle,
} from '@frameflow/shared';
import { sha256, type Rgba } from '../pixels.js';
import { inkBounds, measureWord, type PixelBox } from '../../../textRecognition/measure.js';
import { matchLineFont } from '../../../textRecognition/fontMatch.js';
import type { RecognizedWord, WordRecognizer } from '../../../textRecognition/recognizer.js';
import { boxInsideShare, colourDistance, padBox, unionBoxes, type PosterScan, type ScanLine } from './scan.js';

const hexId = (prefix: string) => `${prefix}-${randomBytes(5).toString('hex')}`;
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const alnum = (t: string) => (t.match(/[\p{L}\p{N}]/gu) ?? []).length;
const DECORATION = /^[oO0°•·.,:;'"`()[\]{}|8\-_~*=]+$/;
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1] ?? 0; };

interface Reading { text: string; confidence: number; box: PixelBox; mode: string }

/** One line read again on its own: a crop of the line (with a margin), the words mapped back to source pixels. */
async function rereadLine(source: Rgba, recognizer: WordRecognizer, line: ScanLine): Promise<Reading[]> {
  const h = median(line.words.map(w => w.box.height)), region = padBox(line.box, Math.max(4, h * 0.18), source);
  const png = await sharp(source.data, { raw: { width: source.width, height: source.height, channels: 4 } }).extract({ left: region.x, top: region.y, width: region.width, height: region.height }).png().toBuffer();
  const read: RecognizedWord[] = await recognizer.recognize({ image: png, region, purpose: 'template' });
  const boxes = read.map(w => ({ x: region.x + w.box.x0, y: region.y + w.box.y0, width: w.box.x1 - w.box.x0, height: w.box.y1 - w.box.y0 }));
  return read.map((w, k) => {
    const smaller = boxes.filter((b, j) => j !== k && b.width * b.height < boxes[k].width * boxes[k].height && boxInsideShare(b, boxes[k]) > 0.8);
    return { text: w.text.trim(), confidence: w.confidence, box: inkBounds(source, boxes[k], smaller), mode: `line ${w.mode}` };
  }).filter(w => w.text && alnum(w.text) && !DECORATION.test(w.text) && boxInsideShare(w.box, line.box) > 0.5);
}
/** The two readings of a line reconciled into its words, left to right. */
function reconcile(scanWords: Reading[], line: Reading[], lineBox: PixelBox): Reading[] {
  const overlaps = (a: PixelBox, b: PixelBox) => boxInsideShare(a, b) > 0.5 || boxInsideShare(b, a) > 0.5;
  const out: Reading[] = [], usedScan = new Set<Reading>();
  for (const r of line) {
    const covered = scanWords.filter(s => overlaps(s.box, r.box));
    if (!covered.length) { if (r.confidence >= 0.85 && alnum(r.text) >= 2 && boxInsideShare(r.box, lineBox) > 0.8) out.push(r); continue; }
    const scanConfidence = Math.min(...covered.map(s => s.confidence));
    // The line reading joins pieces the whole poster split ("NO-" + "OS" → "NO-COST"), or is simply surer.
    const better = covered.length > 1 ? r.confidence >= scanConfidence - 0.05 : r.confidence >= covered[0].confidence - 0.03 && alnum(r.text) >= alnum(covered[0].text) - 1;
    if (better) { out.push(r); covered.forEach(s => usedScan.add(s)); }
  }
  for (const s of scanWords) if (!usedScan.has(s) && !out.some(o => overlaps(o.box, s.box))) out.push(s);
  return out.sort((a, b) => a.box.x - b.box.x);
}

export interface MasterAnalysisInput {
  template: Pick<ProtectedTemplate, 'id' | 'source'>;
  source: Rgba; scan: PosterScan; recognizer: WordRecognizer;
  previous?: TextAnalysis;
  /** Stores a logo slot's exact crop. */
  store: (file: string, png: Buffer) => void;
  at: string;
}
export interface MasterAnalysisResult { analysis: TextAnalysis; elements: ProtectedElement[]; written: string[]; ignored: number }

export async function buildMasterAnalysis(input: MasterAnalysisInput): Promise<MasterAnalysisResult> {
  const { source, scan, recognizer, previous, at } = input, size = { width: source.width, height: source.height };
  const elements: ProtectedElement[] = [], groups: WordGroup[] = [], words: DetectedWord[] = [], plates: TextPlate[] = [], logoSlots: LogoSlot[] = [], written: string[] = [];
  const prior = previous?.words ?? [], usedPrior = new Set<string>();
  const keepId = (prefix: 'pw' | 'pl', box: SourceBox, pool: { id: string; box: SourceBox }[]) => {
    const old = pool.find(p => !usedPrior.has(p.id) && boxIoU(p.box, box) >= 0.5);
    if (old) { usedPrior.add(old.id); return old.id; }
    return hexId(prefix);
  };
  let ignored = scan.dropped.length;
  const posterMax = Math.max(1, ...scan.blocks.flatMap(b => b.lines.flatMap(l => l.words.map(w => w.box.height))));
  const element = (kind: ProtectedElement['kind'], label: string, box: PixelBox, note: string): ProtectedElement => {
    const b: SourceBox = { ...box, rotation: 0 };
    const e: ProtectedElement = { id: hexId('pe'), kind, label: label.slice(0, 120) || 'Element', box: b, normalized: normalizeBox(b, size), zIndex: elements.length, representation: 'raster',
      mask: { mode: 'difference', threshold: 24 }, locked: false, replaceable: true, origin: 'auto-scan', note, review: { status: 'approved', at } };
    elements.push(e);
    return e;
  };

  for (const block of scan.blocks) {
    const groupId = hexId('pg'), group: WordGroup = { id: groupId, elementId: '', label: '', lines: [], align: 'left' };
    const blockWords: DetectedWord[] = [];
    // Each line read again and reconciled; then lines of one size and slant share one font (a phrase set in one face).
    const read: { line: ScanLine; words: Reading[]; italic: boolean; height: number }[] = [];
    for (const line of block.lines) {
      const reread = await rereadLine(source, recognizer, line);
      const scanReadings: Reading[] = line.words.map(w => ({ text: w.text, confidence: w.confidence, box: w.box, mode: `poster ${w.mode}` }));
      const merged = reconcile(scanReadings, reread, line.box);
      ignored += Math.max(0, reread.length + scanReadings.length - merged.length);
      if (!merged.length) continue;
      read.push({ line, words: merged, italic: merged.some(w => w.box.height >= 10 && measureWord(source, w.box, w.text).italic), height: median(merged.map(w => w.box.height)) });
    }
    const runs: (typeof read)[] = [];
    for (const r of read) {
      const last = runs[runs.length - 1]?.[0];
      if (last && last.italic === r.italic && Math.max(last.height, r.height) / Math.max(1, Math.min(last.height, r.height)) <= 1.25 && colourDistance(last.line.words[0].ink, r.line.words[0].ink) <= 30) runs[runs.length - 1].push(r); else runs.push([r]);
    }
    for (const run of runs) {
      const all = run.flatMap(r => r.words), font = await matchLineFont(source, all.map(w => ({ text: w.text, box: w.box })), run[0].line.words[0].ink, { italicHint: run[0].italic });
      let k = 0;
      for (const { line, words: merged } of run) {
        const lineRow = { id: hexId('pn'), wordIds: [] as string[] };
        for (const r of merged) {
          const m = measureWord(source, r.box, r.text), place = font?.words[k++];
          const style: WordStyle = {
            fontFamily: font?.family ?? 'Inter', fontMatch: 'estimated', fontSize: place?.fontSize ?? m.fontSize, fontWeight: font?.weight ?? m.fontWeight, fontStyle: font?.style ?? 'normal',
            color: m.color, opacity: 1, lineHeight: 1.2, letterSpacing: place?.letterSpacing ?? 0, baseline: place?.baseline ?? m.baseline, align: 'left', ...(place ? { originDx: place.originDx } : {}),
          };
          const box: SourceBox = { ...r.box, rotation: m.rotation }, role = guessWordRole(r.text, block.kind === 'legal' ? 'legal' : 'text');
          const word: DetectedWord = {
            id: keepId('pw', box, prior), text: r.text, recognized: { text: r.text, confidence: round(r.confidence, 2), mode: r.mode }, box, normalized: normalizeBox(box, size),
            elementId: '', groupId, lineId: lineRow.id, order: 0, style, confidence: round(r.confidence, 2), styleConfidence: round(Math.min(1, Math.max(0.1, (font?.score ?? 0) + 0.5)) * m.confidence, 2),
            role, review: { status: 'needs-review' }, locked: false, protected: PROTECTED_ROLES.includes(role) || block.kind === 'legal', origin: 'ocr',
          };
          blockWords.push(word); lineRow.wordIds.push(word.id);
        }
        group.lines.push(lineRow);
        if (line.plate) {
          const p = line.plate, b: SourceBox = { ...p.box, rotation: 0 };
          plates.push({ id: hexId('pp'), groupId, box: b, normalized: normalizeBox(b, size), fill: p.fill, stroke: p.stroke, radius: p.radius, confidence: p.confidence, review: { status: 'needs-review' } });
        }
      }
    }
    if (!blockWords.length) continue;
    // Line spacing: from one line's baseline to the next, in font sizes (the last line keeps the one above's).
    const baselineOf = (lineId: string) => median(blockWords.filter(w => w.lineId === lineId).map(w => w.box.y + w.style.baseline));
    group.lines.forEach((l, i) => {
      const next = group.lines[i + 1], size0 = median(blockWords.filter(w => w.lineId === l.id).map(w => w.style.fontSize));
      const lh = next ? Math.max(0.6, Math.min(3, (baselineOf(next.id) - baselineOf(l.id)) / Math.max(1, size0))) : undefined;
      if (lh) for (const w of blockWords) if (w.lineId === l.id) w.style = { ...w.style, lineHeight: round(lh, 2) };
    });
    const text = group.lines.map(l => l.wordIds.map(id => blockWords.find(w => w.id === id)!.text).join(' ')).join(' ');
    const lefts = group.lines.map(l => Math.min(...blockWords.filter(w => w.lineId === l.id).map(w => w.box.x))), rights = group.lines.map(l => Math.max(...blockWords.filter(w => w.lineId === l.id).map(w => w.box.x + w.box.width)));
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v), width = Math.max(...rights) - Math.min(...lefts);
    group.align = group.lines.length < 2 ? 'left' : spread(lefts) <= 0.06 * width ? 'left' : spread(lefts.map((l, i) => (l + rights[i]) / 2)) <= 0.06 * width ? 'center' : spread(rights) <= 0.06 * width ? 'right' : 'left';
    for (const w of blockWords) w.style = { ...w.style, align: group.align };
    const plate = plates.find(p => p.groupId === groupId);
    group.category = guessTextCategory(text, { maxWordHeight: Math.max(...blockWords.map(w => w.box.height)), posterMaxWordHeight: posterMax, hasPlate: !!plate, legalRegion: block.kind === 'legal' });
    group.label = text.slice(0, 80);
    const region = element(block.kind === 'legal' ? 'legal' : 'text', text, padBox(unionBoxes([...blockWords.map(w => w.box), ...(plate ? [plate.box] : [])]), 6, size), `scan:${group.category}`);
    group.elementId = region.id;
    for (const w of blockWords) w.elementId = region.id;
    groups.push(group); words.push(...blockWords);
  }

  // Logo slots: the source's exact pixels of each, stored once per content.
  const priorSlots = previous?.logoSlots ?? [];
  const cut = async (box: PixelBox) => {
    const rect = { x: Math.max(0, Math.floor(box.x)), y: Math.max(0, Math.floor(box.y)), width: 0, height: 0 };
    rect.width = Math.min(size.width, Math.ceil(box.x + box.width)) - rect.x; rect.height = Math.min(size.height, Math.ceil(box.y + box.height)) - rect.y;
    const png = await sharp(source.data, { raw: { width: source.width, height: source.height, channels: 4 } }).extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height }).png({ compressionLevel: 9 }).toBuffer();
    return { png, rect };
  };
  const addSlot = async (box: PixelBox, label: string, category: MasterCategory, elementId: string, detection: LogoSlot['detection'], confidence: number) => {
    const b: SourceBox = { ...box, rotation: 0 }, id = keepId('pl', b, priorSlots), { png, rect } = await cut(box), hash = sha256(png), file = `logo-${id}-${hash.slice(0, 12)}.png`;
    input.store(file, png); written.push(file);
    const original: ProtectedAssetRef & { placement: typeof rect } = { file, sha256: hash, mime: 'image/png', width: rect.width, height: rect.height, bytes: png.length, hasAlpha: true, placement: rect };
    const old = priorSlots.find(s => s.id === id);
    logoSlots.push({ id, label: label.slice(0, 80), elementId, box: b, normalized: normalizeBox(b, size), original, ...(old?.replacement ? { replacement: old.replacement } : {}), detection, confidence, order: logoSlots.length,
      locked: false, replaceable: true, review: { status: 'needs-review' }, category });
  };
  for (const g of scan.graphics.filter(x => x.kind === 'brand-logo')) {
    const e = element('logo', `Brand logo: ${g.text ?? ''}`, padBox(g.box, 4, size), 'scan:brand-logo');
    await addSlot(g.box, g.text ? `${g.text.split(/\s+/).slice(0, 3).join(' ')} logo` : 'Brand logo', 'brand-logo', e.id, 'element', g.confidence);
  }
  if (scan.tiles.length) {
    const e = element('logo', `Logo cards (${scan.tiles.length})`, padBox(unionBoxes(scan.tiles), 4, size), 'scan:partner-logo');
    for (const [i, t] of scan.tiles.entries()) await addSlot(t, `Logo ${i + 1}`, 'partner-logo', e.id, 'tile-grid', 0.7);
  }
  for (const [i, g] of scan.graphics.filter(x => x.kind === 'qr').entries()) {
    const e = element('logo', 'QR code', padBox(g.box, 4, size), 'scan:qr');
    await addSlot(g.box, scan.graphics.filter(x => x.kind === 'qr').length > 1 ? `QR code ${i + 1}` : 'QR code', 'qr', e.id, 'element', g.confidence);
  }
  for (const [i, g] of scan.graphics.filter(x => x.kind === 'badge').entries()) {
    const e = element('logo', 'Badge', padBox(g.box, 4, size), 'scan:badge');
    await addSlot(g.box, `Badge${i ? ` ${i + 1}` : ''}`, 'badge', e.id, 'element', g.confidence);
  }

  // One colour per family of near-identical measured colours (each word is measured on its own pixels, so one teal comes
  // out as #03595a, #035959, #025858…): the median of the family, so a creative changes "the teal" in one step.
  const families: { members: DetectedWord[]; rgb: number[] }[] = [];
  const rgbOf = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  for (const w of words) {
    const c = rgbOf(w.style.color), f = families.find(x => Math.max(...x.rgb.map((v, i) => Math.abs(v - c[i]))) <= 18);
    if (f) f.members.push(w); else families.push({ members: [w], rgb: c });
  }
  for (const f of families) {
    const med = [0, 1, 2].map(i => median(f.members.map(w => rgbOf(w.style.color)[i])));
    const colour = `#${med.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    for (const w of f.members) w.style = { ...w.style, color: colour };
  }
  const ordered = readingOrder(words, groups);
  const analysis: TextAnalysis = {
    version: WORD_ANALYSIS_VERSION, revision: (previous?.revision ?? 0) + 1, analyzedAt: at, updatedAt: at,
    engine: { ...recognizer.engine, local: true }, basis: { sourceSha256: input.template.source.sha256, regionsKey: regionsKey(elements) },
    words: ordered, groups, logoSlots, plates,
    history: withHistory(previous?.history ?? [], { at, action: 'analysed', detail: `${recognizer.engine.name}: ${ordered.length} word(s) in ${groups.length} group(s), ${logoSlots.length} logo slot(s), ${plates.length} plate(s); ${ignored} reading(s) left out as decoration, logo lettering or noise.` }),
  };
  return { analysis, elements, written, ignored };
}
