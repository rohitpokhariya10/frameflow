/**
 * The words and logo slots of a protected template, from its source pixels and its confirmed regions:
 *
 *   logo regions      one image slot each, or one per tile when the region is a grid of logo cards
 *   other regions     logo-card grids first (their tiles become slots and their text is the logos' own), then the words
 *                     the recognizer reads in the region, each measured from its own pixels
 *   lines, phrases    words on one baseline form a line; lines close below each other in one region form a phrase
 *   re-analysis       a word or slot found again keeps its id, and everything an administrator corrected or reviewed
 *
 * Every word and slot starts as needs-review. Logo slots keep the source's exact pixels (never resampled).
 */
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import {
  boundingBox, boxIoU, catalogFont, estimateTextWidth, guessWordRole, insideShare, normalizeBox, pixelBounds, PROTECTED_ROLES, readingOrder, regionsKey, WORD_ANALYSIS_VERSION, WORD_LIMITS, withHistory,
  type AnalysisEvent, type DetectedWord, type LogoSlot, type ProtectedAssetRef, type ProtectedElement, type ProtectedTemplate, type SourceBox, type TextAnalysis, type WordGroup, type WordStyle,
} from '@frameflow/shared';
import { sha256, type Rgba } from '../decomposition/protectedTemplates/pixels.js';
import { detectLogoTiles, inkBounds, measureWord } from './measure.js';
import type { RecognizedWord, WordRecognizer } from './recognizer.js';

const hexId = (prefix: string) => `${prefix}-${randomBytes(5).toString('hex')}`;
const round = (v: number) => Math.round(v * 100) / 100;

/** What the region's description says about a word's type ("italic serif “Easy,”"): hints, never certainties. */
export function labelHints(label: string, word: string): { italic: boolean; serif: boolean; sans: boolean; bold: boolean; script: boolean; condensed: boolean } {
  const lower = label.toLowerCase(), key = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const none = { italic: false, serif: false, sans: false, bold: false, script: false, condensed: false };
  if (key.length < 2) return none;
  const at = lower.search(new RegExp(`[“"']?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  if (at < 0) return none;
  // The words just before it, up to the previous quote or comma-separated clause.
  const before = lower.slice(Math.max(0, at - 48), at).split(/[”"]|,\s(?=[a-z]+\s[“"])/).pop() ?? '';
  return { italic: /italic|oblique/.test(before), serif: /(^|[^-\w])serif/.test(before) && !/sans[- ]?serif/.test(before), sans: /sans/.test(before), bold: /bold|heavy|black/.test(before), script: /script|handwrit|brush|cursive/.test(before), condensed: /condensed|narrow/.test(before) };
}
/**
 * The closest family the editor has, from what was measured and hinted: serif or sans, italic, condensed or wide letters.
 * Only families of the catalogue (always open-licensed Google fonts) are chosen.
 */
export function closestFont(h: { serif: boolean; italic: boolean; script: boolean; condensed: boolean; widthRatio: number }): string {
  const pick = (...families: string[]) => families.find(f => catalogFont(f)) ?? 'Inter';
  if (h.script) return pick('Pacifico', 'Lobster');
  if (h.serif) return h.italic ? pick('Fraunces', 'Playfair Display') : pick('Lora', 'Playfair Display');
  if (h.condensed || h.widthRatio < 0.78) return pick('Barlow Condensed', 'Oswald');
  if (h.widthRatio > 1.15) return pick('Poppins', 'Montserrat');
  return pick('Inter');
}

interface Candidate { word: RecognizedWord; box: SourceBox; element: ProtectedElement; style: WordStyle; styleConfidence: number; baselineY: number }
const lineOf = (c: Candidate) => ({ top: c.box.y, bottom: c.box.y + c.box.height, baseline: c.baselineY, size: c.style.fontSize });

/** Words on one baseline, left to right; lines top to bottom. */
function lines(cands: Candidate[]): Candidate[][] {
  const out: Candidate[][] = [];
  for (const c of [...cands].sort((a, b) => a.baselineY - b.baselineY)) {
    const l = lineOf(c);
    const line = out.find(row => {
      const r = row.map(lineOf), base = r.reduce((s, x) => s + x.baseline, 0) / r.length, size = Math.min(...r.map(x => x.size), l.size);
      const top = Math.min(...r.map(x => x.top)), bottom = Math.max(...r.map(x => x.bottom));
      const overlap = Math.min(bottom, l.bottom) - Math.max(top, l.top);
      return Math.abs(base - l.baseline) <= 0.35 * size && overlap >= 0.4 * Math.min(bottom - top, l.bottom - l.top);
    });
    if (line) line.push(c); else out.push([c]);
  }
  for (const row of out) row.sort((a, b) => a.box.x - b.box.x);
  return out.sort((a, b) => Math.min(...a.map(c => c.box.y)) - Math.min(...b.map(c => c.box.y)));
}
/** Lines close below each other (and side by side) form one phrase. */
function phrases(rows: Candidate[][]): Candidate[][][] {
  const out: Candidate[][][] = [];
  const extent = (row: Candidate[]) => ({ left: Math.min(...row.map(c => c.box.x)), right: Math.max(...row.map(c => c.box.x + c.box.width)), top: Math.min(...row.map(c => c.box.y)), bottom: Math.max(...row.map(c => c.box.y + c.box.height)), size: Math.max(...row.map(c => c.style.fontSize)) });
  for (const row of rows) {
    const e = extent(row), last = out[out.length - 1], prev = last ? extent(last[last.length - 1]) : undefined;
    const gap = prev ? e.top - prev.bottom : Infinity, overlaps = prev ? Math.min(e.right, prev.right) - Math.max(e.left, prev.left) > 0 : false;
    if (last && prev && overlaps && gap <= 1.6 * Math.max(e.size, prev.size)) last.push(row); else out.push([row]);
  }
  return out;
}
function alignmentOf(rows: Candidate[][]): WordStyle['align'] {
  if (rows.length < 2) return 'left';
  const ext = rows.map(row => ({ l: Math.min(...row.map(c => c.box.x)), r: Math.max(...row.map(c => c.box.x + c.box.width)) }));
  const spread = (v: number[]) => Math.max(...v) - Math.min(...v), width = Math.max(...ext.map(e => e.r)) - Math.min(...ext.map(e => e.l));
  const s = { left: spread(ext.map(e => e.l)), center: spread(ext.map(e => (e.l + e.r) / 2)), right: spread(ext.map(e => e.r)) };
  const best = (Object.entries(s) as [WordStyle['align'], number][]).sort((a, b) => a[1] - b[1])[0];
  return best[1] <= 0.08 * width ? best[0] : 'left';
}

export interface AnalyseInput {
  template: ProtectedTemplate;
  /** The source's pixels (EXIF orientation applied). */
  source: Rgba;
  recognizer: WordRecognizer;
  previous?: TextAnalysis;
  /** Stores a logo slot's exact crop and returns its record. */
  store: (file: string, png: Buffer) => void;
  at?: string;
}
export interface AnalyseResult { analysis: TextAnalysis; written: string[]; dropped: number; regions: { elementId: string; words: number; logos: number }[] }

export async function analyseTemplateText(input: AnalyseInput): Promise<AnalyseResult> {
  const { template: t, source, recognizer, previous } = input, at = input.at ?? new Date().toISOString(), size = { width: t.source.width, height: t.source.height };
  const elements = [...t.elements].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const candidates: Candidate[] = [], tiles: { element: ProtectedElement; box: SourceBox; detection: LogoSlot['detection']; confidence: number }[] = [], written: string[] = [];
  const regions: AnalyseResult['regions'] = [];
  let dropped = 0;
  for (const element of elements) {
    const rect = pixelBounds(element.box, size);
    if (!rect) continue;
    const grid = detectLogoTiles(source, rect).map(tile => ({ x: tile.x, y: tile.y, width: tile.width, height: tile.height, rotation: 0 }));
    if (element.kind === 'logo') {
      if (grid.length >= 2) for (const box of grid) tiles.push({ element, box, detection: 'tile-grid', confidence: 0.7 });
      else tiles.push({ element, box: { ...element.box }, detection: 'element', confidence: 1 });
      regions.push({ elementId: element.id, words: 0, logos: Math.max(1, grid.length) });
      continue;
    }
    for (const box of grid) tiles.push({ element, box, detection: 'tile-grid', confidence: 0.7 });
    const crop = await sharp(source.data, { raw: { width: source.width, height: source.height, channels: 4 } }).extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height }).png().toBuffer();
    const read = await recognizer.recognize({ image: crop, region: rect, purpose: 'template' });
    let kept = 0;
    const engineBoxes = read.map(word => ({ x: rect.x + word.box.x0, y: rect.y + word.box.y0, width: word.box.x1 - word.box.x0, height: word.box.y1 - word.box.y0 }));
    for (const [k, word] of read.entries()) {
      const own = engineBoxes[k], smaller = engineBoxes.filter((b, j) => j !== k && b.width * b.height < own.width * own.height);
      const box: SourceBox = { ...inkBounds(source, own, smaller), rotation: 0 };
      // Text on a logo card is the logo's own; a reading mostly outside the region belongs to something else.
      if (box.width < WORD_LIMITS.minBoxPx || box.height < WORD_LIMITS.minBoxPx || grid.some(g => insideShare(box, g) > 0.5) || insideShare(box, element.box) < 0.5) { dropped++; continue; }
      const baselineLine = word.baseline ? { x0: rect.x + word.baseline.x0, y0: rect.y + word.baseline.y0, x1: rect.x + word.baseline.x1, y1: rect.y + word.baseline.y1 } : undefined;
      const m = measureWord(source, box, word.text, baselineLine), hints = labelHints(element.label, word.text);
      const inter = estimateTextWidth(word.text, { fontFamily: 'Inter', fontSize: m.fontSize, fontWeight: m.fontWeight, fontStyle: 'normal', letterSpacing: 0 });
      const italic = m.italic || hints.italic;
      const family = closestFont({ serif: hints.serif, italic, script: hints.script, condensed: hints.condensed, widthRatio: inter > 0 ? box.width / inter : 1 });
      const weight: 400 | 600 | 700 = hints.bold ? 700 : m.fontWeight;
      const style: WordStyle = { fontFamily: family, fontMatch: 'estimated', fontSize: m.fontSize, fontWeight: weight, fontStyle: italic && catalogFont(family)?.italic ? 'italic' : 'normal', color: m.color, opacity: 1,
        lineHeight: 1.2, letterSpacing: 0, baseline: m.baseline, align: 'left' };
      candidates.push({ word, box: { ...box, rotation: m.rotation }, element, style, styleConfidence: round(m.confidence * 0.8), baselineY: box.y + m.baseline });
      kept++;
    }
    regions.push({ elementId: element.id, words: kept, logos: grid.length });
  }

  // Lines and phrases per region; line height from the next line's baseline.
  const groups: WordGroup[] = [], words: DetectedWord[] = [];
  const prior = previous?.words ?? [], used = new Set<string>();
  const match = (c: Candidate) => prior.find(p => !used.has(p.id) && p.elementId === c.element.id && boxIoU(p.box, c.box) >= 0.5);
  for (const element of elements) {
    const rows = lines(candidates.filter(c => c.element.id === element.id));
    for (const phrase of phrases(rows)) {
      const groupId = hexId('pg'), align = alignmentOf(phrase), group: WordGroup = { id: groupId, elementId: element.id, label: '', lines: [], align };
      // Line height from the next line's baseline; the last line takes the one above's (a single line: 1.2).
      const baseOf = (row: Candidate[]) => row.reduce((s, c) => s + c.baselineY, 0) / row.length;
      const heights = phrase.map((row, i) => {
        const size = row.map(c => c.style.fontSize).sort((a, b) => a - b)[Math.floor(row.length / 2)];
        return phrase[i + 1] ? Math.max(0.6, Math.min(3, (baseOf(phrase[i + 1]) - baseOf(row)) / size)) : undefined;
      });
      phrase.forEach((row, i) => {
        const lineHeight = heights[i] ?? heights[i - 1] ?? 1.2;
        // Words of one line set at one size are almost always one style: measured word by word, made consistent here.
        const sizes = row.map(c => c.style.fontSize);
        if (row.length > 1 && Math.max(...sizes) / Math.min(...sizes) <= 1.15) {
          const mid = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
          const count = (v: string[]) => v.sort((a, b) => v.filter(x => x === b).length - v.filter(x => x === a).length)[0];
          const size = mid(sizes), weight = mid(row.map(c => c.style.fontWeight)) as 400 | 600 | 700, family = count(row.map(c => c.style.fontFamily));
          for (const c of row) c.style = { ...c.style, fontSize: size, fontWeight: weight, fontFamily: family, fontStyle: c.style.fontStyle === 'italic' && catalogFont(family)?.italic ? 'italic' : 'normal' };
        }
        const line = { id: hexId('pn'), wordIds: [] as string[] };
        for (const c of row) {
          const old = match(c), role = guessWordRole(c.word.text, element.kind);
          if (old) used.add(old.id);
          const reviewed = old && (old.review.status !== 'needs-review' || old.text !== old.recognized.text || old.style.fontMatch === 'admin');
          const style: WordStyle = reviewed ? old!.style : { ...c.style, align, lineHeight: round(lineHeight) };
          const word: DetectedWord = {
            id: old?.id ?? hexId('pw'), text: reviewed ? old!.text : c.word.text, recognized: { text: c.word.text, confidence: round(c.word.confidence), mode: c.word.mode },
            box: reviewed ? old!.box : c.box, normalized: normalizeBox(reviewed ? old!.box : c.box, size),
            elementId: element.id, groupId, lineId: line.id, order: 0, style, confidence: round(c.word.confidence), styleConfidence: c.styleConfidence,
            role: reviewed ? old!.role : role, review: reviewed ? old!.review : { status: 'needs-review' },
            locked: old?.locked ?? element.locked, protected: reviewed ? old!.protected : PROTECTED_ROLES.includes(role) || element.kind === 'legal', origin: 'ocr',
          };
          words.push(word); line.wordIds.push(word.id);
        }
        group.lines.push(line);
      });
      group.label = phrase.flat().map(c => c.word.text).join(' ').slice(0, 60);
      groups.push(group);
    }
  }
  // Words an administrator added by hand are kept as they are (no engine reading can replace them).
  for (const p of prior.filter(w => w.origin === 'admin' && t.elements.some(e => e.id === w.elementId))) {
    const group = groups.find(g => g.elementId === p.elementId) ?? (() => { const g: WordGroup = { id: hexId('pg'), elementId: p.elementId, label: p.text, lines: [], align: p.style.align }; groups.push(g); return g; })();
    const line = { id: hexId('pn'), wordIds: [p.id] };
    group.lines.push(line);
    words.push({ ...p, groupId: group.id, lineId: line.id });
  }

  // Logo slots: the exact source pixels of each, stored once per content.
  const priorSlots = previous?.logoSlots ?? [], usedSlots = new Set<string>(), logoSlots: LogoSlot[] = [], perRegion = new Map<string, number>();
  for (const tile of tiles) {
    const n = (perRegion.get(tile.element.id) ?? 0) + 1;
    perRegion.set(tile.element.id, n);
    const old = priorSlots.find(s => !usedSlots.has(s.id) && s.elementId === tile.element.id && boxIoU(s.box, tile.box) >= 0.5);
    if (old) usedSlots.add(old.id);
    const box = old?.detection === 'admin' ? old.box : tile.box, rect = pixelBounds(box, size);
    if (!rect) continue;
    const png = await sharp(source.data, { raw: { width: source.width, height: source.height, channels: 4 } }).extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height }).png({ compressionLevel: 9 }).toBuffer();
    const id = old?.id ?? hexId('pl'), hash = sha256(png), file = `logo-${id}-${hash.slice(0, 12)}.png`;
    input.store(file, png); written.push(file);
    const original: ProtectedAssetRef & { placement: typeof rect } = { file, sha256: hash, mime: 'image/png', width: rect.width, height: rect.height, bytes: png.length, hasAlpha: true, placement: rect };
    logoSlots.push({ id, label: old?.label ?? (tile.detection === 'tile-grid' ? `${tile.element.label.split(/[.:]/)[0].slice(0, 40)} · logo ${n}` : tile.element.label.slice(0, 80)), elementId: tile.element.id, box, normalized: normalizeBox(box, size),
      original, ...(old?.replacement ? { replacement: old.replacement } : {}), detection: old?.detection ?? tile.detection, confidence: tile.confidence, order: logoSlots.length,
      locked: old?.locked ?? true, replaceable: old?.replaceable ?? tile.element.replaceable, review: old?.review ?? { status: 'needs-review' } });
  }
  for (const s of priorSlots.filter(s => s.detection === 'admin' && !usedSlots.has(s.id) && t.elements.some(e => e.id === s.elementId))) logoSlots.push({ ...s, order: logoSlots.length });

  const ordered = readingOrder(words, groups);
  const event: AnalysisEvent = { at, action: 'analysed', detail: `${recognizer.engine.name} ${recognizer.engine.version}: ${ordered.length} word(s) in ${groups.length} phrase(s), ${logoSlots.length} logo slot(s); ${dropped} reading(s) left out (on a logo card or outside the region).` };
  return {
    analysis: {
      version: WORD_ANALYSIS_VERSION, revision: (previous?.revision ?? 0) + 1, analyzedAt: at, updatedAt: at,
      engine: { ...recognizer.engine, local: true }, basis: { sourceSha256: t.source.sha256, regionsKey: regionsKey(t.elements) },
      words: ordered, groups, logoSlots, history: withHistory(previous?.history ?? [], event),
    },
    written, dropped, regions,
  };
}

/** The words' and slots' outer bounds, for a preview. */
export const analysisBounds = (a: TextAnalysis) => [...a.words.map(w => boundingBox(w.box)), ...a.logoSlots.map(l => boundingBox(l.box))];
