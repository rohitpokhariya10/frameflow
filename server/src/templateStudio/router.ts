/**
 * HTTP surface of Template Studio, mounted at /api/template-studio beside the OpenAI + Seedream experiment and guarded the
 * same way (experimentAccess): it spends paid API credit and has no login. The routes follow the Generator's API
 * (templates, assets, brand kits, campaigns, jobs, posters, costs, setup). Jobs run on the in-process worker, one at a time.
 *
 * Every paid call starts from an explicit POST carrying an idempotency key: a double click or a retried request returns the
 * same job, and nothing paid is ever started by a read, a refresh or a restart.
 */
import express, { type Request, type Router } from 'express';
import busboy from 'busboy';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  DEFAULT_FIDELITY_MODE, DEFAULT_STUDIO_FORMAT, FIDELITY_MODES, STUDIO_COPY_FIELDS, STUDIO_CREATIVE_DIRECTIONS, STUDIO_FORMATS, STUDIO_IMAGE_QUALITIES,
  STUDIO_MAX_PRODUCTS, STUDIO_MAX_REFERENCES, STUDIO_OCCASION_GROUPS, type StudioEstimate, type StudioEstimateLine,
  DEFAULT_PRESET_IDS, PROVENANCE_DETAILS, PROVENANCE_LABELS, STYLE_PRESETS, TYPOGRAPHY_MODE_LABELS, VARIATION_LIMITS, validProtectedTemplateId, type StyleVariationRequest,
} from '@frameflow/shared';
import { DEFAULT_PROTECTED_DIR, fileProtectedStore } from '../decomposition/protectedTemplates/store.js';
import { localRecognizer, type WordRecognizer } from '../textRecognition/recognizer.js';
import { changeLayout, createBatch, duplicateVariation, estimateView, MAX_VARIATIONS_LISTED, planVariations, reviewVariation, toVariationView, VariationError, variationTemplate, type LayoutPatch } from './variations/service.js';
import { experimentAccess, type ExperimentAccess } from '../decomposition/layerizeRouter.js';
import { DEFAULT_RUNS_DIR } from '../decomposition/layerizeExperiment.js';
import { cutoutProvider } from '../decomposition/aiModels.js';
import { createFalTransport } from '../decomposition/providers/falClient.js';
import { liveSegmenter, type Segmenter } from '../decomposition/creativeTemplates/segmenter.js';
import { parseStudioEnv, type ServerEnv } from './config.js';
import { openStudioStore, validId, now, type StudioStore } from './store.js';
import { OpenAIProvider, type Provider } from './ai/provider.js';
import { checkModelAccess } from './openai/client.js';
import { ingestAsset } from './assets/ingest.js';
import { toAssetDto } from './assets/dto.js';
import { LIMITS, UPLOADABLE_ROLES, UploadRejectedError } from './assets/validate.js';
import { readStorageFile } from './storage.js';
import { attachLogo, addFont, brandKitFile, BrandKitError, createBrandKit, detachLogo, removeFont, toBrandKitDto, updateBrandKit, updateFont } from './brand/kits.js';
import { MAX_FONT_BYTES } from './brand/fonts.js';
import { createTemplate, createTemplateSchema, startAnalysis, TemplateError, templateView } from './templates/service.js';
import { toTemplateDto } from './templates/dto.js';
import { CampaignError, createCampaign, createCampaignSchema, regenerate } from './campaigns/service.js';
import { enqueueJob, requestCancel } from './jobs/queue.js';
import { toJobDto } from './jobs/dto.js';
import { startWorker, type StudioWorker } from './jobs/worker.js';
import { SUBJECT_ANALYST } from './prompts.js';
import { SUBJECT_ANALYSIS_SCHEMA } from './contracts/ai.js';
import { describeMoney, estimatePoster, estimateReferencePoster, estimateTemplateCreation, type WorkflowEstimate } from './costs/profiles.js';
import { CostUnboundedError } from './costs/estimate.js';
import { FAL_RATES, RATE_CARD_VERSION } from './costs/rateCard.js';
import { spentToday } from './costs/budget.js';
import { costSummary } from './costs/summary.js';
import { editorOverlay, historyItems, posterDetail, posterJobIds } from './posters/dto.js';
import { renderPosterImage, renderPosterLogo } from './posters/service.js';
import { decompositionScene, HandoffError, linkDecomposition } from './handoff.js';
import { resumeBudgetJob } from './jobs/queue.js';
import { resolveReferencePolicy } from './referencePolicy.js';
import { budgetStatus, BudgetExceededError } from './costs/budget.js';
import { setupStatus } from './setup.js';
import { registerMasterCreativeRoutes } from './masterCreatives/routes.js';

class StudioHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) { super(message); this.name = 'StudioHttpError'; }
}
const notFound = (what: string) => new StudioHttpError(404, 'not_found', `${what} not found.`);
const idempotencyKey = z.object({ idempotencyKey: z.string().min(8).max(128) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issues = result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message }));
    throw new StudioHttpError(400, 'invalid_request', issues[0]?.message ?? 'The request is not valid.', { issues });
  }
  return result.data;
}

/** One multipart upload: the file and a few short text fields. */
function readMultipart(req: Request, maxBytes: number): Promise<{ file?: { bytes: Buffer; filename: string; mime: string }; fields: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof busboy>;
    try { parser = busboy({ headers: req.headers, limits: { files: 1, fields: 8, fieldSize: 400, fileSize: maxBytes } }); }
    catch { reject(new StudioHttpError(400, 'invalid_form', 'Expected a multipart form upload.')); return; }
    let file: { bytes: Buffer; filename: string; mime: string } | undefined, truncated = false;
    const fields: Record<string, string> = {};
    parser.on('field', (name, value) => { fields[name] = value; });
    parser.on('file', (_name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => { truncated = true; });
      stream.on('end', () => { file = { bytes: Buffer.concat(chunks), filename: info.filename, mime: info.mimeType }; });
    });
    parser.on('error', () => reject(new StudioHttpError(400, 'invalid_form', 'The upload could not be read.')));
    parser.on('close', () => truncated ? reject(new StudioHttpError(413, 'too_large', `Uploads must be under ${Math.round(maxBytes / 1024 / 1024)} MB.`)) : resolve({ file, fields }));
    req.pipe(parser);
  });
}

export interface TemplateStudioOptions {
  env?: ServerEnv; dataDir?: string; access?: ExperimentAccess; runsDir?: string;
  /** The image and text provider (live OpenAI by default; tests and the offline fixture inject a fake). */
  provider?: Provider;
  /** FrameFlow's mask provider for exact cutouts (live SAM-3 via fal by default; undefined when not configured). */
  segmenter?: () => Segmenter | undefined;
  /** false: no worker (route tests drive jobs themselves). */
  worker?: boolean;
  falConfigured?: boolean;
  log?: (message: string) => void;
  /** Protected templates, read only (style variations); FrameFlow's own folder by default. */
  protectedDir?: string;
  /** The local recognizer that checks generated artwork for drawn text (tesseract by default). */
  recognizer?: () => WordRecognizer;
  /** The local recognizer of master templates (the same reading as their scans; tesseract by default): AI variations' template check. */
  masterRecognizer?: () => WordRecognizer;
}

export function createTemplateStudioRouter(options: TemplateStudioOptions = {}): Router & { studio: { db: StudioStore; env: ServerEnv; worker?: StudioWorker } } {
  const env = options.env ?? parseStudioEnv(process.env, options.dataDir);
  const db = openStudioStore(env.dataDir);
  const runsDir = options.runsDir ?? DEFAULT_RUNS_DIR;
  const provider = options.provider ?? new OpenAIProvider(env.OPENAI_API_KEY);
  const falKey = process.env.FAL_KEY?.trim();
  const segmenter = options.segmenter ?? (() => {
    let kind: ReturnType<typeof cutoutProvider>;
    try { kind = cutoutProvider(process.env); } catch { return undefined; }
    return kind === 'none' || !falKey ? undefined : liveSegmenter(kind, () => createFalTransport(falKey));
  });
  const protectedStore = fileProtectedStore(options.protectedDir ?? DEFAULT_PROTECTED_DIR), recognizer = options.recognizer ?? localRecognizer;
  const worker = options.worker === false ? undefined : startWorker({ db, storageDir: env.assetStorageDir, env, provider, segmenter, log: options.log, protectedStore: () => protectedStore, recognizer });
  const money = (m: number) => describeMoney(m, env);
  const router = express.Router() as Router & { studio: { db: StudioStore; env: ServerEnv; worker?: StudioWorker } };
  router.studio = { db, env, worker };
  router.use(experimentAccess(options.access));
  router.use(express.json({ limit: '256kb', strict: true }));
  registerMasterCreativeRoutes(router, { db, env, store: protectedStore, configured: !!env.OPENAI_API_KEY || !!options.provider, offline: (provider as Provider).offline === true, recognizer: options.masterRecognizer ?? localRecognizer, wake: () => worker?.wake() });
  const queued = <T>(value: T) => { worker?.wake(); return value; };
  const id = (req: Request, name = 'id') => { const value = req.params[name]; if (!validId(value)) throw new StudioHttpError(404, 'not_found', 'Not found.'); return value as string; };
  const posterOf = (req: Request) => db.posters.get(id(req)) ?? (() => { throw notFound('Poster'); })();

  // --- Reference data --------------------------------------------------------------------------------------------------
  router.get('/meta', (_req, res) => res.json({
    formats: STUDIO_FORMATS, copyFields: STUDIO_COPY_FIELDS, occasions: STUDIO_OCCASION_GROUPS, fidelityModes: FIDELITY_MODES, creativeDirections: STUDIO_CREATIVE_DIRECTIONS,
    qualities: STUDIO_IMAGE_QUALITIES, limits: { products: STUDIO_MAX_PRODUCTS, references: STUDIO_MAX_REFERENCES },
    defaults: { formatId: DEFAULT_STUDIO_FORMAT, fidelityMode: DEFAULT_FIDELITY_MODE, quality: env.IMAGE_QUALITY },
    cutouts: { available: Boolean(segmenter()), price: money(FAL_RATES.cutoutSam3.perRequest), priceSource: FAL_RATES.cutoutSam3.source },
    fx: env.fx,
  }));

  router.get('/setup', async (_req, res, next) => {
    try { res.json(await setupStatus(env, db, worker, { falConfigured: options.falConfigured ?? Boolean(falKey), runsDir })); } catch (e) { next(e); }
  });
  /** The free models endpoint (no tokens, no charge): confirms the configured models are visible to the key. */
  router.post('/setup/check-models', async (_req, res, next) => {
    try { res.json({ results: await checkModelAccess(env.OPENAI_API_KEY, { analysis: env.OPENAI_ANALYSIS_MODEL, planner: env.OPENAI_PLANNER_MODEL, review: env.OPENAI_REVIEW_MODEL, image: env.OPENAI_IMAGE_MODEL }) }); }
    catch (e) { next(new StudioHttpError(503, 'not_configured', e instanceof Error ? e.message : 'The model check failed.')); }
  });

  // --- Costs -----------------------------------------------------------------------------------------------------------
  const workflowView = (w: WorkflowEstimate) => ({
    label: w.label, total: money(w.totalMicroUsd), cap: money(w.capMicroUsd), withinCap: w.withinCap,
    calls: w.calls.map(c => ({ stage: c.stage, model: c.estimate.model, cost: money(c.estimate.microUsd), assumptions: c.estimate.assumptions })),
  });
  router.get('/costs', (_req, res, next) => {
    try {
      let workflows: ReturnType<typeof workflowView>[] = [], estimateError: string | null = null;
      try { workflows = [estimateTemplateCreation(env, 3), estimatePoster(env, { subjects: 1 }), estimatePoster(env, { subjects: 3 }), estimatePoster(env, { subjects: 6 })].map(workflowView); }
      catch (err) { if (!(err instanceof CostUnboundedError)) throw err; estimateError = err.message; }
      res.json({
        rateCardVersion: RATE_CARD_VERSION, fx: env.fx, workflows, estimateError,
        today: { spent: money(spentToday(db)), cap: money(Math.round(env.DAILY_BUDGET_USD * 1e6)) },
        recorded: costSummary(db.usage.all(), env),
        note: 'Estimates are upper bounds from published prices plus stated assumptions. Recorded costs come from the usage each provider reports; the provider\'s billing dashboard is authoritative.',
      });
    } catch (e) { next(e); }
  });
  /** Before Create Template: the analysis for this many references, and the one bounded repair it may need. */
  router.get('/costs/template-estimate', (req, res, next) => {
    try {
      const references = Math.min(STUDIO_MAX_REFERENCES, Math.max(1, Number(req.query.references) || 1));
      const w = estimateTemplateCreation(env, references);
      res.json({ ...workflowView(w), fx: env.fx, rateCardVersion: RATE_CARD_VERSION });
    } catch (e) { next(e instanceof CostUnboundedError ? new StudioHttpError(422, 'cost_unbounded', e.message) : e); }
  });
  const estimateBody = z.object({
    fidelityMode: z.enum(['match', 'adapt', 'explore']).default('match'), direction: z.string().max(1000).nullable().optional(), occasion: z.string().max(80).nullable().optional(),
    copy: createCampaignSchema.shape.copy.optional(), productActions: createCampaignSchema.shape.productActions,
    backgroundOnly: createCampaignSchema.shape.backgroundOnly, referenceText: createCampaignSchema.shape.referenceText,
    templateId: z.string().nullable().optional(), formatId: z.string(), quality: z.enum(STUDIO_IMAGE_QUALITIES).optional(),
    products: z.array(z.object({ assetId: z.string(), name: z.string().max(120).default(''), subjectType: z.string().max(120).nullable().optional(), isSku: z.boolean().optional() })).max(STUDIO_MAX_PRODUCTS).default([]),
  });
  /** The pre-generation breakdown: what each stage could cost, and what is already cached (no new call). */
  router.post('/costs/estimate', (req, res, next) => {
    try {
      const body = parse(estimateBody, req.body);
      const format = STUDIO_FORMATS.find(f => f.id === body.formatId);
      if (!format) throw new StudioHttpError(400, 'invalid_format', 'Unknown format.');
      const quality = body.quality ?? env.IMAGE_QUALITY;
      const cached = body.products.filter(p => {
        const asset = db.assets.get(p.assetId), subject = asset && db.subjects.find(s => s.primaryAssetId === asset.id);
        if (!asset || !subject?.analysis) return false;
        const key = createHash('sha256').update(JSON.stringify({ sha: asset.sha256, name: p.name.trim(), type: p.subjectType?.trim() || null, sku: p.isSku ?? false, model: env.OPENAI_ANALYSIS_MODEL, prompt: SUBJECT_ANALYST.version, schema: SUBJECT_ANALYSIS_SCHEMA })).digest('hex');
        return subject.analysisCacheKey === key;
      }).length;
      let policy;
      let blockedReason: string | null = null;
      if (body.templateId) try { policy = resolveReferencePolicy(db, { ...body, templateId: body.templateId, subjects: body.products }); }
      catch (err) { blockedReason = (err as Error).message; }
      const w = estimateReferencePoster(env, policy, { subjects: body.products.length, size: format.providerSize, quality, uncachedSubjects: body.products.length - cached });
      const view = templateView(db, body.templateId ?? '');
      const lines: StudioEstimateLine[] = [{
        stage: 'Reference / template analysis', model: view?.profile?.analysisModel ?? env.OPENAI_ANALYSIS_MODEL, cost: money(0), cached: true,
        note: view?.profile ? `Done when the template was created (v${view.profile.version}); reused, no new call.` : 'Done once when a template is created; reused by every poster.', assumptions: [],
      }];
      if (body.products.length) {
        const analysis = w.calls.find(c => c.stage.startsWith('Subject analysis'));
        lines.push({ stage: 'Product analysis', model: env.OPENAI_ANALYSIS_MODEL, cost: money(analysis?.estimate.microUsd ?? 0), cached: !analysis,
          note: cached ? `${cached} of ${body.products.length} product${body.products.length === 1 ? '' : 's'} already analysed with the same name: reused, no new call.` : `${body.products.length} product${body.products.length === 1 ? '' : 's'}; cached for later posters.`, assumptions: analysis?.estimate.assumptions ?? [] });
      }
      const label: Record<string, string> = { 'Art direction (planner)': 'AI composition planning', 'Visual review': 'Image review' };
      for (const c of w.calls.filter(c => !c.stage.startsWith('Subject analysis'))) {
        lines.push({ stage: label[c.stage] ?? (c.stage.startsWith('Scene image') ? `Image generation (${quality}, ${format.providerSize})` : c.stage), model: c.estimate.model, cost: money(c.estimate.microUsd), cached: false, assumptions: c.estimate.assumptions });
      }
      const daily = budgetStatus(db, env);
      const estimate: StudioEstimate = {
        label: w.label, lines, total: money(w.totalMicroUsd), cap: money(w.capMicroUsd), withinCap: w.withinCap, localReuse: policy?.localReuse ?? false, blockedReason,
        daily: { cap: money(daily.cap), used: money(daily.used), held: money(daily.held), remaining: money(daily.remaining), fits: w.totalMicroUsd <= daily.remaining, resets: daily.resets },
        quality, providerSize: format.providerSize, fx: env.fx, rateCardVersion: RATE_CARD_VERSION,
        note: 'Conservative planning estimate including possible repairs and review retry; each call is also capped before sending. Not a provider invoice. Reference masks, when listed, count toward the Studio cap. Later fal/Seedream decomposition is billed separately and is outside this budget.',
      };
      res.json(estimate);
    } catch (e) { next(e instanceof CostUnboundedError ? new StudioHttpError(422, 'cost_unbounded', e.message) : e); }
  });

  // --- Assets ----------------------------------------------------------------------------------------------------------
  router.get('/assets', (req, res, next) => {
    try {
      const roles = typeof req.query.role === 'string' ? req.query.role.split(',') : [...UPLOADABLE_ROLES];
      if (roles.some(r => !(UPLOADABLE_ROLES as readonly string[]).includes(r))) throw new StudioHttpError(400, 'invalid_role', 'Unknown asset role.');
      res.json({ assets: db.assets.filter(a => roles.includes(a.role)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300).map(toAssetDto) });
    } catch (e) { next(e); }
  });
  router.post('/assets', async (req, res, next) => {
    try {
      const { file, fields } = await readMultipart(req, LIMITS.maxUploadBytes);
      if (!file?.bytes.length) throw new StudioHttpError(400, 'missing_file', 'No file was uploaded.');
      const role = fields.role ?? '';
      if (!(UPLOADABLE_ROLES as readonly string[]).includes(role)) throw new StudioHttpError(400, 'invalid_role', `Role must be one of: ${UPLOADABLE_ROLES.join(', ')}.`);
      const { asset, deduplicated } = await ingestAsset({ buffer: file.bytes, declaredMime: file.mime, filename: file.filename, role: role as (typeof UPLOADABLE_ROLES)[number], label: fields.label }, { db, storageDir: env.assetStorageDir });
      res.status(deduplicated ? 200 : 201).json({ asset: toAssetDto(asset), deduplicated });
    } catch (e) { next(e instanceof UploadRejectedError ? new StudioHttpError(422, e.code, e.message) : e); }
  });
  const VARIANTS = { thumb: 'thumbPath', normalised: 'normalisedPath', analysis: 'analysisPath', original: 'originalPath' } as const;
  router.get('/assets/:id', async (req, res, next) => {
    try {
      const asset = db.assets.get(id(req)) ?? (() => { throw notFound('Asset'); })();
      const variant = (typeof req.query.variant === 'string' ? req.query.variant : 'normalised') as keyof typeof VARIANTS;
      if (!VARIANTS[variant]) throw new StudioHttpError(400, 'invalid_variant', 'Unknown variant.');
      const rel = asset[VARIANTS[variant]];
      const data = await readStorageFile(env.assetStorageDir, rel);
      const type = variant === 'thumb' ? 'image/webp' : variant === 'normalised' ? 'image/png' : variant === 'analysis' ? (rel.endsWith('.png') ? 'image/png' : 'image/jpeg') : asset.mimeType;
      const download = req.query.download === '1' || type === 'image/svg+xml';
      res.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      if (download) res.attachment((asset.sourceFilename ?? asset.id).replace(/[^\w.\- ]/g, '_'));
      res.send(data);
    } catch (e) { next((e as NodeJS.ErrnoException)?.code === 'ENOENT' ? new StudioHttpError(404, 'file_missing', 'The asset record exists but its file is missing from storage.') : e); }
  });
  /** Explicit, paid: an exact cutout of an opaque product photo with FrameFlow's SAM-3 masks. */
  router.post('/assets/:id/cutout', (req, res, next) => {
    try {
      const body = parse(idempotencyKey.extend({ label: z.string().trim().min(1).max(120) }), req.body);
      const asset = db.assets.get(id(req)) ?? (() => { throw notFound('Asset'); })();
      if (asset.role !== 'subject') throw new StudioHttpError(422, 'invalid', 'Only product photos can be cut out.');
      if (asset.hasAlpha) throw new StudioHttpError(422, 'invalid', 'This image is already transparent; use it directly.');
      if (!segmenter()) throw new StudioHttpError(503, 'not_configured', 'Exact cutouts need FAL_KEY and CREATIVE_CUTOUT_PROVIDER=sam3 on the server. You can upload a transparent PNG cutout instead.');
      const { job } = enqueueJob(db, { kind: 'make_cutout', idempotencyKey: `cutout:${body.idempotencyKey}`, input: { assetId: asset.id, label: body.label } });
      res.status(202).json(queued({ job: toJobDto(db, env, job) }));
    } catch (e) { next(e); }
  });

  // --- Brand kits ------------------------------------------------------------------------------------------------------
  const kitOf = (req: Request) => db.brandKits.get(id(req)) ?? (() => { throw notFound('Brand kit'); })();
  const kitJson = (kitId: string) => ({ kit: toBrandKitDto(db, db.brandKits.require(kitId, 'Brand kit')) });
  router.get('/brand-kits', (_req, res, next) => { try { res.json({ kits: db.brandKits.all().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(k => toBrandKitDto(db, k)) }); } catch (e) { next(e); } });
  router.post('/brand-kits', (req, res, next) => {
    try { const body = parse(brandKitFile, req.body); const kit = createBrandKit(db, { name: body.name, rules: body.rules, sourceNote: body.sourceNote }); res.status(201).json(kitJson(kit.id)); } catch (e) { next(e); }
  });
  router.get('/brand-kits/:id', (req, res, next) => { try { res.json(kitJson(kitOf(req).id)); } catch (e) { next(e); } });
  router.patch('/brand-kits/:id', (req, res, next) => {
    try { const body = parse(z.object({ name: z.string().trim().min(1).max(120).optional(), rules: z.unknown().optional(), expectedRevision: z.number().int().min(1) }), req.body); updateBrandKit(db, kitOf(req).id, body); res.json(kitJson(req.params.id as string)); } catch (e) { next(e); }
  });
  router.post('/brand-kits/:id/logos', (req, res, next) => {
    try { const body = parse(z.object({ assetId: z.string().min(1), kind: z.enum(['primary', 'partner']), name: z.string().trim().min(1).max(120), colourName: z.string().trim().max(60).nullable().optional() }), req.body); attachLogo(db, kitOf(req).id, body); res.json(kitJson(req.params.id as string)); } catch (e) { next(e); }
  });
  router.delete('/brand-kits/:id/logos/:logoId', (req, res, next) => { try { detachLogo(db, kitOf(req).id, id(req, 'logoId')); res.json(kitJson(req.params.id as string)); } catch (e) { next(e); } });
  router.post('/brand-kits/:id/fonts', async (req, res, next) => {
    try {
      const kit = kitOf(req);
      const { file, fields } = await readMultipart(req, MAX_FONT_BYTES);
      if (!file?.bytes.length) throw new StudioHttpError(400, 'missing_file', 'No font file was uploaded.');
      if (fields.role !== 'display' && fields.role !== 'text') throw new StudioHttpError(400, 'invalid_role', 'Role must be display or text.');
      await addFont(db, env.assetStorageDir, kit.id, { buffer: file.bytes, filename: file.filename, role: fields.role, licenceConfirmed: fields.licenceConfirmed === 'true' });
      res.status(201).json(kitJson(kit.id));
    } catch (e) { next(e); }
  });
  router.patch('/brand-kits/:id/fonts/:fontId', (req, res, next) => {
    try { const body = parse(z.object({ licenceConfirmed: z.boolean().optional(), role: z.enum(['display', 'text']).optional() }), req.body); updateFont(db, kitOf(req).id, id(req, 'fontId'), body); res.json(kitJson(req.params.id as string)); } catch (e) { next(e); }
  });
  router.delete('/brand-kits/:id/fonts/:fontId', (req, res, next) => { try { removeFont(db, kitOf(req).id, id(req, 'fontId')); res.json(kitJson(req.params.id as string)); } catch (e) { next(e); } });

  // --- Templates -------------------------------------------------------------------------------------------------------
  const templateJson = (templateId: string) => { const view = templateView(db, templateId); if (!view) throw notFound('Template'); return { template: toTemplateDto(db, env, view) }; };
  router.get('/templates', (_req, res, next) => {
    try { res.json({ templates: db.templates.all().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(t => templateJson(t.id).template) }); } catch (e) { next(e); }
  });
  /** Create a template and start analysing its references (one paid analysis call; identical inputs reuse a cached profile). */
  router.post('/templates', (req, res, next) => {
    try {
      const body = parse(createTemplateSchema.extend({ idempotencyKey: z.string().min(8).max(128) }), req.body);
      const prior = db.jobs.find(j => j.kind === 'analyse_template' && j.idempotencyKey.endsWith(`:${body.idempotencyKey}`));
      if (prior) { const templateId = (prior.inputSnapshot as { templateId: string }).templateId; return void res.status(200).json({ templateId, jobId: prior.id }); }
      const template = createTemplate(db, body);
      const { job } = startAnalysis(db, env, template.id, body.idempotencyKey);
      res.status(201).json(queued({ templateId: template.id, jobId: job.id }));
    } catch (e) { next(e); }
  });
  router.get('/templates/:id', (req, res, next) => { try { res.json(templateJson(id(req))); } catch (e) { next(e); } });
  router.patch('/templates/:id', (req, res, next) => {
    try {
      const body = parse(z.object({ name: z.string().trim().min(1).max(120).optional(), guidance: z.string().trim().max(2000).nullable().optional(), brandKitId: z.string().nullable().optional(), selectedClusterId: z.string().optional() }), req.body);
      const template = db.templates.get(id(req)) ?? (() => { throw notFound('Template'); })();
      if (body.brandKitId && !db.brandKits.get(body.brandKitId)) throw new StudioHttpError(422, 'invalid', 'Brand kit not found.');
      db.templates.update(template.id, { ...(body.name ? { name: body.name } : {}), ...(body.guidance !== undefined ? { creatorGuidance: body.guidance || null } : {}), ...(body.brandKitId !== undefined ? { brandKitId: body.brandKitId } : {}), updatedAt: now() });
      if (body.selectedClusterId && template.currentProfileVersionId) {
        const v = db.profiles.require(template.currentProfileVersionId, 'Style profile');
        if (!(v.profile as { referenceClusters: { id: string }[] }).referenceClusters.some(c => c.id === body.selectedClusterId)) throw new StudioHttpError(422, 'invalid', 'Unknown style direction.');
        db.profiles.update(v.id, { selectedClusterId: body.selectedClusterId });
      }
      res.json(templateJson(template.id));
    } catch (e) { next(e); }
  });
  /** Explicit, paid (unless the same inputs were analysed before): analyse the references again as a new version. */
  router.post('/templates/:id/analyse', (req, res, next) => {
    try { const body = parse(idempotencyKey, req.body); const { job } = startAnalysis(db, env, id(req), body.idempotencyKey); res.status(202).json(queued({ jobId: job.id })); } catch (e) { next(e); }
  });

  // --- Campaigns, jobs -------------------------------------------------------------------------------------------------
  router.post('/campaigns', (req, res, next) => {
    try { const { job, campaignId } = createCampaign(db, env, parse(createCampaignSchema, req.body)); res.status(202).json(queued({ jobId: job.id, campaignId })); } catch (e) { next(e); }
  });
  router.get('/jobs/:id', (req, res, next) => {
    try { const job = db.jobs.get(id(req)) ?? (() => { throw notFound('Job'); })(); res.setHeader('Cache-Control', 'no-store'); res.json({ job: toJobDto(db, env, job) }); } catch (e) { next(e); }
  });
  router.post('/jobs/:id/resume-budget', (req, res, next) => {
    try { const jobId = id(req); let job; try { job = resumeBudgetJob(db, jobId); } catch (err) { throw new StudioHttpError(422, 'cannot_resume', (err as Error).message); }
      res.status(202).json(queued({ jobId: job.id }));
    } catch (e) { next(e); }
  });
  router.post('/jobs/:id/cancel', (req, res, next) => {
    try { const job = requestCancel(db, id(req)); if (!job) throw notFound('Job'); res.json({ job: toJobDto(db, env, job) }); } catch (e) { next(e); }
  });

  // --- Posters ---------------------------------------------------------------------------------------------------------
  router.get('/posters', (_req, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); res.json({ items: historyItems(db, env) }); } catch (e) { next(e); } });
  router.get('/posters/:id', (req, res, next) => {
    try { const detail = posterDetail(db, env, id(req)); if (!detail) throw notFound('Poster'); res.setHeader('Cache-Control', 'no-store'); res.json({ poster: detail }); } catch (e) { next(e); }
  });
  /** The poster rendered on the server (scene + exact copy + logos). Preview, download and review use the same renderer. */
  router.get('/posters/:id/image', async (req, res, next) => {
    try {
      const poster = posterOf(req);
      const format = req.query.format === 'jpeg' ? 'jpeg' : 'png';
      const width = req.query.width ? Math.min(4000, Math.max(64, Number(req.query.width) || 0)) : undefined;
      const image = await renderPosterImage(db, env.assetStorageDir, poster, { format, width });
      res.set({ 'Content-Type': format === 'jpeg' ? 'image/jpeg' : 'image/png', 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' });
      if (req.query.download === '1') res.attachment(`poster-${poster.id}.${format === 'jpeg' ? 'jpg' : 'png'}`);
      res.send(image);
    } catch (e) { next(e); }
  });
  /** The text-free scene FrameFlow's decomposition receives for this poster (byte-identical on every request). */
  router.get('/posters/:id/decomposition-scene.png', async (req, res, next) => {
    try {
      const scene = await decompositionScene(db, env.assetStorageDir, posterOf(req));
      res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Studio-Scene-Note': encodeURIComponent(scene.note), 'X-Studio-Scene-Sha256': scene.asset.sha256 });
      res.send(scene.bytes);
    } catch (e) { next(e); }
  });
  router.get('/posters/:id/logo.png', async (req, res, next) => {
    try { const logo = await renderPosterLogo(db, env.assetStorageDir, posterOf(req)); if (!logo) throw notFound('Logo'); res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.send(logo.image); } catch (e) { next(e); }
  });
  /** What the editor restores over the decomposed layers: the copy as native text and the logo lock-up as one image. */
  router.get('/posters/:id/editor-overlay', async (req, res, next) => {
    try { const poster = posterOf(req); const logo = await renderPosterLogo(db, env.assetStorageDir, poster); res.setHeader('Cache-Control', 'no-store'); res.json(editorOverlay(poster, logo?.box ?? null)); } catch (e) { next(e); }
  });
  router.post('/posters/:id/approve', (req, res, next) => {
    try { const poster = posterOf(req); const approved = req.body?.approved !== false; db.posters.update(poster.id, { approvedAt: approved ? now() : null }); res.json({ poster: posterDetail(db, env, poster.id) }); } catch (e) { next(e); }
  });
  /** Explicit, paid: a new scene for the same campaign (same inputs, same mode). Never automatic. */
  router.post('/posters/:id/regenerate', (req, res, next) => {
    try { const body = parse(idempotencyKey, req.body); const { job } = regenerate(db, posterOf(req).campaignId, body.idempotencyKey); res.status(202).json(queued({ jobId: job.id })); } catch (e) { next(e); }
  });
  /** Explicit, paid (one text call): review the same poster again. No image call. */
  router.post('/posters/:id/review', (req, res, next) => {
    try {
      const body = parse(idempotencyKey, req.body), poster = posterOf(req);
      if (!poster.jobId) throw new StudioHttpError(422, 'invalid', 'This poster has no generation record to review against.');
      const { job } = enqueueJob(db, { kind: 'review_poster', idempotencyKey: `review:${body.idempotencyKey}`, input: { posterId: poster.id }, campaignId: poster.campaignId });
      res.status(202).json(queued({ jobId: job.id }));
    } catch (e) { next(e); }
  });
  /** After the browser started FrameFlow's decomposition with this poster's scene: remember which run it was. */
  router.post('/posters/:id/decompositions', async (req, res, next) => {
    try { const body = parse(z.object({ runId: z.string().max(80) }), req.body); const link = await linkDecomposition(db, env.assetStorageDir, runsDir, posterOf(req), body.runId); res.status(201).json({ link }); } catch (e) { next(e); }
  });
  /** For FrameFlow's run dashboard and editor import: the poster a decomposition run came from, with its costs. */
  router.get('/decompositions/:runId', (req, res, next) => {
    try {
      const link = db.decompositions.filter(d => d.runId === req.params.runId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!link) return void res.json({ link: null });
      const poster = db.posters.require(link.posterId, 'Poster'), campaign = db.campaigns.require(poster.campaignId, 'Campaign');
      const template = db.templates.get(campaign.templateId), view = template ? templateView(db, template.id) : null;
      const jobIds = posterJobIds(db, poster);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        // provenance: reference_reuse means the run decomposed the template's original reference, copied unchanged.
        link, poster: { id: poster.id, headline: campaign.copy.headline ?? null, thumb: `/api/template-studio/posters/${poster.id}/image?width=360&format=jpeg&v=${encodeURIComponent(poster.updatedAt)}`, fidelityMode: campaign.fidelityMode, provenance: poster.provenance ?? 'ai_generated' },
        template: template ? { id: template.id, name: template.name } : null,
        costs: { template: view ? costSummary(view.usage, env) : null, generation: costSummary(db.usage.filter(u => u.jobId !== null && jobIds.includes(u.jobId)), env) },
      });
    } catch (e) { next(e); }
  });

  // --- Style variations of protected templates --------------------------------------------------------------------------
  // Paid: only POST /protected/:templateId/variations, with an explicit confirmation naming the exact estimate. Every other
  // route is local and free (typography, layout and logo changes never ask for new artwork).
  const protectedIdOf = (req: Request) => { const value = req.params.templateId; if (!validProtectedTemplateId(value)) throw notFound('Protected template'); return value as string; };
  const variationOf = (req: Request) => db.styleVariations.get(id(req)) ?? (() => { throw notFound('Variation'); })();
  const variationJson = (variationId: string) => ({ variation: toVariationView(db, env, db.styleVariations.require(variationId, 'Variation')) });
  const slot = z.object({ presetId: z.string().max(60), source: z.enum(['ai', 'restyle', 'reuse']), customName: z.string().max(VARIATION_LIMITS.maxPresetName).optional(), customDirection: z.string().max(VARIATION_LIMITS.maxCustomInstructions).optional() });
  const typography = z.object({ headline: z.string().max(120), body: z.string().max(120), accent: z.string().max(120).optional(), headlineWeight: z.union([z.literal(400), z.literal(600), z.literal(700)]), bodyWeight: z.union([z.literal(400), z.literal(600), z.literal(700)]), color: z.string().max(7).optional() });
  const variationRequest = z.object({ slots: z.array(slot).min(1).max(VARIATION_LIMITS.maxCount), customInstructions: z.string().max(VARIATION_LIMITS.maxCustomInstructions).optional(),
    typographyMode: z.enum(['match', 'suggested', 'custom']), customTypography: typography.optional(), quality: z.enum(STUDIO_IMAGE_QUALITIES) });
  router.get('/variations/meta', (_req, res) => res.json({
    presets: STYLE_PRESETS, defaults: DEFAULT_PRESET_IDS, typographyModes: TYPOGRAPHY_MODE_LABELS, provenance: { labels: PROVENANCE_LABELS, details: PROVENANCE_DETAILS },
    limits: VARIATION_LIMITS, quality: env.IMAGE_QUALITY, qualities: STUDIO_IMAGE_QUALITIES, model: env.OPENAI_IMAGE_MODEL, fx: env.fx,
  }));
  router.get('/protected/:templateId/variations', (req, res, next) => {
    try {
      const templateId = protectedIdOf(req);
      let readiness: { ready: boolean; code?: string; reason?: string } = { ready: true };
      try { variationTemplate(protectedStore, templateId); } catch (err) { if (!(err instanceof VariationError)) throw err; readiness = { ready: false, code: err.code, reason: err.message }; }
      const variations = db.styleVariations.filter(v => v.templateId === templateId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.index - b.index).slice(0, MAX_VARIATIONS_LISTED);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ readiness, variations: variations.map(v => toVariationView(db, env, v)) });
    } catch (e) { next(e); }
  });
  router.post('/protected/:templateId/variations/estimate', async (req, res, next) => {
    try {
      const body = parse(z.object({ request: variationRequest }), req.body), src = variationTemplate(protectedStore, protectedIdOf(req));
      const { plans, providerSize } = await planVariations(db, env, src, body.request as StyleVariationRequest);
      res.setHeader('Cache-Control', 'no-store');
      res.json(estimateView(db, env, plans, providerSize, body.request.quality));
    } catch (e) { next(e); }
  });
  /** Explicit, paid when any slot needs new AI artwork: needs confirm.paid and the exact estimate it was shown. */
  router.post('/protected/:templateId/variations', async (req, res, next) => {
    try {
      const body = parse(idempotencyKey.extend({ request: variationRequest, confirm: z.object({ paid: z.boolean().optional(), estimateMicroUsd: z.number().int().min(0).optional() }).optional() }), req.body);
      const src = variationTemplate(protectedStore, protectedIdOf(req));
      const { batch, created } = await createBatch(db, env, env.assetStorageDir, src, { idempotencyKey: body.idempotencyKey, request: body.request as StyleVariationRequest, confirm: body.confirm });
      res.status(created ? 202 : 200).json(queued({ batch: { id: batch.id, variationIds: batch.variationIds, existing: !created }, variations: batch.variationIds.map(v => variationJson(v).variation) }));
    } catch (e) { next(e); }
  });
  router.get('/variations/:id', (req, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); res.json(variationJson(variationOf(req).id)); } catch (e) { next(e); } });
  const style = z.object({ fontFamily: z.string().max(120), fontSize: z.number(), fontWeight: z.union([z.literal(400), z.literal(600), z.literal(700)]), fontStyle: z.enum(['normal', 'italic']), color: z.string().max(7), opacity: z.number(), letterSpacing: z.number() }).partial();
  const box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), rotation: z.number() });
  /** Typography, word and logo changes in variant coordinates. Never new artwork, never a paid call. */
  router.patch('/variations/:id/layout', async (req, res, next) => {
    try {
      const body = parse(z.object({ typographyMode: z.enum(['match', 'suggested', 'custom']).optional(), customTypography: typography.nullable().optional(),
        words: z.array(z.object({ wordId: z.string().max(40), box: box.optional(), text: z.string().max(80).optional(), hidden: z.boolean().optional(), style: style.optional() })).max(400).optional(),
        logos: z.array(z.object({ slotId: z.string().max(40), box: box.optional(), hidden: z.boolean().optional() })).max(60).optional(),
        confirmProtectedEdits: z.array(z.string().max(40)).max(400).optional() }), req.body);
      const record = variationOf(req), template = protectedStore.get(record.templateId) ?? (() => { throw notFound('Protected template'); })();
      if (!template.textAnalysis) throw new StudioHttpError(422, 'no_text_analysis', 'The template has no word analysis any more.');
      await changeLayout(db, env.assetStorageDir, record, template.textAnalysis, body as LayoutPatch);
      res.json(variationJson(record.id));
    } catch (e) { next(e); }
  });
  router.post('/variations/:id/review', (req, res, next) => {
    try { const body = parse(z.object({ action: z.enum(['select', 'reject', 'save', 'reopen']) }), req.body); reviewVariation(db, variationOf(req), body.action); res.json(variationJson(req.params.id as string)); } catch (e) { next(e); }
  });
  router.post('/variations/:id/duplicate', (req, res, next) => {
    try { const copy = duplicateVariation(db, variationOf(req)); res.status(201).json(variationJson(copy.id)); } catch (e) { next(e); }
  });

  router.use(((error: unknown, _req, res, next) => {
    void next;
    let e: StudioHttpError;
    if (error instanceof StudioHttpError) e = error;
    else if (error instanceof VariationError) e = new StudioHttpError(error.status, error.code, error.message, error.details);
    else if (error instanceof TemplateError) e = new StudioHttpError(error.code === 'not_found' ? 404 : 422, error.code, error.message);
    else if (error instanceof BudgetExceededError) e = new StudioHttpError(422, error.code, error.message);
    else if (error instanceof CampaignError) e = new StudioHttpError(error.code === 'not_found' ? 404 : 422, error.code, error.message);
    else if (error instanceof BrandKitError) e = new StudioHttpError(error.code === 'not_found' ? 404 : 422, error.code, error.message, error.issues ? { issues: error.issues } : {});
    else if (error instanceof HandoffError) e = new StudioHttpError(error.code === 'not_found' ? 404 : error.code === 'mismatch' ? 409 : 400, error.code, error.message);
    else if (error && typeof error === 'object' && 'type' in error && (error as { type?: string }).type === 'entity.parse.failed') e = new StudioHttpError(400, 'invalid_json', 'The request body is not valid JSON.');
    else { console.error('template studio', error); e = new StudioHttpError(500, 'internal', 'Something went wrong on the server. Nothing paid was started by this request.'); }
    res.status(e.status).json({ error: { code: e.code, message: e.message, ...e.details } });
  }) as express.ErrorRequestHandler);
  return router;
}
