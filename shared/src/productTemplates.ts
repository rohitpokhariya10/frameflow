/**
 * Product with Text templates: one creative analysed once into its parts, then reused.
 *
 *   overlays   text (word level, edited as blocks), brand, bank and payment logos, QR codes and text plates: the template's
 *              editable layers. They are never part of the picture sent to any decomposition or segmentation provider
 *              (the server checks the picture it sends: product/prepare.ts).
 *   objects    the template's visual parts, each on its own: every character and every product has a slot and cutout.
 *              Podiums, frames and decorations are recorded as background structure; legacy brand objects require review.
 *   base       the picture with the overlays and the objects taken out and the background continued behind them.
 *
 * Coordinates are source pixels of the template's own creative (the upload, or the one creative cropped from a reference
 * sheet; the sheet and the crop are recorded). Text and logo details reuse the Text & Graphics word model
 * (protectedWords.ts); a product template is a protected-template record with `product` set (never `master`), so the
 * Text & Graphics pipeline never reads it.
 */
import type { PixelRect, SourceBox, SourceSize } from './protectedContent.js';
import type { DetectedWord, LogoSlot, WordGroup } from './protectedWords.js';
import type { CreativeGroup, CreativeImage, CreativeShape, CreativeText, TextPlate } from './masterTemplates.js';

export const PRODUCT_SCHEMA_VERSION = 1;
/** Version of the preparing (overlay removal, separation, base): a revision records the one that made it. */
export const PRODUCT_PREPARE_VERSION = 6;

export const PRODUCT_OBJECT_KINDS = ['character', 'product', 'brand-logo', 'podium', 'frame', 'decoration'] as const;
export type ProductObjectKind = typeof PRODUCT_OBJECT_KINDS[number];
/** Every kind an element can be given in the review (the overlays included). */
export const PRODUCT_ELEMENT_KINDS = ['text', 'bank-logo', 'qr', ...PRODUCT_OBJECT_KINDS] as const;
export type ProductElementKind = typeof PRODUCT_ELEMENT_KINDS[number];
export const PRODUCT_KIND_LABELS: Record<ProductElementKind, { one: string; many: string }> = {
  text: { one: 'Text', many: 'Text' }, 'bank-logo': { one: 'Logo', many: 'Logos' }, qr: { one: 'QR code', many: 'QR codes' },
  character: { one: 'Character', many: 'Characters' }, product: { one: 'Product', many: 'Products' }, 'brand-logo': { one: 'Brand logo', many: 'Brand logos' },
  podium: { one: 'Podium', many: 'Podiums' }, frame: { one: 'Frame', many: 'Frames' }, decoration: { one: 'Decoration', many: 'Decorations' },
};
/** The groups the review list and the editor show, in this order. */
export const PRODUCT_LAYER_GROUPS = [
  { id: 'characters', label: 'Characters', kinds: ['character'] },
  { id: 'products', label: 'Products', kinds: ['product'] },
  { id: 'text', label: 'Text', kinds: ['text'] },
  { id: 'logos', label: 'Logos', kinds: ['brand-logo', 'bank-logo', 'qr'] },
  { id: 'background', label: 'Background & decorations', kinds: ['podium', 'frame', 'decoration'] },
] as const satisfies readonly { id: string; label: string; kinds: readonly ProductElementKind[] }[];
/** Overlays stay editable and out of every provider's input; the rest are the template's visual objects. */
export const isOverlayKind = (k: ProductElementKind) => k === 'text' || k === 'brand-logo' || k === 'bank-logo' || k === 'qr';
/** Kinds with a slot: a replacement image is fitted there. */
export const hasSlot = (k: ProductElementKind) => k === 'character' || k === 'product';
/** Whether an object is cut out as an image layer of its own (see ProductObject.decompose; podiums: their `layer`). */
export function decomposesObject(o: { kind: ProductObjectKind; hidden?: boolean; decompose?: boolean; layer?: 'own' | 'background' }): boolean {
  if (o.hidden) return false;
  if (o.kind === 'character' || o.kind === 'product') return o.decompose !== false;
  if (o.kind === 'decoration' || o.kind === 'frame') return o.decompose === true;
  return false;
}

/**
 * Back to front: the frame, decorations and podiums behind what stands on them, then characters and products (lower in
 * the picture is nearer), the brand logo on top.
 */
export const PRODUCT_LAYER_RANK: Record<ProductObjectKind, number> = { frame: 0, decoration: 1, podium: 2, character: 3, product: 3, 'brand-logo': 4 };
/**
 * Back to front: by kind (supports behind what stands on them), then by where each stands (the lower foot nearer). Of two
 * overlapping products, the smaller is in front when a large part of it (30 % of its box) lies over the other
 * — phones, earbuds or headphones in front of a laptop stand on a line a little higher than its front edge, yet nothing
 * shown in an advertisement is mostly hidden — and of two standing on the same line the smaller is in front.
 */
export function orderProductObjects<T extends { kind: ProductObjectKind; box: PixelRect }>(objects: T[]): T[] {
  const base = [...objects].sort((a, b) => PRODUCT_LAYER_RANK[a.kind] - PRODUCT_LAYER_RANK[b.kind] || (a.box.y + a.box.height) - (b.box.y + b.box.height) || a.box.x - b.box.x);
  const area = (b: PixelRect) => Math.max(1, b.width * b.height);
  const overlap = (a: PixelRect, b: PixelRect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  // in front of: for each object, the ones that must be behind it.
  const behind = new Map<T, Set<T>>(base.map(o => [o, new Set<T>()]));
  for (let i = 0; i < base.length; i++) for (let j = i + 1; j < base.length; j++) {
    const a = base[i], b = base[j]; // a is behind b in the base order
    // (Products only: a character's hand in front of a product, its box over the product's, keeps the character in front.)
    if (a.kind !== 'product' || b.kind !== 'product') continue;
    const o = overlap(a.box, b.box); if (!o) continue;
    const [small, large] = area(a.box) <= area(b.box) ? [a, b] : [b, a];
    const sameLine = Math.abs((a.box.y + a.box.height) - (b.box.y + b.box.height)) <= 0.06 * Math.max(a.box.height, b.box.height);
    if (o / area(small.box) >= 0.3 || sameLine) behind.get(small)!.add(large);
  }
  // A stable topological order: the base order, each object after every one that must be behind it.
  const out: T[] = [], placed = new Set<T>();
  while (out.length < base.length) {
    const next = base.find(o => !placed.has(o) && [...behind.get(o)!].every(p => placed.has(p) || behind.get(p)!.has(o)))
      ?? base.find(o => !placed.has(o))!;
    out.push(next); placed.add(next);
  }
  return out;
}
/** Below this an element is shown under "Needs attention"; at or above it, it is accepted without a click. */
export const PRODUCT_ATTENTION_BELOW = 0.7;
export type ProductReviewStatus = 'accepted' | 'attention' | 'rejected';
export interface ProductReview { status: ProductReviewStatus; reason?: string; at?: string; by: 'auto' | 'user' }

/** Where a replacement goes: inside `box`, standing on `contactY` (its lowest opaque row), at most `targetHeight` tall. */
export interface ProductSlot { box: PixelRect; contactY: number; targetHeight: number; z: number }
export interface ProductCutout {
  /** The object's own pixels with transparency, at `placement` (source pixels). */
  file: string; sha256: string; placement: PixelRect;
  /** How its pixels were told from the background: a segmentation provider's mask, or the local estimate. */
  method: 'sam3' | 'local' | 'upload' | 'layer' | 'seedream';
  /** Share of its box it covers, and whether it needs a look (a mask that fills its whole box or almost nothing of it). */
  coverage: number; quality: 'good' | 'check'; note?: string;
}
export interface ProductObject {
  id: string; kind: ProductObjectKind; label: string;
  category?: string;
  source?: { crop: string; box: PixelRect; sha256: string };
  box: PixelRect;
  confidence: number;
  /** Back to front among objects; `covers`: the objects this one is in front of (where they overlap). */
  z: number; covers: string[];
  origin: 'ai' | 'local' | 'user';
  review: ProductReview;
  hidden?: boolean;
  /**
   * A podium or stand: its own layer (separated from the products and the background, completed where they hide it,
   * movable), or part of the background (a stand found automatically in its box stays there). Unset: the shared podium,
   * in the background.
   */
  layer?: 'own' | 'background';
  /**
   * Sent to image decomposition (cut out as a layer of its own, the background rebuilt behind it), as the person chose:
   * unset, characters and products are and decorations and frames are not (decomposesObject). A podium's choice is its
   * `layer`. Text and logos are never decomposed: they are overlays.
   */
  decompose?: boolean;
  /** Set when the template is prepared. */
  cutout?: ProductCutout;
  slot?: ProductSlot;
}

/** One creative chosen from a reference sheet: the sheet is kept as it was, the creative is cropped exactly (no resampling). */
export interface ProductSheetCrop { file: string; sha256: string; width: number; height: number; crop: PixelRect }
/** The picture sent to the vision analysis: its size and encoding, and the creative's own size. */
export interface ProductAnalysisSent { width: number; height: number; mime: string; bytes: number; source: { width: number; height: number } }
export interface ProductDetection {
  /** A failed refresh never replaces a completed analysis or its manual corrections. */
  lastFailure?: { at: string; message: string };
  status: 'running' | 'done' | 'failed';
  startedAt: string; finishedAt?: string; sourceSha256: string;
  /** The local reading (free): words, text blocks, logo cards, QR codes. */
  local?: { words: number; blocks: number; logos: number; qr: number; durationMs: number };
  /** The vision analysis (one paid request when a key is configured; the offline test analyser otherwise). */
  ai?: { status: 'done' | 'skipped' | 'failed'; model?: string; offline?: boolean; error?: string; objects?: number; costUsd?: number;
    /** A failure's cause: its code (TIMEOUT, CONNECTION, NO_CREDIT, RATE_LIMIT, AUTHORIZATION, REQUEST_TOO_LARGE,
     * REQUEST_REJECTED, PROVIDER_ERROR, INCOMPLETE, REFUSAL, INVALID_RESPONSE, …), the HTTP status when there was one,
     * how long it waited. */
    code?: string; httpStatus?: number; elapsedMs?: number;
    /** The picture the model was given (a copy at most 2048 px on its longest side) and the creative it came from. */
    sent?: ProductAnalysisSent };
  /** Detection run again on a reviewed template: the corrections kept (they win over what was found at their place). */
  kept?: { objects: number; words: number; logos: number; replaced: number };
  /** Advertising text the analysis saw where the local reading found none: shown for a quick check (add it, or ignore it). */
  missingText?: { text: string; box: PixelRect }[];
  error?: string;
}
/** A check of the prepared template: where it passes and what needs a look (`blocking`: it may not be saved as it is). */
export interface ProductQualityIssue { id: string; area: PixelRect; message: string; blocking: boolean; elementId?: string }
export interface ProductQuality {
  /** Canvas share whose hidden background is unavailable and kept transparent (older preparations; now always 0). */
  unavailablePercent?: number;
  /** Canvas share behind the objects that was never visible and was rebuilt from the surrounding artwork (an estimate). */
  reconstructedPercent?: number;
  /** Original creative vs the template's layers recombined (base + objects + overlays), and the overlay-free picture vs base + objects. */
  original: { meanDiff: number; visiblePercent: number };
  clean: { meanDiff: number; visiblePercent: number };
  /** Of the pixels behind removed overlays and objects: rebuilt from the background's own structure, or estimated. */
  rebuiltPercent: number; estimatedPercent: number;
  issues: ProductQualityIssue[];
}
export interface ProductPrepared {
  version: typeof PRODUCT_PREPARE_VERSION;
  at: string; objectsRevision: number; analysisRevision: number;
  /** The picture without the overlays: the only picture a provider may receive. */
  clean: { file: string; sha256: string };
  /** The picture without overlays and objects: what is behind everything. */
  base: { file: string; sha256: string };
  /** Recombined previews (with and without overlays) and the removal mask. */
  previews: { recombined: string; recombinedClean: string; overlayMask: string; /** The text and logos alone (the original's pixels where they are, clear elsewhere); absent on older preparations. */ overlays?: string;
    /** Where the background is an estimate (amber: guessed; blue: the scene's structure continued); absent on older preparations. */ estimated?: string };
  separation: { method: 'sam3' | 'local' | 'seedream'; requests: number; costUsd: number; inputSha256?: string; ai?: ProductAiSeparation };
  quality: ProductQuality;
  /**
   * Display stands (the pedestals and platforms products stand on): their own layers under the products, each with its
   * cut-out (`podium` kind; `origin` local when found, user when the administrator marked it). Absent on older preparations.
   */
  stands?: (ProductObject & { stand: { under: string[]; visiblePixels: number; completedPixels: number; uncertain: boolean } })[];
  durationMs: number;
}
export interface ProductRevisionRef { revision: number; file: string; sha256: string; publishedAt: string; /** A draft saved with quality warnings. */ draft?: boolean }
export interface ProductHistoryEntry { at: string; action: 'created' | 'cropped' | 'detected' | 'reviewed' | 'prepared' | 'approved' | 'saved'; detail?: string }
export interface ProductInfo {
  /** Recoverable editor entry for this preparation; opening it again reuses the same creative and run. */
  editorDraft?: { objectsRevision: number; analysisRevision: number; baseSha256: string; revision: number; creativeId?: string };
  version: typeof PRODUCT_SCHEMA_VERSION;
  type: 'product-text';
  sheet?: ProductSheetCrop;
  detection?: ProductDetection;
  objects: ProductObject[];
  /** Bumped by every change to the objects or the overlays' classification: a prepared template of an older one is stale. */
  objectsRevision: number;
  prepared?: ProductPrepared;
  /** The preparing in progress, or how the last one ended (with what went wrong). */
  preparing?: { status: 'running' | 'done' | 'failed'; startedAt: string; paid: boolean; error?: string; engine?: 'ai' | 'sam3' | 'local' };
  /** The person chose what is decomposed (each object's `decompose`, each logo's `inBackground`) for this objects revision. */
  selection?: { at: string; objectsRevision: number };
  /** How new creatives made from it should look (see ProductGenerationBrief); kept apart from the decomposition. */
  generation?: ProductGenerationBrief;
  /**
   * A template made from a generated variation ("Decompose & Edit"): where it came from, and the variation's own files —
   * its background, its picture without text and logos, each element's layer at its place, its composition as the
   * detection's answer. Native layers are reference data; explicit AI preparation obtains new object masks (product/variationTemplate.ts).
   */
  variation?: { decompositionEngine?: 'ai'; templateId: string; revision: number; jobId: string; index: number; title: string; background: string; clean: string; cleanSha256?: string;
    layers: { label: string; kind: ProductObjectKind; box: PixelRect; file: string }[]; plates?: { box: PixelRect; file: string }[]; answer: string; words: string };
  /** The administrator saw the prepared template and its checks and accepted it (with the issues listed then). */
  approved?: { at: string; objectsRevision: number; baseSha256: string; acknowledged: string[]; /** Saved as a draft with blocking quality warnings, as the person chose. */ draft?: boolean };
  revisions: ProductRevisionRef[];
  /** Local reads and paid requests so far (reuse never adds to it). */
  activity: { scans: number; aiCalls: number; segmentRequests: number; costUsd: number };
  history: ProductHistoryEntry[];
}
export type ProductStage = 'detecting' | 'detect-failed' | 'review' | 'preparing' | 'prepared' | 'ready' | 'changed';

/**
 * How new creatives made from a template should look (its generation instructions), apart from how the template was
 * decomposed. Structured, so that variations are planned from it without anyone writing a prompt; `prompt` is the
 * artwork instruction made from it (editable). `source`: the prompt the creative was originally generated with, or
 * written by FrameFlow from the AI detection ("derived": never presented as the original prompt).
 */
export interface ProductGenerationBrief {
  source: 'original' | 'derived';
  /** What the creative is (the detection's summary). */
  subject: string;
  characters: { label: string; description: string }[];
  products: { label: string; description: string }[];
  /** Logos kept as their own layers (never drawn by an image model) and the brand rules. */
  brand: { logos: string[]; rules: string };
  style: string; palette: string[]; background: string; layout: string; typography: string;
  /** The approved copy, by role: used as it is, never rewritten (offers, prices, dates, legal text). */
  copy: { role: string; text: string }[];
  /** What an artwork must never contain. */
  negative: string;
  aspectRatio: string;
  /** The artwork instruction made from the fields above (what the image model receives with the layout's space). */
  prompt: string;
  derivedAt: string;
  /** Set when the person changed it (a later derivation does not overwrite it). */
  edited?: { at: string };
}
/**
 * The AI decomposition of a prepare (protectedTemplates/product/aiDecompose.ts): the OpenAI planner's prompt and the one
 * Seedream Layerize request, on the picture without text and overlay logos; which elements got Seedream's layers.
 */
export interface ProductAiSeparation {
  planner: string; engine: string;
  /** An offline stand-in (tests, demo): no model was called. */
  offline: boolean;
  prompt: string; requestId?: string; layers: number;
  matched: string[]; unmatched: string[];
  /** Share of the canvas whose background is Seedream's reconstruction. */
  backgroundPercent: number;
  sentSize: { width: number; height: number };
  warnings: string[];
}
/** How a template was decomposed: what was chosen, kept, and how; reused when it is decomposed again (or a variation is). */
export interface ProductDecompositionPlan {
  elements: { id: string; label: string; kind: ProductObjectKind; decompose: boolean }[];
  logosKeptInPicture: string[];
  overlays: { textBlocks: number; words: number; logos: number };
  method: 'sam3' | 'local' | 'seedream';
  prepareVersion: number;
  /** In plain words, for a person and for the next decomposition. */
  instructions: string;
}

/** Everything a creative of one revision reads. Written once when the template is saved; never changed. */
export interface ProductSnapshot {
  /** Native editor state for this revision; original detection and provider metadata remain alongside it. */
  editorCreative?: ProductCreative;
  /** Complete provider provenance at this revision, alongside the reviewed selection and quality report. */
  preparation?: ProductPrepared;
  selectedObjects?: ProductObject[];
  detection?: ProductDetection;
  backgroundStructure?: ProductObject[];
  schemaVersion: typeof PRODUCT_SCHEMA_VERSION;
  templateId: string; revision: number; publishedAt: string; name: string;
  canvas: SourceSize;
  source: { file: string; sha256: string };
  clean: { file: string; sha256: string };
  base: { file: string; sha256: string };
  objects: ProductObject[];
  words: DetectedWord[]; groups: WordGroup[]; logoSlots: LogoSlot[]; plates: TextPlate[];
  quality: ProductQuality;
  prepareVersion: number;
  /** Saved as a draft: the quality warnings it was saved with (blocking ones included). */
  draft?: { warnings: { id: string; message: string; blocking: boolean }[] };
  /** The generation instructions and the decomposition plan at the time it was saved. */
  generation?: ProductGenerationBrief;
  decomposition?: ProductDecompositionPlan;
}

// ---------------------------------------------------------------------------------------------------------------------
// Creatives: a saved revision reused (its objects replaced, its text and logos edited), each save a new revision file
// ---------------------------------------------------------------------------------------------------------------------
export const PRODUCT_CREATIVE_SCHEMA_VERSION = 1;
/** An object's picture: the template's own cut-out, or an uploaded picture (its background removed locally when it could be). */
export type ProductObjectAsset =
  | { kind: 'template'; file: string }
  | { kind: 'upload'; file: string; sha256: string; width: number; height: number; originalName?: string;
      /** transparent: the upload had its own transparency; removed: a plain backdrop was taken out locally; kept: it could not be (a photo's scene). */
      background: 'transparent' | 'removed' | 'kept' };
export interface ProductCreativeObject {
  id: string;
  /** The template object it is (its slot); null for one added here. */
  objectId: string | null;
  kind: ProductObjectKind; label: string;
  asset: ProductObjectAsset;
  /** Where it is drawn (source pixels; the picture's own proportions). */
  box: PixelRect & { rotation?: number };
  opacity?: number; locked?: boolean;
  hidden: boolean; z: number;
}
export type ProductCreativeOrigin = { kind: 'template' } | { kind: 'duplicate'; creativeId: string; revision: number } | { kind: 'variation'; jobId: string; index: number } | { kind: 'reuse'; draftId: string; ratio: ReuseAspectRatio };
/**
 * A creative's own background picture (a variation in another aspect ratio or style): full canvas, one of the creative's
 * files. Absent: the template revision's prepared base is the background.
 *   template      the base as it is
 *   plain-bands   the base with its plain margins (rows or columns of one colour) made longer: exact, nothing invented
 *   letterbox     the base with plain colour margins added on two sides: the margins are new (a plain fill, flagged)
 *   restyled      any of these with the style's colour treatment (saturation, brightness, tint)
 */
export interface ProductCreativeBackground {
  file: string; sha256: string; width: number; height: number;
  method: 'template' | 'plain-bands' | 'letterbox' | 'ai-artwork' | 'local-backdrop' | 'slice' | 'mirror-extend'; restyled: boolean;
  /** Share of the canvas that is new fill (letterbox margins), percent. */
  filledPercent: number;
  /** Made from the template's stage with its painted display stands rebuilt away (Reuse Template; a cached file of its own). */
  stageCleaned?: boolean;
  /** New artwork (a recomposed variation): the image model and its prompt, or the local preset; text the local reader found in it. */
  artwork?: { model: string; offline: boolean; prompt?: string; textFound: string[]; costUsd?: number; requestId?: string };
}
/** How a variation's layout was made from the template's: its aspect ratio, and the transform from template coordinates. */
export interface ProductCreativeLayout {
  aspectRatio: ProductAspectRatio;
  /** The template revision's canvas; every element keeps its template element id (wordId, slotId, objectId) to map back. */
  sourceCanvas: SourceSize;
  /** Uniform scale from template to creative pixels, and which axis was lengthened (the extra space and where it went). */
  scale: number; axis: 'none' | 'x' | 'y';
  extra: { before: number; after: number };
  /** Plain margins of the template (template pixels) that were lengthened; absent with a letterbox. */
  bands?: { start: number; end: number };
  /** Recomposed for new artwork (composition.ts): the archetype every element was placed with. */
  composition?: string;
  /** The stage found in the new artwork (an ellipse: centre, half-width, top-surface depth; canvas pixels) the products stand on; null: none found. */
  stage?: { cx: number; cy: number; a: number; b: number } | null;
}
export interface ProductCreative {
  masterEditing?: true;
  /** Editor saves use one common z-order for objects, logos, shapes and text. */
  absoluteZOrder?: true;
  schemaVersion: typeof PRODUCT_CREATIVE_SCHEMA_VERSION;
  id: string; templateId: string; templateRevision: number;
  name: string; createdAt: string; updatedAt: string;
  /** Each save is a new revision (its own file); earlier ones stay. */
  revision: number;
  canvas: SourceSize;
  groups: CreativeGroup[]; texts: CreativeText[]; images: CreativeImage[]; shapes: CreativeShape[];
  objects: ProductCreativeObject[];
  origin: ProductCreativeOrigin;
  /** A generated variation: what it is, what was asked for, and its checks. */
  variation?: ProductVariationInfo;
  /** A background of its own (another aspect ratio or style); absent: the template's base. */
  background?: ProductCreativeBackground;
  /** The editor's raw background and transform, alongside the full-canvas preview raster. */
  backgroundSource?: { file: string; box: SourceBox; hidden: boolean; locked: boolean; opacity: number; z?: number };
  canvasFill?: { color: string; transparent: boolean };
  /** Set when the layout was made for another aspect ratio (the template's coordinates map through it). */
  layout?: ProductCreativeLayout;
  history: { at: string; action: 'created' | 'edited' | 'replaced' | 'restored' | 'duplicated' | 'generated'; detail?: string }[];
}
export const PRODUCT_CREATIVE_LIMITS = { maxCreatives: 500, maxHistory: 200 } as const;

/**
 * Where a new picture goes in a slot: as tall as the slot's target (as wide as it may be: at most 1.3 times the slot),
 * standing on its contact line, centred where the slot is, inside the canvas.
 */
export function fitToSlot(slot: ProductSlot, picture: { width: number; height: number }, canvas: SourceSize): PixelRect {
  let scale = slot.targetHeight / Math.max(1, picture.height);
  if (picture.width * scale > slot.box.width * 1.3) scale = (slot.box.width * 1.3) / Math.max(1, picture.width);
  const width = Math.max(1, Math.round(picture.width * scale)), height = Math.max(1, Math.round(picture.height * scale));
  const x = Math.round(slot.box.x + slot.box.width / 2 - width / 2), y = slot.contactY + 1 - height;
  return { x: Math.min(Math.max(0, x), Math.max(0, canvas.width - width)), y: Math.min(Math.max(0, y), Math.max(0, canvas.height - height)), width: Math.min(width, canvas.width), height: Math.min(height, canvas.height) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Variations: new creatives from the structured template (never from its flattened picture)
// ---------------------------------------------------------------------------------------------------------------------
export const PRODUCT_VARIATION_KINDS = ['product-swap', 'festive', 'sale', 'premium', 'minimal'] as const;
export type ProductVariationKind = typeof PRODUCT_VARIATION_KINDS[number];
export const PRODUCT_VARIATION_LABELS: Record<ProductVariationKind, { title: string; hint: string }> = {
  'product-swap': { title: 'Different products', hint: 'The original design with other products in the slots.' },
  festive: { title: 'Festive original', hint: 'The original composition, richer festive colours and warm text.' },
  sale: { title: 'Bold offer', hint: 'The offer set larger and bolder so it stands out.' },
  premium: { title: 'Premium spotlight', hint: 'Muted, calmer artwork, dark text and an elegant serif headline.' },
  minimal: { title: 'Minimal brand-forward', hint: 'Lighter artwork, fewer products, clean sans-serif text.' },
};
/** The aspect ratios a variation can be made in ('original': the template's own canvas). */
export const PRODUCT_ASPECT_RATIOS = ['original', '1:1', '4:5', '9:16', '16:9'] as const;
export type ProductAspectRatio = typeof PRODUCT_ASPECT_RATIOS[number];
export const PRODUCT_ASPECT_LABELS: Record<ProductAspectRatio, string> = { original: 'Original size', '1:1': 'Square 1:1', '4:5': 'Portrait 4:5', '9:16': 'Story 9:16', '16:9': 'Landscape 16:9' };
/**
 * The canvas of a template in an aspect ratio: the template's own size along the side it keeps (its width for a taller
 * ratio, its height for a wider one), the other side lengthened. Never smaller than the template, never stretched.
 */
export function productCanvasFor(canvas: SourceSize, ratio: ProductAspectRatio): SourceSize {
  if (ratio === 'original') return { ...canvas };
  const [w, h] = ratio.split(':').map(Number), want = w / h, have = canvas.width / canvas.height;
  if (Math.abs(want - have) < 0.005) return { ...canvas };
  return want < have ? { width: canvas.width, height: Math.round(canvas.width / want) } : { width: Math.round(canvas.height * want), height: canvas.height };
}
/** One check of a generated variation: `blocking` ones keep it from being sent on until fixed (or regenerated). */
export interface ProductVariationCheck { code: 'OVERLAP' | 'OUT_OF_CANVAS' | 'SAFE_AREA' | 'MISSING_ASSET' | 'REQUEST_IGNORED' | 'DUPLICATE' | 'FILLED_MARGINS' | 'FONT' | 'EMPTY' | 'AI_TEXT' | 'AI_CONTENT' | 'LOW_CONTRAST' | 'STAGE'; message: string; blocking: boolean }
/** Which checks are measured by fixed rules, which look at the picture, and which only a person can judge (AI artwork). */
export const PRODUCT_CHECK_KIND: Record<ProductVariationCheck['code'], 'automatic' | 'visual' | 'person'> = {
  OVERLAP: 'automatic', OUT_OF_CANVAS: 'automatic', SAFE_AREA: 'automatic', MISSING_ASSET: 'automatic', REQUEST_IGNORED: 'automatic', DUPLICATE: 'automatic', FONT: 'automatic', EMPTY: 'automatic',
  FILLED_MARGINS: 'visual', LOW_CONTRAST: 'visual', AI_TEXT: 'visual', STAGE: 'visual', AI_CONTENT: 'person',
};
/** Where a variation's background comes from: the template's artwork, a local preset backdrop (free, no AI), or new AI artwork (paid). */
export const PRODUCT_ARTWORK_MODES = ['template', 'local', 'ai'] as const;
export type ProductArtworkMode = typeof PRODUCT_ARTWORK_MODES[number];
export interface ProductVariationInfo {
  mode?: 'reuse' | 'typography' | 'redesign';
  kind: ProductVariationKind; title: string;
  /** Text written for this variation, per group: what is drawn (always applied). `source`: typed by the person, or written by the AI planner (to check). */
  copy: { groupId: string; role: string; text: string; applied: boolean; source?: 'user' | 'ai' }[];
  /** What the planner left out or a person must check (an offer or price it will not invent). */
  notes: string[];
  model: string; offline: boolean;
  /** Version 2: the aspect ratio, what the person asked for (to check it was done), and the checks of the result. */
  aspectRatio?: ProductAspectRatio;
  requested?: { products: { slotId: string; ref: string; label: string }[]; characters: { slotId: string; ref: string; label: string }[]; headline?: string; offer?: string };
  checks?: { status: 'ready' | 'needs-review' | 'failed'; issues: ProductVariationCheck[] };
}

export const PRODUCT_LIMITS = { maxObjects: 60, maxName: 120, maxUpload: 25 * 1024 * 1024, minSide: 256 } as const;

// ---------------------------------------------------------------------------------------------------------------------
// Reuse Template: a saved revision reused with the person's own product set, copy and formats (separate from variations)
// ---------------------------------------------------------------------------------------------------------------------
/** The output formats of the Reuse Template studio ('original': the template's own canvas). */
export const REUSE_ASPECT_RATIOS = ['original', '3:9', '4:9', '16:9'] as const;
export type ReuseAspectRatio = typeof REUSE_ASPECT_RATIOS[number];
export const REUSE_ASPECT_LABELS: Record<ReuseAspectRatio, string> = { original: 'Original size', '3:9': 'Portrait 3:9', '4:9': 'Portrait 4:9', '16:9': 'Landscape 16:9' };
/**
 * A reused creative's canvas: the template's own for 'original'; otherwise exactly the ratio, a portrait one as tall as
 * the template, a landscape one as wide (at most 4096 px), so the template's artwork is never enlarged.
 */
export function reuseCanvasFor(canvas: SourceSize, ratio: ReuseAspectRatio): SourceSize {
  if (ratio === 'original') return { ...canvas };
  const [w, h] = ratio.split(':').map(Number);
  if (w < h) { const height = Math.min(4096, canvas.height); return { width: Math.max(1, Math.round(height * w / h)), height }; }
  const width = Math.min(4096, canvas.width); return { width, height: Math.max(1, Math.round(width * h / w)) };
}
export type ReuseItemAsset = { kind: 'template'; file: string }
  | { kind: 'upload'; file: string; sha256: string; width: number; height: number; background: 'transparent' | 'removed' | 'kept'; originalName?: string };
/**
 * A product or character of a reuse draft: one of the template's (objectId) or one the person added (objectId null).
 * included: in the creative's arrangement; hidden: in it but not drawn; removed: taken out of this draft (restorable).
 */
export interface ReuseItem {
  id: string; objectId: string | null; kind: 'product' | 'character'; label: string; category: string;
  included: boolean; hidden: boolean; removed: boolean; order: number;
  asset: ReuseItemAsset;
  /** The template's own picture and name (to restore). */
  original?: { file: string; label: string };
}
export interface ReuseTextEdit { text?: string; hidden?: boolean; fontFamily?: string; fontWeight?: number; color?: string; scale?: number; align?: 'left' | 'center' }
export interface ReuseLogoEdit { hidden?: boolean; asset?: { kind: 'creative'; file: string; sha256: string; width: number; height: number; originalName?: string } }
/** original: the template's own places (only for its own product set); geometry: arranged on this computer by fixed rules; ai: arranged by the approved AI planner. */
export type ReusePlacementMode = 'original' | 'geometry' | 'ai';
export interface ReusePlacementBox { id: string; x: number; y: number; width: number; height: number; z: number }
/** One approved AI placement of one format, for one set of products (`items`: the ids it was made for). */
export interface ReuseAiPlan { ratio: ReuseAspectRatio; at: string; model: string; offline: boolean; operationId: string; responseId?: string; items: string[];
  /** The main product the person chose when it was made (null: chosen by the AI). */ hero?: string | null;
  boxes: ReusePlacementBox[]; notes: string[]; rejected: { id: string; reason: string }[];
  /** The product the AI made the main one. */ aiHero?: string }
/** A manual correction in one format: an object's box, or a text group's or logo's move. */
export interface ReuseOverride { x?: number; y?: number; width?: number; height?: number; dx?: number; dy?: number }
export interface ReuseOutput {
  ratio: ReuseAspectRatio; generatedAt: string; draftRevision: number; preview: string; previewSha256: string; canvas: SourceSize;
  placement: ReusePlacementMode; background: { method: ProductCreativeBackground['method']; filledPercent: number; note?: string };
  checks: { status: 'ready' | 'needs-review' | 'failed'; issues: ProductVariationCheck[] };
  creativeId?: string; creativeRevision?: number; savedAt?: string; savedDraftRevision?: number;
  /** Decompose & Edit: the layer template made from the saved creative (which revision), so it is never made (and paid) twice. */
  decomposition?: { templateId: string; creativeId: string; creativeRevision: number; at: string };
}
export interface ReuseDraft {
  schemaVersion: 1; id: string; templateId: string; templateRevision: number; name: string; createdAt: string; updatedAt: string; revision: number;
  items: ReuseItem[]; texts: Record<string, ReuseTextEdit>; logos: Record<string, ReuseLogoEdit>;
  ratios: ReuseAspectRatio[];
  /** hero: the product the person made the main one (else chosen automatically); variant: which automatic layout (Regenerate Layout). */
  placement: { mode: ReusePlacementMode; keepStands: boolean; hero?: string | null; variant?: number };
  /** Made in the simple flow (Upload Products → Generate My Creative): the template's own products start left out. */
  simple?: boolean;
  ai: { requests: number; costUsd: number; plans: Partial<Record<ReuseAspectRatio, ReuseAiPlan>>; failures: { at: string; operationId: string; message: string }[] };
  overrides: Partial<Record<ReuseAspectRatio, Record<string, ReuseOverride>>>;
  outputs: Partial<Record<ReuseAspectRatio, ReuseOutput>>;
}
