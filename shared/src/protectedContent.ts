/**
 * Protected content decomposition: bank and brand logos, promotional text and legal copy that Seedream must never redraw.
 * A protected template keeps them apart from the artwork Seedream decomposes, with the exact geometry and assets needed to
 * restore them deterministically, and to replace them later without decomposing again.
 *
 *   A. protected content   elements[]: geometry, the preserved pixels or the original asset, text metadata
 *   B. decomposable content the prepared base: the source with every protected region removed (or a clean base)
 *   C. template metadata    this record: coordinates, order, text, asset hashes, provenance and reviews
 *
 * CANONICAL COORDINATES ARE SOURCE PIXELS: the source image as decomposition sees it (EXIF orientation applied), origin at
 * its top-left corner, x to the right, y down. A region is its unrotated box (x, y, width, height; fractional pixels
 * allowed) plus a rotation in degrees, clockwise, about the box centre. Normalized values (fractions of the source width
 * and height) are derived from it on every save. Every other space (the annotation view at any zoom, Seedream's output
 * canvas, the editor canvas at any export size) is reached through the functions below and never stored, so preview
 * scaling, browser zoom or device-pixel ratio cannot drift the saved geometry.
 *
 * Nothing here calls a provider.
 */
import { CANVAS_LIMITS } from './index.js';
import { isCatalogFont } from './fonts/catalog.js';
import type { TextAnalysis, WordProblem } from './protectedWords.js';
import type { MasterInfo } from './masterTemplates.js';
import type { ProductInfo } from './productTemplates.js';

export const PROTECTED_KINDS = ['logo', 'text', 'legal', 'other'] as const;
export type ProtectedKind = typeof PROTECTED_KINDS[number];
export const PROTECTED_KIND_LABELS: Record<ProtectedKind, string> = { logo: 'Logo', text: 'Text', legal: 'Legal / fine print', other: 'Other protected' };
/**
 * How the editor shows an element. raster: the original pixels of its region (a visual copy, never editable text);
 * source-asset: an uploaded original file (a bank's logo PNG), byte for byte; native-text: editable text from the text and
 * style the administrator entered (typeset by the editor, so it matches the original only as far as the font does).
 */
export const PROTECTED_REPRESENTATIONS = ['raster', 'source-asset', 'native-text'] as const;
export type ProtectedRepresentation = typeof PROTECTED_REPRESENTATIONS[number];
/** difference: protected where the source differs from the prepared base by more than `threshold`; opaque: the whole region. */
export type ProtectedMaskMode = 'difference' | 'opaque';
export const PROTECTED_LIMITS = { maxElements: 40, minRegionPx: 4, maxLabel: 120, maxInstructions: 2000, maxNote: 500, minSourceSide: 256, maxSourceBytes: 25 * 1024 * 1024 } as const;
export const DEFAULT_MASK_THRESHOLD = 24;
/** A base whose aspect ratio differs from the source by more than this is refused: protected geometry would not line up. */
export const ASPECT_TOLERANCE = 0.005;

export interface SourceSize { width: number; height: number }
/** Source pixels: the unrotated box and its rotation (degrees, clockwise, about the box centre). */
export interface SourceBox { x: number; y: number; width: number; height: number; rotation: number }
export interface NormalizedBox { x: number; y: number; width: number; height: number }
export interface PixelRect { x: number; y: number; width: number; height: number }

export interface ProtectedText {
  /** Exactly as the administrator typed it, line breaks included. Never guessed from the image. */
  value: string;
  /** The font the creative uses, as the administrator named it; the editor uses fallbackFamily when it does not have it. */
  fontFamily: string; fallbackFamily: string;
  /** Source pixels. */
  fontSize: number; letterSpacing: number;
  fontWeight: 400 | 600 | 700;
  /** A multiple of the font size. */
  lineHeight: number;
  align: 'left' | 'center' | 'right'; verticalAlign: 'top' | 'middle' | 'bottom';
  color: string;
}
/** A stored file: its name in the template folder, and what it is, byte for byte. */
export interface ProtectedAssetRef { file: string; sha256: string; mime: string; width: number; height: number; bytes: number; hasAlpha: boolean; originalName?: string }
/**
 * The element's own pixels, cut from the source: the whole-pixel rectangle around its (rotated) region, never resampled,
 * with an alpha mask (outside a rotated region alpha is 0). `basisSha256`: the prepared base the mask was measured
 * against, so a newer base makes it stale.
 */
export interface ProtectedRaster extends ProtectedAssetRef { placement: PixelRect; opaquePercent: number; protectedPercent: number; basisSha256: string; maskKey: string }

export interface ProtectedElement {
  /** Stable for the template's life: the editor's slots and every reuse refer to it. */
  id: string;
  kind: ProtectedKind; label: string;
  box: SourceBox;
  /** Derived from box on save (fractions of the source size, unrotated box). */
  normalized: NormalizedBox;
  /** Back to front among the protected elements; all of them are drawn above the decomposed artwork. */
  zIndex: number;
  representation: ProtectedRepresentation;
  mask: { mode: ProtectedMaskMode; threshold: number };
  sourceAsset?: ProtectedAssetRef;
  text?: ProtectedText;
  raster?: ProtectedRaster;
  /** Locked in the editor until someone unlocks it there; replaceable: a reuse may give the slot a new logo or text. */
  locked: boolean; replaceable: boolean;
  /** admin: drawn by a person; template-studio: a Template Studio poster's own text or logo; saved-analysis: a region from a
   * template's earlier saved analysis (approximate, always reviewed). */
  origin: 'admin' | 'template-studio' | 'saved-analysis' | 'auto-scan';
  note?: string;
  review: { status: 'needs-review' | 'approved'; at?: string };
}

export type ProtectedSourceOrigin = { kind: 'upload'; filename?: string } | { kind: 'decomposition-run'; runId: string }
  | { kind: 'template-studio-poster'; posterId: string; provenance: 'reference_reuse' | 'ai_generated'; templateName?: string };
export type ProtectedBaseMethod = 'clean-upload' | 'structured-scene' | 'local-fill';
export const PROTECTED_BASE_METHODS: Record<ProtectedBaseMethod, string> = {
  'clean-upload': 'Clean artwork you upload (the creative before text and logos were added)',
  'structured-scene': 'The Template Studio scene (generated without text or logos)',
  'local-fill': 'Fill the protected regions from their surroundings (local, no AI)',
};
/** edgeContentPercent: share of the pixels just outside the region that differ strongly from its surroundings (content the box cuts through). */
export interface ProtectedFillRegion { elementIds: string[]; areaPercent: number; method: 'plain-field' | 'graphic-fill' | 'smooth-fill'; trusted: boolean; reason: string; edgeContentPercent?: number }
export interface ProtectedBase {
  method: ProtectedBaseMethod;
  /** The exact image proposed for Seedream. Any size with the source's aspect ratio; geometry maps through normalized space. */
  file: string; sha256: string; width: number; height: number;
  /** regionsKey: the protected regions it was prepared for; any other regions make it stale. */
  preparedAt: string; regionsKey: string;
  /** clean-upload, structured-scene: the uploaded original, as received. */
  upload?: ProtectedAssetRef;
  /** local-fill: each filled region, how it was continued and whether that can be trusted; and the mask of filled pixels. */
  fill?: { regions: ProtectedFillRegion[]; filledPercent: number; maskFile: string; previewFile: string };
  /** Per element: whether the base differs from the source inside it. A clean base that does not still shows that content. */
  checks: { elementId: string; meanDiff: number; differsFromSource: boolean }[];
  /** Mean largest-channel difference from the source outside the protected regions (0 for a local fill). */
  outsideMeanDiff: number;
  /** reliable: real artwork that passed its checks. uncertain: a local fill (always an estimate where it filled) or a base whose checks failed. */
  reliability: 'reliable' | 'uncertain';
  approval?: { at: string; acknowledgedUncertain: boolean };
}
export interface ProtectedRunLink { runId: string; createdAt: string; idempotencyKey: string; baseSha256: string; elementsRevision: number }
/** 1: the first records (no word analysis). 2: adds `textAnalysis`. Records are read through migrateProtectedTemplate. */
export const PROTECTED_SCHEMA_VERSION = 2;
export interface ProtectedTemplate {
  /** Every record read is migrated to PROTECTED_SCHEMA_VERSION; 1 stays valid in the type so older records still type-check. */
  schemaVersion: 1 | 2;
  id: string; name: string; createdAt: string; updatedAt: string;
  /** Every saved change; a write that names an older revision is refused (two people, or two tabs, editing at once). */
  revision: number;
  source: { file: string; inputFile: string; sha256: string; mime: string; width: number; height: number; bytes: number; orientationNormalized: boolean; origin: ProtectedSourceOrigin };
  coordinateSystem: 'source-pixels';
  elements: ProtectedElement[];
  /** Bumped by every change to the elements: an approval made for an older one is stale. */
  elementsRevision: number;
  /** The regions an administrator confirmed (regionsKey); a base is prepared for confirmed regions only. */
  regionsConfirmed?: { at: string; regionsKey: string };
  base?: ProtectedBase;
  /** Optional instructions for Seedream, written by the administrator; empty sends none (Seedream's automatic mode). */
  layerInstructions: string;
  /** Every decomposition attempt, failed ones included, oldest first. */
  runs: ProtectedRunLink[];
  approval?: { runId: string; at: string; elementsRevision: number; baseSha256: string; reconstructionSha256: string; acknowledged: string[] };
  /**
   * Schema 2: the words and logo slots found inside the protected regions (protectedWords.ts), by a local recognizer only.
   * Kept apart from `elements`, so analysing or correcting words never makes the base, the regions or an approval stale.
   */
  textAnalysis?: TextAnalysis;
  /**
   * A Text & Graphics MASTER template (masterTemplates.ts): its scan, how its artwork is used, and its published
   * revisions. Absent on protected templates made in the Protected Templates workspace.
   */
  master?: MasterInfo;
  /** A Product with Text template (productTemplates.ts): its objects, preparing and revisions. Never set with `master`. */
  product?: ProductInfo;
}

export class ProtectedSchemaError extends Error {
  constructor(readonly found: unknown) { super(`This protected template uses schema ${String(found)}; this version reads 1–${PROTECTED_SCHEMA_VERSION}.`); this.name = 'ProtectedSchemaError'; }
}
/**
 * A stored record in the current schema. 1 → 2 adds nothing required (a template without words has no textAnalysis), so
 * an older record reads unchanged apart from its version; a record of a newer, unknown schema is refused, never guessed.
 */
export function migrateProtectedTemplate(raw: unknown): ProtectedTemplate {
  if (!raw || typeof raw !== 'object') throw new ProtectedSchemaError(undefined);
  const record = raw as ProtectedTemplate;
  if (record.schemaVersion === 1) return { ...record, schemaVersion: 2 };
  if (record.schemaVersion === 2) return record;
  throw new ProtectedSchemaError(record.schemaVersion);
}

export type ProtectedCheckStatus = 'pass' | 'warn' | 'fail';
export interface ProtectedCheck { id: string; label: string; status: ProtectedCheckStatus; detail: string }
export interface ProtectedReconstruction {
  runId: string; file: string; sha256: string; createdAt: string; width: number; height: number;
  /** Seedream's output canvas, and the scale from it to the source. */
  seedreamCanvas: SourceSize; scale: { x: number; y: number };
  layers: number;
  metrics: {
    tolerance: number;
    overall: { meanAbsDiff: number; withinTolerancePercent: number };
    outsideProtected: { meanAbsDiff: number; withinTolerancePercent: number };
    /** opaqueExactPercent: the element's fully opaque pixels identical to the source (100 for an exact restoration). */
    protected: { elementId: string; label: string; representation: ProtectedRepresentation; pixels: number; opaquePixels: number; opaqueExactPercent: number; exactPercent: number; maxDiff: number; meanAbsDiff: number }[];
  };
  /** Whether Seedream's own layers show something like the protected content where it was removed (a duplicate). */
  duplicates: { elementId: string; label: string; suspected: boolean; toSource: number; toBase: number }[];
  blockers: string[]; warnings: string[];
}
export type ProtectedStatus = 'annotating' | 'preparing-base' | 'ready' | 'decomposing' | 'interrupted' | 'failed' | 'review' | 'approved';
export interface ProtectedRunSummary {
  runId: string; stage: string; active: boolean; createdAt: string;
  error?: { code: string; message: string; provider?: { status: number; messages: { msg: string; type?: string; loc?: string; reason?: string }[]; billableUnits?: string; requestId?: string } };
  rejection?: { category: string; reason?: string; billableUnits?: string; requestId?: string };
  requestId?: string; editorLayers: number; usable: boolean; problems: string[];
  /** The run's base, the same as the template's current one. */
  current: boolean;
}
/** What the API answers: the record plus what is derived from it and its runs on every read. */
export interface ProtectedTemplateView extends ProtectedTemplate {
  status: ProtectedStatus;
  problems: ProtectedProblem[];
  latestRun?: ProtectedRunSummary;
  reconstruction?: ProtectedReconstruction;
  /** Problems of the word analysis (protectedWords.ts analysisProblems), when there is one. */
  wordProblems?: WordProblem[];
  /** textAnalysis: the words were read for other regions or another source; analyse again (absent: no analysis yet). */
  stale: { base: boolean; approval: boolean; textAnalysis?: boolean };
}
export interface ProtectedProblem { severity: 'error' | 'warning'; code: string; message: string; elementId?: string }

/** Where an element sits in an editor document: kept on its layer or text so a replacement keeps the slot. */
export interface ProtectedSlot {
  templateId: string; elementId: string; kind: ProtectedKind; representation: ProtectedRepresentation;
  /** A single word of the region (protectedWords.ts): its id, phrase, line and reading order. Phrase tools act on the group. */
  word?: { id: string; groupId: string; lineId: string; order: number; role?: string; protected?: boolean };
  /** One logo of the region (protectedWords.ts LogoSlot): replacing its picture keeps the slot. */
  logoSlotId?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------------------------------
const TEMPLATE_ID = /^pt-[a-f0-9]{12}$/, ELEMENT_ID = /^pe-[a-f0-9]{10}$/;
export const validProtectedTemplateId = (id: unknown): id is string => typeof id === 'string' && TEMPLATE_ID.test(id);
export const validProtectedElementId = (id: unknown): id is string => typeof id === 'string' && ELEMENT_ID.test(id);

// ---------------------------------------------------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------------------------------------------------
const round = (v: number, digits = 6) => Math.round(v * 10 ** digits) / 10 ** digits;
export const normalizeBox = (box: SourceBox, size: SourceSize): NormalizedBox =>
  ({ x: round(box.x / size.width), y: round(box.y / size.height), width: round(box.width / size.width), height: round(box.height / size.height) });
export const fromNormalized = (n: NormalizedBox, size: SourceSize, rotation = 0): SourceBox =>
  ({ x: n.x * size.width, y: n.y * size.height, width: n.width * size.width, height: n.height * size.height, rotation });
/** The four corners of the rotated box, clockwise from its own top-left. */
export function boxCorners(box: SourceBox): [number, number][] {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2, a = box.rotation * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
    const dx = sx * box.width / 2, dy = sy * box.height / 2;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  });
}
/** The axis-aligned bounds of the rotated box (fractional). */
export function boundingBox(box: SourceBox): PixelRect {
  const c = boxCorners(box), xs = c.map(p => p[0]), ys = c.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
/** The whole-pixel rectangle around the rotated box, clipped to the canvas: what a raster keeps, never resampled. */
export function pixelBounds(box: SourceBox, size: SourceSize): PixelRect | undefined {
  const b = boundingBox(box), eps = 1e-6;
  const x0 = Math.max(0, Math.floor(b.x + eps)), y0 = Math.max(0, Math.floor(b.y + eps));
  const x1 = Math.min(size.width, Math.ceil(b.x + b.width - eps)), y1 = Math.min(size.height, Math.ceil(b.y + b.height - eps));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : undefined;
}
/** Whether a source point lies inside the rotated box. */
export function insideBox(box: SourceBox, px: number, py: number): boolean {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2, a = -box.rotation * Math.PI / 180;
  const dx = px - cx, dy = py - cy, lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= box.width / 2 && Math.abs(ly) <= box.height / 2;
}
/** Share (0..1) of the box's own area that lies on the canvas, measured on a 24×24 grid inside the rotated box. */
export function onCanvasShare(box: SourceBox, size: SourceSize): number {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2, a = box.rotation * Math.PI / 180, n = 24;
  let inside = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const dx = ((i + 0.5) / n - 0.5) * box.width, dy = ((j + 0.5) / n - 0.5) * box.height;
    const x = cx + dx * Math.cos(a) - dy * Math.sin(a), y = cy + dx * Math.sin(a) + dy * Math.cos(a);
    if (x >= 0 && y >= 0 && x <= size.width && y <= size.height) inside++;
  }
  return inside / (n * n);
}
/**
 * The editor (and an image layer) rotates about its own origin (x, y), not about the centre: the origin that puts the same
 * rotated box in the same place.
 */
export function centreRotationToOrigin(box: SourceBox): { x: number; y: number } {
  const [topLeft] = boxCorners(box);
  return { x: topLeft[0], y: topLeft[1] };
}
/** A box in another canvas of the same picture (Seedream's output, the editor, an export size), by normalized position. */
export function mapBox(box: SourceBox, from: SourceSize, to: SourceSize): SourceBox {
  const sx = to.width / from.width, sy = to.height / from.height;
  return { x: box.x * sx, y: box.y * sy, width: box.width * sx, height: box.height * sy, rotation: box.rotation };
}
export const aspectDifference = (a: SourceSize, b: SourceSize) => Math.abs((a.width / a.height) / (b.width / b.height) - 1);
export const sameAspect = (a: SourceSize, b: SourceSize, tolerance = ASPECT_TOLERANCE) => aspectDifference(a, b) <= tolerance;
/**
 * The editor canvas for a source: its own size, scaled down (never up) to the editor's limits. `scale` maps source pixels
 * to it; whole-pixel rounding makes x and y differ by at most one pixel over the canvas.
 */
export function protectedEditorCanvas(source: SourceSize, limits: { maxSide: number; maxArea: number } = CANVAS_LIMITS): { width: number; height: number; scale: { x: number; y: number } } {
  const s = Math.min(1, limits.maxSide / source.width, limits.maxSide / source.height, Math.sqrt(limits.maxArea / (source.width * source.height)));
  const width = Math.floor(source.width * s), height = Math.floor(source.height * s);
  return { width, height, scale: { x: width / source.width, y: height / source.height } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------------
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const hex = (v: unknown) => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v);
export const editorFontFor = (text: Pick<ProtectedText, 'fontFamily' | 'fallbackFamily'>) => isCatalogFont(text.fontFamily) ? text.fontFamily : isCatalogFont(text.fallbackFamily) ? text.fallbackFamily : 'Inter';
export function textProblems(text: ProtectedText | undefined): string[] {
  if (!text) return ['Text details are missing.'];
  const out: string[] = [];
  if (typeof text.value !== 'string' || !text.value.trim() || text.value.length > 5000) out.push('Enter the text exactly as it appears (up to 5000 characters).');
  if (typeof text.fontFamily !== 'string' || !text.fontFamily.trim() || text.fontFamily.length > 120) out.push('Name the font family.');
  if (!isCatalogFont(text.fallbackFamily)) out.push('Choose a fallback font the editor has.');
  if (!finite(text.fontSize) || text.fontSize < 1 || text.fontSize > 4096) out.push('Font size must be 1–4096 source pixels.');
  if (![400, 600, 700].includes(text.fontWeight)) out.push('Font weight must be 400, 600 or 700.');
  if (!finite(text.lineHeight) || text.lineHeight < 0.5 || text.lineHeight > 4) out.push('Line height must be 0.5–4 times the font size.');
  if (!finite(text.letterSpacing) || Math.abs(text.letterSpacing) > 200) out.push('Letter spacing must be within ±200 source pixels.');
  if (!['left', 'center', 'right'].includes(text.align) || !['top', 'middle', 'bottom'].includes(text.verticalAlign)) out.push('Choose an alignment.');
  if (!hex(text.color)) out.push('Text color must be a #RRGGBB colour.');
  return out;
}
/** Everything wrong with one element on a source of this size: errors block confirmation, warnings are shown. */
export function elementProblems(e: ProtectedElement, size: SourceSize): ProtectedProblem[] {
  const out: ProtectedProblem[] = [], at = (severity: ProtectedProblem['severity'], code: string, message: string) => out.push({ severity, code, message: `${e.label || e.id}: ${message}`, elementId: e.id });
  const b = e.box;
  if (![b.x, b.y, b.width, b.height, b.rotation].every(finite)) { at('error', 'INVALID_GEOMETRY', 'its position is not a number.'); return out; }
  if (b.width < PROTECTED_LIMITS.minRegionPx || b.height < PROTECTED_LIMITS.minRegionPx) at('error', 'REGION_TOO_SMALL', `a region must be at least ${PROTECTED_LIMITS.minRegionPx}×${PROTECTED_LIMITS.minRegionPx} source pixels.`);
  if (Math.abs(b.rotation) > 180) at('error', 'INVALID_ROTATION', 'rotation must be between −180° and 180°.');
  const share = onCanvasShare(b, size);
  if (share < 0.5) at('error', 'OFF_CANVAS', `only ${Math.round(share * 100)}% of it is on the image. Move it onto the creative.`);
  else if (share < 0.999) at('warning', 'PARTLY_OFF_CANVAS', `${Math.round((1 - share) * 100)}% of it is outside the image and is clipped.`);
  if (!PROTECTED_KINDS.includes(e.kind)) at('error', 'INVALID_KIND', 'choose logo, text, legal or other.');
  if (typeof e.label !== 'string' || !e.label.trim() || e.label.length > PROTECTED_LIMITS.maxLabel) at('error', 'INVALID_LABEL', `give it a name (up to ${PROTECTED_LIMITS.maxLabel} characters).`);
  if (!finite(e.mask?.threshold) || e.mask.threshold < 1 || e.mask.threshold > 255 || !['difference', 'opaque'].includes(e.mask.mode)) at('error', 'INVALID_MASK', 'its mask settings are invalid.');
  if (e.representation === 'native-text') for (const p of textProblems(e.text)) at('error', 'TEXT_INCOMPLETE', p);
  else if (e.text) for (const p of textProblems(e.text)) at('warning', 'TEXT_INCOMPLETE', `${p} (only needed to make it editable text).`);
  if (e.representation === 'source-asset' && !e.sourceAsset) at('error', 'SOURCE_ASSET_MISSING', 'upload its original file, or keep the original pixels instead.');
  if (e.representation === 'source-asset' && e.sourceAsset && !e.sourceAsset.hasAlpha) at('warning', 'OPAQUE_SOURCE_ASSET', 'its original file has no transparency, so its own background shows as a box around it. Use a transparent PNG if there is one.');
  if (e.representation === 'native-text' && e.text && !isCatalogFont(e.text.fontFamily)) at('warning', 'FONT_FALLBACK', `the editor does not have "${e.text.fontFamily}"; it uses ${editorFontFor(e.text)}, so the text will not match the original exactly.`);
  if (e.note !== undefined && (typeof e.note !== 'string' || e.note.length > PROTECTED_LIMITS.maxNote)) at('error', 'INVALID_NOTE', `notes are limited to ${PROTECTED_LIMITS.maxNote} characters.`);
  return out;
}
/** Problems of the whole set: each element's, duplicate ids and z-orders, and overlaps (shown, not refused). */
export function elementsProblems(elements: ProtectedElement[], size: SourceSize): ProtectedProblem[] {
  const out = elements.flatMap(e => elementProblems(e, size));
  if (elements.length > PROTECTED_LIMITS.maxElements) out.push({ severity: 'error', code: 'TOO_MANY_ELEMENTS', message: `At most ${PROTECTED_LIMITS.maxElements} protected elements.` });
  if (new Set(elements.map(e => e.id)).size !== elements.length || elements.some(e => !validProtectedElementId(e.id))) out.push({ severity: 'error', code: 'INVALID_IDS', message: 'Element ids must be unique.' });
  if (new Set(elements.map(e => e.zIndex)).size !== elements.length) out.push({ severity: 'error', code: 'INVALID_ORDER', message: 'Each protected element needs its own place in the order.' });
  for (let i = 0; i < elements.length; i++) for (let j = i + 1; j < elements.length; j++) {
    const a = boundingBox(elements[i].box), b = boundingBox(elements[j].box);
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    if (w > 0 && h > 0 && w * h > 0.02 * Math.min(a.width * a.height, b.width * b.height)) out.push({ severity: 'warning', code: 'OVERLAP', elementId: elements[j].id,
      message: `${elements[i].label} and ${elements[j].label} overlap; the one later in the order is drawn on top.` });
  }
  return out;
}
/** An element as saved: normalized values derived from its box, nothing else changed. */
export const withNormalized = (e: ProtectedElement, size: SourceSize): ProtectedElement => ({ ...e, normalized: normalizeBox(e.box, size) });
/** Whether a change to an element changes what is protected (its region, its mask, or how it is shown). */
export function geometryChanged(a: ProtectedElement, b: ProtectedElement): boolean {
  return JSON.stringify([a.box, a.mask, a.representation, a.sourceAsset?.sha256, a.zIndex]) !== JSON.stringify([b.box, b.mask, b.representation, b.sourceAsset?.sha256, b.zIndex]);
}
/** The regions themselves (ids and boxes): what a confirmation and a prepared base are made for. */
export const regionsKey = (elements: Pick<ProtectedElement, 'id' | 'box'>[]) => JSON.stringify([...elements].sort((a, b) => a.id.localeCompare(b.id)).map(e => [e.id, e.box.x, e.box.y, e.box.width, e.box.height, e.box.rotation]));
/** What a raster is cut for: its region and mask on one base. */
export const maskKey = (e: Pick<ProtectedElement, 'box' | 'mask'>, baseSha256: string) => JSON.stringify([e.box.x, e.box.y, e.box.width, e.box.height, e.box.rotation, e.mask.mode, e.mask.threshold, baseSha256]);
