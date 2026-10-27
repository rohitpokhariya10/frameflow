/**
 * Protected templates: a creative whose text, logos and legal copy are kept out of AI decomposition, and restored from
 * their own preserved pixels or original files. The steps, each an explicit administrator action:
 *
 *   create        the source creative (an upload, a saved run's image, a Template Studio poster)
 *   setElements   protected regions: kind, geometry in source pixels, representation, text, mask
 *   attachAsset   an element's original file (a bank's logo PNG), stored byte for byte
 *   confirmRegions every region reviewed and valid
 *   base          clean artwork (uploaded, or a Template Studio scene) or a local fill, with its checks; then approved
 *   preflight     every check before the paid call, local only
 *   decompose     ONE Seedream 5.0 Pro Layerize request for the prepared base: no planner, no image edit, no other model
 *   reconstruct   Seedream's layers plus the protected visuals, measured against the source
 *   approve       the reusable template: what the editor opens, and what a reuse replaces
 *   analyseText   (separate, optional, local) the words and logo slots inside the confirmed regions, read by the local
 *                 recognizer (textRecognition/), each an estimate an administrator reviews; never part of a Seedream run
 *
 * Nothing here calls a provider except the decomposition, which goes through layerizeExperiment's executeRun with deps
 * that can reach Seedream only (protectedRunDeps). A paid request is never retried or repeated by itself.
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { AI_PRICING, analysisProblems, DEFAULT_MASK_THRESHOLD, elementsProblems, isCatalogFont, maskKey, pixelBounds, PROTECTED_KINDS, PROTECTED_SCHEMA_VERSION, withHistory, PROTECTED_LIMITS, PROTECTED_REPRESENTATIONS, regionsKey, sameAspect, validProtectedElementId, withNormalized,
  type ProtectedAssetRef, type ProtectedBase, type ProtectedCheck, type ProtectedElement, type ProtectedFillRegion, type ProtectedProblem, type ProtectedReconstruction, type ProtectedRunSummary, type ProtectedSourceOrigin,
  type ProtectedStatus, type ProtectedTemplate, type ProtectedTemplateView, type ProtectedText, type TextAnalysis } from '@frameflow/shared';
import { createRun, executeRun, readRun, resumeRun, RunError, SEEDREAM_ENDPOINT, validRunId, type RunnerDeps, type RunRecord } from '../layerizeExperiment.js';
import type { FalTransport } from '../providers/falClient.js';
import { prepareProviderImage, ProviderImageError } from '../providerImage.js';
import { baseChecks, decodeRgba, extractRaster, fillPreview, ingestImage, localFill, ProtectedImageError, reconstruct, runEditorLayers, seedreamComposite, sha256, type ProtectedVisual } from './pixels.js';
import { newProtectedTemplateId, type ProtectedStore } from './store.js';
import { analysisFiles, correctAnalysis } from './words.js';
import { analyseTemplateText } from '../../textRecognition/analyse.js';
import type { WordRecognizer } from '../../textRecognition/recognizer.js';

const short = (hash: string) => hash.slice(0, 12);
/** Stages before anything reached Seedream: a run stopped there sent nothing and is no attempt. */
const NOT_SENT = ['uploaded', 'planning', 'planned', 'uploading'];
const notSent = (run: Pick<RunRecord, 'stage' | 'seedream'>) => NOT_SENT.includes(run.stage) && !run.seedream.requestId;
const nowIso = () => new Date().toISOString();
function fail(code: string, message: string, details?: Record<string, unknown>): never { throw new RunError(code, message, details); }
/** Image problems as the API's errors (400, or 413 for size). */
async function image<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { if (error instanceof ProtectedImageError) fail(error.code === 'UPLOAD_TOO_LARGE' ? 'UPLOAD_TOO_LARGE' : error.code, error.message); throw error; }
}

/**
 * The only provider access a protected run has: Seedream through fal. The planner refuses, there is no background
 * reconstructor (the OpenAI image edit), and the transport refuses any endpoint but Seedream's.
 */
export function protectedRunDeps(deps: RunnerDeps): RunnerDeps {
  const seedreamOnly = (transport: FalTransport): FalTransport => ({ ...transport,
    submit: (endpoint, input) => endpoint === SEEDREAM_ENDPOINT ? transport.submit(endpoint, input) : Promise.reject(new RunError('MODEL_NOT_ALLOWED', `A protected run may only call ${SEEDREAM_ENDPOINT}.`)) });
  return { planner: async () => fail('PLANNER_NOT_ALLOWED', 'A protected run never calls the planner.'), transport: () => seedreamOnly(deps.transport()),
    sleep: deps.sleep, pollIntervalMs: deps.pollIntervalMs, pollTimeoutMs: deps.pollTimeoutMs, onUpdate: deps.onUpdate, verifyUploads: deps.verifyUploads };
}

/** The most Seedream can charge for one request on this base: every one of its at most 17 layers, at the base's tier. */
export function seedreamEstimate(base: { width: number; height: number }, fx = AI_PRICING.budgetUsdInr as number) {
  const pixels = base.width * base.height, perLayerUsd = pixels < AI_PRICING.seedream.thresholdPixels ? AI_PRICING.seedream.low : AI_PRICING.seedream.high, maxLayers = 17;
  return { endpoint: SEEDREAM_ENDPOINT, perLayerUsd, maxLayers, maxUsd: perLayerUsd * maxLayers, maxInr: perLayerUsd * maxLayers * fx, fx, pricingVersion: AI_PRICING.version,
    note: `Seedream bills each returned layer: $${perLayerUsd} per layer for an output base of ${base.width}×${base.height} (${pixels < AI_PRICING.seedream.thresholdPixels ? 'under' : 'at or over'} 1536×1536, assuming the output base keeps the input size, as recorded runs did). At most ${maxLayers} layers. A refusal recorded with 0 billable units costs nothing. No planner or other model is called.` };
}

type ElementInput = Partial<Omit<ProtectedElement, 'normalized' | 'sourceAsset' | 'raster'>>;
const string = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const num = (v: unknown, min = -1e6, max = 1e6) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
/** Structure only (types, enums, bounds); what is incomplete is reported by elementsProblems and blocks confirmation, not saving. */
function cleanText(v: unknown): ProtectedText | undefined {
  if (v === undefined || v === null) return undefined;
  const t = v as Partial<ProtectedText>;
  if (!t || typeof t !== 'object' || !string(t.value, 5000) || !string(t.fontFamily, 120) || !string(t.fallbackFamily, 120) || !num(t.fontSize, 0, 4096) || !num(t.letterSpacing, -1000, 1000) || !num(t.lineHeight, 0, 10)
    || ![400, 600, 700].includes(t.fontWeight as number) || !['left', 'center', 'right'].includes(t.align as string) || !['top', 'middle', 'bottom'].includes(t.verticalAlign as string) || !string(t.color, 7)) fail('INVALID_ELEMENTS', 'Text details are malformed.');
  return { value: t.value!, fontFamily: t.fontFamily!, fallbackFamily: t.fallbackFamily!, fontSize: t.fontSize!, letterSpacing: t.letterSpacing!, lineHeight: t.lineHeight!, fontWeight: t.fontWeight!, align: t.align!, verticalAlign: t.verticalAlign!, color: t.color! };
}
function cleanElement(input: ElementInput, existing: ProtectedElement | undefined, size: { width: number; height: number }): ProtectedElement {
  const b = input.box;
  if (!validProtectedElementId(input.id)) fail('INVALID_ELEMENTS', 'Each element needs an id like pe-0123456789.');
  if (!b || typeof b !== 'object' || ![b.x, b.y, b.width, b.height].every(v => num(v)) || !num(b.rotation, -360, 360) || !(b.width! > 0) || !(b.height! > 0)) fail('INVALID_ELEMENTS', `${input.label ?? input.id}: its box is not valid.`);
  if (!PROTECTED_KINDS.includes(input.kind as never) || !PROTECTED_REPRESENTATIONS.includes(input.representation as never) || !string(input.label, PROTECTED_LIMITS.maxLabel) || !Number.isSafeInteger(input.zIndex)
    || !input.mask || !['difference', 'opaque'].includes(input.mask.mode) || !num(input.mask.threshold, 1, 255) || (input.note !== undefined && !string(input.note, PROTECTED_LIMITS.maxNote))
    || !['needs-review', 'approved'].includes(input.review?.status as string)) fail('INVALID_ELEMENTS', `${input.label ?? input.id}: a field is missing or malformed.`);
  const origin = existing?.origin ?? (['admin', 'template-studio', 'saved-analysis'].includes(input.origin as string) ? input.origin! : 'admin');
  const review = input.review!.status === 'approved' ? { status: 'approved' as const, at: existing?.review.status === 'approved' ? existing.review.at ?? nowIso() : nowIso() } : { status: 'needs-review' as const };
  const element: ProtectedElement = { id: input.id!, kind: input.kind!, label: input.label!.trim(), box: { x: b.x!, y: b.y!, width: b.width!, height: b.height!, rotation: b.rotation! }, normalized: { x: 0, y: 0, width: 0, height: 0 },
    zIndex: input.zIndex!, representation: input.representation!, mask: { mode: input.mask.mode, threshold: Math.round(input.mask.threshold) }, locked: input.locked !== false, replaceable: input.replaceable !== false,
    origin, review, ...(input.note ? { note: input.note } : {}), ...(cleanText(input.text) ? { text: cleanText(input.text) } : {}),
    // Server-owned: the original file and the raster are only ever written here, never taken from a request.
    ...(existing?.sourceAsset ? { sourceAsset: existing.sourceAsset } : {}), ...(existing?.raster ? { raster: existing.raster } : {}) };
  return withNormalized(element, size);
}

export interface ProtectedServiceOptions {
  store: ProtectedStore; runsDir: string; deps: () => RunnerDeps; isActiveRun: (runId: string) => boolean; fx?: () => number;
  /** The local word recognizer (tesseract by default; a fake in tests). Only the explicit text analysis uses it. */
  recognizer?: () => WordRecognizer;
}
export type ProtectedService = ReturnType<typeof createProtectedTemplates>;

export function createProtectedTemplates(options: ProtectedServiceOptions) {
  const { store, runsDir } = options, fx = () => options.fx?.() ?? AI_PRICING.budgetUsdInr;
  // One change at a time per template: an async step (decoding, extraction) never interleaves with another change.
  const locks = new Map<string, Promise<unknown>>();
  const locked = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const next = (locks.get(id) ?? Promise.resolve()).then(work, work);
    locks.set(id, next.catch(() => undefined));
    return next;
  };
  const sourceOf = (t: ProtectedTemplate) => store.read(t.id, t.source.inputFile);
  const runDir = (runId: string) => join(runsDir, runId);
  const readLinkedRun = (runId: string): RunRecord | undefined => validRunId(runId) && existsSync(join(runDir(runId), 'run.json')) ? readRun(runDir(runId)) : undefined;
  const baseCurrent = (t: ProtectedTemplate) => !!t.base && t.base.regionsKey === regionsKey(t.elements) && t.regionsConfirmed?.regionsKey === t.base.regionsKey;
  const reconstructionFile = (runId: string, ext: 'png' | 'json') => `recon-${runId.toLowerCase()}.${ext}`;

  /** Rasters for every element without a current one, cut from the source against the base; files no longer used are returned. */
  async function rasters(t: ProtectedTemplate, elements: ProtectedElement[], base: { file: string; sha256: string } | undefined): Promise<{ elements: ProtectedElement[]; written: string[]; unused: string[] }> {
    const written: string[] = [], unused: string[] = [];
    if (!base) return { elements: elements.map(e => { if (e.raster) unused.push(e.raster.file); const { raster: _r, ...rest } = e; void _r; return rest; }), written, unused };
    const stale = elements.filter(e => e.raster?.maskKey !== maskKey(e, base.sha256));
    if (!stale.length) return { elements, written, unused };
    const source = await decodeRgba(sourceOf(t)), basePixels = await decodeRgba(store.read(t.id, base.file), { width: t.source.width, height: t.source.height });
    const next: ProtectedElement[] = [];
    for (const e of elements) {
      if (!stale.includes(e)) { next.push(e); continue; }
      if (e.raster) unused.push(e.raster.file);
      try {
        const r = await extractRaster(source, basePixels, e), hash = sha256(r.png), file = `raster-${e.id}-${short(hash)}.png`;
        store.write(t.id, file, r.png); written.push(file);
        next.push({ ...e, raster: { file, sha256: hash, mime: 'image/png', width: r.placement.width, height: r.placement.height, bytes: r.png.length, hasAlpha: true, placement: r.placement, opaquePercent: r.opaquePercent, protectedPercent: r.protectedPercent, basisSha256: base.sha256, maskKey: maskKey(e, base.sha256) } });
      } catch (error) { if (!(error instanceof ProtectedImageError)) throw error; const { raster: _r, ...rest } = e; void _r; next.push(rest); }
    }
    return { elements: next, written, unused };
  }
  /**
   * Every stored file a record refers to, and every file its published master revisions name: a published revision never
   * changes and its creatives read its files (its clean background stays when the background is made again).
   */
  const referencedFiles = (t: ProtectedTemplate | undefined) => {
    if (!t) return new Set<string>();
    const records = [JSON.stringify(t), ...(t.master?.revisions ?? []).filter(r => store.has(t.id, r.file)).map(r => store.read(t.id, r.file).toString('utf8'))];
    return new Set(records.flatMap(r => r.match(/"(?:file|maskFile|previewFile|inputFile)":\s*"[^"]+"/g) ?? []).map(m => m.replace(/^"[A-Za-z]+":\s*"/, '').slice(0, -1)));
  };
  /**
   * Writes a change. On a refused write the files made for it are removed again, unless the current record uses them (the
   * same content stored before under the same name); after a written one, the files it no longer uses.
   */
  function commit(t: ProtectedTemplate, expected: number | undefined, files: { written: string[]; unused: string[] }, change: (x: ProtectedTemplate) => void) {
    let saved: ProtectedTemplate;
    try { saved = store.update(t.id, expected, change); }
    catch (error) { const keep = referencedFiles(store.get(t.id)); for (const f of files.written) if (!keep.has(f)) store.discard(t.id, f); throw error; }
    const referenced = referencedFiles(saved);
    for (const f of files.unused) if (!referenced.has(f)) store.discard(t.id, f);
    return saved;
  }

  async function create(bytes: Buffer, input: { name?: string; origin?: ProtectedSourceOrigin; filename?: string }): Promise<ProtectedTemplate> {
    const img = await image(() => ingestImage(bytes, 'source creative', { seedream: true, minSide: PROTECTED_LIMITS.minSourceSide }));
    const origin = validOrigin(input.origin ?? { kind: 'upload', ...(input.filename ? { filename: input.filename.slice(0, 200) } : {}) });
    const name = (input.name?.trim() || input.filename?.replace(/\.[a-z0-9]+$/i, '') || 'Protected template').slice(0, 120);
    const now = nowIso(), id = newProtectedTemplateId(), file = `source.${img.ext}`, inputFile = img.orientationNormalized ? 'source-input.png' : file;
    return store.create({ schemaVersion: PROTECTED_SCHEMA_VERSION, id, name, createdAt: now, updatedAt: now, revision: 1, coordinateSystem: 'source-pixels', elements: [], elementsRevision: 0, layerInstructions: '', runs: [],
      source: { file, inputFile, sha256: img.sha256, mime: img.mime, width: img.width, height: img.height, bytes: bytes.length, orientationNormalized: img.orientationNormalized, origin } },
    { [file]: bytes, ...(img.orientationNormalized ? { [inputFile]: img.input } : {}) });
  }
  function validOrigin(o: ProtectedSourceOrigin): ProtectedSourceOrigin {
    if (o?.kind === 'upload') return { kind: 'upload', ...(typeof o.filename === 'string' ? { filename: o.filename.slice(0, 200) } : {}) };
    if (o?.kind === 'decomposition-run' && validRunId(o.runId)) return { kind: 'decomposition-run', runId: o.runId };
    if (o?.kind === 'template-studio-poster' && /^[a-z]{2,6}_[A-Za-z0-9]{6,64}$/.test(o.posterId) && ['reference_reuse', 'ai_generated'].includes(o.provenance))
      return { kind: 'template-studio-poster', posterId: o.posterId, provenance: o.provenance, ...(typeof o.templateName === 'string' ? { templateName: o.templateName.slice(0, 120) } : {}) };
    return fail('INVALID_ORIGIN', 'Unknown source origin.');
  }

  /** A view of every template for the list: its status from its latest run, nothing heavy. */
  // Product with Text templates have their own flow and list (product/service.ts).
  function list() { return store.list().filter(t => !t.product).map(t => { const v = view(t); return { id: v.id, name: v.name, createdAt: v.createdAt, updatedAt: v.updatedAt, status: v.status, elements: v.elements.length, source: v.source, approval: v.approval, latestRun: v.latestRun }; }); }

  function runSummary(t: ProtectedTemplate, runId: string): ProtectedRunSummary | undefined {
    const run = readLinkedRun(runId), link = t.runs.find(r => r.runId === runId);
    if (!run || !link) return undefined;
    const problems: string[] = [];
    let editorLayers = 0;
    if (run.stage === 'done') {
      try { editorLayers = runEditorLayers(run).length; } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
      if (!editorLayers && !problems.length) problems.push('Seedream returned no usable editor layers.');
      if (run.canvas && !sameAspect(run.canvas, t.source, 0.01)) problems.push(`Seedream's canvas ${run.canvas.width}×${run.canvas.height} does not have the source's aspect ratio; layers would not line up.`);
    }
    return { runId, stage: run.stage, active: options.isActiveRun(runId), createdAt: run.createdAt, ...(run.error ? { error: run.error } : {}),
      ...(run.rejection ? { rejection: { category: run.rejection.category, reason: run.rejection.reason, billableUnits: run.rejection.billableUnits, requestId: run.rejection.requestId } } : {}),
      ...(run.seedream.requestId ? { requestId: run.seedream.requestId } : {}), editorLayers, usable: run.stage === 'done' && editorLayers > 0 && !problems.length, problems, current: !!t.base && link.baseSha256 === t.base.sha256 };
  }
  function reconstructionOf(t: ProtectedTemplate, runId: string): ProtectedReconstruction | undefined {
    const file = reconstructionFile(runId, 'json');
    return store.has(t.id, file) ? JSON.parse(store.read(t.id, file).toString('utf8')) as ProtectedReconstruction : undefined;
  }
  /** The record with everything derived from it and its runs. */
  function view(t: ProtectedTemplate): ProtectedTemplateView {
    const problems: ProtectedProblem[] = elementsProblems(t.elements, t.source);
    const key = regionsKey(t.elements), confirmed = t.regionsConfirmed?.regionsKey === key && t.elements.length > 0, current = baseCurrent(t);
    if (t.regionsConfirmed && !confirmed) problems.push({ severity: 'warning', code: 'REGIONS_CHANGED', message: 'The protected regions changed after they were confirmed. Confirm them again.' });
    if (t.base && !current) problems.push({ severity: 'warning', code: 'BASE_STALE', message: 'The prepared base was made for other regions. Prepare it again.' });
    for (const e of t.elements) {
      if (e.review.status !== 'approved') problems.push({ severity: 'warning', code: 'NOT_REVIEWED', elementId: e.id, message: `${e.label}: not reviewed yet.` });
      if (current && e.raster?.maskKey !== maskKey(e, t.base!.sha256) && e.representation !== 'source-asset') problems.push({ severity: 'warning', code: 'RASTER_MISSING', elementId: e.id, message: `${e.label}: its preserved pixels are not ready.` });
    }
    const latest = [...t.runs].reverse().find(r => !!readLinkedRun(r.runId)), latestRun = latest ? runSummary(t, latest.runId) : undefined;
    const reconstruction = latestRun?.usable ? reconstructionOf(t, latestRun.runId) : undefined;
    const approvalCurrent = !!t.approval && t.approval.elementsRevision === t.elementsRevision && t.approval.baseSha256 === t.base?.sha256 && current;
    const status: ProtectedStatus = approvalCurrent ? 'approved'
      : latestRun?.current && latestRun.active ? 'decomposing'
      : latestRun?.current && !['done', 'failed'].includes(latestRun.stage) ? (NOT_SENT.includes(latestRun.stage) && !latestRun.requestId ? (current && t.base?.approval ? 'ready' : 'preparing-base') : 'interrupted')
      : latestRun?.current && latestRun.stage === 'failed' ? 'failed'
      : latestRun?.current && latestRun.stage === 'done' ? 'review'
      : current && t.base?.approval ? 'ready' : confirmed ? 'preparing-base' : 'annotating';
    const analysisStale = t.textAnalysis ? t.textAnalysis.basis.regionsKey !== key || t.textAnalysis.basis.sourceSha256 !== t.source.sha256 : undefined;
    const wordProblems = t.textAnalysis ? analysisProblems(t.textAnalysis, t.source, t.elements) : undefined;
    return { ...t, status, problems, ...(latestRun ? { latestRun } : {}), ...(reconstruction ? { reconstruction } : {}), ...(wordProblems ? { wordProblems } : {}),
      stale: { base: !!t.base && !current, approval: !!t.approval && !approvalCurrent, ...(analysisStale !== undefined ? { textAnalysis: analysisStale } : {}) } };
  }

  const setDetails = (id: string, expected: number, patch: { name?: unknown; layerInstructions?: unknown }) => locked(id, async () => {
    const t = store.require(id);
    if (patch.name !== undefined && (!string(patch.name, 120) || !(patch.name as string).trim())) fail('INVALID_NAME', 'Give the template a name of up to 120 characters.');
    if (patch.layerInstructions !== undefined && !string(patch.layerInstructions, PROTECTED_LIMITS.maxInstructions)) fail('INVALID_INSTRUCTIONS', `Layer instructions are limited to ${PROTECTED_LIMITS.maxInstructions} characters.`);
    return view(store.update(t.id, expected, x => {
      if (patch.name !== undefined) x.name = (patch.name as string).trim();
      if (patch.layerInstructions !== undefined) x.layerInstructions = (patch.layerInstructions as string).trim();
    }));
  });

  /** The whole list of elements, as the region editor holds it. Rasters follow automatically while the base is current. */
  const setElements = (id: string, expected: number, inputs: unknown) => locked(id, async () => {
    const t = store.require(id);
    if (expected !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}, yours ${expected}). Reload it and make your change again.`, { revision: t.revision });
    if (!Array.isArray(inputs) || inputs.length > PROTECTED_LIMITS.maxElements) fail('INVALID_ELEMENTS', `Send at most ${PROTECTED_LIMITS.maxElements} elements.`);
    const existing = new Map(t.elements.map(e => [e.id, e]));
    let next = (inputs as ElementInput[]).map(input => cleanElement(input, existing.get(input.id!), t.source));
    if (new Set(next.map(e => e.id)).size !== next.length) fail('INVALID_ELEMENTS', 'Element ids must be unique.');
    const removed = t.elements.filter(e => !next.some(n => n.id === e.id));
    const regionsSame = regionsKey(next) === regionsKey(t.elements);
    const files = await rasters(t, next, regionsSame && baseCurrent(t) ? t.base : undefined);
    next = files.elements;
    for (const e of removed) { if (e.raster) files.unused.push(e.raster.file); if (e.sourceAsset) files.unused.push(e.sourceAsset.file); }
    const changed = JSON.stringify(next.map(e => ({ ...e, review: e.review.status }))) !== JSON.stringify(t.elements.map(e => ({ ...e, review: e.review.status })));
    return view(commit(t, expected, files, x => { x.elements = next; if (changed) x.elementsRevision++; }));
  });
  /** An element's original file, byte for byte (a bank's logo PNG): the element shows it from now on. */
  const attachAsset = (id: string, expected: number, elementId: string, bytes: Buffer, filename?: string) => locked(id, async () => {
    const t = store.require(id), element = t.elements.find(e => e.id === elementId) ?? fail('NOT_FOUND', 'Element not found.');
    const img = await image(() => ingestImage(bytes, 'original file'));
    if (img.orientationNormalized) fail('UNSUPPORTED_IMAGE', 'Upload the original file without an EXIF rotation, so its pixels are used exactly as stored.');
    const file = `asset-${element.id}-${short(img.sha256)}.${img.ext}`;
    store.write(t.id, file, bytes);
    const ref: ProtectedAssetRef = { file, sha256: img.sha256, mime: img.mime, width: img.width, height: img.height, bytes: bytes.length, hasAlpha: img.hasAlpha, ...(filename ? { originalName: filename.slice(0, 200) } : {}) };
    return view(commit(t, expected, { written: [file], unused: element.sourceAsset && element.sourceAsset.file !== file ? [element.sourceAsset.file] : [] }, x => {
      const e = x.elements.find(item => item.id === elementId)!;
      e.sourceAsset = ref; e.representation = 'source-asset'; x.elementsRevision++;
    }));
  });

  const confirmRegions = (id: string, expected: number) => locked(id, async () => {
    const t = store.require(id), errors = elementsProblems(t.elements, t.source).filter(p => p.severity === 'error');
    if (!t.elements.length) fail('NO_PROTECTED_ELEMENTS', 'Mark at least one protected element. A creative with nothing to protect can be decomposed in Decompose/Test.');
    if (errors.length) fail('REGIONS_INVALID', errors.map(p => p.message).join(' '), { problems: errors });
    const unreviewed = t.elements.filter(e => e.review.status !== 'approved');
    if (unreviewed.length) fail('REVIEW_REQUIRED', `Review and approve every element first: ${unreviewed.map(e => e.label).join(', ')}.`);
    return view(store.update(t.id, expected, x => { x.regionsConfirmed = { at: nowIso(), regionsKey: regionsKey(x.elements) }; }));
  });
  const requireConfirmed = (t: ProtectedTemplate) => { if (t.regionsConfirmed?.regionsKey !== regionsKey(t.elements) || !t.elements.length) fail('REGIONS_NOT_CONFIRMED', 'Confirm the protected regions before preparing the base.'); };

  /** A base from artwork the administrator has (clean-upload) or a Template Studio scene (structured-scene), checked against the source. */
  const uploadBase = (id: string, expected: number, bytes: Buffer, method: 'clean-upload' | 'structured-scene', filename?: string) => locked(id, async () => {
    const t = store.require(id);
    requireConfirmed(t);
    const img = await image(() => ingestImage(bytes, 'clean artwork', { seedream: true }));
    if (!sameAspect(img, t.source)) fail('BASE_ASPECT_MISMATCH', `The clean artwork is ${img.width}×${img.height}; the source is ${t.source.width}×${t.source.height}. It must have the same aspect ratio (within 0.5%) so the protected regions line up.`);
    const png = await sharp(img.input).png({ compressionLevel: 9 }).toBuffer(), hash = sha256(png);
    const uploadFile = `base-upload-${short(img.sha256)}.${img.ext}`, file = `base-${short(hash)}.png`;
    store.write(t.id, uploadFile, bytes); store.write(t.id, file, png);
    const checked = baseChecks(await decodeRgba(sourceOf(t)), await decodeRgba(png, t.source), t.elements);
    const reliability = checked.checks.every(c => c.differsFromSource) && checked.outsideMeanDiff <= 10 ? 'reliable' : 'uncertain';
    const base: ProtectedBase = { method, file, sha256: hash, width: img.width, height: img.height, preparedAt: nowIso(), regionsKey: regionsKey(t.elements),
      upload: { file: uploadFile, sha256: img.sha256, mime: img.mime, width: img.width, height: img.height, bytes: bytes.length, hasAlpha: img.hasAlpha, ...(filename ? { originalName: filename.slice(0, 200) } : {}) },
      checks: checked.checks, outsideMeanDiff: checked.outsideMeanDiff, reliability };
    return view(await replaceBase(t, expected, base, [uploadFile, file]));
  });
  /** A base made locally: every protected region continued from its surroundings. Always an estimate where it filled. */
  const fillBase = (id: string, expected: number) => locked(id, async () => {
    const t = store.require(id);
    requireConfirmed(t);
    const source = await decodeRgba(sourceOf(t)), filled = await localFill(source, t.elements), hash = sha256(filled.png);
    const file = `base-${short(hash)}.png`, maskFile = `fill-mask-${short(hash)}.png`, previewFile = `fill-preview-${short(hash)}.png`;
    store.write(t.id, file, filled.png);
    store.write(t.id, maskFile, await sharp(Buffer.from(filled.mask.map(v => v ? 255 : 0)), { raw: { width: t.source.width, height: t.source.height, channels: 1 } }).png().toBuffer());
    store.write(t.id, previewFile, await fillPreview(filled.png, filled.mask, t.source, filled.regions, t.elements));
    const checked = baseChecks(source, await decodeRgba(filled.png), t.elements);
    const base: ProtectedBase = { method: 'local-fill', file, sha256: hash, width: t.source.width, height: t.source.height, preparedAt: nowIso(), regionsKey: regionsKey(t.elements),
      fill: { regions: filled.regions, filledPercent: filled.filledPercent, maskFile, previewFile }, checks: checked.checks, outsideMeanDiff: checked.outsideMeanDiff, reliability: 'uncertain' };
    return view(await replaceBase(t, expected, base, [file, maskFile, previewFile]));
  });
  async function replaceBase(t: ProtectedTemplate, expected: number, base: ProtectedBase, written: string[]) {
    const r = await rasters(t, t.elements, base), old = t.base;
    const unused = [...r.unused, ...(old ? [old.file, old.upload?.file, old.fill?.maskFile, old.fill?.previewFile].filter((f): f is string => !!f && !written.includes(f)) : [])];
    return commit(t, expected, { written: [...written, ...r.written], unused }, x => { x.base = base; x.elements = r.elements; x.elementsRevision++; });
  }
  const approveBase = (id: string, expected: number, acknowledgeUncertain: boolean) => locked(id, async () => {
    const t = store.require(id);
    if (!t.base || !baseCurrent(t)) fail('BASE_NOT_READY', 'Prepare the base for the confirmed regions first.');
    if (t.base!.reliability === 'uncertain' && !acknowledgeUncertain) fail('ACKNOWLEDGEMENT_REQUIRED', t.base!.method === 'local-fill'
      ? 'The filled areas are an estimate of what lies under the protected content. Look at them and confirm you accept them.'
      : 'The clean artwork did not pass every check (it may still show protected content, or differ from the source). Look at it and confirm you accept it.');
    return view(store.update(t.id, expected, x => { x.base!.approval = { at: nowIso(), acknowledgedUncertain: x.base!.reliability === 'uncertain' }; }));
  });

  /** Every check before the paid call; local only (the image check is the same one every Seedream upload passes). */
  async function preflight(t: ProtectedTemplate): Promise<{ checks: ProtectedCheck[]; ok: boolean; estimate?: ReturnType<typeof seedreamEstimate> }> {
    const checks: ProtectedCheck[] = [], add = (id: string, label: string, status: ProtectedCheck['status'], detail: string) => checks.push({ id, label, status, detail });
    const errors = elementsProblems(t.elements, t.source).filter(p => p.severity === 'error');
    add('elements', 'Protected elements', !t.elements.length ? 'fail' : errors.length ? 'fail' : 'pass', !t.elements.length ? 'None marked.' : errors.length ? errors.map(e => e.message).join(' ') : `${t.elements.length} element(s), all valid.`);
    const unreviewed = t.elements.filter(e => e.review.status !== 'approved');
    add('review', 'Every element reviewed', unreviewed.length ? 'fail' : 'pass', unreviewed.length ? `Not reviewed: ${unreviewed.map(e => e.label).join(', ')}.` : 'All approved by an administrator.');
    add('confirmed', 'Regions confirmed', t.regionsConfirmed?.regionsKey === regionsKey(t.elements) ? 'pass' : 'fail', t.regionsConfirmed ? 'Confirmed for these regions.' : 'Not confirmed.');
    const current = baseCurrent(t);
    add('base', 'Prepared base', !t.base ? 'fail' : !current ? 'fail' : !t.base.approval ? 'fail' : t.base.reliability === 'uncertain' ? 'warn' : 'pass',
      !t.base ? 'No base prepared.' : !current ? 'Made for other regions; prepare it again.' : !t.base.approval ? 'Not approved yet.' : `${t.base.method}, ${t.base.width}×${t.base.height}${t.base.reliability === 'uncertain' ? ', an estimate the administrator accepted' : ''}.`);
    if (t.base && current) {
      const still = t.base.checks.filter(c => !c.differsFromSource).map(c => t.elements.find(e => e.id === c.elementId)?.label ?? c.elementId);
      add('removed', 'Protected content removed from the base', still.length ? 'warn' : 'pass', still.length ? `The base still looks like the source inside: ${still.join(', ')}. Seedream would decompose that content too.` : 'Every protected region differs from the source in the base.');
      let bytes: Buffer | undefined;
      try { bytes = store.read(t.id, t.base.file); } catch { /* reported below */ }
      add('stored', 'Stored base matches its record', bytes && sha256(bytes) === t.base.sha256 ? 'pass' : 'fail', bytes ? sha256(bytes) === t.base.sha256 ? 'sha256 verified.' : 'The stored base changed on disk.' : 'The stored base is missing.');
      if (bytes) {
        try { const p = await prepareProviderImage(bytes, 'image/png'); add('contract', 'Seedream image limits (checked locally)', 'pass', `${p.report.provider.width}×${p.report.provider.height}, ${Math.round(p.report.provider.bytes / 1024)} KB.`); }
        catch (error) { add('contract', 'Seedream image limits (checked locally)', 'fail', error instanceof ProviderImageError ? error.message : String(error)); }
      }
    }
    const visuals = t.elements.map(e => e.representation === 'source-asset' ? e.sourceAsset : e.raster).map((ref, i) => ({ ref, e: t.elements[i] }));
    const missing = visuals.filter(v => !v.ref || !store.has(t.id, v.ref.file) || sha256(store.read(t.id, v.ref.file)) !== v.ref.sha256);
    add('preserved', 'Preserved text and logo assets', missing.length ? 'fail' : 'pass', missing.length ? `Missing or changed: ${missing.map(v => v.e.label).join(', ')}.` : 'Every element has its stored pixels or original file (sha256 verified).');
    const active = t.runs.map(r => readLinkedRun(r.runId)).find(r => r && options.isActiveRun(r.id));
    add('idle', 'No decomposition of this template running', active ? 'fail' : 'pass', active ? `Run ${active.id} is still running.` : 'Idle.');
    add('models', 'Models', 'pass', `Only ${SEEDREAM_ENDPOINT} (one request). No planner, image edit, Qwen or other model. The provider's safety checker stays on.`);
    const ok = !checks.some(c => c.status === 'fail');
    return { checks, ok, ...(t.base ? { estimate: seedreamEstimate(t.base, fx()) } : {}) };
  }

  /**
   * The paid step: a new run of the prepared base, linked before it is executed. A request repeated with its idempotency key
   * returns the same run. After Seedream's content check refused this exact base, it is not sent again: something has to
   * change. Any other repeat of a decomposition of the same base needs confirmRepeat (a second paid request).
   */
  const startDecomposition = (id: string, input: { expectedRevision: number; idempotencyKey: string; confirmRepeat?: boolean }) => locked(id, async () => {
    const t = store.require(id);
    if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey)) fail('INVALID_REQUEST', 'An idempotency key (8–128 letters, digits, - or _) is required.');
    const same = t.runs.find(r => r.idempotencyKey === input.idempotencyKey);
    if (same) { const run = readLinkedRun(same.runId); if (run) return { run, dir: runDir(same.runId), existing: true, template: view(t) }; }
    if (input.expectedRevision !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}, yours ${input.expectedRevision}). Reload it and check it again.`, { revision: t.revision });
    const running = t.runs.find(r => options.isActiveRun(r.runId));
    if (running) fail('BUSY', `Run ${running.runId} of this template is still running or waiting its turn; it is sent once. Wait for it to finish.`);
    const check = await preflight(t);
    if (!check.ok) fail('PREFLIGHT_FAILED', check.checks.filter(c => c.status === 'fail').map(c => `${c.label}: ${c.detail}`).join(' '), { checks: check.checks });
    const previous = [...t.runs].reverse().filter(r => r.baseSha256 === t.base!.sha256).map(r => readLinkedRun(r.runId)).filter((r): r is RunRecord => !!r && (options.isActiveRun(r.id) || !notSent(r)));
    const last = previous[0];
    if (last && options.isActiveRun(last.id)) fail('BUSY', `Run ${last.id} of this template is still running.`);
    if (last && !['done', 'failed'].includes(last.stage) && last.seedream.requestId) fail('RESUME_AVAILABLE', `Run ${last.id} stopped before it finished, and its Seedream request ${last.seedream.requestId} is saved. Resume it (no new paid request) instead of sending the base again.`);
    if (last && !['done', 'failed'].includes(last.stage) && !input.confirmRepeat) fail('REPEAT_REQUIRES_CONFIRMATION', `Run ${last.id} stopped while submitting, before a request ID was saved: fal may have accepted it. Check the fal dashboard; sending the base again is a new paid request and needs your confirmation.`);
    if (last?.stage === 'failed' && last.seedream.requestId && last.error && !['PROVIDER_DECOMPOSITION_REJECTED', 'PROVIDER_SAFETY_REJECTED'].includes(last.error.code) && ![400, 422].includes(last.error.provider?.status ?? 0))
      fail('RESUME_AVAILABLE', `Run ${last.id} failed after its request ${last.seedream.requestId} was saved (${last.error.code}). Resume it (no new paid request) first.`);
    const refused = previous.find(r => r.rejection?.category === 'partner-content' || r.error?.code === 'PROVIDER_SAFETY_REJECTED');
    if (refused) fail('REPEAT_REQUIRES_CHANGE', `Seedream's provider refused this exact prepared base before (run ${refused.id}${refused.seedream.requestId ? `, request ${refused.seedream.requestId}` : ''}). The same image is not sent again: change the base (clean artwork, or other protected regions) first. The reason was not disclosed by the provider.`);
    if (previous.length && !input.confirmRepeat) fail('REPEAT_REQUIRES_CONFIRMATION', `This base was already sent ${previous.length} time(s) (latest run ${last!.id}: ${last!.stage}). Sending it again is a new paid Seedream request; confirm it explicitly.`);
    const bytes = store.read(t.id, t.base!.file);
    const { dir, run } = await createRun(runsDir, bytes, { mode: 'protected', templateId: t.id, elementsRevision: t.elementsRevision, baseSha256: t.base!.sha256, prompt: t.layerInstructions },
      { origin: { kind: 'protected-template', generationId: t.id } });
    const saved = store.update(t.id, t.revision, x => { x.runs.push({ runId: run.id, createdAt: run.createdAt, idempotencyKey: input.idempotencyKey, baseSha256: t.base!.sha256, elementsRevision: t.elementsRevision }); });
    return { run, dir, existing: false, template: view(saved) };
  });
  /** Runs the linked run (its one Seedream request), then reconstructs it when it finished with layers. */
  async function execute(id: string, dir: string) {
    const run = await executeRun(dir, protectedRunDeps(options.deps()));
    if (run.stage === 'done') await reconstructRun(id, run.id).catch(error => console.error('protected reconstruction', id, run.id, error));
    return run;
  }
  /** A stopped run of this template, from its saved request: polls and reads it, never submits. */
  const resume = (id: string, runId: string) => locked(id, async () => {
    const t = store.require(id);
    if (!t.runs.some(r => r.runId === runId)) fail('NOT_FOUND', 'That run is not one of this template\'s.');
    const run = readLinkedRun(runId) ?? fail('NOT_FOUND', 'Run not found.');
    if (options.isActiveRun(runId)) fail('BUSY', 'That run is still running.');
    if (!run.seedream.requestId) fail('NO_REQUEST_ID', 'That run never reached Seedream (no request ID saved); nothing to resume.');
    if (run.stage === 'done') fail('NOT_NEEDED', 'That run already finished.');
    if (run.stage === 'failed' && (['PROVIDER_DECOMPOSITION_REJECTED', 'PROVIDER_SAFETY_REJECTED'].includes(run.error?.code ?? '') || [400, 422].includes(run.error?.provider?.status ?? 0)))
      fail('NOT_RETRYABLE', 'Seedream\'s answer to that request is final; resuming would read the same refusal.');
    return { dir: runDir(runId), run };
  });
  async function executeResume(id: string, dir: string) {
    const run = await resumeRun(dir, protectedRunDeps(options.deps()));
    if (run.stage === 'done') await reconstructRun(id, run.id).catch(error => console.error('protected reconstruction', id, run.id, error));
    return run;
  }

  /** The deterministic reconstruction of a finished run, stored with its measurements. Local only. */
  const reconstructRun = (id: string, runId: string) => locked(id, async () => {
    const t = store.require(id);
    if (!t.runs.some(r => r.runId === runId)) fail('NOT_FOUND', 'That run is not one of this template\'s.');
    const run = readLinkedRun(runId) ?? fail('NOT_FOUND', 'Run not found.');
    if (run.stage !== 'done') fail('NOT_READY', 'The run has not finished.');
    const size = { width: t.source.width, height: t.source.height }, dir = runDir(runId);
    const blockers: string[] = [], warnings: string[] = [];
    if (run.canvas && !sameAspect(run.canvas, size, 0.01)) blockers.push(`Seedream's canvas ${run.canvas.width}×${run.canvas.height} does not have the source's aspect ratio.`);
    const source = await decodeRgba(sourceOf(t)), base = await decodeRgba(readFileSync(join(dir, run.input.file)), size);
    const seedream = await image(() => seedreamComposite(dir, run, size));
    const visuals: ProtectedVisual[] = [];
    for (const e of t.elements) {
      const ref = e.representation === 'source-asset' ? e.sourceAsset : e.raster;
      if (!ref || !store.has(t.id, ref.file)) { blockers.push(`${e.label}: its preserved ${e.representation === 'source-asset' ? 'original file' : 'pixels'} are missing.`); continue; }
      const png = store.read(t.id, ref.file);
      if (sha256(png) !== ref.sha256) { blockers.push(`${e.label}: its stored file changed (sha256 mismatch).`); continue; }
      visuals.push({ element: e, png, placement: e.representation === 'source-asset' ? { kind: 'box', box: e.box } : { kind: 'raster', rect: e.raster!.placement } });
      if (e.representation === 'native-text') warnings.push(`${e.label}: shown here with its preserved pixels; the editor typesets it as text in ${e.text && isCatalogFont(e.text.fontFamily) ? e.text.fontFamily : `${e.text?.fallbackFamily ?? 'Inter'} (fallback for ${e.text?.fontFamily ?? 'its font'})`}, which can differ from the original.`);
      if (e.representation === 'source-asset' && Math.abs(e.sourceAsset!.width / e.sourceAsset!.height - e.box.width / e.box.height) > 0.01) warnings.push(`${e.label}: the original file's aspect ratio differs from its box; it is fitted inside it, centred.`);
    }
    const result = await reconstruct({ source, base, seedream, visuals, elements: t.elements });
    for (const d of result.duplicates) if (d.suspected) warnings.push(`${d.label}: Seedream's own layers look like the protected content where it was removed (a possible duplicate under the restored element).`);
    for (const p of result.metrics.protected) if (p.representation === 'raster' && p.opaquePixels && p.opaqueExactPercent < 100) warnings.push(`${p.label}: ${p.opaqueExactPercent}% of its fully protected pixels match the source exactly (another element overlaps it).`);
    const hash = sha256(result.png), file = reconstructionFile(runId, 'png');
    store.write(t.id, file, result.png);
    const record: ProtectedReconstruction = { runId, file, sha256: hash, createdAt: nowIso(), width: size.width, height: size.height, seedreamCanvas: run.canvas ?? size,
      scale: { x: size.width / (run.canvas?.width ?? size.width), y: size.height / (run.canvas?.height ?? size.height) }, layers: runEditorLayers(run).length, metrics: result.metrics, duplicates: result.duplicates, blockers, warnings };
    store.write(t.id, reconstructionFile(runId, 'json'), Buffer.from(JSON.stringify(record, null, 2)));
    return record;
  });

  /** The reusable template: a finished, reconstructed run of the current base, every preserved asset intact. */
  const approve = (id: string, input: { expectedRevision: number; runId: string; acknowledge?: string[] }) => locked(id, async () => {
    const t = store.require(id), summary = runSummary(t, input.runId) ?? fail('NOT_FOUND', 'That run is not one of this template\'s.');
    if (!summary.current) fail('NOT_READY', 'That run was made from an earlier base. Decompose the current base, or prepare the base it used again.');
    if (!summary.usable) fail('NOT_READY', `That run has no usable layers. ${summary.problems.join(' ')}`.trim());
    const check = await preflight(t), failed = check.checks.filter(c => c.status === 'fail' && c.id !== 'idle');
    if (failed.length) fail('NOT_READY', failed.map(c => `${c.label}: ${c.detail}`).join(' '));
    const recon = reconstructionOf(t, input.runId) ?? fail('NOT_READY', 'Reconstruct the run first.');
    if (recon.blockers.length) fail('NOT_READY', recon.blockers.join(' '));
    const acknowledge = new Set(input.acknowledge ?? []);
    if (recon.duplicates.some(d => d.suspected) && !acknowledge.has('duplicates')) fail('ACKNOWLEDGEMENT_REQUIRED', 'Seedream\'s layers may contain a copy of protected content. Check the layers and confirm before approving.');
    if (recon.warnings.length && !acknowledge.has('warnings')) fail('ACKNOWLEDGEMENT_REQUIRED', `Confirm you checked: ${recon.warnings.join(' ')}`);
    return view(store.update(t.id, input.expectedRevision, x => { x.approval = { runId: input.runId, at: nowIso(), elementsRevision: x.elementsRevision, baseSha256: x.base!.sha256, reconstructionSha256: recon.sha256, acknowledged: [...acknowledge].sort() }; }));
  });

  // --- Words and logo slots (local; never part of a decomposition) ------------------------------------------------------
  /** Reads the words and logo slots of the confirmed regions with the local recognizer. Free: nothing leaves this machine. */
  const analyseText = (id: string, expected: number) => locked(id, async () => {
    const t = store.require(id);
    requireConfirmed(t);
    const recognizer = options.recognizer?.() ?? fail('NOT_CONFIGURED', 'No local text recognizer is configured on this server.');
    const written: string[] = [];
    const result = await analyseTemplateText({ template: t, source: await decodeRgba(sourceOf(t)), recognizer, previous: t.textAnalysis, store: (file, png) => { store.write(t.id, file, png); written.push(file); } });
    const keep = new Set(analysisFiles(result.analysis));
    return view(commit(t, expected, { written, unused: analysisFiles(t.textAnalysis).filter(f => !keep.has(f)) }, x => { x.schemaVersion = PROTECTED_SCHEMA_VERSION; x.textAnalysis = result.analysis; }));
  });
  const requireAnalysis = (t: ProtectedTemplate, expectedAnalysisRevision: unknown) => {
    const a = t.textAnalysis ?? fail('NO_TEXT_ANALYSIS', 'Find the words and logos first.');
    if (expectedAnalysisRevision !== undefined && expectedAnalysisRevision !== a.revision) fail('STALE_REVISION', `The words changed since you opened them (analysis revision ${a.revision}, yours ${String(expectedAnalysisRevision)}). Reload and correct them again.`, { analysisRevision: a.revision });
    return a;
  };
  /** Cuts a logo slot's exact source pixels (whole pixels around its box, never resampled). */
  async function cutLogo(t: ProtectedTemplate, slotId: string, box: { x: number; y: number; width: number; height: number; rotation: number }) {
    const rect = pixelBounds(box, t.source) ?? fail('INVALID_TEXT_ANALYSIS', 'A logo slot must lie on the image.');
    const png = await sharp(sourceOf(t)).rotate().extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height }).ensureAlpha().png({ compressionLevel: 9 }).toBuffer(), hash = sha256(png);
    const file = `logo-${slotId}-${short(hash)}.png`;
    store.write(t.id, file, png);
    return { file, ref: { file, sha256: hash, mime: 'image/png', width: rect.width, height: rect.height, bytes: png.length, hasAlpha: true, placement: rect } };
  }
  /** The administrator's corrections: the whole list of words, phrases and logo slots as the review screen holds it. */
  const correctText = (id: string, expected: number, input: { expectedAnalysisRevision?: unknown; words?: unknown; groups?: unknown; logoSlots?: unknown }) => locked(id, async () => {
    const t = store.require(id), current = requireAnalysis(t, input.expectedAnalysisRevision);
    if (expected !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}, yours ${expected}). Reload it and make your change again.`, { revision: t.revision });
    const { next, recut } = correctAnalysis(t, current, input, nowIso()), written: string[] = [];
    for (const slotId of recut) {
      const slot = next.logoSlots.find(l => l.id === slotId)!, cut = await cutLogo(t, slotId, slot.box);
      slot.original = cut.ref; written.push(cut.file);
    }
    const keep = new Set(analysisFiles(next));
    return view(commit(t, expected, { written, unused: analysisFiles(current).filter(f => !keep.has(f)) }, x => { x.textAnalysis = next; }));
  });
  /** A logo slot's replacement (a bank's own logo file), byte for byte: the slot shows it instead of the source's pixels. */
  const replaceLogo = (id: string, expected: number, slotId: string, bytes: Buffer, filename?: string) => locked(id, async () => {
    const t = store.require(id), a = requireAnalysis(t, undefined), slot = a.logoSlots.find(l => l.id === slotId) ?? fail('NOT_FOUND', 'Logo slot not found.');
    if (!slot.replaceable) fail('NOT_REPLACEABLE', `${slot.label} is not replaceable.`);
    const img = await image(() => ingestImage(bytes, 'logo file'));
    if (img.orientationNormalized) fail('UNSUPPORTED_IMAGE', 'Upload the logo without an EXIF rotation, so its pixels are used exactly as stored.');
    const file = `logo-asset-${slotId}-${short(img.sha256)}.${img.ext}`;
    store.write(t.id, file, bytes);
    const ref: ProtectedAssetRef = { file, sha256: img.sha256, mime: img.mime, width: img.width, height: img.height, bytes: bytes.length, hasAlpha: img.hasAlpha, ...(filename ? { originalName: filename.slice(0, 200) } : {}) };
    const at = nowIso();
    return view(commit(t, expected, { written: [file], unused: slot.replacement && slot.replacement.file !== file ? [slot.replacement.file] : [] }, x => {
      const s = x.textAnalysis!.logoSlots.find(l => l.id === slotId)!;
      s.replacement = ref;
      x.textAnalysis = { ...x.textAnalysis!, revision: x.textAnalysis!.revision + 1, updatedAt: at, history: withHistory(x.textAnalysis!.history, { at, action: 'logo-replaced', targetId: slotId, detail: `${slot.label}: ${filename ?? file} (${img.width}×${img.height}).` }) };
    }));
  });
  const restoreLogo = (id: string, expected: number, slotId: string) => locked(id, async () => {
    const t = store.require(id), a = requireAnalysis(t, undefined), slot = a.logoSlots.find(l => l.id === slotId) ?? fail('NOT_FOUND', 'Logo slot not found.');
    if (!slot.replacement) return view(t);
    const at = nowIso();
    return view(commit(t, expected, { written: [], unused: [slot.replacement.file] }, x => {
      const s = x.textAnalysis!.logoSlots.find(l => l.id === slotId)!;
      delete s.replacement;
      x.textAnalysis = { ...x.textAnalysis!, revision: x.textAnalysis!.revision + 1, updatedAt: at, history: withHistory(x.textAnalysis!.history, { at, action: 'logo-restored', targetId: slotId, detail: `${slot.label}: the source's own pixels again.` }) };
    }));
  });
  /**
   * A master template's regions and words in one change (master/service.ts): the regions derived from its reviewed words,
   * logos and plates (confirmed with them: a master is reviewed word by word, not region by region), its analysis, and
   * optionally a base it prepared locally (a clean background, always an estimate) with the preserved pixels against it.
   * `master` updates the record's master part in the same write.
   */
  const setMasterPrepared = (id: string, expected: number, input: { elements: ProtectedElement[]; analysis: TextAnalysis; base?: { png: Buffer; maskPng: Buffer; previewPng: Buffer; regions: ProtectedFillRegion[]; filledPercent: number }; master?: (x: ProtectedTemplate) => void }) => locked(id, async () => {
    const t = store.require(id);
    if (expected !== t.revision) fail('STALE_REVISION', `This template changed since you opened it (revision ${t.revision}, yours ${expected}). Reload it and make your change again.`, { revision: t.revision });
    const at = nowIso(), elements = input.elements.map(e => withNormalized(e, t.source)), key = regionsKey(elements), written: string[] = [];
    let base = t.base;
    if (input.base) {
      const hash = sha256(input.base.png), file = `base-${short(hash)}.png`, maskFile = `fill-mask-${short(hash)}.png`, previewFile = `fill-preview-${short(hash)}.png`;
      store.write(t.id, file, input.base.png); store.write(t.id, maskFile, input.base.maskPng); store.write(t.id, previewFile, input.base.previewPng); written.push(file, maskFile, previewFile);
      const checked = baseChecks(await decodeRgba(sourceOf(t)), await decodeRgba(input.base.png), elements);
      base = { method: 'local-fill', file, sha256: hash, width: t.source.width, height: t.source.height, preparedAt: at, regionsKey: key,
        fill: { regions: input.base.regions, filledPercent: input.base.filledPercent, maskFile, previewFile }, checks: checked.checks, outsideMeanDiff: checked.outsideMeanDiff, reliability: 'uncertain' };
    }
    const r = base && base.regionsKey === key ? await rasters(t, elements, base) : { elements, written: [] as string[], unused: [] as string[] };
    const old = t.base, unused = [...r.unused, ...t.elements.filter(e => !elements.some(n => n.id === e.id)).flatMap(e => [e.raster?.file, e.sourceAsset?.file].filter((f): f is string => !!f)),
      ...(input.base && old ? [old.file, old.upload?.file, old.fill?.maskFile, old.fill?.previewFile].filter((f): f is string => !!f && !written.includes(f)) : [])];
    return view(commit(t, expected, { written: [...written, ...r.written], unused }, x => {
      x.elements = r.elements; x.elementsRevision++; x.regionsConfirmed = { at, regionsKey: key };
      x.schemaVersion = PROTECTED_SCHEMA_VERSION; x.textAnalysis = { ...input.analysis, basis: { sourceSha256: x.source.sha256, regionsKey: key } };
      if (input.base) x.base = base;
      input.master?.(x);
    }));
  });
  /** Writes the master part of a record (and anything else `change` sets) under the template's own lock. */
  const updateMaster = (id: string, expected: number | undefined, change: (x: ProtectedTemplate) => void) => locked(id, async () => view(store.update(id, expected, change)));

  const createFromRun = async (runId: string, name?: string) => {
    const run = readLinkedRun(runId) ?? fail('NOT_FOUND', 'Run not found.');
    return create(readFileSync(join(runDir(runId), run.original.file)), { name: name ?? `From run ${runId.slice(-6)}`, origin: { kind: 'decomposition-run', runId } });
  };

  /** The run an earlier request with this idempotency key made, if any. */
  const runForKey = (id: string, key: string) => { const link = store.require(id).runs.find(r => r.idempotencyKey === key); return link ? readLinkedRun(link.runId) : undefined; };

  return { create, createFromRun, list, runForKey, view: (id: string) => view(store.require(id)), get: (id: string) => store.require(id), setDetails, setElements, attachAsset, confirmRegions, uploadBase, fillBase, approveBase,
    analyseText, correctText, replaceLogo, restoreLogo, setMasterPrepared, updateMaster, runSummary: (id: string, runId: string) => runSummary(store.require(id), runId),
    preflight: async (id: string) => preflight(store.require(id)), startDecomposition, execute, resume, executeResume, reconstructRun, approve, defaults: { maskThreshold: DEFAULT_MASK_THRESHOLD } };
}
