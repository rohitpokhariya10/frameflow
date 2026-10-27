/**
 * Product with Text templates (shared/src/productTemplates.ts): a protected-template record with `product` set, in the
 * same store as every protected template, never read by the Text & Graphics service (which reads `master` only).
 *
 *   create     one uploaded creative, or one creative chosen on a reference sheet (cropped exactly; the sheet is kept)
 *   detect     the local reading and the vision analysis (detect.ts), in the background; saved per source
 *   review     the administrator's corrections as one state: objects (moved, resized, renamed, given another kind,
 *              removed, added), text blocks (removed, recategorised, retyped) and logos; confident items were accepted
 *              by the detection, the rest need a click (or "Accept all")
 *
 * Every change bumps `objectsRevision` (a prepared template of an older one is stale) and is kept in the history.
 */
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import {
  decomposesObject, estimateAdvance, isMasterCategory, isOverlayKind, normalizeBox, orderProductObjects, PRODUCT_ELEMENT_KINDS, PRODUCT_LIMITS, PRODUCT_OBJECT_KINDS, PRODUCT_PREPARE_VERSION, PRODUCT_SCHEMA_VERSION, PROTECTED_SCHEMA_VERSION, withHistory,
  type DetectedWord, type LogoSlot, type MasterCategory, type PixelRect, type ProductHistoryEntry, type ProductInfo, type ProductObject, type ProductObjectKind, type ProductPrepared, type ProductSnapshot, type ProductGenerationBrief, type ProductStage, type ProtectedTemplate, type SourceBox,
} from '@frameflow/shared';
import { RunError } from '../../layerizeExperiment.js';
import { decodeRgba, ingestImage, ProtectedImageError, sha256 } from '../pixels.js';
import type { ProtectedService } from '../service.js';
import { newProtectedTemplateId, type ProtectedStore } from '../store.js';
import type { WordRecognizer } from '../../../textRecognition/recognizer.js';
import type { SceneAnalyzer } from '../../creativeTemplates/smartProviders.js';
import type { Segmenter } from '../../creativeTemplates/segmenter.js';
import { aiDecompositionEstimate, sentSize, type ProductLayerizer } from './aiDecompose.js';
import { OverlayGateError, prepareProduct } from './prepare.js';
import { createProductCreatives } from './creatives.js';
import { createProductVariations, type ProductVariationPlanner } from './variations.js';
import type { ArtworkGenerator } from './artwork.js';
import { detectProduct, logoSlot, styleLine } from './detect.js';
import { fitLines } from './wordFit.js';
import { productSceneFromResponse, replayProductAnalyzer, type ProductAnalysisJob, type RecoverableProductAnalyzer } from './analyzer.js';
import { findSheetCreatives } from './sheet.js';
import { decompositionPlan, deriveBrief, type DetectionAnswer } from './brief.js';
import { compositionAnalyzer, variationClean, type VariationComposition } from './variationTemplate.js';
import { paletteOf } from './artwork.js';
import { createReuseStudio } from './reuseStudio.js';
import type { ReusePlacementPlanner } from './reusePlacement.js';
import { measureWord } from '../../../textRecognition/measure.js';

const nowIso = () => new Date().toISOString();
const hexId = (prefix: string) => `${prefix}-${randomBytes(5).toString('hex')}`;
function fail(code: string, message: string, details?: Record<string, unknown>): never { throw new RunError(code, message, details); }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
type ProductRecord = ProtectedTemplate & { product: ProductInfo };

/**
 * Words of one line that would be drawn over others: lying largely on top of each other (over a third of the smaller box)
 * — the reading took one thing for two words — "Ld" and "On" over "pays you", a line's words read again onto the line above ("Acceptstomer") — so one of
 * them is misread. Pairs, as the review names them.
 */
export function overlappingWords(words: Pick<DetectedWord, 'text' | 'box'>[]): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < words.length; i++) for (let j = i + 1; j < words.length; j++) {
    const p = words[i].box, q = words[j].box, ix = Math.max(0, Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x)), iy = Math.max(0, Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y));
    if (ix * iy > Math.min(p.width * p.height, q.width * q.height) / 3) pairs.push(`“${words[i].text}” and “${words[j].text}”`);
  }
  // A word well off its line (its middle more than half the line's word height from the line's): set again on the line's
  // baseline it is drawn over its neighbours ("Ld" read in the gap above "pays you").
  if (words.length >= 3) {
    const mid = (w: (typeof words)[number]) => w.box.y + w.box.height / 2, median = (v: number[]) => [...v].sort((p, q) => p - q)[v.length >> 1];
    const line = median(words.map(mid)), size = median(words.map(w => w.box.height));
    for (const w of words) if (!w.box.rotation && Math.abs(mid(w) - line) > size * 0.5) pairs.push(`“${w.text}” (off its line)`);
  }
  return pairs;
}
export const overlapReason = (pairs: string[]) => `${pairs.slice(0, 3).join(', ')}: set again, these would be drawn over other words — probably misread. Remove or correct them.`;

export interface ProductTemplateOptions {
  store: ProtectedStore; service: ProtectedService; runsDir: string;
  recognizer: () => WordRecognizer;
  /** The vision analysis; absent (no key configured): characters and products are added in the review. */
  analyzer?: () => SceneAnalyzer | undefined;
  /** Object masks from a provider (SAM-3), used only when the administrator approves its cost; else the local estimate. */
  segmenter?: () => Segmenter | undefined;
  /** The AI decomposition core (aiDecompose.ts: OpenAI planner → Seedream Layerize), used only when its cost is approved. */
  layerizer?: () => ProductLayerizer | undefined;
  /** The AI variation planner (one request per batch, only when the person approves it); else the offline planner. */
  planner?: () => ProductVariationPlanner | undefined;
  /** New AI artwork for recomposed variations (the image model; one request per variation, only with approval of its cost). */
  artwork?: () => ArtworkGenerator | undefined;
  /** Reuse Template: the AI product placement planner (one request per format, only with approval of its cost). */
  placement?: () => ReusePlacementPlanner | undefined;
}
/** One element of the review as the client sends it (the whole state each time). */
export interface ReviewInput {
  expectedRevision: number;
  /** `layer`, for a podium or stand: its own layer, or part of the background (see ProductObject.layer). */
  objects: { id?: string; kind: ProductObjectKind; label: string; box: PixelRect; hidden?: boolean; accepted?: boolean; layer?: 'own' | 'background' | null }[];
  texts: { groupId: string; box?: PixelRect; removed?: boolean; category?: MasterCategory; text?: string; accepted?: boolean }[];
  logos: { slotId?: string; removed?: boolean; category?: 'brand-logo' | 'partner-logo' | 'qr' | 'badge'; label?: string; box?: PixelRect; accepted?: boolean;
    /** A picture uploaded in the review (POST …/review-assets) shown instead of the logo's own pixels. */
    replacement?: string | null }[];
  /** Word by word, after the block changes: its text (one word), box, removal, or another block ('new': a block of its own). */
  words?: { wordId: string; text?: string; box?: PixelRect; removed?: boolean; groupId?: string }[];
  /** Text the detection missed, typed by the administrator in a box they drew. */
  newTexts?: { text: string; box: PixelRect; category?: MasterCategory }[];
  dismissMissingText?: boolean;
}

export function createProductTemplates(options: ProductTemplateOptions) {
  const { store, service } = options;
  const locks = new Map<string, Promise<unknown>>(), detecting = new Set<string>(), preparingIds = new Set<string>();
  const locked = <T>(key: string, work: () => Promise<T>): Promise<T> => { const next = (locks.get(key) ?? Promise.resolve()).then(work, work); locks.set(key, next.catch(() => undefined)); return next; };
  const requireProduct = (id: string) => { const t = store.require(id); if (!t.product) fail('NOT_FOUND', 'Product template not found.'); return t as ProductRecord; };
  const preparingNow = (id: string) => preparingIds.has(id);
  const history = (p: ProductInfo, entry: Omit<ProductHistoryEntry, 'at'>) => { p.history = [...p.history, { at: nowIso(), ...entry }].slice(-300); };

  // --- Views -----------------------------------------------------------------------------------------------------------
  function stageOf(t: ProductRecord): ProductStage {
    const p = t.product;
    // A run recorded as running that this process is not doing was interrupted (the server restarted): it failed.
    if (detecting.has(t.id)) return 'detecting';
    if (p.detection?.status === 'running') return 'detect-failed';
    if (p.detection?.status === 'failed') return t.textAnalysis ? 'review' : 'detect-failed';
    if (!p.detection) return 'detect-failed';
    if (preparingNow(t.id)) return 'preparing';
    const prepared = p.prepared && p.prepared.objectsRevision === p.objectsRevision;
    const latest = p.revisions[p.revisions.length - 1];
    if (prepared && p.approved && latest && !latest.draft && p.approved.objectsRevision === p.objectsRevision) return 'ready';
    if (latest && !prepared) return 'changed';
    return prepared ? 'prepared' : 'review';
  }
  const boxOf = (b: SourceBox): PixelRect => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  const unionOf = (boxes: PixelRect[]): PixelRect => { const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y)); return { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height: Math.max(...boxes.map(b => b.y + b.height)) - y }; };
  /** The text blocks (the editable unit): each group's words in reading order, its box, and whether it needs a look. */
  function textBlocks(t: ProductRecord) {
    const a = t.textAnalysis;
    if (!a) return [];
    return a.groups.map(g => {
      const ws = g.lines.flatMap(l => l.wordIds.map(id => a.words.find(w => w.id === id)).filter((w): w is DetectedWord => !!w));
      const live = ws.filter(w => w.review.status !== 'rejected');
      const box = unionOf((live.length ? live : ws).map(w => boxOf(w.box)));
      const overlaps = g.lines.flatMap(l => overlappingWords(l.wordIds.map(id => a.words.find(w => w.id === id)).filter((w): w is DetectedWord => !!w && w.review.status !== 'rejected')));
      return { id: g.id, category: g.category ?? 'supporting', ...(overlaps.length ? { overlaps } : {}), text: g.lines.map(l => l.wordIds.map(id => a.words.find(w => w.id === id)).filter((w): w is DetectedWord => !!w && w.review.status !== 'rejected').map(w => w.text).join(' ')).filter(Boolean).join('\n'),
        wordList: g.lines.flatMap((l, line) => l.wordIds.map(id => a.words.find(w => w.id === id)).filter((w): w is DetectedWord => !!w).map(w => ({ id: w.id, text: w.text, line, box: boxOf(w.box), removed: w.review.status === 'rejected', attention: w.review.status === 'needs-review', confidence: Math.round(w.confidence * 100) / 100, corrected: !!w.corrected }))),
        box, words: live.length, removed: !live.length, attention: live.some(w => w.review.status === 'needs-review') || overlaps.length > 0,
        confidence: live.length ? Math.round(Math.min(...live.map(w => w.confidence)) * 100) / 100 : 0,
        style: live[0] ? { fontFamily: live[0].style.fontFamily, fontSize: Math.round(live[0].style.fontSize), fontWeight: live[0].style.fontWeight, color: live[0].style.color, align: g.align } : undefined };
    });
  }
  function view(id: string) {
    const t = requireProduct(id), p = t.product, a = t.textAnalysis, blocks = textBlocks(t);
    const logos = (a?.logoSlots ?? []).map(s => ({ id: s.id, label: s.label, category: s.category ?? 'partner-logo', box: boxOf(s.box), file: s.replacement?.file ?? s.original.file, removed: s.review.status === 'rejected', attention: s.review.status === 'needs-review', confidence: s.confidence, ...(s.inBackground ? { inBackground: true } : {}) }));
    const live = p.objects.filter(o => !o.hidden);
    const attention = [
      ...live.filter(o => o.review.status === 'attention').map(o => ({ type: 'object' as const, id: o.id, label: o.label, reason: o.review.reason ?? 'Check this.', box: o.box })),
      ...blocks.filter(b => !b.removed && b.attention).map(b => ({ type: 'text' as const, id: b.id, label: b.text.split('\n')[0].slice(0, 60), reason: b.overlaps ? overlapReason(b.overlaps) : `Read with ${Math.round(b.confidence * 100)}% certainty: check the text.`, box: b.box })),
      ...logos.filter(l => !l.removed && l.attention).map(l => ({ type: 'logo' as const, id: l.id, label: l.label, reason: 'Check that this is a logo.', box: l.box })),
      ...(p.detection?.missingText ?? []).map((m, i) => ({ type: 'missing' as const, id: `missing-${i}`, label: m.text.slice(0, 60), reason: 'This text was seen but not read: add it as text, or ignore it.', box: m.box })),
    ];
    const count = (kind: ProductObjectKind) => live.filter(o => o.kind === kind).length;
    return {
      template: { id: t.id, name: t.name, revision: t.revision, createdAt: t.createdAt, updatedAt: t.updatedAt, source: t.source },
      recovery: { savedAnswer: store.has(id, 'analysis-product-completed.json') || store.list().some(s => s.source.sha256 === t.source.sha256 && s.product?.detection?.status === 'done' && store.has(s.id, 'analysis-product-response.json')),
        retrievable: !!readJob(id)?.responseId, interrupted: p.detection?.status === 'running' && !detecting.has(id) },
      stage: stageOf(t), texts: blocks, logos, attention,
      product: p.preparing?.status === 'running' && !preparingNow(t.id) ? { ...p, preparing: { ...p.preparing, status: 'failed' as const, error: 'Preparing was interrupted: prepare again.' } } : p,
      counts: { characters: count('character'), products: count('product'), text: blocks.filter(b => !b.removed).length, words: (a?.words ?? []).filter(w => w.review.status !== 'rejected').length, logos: logos.filter(l => !l.removed && !l.inBackground).length + count('brand-logo'), background: count('podium') + count('frame') + count('decoration') },
    };
  }
  function list() {
    return store.list().filter(t => !!t.product).map(t => { const v = view(t.id); return { id: t.id, name: t.name, createdAt: t.createdAt, updatedAt: t.updatedAt, stage: v.stage, source: t.source, counts: v.counts, revisions: v.product.revisions.length, ...(v.product.revisions.at(-1)?.draft ? { draft: true } : {}) }; });
  }

  // --- Create ----------------------------------------------------------------------------------------------------------
  /** Whether an upload is a sheet of several creatives, and where each is (nothing is stored). */
  async function sheetOf(bytes: Buffer) {
    let img;
    try { img = await ingestImage(bytes, 'image', { minSide: PRODUCT_LIMITS.minSide }); } catch (error) { if (error instanceof ProtectedImageError) fail(error.code, error.message); throw error; }
    const found = findSheetCreatives(await decodeRgba(img.input));
    return { width: img.width, height: img.height, sheet: found.sheet, boxes: found.boxes };
  }
  /** A template from an upload; with `crop`, from that rectangle of it (a creative on a sheet), cropped without resampling. */
  async function create(bytes: Buffer, input: { name?: string; filename?: string; crop?: PixelRect }) {
    let img;
    try { img = await ingestImage(bytes, 'image', { minSide: PRODUCT_LIMITS.minSide }); } catch (error) { if (error instanceof ProtectedImageError) fail(error.code, error.message); throw error; }
    let sourceBytes = img.input, sheet: ProductInfo['sheet'], files: Record<string, Buffer> = {};
    if (input.crop) {
      const c = input.crop;
      if (![c.x, c.y, c.width, c.height].every(v => Number.isSafeInteger(v)) || c.x < 0 || c.y < 0 || c.width < PRODUCT_LIMITS.minSide || c.height < PRODUCT_LIMITS.minSide || c.x + c.width > img.width || c.y + c.height > img.height)
        fail('INVALID_CROP', `Choose a creative inside the image, at least ${PRODUCT_LIMITS.minSide} pixels on each side.`);
      sourceBytes = await sharp(img.input).extract({ left: c.x, top: c.y, width: c.width, height: c.height }).png({ compressionLevel: 9 }).toBuffer();
      const sheetFile = `sheet-${img.sha256.slice(0, 12)}.${img.ext}`;
      files[sheetFile] = bytes;
      sheet = { file: sheetFile, sha256: img.sha256, width: img.width, height: img.height, crop: { ...c } };
    }
    const meta = await sharp(sourceBytes).metadata(), hash = sha256(sourceBytes), ext = input.crop ? 'png' : img.ext, file = `source.${ext}`;
    files = { [file]: sourceBytes, ...files };
    const now = nowIso(), id = newProtectedTemplateId(), name = (input.name?.trim() || input.filename?.replace(/\.[a-z0-9]+$/i, '') || 'Product template').slice(0, PRODUCT_LIMITS.maxName);
    const product: ProductInfo = { version: PRODUCT_SCHEMA_VERSION, type: 'product-text', ...(sheet ? { sheet } : {}), objects: [], objectsRevision: 0, revisions: [], activity: { scans: 0, aiCalls: 0, segmentRequests: 0, costUsd: 0 },
      history: [{ at: now, action: 'created', detail: input.filename ? `From ${input.filename.slice(0, 120)}` : undefined }, ...(sheet ? [{ at: now, action: 'cropped' as const, detail: `One creative (${sheet.crop.width}×${sheet.crop.height} at ${sheet.crop.x},${sheet.crop.y}) of a ${sheet.width}×${sheet.height} sheet.` }] : [])] };
    store.create({ schemaVersion: PROTECTED_SCHEMA_VERSION, id, name, createdAt: now, updatedAt: now, revision: 1, coordinateSystem: 'source-pixels', elements: [], elementsRevision: 0, layerInstructions: '', runs: [],
      source: { file, inputFile: file, sha256: hash, mime: `image/${ext === 'jpg' ? 'jpeg' : ext}`, width: meta.width!, height: meta.height!, bytes: sourceBytes.length, orientationNormalized: false, origin: { kind: 'upload', ...(input.filename ? { filename: input.filename.slice(0, 200) } : {}) } },
      product }, files);
    return id;
  }

  /**
   * "Decompose & Edit" of a generated variation: a template of its own (product/variationTemplate.ts), detected from its
   * composition (free), then reviewed, chosen, decomposed, inspected and saved like an upload. Returns its id.
   */
  async function createFromVariation(input: { templateId: string; revision: number; jobId: string; index: number; title: string; name: string; composition: VariationComposition }) {
    const c = input.composition, meta = await sharp(c.png).metadata(), hash = sha256(c.png), now = nowIso(), id = newProtectedTemplateId();
    const files: Record<string, Buffer> = { 'source.png': c.png, 'variation-background.png': c.background, 'variation-clean.png': await variationClean(c, { width: meta.width!, height: meta.height! }),
      'variation-answer.json': Buffer.from(JSON.stringify(c.answer)), 'variation-words.json': Buffer.from(JSON.stringify(c.words)) };
    const layers = c.layers.map((l, k) => { const file = `variation-layer-${String(k).padStart(2, '0')}.png`; files[file] = l.png; return { label: l.label, kind: l.kind, box: { ...l.box }, file }; });
    const plates = c.plates.map((p, k) => { const file = `variation-plate-${String(k).padStart(2, '0')}.png`; files[file] = p.png; return { box: { ...p.box }, file }; });
    const product: ProductInfo = { version: PRODUCT_SCHEMA_VERSION, type: 'product-text', objects: [], objectsRevision: 0, revisions: [], activity: { scans: 0, aiCalls: 0, segmentRequests: 0, costUsd: 0 },
      variation: { decompositionEngine: 'ai', templateId: input.templateId, revision: input.revision, jobId: input.jobId, index: input.index, title: input.title, background: 'variation-background.png', clean: 'variation-clean.png', cleanSha256: sha256(files['variation-clean.png']), layers, plates, answer: 'variation-answer.json', words: 'variation-words.json' },
      history: [{ at: now, action: 'created', detail: `From the variation “${input.title}” of template ${input.templateId} (version ${input.revision}).` }] };
    store.create({ schemaVersion: PROTECTED_SCHEMA_VERSION, id, name: input.name.slice(0, PRODUCT_LIMITS.maxName), createdAt: now, updatedAt: now, revision: 1, coordinateSystem: 'source-pixels', elements: [], elementsRevision: 0, layerInstructions: '', runs: [],
      source: { file: 'source.png', inputFile: 'source.png', sha256: hash, mime: 'image/png', width: meta.width!, height: meta.height!, bytes: c.png.length, orientationNormalized: false, origin: { kind: 'upload', filename: `variation-${input.jobId}-${input.index}.png` } },
      product }, files);
    startDetect(id, { force: true });
    return id;
  }

  // --- Detect ----------------------------------------------------------------------------------------------------------
  /** The detection, in the background (saved per source: asking again reads nothing unless `force`). */
  function startDetect(id: string, input: { force?: boolean; useAi?: boolean; savedAnswer?: boolean; recover?: boolean; newRequest?: boolean } = {}) {
    const t = requireProduct(id);
    if (detecting.has(id)) return { started: false };
    if ((!input.force || input.savedAnswer || input.recover) && t.product.detection?.status === 'done' && t.product.detection.sourceSha256 === t.source.sha256) return { started: false };
    if (preparingNow(id)) fail('BUSY', 'Wait for decomposition to finish before detecting again.');
    if (input.recover && !readJob(id)?.responseId) fail('NO_SAVED_REQUEST', 'No response ID was received. Look for a saved analysis, or explicitly approve a new request.');
    detecting.add(id);
    void runDetect(id, input.useAi === true, input.savedAnswer === true, input.recover === true, input.newRequest === true).catch(error => console.error('product detect', id, error)).finally(() => detecting.delete(id));
    return { started: true };
  }
  /**
   * The AI answer already received for this creative (saved with the template on every request), to be read again with
   * today's checks — no new request, nothing spent. One that belongs to another picture, or is not a completed answer,
   * is refused.
   */
  function readJob(id: string): ProductAnalysisJob | undefined {
    try { return JSON.parse(store.read(id, 'analysis-product-job.json').toString('utf8')) as ProductAnalysisJob; } catch { return undefined; }
  }
  function savedAnswer(id: string, image: Buffer) {
    const target = requireProduct(id), imageSha256 = sha256(image);
    const candidates = [target, ...store.list().filter(t => t.id !== id && t.product && t.source.sha256 === target.source.sha256)];
    for (const owner of candidates) {
      try {
        if (owner.source.sha256 !== target.source.sha256 || owner.source.width !== target.source.width || owner.source.height !== target.source.height || sha256(store.read(owner.id, owner.source.inputFile)) !== target.source.sha256) continue;
        let response: Parameters<typeof productSceneFromResponse>[0], model: string, sent: { width: number; height: number; source: { width: number; height: number } };
        if (store.has(owner.id, 'analysis-product-completed.json')) {
          const completed = JSON.parse(store.read(owner.id, 'analysis-product-completed.json').toString('utf8')) as { job: ProductAnalysisJob; response: typeof response };
          if (completed.job.imageSha256 !== imageSha256) continue;
          ({ response } = completed); model = completed.job.model; sent = completed.job.sent;
        } else {
          // Legacy files were overwritten independently. Only a successfully accepted detection binds that pair.
          if (owner.product?.detection?.status !== 'done' || owner.product.detection.sourceSha256 !== target.source.sha256) continue;
          response = JSON.parse(store.read(owner.id, 'analysis-product-response.json').toString('utf8')) as typeof response;
          const request = JSON.parse(store.read(owner.id, 'analysis-product-request.json').toString('utf8')) as { model: string; input: { width: number; height: number; imageSha256?: string; source?: { width: number; height: number } } };
          if (request.input.imageSha256 && request.input.imageSha256 !== imageSha256) continue;
          model = request.model; sent = { width: request.input.width, height: request.input.height, source: request.input.source ?? { width: owner.source.width, height: owner.source.height } };
        }
        if (!model || !Number.isSafeInteger(sent.width) || !Number.isSafeInteger(sent.height) || sent.width < 1 || sent.height < 1 || sent.source.width !== target.source.width || sent.source.height !== target.source.height) continue;
        productSceneFromResponse(response, sent, model, () => undefined);
        return { owner, response, model, sent, analyzer: replayProductAnalyzer({ response, model, imageSha256, sent }) };
      } catch { /* Incomplete, unbound or invalid historical evidence is never accepted as this image's analysis. */ }
    }
    return undefined;
  }
  async function runDetect(id: string, useAi: boolean, useSaved = false, recover = false, newRequest = false) {
    const startedAt = nowIso();
    const before = requireProduct(id);
    // Keep the last successful analysis intact even while a new attempt is running or fails.
    if (before.product.detection?.status !== 'done') await service.updateMaster(id, undefined, x => { x.product!.detection = { ...x.product!.detection, status: 'running', startedAt, sourceSha256: x.source.sha256 }; });
    try {
      const t = requireProduct(id), png = store.read(id, t.source.inputFile);
      if (sha256(png) !== t.source.sha256) fail('SOURCE_MISMATCH', 'The stored image does not match its original hash. No saved analysis or provider request was used.');
      const source = await decodeRgba(png), input = await sharp(png).png().toBuffer();
      // A template made from a variation is read from its own composition (free, exact), never sent to a provider.
      const fromVariation = t.product.variation, cached = !fromVariation && !recover ? savedAnswer(id, input) : undefined;
      if (useSaved && !cached) fail('NO_SAVED_ANSWER', 'No completed, image-matched analysis is available. Retrieve an existing request, or explicitly approve a new detection.');
      let job = readJob(id);
      const live = options.analyzer?.() as RecoverableProductAnalyzer | undefined;
      if (useAi && !cached && !recover) {
        const first = [...detecting].find(other => requireProduct(other).source.sha256 === t.source.sha256);
        if (first && first !== id) fail('BUSY', `Detection for this exact image is already running in template ${first}. No duplicate request was submitted.`);
        if (!job) {
          // A repeated upload must not silently submit another copy of a still-pending request.
          const pending = store.list().filter(owner => owner.id !== id && owner.product && owner.source.sha256 === t.source.sha256)
            .map(owner => readJob(owner.id)).find(j => j?.imageSha256 === sha256(input) && ['submitting', 'queued', 'in_progress', 'unknown'].includes(j.status));
          if (pending) { job = pending; store.write(id, 'analysis-product-job.json', Buffer.from(JSON.stringify(job, null, 2))); }
        }
      }
      if (recover && (!job?.responseId || !live?.recover)) fail('NOT_CONFIGURED', 'Retrieval is unavailable. The saved request and image are intact; no new request was sent.');
      // An uncollected response must be retrieved, never replaced by another automatic submission.
      if (useAi && !cached && !recover && job && !newRequest && ['submitting', 'queued', 'in_progress', 'unknown', 'unavailable'].includes(job.status)) fail('RECOVERY_REQUIRED', 'Retrieve the existing request or explicitly approve a new request. The earlier attempt may still be processed and billed.');
      if (useAi && !cached && !recover && job && newRequest) store.write(id, `analysis-product-job-${Date.now()}.json`, Buffer.from(JSON.stringify(job, null, 2)));
      if (cached && cached.owner.id !== id) {
        // Preserve the paired evidence with the new upload too, so removal of the donor cannot lose recovery.
        for (const f of ['analysis-product-completed.json', 'analysis-product-request.json', 'analysis-product-response.json']) if (store.has(cached.owner.id, f)) store.write(id, f, store.read(cached.owner.id, f));
      }
      const analyzer = fromVariation ? compositionAnalyzer(JSON.parse(store.read(id, fromVariation.answer).toString('utf8')) as object)
        : cached?.analyzer ?? (recover ? { model: job!.model, analyze: (bytes: Buffer, _mime: string, save: (file: string, value: object) => void) => live!.recover(bytes, save, job!) } : useAi ? live : undefined);
      // (A variation's words and logos are its composition's, exactly: nothing is read from its pixels.)
      const recognizer: WordRecognizer = fromVariation ? { engine: { name: 'composition', version: '1', model: 'the variation\'s own text (no reading)', modes: ['composition'] }, recognize: async () => [] } : options.recognizer();
      const result = await detectProduct({ template: t, source, png: input, recognizer, analyzer, previous: t.textAnalysis, ...(fromVariation ? { exact: true } : {}),
        store: (f, bytes) => store.write(id, f, bytes), save: (f, value) => store.write(id, `analysis-${f.replace(/\.json$/i, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 80)}.json`, Buffer.from(JSON.stringify(value, null, 2))), at: nowIso() });
      // Run again on a reviewed template: the administrator's corrections win over what was found again at their place.
      const prior = !t.textAnalysis && cached?.owner.product?.detection?.status === 'done' ? cached.owner : t;
      if (prior.id !== id) {
        // Carry corrected logo assets along with their metadata. The donor template remains read-only.
        for (const s of prior.textAnalysis?.logoSlots ?? []) for (const f of [s.original.file, s.replacement?.file]) if (f && store.has(prior.id, f) && !store.has(id, f)) store.write(id, f, store.read(prior.id, f));
        for (const f of [...(prior.textAnalysis?.words.map(w => w.source?.crop) ?? []), ...(prior.product?.objects.map(o => o.source?.crop) ?? [])]) if (f && store.has(prior.id, f) && !store.has(id, f)) store.write(id, f, store.read(prior.id, f));
      }
      const kept = result.ai.status === 'done' ? keepCorrections(prior.textAnalysis, prior.product?.objects ?? [], result) : undefined;
      // A variation's words as drawn: each detected word takes the face, size, colour and spacing it was drawn with.
      if (fromVariation && result.ai.status === 'done') {
        const drawn = JSON.parse(store.read(id, fromVariation.words).toString('utf8')) as VariationComposition['words'];
        for (const w of result.analysis.words) {
          const d = drawn.find(x => x.text === w.text && Math.min(x.box.x + x.box.width, w.box.x + w.box.width) > Math.max(x.box.x, w.box.x) && Math.min(x.box.y + x.box.height, w.box.y + w.box.height) > Math.max(x.box.y, w.box.y));
          if (d) w.style = { ...w.style, fontFamily: d.style.fontFamily, fontMatch: 'admin', fontSize: d.style.fontSize, fontWeight: d.style.fontWeight as 400 | 600 | 700, fontStyle: d.style.fontStyle, color: d.style.color, opacity: d.style.opacity, letterSpacing: d.style.letterSpacing };
        }
      }
      await service.updateMaster(id, undefined, x => {
        if (result.ai.status !== 'done' && t.textAnalysis) {
          x.product!.detection = before.product.detection?.status === 'done'
            ? { ...before.product.detection, lastFailure: { at: nowIso(), message: result.ai.error ?? 'Detection did not complete.' } }
            : { status: 'failed', startedAt, finishedAt: nowIso(), sourceSha256: x.source.sha256, ai: result.ai, error: result.ai.error };
          return;
        }
        x.textAnalysis = result.analysis; x.elements = result.elements; x.elementsRevision += 1;
        const p = x.product!;
        p.objects = result.objects; p.objectsRevision += 1;
        p.detection = { status: result.ai.status === 'done' ? 'done' : 'failed', error: result.ai.status !== 'done' ? `AI detection not completed. ${result.ai.error ?? 'Enable AI detection with an available provider and retry.'}` : undefined, startedAt, finishedAt: nowIso(), sourceSha256: x.source.sha256, local: result.local, ai: result.ai, missingText: result.missingText, ...(kept && (kept.words || kept.objects || kept.logos) ? { kept } : {}) };
        p.activity = { ...p.activity, scans: p.activity.scans + 1, aiCalls: p.activity.aiCalls + (result.ai.status === 'skipped' || cached || recover || fromVariation ? 0 : 1), costUsd: p.activity.costUsd + (cached || fromVariation ? 0 : result.ai.costUsd ?? 0) };
        history(p, { action: 'detected', detail: `${result.objects.length} object(s), ${result.analysis.groups.length} text block(s), ${result.analysis.logoSlots.length} logo(s); vision analysis ${result.ai.status}${result.ai.offline ? ' (offline test analyser)' : ''}.` });
      });
    } catch (error) {
      await service.updateMaster(id, undefined, x => { const message = error instanceof Error ? error.message.slice(0, 300) : String(error); x.product!.detection = before.product.detection?.status === 'done' ? { ...before.product.detection, lastFailure: { at: nowIso(), message } } : { status: 'failed', startedAt, finishedAt: nowIso(), sourceSha256: x.source.sha256, error: message }; });
      throw error;
    }
  }

  /**
   * Corrections kept when detection runs again (in place on `next`): objects the administrator added, moved, retyped or
   * accepted, logos they added or changed, and words they corrected, added or removed. A newly found item at the same
   * place gives way (a corrected word takes over the new word there, keeping the new block's line); the counts say so.
   */
  function keepCorrections(prevA: ProtectedTemplate['textAnalysis'], prevObjects: ProductObject[], next: { analysis: NonNullable<ProtectedTemplate['textAnalysis']>; objects: ProductObject[]; aiLogoBoxes?: { label: string; box: PixelRect }[]; aiObjectBoxes?: { label: string; kind: string; box: PixelRect; absorbed?: boolean }[] }) {
    const overlap = (p: PixelRect | SourceBox, q: PixelRect | SourceBox) => { const ix = Math.max(0, Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x)), iy = Math.max(0, Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y)); return (ix * iy) / Math.max(1, Math.min(p.width * p.height, q.width * q.height)); };
    const kept = { objects: 0, words: 0, logos: 0, replaced: 0 }, a = next.analysis;
    // An object the administrator only accepted — still where and what the AI said, same name — takes the new detection's
    // place (its boxes may have been corrected since) with their acceptance; moved, retyped, renamed or added ones stay.
    const same = (p: PixelRect, q: PixelRect) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y) + Math.abs(p.width - q.width) + Math.abs(p.height - q.height) <= 1;
    // (By name and box: a kind the detection now reads better — an appliance once taken for a podium — follows it.)
    const aiBox = (o: ProductObject) => o.origin === 'ai' && !o.hidden ? (next.aiObjectBoxes ?? []).find(b => b.label === o.label && same(b.box, o.box)) : undefined, acceptedOnly = (o: ProductObject) => !!aiBox(o);
    // (One the new detection made part of its holder — a modak in Ganesha's hand — is not kept on its own.)
    const mine = prevObjects.filter(o => (o.origin === 'user' || o.review.by === 'user') && !(acceptedOnly(o) && (aiBox(o)!.absorbed || next.objects.some(n => n.label === o.label && overlap(o.box, n.box) > 0.3))));
    let carried = 0;
    for (const o of prevObjects.filter(x => x.review.by === 'user' && acceptedOnly(x))) {
      const n = next.objects.find(x => x.label === o.label && overlap(o.box, x.box) > 0.3);
      if (n) { n.review = { ...o.review }; if (o.layer) n.layer = o.layer; carried++; }
    }
    kept.objects = carried;
    if (mine.length) {
      const before = next.objects.length;
      // A newly found object gives way to a kept one in the same place (not to a small one inside it: a sweet in a hand).
      const iou = (p: PixelRect, q: PixelRect) => { const ix = Math.max(0, Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x)), iy = Math.max(0, Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y)); return (ix * iy) / Math.max(1, p.width * p.height + q.width * q.height - ix * iy); };
      next.objects = [...next.objects.filter(n => !mine.some(m => iou(m.box, n.box) > 0.5)), ...mine.map(o => ({ ...o }))];
      kept.objects += mine.length; kept.replaced += before - (next.objects.length - mine.length);
      next.objects = orderProductObjects(next.objects); next.objects.forEach((o, i) => { o.z = i; });
      for (const o of next.objects) o.covers = next.objects.filter(q => q.z < o.z && overlap(o.box, q.box) > 0).map(q => q.id);
    }
    // What was chosen for decomposition goes on with the objects found again at the same place under the same name.
    for (const n of next.objects) {
      const o = prevObjects.find(x => x.label === n.label && x.kind === n.kind && overlap(x.box, n.box) > 0.3);
      if (o?.decompose !== undefined && n.decompose === undefined) n.decompose = o.decompose;
      if (o?.layer && !n.layer && n.kind === 'podium') n.layer = o.layer;
    }
    // Only logos the administrator changed or added (every detected slot is made with detection 'admin'). A logo marked
    // corrected but still exactly where the AI put it, under the same name, with no picture of its own (earlier reviews
    // marked every logo they sent) gives way to the newly placed one.
    const untouched = (l: NonNullable<ProtectedTemplate['textAnalysis']>['logoSlots'][number]) => !l.replacement && l.review.status !== 'rejected'
      && (next.aiLogoBoxes ?? []).some(b => b.label === l.label && Math.abs(b.box.x - l.box.x) + Math.abs(b.box.y - l.box.y) + Math.abs(b.box.width - l.box.width) + Math.abs(b.box.height - l.box.height) <= 1);
    const slots = (prevA?.logoSlots ?? []).filter(l => l.corrected && !untouched(l));
    if (slots.length) {
      const before = a.logoSlots.length;
      a.logoSlots = [...a.logoSlots.filter(n => !slots.some(m => overlap(m.box, n.box) > 0.5)), ...slots.map(l => structuredClone(l))];
      kept.logos = slots.length; kept.replaced += before - (a.logoSlots.length - slots.length);
    }
    // Logos are always separate overlays, including recovered legacy analyses.
    for (const n of a.logoSlots) delete n.inBackground;
    for (const cw of (prevA?.words ?? []).filter(w => w.corrected)) {
      const here = a.words.filter(n => !n.corrected && overlap(cw.box, n.box) > 0.4);
      kept.words++;
      if (cw.corrected?.removed) { for (const n of here) { n.review = { status: 'rejected', at: cw.corrected.at }; n.corrected = { at: cw.corrected.at, removed: true }; } continue; }
      const [take, ...rest] = here;
      for (const n of rest) n.review = { status: 'rejected', at: cw.corrected!.at };
      if (take) { Object.assign(take, { text: cw.text, box: { ...cw.box }, normalized: cw.normalized, style: { ...cw.style }, source: cw.source ? { ...cw.source } : take.source, corrected: { ...cw.corrected! }, review: { status: 'approved', at: cw.corrected!.at } }); kept.replaced += here.length; continue; }
      // Nothing found there now (text the administrator added): it comes back in a block of its own (with its old block's words when they came back too).
      const copy = structuredClone(cw), home = a.groups.find(g => g.id === copy.groupId) ?? a.groups.find(g => g.lines.some(l => l.wordIds.some(x => prevA?.groups.find(pg => pg.id === cw.groupId)?.lines.some(pl => pl.wordIds.includes(x)))));
      a.words.push(copy);
      if (home) { copy.groupId = home.id; copy.elementId = home.elementId; const line = home.lines[home.lines.length - 1]; copy.lineId = line.id; line.wordIds.push(copy.id); }
      else { const g = prevA?.groups.find(x => x.id === cw.groupId); a.groups.push({ id: copy.groupId, elementId: copy.elementId, label: '', lines: [{ id: copy.lineId, wordIds: [copy.id] }], align: g?.align ?? 'left', category: g?.category ?? 'supporting' }); }
    }
    tidyGroups(a);
    return kept;
  }

  // --- Review ----------------------------------------------------------------------------------------------------------
  const inCanvas = (b: unknown, size: { width: number; height: number }): b is PixelRect => {
    const r = b as PixelRect;
    return !!r && [r.x, r.y, r.width, r.height].every(finite) && r.width >= 2 && r.height >= 2 && r.x >= -1 && r.y >= -1 && r.x + r.width <= size.width + 1 && r.y + r.height <= size.height + 1;
  };
  const clampBox = (b: PixelRect, size: { width: number; height: number }): PixelRect => { const x = Math.max(0, Math.round(b.x)), y = Math.max(0, Math.round(b.y)); return { x, y, width: Math.max(2, Math.min(size.width - x, Math.round(b.width))), height: Math.max(2, Math.min(size.height - y, Math.round(b.height))) }; };
  /** The whole review state at once (the client keeps undo and redo): objects, text blocks and logos as they should be. */
  const review = (id: string, input: ReviewInput) => locked(id, async () => {
    if (detecting.has(id) || preparingNow(id)) fail('BUSY', 'Wait for detection or decomposition to finish before editing the review.');
    const t = requireProduct(id), size = { width: t.source.width, height: t.source.height }, at = nowIso();
    if (input.expectedRevision !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}, yours ${String(input.expectedRevision)}). Reload it and try again.`, { revision: t.revision });
    if (!Array.isArray(input.objects) || input.objects.length > PRODUCT_LIMITS.maxObjects) fail('INVALID_REQUEST', `Send the objects as a list (at most ${PRODUCT_LIMITS.maxObjects}).`);
    const old = new Map(t.product.objects.map(o => [o.id, o])), objects: ProductObject[] = [];
    for (const o of input.objects) {
      if (!(PRODUCT_OBJECT_KINDS as readonly string[]).includes(o.kind)) fail('INVALID_REQUEST', `Unknown kind ${String(o.kind)}.`);
      if (!inCanvas(o.box, size)) fail('INVALID_REQUEST', `“${String(o.label).slice(0, 40)}” is outside the creative.`);
      const prev = o.id ? old.get(o.id) : undefined, box = clampBox(o.box, size), label = (typeof o.label === 'string' && o.label.trim() ? o.label.trim() : prev?.label ?? o.kind).slice(0, 80);
      const moved = !prev || JSON.stringify(prev.box) !== JSON.stringify(box) || prev.kind !== o.kind;
      const reviewed: ProductObject['review'] = o.accepted ? { status: 'accepted', at, by: 'user' } : prev ? (moved && prev.review.status === 'attention' ? { status: 'accepted', at, by: 'user' } : prev.review) : { status: 'accepted', at, by: 'user' };
      // A stand's layer: as sent (null clears it), else as it was; only podiums and stands have one.
      const layer = o.kind !== 'podium' ? undefined : o.layer === 'own' || o.layer === 'background' ? o.layer : o.layer === null ? undefined : prev?.layer;
      objects.push({ ...(prev?.source ? { source: prev.source, category: prev.category } : {}), ...(prev && prev.kind === o.kind && prev.decompose !== undefined ? { decompose: prev.decompose } : {}), id: prev?.id ?? hexId('po'), kind: o.kind, label, box, confidence: prev && !moved ? prev.confidence : 1, z: 0, covers: [], origin: prev?.origin ?? 'user', review: reviewed, ...(o.hidden ? { hidden: true } : {}), ...(layer ? { layer } : {}) });
    }
    // Back to front by kind and place (a kind changed in the review moves with it).
    const ordered = orderProductObjects(objects);
    objects.splice(0, objects.length, ...ordered);
    objects.forEach((o, i) => { o.z = i; });
    const overlap = (a: PixelRect, b: PixelRect) => Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
    for (const o of objects) o.covers = objects.filter(p => p.z < o.z && overlap(o.box, p.box)).map(p => p.id);
    const a = t.textAnalysis ? structuredClone(t.textAnalysis) : undefined, newSlots: LogoSlot[] = [];
    if (a) {
      for (const change of input.texts ?? []) {
        const g = a.groups.find(x => x.id === change.groupId);
        if (!g) fail('INVALID_REQUEST', 'A text block of the review is not in this template.');
        const ws = g.lines.flatMap(l => l.wordIds.map(wid => a.words.find(w => w.id === wid)).filter((w): w is DetectedWord => !!w));
        if (change.category) g.category = change.category;
        if (change.box) {
          if (!inCanvas(change.box, size)) fail('INVALID_REQUEST', 'The text block is outside the creative.');
          const bounds = unionOf(ws.map(w => boxOf(w.box))), sx = change.box.width / bounds.width, sy = change.box.height / bounds.height;
          for (const w of ws) {
            w.box = { ...w.box, x: change.box.x + (w.box.x - bounds.x) * sx, y: change.box.y + (w.box.y - bounds.y) * sy, width: w.box.width * sx, height: w.box.height * sy };
            w.normalized = normalizeBox(w.box, size);
            w.style = { ...w.style, fontSize: w.style.fontSize * sy, baseline: w.style.baseline * sy };
          }
        }
        if (change.removed !== undefined) for (const w of ws) w.review = change.removed ? { status: 'rejected', at } : (w.review.status === 'rejected' ? { status: 'approved', at } : w.review);
        if (change.accepted) for (const w of ws) if (w.review.status === 'needs-review') w.review = { status: 'approved', at };
        if (typeof change.text === 'string') retype(a, g.id, change.text.slice(0, 2000), at, size);
      }
      for (const change of input.logos ?? []) {
        if (!change.slotId) {
          if (!change.box || !inCanvas(change.box, size)) fail('INVALID_REQUEST', 'A new logo needs its place on the creative.');
          const source = await decodeRgba(store.read(id, t.source.inputFile));
          const added = await logoSlot(source, clampBox(change.box, size), change.label ?? 'Logo', change.category ?? 'partner-logo', (f, png) => store.write(id, f, png), a.logoSlots.length + newSlots.length);
          if (typeof change.replacement === 'string') added.replacement = await reviewAsset(id, change.replacement);
          newSlots.push({ ...added, corrected: { at } });
          continue;
        }
        const s = a.logoSlots.find(x => x.id === change.slotId);
        if (!s) fail('INVALID_REQUEST', 'A logo of the review is not in this template.');
        // A correction is what the administrator changed: the review sends every logo's box, label and category each time.
        const changed = (!!change.category && change.category !== s.category) || (!!change.label && change.label.slice(0, 80) !== s.label)
          || (change.removed !== undefined && change.removed !== (s.review.status === 'rejected'));
        if (change.category) s.category = change.category;
        if (change.label) s.label = change.label.slice(0, 80);
        // Moved or resized: cropped again, exactly, from the original.
        if (change.box && inCanvas(change.box, size)) {
          const b = clampBox(change.box, size);
          if (Math.abs(b.x - s.box.x) + Math.abs(b.y - s.box.y) + Math.abs(b.width - s.box.width) + Math.abs(b.height - s.box.height) > 1) {
            const made = await logoSlot(await decodeRgba(store.read(id, t.source.inputFile)), b, s.label, s.category ?? 'partner-logo', (f, png) => store.write(id, f, png), s.order);
            Object.assign(s, { box: made.box, normalized: made.normalized, original: made.original });
            s.corrected = { at };
          }
        }
        if (change.removed !== undefined) s.review = change.removed ? { status: 'rejected', at } : (s.review.status === 'rejected' ? { status: 'approved', at } : s.review);
        if (change.accepted && s.review.status === 'needs-review') s.review = { status: 'approved', at };
        if (change.replacement === null && s.replacement) { delete s.replacement; s.corrected = { at }; }
        else if (typeof change.replacement === 'string' && change.replacement !== s.replacement?.file) { s.replacement = await reviewAsset(id, change.replacement); s.review = { status: 'approved', at }; s.corrected = { at }; }
        if (changed) s.corrected = { at };
      }
      // Word by word (after the block changes, so they win).
      let pixels: Awaited<ReturnType<typeof decodeRgba>> | undefined;
      for (const change of input.words ?? []) {
        const w = a.words.find(x => x.id === change.wordId) ?? fail('INVALID_REQUEST', 'A word of the review is not in this template.');
        const corrected: NonNullable<DetectedWord['corrected']> = { ...(w.corrected ?? {}), at };
        if (typeof change.text === 'string') {
          const text = change.text.trim();
          if (!text || /\s/.test(text) || text.length > 80) fail('INVALID_REQUEST', `“${change.text.slice(0, 30)}” is not one word. Change several words with the block's wording, or add text.`);
          if (text !== w.text) { w.text = text; corrected.text = true; }
          w.review = { status: 'approved', at };
        }
        if (change.box) {
          if (!inCanvas(change.box, size)) fail('INVALID_REQUEST', `The word “${w.text}” is outside the creative.`);
          const b = clampBox(change.box, size), old = w.box;
          if (Math.abs(b.x - old.x) + Math.abs(b.y - old.y) + Math.abs(b.width - old.width) + Math.abs(b.height - old.height) > 0.5) {
            const sy = b.height / Math.max(1, old.height), sx = b.width / Math.max(1, old.width);
            w.box = { ...b, rotation: old.rotation }; w.normalized = normalizeBox(w.box, size);
            // Its face, size and spacing found again from the letters in the corrected box (a box that took in a divider
            // under the word had made "CHATURTHI" a thin face a third too tall; scaling that style kept the wrong face).
            pixels ??= await decodeRgba(store.read(id, t.source.inputFile));
            const again = old.rotation ? undefined : (await styleLine(pixels, [{ text: w.text, box: w.box }]))[0];
            w.style = again && again.confidence > 0 ? { ...again.style, opacity: w.style.opacity, lineHeight: w.style.lineHeight, align: w.style.align }
              : { ...w.style, fontSize: w.style.fontSize * sy, baseline: w.style.baseline * sy, ...(w.style.originDx !== undefined ? { originDx: w.style.originDx * sx } : {}) };
            // Its pixels are removed where the administrator says it is.
            if (w.source) w.source = { ...w.source, box: { ...w.box } };
            corrected.box = true;
          }
        }
        if (change.removed !== undefined) { w.review = change.removed ? { status: 'rejected', at } : { status: 'approved', at }; corrected.removed = change.removed; }
        if (change.groupId && change.groupId !== w.groupId) { moveWord(a, w, change.groupId); corrected.group = true; }
        w.corrected = corrected;
      }
      if (input.newTexts?.length) {
        const source = await decodeRgba(store.read(id, t.source.inputFile));
        for (const text of input.newTexts.slice(0, 40)) await addText(id, a, text, source, at, size);
      }
      tidyGroups(a);
      for (const brand of objects.filter(o => o.kind === 'brand-logo' && !o.hidden)) {
        const slot = await logoSlot(await decodeRgba(store.read(id, t.source.inputFile)), brand.box, brand.label, 'brand-logo', (f, png) => store.write(id, f, png), a.logoSlots.length + newSlots.length);
        newSlots.push(slot);
      }
      objects.splice(0, objects.length, ...objects.filter(o => o.kind !== 'brand-logo'));
      a.logoSlots.push(...newSlots);
      a.revision += 1; a.updatedAt = at;
    }
    const saved = store.update(id, input.expectedRevision, x => {
      if (a) x.textAnalysis = a;
      const p = x.product!;
      p.objects = objects; p.objectsRevision += 1;
      if (input.dismissMissingText && p.detection) p.detection = { ...p.detection, missingText: [] };
      history(p, { action: 'reviewed', detail: `${objects.length} object(s); ${newSlots.length ? `${newSlots.length} logo(s) added; ` : ''}text and logos as reviewed.` });
    });
    return view(saved.id);
  });
  /**
   * Asked for explicitly (never on its own): the AI-read text lines moved onto their letters in the picture (wordFit.ts:
   * on this computer, no AI request), each moved line's style measured again there and its source crop taken again.
   * Lines a person corrected, rotated words and other text stay. A new analysis revision: a prepared or approved
   * template is prepared (and approved) again; its saved revisions do not change.
   */
  const fitText = (id: string, input: { expectedRevision?: number }) => locked(id, async () => {
    if (detecting.has(id) || preparingNow(id)) fail('BUSY', 'Wait for detection or decomposition to finish before fitting the text.');
    const t = requireProduct(id), at = nowIso(), size = { width: t.source.width, height: t.source.height };
    if (input.expectedRevision !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}, yours ${String(input.expectedRevision)}). Reload it and try again.`, { revision: t.revision });
    const a = t.textAnalysis ? structuredClone(t.textAnalysis) : undefined;
    if (!a || t.product.variation || !a.words.some(w => w.origin === 'ai' && w.review.status !== 'rejected')) fail('NOTHING_TO_FIT', 'This template has no text read by the AI analysis to fit.');
    const sourceBytes = store.read(id, t.source.inputFile), source = await decodeRgba(sourceBytes);
    const lines = a.groups.flatMap(g => g.lines.map(l => l.wordIds.map(w => a.words.find(x => x.id === w)).filter((w): w is DetectedWord => !!w && w.review.status !== 'rejected'))).filter(l => l.length);
    const keep = lines.map(ws => ws.some(w => w.origin !== 'ai' || !!w.box.rotation || !!w.corrected?.box));
    const fits = await fitLines(source, lines.map(ws => ws.map(w => ({ text: w.text, box: w.source?.box ?? w.box }))), options.recognizer(), keep);
    const report = lines.map((ws, i) => ({ text: ws.map(w => w.text).join(' ').slice(0, 120), method: fits[i].method, moved: fits[i].moved, ...(keep[i] ? { reason: 'corrected by a person, rotated or not read by the analysis' } : fits[i].reason ? { reason: fits[i].reason } : {}) }));
    let moved = 0;
    for (const [i, ws] of lines.entries()) {
      if (fits[i].method === 'kept' || fits[i].moved < 1) continue;
      moved++;
      for (const [k, w] of ws.entries()) {
        const b = fits[i].boxes[k], box = { x: b.x, y: b.y, width: b.width, height: b.height, rotation: 0 };
        const rect = { left: Math.max(0, Math.floor(box.x)), top: Math.max(0, Math.floor(box.y)) }, crop = await sharp(sourceBytes).extract({ ...rect, width: Math.max(1, Math.min(Math.ceil(box.width), size.width - rect.left)), height: Math.max(1, Math.min(Math.ceil(box.height), size.height - rect.top)) }).png().toBuffer();
        const file = `word-${w.id}-${sha256(crop).slice(0, 12)}.png`;
        if (!store.has(id, file)) store.write(id, file, crop);
        w.box = box; w.normalized = normalizeBox(box, size); w.source = { box: { ...box }, crop: file, z: w.source?.z ?? w.order };
      }
      const styled = await styleLine(source, ws.map(w => ({ text: w.text, box: w.box })));
      ws.forEach((w, k) => { if (styled[k].confidence > 0) w.style = { ...styled[k].style, opacity: w.style.opacity, lineHeight: w.style.lineHeight, align: w.style.align }; });
    }
    if (!moved) return { ...view(id), fit: { moved, lines: report } };
    a.revision += 1; a.updatedAt = at;
    a.history = withHistory(a.history, { at, action: 'corrected', detail: `Text boxes of ${moved} line(s) fitted to their letters in the picture.` });
    const saved = store.update(id, input.expectedRevision, x => { x.textAnalysis = a; history(x.product!, { action: 'reviewed', detail: `Text boxes of ${moved} line(s) fitted to their letters (on this computer, no AI request).` }); });
    return { ...view(saved.id), fit: { moved, lines: report } };
  });
  /** A text block typed again: the new words take the old words' places in order (extra words follow on its last line). */
  function retype(a: NonNullable<ProtectedTemplate['textAnalysis']>, groupId: string, text: string, at: string, size: { width: number; height: number }) {
    const g = a.groups.find(x => x.id === groupId)!, lines = text.split('\n').map(l => l.split(/\s+/).filter(Boolean)).filter(l => l.length);
    const old = g.lines.flatMap(l => l.wordIds.map(id => a.words.find(w => w.id === id)).filter((w): w is DetectedWord => !!w && w.review.status !== 'rejected'));
    if (!old.length || !lines.length) return;
    const flat = lines.flat();
    flat.forEach((word, i) => {
      const w = old[Math.min(i, old.length - 1)];
      if (i < old.length) { w.text = word; w.review = { status: 'approved', at }; return; }
      // A word more: after the last one, as wide as its letters in the last word's size.
      const last = a.words.find(x => x.id === g.lines[g.lines.length - 1].wordIds[g.lines[g.lines.length - 1].wordIds.length - 1]) ?? w, width = Math.max(4, word.length * last.style.fontSize * 0.55);
      const box: SourceBox = { ...last.box, x: last.box.x + last.box.width + last.style.fontSize * 0.3, width };
      const added: DetectedWord = { ...structuredClone(last), id: hexId('pw'), text: word, box, normalized: normalizeBox(box, size), order: last.order + 1, origin: 'admin', review: { status: 'approved', at } };
      a.words.push(added); g.lines[g.lines.length - 1].wordIds.push(added.id);
    });
    for (const w of old.slice(flat.length)) w.review = { status: 'rejected', at };
  }

  /** A word moved to another block (on the line at its height, else a new line), or to a block of its own ('new'). */
  function moveWord(a: NonNullable<ProtectedTemplate['textAnalysis']>, w: DetectedWord, target: string) {
    const from = a.groups.find(g => g.id === w.groupId);
    if (from) for (const l of from.lines) l.wordIds = l.wordIds.filter(x => x !== w.id);
    let g = target === 'new' ? undefined : a.groups.find(x => x.id === target);
    if (target !== 'new' && !g) fail('INVALID_REQUEST', 'That text block is not in this template.');
    if (!g) { g = { id: hexId('pg'), elementId: hexId('pe'), label: '', lines: [], align: from?.align ?? 'left', category: from?.category ?? 'supporting' }; a.groups.push(g); }
    const cy = w.box.y + w.box.height / 2;
    let line = g.lines.find(l => l.wordIds.some(x => { const o = a.words.find(v => v.id === x); return !!o && Math.abs(o.box.y + o.box.height / 2 - cy) < Math.max(o.box.height, w.box.height) * 0.6; }));
    if (!line) { line = { id: hexId('pn'), wordIds: [] }; g.lines.push(line); }
    line.wordIds.push(w.id);
    w.groupId = g.id; w.lineId = line.id; w.elementId = g.elementId;
  }
  /** Blocks after word changes: empty lines and blocks dropped, lines top to bottom and words left to right, labels again. */
  function tidyGroups(a: NonNullable<ProtectedTemplate['textAnalysis']>) {
    const word = (x: string) => a.words.find(v => v.id === x);
    for (const g of a.groups) {
      g.lines = g.lines.filter(l => l.wordIds.length);
      for (const l of g.lines) l.wordIds.sort((p, q) => (word(p)?.box.x ?? 0) - (word(q)?.box.x ?? 0));
      g.lines.sort((p, q) => Math.min(...p.wordIds.map(x => word(x)?.box.y ?? 0)) - Math.min(...q.wordIds.map(x => word(x)?.box.y ?? 0)));
      g.label = g.lines.flatMap(l => l.wordIds.map(word).filter((w): w is DetectedWord => !!w && w.review.status !== 'rejected').map(w => w.text)).join(' ').slice(0, 200);
    }
    a.groups = a.groups.filter(g => g.lines.length);
    let order = 0;
    for (const g of a.groups) for (const l of g.lines) for (const x of l.wordIds) { const w = word(x); if (w) w.order = order++; }
  }
  /** Text the detection missed: a block of its own, its words laid across the drawn box, its colour measured there. */
  async function addText(id: string, a: NonNullable<ProtectedTemplate['textAnalysis']>, input: NonNullable<ReviewInput['newTexts']>[number], source: Awaited<ReturnType<typeof decodeRgba>>, at: string, size: { width: number; height: number }) {
    const words = typeof input.text === 'string' ? input.text.trim().split(/\s+/).filter(Boolean).slice(0, 40) : [];
    if (!words.length || words.some(x => x.length > 80)) fail('INVALID_REQUEST', 'Type the text you added (up to 40 words).');
    if (!inCanvas(input.box, size)) fail('INVALID_REQUEST', 'The added text is outside the creative.');
    const box = clampBox(input.box, size), m = measureWord(source, box, words.join(' ')), category = input.category && isMasterCategory(input.category) ? input.category : 'supporting';
    let fontSize = Math.max(6, Math.min(m.fontSize, box.height * 0.9));
    const style0 = { fontFamily: 'Inter', fontWeight: (m.fontWeight === 400 ? 400 : m.fontWeight === 700 ? 700 : 600) as 400 | 600 | 700, fontStyle: 'normal' as const, letterSpacing: 0, color: m.color, opacity: 1 };
    const width = (s: number) => words.reduce((sum, x) => sum + estimateAdvance(x, { ...style0, fontSize: s }), 0) + estimateAdvance(' ', { ...style0, fontSize: s }) * (words.length - 1);
    if (width(fontSize) > box.width) fontSize = Math.max(6, fontSize * box.width / width(fontSize));
    const g = { id: hexId('pg'), elementId: hexId('pe'), label: words.join(' ').slice(0, 200), lines: [{ id: hexId('pn'), wordIds: [] as string[] }], align: 'left' as const, category };
    const role = category === 'legal' ? 'legal' : category === 'offer' ? 'claim' : 'copy', space = estimateAdvance(' ', { ...style0, fontSize });
    let x = box.x;
    for (const text of words) {
      const wbox: SourceBox = { x, y: box.y, width: Math.max(2, estimateAdvance(text, { ...style0, fontSize })), height: box.height, rotation: 0 };
      const rect = { left: Math.max(0, Math.floor(wbox.x)), top: Math.max(0, Math.floor(wbox.y)), width: 0, height: 0 };
      rect.width = Math.max(1, Math.min(size.width - rect.left, Math.ceil(wbox.width))); rect.height = Math.max(1, Math.min(size.height - rect.top, Math.ceil(wbox.height)));
      const crop = await sharp(source.data, { raw: { width: source.width, height: source.height, channels: 4 } }).extract(rect).png().toBuffer(), wid = hexId('pw'), file = `word-${wid}-${sha256(crop).slice(0, 12)}.png`;
      store.write(id, file, crop);
      a.words.push({ id: wid, text, recognized: { text, confidence: 1, mode: 'admin' }, box: wbox, normalized: normalizeBox(wbox, size), elementId: g.elementId, groupId: g.id, lineId: g.lines[0].id, order: a.words.length,
        style: { ...style0, fontSize, fontMatch: 'admin', lineHeight: 1.2, baseline: Math.min(box.height, m.baseline || box.height * 0.8), align: 'left' }, confidence: 1, styleConfidence: 0.5, role, protected: role !== 'copy',
        review: { status: 'approved', at }, locked: false, origin: 'admin', source: { box: { ...wbox }, crop: file, z: a.words.length }, corrected: { at, added: true } });
      g.lines[0].wordIds.push(wid);
      x += wbox.width + space;
    }
    a.groups.push(g);
  }
  /** A picture uploaded during the review (a logo's replacement): stored as the template's own file, nothing else changes. */
  async function reviewAsset(id: string, file: string) {
    if (!/^prl-[a-f0-9]{12}\.(png|jpg|webp)$/.test(file) || !store.has(id, file)) fail('INVALID_REQUEST', 'That picture was not uploaded for this template.');
    const bytes = store.read(id, file), meta = await sharp(bytes).metadata();
    return { file, sha256: sha256(bytes), mime: `image/${meta.format === 'jpeg' ? 'jpeg' : meta.format}`, width: meta.width ?? 1, height: meta.height ?? 1, bytes: bytes.length, hasAlpha: !!meta.hasAlpha };
  }
  /** Stores a picture for the review (no change to the template until the review is saved). */
  async function uploadReviewAsset(id: string, bytes: Buffer) {
    requireProduct(id);
    let meta; try { meta = await sharp(bytes).metadata(); } catch { fail('UNSUPPORTED_IMAGE', 'That file could not be read as a picture. Use a PNG, JPEG or WebP image.'); }
    const ext = meta.format === 'jpeg' ? 'jpg' : meta.format === 'webp' ? 'webp' : meta.format === 'png' ? 'png' : fail('UNSUPPORTED_IMAGE', 'Use a PNG, JPEG or WebP image.');
    const file = `prl-${sha256(bytes).slice(0, 12)}.${ext}`;
    if (!store.has(id, file)) store.write(id, file, bytes);
    return { file, width: meta.width ?? 1, height: meta.height ?? 1 };
  }

  // --- Prepare, approve, save --------------------------------------------------------------------------------------------
  const preparing = preparingIds;
  /** What preparing will cost: nothing locally; one SAM-3 request per object when the provider is chosen. */
  /**
   * What is decomposed, as the person chose after the review: each character, product, decoration or frame cut out as a
   * layer or left in the background, each stand its own layer or not, each brand logo or graphic a layer or kept in the
   * picture. Text, bank and payment logos and QR codes are always editable layers (never decomposed, never in the
   * background). Kept with the template: a later preparation, and detection run again, use it.
   */
  const select = (id: string, input: { expectedRevision?: unknown; objects?: unknown; logos?: unknown }) => locked(id, async () => {
    if (detecting.has(id) || preparingNow(id)) fail('BUSY', 'Wait for detection or decomposition to finish before changing the selection.');
    const t = requireProduct(id);
    if (input.expectedRevision !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}, yours ${String(input.expectedRevision)}). Reload it and try again.`, { revision: t.revision });
    const objects = Array.isArray(input.objects) ? input.objects as { id?: unknown; decompose?: unknown }[] : [], logos = Array.isArray(input.logos) ? input.logos as { slotId?: unknown; separate?: unknown }[] : [];
    const at = nowIso();
    const saved = store.update(id, t.revision, x => {
      const p = x.product!;
      for (const c of objects) {
        const o = p.objects.find(q => q.id === c.id); if (!o || typeof c.decompose !== 'boolean') continue;
        if (o.kind === 'podium') o.layer = c.decompose ? 'own' : 'background';
        else if (o.kind === 'character' || o.kind === 'product') { if (c.decompose) delete o.decompose; else o.decompose = false; }
        else if (o.kind === 'decoration' || o.kind === 'frame') { if (c.decompose) o.decompose = true; else delete o.decompose; }
      }
      for (const c of logos) {
        const l = x.textAnalysis?.logoSlots.find(q => q.id === c.slotId); if (!l || typeof c.separate !== 'boolean') continue;
        delete l.inBackground;
      }
      if (!p.objects.some(decomposesObject)) fail('INVALID_REQUEST', 'Choose at least one element to decompose.');
      p.objectsRevision += 1; delete p.approved;
      p.selection = { at, objectsRevision: p.objectsRevision };
      const cut = p.objects.filter(decomposesObject).length + p.objects.filter(o => !o.hidden && o.kind === 'podium' && o.layer === 'own').length, kept = (x.textAnalysis?.logoSlots ?? []).filter(l => l.inBackground).length;
      history(p, { action: 'reviewed', detail: `Chosen for decomposition: ${cut} element(s); ${p.objects.filter(o => !o.hidden && !decomposesObject(o) && o.layer !== 'own').length} kept in the background${kept ? `, ${kept} logo(s) kept in the picture` : ''}.` });
    });
    return view(saved.id);
  });
  function estimate(id: string) {
    const t = requireProduct(id), objects = t.product.objects.filter(decomposesObject).length, configured = !!options.segmenter?.();
    // Explicit AI preparation re-segments chosen objects, even when native cutouts are available.
    const layerizer = options.layerizer?.(), toAsk = objects;
    const sent = sentSize(t.source.width, t.source.height), e = aiDecompositionEstimate(sent, toAsk);
    return { objects, local: { usd: 0 }, sam3: { configured, requests: objects, usd: Math.round(objects * 0.01 * 100) / 100, note: 'One SAM-3 mask request per object ($0.01 each), sent only individually masked character/product crops.' },
      ai: { configured: !!layerizer, offline: layerizer?.offline ?? false, planner: layerizer?.planner ?? '', engine: layerizer?.engine ?? '', elements: toAsk, requests: toAsk ? 2 : 0, sentSize: { width: sent.width, height: sent.height },
        expectedUsd: toAsk && !layerizer?.offline ? e.expectedUsd : 0, maxUsd: toAsk && !layerizer?.offline ? e.maxUsd : 0,
        note: toAsk ? `One OpenAI planning request (about $${e.plannerUsd.toFixed(2)}) and one Seedream Layerize request ($${e.perLayerUsd} per returned layer, at most 17) on a ${sent.width}×${sent.height} copy of the picture without its text and logos.` : 'Every element already has its own layer: nothing would be sent.' } };
  }
  /** Prepares in the background: overlays out (gated), objects cut out, the base behind them, the checks (prepare.ts). */
  const startPrepare = (id: string, input: { expectedRevision?: unknown; paid?: unknown; engine?: unknown; approveUsd?: unknown }) => locked(id, async () => {
    const t = requireProduct(id);
    if (input.expectedRevision !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}, yours ${String(input.expectedRevision)}). Reload it and try again.`, { revision: t.revision });
    if (t.product.detection?.ai?.status !== 'done') fail('NOT_READY', 'AI detection not completed. Retry analysis with an available, authorized provider before preparing.');
    if (!t.product.objects.some(decomposesObject)) fail('NOT_READY', 'Nothing is chosen for decomposition: choose at least one character, product or graphic to cut out (or correct the detections).');
    if (t.product.objects.some(o => decomposesObject(o) && o.review.status !== 'accepted')) fail('NOT_READY', 'Review the uncertain elements chosen for decomposition first.');
    if (preparing.has(id)) return { started: false };
    // engine 'ai': the OpenAI planner and Seedream Layerize (paid: the request carries the approved amount, never implied).
    const engine = input.engine === 'ai' ? 'ai' as const : input.paid === true ? 'sam3' as const : 'local' as const;
    if (t.product.variation?.decompositionEngine === 'ai' && engine !== 'ai') fail('AI_REQUIRED', 'This variation was sent for AI decomposition. Confirm OpenAI + Seedream preparation; local conversion is a separate action.');
    if (t.product.prepared?.version === PRODUCT_PREPARE_VERSION && t.product.prepared.objectsRevision === t.product.objectsRevision && t.product.prepared.analysisRevision === (t.textAnalysis?.revision ?? 0) &&
      (engine === 'local' || t.product.prepared.separation.method === (engine === 'ai' ? 'seedream' : 'sam3'))) return { started: false };
    if (engine === 'sam3' && !options.segmenter?.()) fail('NOT_CONFIGURED', 'The cut-out service is not configured on this server; prepare without it.');
    if (engine === 'ai') {
      const e = estimate(id).ai;
      if (!e.configured) fail('NOT_CONFIGURED', 'AI decomposition is not configured on this server (it needs OPENAI_API_KEY and FAL_KEY); decompose on this computer instead.');
      if (!e.elements) fail('NOTHING_TO_SEND', 'Every element already has its own layer: decompose on this computer (free), nothing would be sent.');
      if (e.maxUsd > 0 && !(typeof input.approveUsd === 'number' && input.approveUsd >= e.maxUsd)) fail('APPROVAL_REQUIRED', `AI decomposition makes one OpenAI planning request and one Seedream Layerize request: at most $${e.maxUsd.toFixed(2)}. Approve the cost to decompose with AI.`, { maxUsd: e.maxUsd, expectedUsd: e.expectedUsd });
    }
    preparing.add(id);
    void runPrepare(id, engine).catch(error => console.error('product prepare', id, error)).finally(() => preparing.delete(id));
    return { started: true };
  });
  /** The overlay gate's refusal, naming the text it is about and what to do (its boxes off the letters: the usual cause). */
  const gateMessage = (error: OverlayGateError, a: ProtectedTemplate['textAnalysis']) => {
    if (!a || !/still in the picture/.test(error.message)) return error.message;
    const over = (p: PixelRect, q: PixelRect) => p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
    const named = a.groups.filter(g => a.words.some(w => w.groupId === g.id && w.review.status !== 'rejected' && error.areas.some(b => over(w.source?.box ?? w.box, b))))
      .map(g => `“${g.label.length > 48 ? `${g.label.slice(0, 48)}…` : g.label}”`);
    return `${error.message}${named.length ? ` (${named.slice(0, 2).join(', ')})` : ''} Its text boxes may not sit on the letters: use “Fit text to the letters” in the review (free, on this computer), or correct the boxes, then prepare again.`;
  };
  async function runPrepare(id: string, engine: 'ai' | 'sam3' | 'local') {
    const started = Date.now(), at = nowIso(), t = requireProduct(id), objectsRevision = t.product.objectsRevision, analysisRevision = t.textAnalysis?.revision ?? 0, paid = engine !== 'local';
    await service.updateMaster(id, undefined, x => { x.product!.preparing = { status: 'running', startedAt: at, paid, engine }; });
    try {
      const source = await decodeRgba(store.read(id, t.source.inputFile));
      // A template made from a variation: its own layers, background and picture without text and logos (exact).
      const v = t.product.variation;
      if (v?.cleanSha256 && sha256(store.read(id, v.clean)) !== v.cleanSha256) fail('INVALID_ASSET', 'The saved overlay-free composition changed. Recreate the variation before decomposition.');
      const known = v ? { background: await decodeRgba(store.read(id, v.background)), clean: await decodeRgba(store.read(id, v.clean)), verifiedComposition: !!v.cleanSha256, layers: v.layers.map(l => ({ label: l.label, kind: l.kind, box: l.box, png: store.read(id, l.file) })),
        plates: (v.plates ?? []).map(p => ({ box: p.box, png: store.read(id, p.file) })) } : undefined;
      const analysis = t.textAnalysis ? structuredClone(t.textAnalysis) : undefined;
      // Every saved logo is restored independently, including legacy logos previously kept in the background.
      for (const logo of analysis?.logoSlots ?? []) delete logo.inBackground;
      const result = await prepareProduct({ source, analysis, objects: t.product.objects, segmenter: engine === 'sam3' ? options.segmenter?.() : undefined, paidApproved: paid,
        ...(engine === 'ai' ? { layerizer: options.layerizer?.(), requireAiMatches: !!v } : {}), ...(known ? { known } : {}),
        save: (f, value) => store.write(id, `prepare-${f.replace(/\.json$/i, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 80)}.json`, Buffer.from(JSON.stringify(value, null, 2))),
        saveImage: (f, png) => store.write(id, `prepare-${f.replace(/\.png$/i, '')}-${sha256(png).slice(0, 12)}.png`, png) });
      const file = (prefix: string, png: Buffer) => { const name = `${prefix}-${sha256(png).slice(0, 12)}.png`; if (!store.has(id, name)) store.write(id, name, png); return { file: name, sha256: sha256(png) }; };
      const clean = file('pclean', result.clean), base = file('pbase', result.base);
      const cutouts = new Map(result.cutouts.map(c => [c.id, { ...c, ...file(`pcut-${c.id}`, c.png) }]));
      // Display stands: layers of their own, under every product and character (back to front: the farther first).
      const lowest = Math.min(...t.product.objects.filter(o => !o.hidden && (o.kind === 'product' || o.kind === 'character')).map(o => o.z));
      const stands: NonNullable<ProductPrepared['stands']> = result.stands.map((s, k) => {
        const f = file(`pstand-${sha256(Buffer.from(`${id}:${s.hint ?? s.key}`)).slice(0, 10)}`, s.png);
        return { id: s.hint ?? `po-${sha256(Buffer.from(`${id}:stand:${s.key}`)).slice(0, 10)}`, kind: 'podium' as const, label: s.label, box: { ...s.placement },
          confidence: s.uncertain ? 0.6 : 0.9, z: lowest - 1 + (k + 1) / (result.stands.length + 1), covers: [], origin: s.source === 'user' ? 'user' as const : 'local' as const,
          review: { status: 'accepted' as const, by: s.source === 'user' ? 'user' as const : 'auto' as const }, layer: 'own' as const,
          cutout: { file: f.file, sha256: f.sha256, placement: { ...s.placement }, method: 'local' as const, coverage: Math.round(100 * s.visiblePixels / Math.max(1, s.visiblePixels + s.completedPixels)) / 100,
            quality: s.uncertain ? 'check' as const : 'good' as const, ...(s.uncertain ? { note: 'Mostly hidden behind the products: most of it is an estimate.' } : {}) },
          stand: { under: s.under, visiblePixels: s.visiblePixels, completedPixels: s.completedPixels, uncertain: s.uncertain } };
      });
      await service.updateMaster(id, undefined, x => {
        const p = x.product!;
        if (p.objectsRevision !== objectsRevision || (x.textAnalysis?.revision ?? 0) !== analysisRevision) { p.preparing = { status: 'failed', startedAt: at, paid, error: 'The elements changed while preparing: prepare again.' }; return; }
        if (analysis) x.textAnalysis = analysis;
        for (const o of p.objects) {
          const c = cutouts.get(o.id);
          if (!c) { delete o.cutout; delete o.slot; continue; }
          o.cutout = { file: c.file, sha256: c.sha256, placement: c.placement, method: c.method, coverage: c.coverage, quality: c.quality, ...(c.note ? { note: c.note } : {}) };
          if (o.kind === 'character' || o.kind === 'product') o.slot = { box: { ...c.placement }, contactY: c.contactY, targetHeight: c.contactY - c.placement.y + 1, z: o.z };
        }
        p.prepared = { version: PRODUCT_PREPARE_VERSION, at: nowIso(), objectsRevision, analysisRevision, clean, base,
          previews: { recombined: file('precombined', result.recombined).file, recombinedClean: file('precombined-clean', result.recombinedClean).file, overlayMask: file('pmask', result.overlayMask).file, overlays: file('poverlays', result.overlays).file, estimated: file('pestimated', result.estimated).file },
          separation: result.separation, quality: result.quality, ...(stands.length ? { stands } : {}), durationMs: Date.now() - started };
        p.preparing = { status: 'done', startedAt: at, paid, engine };
        const ai = result.separation.method === 'seedream' && !result.separation.ai?.offline;
        p.activity = { ...p.activity, aiCalls: p.activity.aiCalls + (ai ? 1 : 0), segmentRequests: p.activity.segmentRequests + (ai ? 1 : result.separation.method === 'sam3' ? result.separation.requests : 0), costUsd: Math.round((p.activity.costUsd + result.separation.costUsd) * 10000) / 10000 };
        delete p.approved;
        history(p, { action: 'prepared', detail: `${result.cutouts.length} object(s) cut out (${result.separation.method === 'seedream' ? `AI: ${result.separation.ai?.planner} plan → ${result.separation.ai?.engine}, ${result.separation.ai?.matched.length} element(s) from its layers${result.separation.ai?.unmatched.length ? `, ${result.separation.ai.unmatched.length} locally` : ''}, $${result.separation.costUsd.toFixed(2)}` : result.separation.method === 'sam3' ? `SAM-3, ${result.separation.requests} request(s)` : 'locally'})${stands.length ? `, ${stands.length} display stand(s) on their own layers` : ''}; ${result.quality.issues.length} check(s) to look at.` });
      });
    } catch (error) {
      const message = error instanceof OverlayGateError ? gateMessage(error, t.textAnalysis) : error instanceof Error ? error.message.slice(0, 300) : String(error);
      await service.updateMaster(id, undefined, x => { x.product!.preparing = { status: 'failed', startedAt: at, paid, engine, error: message }; });
      throw error;
    }
  }
  /**
   * The administrator accepts the prepared template, every check acknowledged; a blocking one must be fixed, unless the
   * person explicitly saves a draft with its quality warnings (`draft`: recorded with the revision and shown with it).
   */
  const approve = (id: string, input: { expectedRevision?: unknown; acknowledge?: unknown; draft?: unknown }) => locked(id, async () => {
    const t = requireProduct(id), p = t.product;
    if (input.expectedRevision !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}). Reload it and try again.`, { revision: t.revision });
    if (!p.prepared || p.prepared.objectsRevision !== p.objectsRevision) fail('NOT_READY', 'Prepare the template first (its elements changed since it was prepared).');
    const blocking = p.prepared.quality.issues.filter(i => i.blocking), draft = input.draft === true;
    if (blocking.length && !draft) fail('NOT_READY', `Fix these first, or save a draft with these warnings: ${blocking.map(i => i.message).join(' ')}`);
    const ack = Array.isArray(input.acknowledge) ? input.acknowledge.filter((v): v is string => typeof v === 'string') : [];
    const open = p.prepared.quality.issues.filter(i => !ack.includes(i.id));
    if (open.length) fail('ACKNOWLEDGEMENT_REQUIRED', `Look at ${open.length} check(s) and confirm them.`, { issues: open.map(i => i.id) });
    const saved = store.update(id, t.revision, x => { const q = x.product!; q.approved = { at: nowIso(), objectsRevision: q.objectsRevision, baseSha256: q.prepared!.base.sha256, acknowledged: ack, ...(draft ? { draft: true } : {}) }; history(q, { action: 'approved', ...(draft ? { detail: 'As a draft with quality warnings.' } : {}) }); });
    return view(saved.id);
  });
  // --- Generation instructions and the decomposition plan ----------------------------------------------------------
  /** The brief as FrameFlow writes it from the template (free: the saved detection answer, the elements, the picture). */
  async function derivedBrief(t: ProductRecord): Promise<ProductGenerationBrief> {
    // A variation's template: its master's instructions (what made it).
    if (t.product.variation) { try { const m = requireProduct(t.product.variation.templateId).product.generation; if (m) return { ...structuredClone(m), derivedAt: nowIso() }; } catch { /* the master is gone: derived from itself */ } }
    let answer: DetectionAnswer | undefined;
    try { if (store.has(t.id, 'analysis-product-response.json')) answer = JSON.parse((JSON.parse(store.read(t.id, 'analysis-product-response.json').toString('utf8')) as { output_text?: string }).output_text ?? '{}') as DetectionAnswer; } catch { answer = undefined; }
    const picture = await decodeRgba(store.read(t.id, t.product.prepared?.base.file ?? t.source.inputFile));
    return deriveBrief({ name: t.name, canvas: { width: t.source.width, height: t.source.height }, objects: t.product.objects, analysis: t.textAnalysis, answer, palette: paletteOf(picture, 5), at: nowIso() });
  }
  /** What new creatives should look like (saved, else derived now) and how the template is decomposed. */
  async function brief(id: string) {
    const t = requireProduct(id);
    return { generation: t.product.generation ?? await derivedBrief(t), saved: !!t.product.generation, decomposition: decompositionPlan(t.product.objects, t.textAnalysis, t.product.prepared?.separation.method ?? 'local') };
  }
  /** The person's edit of the generation instructions (any of the text fields, the prompt); kept as edited. */
  const editBrief = (id: string, input: { expectedRevision?: unknown; brief?: unknown; derive?: unknown }) => locked(id, async () => {
    const t = requireProduct(id);
    if (input.expectedRevision !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}). Reload it and try again.`, { revision: t.revision });
    const base = input.derive === true ? await derivedBrief(t) : t.product.generation ?? await derivedBrief(t), next: ProductGenerationBrief = structuredClone(base);
    const patch = (input.brief && typeof input.brief === 'object' ? input.brief : {}) as Record<string, unknown>;
    for (const k of ['subject', 'style', 'background', 'layout', 'typography', 'negative', 'prompt'] as const) if (typeof patch[k] === 'string') next[k] = (patch[k] as string).slice(0, k === 'prompt' ? 2000 : 800);
    if (Array.isArray(patch.palette)) next.palette = (patch.palette as unknown[]).filter((v): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)).slice(0, 8);
    if (input.derive !== true && Object.keys(patch).length) next.edited = { at: nowIso() }; else if (input.derive === true) delete next.edited;
    const saved = store.update(id, t.revision, x => { x.product!.generation = next; history(x.product!, { action: 'reviewed', detail: input.derive === true ? 'Generation instructions written again from the template.' : 'Generation instructions edited.' }); });
    return { ...(await brief(saved.id)), template: view(saved.id) };
  });
  /** Saves the approved template as a new revision (never changing an older one). */
  const publish = (id: string, input: { expectedRevision?: unknown }) => locked(id, async () => {
    const t = requireProduct(id), p = t.product;
    if (input.expectedRevision !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}). Reload it and try again.`, { revision: t.revision });
    if (!p.approved || p.approved.objectsRevision !== p.objectsRevision || !p.prepared) fail('NOT_READY', 'Approve the prepared template first.');
    return writeSnapshot(t, !!p.approved.draft);
  });
  async function writeSnapshot(t: ProductRecord, draft: boolean) {
    const id = t.id, p = t.product;
    if (!p.prepared || p.prepared.objectsRevision !== p.objectsRevision || p.prepared.analysisRevision !== (t.textAnalysis?.revision ?? 0)) fail('NOT_READY', 'Prepare the current reviewed elements first.');
    const a = t.textAnalysis, revision = (p.revisions[p.revisions.length - 1]?.revision ?? 0) + 1, at = nowIso(), generation = p.generation ?? await derivedBrief(t);
    const snapshot: ProductSnapshot = { schemaVersion: PRODUCT_SCHEMA_VERSION, templateId: id, revision, publishedAt: at, name: t.name, canvas: { width: t.source.width, height: t.source.height },
      source: { file: t.source.inputFile, sha256: t.source.sha256 }, clean: p.prepared.clean, base: p.prepared.base, objects: [...p.objects.filter(o => !o.hidden && o.cutout), ...(p.prepared.stands ?? []).map(o => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'stand')) as ProductObject)],
      words: (a?.words ?? []).filter(w => w.review.status !== 'rejected'), groups: a?.groups ?? [], logoSlots: (a?.logoSlots ?? []).filter(s => s.review.status !== 'rejected' && !s.inBackground), plates: (a?.plates ?? []).filter(pl => pl.review.status !== 'rejected'),
      detection: p.detection, backgroundStructure: p.objects.filter(o => !['character', 'product', 'brand-logo'].includes(o.kind)), quality: p.prepared.quality, prepareVersion: p.prepared.version,
      preparation: p.prepared, selectedObjects: p.objects,
      ...(draft ? { draft: { warnings: p.prepared.quality.issues.map(i => ({ id: i.id, message: i.message, blocking: i.blocking })) } } : {}),
      generation, decomposition: decompositionPlan(p.objects, a, p.prepared.separation.method) };
    const edit = p.editorDraft;
    if (edit && edit.objectsRevision === p.objectsRevision && edit.analysisRevision === p.prepared.analysisRevision && edit.baseSha256 === p.prepared.base.sha256) {
      const edited = JSON.parse(store.read(id, `product-r${edit.revision}.json`).toString('utf8')) as ProductSnapshot;
      if (edited.editorCreative) { snapshot.editorCreative = edited.editorCreative; snapshot.canvas = edited.editorCreative.canvas; }
    }
    const bytes = Buffer.from(JSON.stringify(snapshot, null, 2)), file = `product-r${revision}.json`;
    if (store.has(id, file)) fail('CONFLICT', `Revision ${revision} exists already.`);
    store.write(id, file, bytes);
    const saved = store.update(id, t.revision, x => { const q = x.product!; q.generation ??= generation; q.revisions = [...q.revisions, { revision, file, sha256: sha256(bytes), publishedAt: at, ...(draft ? { draft: true } : {}) }]; if (snapshot.editorCreative && q.editorDraft) q.editorDraft.revision = revision; history(q, { action: 'saved', detail: `Revision ${revision}${draft ? ' (an editor draft; quality approval is still required)' : ''}.` }); });
    return view(saved.id);
  }
  function snapshot(id: string, revision: number): ProductSnapshot {
    const t = requireProduct(id), ref = t.product.revisions.find(r => r.revision === revision) ?? fail('NOT_FOUND', `Revision ${revision} not found.`);
    return JSON.parse(store.read(id, ref.file).toString('utf8')) as ProductSnapshot;
  }

  const creatives = createProductCreatives({ store, runsDir: options.runsDir, requireProduct, snapshot, locked, latestRevision: id => requireProduct(id).product.revisions.at(-1)?.revision });
  /** Enter the existing Konva editor through the existing creative/run adapter. This does not approve quality. */
  const openEditor = (id: string) => locked(id, async () => {
    let t = requireProduct(id);
    const p = t.product, prepared = p.prepared;
    if (detecting.has(id) || preparingNow(id) || !prepared || prepared.version !== PRODUCT_PREPARE_VERSION || prepared.objectsRevision !== p.objectsRevision || prepared.analysisRevision !== (t.textAnalysis?.revision ?? 0)) fail('NOT_READY', 'Finish preparing the current elements before opening the editor.');
    let link = p.editorDraft;
    if (!link || link.objectsRevision !== p.objectsRevision || link.analysisRevision !== prepared.analysisRevision || link.baseSha256 !== prepared.base.sha256) {
      const latest = p.revisions.at(-1), saved = latest ? snapshot(id, latest.revision) : undefined;
      let revision = saved?.preparation?.objectsRevision === p.objectsRevision && saved.preparation.analysisRevision === prepared.analysisRevision && saved.base.sha256 === prepared.base.sha256 && saved.prepareVersion === prepared.version ? latest!.revision : undefined;
      if (!revision) { await writeSnapshot(t, true); t = requireProduct(id); revision = t.product.revisions.at(-1)!.revision; }
      link = { objectsRevision: p.objectsRevision, analysisRevision: prepared.analysisRevision, baseSha256: prepared.base.sha256, revision };
      store.update(id, t.revision, x => { x.product!.editorDraft = link; });
    }
    if (!link.creativeId) {
      // A template made from a person's reused creative (Decompose & Edit) opens as that creative to edit, not as a master
      // to maintain: its editing saves the creative; there is no master revision to save from it.
      const client = !!t.product.variation?.jobId?.startsWith('reuse-');
      const c = await creatives.create(id, { revision: link.revision, name: client ? t.name : `${t.name} · master editor`, masterEditing: !client });
      link = { ...link, creativeId: c.id };
      store.update(id, undefined, x => { x.product!.editorDraft = link; });
    }
    return { ...await creatives.open(id, link.creativeId!), template: view(id) };
  });
  /** Explicit master save only. Variation and ordinary creative saves can never enter this path. */
  const saveEditorMaster = (id: string, cid: string, input: { expectedCreativeRevision?: unknown; expectedMasterRevision?: unknown }) => locked(id, async () => {
    const t = requireProduct(id), link = t.product.editorDraft, c = creatives.read(id, cid);
    if (detecting.has(id) || preparingNow(id)) fail('BUSY', 'Wait for detection or decomposition to finish before saving the master.');
    if (!c.masterEditing || c.origin.kind !== 'template' || link?.creativeId !== cid || link.objectsRevision !== t.product.objectsRevision || link.analysisRevision !== (t.textAnalysis?.revision ?? 0) || link.baseSha256 !== t.product.prepared?.base.sha256) fail('NOT_READY', 'This creative is not the current master editing draft. Reopen the master to continue.');
    if (input.expectedCreativeRevision !== c.revision || input.expectedMasterRevision !== t.product.revisions.at(-1)?.revision) fail('STALE_REVISION', 'The master or creative changed elsewhere. Reopen it before saving a master revision.');
    const previous = snapshot(id, link.revision), revision = t.product.revisions.at(-1)!.revision + 1, at = nowIso();
    const saved: ProductSnapshot = { ...previous, revision, publishedAt: at, canvas: c.canvas, editorCreative: structuredClone(c),
      draft: { warnings: previous.quality.issues.map(i => ({ id: i.id, message: i.message, blocking: i.blocking })) } };
    const file = `product-r${revision}.json`, bytes = Buffer.from(JSON.stringify(saved, null, 2));
    if (store.has(id, file)) fail('CONFLICT', 'That master revision already exists.');
    store.write(id, file, bytes);
    store.update(id, t.revision, x => { x.product!.revisions.push({ revision, file, sha256: sha256(bytes), publishedAt: at, draft: true }); x.product!.editorDraft = { ...link, revision }; delete x.product!.approved; history(x.product!, { action: 'saved', detail: `Editor master revision ${revision}; quality review retained.` }); });
    return view(id);
  });
  const variations = createProductVariations({ store, creatives, requireProduct, snapshot, locked, toTemplate: input => createFromVariation(input), latestRevision: id => requireProduct(id).product.revisions.at(-1)?.revision, planner: options.planner, artwork: options.artwork, recognizer: options.recognizer });
  // Reuse Template (separate from variations): the person's own product set, copy and formats.
  const reuse = createReuseStudio({ store, creatives, requireProduct, snapshot, locked, latestRevision: id => requireProduct(id).product.revisions.at(-1)?.revision, placement: options.placement, toTemplate: input => createFromVariation(input) });

  return { list, view, sheetOf, create, createFromVariation, startDetect, review, fitText, select, brief, editBrief, uploadReviewAsset, estimate, startPrepare, approve, publish, openEditor, saveEditorMaster, snapshot, creatives, variations, reuse, isDetecting: (id: string) => detecting.has(id), isPreparing: (id: string) => preparing.has(id), requireProduct, kinds: PRODUCT_ELEMENT_KINDS, isOverlayKind };
}
export type ProductTemplates = ReturnType<typeof createProductTemplates>;
