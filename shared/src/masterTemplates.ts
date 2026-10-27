/**
 * Text & Graphics MASTER templates and the CREATIVES made from them.
 *
 *   Phase 1 (once per source)  upload ─► scan (local OCR + pixel analysis) ─► review ─► clean background (and, optionally,
 *                               one Seedream decomposition of it) ─► publish a master revision (an immutable snapshot)
 *   Phase 2 (any number)       choose a master ─► a creative: the saved background and artwork with every word, logo and
 *                               text plate as its own element on top, at the saved coordinates ─► edit ─► editor ─► save
 *
 * A master is a protected template (protectedContent.ts) with `master` set: its words and logo slots are its textAnalysis
 * (protectedWords.ts), its clean background is its base. A creative never changes its master: it refers to one published
 * revision and holds only its own elements (text, style, position, replaced logos), never pixels painted onto the artwork.
 * Reusing a master reads stored files only: no OCR, no decomposition, no image generation.
 *
 * COORDINATES: source pixels of the master's source image (origin top-left), as everywhere in protected templates. Every
 * view (preview, editor, export) scales from them; nothing scaled is stored.
 *
 * Nothing here calls a provider.
 */
import type { NormalizedBox, ProtectedBaseMethod, ProtectedElement, SourceBox, SourceSize } from './protectedContent.js';
import { boxIoU, withHistory, type DetectedWord, type LogoSlot, type TextAnalysis, type WordGroup, type WordStyle } from './protectedWords.js';
import { drawableOfferStyle, isOfferFont, offerWeights, type OfferWeight } from './offerFonts.js';

export const MASTER_SCHEMA_VERSION = 1;
export const CREATIVE_SCHEMA_VERSION = 1;
export const TEMPLATE_TYPES = ['text-graphics', 'product-text'] as const;
export type TemplateType = typeof TEMPLATE_TYPES[number];
export const TEMPLATE_TYPE_LABELS: Record<TemplateType, { title: string; summary: string }> = {
  'text-graphics': { title: 'Text & Graphics', summary: 'Offer creatives with replaceable headings, offer copy, CTAs, logos, badges and QR codes on static artwork. No product replacement.' },
  'product-text': { title: 'Product + Text', summary: 'Product-focused creatives: product replacement, decomposition and supporting text.' },
};

// ---------------------------------------------------------------------------------------------------------------------
// Categories: how the content panel groups what was found (derived from the content, always editable)
// ---------------------------------------------------------------------------------------------------------------------
export const MASTER_CATEGORIES = ['headline', 'offer', 'supporting', 'cta', 'legal', 'brand-logo', 'partner-logo', 'qr', 'badge', 'graphic'] as const;
export type MasterCategory = typeof MASTER_CATEGORIES[number];
export const TEXT_CATEGORIES: readonly MasterCategory[] = ['headline', 'offer', 'supporting', 'cta', 'legal'];
export const GRAPHIC_CATEGORIES: readonly MasterCategory[] = ['brand-logo', 'partner-logo', 'qr', 'badge', 'graphic'];
export const MASTER_CATEGORY_LABELS: Record<MasterCategory, string> = {
  headline: 'Headline', offer: 'Offer details', supporting: 'Supporting copy', cta: 'Call to action', legal: 'Legal text',
  'brand-logo': 'Brand logos', 'partner-logo': 'Bank & partner logos', qr: 'QR codes', badge: 'Badges', graphic: 'Other graphics',
};
export const isMasterCategory = (v: unknown): v is MasterCategory => typeof v === 'string' && (MASTER_CATEGORIES as readonly string[]).includes(v);

const CTA = /\b(shop|buy|order|scan|call|visit|book|download|register|sign ?up|claim|tap|click|whatsapp|subscribe|learn more|know more|apply now|get started)\b/i;
const OFFER = /\d\s*%|[₹$€£]\s*\d|\d\s*[₹$€£]|\b\d+\s*(months?|days?|years?|yrs?|x)\b|\d-\d|\bno[- ]cost\b|\bcashback\b|\bfree\b|\boff\b|\bemi\b/i;
const LEGAL = /t\s?&\s?c|terms|conditions|disclaimer|\*\s*apply|subject to/i;
/**
 * A first guess at a group's category from its text, its size against the poster's largest text and its plate. Every
 * guess is shown to the administrator and can be changed.
 */
export function guessTextCategory(text: string, input: { maxWordHeight: number; posterMaxWordHeight: number; hasPlate: boolean; legalRegion?: boolean }): MasterCategory {
  if (input.legalRegion || LEGAL.test(text)) return 'legal';
  if (input.maxWordHeight >= input.posterMaxWordHeight * 0.6) return 'headline';
  if (CTA.test(text) && text.split(/\s+/).length <= 10) return 'cta';
  if (input.hasPlate || OFFER.test(text)) return 'offer';
  return 'supporting';
}

// ---------------------------------------------------------------------------------------------------------------------
// Plates: a solid shape behind a line of text (a pill, a button), recolourable as its own element
// ---------------------------------------------------------------------------------------------------------------------
export interface TextPlate {
  /** pp- + 10 hex, stable for the template's life. */
  id: string;
  /** The phrase it sits behind. */
  groupId: string;
  box: SourceBox; normalized: NormalizedBox;
  fill: string; stroke: { color: string; width: number } | null; radius: number;
  confidence: number;
  review: { status: 'needs-review' | 'approved' | 'rejected'; at?: string };
}
export const validPlateId = (id: unknown): id is string => typeof id === 'string' && /^pp-[a-f0-9]{10}$/.test(id);

// ---------------------------------------------------------------------------------------------------------------------
// The master record (on the protected template) and its published revisions
// ---------------------------------------------------------------------------------------------------------------------
export interface MasterScan {
  status: 'running' | 'done' | 'failed';
  startedAt: string; finishedAt?: string;
  /** The source it read: a scan is never repeated for the same source (the result is cached in textAnalysis). */
  sourceSha256: string;
  engine?: string; durationMs?: number; error?: string;
  /** OCR reads made by this scan: one of the whole poster, then one per text region. */
  recognizerCalls: number;
  found?: { words: number; groups: number; logos: number; plates: number; ignored: number };
}
export interface MasterRevisionRef {
  revision: number; publishedAt: string;
  /** master-r<n>.json in the template folder: the immutable snapshot creatives of this revision read. */
  file: string; sha256: string;
  analysisRevision: number; baseSha256: string; runId: string | null;
}
/** How each area of the clean background was continued (patternFill.ts), for review: boxes in source pixels. */
/**
 * The local clean-up's version: bumped whenever removal or filling changes what it produces. 1 (absent): before ink edges
 * beyond a word's box were followed (ascenders, i-dots, full stops), before pattern copies were limited to the same field
 * (a copy from one repeat away could land in a white margin) and before plain margins were continued as plain (a smooth
 * fill pulled colour in from nearby artwork). A clean background made by an older clean-up can keep those leftovers; it
 * is flagged so it can be made again, approved and published as a new revision (never overwritten).
 */
export const MASTER_CLEANUP_VERSION = 2;
export interface MasterCleanup {
  /** The clean-up version that made it (MASTER_CLEANUP_VERSION); absent: version 1. */
  version?: number;
  baseSha256: string;
  areas: { box: { x: number; y: number; width: number; height: number }; method: 'plain' | 'pattern' | 'flat' | 'smooth'; trusted: boolean; detail: string }[];
  /** Share (%) of the removed pixels continued from a plain field, a pattern or flat colours (the rest is a smooth estimate). */
  trustedPercent: number; filledPercent: number; durationMs: number;
}
export interface MasterInfo {
  version: typeof MASTER_SCHEMA_VERSION;
  type: 'text-graphics';
  scan?: MasterScan;
  cleanup?: MasterCleanup;
  /** What this master has cost in local reads and paid requests so far: reuse never adds to it. */
  activity: { scans: number; ocrReads: number };
  /** Whether the clean background was split into layers by Seedream (one paid request), or used as one picture. */
  artwork: { mode: 'background' | 'seedream'; runId?: string; decidedAt?: string };
  /** Published revisions, oldest first. The newest is what Reuse starts from. */
  revisions: MasterRevisionRef[];
  /** A second reading of the upload ("Scan again"), kept apart until the administrator applies or discards it. */
  rescan?: MasterRescan;
}
export type MasterStage = 'scanning' | 'scan-failed' | 'review' | 'prepare' | 'ready' | 'changed';
export const MASTER_STAGE_LABELS: Record<MasterStage, string> = {
  scanning: 'Scanning', 'scan-failed': 'Scan failed', review: 'Review elements', prepare: 'Prepare background', ready: 'Ready to reuse', changed: 'Edited since publishing',
};

/** A decomposed artwork layer of the clean background, in source pixels (Seedream's canvas mapped onto the source). */
export interface MasterArtworkLayer { id: string; name: string; file: string; sha256: string; x: number; y: number; width: number; height: number; zIndex: number }
/** Everything a creative of one revision reads. Written once at publishing; never changed. */
export interface MasterSnapshot {
  schemaVersion: typeof MASTER_SCHEMA_VERSION;
  masterId: string; revision: number; publishedAt: string; name: string;
  canvas: SourceSize;
  source: { file: string; sha256: string };
  background: { file: string; sha256: string; width: number; height: number; method: ProtectedBaseMethod; reliability: 'reliable' | 'uncertain'; acknowledgedEstimate: boolean;
    /** For a local clean-up: the MASTER_CLEANUP_VERSION that made it (absent on older revisions: version 1). */
    cleanupVersion?: number };
  /** Seedream's layers of the background (back to front); empty: the background is the one artwork picture. */
  layers: MasterArtworkLayer[];
  decomposition: { runId: string; layers: number } | null;
  words: DetectedWord[]; groups: WordGroup[]; logoSlots: LogoSlot[]; plates: TextPlate[];
  analysisRevision: number;
}

/** Whether a published revision's clean background was made by an older local clean-up (uploaded backgrounds never are). */
export const olderCleanup = (b: MasterSnapshot['background']) => b.method === 'local-fill' && (b.cleanupVersion ?? 1) < MASTER_CLEANUP_VERSION;

// ---------------------------------------------------------------------------------------------------------------------
// Creatives
// ---------------------------------------------------------------------------------------------------------------------
export interface CreativeTextStyle {
  fontFamily: string; fontWeight: OfferWeight; fontStyle: 'normal' | 'italic';
  /** Source pixels. */
  fontSize: number; letterSpacing: number;
  color: string; opacity: number;
}
/** One editable text object (one word of the master, or text added in this creative). */
export interface CreativeText {
  id: string;
  /** The master word it started as; null for text added here. */
  wordId: string | null;
  groupId: string; line: number; order: number;
  text: string;
  /** The text's origin (where its first letter's advance starts) and its baseline, in source pixels. */
  x: number; baselineY: number;
  /** Degrees, clockwise, about the origin. */
  rotation: number;
  style: CreativeTextStyle;
  hidden: boolean; locked: boolean; z: number;
}
export type CreativeAsset = { kind: 'master'; file: string } | { kind: 'creative'; file: string; sha256: string; width: number; height: number; originalName?: string };
/** One image object: a logo slot of the master (or a picture added here), fitted without distortion in its box. */
export interface CreativeImage {
  id: string;
  slotId: string | null;
  category: MasterCategory; label: string;
  /** Source pixels; rotation about the box centre. */
  box: SourceBox;
  asset: CreativeAsset;
  hidden: boolean; locked: boolean; z: number;
  /** The master's own artwork, placed as an AI creative's background picture: not a logo, so layout checks skip it. */
  artwork?: true;
}
/** A text plate as its own shape. */
export interface CreativeShape {
  id: string; plateId: string | null; groupId: string;
  box: SourceBox; fill: string; stroke: { color: string; width: number } | null; radius: number;
  hidden: boolean; z: number;
}
export interface CreativeGroup { id: string; label: string; category: MasterCategory; masterGroupId: string | null; align: 'left' | 'center' | 'right' }
export interface CreativeEvent { at: string; action: 'created' | 'edited' | 'saved-from-editor' | 'logo-replaced' | 'logo-restored' | 'exported' | 'duplicated' | 'renamed'; detail?: string }
export interface CreativeInstance {
  schemaVersion: typeof CREATIVE_SCHEMA_VERSION;
  id: string; masterId: string; masterRevision: number;
  name: string; createdAt: string; updatedAt: string;
  /** Every saved change; a write naming an older revision is refused. */
  revision: number;
  canvas: SourceSize;
  groups: CreativeGroup[]; texts: CreativeText[]; images: CreativeImage[]; shapes: CreativeShape[];
  origin: { kind: 'master' } | { kind: 'duplicate'; creativeId: string } | { kind: 'ai'; jobId: string; index: number };
  /** AI creatives own their canvas and background; absent on legacy/manual creatives (master artwork is used). */
  backgroundColor?: string;
  /** Immutable generation provenance, retained on edits and duplicates. Preview is the initial generated composition. */
  generation?: { jobId: string; formatId: string; count: 3 | 4 | 5; model: string; recipeFile: string; previewFile: string; provider?: 'openai' | 'offline-mock' };
  /** The last save from the Konva editor (its design id there), if any. */
  editor: { designId: string; savedAt: string } | null;
  exports: { at: string; width: number; height: number }[];
  history: CreativeEvent[];
}
export const CREATIVE_LIMITS = { maxTexts: 200, maxImages: 80, maxShapes: 40, maxGroups: 80, maxText: 400, maxName: 120, maxHistory: 300 } as const;
export const validCreativeId = (id: unknown): id is string => typeof id === 'string' && /^cr-[a-f0-9]{12}$/.test(id);
const ELEMENT_ID = /^c[tisg]-[a-f0-9]{10}$/;
export const validCreativeElementId = (id: unknown): id is string => typeof id === 'string' && ELEMENT_ID.test(id);

/** The style a creative draws a master word in: the word's measured style, snapped to what the font files can draw. */
export function creativeStyleOf(style: WordStyle): CreativeTextStyle {
  const family = isOfferFont(style.fontFamily) ? style.fontFamily : 'Inter', drawable = drawableOfferStyle(family, style.fontWeight, style.fontStyle === 'italic');
  return { fontFamily: family, fontWeight: drawable.weight, fontStyle: drawable.italic ? 'italic' : 'normal', fontSize: style.fontSize, letterSpacing: style.letterSpacing, color: style.color, opacity: style.opacity };
}

/**
 * A new creative of a published revision: every usable word as its own text at its saved origin and baseline, every logo
 * slot as its own image (the master's replacement file when it has one), every plate as its own shape. `newId` makes the
 * element ids (prefix + 10 hex).
 */
export function creativeFromSnapshot(snapshot: MasterSnapshot, input: { id: string; name: string; at: string; newId: (prefix: 'ct' | 'ci' | 'cs' | 'cg') => string }): CreativeInstance {
  const words = snapshot.words.filter(w => w.review.status !== 'rejected').sort((a, b) => a.order - b.order);
  const groups: CreativeGroup[] = snapshot.groups.filter(g => g.lines.some(l => l.wordIds.some(id => words.some(w => w.id === id))))
    .map(g => ({ id: g.id, label: g.label || 'Text', category: isMasterCategory(g.category) ? g.category : 'supporting', masterGroupId: g.id, align: g.align }));
  let z = 0;
  const shapes: CreativeShape[] = snapshot.plates.filter(p => p.review.status !== 'rejected' && groups.some(g => g.id === p.groupId))
    .map(p => ({ id: input.newId('cs'), plateId: p.id, groupId: p.groupId, box: { ...p.box }, fill: p.fill, stroke: p.stroke ? { ...p.stroke } : null, radius: p.radius, hidden: false, z: z++ }));
  const images: CreativeImage[] = snapshot.logoSlots.filter(l => l.review.status !== 'rejected').sort((a, b) => a.order - b.order).map(l => ({
    id: input.newId('ci'), slotId: l.id, category: isMasterCategory(l.category) ? l.category : 'graphic', label: l.label, box: { ...l.box },
    asset: { kind: 'master' as const, file: l.replacement?.file ?? l.original.file }, hidden: false, locked: false, z: z++,
  }));
  const lineIndex = (w: DetectedWord) => Math.max(0, snapshot.groups.find(g => g.id === w.groupId)?.lines.findIndex(l => l.id === w.lineId) ?? 0);
  const texts: CreativeText[] = words.map((w, order) => ({
    id: input.newId('ct'), wordId: w.id, groupId: w.groupId, line: lineIndex(w), order, text: w.text,
    x: w.box.x + (w.style.originDx ?? 0), baselineY: w.box.y + w.style.baseline, rotation: w.box.rotation,
    style: creativeStyleOf(w.style), hidden: false, locked: false, z: z++,
  }));
  return { schemaVersion: CREATIVE_SCHEMA_VERSION, id: input.id, masterId: snapshot.masterId, masterRevision: snapshot.revision, name: input.name, createdAt: input.at, updatedAt: input.at, revision: 1,
    canvas: { ...snapshot.canvas }, groups, texts, images, shapes, origin: { kind: 'master' }, editor: null, exports: [], history: [{ at: input.at, action: 'created', detail: `From master revision ${snapshot.revision}.` }] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Layout: measuring, rewriting a phrase, checks (pure; the browser passes real font measurements)
// ---------------------------------------------------------------------------------------------------------------------
/** The drawn advance width of a text in a style, source pixels (the browser measures with the loaded font file). */
export type MeasureText = (text: string, style: CreativeTextStyle) => number;
/** An estimate without fonts (average glyph widths): only for the server and for tests. */
export const estimateAdvance: MeasureText = (text, style) => {
  let em = 0;
  for (const ch of text) em += /[.,:;'!|ilIj]/.test(ch) ? 0.27 : /[frt\-/()[\]]/.test(ch) ? 0.36 : /[MWmw]/.test(ch) ? 0.84 : /[A-Z]/.test(ch) ? 0.66 : /[a-z]/.test(ch) ? 0.53 : /\d/.test(ch) ? 0.58 : ch === ' ' ? 0.28 : 0.6;
  return em * style.fontSize * (style.fontWeight === 700 ? 1.06 : style.fontWeight === 600 ? 1.03 : 1) + Math.max(0, [...text].length - 1) * style.letterSpacing;
};
/** A text's box for checks: origin to advance, from cap height above the baseline to the descender below it. */
export function textBounds(t: Pick<CreativeText, 'x' | 'baselineY' | 'text' | 'style'>, measure: MeasureText) {
  const w = measure(t.text, t.style), f = t.style.fontSize;
  return { x: t.x, y: t.baselineY - f * 0.78, width: Math.max(1, w), height: f * 1.0 };
}

export interface RewriteResult { texts: CreativeText[]; shapes: CreativeShape[]; scale: number[]; warnings: string[] }
/**
 * A group rewritten with new copy: `copy` lines (newlines) of words (spaces). Each new line takes the style and baseline
 * spacing of the original line at its place (the last one's beyond them); words keep the group's alignment on its
 * original anchor; a line wider than the group's original width (or the canvas safe area) is set smaller to fit, never
 * below `minScale`, and the plate behind the group follows the text with its original padding. Words take the ids of
 * the old words in reading order (their master slots), new ones get new ids; old words left over are removed.
 */
export function rewriteGroup(creative: CreativeInstance, groupId: string, copy: string, measure: MeasureText, options: { newId: (prefix: 'ct') => string; minScale?: number; keepWidth?: boolean } = { newId: () => 'ct-0000000000' }): RewriteResult {
  const group = creative.groups.find(g => g.id === groupId);
  const old = creative.texts.filter(t => t.groupId === groupId).sort((a, b) => a.line - b.line || a.order - b.order);
  if (!group || !old.length) return { texts: creative.texts, shapes: creative.shapes, scale: [], warnings: ['This group has no text to rewrite.'] };
  const lines = copy.split('\n').map(l => l.trim().split(/\s+/).filter(Boolean)).filter(l => l.length);
  if (!lines.length) return { texts: creative.texts.filter(t => t.groupId !== groupId), shapes: creative.shapes.filter(s => s.groupId !== groupId), scale: [], warnings: [] };
  const oldLines = [...new Set(old.map(t => t.line))].sort((a, b) => a - b).map(n => old.filter(t => t.line === n));
  const extent = (row: CreativeText[]) => { const left = Math.min(...row.map(t => t.x)), right = Math.max(...row.map(t => t.x + measure(t.text, t.style))); return { left, right }; };
  const ext = oldLines.map(extent), left = Math.min(...ext.map(e => e.left)), right = Math.max(...ext.map(e => e.right));
  const safe = Math.min(creative.canvas.width, creative.canvas.height) * 0.04;
  const width = options.keepWidth === false ? creative.canvas.width - 2 * safe : right - left;
  const anchor = group.align === 'center' ? (left + right) / 2 : group.align === 'right' ? right : left;
  const steps = oldLines.slice(1).map((row, i) => row[0].baselineY - oldLines[i][0].baselineY);
  const minScale = options.minScale ?? 0.55, warnings: string[] = [], scales: number[] = [];
  const out: CreativeText[] = [];
  const ids = old.map(t => t.id), wordIds = old.map(t => t.wordId);
  let baseline = oldLines[0][0].baselineY, prevSize = oldLines[0][0].style.fontSize, order = Math.min(...old.map(t => t.order));
  lines.forEach((words, i) => {
    const template = oldLines[Math.min(i, oldLines.length - 1)][0];
    if (i > 0) {
      const step = steps[Math.min(i - 1, steps.length - 1)] ?? template.style.fontSize * 1.15;
      baseline += step * (prevSize / Math.max(1e-6, oldLines[Math.min(i - 1, oldLines.length - 1)][0].style.fontSize)) * (i < oldLines.length ? 1 : 1);
    }
    let style = { ...template.style };
    const lineWidth = (s: CreativeTextStyle) => words.reduce((sum, w) => sum + measure(w, s), 0) + measure(' ', s) * (words.length - 1);
    const natural = lineWidth(style);
    let scale = 1;
    if (natural > width * 1.01) {
      scale = Math.max(minScale, width / natural);
      style = { ...style, fontSize: style.fontSize * scale, letterSpacing: style.letterSpacing * scale };
      if (lineWidth(style) > width * 1.01) warnings.push(`Line ${i + 1} (“${words.join(' ')}”) is still wider than the space at ${Math.round(scale * 100)}% size: shorten it, break it into more lines or move it.`);
      else if (scale < 0.8) warnings.push(`Line ${i + 1} was set at ${Math.round(scale * 100)}% of its original size to fit.`);
    }
    scales.push(scale);
    const total = lineWidth(style), space = measure(' ', style);
    let x = group.align === 'center' ? anchor - total / 2 : group.align === 'right' ? anchor - total : anchor;
    for (const word of words) {
      const id = ids.shift() ?? options.newId('ct'), wordId = wordIds.length ? wordIds.shift()! : null;
      out.push({ id, wordId, groupId, line: i, order: order++, text: word, x, baselineY: baseline, rotation: template.rotation, style, hidden: false, locked: false, z: template.z });
      x += measure(word, style) + space;
    }
    prevSize = style.fontSize;
  });
  const others = creative.texts.filter(t => t.groupId !== groupId);
  // The plate follows the text: same padding around the new lines as around the old ones.
  const shapes = creative.shapes.map(s => {
    if (s.groupId !== groupId) return s;
    const before = { left, right, top: Math.min(...old.map(t => t.baselineY - t.style.fontSize * 0.78)), bottom: Math.max(...old.map(t => t.baselineY + t.style.fontSize * 0.22)) };
    const newExt = out.map(t => ({ l: t.x, r: t.x + measure(t.text, t.style), t: t.baselineY - t.style.fontSize * 0.78, b: t.baselineY + t.style.fontSize * 0.22 }));
    const nl = Math.min(...newExt.map(e => e.l)), nr = Math.max(...newExt.map(e => e.r)), nt = Math.min(...newExt.map(e => e.t)), nb = Math.max(...newExt.map(e => e.b));
    const padL = before.left - s.box.x, padR = s.box.x + s.box.width - before.right, padT = before.top - s.box.y, padB = s.box.y + s.box.height - before.bottom;
    return { ...s, box: { ...s.box, x: nl - padL, y: nt - padT, width: nr - nl + padL + padR, height: nb - nt + padT + padB } };
  });
  // Keep the rest of the reading order after the group.
  const shift = out.length - old.length;
  return { texts: [...others.map(t => t.order > Math.max(...old.map(o => o.order)) ? { ...t, order: t.order + shift } : t), ...out].sort((a, b) => a.order - b.order), shapes, scale: scales, warnings };
}

/** Lays one line of a group out again (after a word changed): words keep their order and the line keeps its anchor. */
export function reflowLine(creative: CreativeInstance, groupId: string, line: number, measure: MeasureText): CreativeText[] {
  const group = creative.groups.find(g => g.id === groupId), row = creative.texts.filter(t => t.groupId === groupId && t.line === line && !t.hidden).sort((a, b) => a.x - b.x);
  if (!group || row.length < 2) return creative.texts;
  const left = row[0].x, right = Math.max(...row.map(t => t.x + measure(t.text, t.style)));
  const space = measure(' ', row[0].style), total = row.reduce((s, t) => s + measure(t.text, t.style), 0) + space * (row.length - 1);
  let x = group.align === 'center' ? (left + right) / 2 - total / 2 : group.align === 'right' ? right - total : left;
  const placed = new Map<string, number>();
  for (const t of row) { placed.set(t.id, x); x += measure(t.text, t.style) + space; }
  return creative.texts.map(t => placed.has(t.id) ? { ...t, x: placed.get(t.id)! } : t);
}

/** A group's lines aligned to the group's own extent (left edges, centres or right edges together); words keep their spacing. */
export function alignGroup(creative: CreativeInstance, groupId: string, align: 'left' | 'center' | 'right', measure: MeasureText): CreativeInstance {
  const words = creative.texts.filter(t => t.groupId === groupId && !t.hidden);
  if (!words.length) return creative;
  const lines = [...new Set(words.map(t => t.line))].map(n => {
    const row = words.filter(t => t.line === n), left = Math.min(...row.map(t => t.x)), right = Math.max(...row.map(t => t.x + measure(t.text, t.style)));
    return { n, left, right };
  });
  const groupLeft = Math.min(...lines.map(l => l.left)), groupRight = Math.max(...lines.map(l => l.right));
  const shift = new Map(lines.map(l => [l.n, align === 'left' ? groupLeft - l.left : align === 'right' ? groupRight - l.right : (groupLeft + groupRight) / 2 - (l.left + l.right) / 2]));
  return { ...creative, groups: creative.groups.map(g => g.id === groupId ? { ...g, align } : g),
    texts: creative.texts.map(t => t.groupId === groupId && !t.hidden ? { ...t, x: t.x + (shift.get(t.line) ?? 0) } : t) };
}

export interface CreativeIssue { severity: 'error' | 'warning'; code: 'OVERLAP' | 'OUT_OF_CANVAS' | 'SAFE_AREA' | 'EMPTY' | 'FONT'; message: string; ids: string[] }
/** Layout checks with real measurements: text running into other text or a logo, off the canvas, missing fonts. */
export function masterCreativeIssues(c: CreativeInstance, measure: MeasureText): CreativeIssue[] {
  const out: CreativeIssue[] = [], { width: W, height: H } = c.canvas;
  const items = [
    ...c.texts.filter(t => !t.hidden && t.text.trim()).map(t => ({ id: t.id, kind: 'text' as const, line: `${t.groupId}:${t.line}`, group: t.groupId, label: `“${t.text}”`, b: textBounds(t, measure) })),
    ...c.images.filter(i => !i.hidden && !i.artwork).map(i => ({ id: i.id, kind: 'image' as const, line: i.id, group: i.id, label: i.label, b: { x: i.box.x, y: i.box.y, width: i.box.width, height: i.box.height } })),
  ];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    const w = Math.min(a.b.x + a.b.width, b.b.x + b.b.width) - Math.max(a.b.x, b.b.x), h = Math.min(a.b.y + a.b.height, b.b.y + b.b.height) - Math.max(a.b.y, b.b.y);
    if (w <= 0 || h <= 0) continue;
    const share = (w * h) / Math.max(1, Math.min(a.b.width * a.b.height, b.b.width * b.b.height));
    // Words of one line may touch; anything else overlapping by more than a sliver collides.
    if (a.line === b.line ? share > 0.08 : share > 0.03) out.push({ severity: a.group === b.group ? 'warning' : 'error', code: 'OVERLAP', message: `${a.label} overlaps ${b.label}.`, ids: [a.id, b.id] });
  }
  const inset = Math.min(W, H) * 0.02;
  for (const it of items) {
    const b = it.b;
    if (b.x < -1 || b.y < -1 || b.x + b.width > W + 1 || b.y + b.height > H + 1) out.push({ severity: 'error', code: 'OUT_OF_CANVAS', message: `${it.label} runs off the canvas.`, ids: [it.id] });
    else if (it.kind === 'text' && (b.x < inset || b.x + b.width > W - inset)) out.push({ severity: 'warning', code: 'SAFE_AREA', message: `${it.label} is very close to the edge.`, ids: [it.id] });
  }
  for (const t of c.texts.filter(x => !x.hidden)) {
    if (!t.text.trim()) out.push({ severity: 'warning', code: 'EMPTY', message: 'An empty text is hidden in the export.', ids: [t.id] });
    if (!isOfferFont(t.style.fontFamily) || !offerWeights(t.style.fontFamily).includes(t.style.fontWeight)) out.push({ severity: 'error', code: 'FONT', message: `“${t.text}” uses ${t.style.fontFamily} ${t.style.fontWeight}, which has no font file here.`, ids: [t.id] });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Local typography presets ("Suggest styles", no AI): fixed rules, clearly labelled as such
// ---------------------------------------------------------------------------------------------------------------------
export interface TypographyPreset { id: string; name: string; summary: string }
export const TYPOGRAPHY_PRESETS: readonly TypographyPreset[] = [
  { id: 'original', name: 'Original', summary: 'The master’s own fonts and colours.' },
  { id: 'all-black', name: 'All black text', summary: 'Every text colour becomes black; fonts and sizes unchanged.' },
  { id: 'high-contrast', name: 'High-contrast headline', summary: 'Headline in the darkest colour of the creative at full weight; other text unchanged.' },
  { id: 'geometric', name: 'Geometric hierarchy', summary: 'Headline in Sora Bold, the rest in Outfit; colours unchanged.' },
  { id: 'serif-accent', name: 'Serif accent', summary: 'Headline in DM Serif Display, the rest in Manrope; colours unchanged.' },
];
const luminance = (hex: string) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** A preset applied to a creative's texts (and the master's styles for "original"): styles only, never text or positions. */
export function applyTypographyPreset(c: CreativeInstance, presetId: string, master: Pick<MasterSnapshot, 'words'>): CreativeText[] {
  const headline = new Set(c.groups.filter(g => g.category === 'headline').map(g => g.id));
  const darkest = [...c.texts.map(t => t.style.color)].sort((a, b) => luminance(a) - luminance(b))[0] ?? '#000000';
  return c.texts.map(t => {
    const s = t.style, isHead = headline.has(t.groupId);
    const family = (f: string, w: OfferWeight): CreativeTextStyle => { const d = drawableOfferStyle(f, w, false); return { ...s, fontFamily: f, fontWeight: d.weight, fontStyle: 'normal' }; };
    switch (presetId) {
      case 'original': { const w = master.words.find(x => x.id === t.wordId); return w ? { ...t, style: { ...creativeStyleOf(w.style), fontSize: s.fontSize } } : t; }
      case 'all-black': return { ...t, style: { ...s, color: '#000000' } };
      case 'high-contrast': return isHead ? { ...t, style: { ...s, color: darkest, fontWeight: drawableOfferStyle(s.fontFamily, 700, s.fontStyle === 'italic').weight } } : t;
      case 'geometric': return { ...t, style: isHead ? family('Sora', 700) : family('Outfit', s.fontWeight) };
      case 'serif-accent': return { ...t, style: isHead ? family('DM Serif Display', 400) : family('Manrope', s.fontWeight) };
      default: return t;
    }
  });
}

/** A text's words and logo slots as the master holds them, for the content panel's headings. */
export function categoryOfGroup(analysis: Pick<TextAnalysis, 'groups'>, groupId: string): MasterCategory {
  const g = analysis.groups.find(x => x.id === groupId);
  return g && isMasterCategory(g.category) ? g.category : 'supporting';
}

// ---------------------------------------------------------------------------------------------------------------------
// Scan again: a second reading of the master's own upload (local OCR and font matching, no provider), compared with the
// current elements before anything changes. Applying it changes the working analysis only: published revisions and the
// creatives made from them keep theirs; a new revision is published by saving the master again.
// ---------------------------------------------------------------------------------------------------------------------
export interface MasterRescan {
  status: 'running' | 'done' | 'failed';
  startedAt: string; finishedAt?: string; error?: string;
  /** The analysis revision it was read against: applying needs the elements unchanged since. */
  basedOn: number;
  recognizerCalls: number; durationMs?: number; engine?: string;
  /** The new reading (`MasterRescanProposal`), once done. */
  file?: string;
}
/** The rescan file: the new analysis, the regions it would use, the logo crops it wrote and what it found. */
export interface MasterRescanProposal {
  analysis: TextAnalysis; elements: ProtectedElement[]; written: string[];
  found: { words: number; groups: number; logos: number; plates: number; ignored: number };
}
export type RescanFont = Pick<WordStyle, 'fontFamily' | 'fontWeight' | 'fontStyle' | 'fontSize'>;
export interface RescanFontChange {
  wordId: string; text: string; lineId: string;
  /** The current font was chosen by hand: offered, never preselected. */
  chosen: boolean;
  from: RescanFont; to: RescanFont;
}
export interface RescanChanges {
  /** Current words the new reading matched with another font. */
  fonts: RescanFontChange[];
  /** Current words read with other text now (the current text is kept). */
  text: { wordId: string; from: string; to: string }[];
  /**
   * Read now and not among the current elements. `lineId`: the current line it reads on (beside words that line already
   * has), so it can be added there; null: only replacing everything brings it in.
   */
  added: { wordId: string; text: string; box: SourceBox; lineId: string | null }[];
  /** Shapes behind text found now (a pill, a band) and not among the current ones; `groupId`: the phrase it sits behind. */
  plates: { plateId: string; box: SourceBox; fill: string; groupId: string | null }[];
  /** Current words the new reading did not find (kept unless everything is replaced); `manual`: added by hand. */
  missing: { wordId: string; text: string; manual: boolean }[];
  logos: { added: number; missing: number; moved: number };
}
const rescanFont = (s: WordStyle): RescanFont => ({ fontFamily: s.fontFamily, fontWeight: s.fontWeight, fontStyle: s.fontStyle, fontSize: s.fontSize });
const sameFont = (a: RescanFont, b: RescanFont) => a.fontFamily === b.fontFamily && a.fontWeight === b.fontWeight && a.fontStyle === b.fontStyle && Math.abs(a.fontSize - b.fontSize) <= Math.max(1, a.fontSize * 0.03);
/** What a new reading would change. Words and logo slots are matched by id (a new reading keeps the id of the element in the same place). */
export function rescanChanges(current: TextAnalysis, proposal: TextAnalysis): RescanChanges {
  const live = <T extends { review: { status: string } }>(x: T) => x.review.status !== 'rejected';
  const next = new Map(proposal.words.filter(live).map(w => [w.id, w])), known = new Set(current.words.map(w => w.id));
  const out: RescanChanges = { fonts: [], text: [], added: [], missing: [], plates: [], logos: { added: 0, missing: 0, moved: 0 } };
  for (const w of current.words.filter(live)) {
    const p = next.get(w.id);
    if (!p) { out.missing.push({ wordId: w.id, text: w.text, manual: w.origin === 'admin' }); continue; }
    if (!sameFont(rescanFont(w.style), rescanFont(p.style))) out.fonts.push({ wordId: w.id, text: w.text, lineId: w.lineId, chosen: w.style.fontMatch === 'admin', from: rescanFont(w.style), to: rescanFont(p.style) });
    if (p.text !== w.text) out.text.push({ wordId: w.id, from: w.text, to: p.text });
  }
  out.added = proposal.words.filter(w => live(w) && !known.has(w.id)).map(w => ({ wordId: w.id, text: w.text, box: w.box, lineId: currentLineOf(current, proposal, w.lineId)?.lineId ?? null }));
  const plates = (current.plates ?? []).filter(live);
  for (const p of (proposal.plates ?? []).filter(live)) if (!plates.some(c => boxIoU(c.box, p.box) >= 0.6)) out.plates.push({ plateId: p.id, box: p.box, fill: p.fill, groupId: currentGroupOf(current, proposal, p.groupId) });
  const slots = new Map(proposal.logoSlots.filter(live).map(l => [l.id, l])), knownSlots = new Set(current.logoSlots.map(l => l.id));
  for (const l of current.logoSlots.filter(live)) { const p = slots.get(l.id); if (!p) out.logos.missing++; else if (boxIoU(l.box, p.box) < 0.95) out.logos.moved++; }
  out.logos.added = proposal.logoSlots.filter(l => live(l) && !knownSlots.has(l.id)).length;
  return out;
}
/** The current line and phrase a new reading's line continues: the one holding most of the words they share. */
function currentLineOf(current: TextAnalysis, proposal: TextAnalysis, proposalLineId: string): { lineId: string; groupId: string } | undefined {
  const votes = new Map<string, number>();
  for (const w of proposal.words) if (w.lineId === proposalLineId) { const c = current.words.find(x => x.id === w.id && x.review.status !== 'rejected'); if (c) votes.set(c.lineId, (votes.get(c.lineId) ?? 0) + 1); }
  const lineId = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const group = lineId ? current.groups.find(g => g.lines.some(l => l.id === lineId)) : undefined;
  return lineId && group ? { lineId, groupId: group.id } : undefined;
}
function currentGroupOf(current: TextAnalysis, proposal: TextAnalysis, proposalGroupId: string): string | null {
  const votes = new Map<string, number>();
  for (const w of proposal.words) if (w.groupId === proposalGroupId) { const c = current.words.find(x => x.id === w.id && x.review.status !== 'rejected'); if (c) votes.set(c.groupId, (votes.get(c.groupId) ?? 0) + 1); }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
/**
 * The current analysis with chosen findings of a new reading added: words read beside a current line's words join that
 * line (in reading order, with the font and place they were read with), and shapes behind a current phrase join it. Both
 * approved (the administrator chose them). What has no current line or phrase is left out (only replacing everything adds
 * it). Unchanged when nothing applies.
 */
export function addRescanFindings(current: TextAnalysis, proposal: TextAnalysis, input: { wordIds?: readonly string[]; plateIds?: readonly string[] }, at: string): TextAnalysis {
  const groups = current.groups.map(g => ({ ...g, lines: g.lines.map(l => ({ ...l, wordIds: [...l.wordIds] })) })), words = [...current.words], plates = [...(current.plates ?? [])];
  let added = 0;
  for (const id of input.wordIds ?? []) {
    const p = proposal.words.find(w => w.id === id);
    if (!p || words.some(w => w.id === id)) continue;
    const target = currentLineOf(current, proposal, p.lineId), group = target && groups.find(g => g.id === target.groupId), line = group?.lines.find(l => l.id === target!.lineId);
    if (!group || !line) continue;
    words.push({ ...p, groupId: group.id, lineId: line.id, elementId: group.elementId, review: { status: 'approved', at } });
    line.wordIds.push(p.id);
    added++;
  }
  for (const id of input.plateIds ?? []) {
    const p = (proposal.plates ?? []).find(x => x.id === id), groupId = p ? currentGroupOf(current, proposal, p.groupId) : null;
    if (!p || !groupId || plates.some(x => x.id === id || boxIoU(x.box, p.box) >= 0.6)) continue;
    plates.push({ ...p, groupId, review: { status: 'approved', at } });
    added++;
  }
  if (!added) return current;
  // Each line left to right, reading order and phrases' labels follow.
  const byId = new Map(words.map(w => [w.id, w]));
  for (const g of groups) for (const l of g.lines) l.wordIds.sort((a, b) => byId.get(a)!.box.x - byId.get(b)!.box.x);
  let order = 0;
  const ordered = new Map<string, number>();
  for (const g of groups) for (const l of g.lines) for (const id of l.wordIds) ordered.set(id, order++);
  const next = words.map(w => ({ ...w, order: ordered.get(w.id) ?? order++ }));
  const labelled = groups.map(g => ({ ...g, label: g.lines.map(l => l.wordIds.map(id => byId.get(id)!.text).join(' ')).join(' ').slice(0, 200) || g.label }));
  return { ...current, words: next, groups: labelled, plates, revision: current.revision + 1, updatedAt: at, history: withHistory(current.history, { at, action: 'added', detail: `${added} finding(s) of a new scan added.` }) };
}
/**
 * The current analysis with the new reading's font for the chosen words: family, weight, style, size, letter spacing and
 * where the text starts and sits (the same source pixels, kept relative to the current box, which may be a correction).
 * Text, box, colour, review, group and category stay as they are. Unchanged when no chosen word is in the new reading.
 */
export function applyRescanFonts(current: TextAnalysis, proposal: TextAnalysis, wordIds: readonly string[], at: string): TextAnalysis {
  const next = new Map(proposal.words.map(w => [w.id, w])), chosen = new Set(wordIds), r1 = (v: number) => Math.round(v * 10) / 10;
  let changed = 0;
  const words = current.words.map(w => {
    const p = chosen.has(w.id) ? next.get(w.id) : undefined;
    if (!p) return w;
    changed++;
    const originX = p.box.x + (p.style.originDx ?? 0), baselineY = p.box.y + p.style.baseline;
    return { ...w, style: { ...w.style, fontFamily: p.style.fontFamily, fontMatch: 'estimated' as const, fontSize: p.style.fontSize, fontWeight: p.style.fontWeight, fontStyle: p.style.fontStyle, letterSpacing: p.style.letterSpacing, baseline: r1(baselineY - w.box.y), originDx: r1(originX - w.box.x) } };
  });
  if (!changed) return current;
  return { ...current, words, revision: current.revision + 1, updatedAt: at, history: withHistory(current.history, { at, action: 'corrected', detail: `Fonts of ${changed} word(s) from a new scan.` }) };
}
