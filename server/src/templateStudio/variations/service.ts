/**
 * Style variations of protected templates (shared styleVariations.ts), on Template Studio's own stack: its image provider,
 * per-call budget holds and usage ledger (ai/calls.ts imageCall), its idempotent job queue and its asset store.
 *
 * Paid: only an AI variation's single image request, sent by the worker after a request that named the exact estimate.
 * Everything else is local and free: the estimate, local restyles and reuses, the artwork's text check, every layout and
 * typography change, reviews, duplicates. A failed or refused request leaves the variation failed; it never falls back to
 * a copy of the reference.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  analysisReviewed, blockingIssues, buildVariantLayout, contrastRatio, customPreset, CUSTOM_PRESET_ID, isCatalogFont, presetById, regionsKey, retypeLayout, SOURCE_PROVENANCE, validateLayout, variationRequestProblems,
  type CustomTypography, type ProtectedTemplate, type SourceBox, type StudioMoney, type StyleVariationRequest, type StyleVariationView, type StylePreset, type TextAnalysis,
  type TypographyMode, type VariantLayout, type VariationEstimate, type VariationEvent, type VariationSlotRequest,
} from '@frameflow/shared';
import type { ProtectedStore } from '../../decomposition/protectedTemplates/store.js';
import { decodeRgba, type Rgba } from '../../decomposition/protectedTemplates/pixels.js';
import { medianColour } from '../../textRecognition/measure.js';
import type { ServerEnv } from '../config.js';
import { ingestAsset } from '../assets/ingest.js';
import { budgetStatus, jobCapMicroUsd } from '../costs/budget.js';
import { estimateImageCall } from '../costs/estimate.js';
import { describeMoney } from '../costs/profiles.js';
import { RATE_CARD_VERSION } from '../costs/rateCard.js';
import { enqueueJob, isTerminal } from '../jobs/queue.js';
import { newId, now, type StudioStore, type StyleVariationRecord, type VariationBatchRecord } from '../store.js';
import { readStorageFile } from '../storage.js';
import { compileVariationPrompt, providerSizeFor, renderVariationGuide, reservedAreas, STYLE_VARIATION_PROMPT_VERSION } from './prompt.js';

export class VariationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) { super(message); this.name = 'VariationError'; }
}
const fail = (status: number, code: string, message: string, details?: Record<string, unknown>): never => { throw new VariationError(status, code, message, details); };
const sha = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');

// ---------------------------------------------------------------------------------------------------------------------
// The template a variation is made from
// ---------------------------------------------------------------------------------------------------------------------
export interface VariationSourceTemplate { template: ProtectedTemplate; analysis: TextAnalysis; base: Buffer; canvas: { width: number; height: number } }
/** A protected template ready for variations: an approved text-free base for its confirmed regions and reviewed words. */
export function variationTemplate(store: ProtectedStore, templateId: string): VariationSourceTemplate {
  const t = store.get(templateId) ?? fail(404, 'not_found', 'Protected template not found.');
  const key = regionsKey(t.elements);
  if (!t.base || t.base.regionsKey !== key || t.regionsConfirmed?.regionsKey !== key || !t.base.approval) fail(422, 'base_not_ready', 'The template needs an approved text-free base for its confirmed regions (step 2) before style variations can be made.');
  const analysis = t.textAnalysis ?? fail(422, 'no_text_analysis', 'Find and review the words and logos of the template first.');
  if (analysis.basis.regionsKey !== key || analysis.basis.sourceSha256 !== t.source.sha256) fail(422, 'text_analysis_stale', 'The words and logos were found for other regions. Find them again.');
  if (!analysisReviewed(analysis)) fail(422, 'review_required', 'Review every word and logo slot (approve or reject it) before making variations.');
  const base = store.read(t.id, t.base!.file);
  if (sha(base) !== t.base!.sha256) fail(409, 'base_changed', 'The stored base no longer matches its record.');
  return { template: t, analysis, base, canvas: { width: t.source.width, height: t.source.height } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Plans and estimates
// ---------------------------------------------------------------------------------------------------------------------
export interface SlotPlan {
  index: number; slot: VariationSlotRequest; preset: StylePreset; source: VariationSlotRequest['source'];
  prompt: string | null; cacheKey: string | null; cachedFrom: string | null; estimateMicroUsd: number; assumptions: string[];
}
const presetFor = (slot: VariationSlotRequest): StylePreset => slot.presetId === CUSTOM_PRESET_ID ? customPreset(slot.customName ?? 'Custom direction', slot.customDirection ?? '') : presetById(slot.presetId) ?? fail(400, 'invalid_request', 'Unknown style.');
/** What each slot would do and cost. Identical earlier AI artwork (same base, guide, prompt, model, size, quality) is reused. */
export async function planVariations(db: StudioStore, env: ServerEnv, src: VariationSourceTemplate, request: StyleVariationRequest): Promise<{ plans: SlotPlan[]; guide: Buffer; providerSize: string }> {
  const problems = variationRequestProblems(request);
  if (problems.length) fail(400, 'invalid_request', problems.join(' '), { problems });
  const guide = await renderVariationGuide(src.canvas, reservedAreas(src.analysis)), guideSha = sha(guide), { size } = providerSizeFor(src.canvas);
  const takes = new Map<string, number>(), seen = new Map<string, number>();
  for (const s of request.slots) if (s.source === 'ai') takes.set(`${s.presetId}:${s.customDirection ?? ''}`, (takes.get(`${s.presetId}:${s.customDirection ?? ''}`) ?? 0) + 1);
  const plans = request.slots.map((slot, index): SlotPlan => {
    const preset = presetFor(slot);
    if (slot.source !== 'ai') return { index, slot, preset, source: slot.source, prompt: null, cacheKey: null, cachedFrom: null, estimateMicroUsd: 0, assumptions: [slot.source === 'restyle' ? 'Local colour treatment of the approved base: no AI call.' : 'The approved base unchanged: no AI call.'] };
    const k = `${slot.presetId}:${slot.customDirection ?? ''}`, take = (seen.get(k) ?? 0) + 1;
    seen.set(k, take);
    const prompt = compileVariationPrompt({ preset, customInstructions: request.customInstructions ?? null, take, takes: takes.get(k) ?? 1 });
    const cacheKey = sha(JSON.stringify({ v: STYLE_VARIATION_PROMPT_VERSION, base: src.template.base!.sha256, guide: guideSha, prompt, model: env.OPENAI_IMAGE_MODEL, size, quality: request.quality }));
    const cached = db.styleVariations.filter(v => v.generation?.cacheKey === cacheKey && !!v.artworkAssetId && !!db.assets.get(v.artworkAssetId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (cached) return { index, slot, preset, source: 'ai', prompt, cacheKey, cachedFrom: cached.id, estimateMicroUsd: 0, assumptions: [`Identical artwork already generated (variation ${cached.id}): reused, no new call.`] };
    const e = estimateImageCall({ model: env.OPENAI_IMAGE_MODEL, quality: request.quality, size, promptChars: prompt.length, referenceImages: 2 });
    return { index, slot, preset, source: 'ai', prompt, cacheKey, cachedFrom: null, estimateMicroUsd: e.microUsd, assumptions: e.assumptions };
  });
  return { plans, guide, providerSize: size };
}
export function estimateView(db: StudioStore, env: ServerEnv, plans: SlotPlan[], providerSize: string, quality: StyleVariationRequest['quality']): VariationEstimate {
  const money = (m: number) => describeMoney(m, env), daily = budgetStatus(db, env), cap = jobCapMicroUsd('generate_style_variation', env);
  const paid = plans.filter(p => p.source === 'ai' && !p.cachedFrom), cached = plans.filter(p => p.cachedFrom), local = plans.filter(p => p.source !== 'ai');
  const total = paid.reduce((n, p) => n + p.estimateMicroUsd, 0), largest = Math.max(0, ...paid.map(p => p.estimateMicroUsd));
  const lines: VariationEstimate['lines'] = [
    { stage: 'Word and logo analysis', model: 'tesseract.js (local)', count: 1, cost: money(0), cached: true, note: 'Done when the template was analysed, on this machine. Reused; no call.', assumptions: [] },
    { stage: 'Seedream decomposition', model: 'not used', count: 0, cost: money(0), cached: true, note: 'Not needed: variations reuse the approved text-free base and the template’s own words and logos. Typography and logo changes never decompose again.', assumptions: [] },
  ];
  if (paid.length) lines.push({ stage: `Artwork generation (${quality}, ${providerSize})`, model: env.OPENAI_IMAGE_MODEL, count: paid.length, cost: money(total), cached: false, note: `${paid.length} image request${paid.length === 1 ? '' : 's'}, one per variation, each sent once and never retried automatically.`, assumptions: paid[0].assumptions });
  if (cached.length) lines.push({ stage: 'Artwork reused from identical earlier variations', model: env.OPENAI_IMAGE_MODEL, count: cached.length, cost: money(0), cached: true, note: cached.map(p => `#${p.index + 1}: ${p.assumptions[0]}`).join(' '), assumptions: [] });
  if (local.length) lines.push({ stage: 'Local restyles and reuses', model: 'sharp (local)', count: local.length, cost: money(0), cached: false, note: 'Computed on this machine from the approved base. No AI call.', assumptions: [] });
  lines.push({ stage: 'Artwork text check and layout', model: 'tesseract.js (local)', count: plans.length, cost: money(0), cached: false, note: 'Local: reads the new artwork for drawn text, places the words and logos, checks collisions, margins, overflow and contrast.', assumptions: [] });
  const blockedReason = largest > cap ? `One variation could cost up to ${money(largest).usd}, above the per-job limit of ${money(cap).usd} (STUDIO_MAX_JOB_BUDGET_USD).` : total > daily.remaining ? `The request could cost up to ${money(total).usd}; ${money(daily.remaining).usd} of today's Studio budget is left (STUDIO_DAILY_BUDGET_USD).` : null;
  return {
    lines, total: money(total), perVariationCap: money(cap), withinCap: largest <= cap,
    daily: { cap: money(daily.cap), used: money(daily.used), held: money(daily.held), remaining: money(daily.remaining), fits: total <= daily.remaining, resets: daily.resets },
    paidRequests: paid.length, quality, providerSize, model: env.OPENAI_IMAGE_MODEL, fx: env.fx, rateCardVersion: RATE_CARD_VERSION, confirmMicroUsd: total, blockedReason,
    note: 'Upper-bound planning estimate from published prices plus the stated assumptions; each request is also checked against the job and daily limits just before it is sent. Not a provider invoice.',
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Layout, artwork and checks
// ---------------------------------------------------------------------------------------------------------------------
/** The artwork's colour behind each visible word, at the template canvas. */
export function wordBackgrounds(artwork: Rgba, layout: VariantLayout): Map<string, string> {
  return new Map(layout.words.filter(w => !w.hidden).map(w => [w.wordId, medianColour(artwork, { x: w.box.x, y: w.box.y, width: w.box.width, height: w.box.height })]));
}
/**
 * Suggested typography keeps the template's colours unless one would be hard to read on the new artwork: then the word
 * takes the most legible of the preset's palette, white and near-black. Match and custom keep their colours.
 */
export function legibleColours(layout: VariantLayout, backgrounds: Map<string, string>, preset: Pick<StylePreset, 'palette'>): VariantLayout {
  if (layout.typographyMode !== 'suggested') return layout;
  return { ...layout, words: layout.words.map(w => {
    const bg = backgrounds.get(w.wordId);
    if (!bg) return w;
    const large = w.style.fontSize >= 24, need = large ? 3 : 4.5;
    if (contrastRatio(w.style.color, bg) >= need) return w;
    const best = [...preset.palette, '#ffffff', '#111111'].sort((a, b) => contrastRatio(b, bg) - contrastRatio(a, bg))[0];
    return { ...w, style: { ...w.style, color: best }, changed: { ...w.changed, style: true } };
  }) };
}
export function validate(record: Pick<StyleVariationRecord, 'layout' | 'confirmedProtectedEdits' | 'artworkCheck'>, analysis: TextAnalysis, backgrounds?: Map<string, string>) {
  return validateLayout(record.layout, { analysis, background: backgrounds, artworkText: record.artworkCheck ? record.artworkCheck.status === 'not_run' ? null : record.artworkCheck.words : null, confirmedProtectedEdits: record.confirmedProtectedEdits });
}
/** The local restyle of the base for a preset: a fixed colour treatment, the same pixels for the same inputs. */
export async function restyleBase(base: Buffer, preset: StylePreset, canvas: { width: number; height: number }): Promise<Buffer> {
  const r = preset.restyle;
  let image = sharp(base).rotate().resize(canvas.width, canvas.height, { fit: 'fill' }).removeAlpha().modulate({ hue: Math.round(r.hue), saturation: r.saturation, brightness: r.brightness });
  if (r.tint && r.tintStrength) {
    const [red, green, blue] = [1, 3, 5].map(i => parseInt(r.tint!.slice(i, i + 2), 16));
    image = sharp(await image.png().toBuffer()).composite([{ input: { create: { width: canvas.width, height: canvas.height, channels: 4, background: { r: red, g: green, b: blue, alpha: r.tintStrength } } }, blend: 'over' }]);
  }
  return image.png({ compressionLevel: 9 }).toBuffer();
}
/** The variation's layout and checks on its artwork (local). */
export async function layoutOnArtwork(db: StudioStore, storageDir: string, record: StyleVariationRecord, analysis: TextAnalysis): Promise<Pick<StyleVariationRecord, 'layout' | 'validation'>> {
  const asset = db.assets.require(record.artworkAssetId, 'Artwork');
  const artwork = await decodeRgba(await readStorageFile(storageDir, asset.normalisedPath), record.layout.canvas);
  let layout = buildVariantLayout(analysis, record.layout.canvas, record.typographyMode, record.preset, record.customTypography ?? undefined);
  const backgrounds = wordBackgrounds(artwork, layout);
  layout = legibleColours(layout, backgrounds, record.preset);
  return { layout, validation: validate({ ...record, layout }, analysis, wordBackgrounds(artwork, layout)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------------------------------------------------
export interface CreateBatchInput { idempotencyKey: string; request: StyleVariationRequest; confirm?: { paid?: boolean; estimateMicroUsd?: number } }
// Planning and asset ingestion await I/O before the batch is inserted. Serialize submissions with the same key so a
// double-click cannot pass the initial lookup twice and enqueue two paid batches. Failed submissions release the key.
const pendingBatches = new WeakMap<StudioStore, Map<string, Promise<unknown>>>();
export async function createBatch(db: StudioStore, env: ServerEnv, storageDir: string, src: VariationSourceTemplate, input: CreateBatchInput): Promise<{ batch: VariationBatchRecord; created: boolean }> {
  let pending = pendingBatches.get(db);
  if (!pending) { pending = new Map(); pendingBatches.set(db, pending); }
  const previous = pending.get(input.idempotencyKey) ?? Promise.resolve();
  const work = previous.catch(() => undefined).then(() => createBatchOnce(db, env, storageDir, src, input));
  pending.set(input.idempotencyKey, work);
  try { return await work; }
  finally { if (pending.get(input.idempotencyKey) === work) pending.delete(input.idempotencyKey); }
}

async function createBatchOnce(db: StudioStore, env: ServerEnv, storageDir: string, src: VariationSourceTemplate, input: CreateBatchInput): Promise<{ batch: VariationBatchRecord; created: boolean }> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey)) fail(400, 'invalid_request', 'An idempotency key (8–128 letters, digits, - or _) is required.');
  const prior = db.variationBatches.find(b => b.idempotencyKey === input.idempotencyKey);
  if (prior) { if (prior.templateId !== src.template.id) fail(409, 'idempotency_conflict', 'That idempotency key was used for another template.'); return { batch: prior, created: false }; }
  const { plans, guide, providerSize } = await planVariations(db, env, src, input.request);
  const estimate = estimateView(db, env, plans, providerSize, input.request.quality);
  if (estimate.blockedReason) fail(422, 'budget_exceeded', `${estimate.blockedReason} Nothing was started.`, { estimate });
  if (estimate.paidRequests > 0) {
    if (input.confirm?.paid !== true) fail(400, 'confirmation_required', `This request sends ${estimate.paidRequests} paid image request(s), up to ${estimate.total.usd}. Confirm it explicitly. Nothing was started.`, { estimate });
    if (input.confirm?.estimateMicroUsd !== estimate.confirmMicroUsd) fail(409, 'estimate_changed', `The estimate is now ${estimate.total.usd} (you confirmed ${describeMoney(input.confirm?.estimateMicroUsd ?? 0, env).usd}). Review and confirm it again. Nothing was started.`, { estimate });
  }
  const at = now(), batchId = newId('vbat'), t = src.template;
  const { asset: guideAsset } = await ingestAsset({ buffer: guide, role: 'layout_guide', filename: `variation-guide-${t.id}.png`, label: `Variation guide · ${t.name}` }, { db, storageDir });
  const records: StyleVariationRecord[] = plans.map(p => {
    const layout = buildVariantLayout(src.analysis, src.canvas, input.request.typographyMode, p.preset, input.request.customTypography);
    const cached = p.cachedFrom ? db.styleVariations.require(p.cachedFrom, 'Variation') : undefined;
    return {
      schemaVersion: 1, id: newId('var'), batchId, index: p.index, templateId: t.id, templateName: t.name,
      preset: p.preset, customInstructions: p.source === 'ai' ? input.request.customInstructions?.trim() || null : null, source: p.source, provenance: SOURCE_PROVENANCE[p.source],
      status: 'queued', error: null, artworkAssetId: cached?.artworkAssetId ?? null, rawArtworkAssetId: cached?.rawArtworkAssetId ?? null, guideAssetId: p.source === 'ai' ? guideAsset.id : null,
      generation: p.source === 'ai' ? { model: env.OPENAI_IMAGE_MODEL, providerSize, quality: input.request.quality, promptVersion: STYLE_VARIATION_PROMPT_VERSION, prompt: p.prompt!, cacheKey: p.cacheKey!, requestId: cached?.generation?.requestId ?? null, cachedFrom: p.cachedFrom } : null,
      artworkCheck: cached?.artworkCheck ?? null, layout, validation: validateLayout(layout, { analysis: src.analysis }),
      typographyMode: input.request.typographyMode, customTypography: input.request.customTypography ?? null, confirmedProtectedEdits: [],
      review: { status: 'unreviewed', history: [{ at, action: 'created', detail: `${p.preset.name} · ${p.source === 'ai' ? p.cachedFrom ? `AI artwork reused from ${p.cachedFrom}` : `AI artwork (${env.OPENAI_IMAGE_MODEL}, ${input.request.quality}, ${providerSize})` : p.source === 'restyle' ? 'local restyle' : 'local reuse'}` }] },
      estimateMicroUsd: p.estimateMicroUsd, jobId: null,
      parent: { templateId: t.id, baseSha256: t.base!.sha256, analysisRevision: src.analysis.revision, elementsRevision: t.elementsRevision, variationId: null }, children: [],
      createdAt: at, updatedAt: at,
    };
  });
  const batch = db.variationBatches.insert({ id: batchId, templateId: t.id, idempotencyKey: input.idempotencyKey, request: input.request, estimateMicroUsd: estimate.confirmMicroUsd, confirmedMicroUsd: estimate.paidRequests ? input.confirm!.estimateMicroUsd! : null, variationIds: records.map(r => r.id), createdAt: at });
  for (const r of records) db.styleVariations.insert(r);
  // AI slots: one job each, idempotent by the variation. Cached and local ones are finished here (local, no call).
  for (const r of records) {
    if (r.source === 'ai' && !r.generation!.cachedFrom) {
      const { job } = enqueueJob(db, { kind: 'generate_style_variation', idempotencyKey: `stylevar:${r.id}`, input: { variationId: r.id } });
      db.styleVariations.update(r.id, { jobId: job.id });
      continue;
    }
    try {
      if (r.source !== 'ai') {
        const bytes = r.source === 'restyle' ? await restyleBase(src.base, r.preset, src.canvas) : await sharp(src.base).rotate().resize(src.canvas.width, src.canvas.height, { fit: 'fill' }).png().toBuffer();
        const { asset } = await ingestAsset({ buffer: bytes, role: 'generated_scene', filename: `variation-${r.id}.png`, label: `${r.preset.name} · ${r.source === 'restyle' ? 'local restyle' : 'local reuse'}` }, { db, storageDir });
        db.styleVariations.update(r.id, { artworkAssetId: asset.id, artworkCheck: { status: 'not_run', words: [], note: 'Not needed: the artwork is the approved text-free base (or a colour treatment of it), not new pixels.' } });
      }
      const fresh = db.styleVariations.require(r.id, 'Variation'), placed = await layoutOnArtwork(db, storageDir, fresh, src.analysis);
      db.styleVariations.update(r.id, (x) => ({ ...placed, status: blockingIssues(placed.validation).length ? 'needs_review' : 'ready', updatedAt: now(),
        review: { ...x.review, history: [...x.review.history, { at: now(), action: x.generation?.cachedFrom ? 'reused-cache' : 'checked', detail: `${placed.validation.issues.length} layout issue(s).` }] } }));
    } catch (error) {
      db.styleVariations.update(r.id, { status: 'failed', error: { code: 'local_failed', message: error instanceof Error ? error.message : String(error) }, updatedAt: now() });
    }
  }
  return { batch, created: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------------------------
export function toVariationView(db: StudioStore, env: ServerEnv, r: StyleVariationRecord): StyleVariationView {
  const job = r.jobId ? db.jobs.get(r.jobId) : undefined;
  let status = r.status, error = r.error;
  if (job && job.state === 'failed') { status = 'failed'; error = job.error ? { code: job.error.code, message: job.error.message, requestId: job.error.requestId ?? null } : { code: 'failed', message: 'The variation failed.' }; }
  else if (job && job.state === 'cancelled') status = 'cancelled';
  else if (job && !isTerminal(job.state)) status = !job.currentStage ? 'queued' : ['check_artwork', 'layout_variation'].includes(job.currentStage) ? 'checking' : 'generating';
  const usage = job ? db.usage.filter(u => u.jobId === job.id) : [];
  const actual = usage.length ? usage.reduce((n, u) => n + (u.usageDerivedMicroUsd ?? u.estimatedMicroUsd ?? 0), 0) : null;
  const asset = r.artworkAssetId ? db.assets.get(r.artworkAssetId) : undefined;
  const money = (m: number): StudioMoney => describeMoney(m, env);
  return {
    schemaVersion: 1, id: r.id, batchId: r.batchId, index: r.index, templateId: r.templateId, templateName: r.templateName, createdAt: r.createdAt, updatedAt: r.updatedAt,
    preset: r.preset, customInstructions: r.customInstructions, source: r.source, provenance: r.provenance, status, error,
    artwork: asset ? { url: `/api/template-studio/assets/${asset.id}`, width: asset.width, height: asset.height, sha256: asset.sha256, model: r.generation?.model ?? null, providerSize: r.generation?.providerSize ?? null,
      quality: r.generation?.quality ?? null, promptVersion: r.generation?.promptVersion ?? null, requestId: r.generation?.requestId ?? null, cachedFrom: r.generation?.cachedFrom ?? null } : null,
    artworkCheck: r.artworkCheck, layout: r.layout, validation: r.validation, customTypography: r.customTypography, confirmedProtectedEdits: r.confirmedProtectedEdits,
    review: r.review, cost: { estimate: money(r.estimateMicroUsd), actual: actual === null ? null : money(actual), unknown: usage.some(u => u.costUnknown) }, jobId: r.jobId, parent: r.parent, children: r.children,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Changes (all local, none paid)
// ---------------------------------------------------------------------------------------------------------------------
const finite = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
function cleanBox(b: unknown): SourceBox {
  const x = b as Partial<SourceBox>;
  if (!x || ![x.x, x.y].every(v => finite(v, -1e5, 1e5)) || !finite(x.width, 1, 1e5) || !finite(x.height, 1, 1e5) || !finite(x.rotation, -360, 360)) fail(400, 'invalid_request', 'A box is not valid.');
  return { x: x.x!, y: x.y!, width: x.width!, height: x.height!, rotation: x.rotation! };
}
export interface LayoutPatch {
  typographyMode?: TypographyMode; customTypography?: CustomTypography | null;
  words?: { wordId: string; box?: SourceBox; text?: string; hidden?: boolean; style?: Partial<VariantLayout['words'][number]['style']> }[];
  logos?: { slotId: string; box?: SourceBox; hidden?: boolean }[];
  confirmProtectedEdits?: string[];
}
/**
 * A layout or typography change: new variant boxes and styles, never new artwork. The template's original boxes are not
 * touched (they live in the protected template; this changes the variation only).
 */
export async function changeLayout(db: StudioStore, storageDir: string, r: StyleVariationRecord, analysis: TextAnalysis, patch: LayoutPatch): Promise<StyleVariationRecord> {
  let layout = r.layout;
  const events: VariationEvent[] = [], at = now();
  let customTypography = r.customTypography, typographyMode = r.typographyMode;
  if (patch.typographyMode && (patch.typographyMode !== r.typographyMode || patch.customTypography !== undefined)) {
    if (!['match', 'suggested', 'custom'].includes(patch.typographyMode)) fail(400, 'invalid_request', 'Unknown typography mode.');
    if (patch.typographyMode === 'custom') {
      const c = patch.customTypography ?? r.customTypography;
      if (!c || !isCatalogFont(c.headline) || !isCatalogFont(c.body) || (c.accent !== undefined && !isCatalogFont(c.accent)) || ![400, 600, 700].includes(c.headlineWeight) || ![400, 600, 700].includes(c.bodyWeight) || (c.color !== undefined && !/^#[\da-f]{6}$/i.test(c.color)))
        fail(400, 'invalid_request', 'Custom typography needs fonts from the licensed catalogue and weights of 400, 600 or 700.');
      customTypography = c;
    }
    typographyMode = patch.typographyMode;
    layout = retypeLayout(layout, analysis, typographyMode, r.preset, customTypography ?? undefined);
    events.push({ at, action: 'typography-changed', detail: `${typographyMode}${typographyMode === 'custom' && customTypography ? ` (${customTypography.headline} / ${customTypography.body})` : ''}; no new artwork, no AI call.` });
  }
  if (patch.words?.length || patch.logos?.length) {
    const words = new Map(layout.words.map(w => [w.wordId, { ...w }])), logos = new Map(layout.logos.map(l => [l.slotId, { ...l }]));
    const original = new Map(analysis.words.map(w => [w.id, w]));
    for (const p of patch.words ?? []) {
      const w = words.get(p.wordId) ?? fail(404, 'not_found', `Word ${p.wordId} is not in this variation.`);
      if (p.box) { w.box = cleanBox(p.box); w.changed = { ...w.changed, box: true }; }
      if (p.hidden !== undefined) w.hidden = p.hidden === true;
      if (p.text !== undefined) {
        if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > 80) fail(400, 'invalid_request', 'A word is 1–80 characters.');
        w.text = p.text.trim(); w.changed = { ...w.changed, text: w.text !== original.get(w.wordId)?.text };
      }
      if (p.style) {
        const s = { ...w.style, ...p.style };
        if (!isCatalogFont(s.fontFamily) || !finite(s.fontSize, 1, 4096) || ![400, 600, 700].includes(s.fontWeight) || !['normal', 'italic'].includes(s.fontStyle) || !/^#[\da-f]{6}$/i.test(s.color) || !finite(s.opacity, 0, 1) || !finite(s.letterSpacing, -200, 200))
          fail(400, 'invalid_request', 'A word style is not valid (fonts must come from the licensed catalogue).');
        w.style = s; w.changed = { ...w.changed, style: true };
      }
      words.set(w.wordId, w);
    }
    for (const p of patch.logos ?? []) {
      const l = logos.get(p.slotId) ?? fail(404, 'not_found', `Logo slot ${p.slotId} is not in this variation.`);
      if (p.box) { l.box = cleanBox(p.box); l.changed = { box: true }; }
      if (p.hidden !== undefined) l.hidden = p.hidden === true;
      logos.set(l.slotId, l);
    }
    layout = { ...layout, words: layout.words.map(w => words.get(w.wordId)!), logos: layout.logos.map(l => logos.get(l.slotId)!) };
    events.push({ at, action: 'layout-changed', detail: `${(patch.words ?? []).length} word(s), ${(patch.logos ?? []).length} logo(s) changed; no new artwork, no AI call.` });
  }
  let confirmed = r.confirmedProtectedEdits;
  if (patch.confirmProtectedEdits?.length) {
    const ok = patch.confirmProtectedEdits.filter(id => layout.words.some(w => w.wordId === id && w.protected));
    confirmed = [...new Set([...confirmed, ...ok])];
    if (ok.length) events.push({ at, action: 'protected-text-confirmed', detail: ok.map(id => { const w = layout.words.find(x => x.wordId === id)!; return `“${analysis.words.find(o => o.id === id)?.text}” → “${w.text}”`; }).join(', ') });
  }
  let backgrounds: Map<string, string> | undefined;
  if (r.artworkAssetId) {
    const asset = db.assets.get(r.artworkAssetId);
    if (asset) backgrounds = wordBackgrounds(await decodeRgba(await readStorageFile(storageDir, asset.normalisedPath), layout.canvas), layout);
  }
  const validation = validate({ layout, confirmedProtectedEdits: confirmed, artworkCheck: r.artworkCheck }, analysis, backgrounds);
  const done = ['ready', 'needs_review'].includes(r.status);
  return db.styleVariations.update(r.id, x => ({ layout, validation, typographyMode, customTypography, confirmedProtectedEdits: confirmed, updatedAt: at,
    ...(done ? { status: blockingIssues(validation).length ? 'needs_review' as const : 'ready' as const } : {}),
    review: { status: x.review.status === 'saved' ? 'selected' : x.review.status, history: [...x.review.history, ...events] } }));
}
export function reviewVariation(db: StudioStore, r: StyleVariationRecord, action: 'select' | 'reject' | 'save' | 'reopen'): StyleVariationRecord {
  const at = now();
  if (action === 'save') {
    if (!r.artworkAssetId || !['ready', 'needs_review'].includes(r.status)) fail(422, 'not_ready', 'Only a finished variation can be saved.');
    const blocking = blockingIssues(r.validation);
    if (blocking.length) fail(422, 'layout_invalid', `Fix these first: ${blocking.map(i => i.message).join(' ')}`, { issues: blocking });
  }
  const status = action === 'select' ? 'selected' : action === 'reject' ? 'rejected' : action === 'save' ? 'saved' : 'unreviewed';
  const event: VariationEvent = { at, action: action === 'select' ? 'selected' : action === 'reject' ? 'rejected' : action === 'save' ? 'saved' : 'reopened' };
  return db.styleVariations.update(r.id, x => ({ updatedAt: at, review: { status, history: [...x.review.history, event] } }));
}
/** A free copy of a variation (same artwork, its own layout from now on): the parent lists it as a child. */
export function duplicateVariation(db: StudioStore, r: StyleVariationRecord): StyleVariationRecord {
  if (!r.artworkAssetId) fail(422, 'not_ready', 'Only a variation with artwork can be duplicated.');
  const at = now(), id = newId('var');
  const copy = db.styleVariations.insert({ ...structuredClone(r), id, jobId: null, estimateMicroUsd: 0, createdAt: at, updatedAt: at,
    parent: { ...r.parent, variationId: r.id }, children: [], review: { status: 'unreviewed', history: [{ at, action: 'duplicated', detail: `Copy of ${r.id}; same artwork, no new call.` }] } });
  db.styleVariations.update(r.id, x => ({ children: [...x.children, id], updatedAt: at }));
  return copy;
}
export const MAX_VARIATIONS_LISTED = 200;
