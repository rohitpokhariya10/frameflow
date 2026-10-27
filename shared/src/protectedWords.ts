/**
 * Word-level text and logo slots of a protected template (protectedContent.ts): every word the local recognizer found
 * inside the protected regions, with its own box and measured style, and every logo as its own replaceable image slot.
 *
 * WHERE THE WORDS COME FROM: a local OCR engine (tesseract.js, on the server, no network, no AI provider) reads each
 * protected region separately. A word's box is the engine's own box for that word; a box is never made by splitting a
 * larger one. Style (size, weight, italic, colour, baseline, rotation) is measured from the source pixels inside the box
 * and the font is the closest family the editor has: every value is an estimate until an administrator approves it.
 *
 * COORDINATES: source pixels, as everywhere in a protected template. These boxes are the ORIGINAL coordinates and are
 * only ever changed by an administrator correcting a recognition; a style variation keeps its own, separate variant
 * boxes (styleVariations.ts) and never writes these.
 *
 * Nothing here calls a provider.
 */
import { boundingBox, normalizeBox, onCanvasShare, type NormalizedBox, type ProtectedAssetRef, type SourceBox, type SourceSize } from './protectedContent.js';
import { isCatalogFont } from './fonts/catalog.js';
import type { MasterCategory, TextPlate } from './masterTemplates.js';

export const WORD_ANALYSIS_VERSION = 1;
export const WORD_LIMITS = { maxWords: 400, maxLogoSlots: 60, maxWordChars: 80, maxHistory: 500, minBoxPx: 2 } as const;
/** Below this recognition confidence (0..1) a word is shown as uncertain. */
export const LOW_WORD_CONFIDENCE = 0.75;

export interface WordStyle {
  /** The closest family the editor has (always a catalogue font); `fontMatch` says whether it was estimated or chosen. */
  fontFamily: string; fontMatch: 'estimated' | 'admin';
  /** Source pixels (the em size, estimated from the height of the word's ink and its letters). */
  fontSize: number;
  fontWeight: 400 | 600 | 700; fontStyle: 'normal' | 'italic';
  color: string;
  /** 0..1. */
  opacity: number;
  /** A multiple of the font size: the distance between this word's line and the next of its group. */
  lineHeight: number;
  /** Source pixels between letters. */
  letterSpacing: number;
  /** Source pixels from the top of the word's box down to its baseline. */
  baseline: number;
  align: 'left' | 'center' | 'right';
  /**
   * Source pixels from the box's left edge to where the text starts (its first letter's advance), measured with the
   * matched font file: the box hugs the ink, the text is drawn from its origin. Absent: the box's left edge.
   */
  originDx?: number;
}
export type WordRole = 'copy' | 'claim' | 'duration' | 'partner' | 'legal';
export const WORD_ROLE_LABELS: Record<WordRole, string> = { copy: 'Copy', claim: 'Offer claim', duration: 'Duration / tenure', partner: 'Partner name', legal: 'Legal' };
export type WordReviewStatus = 'needs-review' | 'approved' | 'rejected';
export interface DetectedWord {
  /** Product templates: immutable source evidence, independent of edits. */
  source?: { box: SourceBox; crop: string; z: number };
  /** Stable for the template's life: re-analysis keeps it for the same word, the editor's text slot refers to it. */
  id: string;
  /** The word exactly as it appears, after any correction by an administrator. */
  text: string;
  /** What the recognizer read, kept unchanged as the evidence for the correction. */
  recognized: { text: string; confidence: number; mode: string };
  /** ORIGINAL source coordinates (box and rotation about its centre), and the same box as fractions of the source. */
  box: SourceBox; normalized: NormalizedBox;
  /** The protected region it lies in, its phrase (group) and line, and its place in the reading order of the template. */
  elementId: string; groupId: string; lineId: string; order: number;
  style: WordStyle;
  /** 0..1: the recognizer's confidence in the text, and how far the measured style can be trusted. */
  confidence: number; styleConfidence: number;
  role: WordRole;
  review: { status: WordReviewStatus; at?: string };
  /** locked: not movable in the editor until unlocked. protected: claims, durations, partner names and legal text, which
   * a style variation or a typography suggestion never rewrites; only an administrator does. */
  locked: boolean; protected: boolean;
  origin: 'ocr' | 'ai' | 'admin';
  /**
   * Product templates: what an administrator corrected on this word in the review (or that they added it). Kept when
   * detection runs again: a corrected word wins over a newly detected one at its place.
   */
  corrected?: { at: string; text?: boolean; box?: boolean; group?: boolean; removed?: boolean; added?: boolean };
}
export interface WordLine { id: string; wordIds: string[] }
export interface WordGroup {
  id: string; elementId: string; label: string;
  /** Top to bottom; each line's words left to right. */
  lines: WordLine[];
  align: WordStyle['align'];
  /** Master templates (masterTemplates.ts): where the content panel lists it. Absent on other templates. */
  category?: MasterCategory;
}
export interface LogoSlot {
  id: string; label: string; elementId: string;
  /** ORIGINAL source coordinates. */
  box: SourceBox; normalized: NormalizedBox;
  /** The source's own pixels inside the box, byte for byte (never resampled). */
  original: ProtectedAssetRef & { placement: { x: number; y: number; width: number; height: number } };
  /** An uploaded file shown instead of the original (a bank's own logo PNG), byte for byte. */
  replacement?: ProtectedAssetRef;
  /** element: a logo region as a whole; tile-grid: one tile of a grid of logos found in a region; admin: drawn by hand. */
  detection: 'element' | 'tile-grid' | 'admin';
  confidence: number; order: number;
  locked: boolean; replaceable: boolean;
  review: { status: WordReviewStatus; at?: string };
  /** Product templates: corrected (moved, recategorised, replaced) or added by an administrator in the review; kept when detection runs again. */
  corrected?: { at: string };
  /** Master templates: what the slot is (brand logo, bank logo, QR code, badge, other graphic). */
  category?: MasterCategory;
  /** Product templates: a brand logo or graphic the person chose to keep as part of the picture (no layer of its own, not
   * taken out of it). Bank and payment logos and QR codes are always their own layers. */
  inBackground?: boolean;
}
export type AnalysisAction = 'analysed' | 'corrected' | 'approved' | 'rejected' | 'reopened' | 'added' | 'removed' | 'locked' | 'unlocked' | 'logo-replaced' | 'logo-restored' | 'regrouped';
export interface AnalysisEvent { at: string; action: AnalysisAction; targetId?: string; detail?: string }
export interface TextAnalysis {
  /** Product-only provider exclusions, including lettering physically printed on objects. */
  sourceExclusions?: SourceBox[];
  version: typeof WORD_ANALYSIS_VERSION;
  /** Bumped by every change: a variation records the revision its layout was made from. */
  revision: number;
  analyzedAt: string; updatedAt: string;
  /** The engine that read the words: always local. */
  engine: { name: string; version: string; model: string; modes: string[]; local: true };
  /** The source and the protected regions it was made for; other regions make it stale. */
  basis: { sourceSha256: string; regionsKey: string };
  words: DetectedWord[]; groups: WordGroup[]; logoSlots: LogoSlot[];
  /** Master templates: solid shapes behind lines of text (masterTemplates.ts TextPlate). */
  plates?: TextPlate[];
  /** Newest last, at most WORD_LIMITS.maxHistory. */
  history: AnalysisEvent[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------------------------------
const WORD_ID = /^pw-[a-f0-9]{10}$/, LOGO_ID = /^pl-[a-f0-9]{10}$/, GROUP_ID = /^pg-[a-f0-9]{10}$/, LINE_ID = /^pn-[a-f0-9]{10}$/;
export const validWordId = (id: unknown): id is string => typeof id === 'string' && WORD_ID.test(id);
export const validLogoSlotId = (id: unknown): id is string => typeof id === 'string' && LOGO_ID.test(id);
export const validWordGroupId = (id: unknown): id is string => typeof id === 'string' && GROUP_ID.test(id);
export const validWordLineId = (id: unknown): id is string => typeof id === 'string' && LINE_ID.test(id);

// ---------------------------------------------------------------------------------------------------------------------
// Geometry and order
// ---------------------------------------------------------------------------------------------------------------------
/** Intersection over union of the axis-aligned bounds of two boxes. */
export function boxIoU(a: SourceBox, b: SourceBox): number {
  const p = boundingBox(a), q = boundingBox(b);
  const w = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x), h = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (p.width * p.height + q.width * q.height - inter);
}
/** Share (0..1) of box a's bounds that lies inside box b's bounds. */
export function insideShare(a: SourceBox, b: SourceBox): number {
  const p = boundingBox(a), q = boundingBox(b);
  const w = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x), h = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y);
  return w > 0 && h > 0 ? (w * h) / Math.max(1e-9, p.width * p.height) : 0;
}
/** The baseline of a word in source pixels (y), from its box and style. */
export const wordBaselineY = (w: Pick<DetectedWord, 'box' | 'style'>) => w.box.y + w.style.baseline;
/**
 * Words of a group in reading order (lines top to bottom, words left to right), then groups in the order of their first
 * word: top to bottom, ties broken left to right. Returns the words with `order` renumbered from 0.
 */
export function readingOrder(words: DetectedWord[], groups: WordGroup[]): DetectedWord[] {
  const byId = new Map(words.map(w => [w.id, w]));
  const top = (g: WordGroup) => Math.min(...g.lines.flatMap(l => l.wordIds).map(id => byId.get(id)?.box.y ?? Infinity));
  const left = (g: WordGroup) => Math.min(...g.lines.flatMap(l => l.wordIds).map(id => byId.get(id)?.box.x ?? Infinity));
  const ordered = [...groups].sort((a, b) => top(a) - top(b) || left(a) - left(b));
  const out: DetectedWord[] = [], seen = new Set<string>();
  for (const g of ordered) for (const line of g.lines) for (const id of line.wordIds) {
    const w = byId.get(id);
    if (w && !seen.has(id)) { seen.add(id); out.push({ ...w, order: out.length }); }
  }
  for (const w of words) if (!seen.has(w.id)) out.push({ ...w, order: out.length });
  return out;
}
/** The words of a group, in reading order. */
export function wordsOfGroup(analysis: Pick<TextAnalysis, 'words' | 'groups'>, groupId: string): DetectedWord[] {
  const g = analysis.groups.find(x => x.id === groupId);
  if (!g) return [];
  const byId = new Map(analysis.words.map(w => [w.id, w]));
  return g.lines.flatMap(l => l.wordIds).map(id => byId.get(id)).filter((w): w is DetectedWord => !!w);
}
/** A group's text: its lines joined by line breaks, its words by spaces. */
export function groupText(analysis: Pick<TextAnalysis, 'words' | 'groups'>, groupId: string): string {
  const g = analysis.groups.find(x => x.id === groupId), byId = new Map(analysis.words.map(w => [w.id, w]));
  return g ? g.lines.map(l => l.wordIds.map(id => byId.get(id)?.text ?? '').filter(Boolean).join(' ')).join('\n') : '';
}

// ---------------------------------------------------------------------------------------------------------------------
// Roles: copy that must never be rewritten silently
// ---------------------------------------------------------------------------------------------------------------------
/**
 * A first guess at what a word is, from its text and its region: durations and tenures (numbers, "months", "EMI"
 * schedules), claims (prices, percentages, "free", "0%", "cashback"), legal (T&C lines, a legal region) and partner names
 * (words inside a logo region). The administrator can change it; a protected role is never rewritten by a variation.
 */
export function guessWordRole(text: string, regionKind: 'logo' | 'text' | 'legal' | 'other'): WordRole {
  const t = text.toLowerCase();
  if (regionKind === 'legal' || /^t&c|t&cs?|terms|conditions|apply\b|\*$/.test(t)) return 'legal';
  if (regionKind === 'logo') return 'partner';
  if (/\d/.test(t) && /(month|day|year|week|yr|mo\b|-)/.test(t)) return 'duration';
  if (/^(months?|days?|years?|weeks?)\.?$/.test(t)) return 'duration';
  if (/[%₹$€£]|\d/.test(t) || /^(free|cashback|off|save|no-cost|zero|instant|discount)/.test(t)) return 'claim';
  return 'copy';
}
export const PROTECTED_ROLES: readonly WordRole[] = ['claim', 'duration', 'partner', 'legal'];

// ---------------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------------
export interface WordProblem { severity: 'error' | 'warning'; code: string; message: string; targetId?: string }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const hex = (v: unknown) => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v);
export function wordStyleProblems(s: WordStyle | undefined): string[] {
  if (!s) return ['its style is missing.'];
  const out: string[] = [];
  if (!isCatalogFont(s.fontFamily)) out.push('choose a font the editor has.');
  if (!finite(s.fontSize) || s.fontSize < 1 || s.fontSize > 4096) out.push('font size must be 1–4096 source pixels.');
  if (![400, 600, 700].includes(s.fontWeight)) out.push('font weight must be 400, 600 or 700.');
  if (s.fontStyle !== 'normal' && s.fontStyle !== 'italic') out.push('style must be normal or italic.');
  if (!hex(s.color)) out.push('colour must be #RRGGBB.');
  if (!finite(s.opacity) || s.opacity < 0 || s.opacity > 1) out.push('opacity must be 0–1.');
  if (!finite(s.lineHeight) || s.lineHeight < 0.5 || s.lineHeight > 4) out.push('line height must be 0.5–4.');
  if (!finite(s.letterSpacing) || Math.abs(s.letterSpacing) > 200) out.push('letter spacing must be within ±200 source pixels.');
  if (!finite(s.baseline)) out.push('baseline must be a number.');
  if (!['left', 'center', 'right'].includes(s.align)) out.push('choose an alignment.');
  if (s.originDx !== undefined && !finite(s.originDx)) out.push('its text origin must be a number.');
  return out;
}
const boxValid = (b: SourceBox | undefined) => !!b && [b.x, b.y, b.width, b.height, b.rotation].every(finite) && b.width >= WORD_LIMITS.minBoxPx && b.height >= WORD_LIMITS.minBoxPx && Math.abs(b.rotation) <= 180;
/** Everything wrong with an analysis: errors block approving it, warnings are shown. */
export function analysisProblems(a: TextAnalysis, size: SourceSize, elements: { id: string; box: SourceBox; label: string }[]): WordProblem[] {
  const out: WordProblem[] = [], at = (severity: WordProblem['severity'], code: string, message: string, targetId?: string) => out.push({ severity, code, message, ...(targetId ? { targetId } : {}) });
  if (a.words.length > WORD_LIMITS.maxWords) at('error', 'TOO_MANY_WORDS', `At most ${WORD_LIMITS.maxWords} words.`);
  if (a.logoSlots.length > WORD_LIMITS.maxLogoSlots) at('error', 'TOO_MANY_LOGOS', `At most ${WORD_LIMITS.maxLogoSlots} logo slots.`);
  const ids = [...a.words.map(w => w.id), ...a.logoSlots.map(l => l.id)];
  if (new Set(ids).size !== ids.length) at('error', 'DUPLICATE_IDS', 'Word and logo ids must be unique.');
  const elementIds = new Set(elements.map(e => e.id)), groupIds = new Set(a.groups.map(g => g.id));
  for (const w of a.words) {
    const name = `“${w.text || w.recognized.text}”`;
    if (!validWordId(w.id)) at('error', 'INVALID_ID', `${name}: its id is not valid.`, w.id);
    if (typeof w.text !== 'string' || !w.text.trim() || w.text.length > WORD_LIMITS.maxWordChars || /\s/.test(w.text.trim())) at('error', 'INVALID_TEXT', `${name}: a word is one piece of text without spaces (up to ${WORD_LIMITS.maxWordChars} characters). Split a phrase into its words.`, w.id);
    if (!boxValid(w.box)) at('error', 'INVALID_GEOMETRY', `${name}: its box is not valid.`, w.id);
    else if (onCanvasShare(w.box, size) < 0.5) at('error', 'OFF_CANVAS', `${name}: it is mostly outside the image.`, w.id);
    for (const p of wordStyleProblems(w.style)) at('error', 'INVALID_STYLE', `${name}: ${p}`, w.id);
    if (!elementIds.has(w.elementId)) at('error', 'UNKNOWN_REGION', `${name}: its protected region no longer exists.`, w.id);
    if (!groupIds.has(w.groupId)) at('error', 'UNKNOWN_GROUP', `${name}: its phrase no longer exists.`, w.id);
    const region = elements.find(e => e.id === w.elementId);
    if (region && boxValid(w.box) && insideShare(w.box, region.box) < 0.6) at('warning', 'OUTSIDE_REGION', `${name}: most of it lies outside ${region.label}.`, w.id);
    if (w.review.status === 'needs-review') at('warning', 'NOT_REVIEWED', `${name}: not reviewed yet.`, w.id);
    if (w.confidence < LOW_WORD_CONFIDENCE && w.review.status !== 'approved') at('warning', 'LOW_CONFIDENCE', `${name}: read with ${Math.round(w.confidence * 100)}% confidence. Check the text.`, w.id);
  }
  for (const g of a.groups) {
    const members = g.lines.flatMap(l => l.wordIds);
    if (!validWordGroupId(g.id) || g.lines.some(l => !validWordLineId(l.id))) at('error', 'INVALID_GROUP', `${g.label}: its id is not valid.`, g.id);
    if (members.some(id => !a.words.some(w => w.id === id && w.groupId === g.id))) at('error', 'INVALID_GROUP', `${g.label}: it lists a word that is not in it.`, g.id);
  }
  for (const l of a.logoSlots) {
    if (!validLogoSlotId(l.id)) at('error', 'INVALID_ID', `${l.label}: its id is not valid.`, l.id);
    if (!boxValid(l.box)) at('error', 'INVALID_GEOMETRY', `${l.label}: its box is not valid.`, l.id);
    if (!elementIds.has(l.elementId)) at('error', 'UNKNOWN_REGION', `${l.label}: its protected region no longer exists.`, l.id);
    if (l.review.status === 'needs-review') at('warning', 'NOT_REVIEWED', `${l.label}: not reviewed yet.`, l.id);
    if (l.replacement && !l.replacement.hasAlpha) at('warning', 'OPAQUE_REPLACEMENT', `${l.label}: the replacement has no transparency, so its background shows as a box.`, l.id);
  }
  return out;
}
/** A word or logo slot as saved: its normalized box derived from its box. */
export const wordWithNormalized = <T extends { box: SourceBox; normalized: NormalizedBox }>(item: T, size: SourceSize): T => ({ ...item, normalized: normalizeBox(item.box, size) });
/** Appends events, keeping the newest WORD_LIMITS.maxHistory. */
export const withHistory = (history: AnalysisEvent[], ...events: AnalysisEvent[]) => [...history, ...events].slice(-WORD_LIMITS.maxHistory);
/** Whether every word and logo slot of the analysis is approved or rejected (nothing left to review). */
export const analysisReviewed = (a: Pick<TextAnalysis, 'words' | 'logoSlots'>) => a.words.every(w => w.review.status !== 'needs-review') && a.logoSlots.every(l => l.review.status !== 'needs-review');
/** The words a layout uses: rejected recognitions are left out. */
export const usableWords = (a: Pick<TextAnalysis, 'words'>) => a.words.filter(w => w.review.status !== 'rejected');
export const usableLogoSlots = (a: Pick<TextAnalysis, 'logoSlots'>) => a.logoSlots.filter(l => l.review.status !== 'rejected');

/**
 * The top of a Konva text box whose first line's baseline falls on `baselineY`. Konva puts the first baseline at
 * lineHeight/2 + (ascent − descent)/2 below the top; `ascentMinusDescent` is that font's (ascent − descent) in em, about
 * 0.73 for most text faces (Inter 0.727). An estimate: the drawn word can sit a pixel or two off for another font.
 */
export const textTopForBaseline = (baselineY: number, fontSize: number, lineHeight: number, ascentMinusDescent = 0.727) => baselineY - fontSize * (lineHeight / 2 + ascentMinusDescent / 2);
