/**
 * Recursive (multi-pass) decomposition refinement for the OpenAI → Seedream layerize experiment. Runs after a run's own
 * decomposition is rendered (layerizeExperiment.ts collect) and before its layer count is applied, only for runs created
 * with the refinement option. It never changes how that first decomposition is planned or requested.
 *
 *   pass 0     the run's initial decomposition (its planner call and its one Seedream call), as rendered
 *   residual 1 Seedream's base with every extracted layer's area filled locally: what pass 0 left behind
 *   assess     assessBackgroundContamination: object-like regions left outside the extracted layers? no → stop
 *   pass 1     Seedream on residual 1 with a fixed residual prompt (no planner call); new layers minus duplicates
 *   residual 2 → assess → pass 2 (MAX_RESIDUAL_PASSES) → residual 3 is assessed for the record, never sent
 *   order      one stacking order for all layers, decided from the original where layers overlap, never by pass
 *   background the foreground union mask, then ONE clean background from the ORIGINAL image (cleanBackground.ts),
 *              checked for recreated products and leftover objects
 *   outputs    layers.json, contact-sheet.png and reconstructed.png rewritten; decomposition-debug.json added
 *
 * Bounded and visible: at most MAX_RESIDUAL_PASSES residual Seedream calls and one background edit per run, each
 * counted in run.calls when sent and never retried. Resume and re-render reuse what was saved (residual responses, the
 * background edit) and never send anything. A failed residual pass keeps every earlier layer; a failed or unavailable
 * background edit falls back to a local fill reported as "fallback", never as clean.
 *
 * Known limits: shadows are removed with a layer only as far as the layer's own alpha and the small mask growth reach;
 * broad environmental lighting stays in the background by design. Text that Seedream returns as layers is kept as raster
 * layers (no OCR). Background-role layers (a backdrop panel) are left in the clean background under their own layer.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildProviderInput, endpointRegistry, normalizeProviderOutput, ProviderError, type ProviderLayerMetadata } from './providers/adapters.js';
import type { FalTransport } from './providers/falClient.js';
import { backgroundRole, composeLayers, placeLayers, writeContactSheet, type Canvas, type CleanBackgroundMethod, type CleanBackgroundStatus, type LayerInfo, type Placement } from './layerizeArtifacts.js';
import { layerWords, posterRole, similarity } from './layerCount.js';
import { assessBackgroundContamination, backgroundModel, compositeOnGrid, coverageOnGrid, fidelity, flattenRgba, gridFor, intersectCount, layerShape, objectRetention, overlapStats, rgbOnGrid, unionOf,
  type ContaminationAssessment, type Fidelity, type Grid, type LayerShape, type Retention } from './backgroundContamination.js';
import { blendIntoCanvas, CLEAN_BACKGROUND_PROMPT, editInputs, featherMask, localFill, reconstructionSize, resizeMap, type BackgroundReconstructor } from './cleanBackground.js';
import { grow } from './outerBackground.js';
import type { RunRecord } from './layerizeExperiment.js';

/** Residual passes after the initial decomposition: a hard cap whatever a run asks for. */
export const MAX_RESIDUAL_PASSES = 2;
export type RefinementOptions = {
  /** Residual passes after the initial decomposition (0–MAX_RESIDUAL_PASSES). */
  maxDepth: number;
  /** New layers one residual pass may add; smaller extra fragments are grouped into one layer. */
  maxNewLayersPerPass: number;
  /** All layers of the result, the background included (the editor allows 60). */
  maxTotalLayers: number;
  /** A residual layer covering less of the canvas than this (%) is a fragment, not a layer. */
  minLayerAreaPercent: number;
  /** Foreground-mask growth around removed layers (fraction of the canvas's shorter side), and its feather (fraction of that growth). */
  maskDilation: number; maskFeather: number;
  /** Contamination: smallest region (% of canvas), total confident area (%) that counts, confidence a region needs. */
  minRegionPercent: number; contaminatedPercent: number; minConfidence: number;
  /** A background still shows a removed layer when this share (%) of the layer's distinctive pixels is unchanged. */
  retainedPercent: number;
  /** Duplicates: mask IoU with an existing layer, or the share of the new layer inside one. */
  duplicateIoU: number; duplicateContainment: number;
  /** One AI reconstruction of the clean background when the base is not clean; false: local fill only. */
  reconstructBackground: boolean;
};
export const REFINEMENT_DEFAULTS: RefinementOptions = { maxDepth: MAX_RESIDUAL_PASSES, maxNewLayersPerPass: 8, maxTotalLayers: 32, minLayerAreaPercent: 0.1, maskDilation: 0.008, maskFeather: 0.5,
  minRegionPercent: 0.25, contaminatedPercent: 0.6, minConfidence: 0.5, retainedPercent: 25, duplicateIoU: 0.5, duplicateContainment: 0.7, reconstructBackground: true };

/** Every paid or metered provider request of a run, counted when sent (a failed request still counts). */
export type CallCounts = { fitCheck: number; planner: number; seedreamInitial: number; seedreamResidual: number; backgroundReconstruction: number };
export const noCalls = (): CallCounts => ({ fitCheck: 0, planner: 0, seedreamInitial: 0, seedreamResidual: 0, backgroundReconstruction: 0 });
export const callLines = (calls: CallCounts) => [`Template fit check (OpenAI): ${calls.fitCheck}`, `Planner (OpenAI): ${calls.planner}`, `Initial layerize (Seedream): ${calls.seedreamInitial}`,
  `Residual layerize (Seedream): ${calls.seedreamResidual}`, `Background reconstruction (OpenAI image edit): ${calls.backgroundReconstruction}`];

export type StopReason = 'clean' | 'below-threshold' | 'low-confidence' | 'not-assessable' | 'max-depth' | 'no-new-layers' | 'all-duplicates' | 'pass-failed' | 'max-total-layers' | 'resume-no-new-calls';
export type RejectedLayer = { file: string; name?: string; reason: 'unplaced' | 'fragment' | 'background-like' | 'inside-extracted-region' | 'duplicate' | 'over-total-limit'; duplicateOf?: string; iou?: number };
export type PassRecord = {
  /** 1 or 2: the residual pass (the initial decomposition is pass 0, the run's own Seedream call). */
  pass: number; state: 'submitting' | 'submitted' | 'done' | 'failed';
  input: { file: string; sha256: string; width: number; height: number }; prompt: string;
  requestId?: string; submittedAt?: string; completedAt?: string; durationMs?: number;
  returnedLayers?: number; accepted: string[]; grouped?: string[]; rejected: RejectedLayer[];
  error?: { code: string; message: string };
};
export type AssessmentRecord = ContaminationAssessment & { after: number; residual: string; sent: boolean };
export type BackgroundRecord = {
  status: CleanBackgroundStatus; method: CleanBackgroundMethod; file: string; source: 'original' | 'provider-base';
  /** Whether the provider base had to be replaced (it still showed extracted layers, or could not be checked). */
  needed: boolean; contaminated: boolean; reasons: string[];
  baseRetention: Retention[]; recreated: Retention[]; residual: Omit<ContaminationAssessment, 'regions'> & { regions: number };
};
export type RefinementRecord = {
  version: 1; options: RefinementOptions; state: 'pending' | 'running' | 'done' | 'failed';
  /** Residual passes that were sent (kept across resumes: their request IDs and responses are reused, never resent). */
  passes: PassRecord[];
  assessments: AssessmentRecord[];
  stopReason?: StopReason; stopDetail?: string;
  /** 1 (the initial decomposition) + residual passes that returned a result. */
  passesExecuted?: number; finalLayers?: number;
  mask?: { layers: string[]; coveragePercent: number; dilatePx: number; featherPx: number; file: string };
  background?: BackgroundRecord;
  /** The one background edit: its cache key (source + mask + size + prompt + model), so a re-render reuses it. */
  reconstruction?: { key: string; model: string; size: { width: number; height: number }; state: 'sent' | 'done' | 'failed'; sentAt: string; requestId?: string; durationMs?: number; error?: { code: string; message: string } };
  fidelity?: { before: Fidelity; after: Fidelity };
  warnings: string[]; error?: string;
};

/** The options a run is created with, or undefined when it is not refined. Partial options are clamped to the hard limits. */
export function refinementOptions(value: boolean | Partial<RefinementOptions> | undefined): RefinementOptions | undefined {
  if (!value) return undefined;
  const options = { ...REFINEMENT_DEFAULTS, ...(value === true ? {} : value) };
  for (const [key, number] of Object.entries(options)) if (typeof number === 'number' && !Number.isFinite(number)) throw new Error(`Refinement option ${key} must be a finite number.`);
  const int = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));
  return { ...options, maxDepth: int(options.maxDepth, 0, MAX_RESIDUAL_PASSES), maxNewLayersPerPass: int(options.maxNewLayersPerPass, 1, 16), maxTotalLayers: int(options.maxTotalLayers, 2, 60),
    maskDilation: Math.min(0.05, Math.max(0, options.maskDilation)), maskFeather: Math.min(1, Math.max(0, options.maskFeather)) };
}
export const newRefinementRecord = (options: RefinementOptions): RefinementRecord => ({ version: 1, options, state: 'pending', passes: [], assessments: [], warnings: [] });

export const RESIDUAL_PROMPT = 'This is the background of an offer creative after some objects were already taken out. Separate every distinct object still visible in it (products, devices, pedestals or platforms, gift boxes, major decorations, logos and text blocks) into its own layer, each complete and unchanged. Keep the plain scene (wall, floor or table surface, gradients, lighting and background patterns) as the base. Group tiny scattered decorations such as confetti into one layer. Do not invent objects.';
/** The residual prompt, with where the remaining objects were found (positions in words, never coordinates). */
export function residualPrompt(assessment: ContaminationAssessment, minConfidence: number): string {
  const where = [...new Set(assessment.regions.filter(r => r.confidence >= minConfidence).map(r => r.position))].slice(0, 6);
  return where.length ? `${RESIDUAL_PROMPT} Remaining objects are around: ${where.join(', ')}.` : RESIDUAL_PROMPT;
}

export type RefineDeps = { backgroundReconstructor?: BackgroundReconstructor; sleep?: (ms: number) => Promise<void>; pollIntervalMs?: number; pollTimeoutMs?: number };
export type RefineContext = {
  dir: string; run: RunRecord; canvas: Canvas;
  /** The rendered initial decomposition (renderLayerizeOutputs): the base and every layer. */
  layers: LayerInfo[]; renderWarnings: string[];
  /** The uploaded (orientation-normalized) image: the source of the clean background. */
  sourceImage?: Buffer;
  transport: FalTransport; deps: RefineDeps;
  /** True only for a run's first execution; resume and re-render reuse saved results and never send anything. */
  allowNewCalls: boolean;
  /** Persists run.json (request IDs and call counts are saved the moment they exist). */
  save: () => void;
};

type Item = { layer: LayerInfo; png: Buffer; shape: LayerShape; pass: number; providerZ: number; kind: 'background' | 'foreground'; role: string; sourceImage: string; requestId?: string };
const ENDPOINT = endpointRegistry.seedream.endpoint;
const AI_FILE = 'clean-background-ai.png', CLEAN_FILE = 'clean-background.png', MASK_FILE = 'foreground-mask.png', DEBUG_FILE = 'decomposition-debug.json';
const sha256 = (bytes: Buffer | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
class PassError extends Error { constructor(public readonly code: string, message: string) { super(message); } }

/** Background for a framing or scene layer large enough to be the scene; foreground otherwise (with its role, read from its name). */
export function classify(layer: LayerInfo, shape: LayerShape, grid: Grid): { kind: Item['kind']; role: string } {
  const n = grid.width * grid.height, box = shape.box;
  const boxShare = box ? (box.x1 - box.x0) * (box.y1 - box.y0) / n : 0;
  const fullSolid = !!box && box.x1 - box.x0 >= 0.9 * grid.width && box.y1 - box.y0 >= 0.9 * grid.height && shape.count / n >= 0.6;
  const framing = backgroundRole(layer.name), named = posterRole(layer);
  const sceneNamed = !!framing || named === 'background' || named === 'backdrop' || named === 'border';
  // A frame-filling layer is the scene, unless it is named as a product or text (a close-up hero is still removable).
  if ((fullSolid && named !== 'product' && named !== 'text') || (sceneNamed && boxShare >= 0.5)) return { kind: 'background', role: framing ? `${framing} background` : named === 'unknown' ? 'background' : named };
  return { kind: 'foreground', role: sceneNamed ? 'decor' : named };
}
/** A layer covering (almost) the whole canvas explains nothing about where objects are. */
const explains = (item: Item, grid: Grid) => item.shape.count > 0 && !(item.kind === 'background' && item.shape.box && item.shape.box.x1 - item.shape.box.x0 >= 0.9 * grid.width && item.shape.box.y1 - item.shape.box.y0 >= 0.9 * grid.height);
/** Stacking priority where nothing overlaps: background, decoration, supports, secondary objects, products, text on top. */
const RANK: Record<string, number> = { decor: 1, support: 2, secondary: 3, unknown: 3, product: 4, text: 5 };
const rankOf = (item: Item) => item.kind === 'background' ? 0 : RANK[item.role] ?? 3;

/** A placement on another pass's canvas, scaled onto this run's canvas. */
function toCanvas(p: Placement, scale: number, canvas: Canvas): Placement {
  if (p.kind === 'unresolved' || scale === 1) return p;
  if (p.kind === 'full-canvas' || p.kind === 'base') return { kind: 'bbox-scaled', x: 0, y: 0, width: canvas.width, height: canvas.height };
  return { kind: 'bbox-scaled', x: Math.round(p.x * scale), y: Math.round(p.y * scale), width: Math.max(1, Math.round(p.width * scale)), height: Math.max(1, Math.round(p.height * scale)) };
}

/** Polls a submitted residual request (never resubmits): three lookup failures in a row or the timeout end it. */
async function awaitResult(transport: FalTransport, requestId: string, deps: RefineDeps): Promise<unknown> {
  const sleep = deps.sleep ?? (ms => new Promise(done => setTimeout(done, ms))), started = Date.now();
  let failures = 0;
  for (;;) {
    let status: string;
    try { status = await transport.status(ENDPOINT, requestId); failures = 0; }
    catch (error) {
      if (++failures >= 3) throw new PassError('FAL_STATUS_FAILED', `${error instanceof Error ? error.message : String(error)}. Request ${requestId} is saved; a resume reads it without resubmitting.`);
      await sleep(deps.pollIntervalMs ?? 3000); continue;
    }
    if (status === 'COMPLETED') break;
    if (Date.now() - started > (deps.pollTimeoutMs ?? 10 * 60_000)) throw new PassError('POLL_TIMEOUT', `Still ${status}. Request ${requestId} is saved; a resume reads it without resubmitting.`);
    await sleep(deps.pollIntervalMs ?? 3000);
  }
  try { return await transport.result(ENDPOINT, requestId); }
  catch (error) {
    const detail = error instanceof ProviderError && error.providerDetail ? ` fal HTTP ${error.providerDetail.status}: ${error.providerDetail.messages.map(m => m.msg).join(' | ')}` : '';
    throw new PassError(error instanceof ProviderError && error.status === 422 ? 'PROVIDER_DECOMPOSITION_REJECTED' : 'FAL_RESULT_FAILED', `${error instanceof Error ? error.message : String(error)}.${detail}`);
  }
}

/**
 * One residual pass: reuses a saved response, or polls a saved request ID, or (first execution only) uploads the residual
 * and submits it once. The request ID is saved the moment it exists; the call is counted before it is sent.
 */
async function runPass(ctx: RefineContext, record: RefinementRecord, depth: number, residual: Buffer, residualFile: string, prompt: string): Promise<{ raw: unknown; pass: PassRecord }> {
  const { dir, run } = ctx, responseFile = `pass-${depth}-seedream-response.json`, requestFile = `pass-${depth}-seedream-request.json`;
  const inputSha = sha256(residual), meta = await sharp(residual).metadata();
  let pass = record.passes.find(p => p.pass === depth);
  if (pass && existsSync(join(dir, responseFile))) {
    if (pass.input.sha256 !== inputSha) record.warnings.push(`RESIDUAL_INPUT_CHANGED: residual ${depth} is no longer byte-identical to what was sent; the saved result of request ${pass.requestId} is reused as it is (no new call).`);
    return { raw: JSON.parse(readFileSync(join(dir, responseFile), 'utf8')), pass };
  }
  if (!pass?.requestId) {
    pass = { pass: depth, state: 'submitting', input: { file: residualFile, sha256: inputSha, width: meta.width!, height: meta.height! }, prompt, accepted: [], rejected: [] };
    record.passes = [...record.passes.filter(p => p.pass !== depth), pass];
    let input: Record<string, unknown>;
    try { input = buildProviderInput('seedream', { imageUrl: 'https://fal.media/placeholder-until-upload', prompt, imageSize: 'auto', enhancePromptMode: 'standard', width: meta.width, height: meta.height }); }
    catch (error) { throw Object.assign(new PassError('INVALID_SEEDREAM_INPUT', error instanceof Error ? error.message : String(error)), { pass }); }
    let imageUrl: string;
    try { imageUrl = await ctx.transport.upload(residual, 'image/png'); }
    catch (error) { throw Object.assign(new PassError('FAL_UPLOAD_FAILED', `${error instanceof Error ? error.message : String(error)} (nothing was submitted)`), { pass }); }
    const shown = { ...input, image_url: `<fal upload of ${residualFile}, ${meta.width}x${meta.height}>` };
    writeFileSync(join(dir, requestFile), JSON.stringify({ endpoint: ENDPOINT, input: shown }, null, 2));
    run.calls!.seedreamResidual++;
    ctx.save();
    try {
      const { requestId } = await ctx.transport.submit(ENDPOINT, { ...input, image_url: imageUrl });
      Object.assign(pass, { requestId, submittedAt: new Date().toISOString(), state: 'submitted' });
      writeFileSync(join(dir, requestFile), JSON.stringify({ endpoint: ENDPOINT, requestId, input: shown }, null, 2));
      ctx.save();
    } catch (error) { throw Object.assign(new PassError('FAL_SUBMIT_FAILED', `${error instanceof Error ? error.message : String(error)}. No request ID was returned; not resubmitted.`), { pass }); }
  }
  const started = Date.now();
  try {
    const raw = await awaitResult(ctx.transport, pass.requestId!, ctx.deps);
    writeFileSync(join(dir, responseFile), JSON.stringify(raw, null, 2));
    Object.assign(pass, { completedAt: new Date().toISOString(), durationMs: Date.now() - started });
    return { raw, pass };
  } catch (error) { throw Object.assign(error instanceof PassError ? error : new PassError('FAL_RESULT_FAILED', String(error)), { pass }); }
}

/** A residual pass's layers on this run's canvas: files pass-N-layer-NN.png (downloaded once), its base resized to the canvas. */
async function renderPass(ctx: RefineContext, depth: number, raw: unknown, A: Grid, requestId?: string): Promise<{ base?: Buffer; candidates: Item[]; returned: number }> {
  const output = normalizeProviderOutput('seedream', raw);
  const decoded: { png: Buffer; file: string; width: number; height: number; opaque: number; meta: ProviderLayerMetadata }[] = [];
  for (const [i, image] of output.images.entries()) {
    const file = `pass-${depth}-layer-${String(i).padStart(2, '0')}.png`, local = join(ctx.dir, file);
    const png = existsSync(local) ? readFileSync(local) : await ctx.transport.download(image.url);
    if (!existsSync(local)) writeFileSync(local, png);
    const { data, info } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
    let opaque = 0; for (const a of data) if (a > 127) opaque++;
    decoded.push({ png, file, width: info.width, height: info.height, opaque: opaque / (info.width * info.height), meta: output.layers?.[i] ?? { zIndex: i } });
  }
  const { canvas: own, placements } = placeLayers(decoded);
  if (Math.abs((own.width / own.height) / (ctx.canvas.width / ctx.canvas.height) - 1) > 0.01) throw new PassError('PASS_ASPECT_MISMATCH', `Residual pass ${depth} returned a ${own.width}×${own.height} canvas, not the run's ${ctx.canvas.width}×${ctx.canvas.height} aspect.`);
  const scale = ctx.canvas.width / own.width, baseAt = placements.findIndex(p => p.kind === 'base');
  const base = baseAt >= 0 ? await sharp(decoded[baseAt].png).resize(ctx.canvas.width, ctx.canvas.height, { fit: 'fill' }).png().toBuffer() : undefined;
  const candidates: Item[] = [];
  for (const [i, d] of decoded.entries()) {
    if (i === baseAt) continue;
    const layer: LayerInfo = { index: i, file: d.file, zIndex: d.meta.zIndex, ...(d.meta.name ? { name: d.meta.name } : {}), ...(d.meta.description ? { description: d.meta.description } : {}),
      ...(scale === 1 && d.meta.bboxAbsolute ? { bboxAbsolute: d.meta.bboxAbsolute } : {}), ...(d.meta.bboxNormalized ? { bboxNormalized: d.meta.bboxNormalized } : {}),
      pixelWidth: d.width, pixelHeight: d.height, opaquePercent: Math.round(d.opaque * 1000) / 10, placement: toCanvas(placements[i], scale, ctx.canvas) };
    const shape = await layerShape(d.png, layer, A), { kind, role } = classify(layer, shape, A);
    candidates.push({ layer, png: d.png, shape, pass: depth, providerZ: d.meta.zIndex, kind, role, sourceImage: `residual-pass-${depth}.png`, ...(requestId ? { requestId } : {}) });
  }
  return { base, candidates, returned: decoded.length };
}

/**
 * Which of a residual pass's layers are new. Rejected: unplaced; fragments; background-like layers (a residual pass looks
 * for objects); layers mostly inside an area already extracted and filled (a duplicate, or an artifact of the fill);
 * duplicates of an earlier or larger same-pass layer (mask IoU, containment, or box overlap with a similar name). The
 * earlier layer is always the one kept. Extra small layers beyond maxNewLayersPerPass become one grouped layer.
 */
async function screen(ctx: RefineContext, candidates: Item[], existing: Item[], filled: Uint8Array, options: RefinementOptions, A: Grid, depth: number): Promise<{ accepted: Item[]; rejected: (RejectedLayer & { item: Item })[]; grouped: string[] }> {
  const n = A.width * A.height, accepted: Item[] = [], rejected: (RejectedLayer & { item: Item })[] = [];
  const reject = (item: Item, reason: RejectedLayer['reason'], extra: Partial<RejectedLayer> = {}) => rejected.push({ item, file: item.layer.file, ...(item.layer.name ? { name: item.layer.name } : {}), reason, ...extra });
  for (const item of [...candidates].sort((a, b) => b.shape.count - a.shape.count)) {
    if (item.layer.placement.kind === 'unresolved') { reject(item, 'unplaced'); continue; }
    if (100 * item.shape.count / n < options.minLayerAreaPercent) { reject(item, 'fragment'); continue; }
    if (item.kind === 'background') { reject(item, 'background-like'); continue; }
    if (intersectCount(item.shape.alpha, filled) / item.shape.count >= options.duplicateContainment) {
      const owner = existing.map(e => ({ e, inter: intersectCount(item.shape.alpha, e.shape.alpha) })).sort((a, b) => b.inter - a.inter)[0];
      reject(item, 'inside-extracted-region', owner?.inter ? { duplicateOf: owner.e.layer.file } : {}); continue;
    }
    const words = layerWords(item.layer.name, item.layer.description);
    const twin = [...existing, ...accepted].map(e => ({ e, s: overlapStats(item.shape, e.shape) })).find(({ e, s }) => s.iou >= options.duplicateIoU || s.aInB >= options.duplicateContainment
      || (s.boxIoU >= 0.5 && similarity(words, layerWords(e.layer.name, e.layer.description)) >= 0.34));
    if (twin) { reject(item, 'duplicate', { duplicateOf: twin.e.layer.file, iou: round(twin.s.iou) }); continue; }
    accepted.push(item);
  }
  // Beyond the per-pass cap, the smallest extras are grouped into one layer (fragments, confetti) instead of 20 tiny ones.
  let grouped: string[] = [];
  if (accepted.length > options.maxNewLayersPerPass) {
    const extras = accepted.splice(options.maxNewLayersPerPass - 1);
    grouped = extras.map(e => e.layer.file);
    const file = `pass-${depth}-grouped.png`;
    const rgba = await compositeOnGrid(extras.map(e => ({ png: e.png, placement: e.layer.placement })), { ...ctx.canvas, scale: 1 });
    const png = await sharp(rgba, { raw: { width: ctx.canvas.width, height: ctx.canvas.height, channels: 4 } }).png().toBuffer();
    writeFileSync(join(ctx.dir, file), png);
    const layer: LayerInfo = { index: extras[0].layer.index, file, zIndex: Math.min(...extras.map(e => e.layer.zIndex)), name: `Residual details (pass ${depth})`, pixelWidth: ctx.canvas.width, pixelHeight: ctx.canvas.height,
      opaquePercent: round(100 * extras.reduce((sum, e) => sum + e.shape.count, 0) / n, 1), placement: { kind: 'full-canvas', x: 0, y: 0, width: ctx.canvas.width, height: ctx.canvas.height } };
    accepted.push({ ...extras[0], layer, png, shape: await layerShape(png, layer, A), role: 'decor', providerZ: layer.zIndex });
  }
  // The result never exceeds maxTotalLayers (the background counts as one).
  const room = Math.max(0, options.maxTotalLayers - 1 - existing.length);
  for (const item of accepted.splice(room)) reject(item, 'over-total-limit');
  return { accepted, rejected, grouped };
}

/** The layer in front where two overlap: the one whose pixels match the original there; undefined when it is unclear. */
function frontOf(a: Item, b: Item, original: Buffer): Item | undefined {
  let ea = 0, eb = 0, count = 0;
  const diff = (rgba: Buffer, i: number) => Math.max(Math.abs(rgba[i * 4] - original[i * 3]), Math.abs(rgba[i * 4 + 1] - original[i * 3 + 1]), Math.abs(rgba[i * 4 + 2] - original[i * 3 + 2]));
  for (let i = 0; i < a.shape.alpha.length; i++) if (a.shape.alpha[i] && b.shape.alpha[i]) { count++; ea += diff(a.shape.rgba, i); eb += diff(b.shape.rgba, i); }
  if (!count || Math.abs(ea - eb) / count < 6) return undefined;
  return ea < eb ? a : b;
}
/**
 * One back-to-front order for every layer. Within a pass, the provider's order holds. Across passes, where two layers
 * overlap, the one matching the original there is in front (unclear: the earlier pass's layer, since what a residual
 * pass finds was behind it). Elsewhere: background, decoration, supports, secondary objects, products, then text.
 */
export function stackOrder(items: Item[], original: Buffer): { order: Item[]; notes: string[] } {
  const n = items.length, below = items.map(() => new Set<number>()), notes: string[] = [];
  const byPass = new Map<number, number[]>();
  items.forEach((item, i) => byPass.set(item.pass, [...(byPass.get(item.pass) ?? []), i]));
  for (const list of byPass.values()) {
    list.sort((a, b) => items[a].providerZ - items[b].providerZ);
    for (let k = 1; k < list.length; k++) below[list[k]].add(list[k - 1]);
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (items[i].pass >= items[j].pass) continue;
    const s = overlapStats(items[i].shape, items[j].shape);
    if (s.inter < Math.max(20, 0.02 * Math.min(items[i].shape.count, items[j].shape.count))) continue;
    const front = frontOf(items[i], items[j], original) ?? items[i];
    if (front === items[i]) below[i].add(j); else below[j].add(i);
  }
  const key = (i: number) => [rankOf(items[i]), -items[i].pass, items[i].providerZ, i];
  const before = (x: number, y: number) => { const a = key(x), b = key(y); for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] - b[k]; return 0; };
  const placed = new Set<number>(), order: number[] = [];
  while (order.length < n) {
    const open = [...Array(n).keys()].filter(i => !placed.has(i)), ready = open.filter(i => [...below[i]].every(j => placed.has(j)));
    if (!ready.length) notes.push(`ORDER_CYCLE_BROKEN: overlaps between ${open.map(i => items[i].layer.file).join(', ')} contradict each other; ${items[open.sort(before)[0]].layer.file} was placed first.`);
    const next = (ready.length ? ready : open).sort(before)[0];
    placed.add(next); order.push(next);
  }
  return { order: order.map(i => items[i]), notes };
}

const pngOfMap = (map: Uint8Array, width: number, height: number) => sharp(Buffer.from(map.buffer, map.byteOffset, map.byteLength), { raw: { width, height, channels: 1 } }).png().toBuffer();

/**
 * Refines a rendered decomposition (see the module comment). Returns the final layers (the clean background as the base,
 * then every layer in stacking order, unplaced layers last) and warnings for the run. Updates run.refinement and
 * run.calls in place and writes every artifact; the caller persists the run.
 */
export async function refineDecomposition(ctx: RefineContext): Promise<{ layers: LayerInfo[]; warnings: string[] }> {
  const { dir, run, canvas } = ctx, record = run.refinement!, options = record.options, calls = run.calls!;
  Object.assign(record, { state: 'running', assessments: [], warnings: [] });
  for (const key of ['stopReason', 'stopDetail', 'passesExecuted', 'finalLayers', 'mask', 'background', 'fidelity', 'error'] as const) delete record[key];
  const read = (file: string) => readFileSync(join(dir, file));
  const baseAt = ctx.layers.findIndex(l => l.placement.kind === 'base');
  if (baseAt < 0) {
    Object.assign(record, { state: 'done', stopReason: 'not-assessable', stopDetail: 'Seedream returned no base layer, so there is no background to refine.' });
    return { layers: ctx.layers, warnings: ['REFINEMENT_SKIPPED: Seedream returned no base layer, so there is no background to refine.'] };
  }
  const A = gridFor(canvas, 640), M = gridFor(canvas, 2048), nA = A.width * A.height;
  const base0 = ctx.layers[baseAt], base0Png = read(base0.file);
  // The clean background's source: the uploaded image when it has the canvas aspect (it holds the real pixels), else the provider base.
  const sourceMeta = ctx.sourceImage ? await sharp(ctx.sourceImage).metadata().catch(() => undefined) : undefined;
  const source = sourceMeta?.width && sourceMeta.height && Math.abs((sourceMeta.width / sourceMeta.height) / (canvas.width / canvas.height) - 1) <= 0.01
    ? { png: ctx.sourceImage!, name: 'original' as const, file: run.input.file } : { png: base0Png, name: 'provider-base' as const, file: base0.file };
  const originalA = await rgbOnGrid(source.png, A);
  const dilateM = Math.max(1, Math.round(options.maskDilation * Math.min(M.width, M.height)));

  const items: Item[] = [], unplaced: LayerInfo[] = [];
  for (const layer of ctx.layers) {
    if (layer === base0) continue;
    if (layer.placement.kind === 'unresolved') { unplaced.push(layer); continue; }
    const png = read(layer.file), shape = await layerShape(png, layer, A), { kind, role } = classify(layer, shape, A);
    items.push({ layer, png, shape, pass: 0, providerZ: layer.zIndex, kind, role, sourceImage: run.input.file, ...(run.seedream.requestId ? { requestId: run.seedream.requestId } : {}) });
  }

  // Residual passes: find what the decomposition so far left in the background, at most options.maxDepth times.
  const passTiles: { png: Buffer; title: string; sub: string }[] = [];
  let currentBase: Buffer = base0Png;
  const stop = (reason: StopReason, detail: string) => Object.assign(record, { stopReason: reason, stopDetail: detail });
  for (let depth = 1; ; depth++) {
    const explaining = items.filter(item => explains(item, A));
    const filledA = grow(unionOf(explaining.map(item => item.shape.alpha), nA), A.width, A.height, Math.max(1, Math.round(dilateM * A.scale / M.scale)));
    // Nothing extracted yet to fill: the residual is the base itself (already at the canvas size).
    const coreM = explaining.length ? grow(await coverageOnGrid(explaining.map(item => ({ png: item.png, placement: item.layer.placement })), M), M.width, M.height, dilateM) : undefined;
    const residual = coreM ? await localFill(currentBase, { map: coreM, width: M.width, height: M.height }, { map: featherMask(coreM, M.width, M.height, 1), width: M.width, height: M.height }, canvas) : currentBase;
    const residualFile = depth <= options.maxDepth ? `residual-pass-${depth}.png` : 'residual-final.png';
    writeFileSync(join(dir, residualFile), residual);
    const assessment = assessBackgroundContamination({ rgb: await rgbOnGrid(residual, A), width: A.width, height: A.height, explained: unionOf(explaining.map(item => item.shape.alpha), nA) }, options);
    const entry: AssessmentRecord = { ...assessment, after: depth - 1, residual: residualFile, sent: false };
    record.assessments.push(entry);
    passTiles.push({ png: residual, title: depth <= options.maxDepth ? `Residual ${depth} (after pass ${depth - 1})` : `Residual after pass ${depth - 1}`, sub: `${assessment.verdict} · ${assessment.contaminatedPercent}% object-like` });
    if (!assessment.contaminated) { stop(assessment.verdict as StopReason, assessment.reasons.join(' ')); break; }
    if (depth > options.maxDepth) { stop('max-depth', `Still contaminated after ${options.maxDepth} residual pass(es) (the hard limit is ${MAX_RESIDUAL_PASSES}): ${assessment.reasons.join(' ')}`); break; }
    if (items.length + 1 >= options.maxTotalLayers) { stop('max-total-layers', `The result already has ${items.length + 1} layers (limit ${options.maxTotalLayers}).`); break; }
    if (!ctx.allowNewCalls && !record.passes.find(p => p.pass === depth)?.requestId) {
      stop('resume-no-new-calls', `Residual pass ${depth} would be a new paid Seedream call, and a resume or re-render never makes one: ${assessment.reasons.join(' ')}`); break;
    }
    let raw: unknown, pass: PassRecord;
    try { ({ raw, pass } = await runPass(ctx, record, depth, residual, residualFile, residualPrompt(assessment, options.minConfidence))); entry.sent = true; }
    catch (error) {
      const failed = (error as { pass?: PassRecord }).pass, code = error instanceof PassError ? error.code : 'RESIDUAL_PASS_FAILED', message = error instanceof Error ? error.message : String(error);
      if (failed) Object.assign(failed, { state: 'failed', error: { code, message } });
      entry.sent = !!failed?.requestId;
      stop('pass-failed', `Residual pass ${depth} failed (${code}): ${message} Every earlier layer is kept.`);
      record.warnings.push(`RESIDUAL_PASS_FAILED: pass ${depth} (${code}): ${message}`);
      ctx.save(); break;
    }
    let rendered: Awaited<ReturnType<typeof renderPass>>;
    try { rendered = await renderPass(ctx, depth, raw, A, pass.requestId); }
    catch (error) {
      const code = error instanceof PassError ? error.code : 'RESIDUAL_RENDER_FAILED', message = error instanceof Error ? error.message : String(error);
      Object.assign(pass, { state: 'failed', error: { code, message } });
      stop('pass-failed', `Residual pass ${depth} could not be used (${code}): ${message} Every earlier layer is kept.`);
      record.warnings.push(`RESIDUAL_PASS_FAILED: pass ${depth} (${code}): ${message}`);
      break;
    }
    const { accepted, rejected, grouped } = await screen(ctx, rendered.candidates, items, filledA, options, A, depth);
    Object.assign(pass, { state: 'done', returnedLayers: rendered.returned, accepted: accepted.map(item => item.layer.file), rejected: rejected.map(({ item, ...rest }) => { void item; return rest; }), ...(grouped.length ? { grouped } : {}) });
    delete pass.error;
    for (const item of accepted) passTiles.push({ png: item.png, title: `P${depth} · ${item.layer.name ?? 'layer'}`, sub: `new · ${item.role} · ${round(100 * item.shape.count / nA, 1)}%` });
    for (const r of rejected) passTiles.push({ png: r.item.png, title: `✗ P${depth} · ${r.name ?? 'layer'}`, sub: `${r.reason}${r.duplicateOf ? ` of ${r.duplicateOf}` : ''}` });
    if (!accepted.length) {
      const duplicates = rejected.filter(r => r.reason === 'duplicate' || r.reason === 'inside-extracted-region').length;
      stop(duplicates ? 'all-duplicates' : 'no-new-layers', duplicates ? `Residual pass ${depth} returned only layers already extracted (${duplicates} duplicate(s)).` : `Residual pass ${depth} returned no new usable layer.`);
      break;
    }
    items.push(...accepted);
    currentBase = rendered.base ?? residual;
  }
  const residualPasses = record.passes.filter(p => p.state === 'done').length;
  record.passesExecuted = 1 + residualPasses;

  // One stacking order for every layer (pass provenance is not z-order).
  const { order, notes } = stackOrder(items, originalA);
  record.warnings.push(...notes);

  // The foreground union mask: every foreground layer, grown a little (edges, halos, contact shadows), feathered.
  const foreground = order.filter(item => item.kind === 'foreground' && item.shape.count > 0);
  const coreM = foreground.length ? grow(await coverageOnGrid(foreground.map(item => ({ png: item.png, placement: item.layer.placement })), M), M.width, M.height, dilateM) : new Uint8Array(M.width * M.height);
  const featherM = Math.max(1, Math.min(dilateM, Math.round(dilateM * options.maskFeather)));
  const alphaM = featherMask(coreM, M.width, M.height, featherM);
  let covered = 0; for (const v of coreM) covered += v;
  writeFileSync(join(dir, MASK_FILE), await pngOfMap(await resizeMap(alphaM, M, canvas), canvas.width, canvas.height));
  record.mask = { layers: foreground.map(item => item.layer.file), coveragePercent: round(100 * covered / (M.width * M.height), 1), dilatePx: round(dilateM / M.scale, 1), featherPx: round(featherM / M.scale, 1), file: MASK_FILE };

  // Does the provider base still show the extracted layers? Compared with the original where each layer is.
  const major = foreground.filter(item => 100 * item.shape.count / nA >= 0.3).map(item => ({ file: item.layer.file, name: item.layer.name, alpha: item.shape.alpha }));
  // The original's background under the layers, estimated only when there is a layer to check against it.
  const model = major.length ? backgroundModel(originalA, A.width, A.height, grow(unionOf(foreground.map(item => item.shape.alpha), nA), A.width, A.height, 2)).model : new Float32Array(0);
  const baseRetention = source.name === 'original' ? objectRetention(await rgbOnGrid(base0Png, A), originalA, model, major) : [];
  const duplicated = baseRetention.filter(r => r.retainedPercent >= options.retainedPercent);
  const needed = foreground.length > 0 && (source.name !== 'original' || duplicated.length > 0);
  const reasons: string[] = [];
  let backgroundPng: Buffer = base0Png, method: CleanBackgroundMethod = 'provider-base';
  if (!needed) reasons.push(foreground.length ? 'Seedream\'s base no longer shows any extracted layer, so it is kept as returned (no reconstruction call).' : 'There is no foreground layer to remove.');
  else {
    reasons.push(source.name === 'original' ? `Seedream's base still shows ${duplicated.map(r => `${r.name ?? r.file} (${r.retainedPercent}%)`).join(', ')}.` : 'The original does not match the canvas aspect, so the provider base is cleaned instead and cannot be compared.');
    const size = reconstructionSize(canvas), reconstructor = ctx.deps.backgroundReconstructor;
    const key = size && reconstructor ? sha256(Buffer.from(JSON.stringify({ source: sha256(source.png), mask: sha256(coreM), size, prompt: CLEAN_BACKGROUND_PROMPT, model: reconstructor.model }))) : undefined;
    let ai: Buffer | undefined, why = '';
    if (key && record.reconstruction?.key === key && record.reconstruction.state === 'done' && existsSync(join(dir, AI_FILE))) ai = read(AI_FILE);
    else if (!options.reconstructBackground) why = 'AI reconstruction is turned off for this run';
    else if (!size) why = `the canvas aspect ${canvas.width}×${canvas.height} is outside the 1:3–3:1 an image edit accepts`;
    else if (!reconstructor) why = 'no background reconstructor is configured';
    else if (!ctx.allowNewCalls) why = 'a resume or re-render never makes a new paid call';
    else if (calls.backgroundReconstruction >= 1) why = 'this run already used its one background reconstruction';
    else {
      const inputs = await editInputs(source.png, { map: coreM, width: M.width, height: M.height }, size!);
      writeFileSync(join(dir, 'clean-background-mask.png'), inputs.mask);
      writeFileSync(join(dir, 'clean-background-request.json'), JSON.stringify({ method: 'images.edit', model: reconstructor.model, size: `${size!.width}x${size!.height}`, n: 1, output_format: 'png', prompt: CLEAN_BACKGROUND_PROMPT,
        image: `<${source.name === 'original' ? `original image ${source.file}` : `provider base ${source.file}`}, resized to ${size!.width}x${size!.height}>`, mask: '<clean-background-mask.png: transparent = remove>', cacheKey: key }, null, 2));
      record.reconstruction = { key: key!, model: reconstructor.model, size: size!, state: 'sent', sentAt: new Date().toISOString() };
      calls.backgroundReconstruction++;
      ctx.save();
      const started = Date.now();
      try {
        const result = await reconstructor.reconstruct({ image: inputs.image, mask: inputs.mask, prompt: CLEAN_BACKGROUND_PROMPT, size: size! });
        const meta = await sharp(result.image).metadata().catch(() => undefined);
        if (!meta?.width || !meta.height) throw new Error('The image edit returned a file that is not an image.');
        writeFileSync(join(dir, AI_FILE), result.image);
        writeFileSync(join(dir, 'clean-background-response.json'), JSON.stringify(result.response ?? {}, null, 2));
        Object.assign(record.reconstruction, { state: 'done', durationMs: Date.now() - started, ...(result.requestId ? { requestId: result.requestId } : {}) });
        ai = result.image;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Object.assign(record.reconstruction, { state: 'failed', durationMs: Date.now() - started, error: { code: 'BACKGROUND_RECONSTRUCTION_FAILED', message } });
        why = `the OpenAI image edit failed: ${message}`;
      }
    }
    const sourceCanvas = await sharp(source.png).resize(canvas.width, canvas.height, { fit: 'fill' }).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();
    if (ai) { backgroundPng = await blendIntoCanvas(sourceCanvas, ai, { map: alphaM, width: M.width, height: M.height }, canvas); method = 'ai-reconstruction'; }
    else {
      backgroundPng = await localFill(source.png, { map: coreM, width: M.width, height: M.height }, { map: alphaM, width: M.width, height: M.height }, canvas); method = 'local-fill';
      reasons.push(`Fell back to a local fill because ${why}. This is not an AI-reconstructed background.`);
    }
    writeFileSync(join(dir, CLEAN_FILE), backgroundPng);
  }
  // Validation: no extracted product recreated, and nothing left that no layer holds.
  const backgroundA = await rgbOnGrid(backgroundPng, A);
  const recreated = method === 'provider-base' ? [] : objectRetention(backgroundA, originalA, model, major).filter(r => r.retainedPercent >= options.retainedPercent);
  // Seedream's base kept as is with no residual layer added: it differs from residual 1 only inside the extracted layers'
  // (filled) areas, which the check ignores, so residual 1's assessment is this background's. Otherwise it is assessed.
  const unchanged = method === 'provider-base' && !order.some(item => item.pass > 0) && record.assessments[0]?.after === 0;
  const leftover = unchanged ? (({ after, residual, sent, ...assessment }) => { void after; void residual; void sent; return assessment; })(record.assessments[0])
    : assessBackgroundContamination({ rgb: backgroundA, width: A.width, height: A.height, explained: unionOf(order.filter(item => explains(item, A)).map(item => item.shape.alpha), nA) }, options);
  if (recreated.length) reasons.push(`The background still shows ${recreated.map(r => `${r.name ?? r.file} (${r.retainedPercent}% of its distinctive pixels)`).join(', ')}.`);
  if (leftover.contaminated) reasons.push(`Objects no layer holds remain in the background: ${leftover.reasons.join(' ')}`);
  const contaminated = recreated.length > 0 || leftover.contaminated;
  const status: CleanBackgroundStatus = method === 'local-fill' ? 'fallback' : contaminated ? 'contaminated' : method === 'provider-base' ? 'provider-clean' : 'ai-reconstructed';
  const backgroundFile = method === 'provider-base' ? base0.file : CLEAN_FILE;
  const { regions, ...leftoverSummary } = leftover;
  record.background = { status, method, file: backgroundFile, source: source.name, needed, contaminated, reasons, baseRetention, recreated, residual: { ...leftoverSummary, regions: regions.length } };

  // The final stack: the background, then every layer in order; unplaced layers keep their place at the end, hidden.
  const renumber = order.some(item => item.pass > 0);
  const provenance = (item: Item) => {
    const box = item.shape.box, s = 1 / A.scale;
    return { sourcePass: item.pass, sourceImage: item.sourceImage, ...(item.pass > 0 ? { parentResidualId: `residual-pass-${item.pass}` } : {}), providerFile: item.layer.file, ...(item.requestId ? { providerRequestId: item.requestId } : {}),
      providerZIndex: item.providerZ, role: item.role, ...(box ? { bbox: [Math.round(box.x0 * s), Math.round(box.y0 * s), Math.round(box.x1 * s), Math.round(box.y1 * s)] as [number, number, number, number] } : {}),
      mask: item.layer.file, areaPercent: round(100 * item.shape.count / nA, 2) };
  };
  const backgroundLayer: LayerInfo = { ...base0, ...(method !== 'provider-base' ? { file: CLEAN_FILE, rawFile: base0.file, opaquePercent: 100, pixelWidth: canvas.width, pixelHeight: canvas.height } : {}),
    cleanBackground: { status, method }, provenance: { sourcePass: 0, sourceImage: run.input.file, providerFile: base0.file, ...(run.seedream.requestId ? { providerRequestId: run.seedream.requestId } : {}), providerZIndex: base0.zIndex, role: 'background', mask: backgroundFile } };
  const stacked = order.map((item, i) => ({ ...item.layer, ...(renumber ? { zIndex: i + 1 } : {}), provenance: provenance(item) }));
  if (renumber) backgroundLayer.zIndex = 0;
  const layers: LayerInfo[] = [backgroundLayer, ...stacked, ...unplaced.map((l, i) => ({ ...l, ...(renumber ? { zIndex: order.length + 1 + i } : {}), provenance: { sourcePass: 0, sourceImage: run.input.file, providerFile: l.file, providerZIndex: l.zIndex, role: 'unplaced', mask: l.file } }))]
    .map((l, index) => ({ ...l, index }));
  record.finalLayers = layers.length;

  // Fidelity of the reconstruction, before (Seedream's base + its layers) and after the refinement, against the original.
  const placedOf = (list: { png: Buffer; placement: Placement }[]) => compositeOnGrid(list, A).then(flattenRgba);
  const before = fidelity(originalA, await placedOf([{ png: base0Png, placement: base0.placement }, ...items.filter(item => item.pass === 0).sort((a, b) => a.providerZ - b.providerZ).map(item => ({ png: item.png, placement: item.layer.placement }))]));
  const after = fidelity(originalA, await placedOf([{ png: backgroundPng, placement: base0.placement }, ...order.map(item => ({ png: item.png, placement: item.layer.placement }))]));
  record.fidelity = { before, after };

  // Outputs: layers.json (same shape, additive fields), reconstructed.png, contact-sheet.png in debugging order, debug JSON.
  const pngs = new Map<string, Buffer>([[backgroundLayer.file, backgroundPng], ...items.map(item => [item.layer.file, item.png] as const)]);
  const pngOf = (l: LayerInfo) => pngs.get(l.file) ?? read(l.file);
  const warnings = [...new Set([...ctx.renderWarnings, ...record.warnings])];
  await composeLayers(join(dir, 'reconstructed.png'), canvas, await Promise.all(layers.map(async l => ({ png: pngOf(l), zIndex: l.zIndex, placement: l.placement }))));
  const summary = { passesExecuted: record.passesExecuted, residualPasses, stopReason: record.stopReason, finalLayers: layers.length, background: { status, method }, calls: { ...calls } };
  writeFileSync(join(dir, 'layers.json'), JSON.stringify({ canvas, warnings, layers, refinement: summary }, null, 2));
  const finalIndex = new Map(layers.map((l, i) => [l.file, i]));
  await writeContactSheet(join(dir, 'contact-sheet.png'), [
    { png: source.png, title: 'Original', sub: `${source.name === 'original' ? run.input.file : 'provider base (aspect differs)'} · ${canvas.width}×${canvas.height}` },
    { png: backgroundPng, title: `Background: ${status}`, sub: `${method}${contaminated ? ' · still contaminated' : ''}` },
    ...items.filter(item => item.pass === 0).sort((a, b) => a.providerZ - b.providerZ).map(item => ({ png: item.png, title: `P0 · ${item.layer.name ?? 'layer'}`, sub: `z${layers[finalIndex.get(item.layer.file)!]?.zIndex} · ${item.kind === 'background' ? 'background' : item.role} · ${round(100 * item.shape.count / nA, 1)}%` })),
    ...passTiles,
    { png: read(MASK_FILE), title: 'Foreground union mask', sub: `${record.mask.coveragePercent}% removed · grow ${record.mask.dilatePx}px · feather ${record.mask.featherPx}px` },
    { png: read('reconstructed.png'), title: 'Reconstruction', sub: `mean Δ ${after.meanAbsDiff} (before ${before.meanAbsDiff}) · changed ${after.changedPercent}%` },
  ]);
  record.state = 'done';
  writeFileSync(join(dir, DEBUG_FILE), JSON.stringify({ runId: run.id, generatedAt: new Date().toISOString(), calls: { ...calls }, callSummary: callLines(calls), summary,
    options, passes: record.passes, assessments: record.assessments, stopReason: record.stopReason, stopDetail: record.stopDetail, mask: record.mask, background: record.background, reconstruction: record.reconstruction,
    fidelity: record.fidelity, warnings: record.warnings,
    layers: layers.map(l => ({ file: l.file, name: l.name, zIndex: l.zIndex, placement: l.placement.kind, provenance: l.provenance, cleanBackground: l.cleanBackground })) }, null, 2));
  const out = [`RECURSIVE_DECOMPOSITION: ${record.passesExecuted} pass(es) (1 initial + ${residualPasses} residual); stopped: ${record.stopReason}. ${layers.length} layers. Background: ${status} (${method}).`, ...record.warnings];
  if (status === 'fallback' || status === 'contaminated') out.push(`BACKGROUND_${status.toUpperCase()}: ${reasons.join(' ')}`);
  return { layers, warnings: out };
}
