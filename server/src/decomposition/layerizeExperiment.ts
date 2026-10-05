/**
 * OpenAI → Seedream layerize experiment. One uploaded image: OpenAI writes an image-specific layerization prompt, the
 * same (orientation-normalized) image and that prompt go to fal `bytedance/seedream/v5/pro/layerize` exactly once, and
 * every returned layer is saved and placed on the base canvas. Standalone: no job, worker, database or other model.
 *
 * Each run is a folder with run.json plus its artifacts. The planner output is saved before Seedream starts, the fal
 * request ID is saved the moment it exists, and nothing is ever resubmitted: timeouts and download failures are
 * recovered with resumeRun (saved response or saved request ID, no new paid call).
 *
 *   npm run decomp:layerize-experiment -w @frameflow/server -- --image ../offer.png          (one OpenAI call + one paid Seedream call)
 *   npm run decomp:layerize-experiment -w @frameflow/server -- --resume <run dir> [--request-id <fal id>]
 *   npm run decomp:layerize-experiment -w @frameflow/server -- --image ../offer.png --template template-a   (saved prompt, no OpenAI call)
 *   npm run decomp:layerize-experiment -w @frameflow/server -- --save-template template-a --run <run id> [--notes "..."]
 *
 * Add --combine-held-object to keep the held object in the subject layer (default: separate layers), and
 * --target-layers N for an exact output layer count (including the base), applied locally after Seedream. Template B
 * (--template-key template-b) takes its own options instead: --template-options '{"separateTouchingIndependentObjects":true}'.
 * The template fit check (one OpenAI call before planning) is off unless LAYERIZE_FIT_CHECK=1; then --skip-fit-check runs anyway.
 *
 * Prompt modes: "generated" (OpenAI writes the prompt from this image) or "template" (a saved template prompt is sent
 * verbatim and OpenAI is not called). The template prompt is snapshotted into run.json when the run is created.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildProviderInput, endpointRegistry, ProviderError, type ProviderErrorDetail } from './providers/adapters.js';
import type { FalTransport } from './providers/falClient.js';
import { createFalTransport } from './providers/falClient.js';
import { decompositionPlannerModel, imageModel, plannerModel } from './aiModels.js';
import { renderLayerizeOutputs, type Canvas, type LayerInfo } from './layerizeArtifacts.js';
import { normalizeLayerCount, type LayerCount, type OutputLayer } from './layerCount.js';
import { createOpenAIPlanner, PlannerError, promptProfile, validatePlan, type LayerizePlan, type Planner, type PlannerUsage } from './layerizePlanner.js';
import { createOpenAIFitChecker, type FitChecker } from './layerizeTemplateFit.js';
import { templateCRoleStrategy, type PlannedCLayer } from './layerizeTemplateC.js';
import { createOpenAIBackgroundReconstructor, type BackgroundReconstructor } from './cleanBackground.js';
import { protectRenderedLayers, type InteractionRecord } from './interactionGrouping.js';
import { callLines, newRefinementRecord, noCalls, refineDecomposition, refinementOptions, type CallCounts, type RefinementOptions, type RefinementRecord } from './recursiveDecomposition.js';
import { getTemplatePrompt, requireTemplate, saveTemplatePrompt, suggestedLayerCount, targetLayerRange, targetLayersProblem, templateOptionsFor, type SavedTemplatePrompt, type TemplateOptions } from './layerizeTemplates.js';

export const SEEDREAM_ENDPOINT = endpointRegistry.seedream.endpoint;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RUNS_DIR = resolve(here, '../../../artifacts/decomposition/layerize-experiment');

/** 'refining': the recursive refinement (residual passes, clean background) of a run created with it. */
export type Stage = 'uploaded' | 'planning' | 'planned' | 'uploading' | 'submitting' | 'queued' | 'in_progress' | 'downloading' | 'refining' | 'done' | 'failed';
/** Where the Seedream prompt comes from. Absent on runs created before template prompts existed (= generated). */
/**
 * Where the Seedream prompt comes from. Absent on runs created before template prompts existed (= generated).
 * `retry`: an explicit user retry of a rejected run, reusing that run's base prompt (OpenAI is not called again).
 * providerPrompt 'auto' (Template B only) sends Seedream an empty prompt instead: its automatic major-elements mode.
 */
export type PromptSource = { mode: 'generated' } | ({ mode: 'template' } & SavedTemplatePrompt)
  | ({ mode: 'retry'; fromRunId: string; providerPrompt?: RetryPrompt } & LayerizePlan)
  /** No prompt at all: Seedream's automatic major-elements mode (Template B's default; `retryOf` for an explicit retry). */
  | { mode: 'automatic'; retryOf?: string };
/** 'current': the rejected run's base prompt with the current provider rules. 'auto': an empty prompt (Template B). */
export type RetryPrompt = 'current' | 'auto';
/**
 * Output layer count for a run (counts include the base). targetLayers is exact and applied locally after Seedream;
 * minLayers/maxLayers only exist on runs made while the count was a range, and are read but never written again.
 */
export type LayerTarget = { templateKey: string; suggestedLayers?: number; targetLayers?: number; minLayers?: number; maxLayers?: number };
export type RunRecord = {
  id: string; createdAt: string; updatedAt: string; stage: Stage;
  promptSource?: PromptSource;
  semanticPlanning?: boolean;
  /** Which template this run belongs to (its prompts, grouping and post-processing). Absent on older runs: Template A. */
  templateKey?: string;
  /** Template A's held-object checkbox ("Separate held object from subject"). Absent on older runs, which all separated
   * it, and on runs of templates without that checkbox (Template B), which read as true. Template B runs made before
   * Template B had its own option stored its old "Separate secondary object from main product" checkbox here; a
   * re-render still honors that (local secondary-object grouping, layerCount.ts), and nothing else reads it for Template B. */
  separateHeldObject?: boolean;
  /** The template's own options (Template B: separateTouchingIndependentObjects), every declared option present. Absent for Template A. */
  templateOptions?: TemplateOptions;
  /** The exact prompt sent to Seedream: the generated or saved prompt after held-object grouping. Absent on older runs. */
  finalPrompt?: string;
  /** Suggested and exact target output layer count for this run. Absent on older runs. */
  layerTarget?: LayerTarget;
  /** `provider` is fal's own status and message for provider failures (sanitized; never the echoed input). */
  error?: { code: string; message: string; stage: Stage; provider?: ProviderFailure };
  original: { file: string; mime: string; width: number; height: number; bytes: number };
  input: { file: string; mime: string; width: number; height: number; orientationNormalized: boolean };
  planner?: { model: string; responseId?: string; usage?: PlannerUsage; durationMs: number } & LayerizePlan;
  seedream: { endpoint: string; input?: Record<string, unknown>; requestId?: string; status?: string; submittedAt?: string; completedAt?: string; queueToResultMs?: number };
  timings: Record<string, number>;
  /** layers: the semantic layers (Seedream's, with the rebuilt outer background). outputLayers: the final layers at the
   * target count (the same list when no target). layerCount: suggested / target / returned / final, and what was merged. */
  canvas?: Canvas; layers?: LayerInfo[]; outputLayers?: OutputLayer[]; layerCount?: LayerCount; warnings: string[];
  /** The template fit check (layerizeTemplateFit.ts): whether the image has the selected template's composition. Absent
   * when no check ran (older runs, retries, runs without a checker, or skipped by the user). */
  templateFit?: { fits: boolean; bestTemplate: string | null; plausibleTemplates?: string[]; reason: string; model: string; responseId?: string; durationMs: number };
  /** The user chose to run despite the fit check ("Run anyway"): the check is not made. */
  skipFitCheck?: boolean;
  /**
   * Where the image came from, when not an upload: a template test generation (generationGroups.ts). `kind` names the
   * template whose generator made it, which is also the run's template; generationId is the creative's group; variantId
   * and aspectRatio say which of its aspect-ratio variants (absent on runs made before groups). 'image-template': a
   * ratio of a template made from a reference image (imageTemplates.ts); the run's own template is its layer style.
   */
  origin?: { kind: 'template-a-generation' | 'template-b-generation' | 'template-c-generation' | 'image-template'; generationId: string; variantId?: string; aspectRatio?: string };
  /**
   * The recursive refinement (recursiveDecomposition.ts): residual passes for objects the first decomposition left in
   * its base, then one clean background from the original. Its options are fixed when the run is created; absent on runs
   * without it (every older run), which are rendered exactly as before.
   */
  refinement?: RefinementRecord;
  /** Protected people and interactions (interactionGrouping.ts): every grouping decision. Image-aware and refined runs only. */
  interactions?: InteractionRecord;
  /** Every provider request this run sent, by kind, counted when sent. Recorded on refined runs only. */
  calls?: CallCounts;
};
export type RunnerDeps = {
  planner: Planner;
  /** The template fit check, before planning. Optional: without it no check is made. */
  fitCheck?: FitChecker;
  /** Lazily created so a missing FAL_KEY fails at submission time, after the plan is saved. */
  transport: () => FalTransport;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number; pollTimeoutMs?: number;
  onUpdate?: (run: RunRecord) => void;
  /** The refinement's one clean-background image edit (cleanBackground.ts). Without it a refined run falls back to a local fill. */
  backgroundReconstructor?: BackgroundReconstructor;
};

/** `details` are extra fields for the API error body (e.g. suggestedLayers). */
export class RunError extends Error { constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) { super(message); this.name = 'RunError'; } }
const RUN_ID = /^[0-9TZ-]+-[a-f0-9]{6}$/;
export const validRunId = (id: string) => RUN_ID.test(id);

const json = (dir: string, file: string, value: unknown) => writeFileSync(join(dir, file), JSON.stringify(value, null, 2));
export function readRun(dir: string): RunRecord {
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunRecord;
  // Runs from before PROVIDER_SAFETY_REJECTED existed filed a safety-checker rejection as a decomposition rejection.
  if (run.error?.code === 'PROVIDER_DECOMPOSITION_REJECTED' && isSafetyRejection(run.error.provider)) {
    const said = run.error.provider!.messages.map(m => m.msg).join(' | ');
    run.error = { ...run.error, code: 'PROVIDER_SAFETY_REJECTED', message: `fal HTTP ${run.error.provider!.status}${said ? `: ${said}` : ''}. ${safetyExplanation(run.seedream.requestId ?? run.error.provider!.requestId ?? 'unknown')} (Recorded as PROVIDER_DECOMPOSITION_REJECTED before safety rejections were classified separately.)` };
  }
  return run;
}
/**
 * fal's ctx.extra_info.reason on a content_policy_violation that is the provider's own post-inference validation, not a
 * verdict on the image: in the 2026-09-29 smoke tests the same image passed and failed with identical requests minutes
 * apart, and the same prompt produced this and the invalid_request "could not be processed" 422 interchangeably.
 */
export const PARTNER_VALIDATION_FAILED = 'partner_validation_failed';
export const isPartnerValidationFailure = (detail: ProviderErrorDetail | undefined) => !!detail?.messages.some(m => m.reason === PARTNER_VALIDATION_FAILED);
/** fal's safety checker (enable_safety_checker) withheld the result: content_policy_violation, except partner validation. */
export const isSafetyRejection = (detail: ProviderErrorDetail | undefined) => !isPartnerValidationFailure(detail)
  && !!detail?.messages.some(m => m.type === 'content_policy_violation' || /content checker|content polic|safety checker|flagged/i.test(m.msg));
const safetyExplanation = (requestId: string) => `fal's safety checker flagged this request (content_policy_violation), so Seedream's result was withheld. This is a safety-checker rejection, not a decomposition failure: the prompt and the output layer count are not the cause. The safety checker stays enabled. This stored result is final for request ${requestId}, so Resume returns the same error. Nothing was retried. Safety checkers can flag ordinary product images; try a different image.`;
/** The run's template: recorded on newer runs, else from its layer target or reused prompt, else Template A. */
export const templateKeyOf = (run: RunRecord) => run.templateKey ?? run.layerTarget?.templateKey ?? (run.promptSource?.mode === 'template' ? run.promptSource.templateKey : undefined) ?? 'template-a';
/** The generated or saved prompt before held-object grouping (what a template save stores). */
export const basePromptOf = (run: RunRecord) => run.promptSource?.mode === 'template' || run.promptSource?.mode === 'retry' ? run.promptSource.prompt : run.planner?.prompt;
/** The planned layers behind that prompt (a retry keeps its original run's), or undefined when none were planned. */
export const plannedLayersOf = (run: RunRecord) => run.promptSource?.mode === 'template' || run.promptSource?.mode === 'retry' ? run.promptSource.planned_layers : run.planner?.planned_layers;
/** The prompt that was (or will be) sent to Seedream. */
export const promptOf = (run: RunRecord) => run.finalPrompt ?? basePromptOf(run);
/** The run's call counts (refined runs record them; other runs keep their frozen run.json shape). */
const callsOf = (run: RunRecord) => (run.calls ??= noCalls());
/** Counts one provider request about to be sent, on runs that record them. */
const count = (run: RunRecord, kind: keyof CallCounts) => { if (run.calls) run.calls[kind]++; };
function save(dir: string, run: RunRecord, deps?: Pick<RunnerDeps, 'onUpdate'>) {
  run.updatedAt = new Date().toISOString();
  json(dir, 'run.json', run);
  deps?.onUpdate?.(run);
}
/** `bodyFile`: the run file holding fal's complete error response (PROVIDER_ERROR_FILE), when the transport captured it. */
export type ProviderFailure = ProviderErrorDetail & { code: string; bodyFile?: string };
const providerFailure = (error: unknown): ProviderFailure | undefined =>
  error instanceof ProviderError && error.providerDetail ? { code: error.code, ...error.providerDetail } : undefined;
/** fal's complete error response for a failed run (status, headers, full body with its echoed input). Local only. */
export const PROVIDER_ERROR_FILE = 'provider-error.json';
/** Our message, led by what fal itself said when the transport captured it. */
function describe(error: unknown): string {
  const ours = error instanceof Error ? error.message : String(error), detail = providerFailure(error);
  if (!detail) return ours;
  const said = detail.messages.map(m => m.msg).join(' | ');
  return `fal HTTP ${detail.status}${said ? `: ${said}` : ''} [${ours}]`;
}
function fail(dir: string, run: RunRecord, code: string, message: string, deps?: Pick<RunnerDeps, 'onUpdate'>, cause?: unknown) {
  const provider = providerFailure(cause);
  if (provider && cause instanceof ProviderError && cause.providerBody) {
    json(dir, PROVIDER_ERROR_FILE, { stage: run.stage, requestId: run.seedream.requestId ?? provider.requestId, capturedAt: new Date().toISOString(), ...cause.providerBody });
    provider.bodyFile = PROVIDER_ERROR_FILE;
  }
  run.error = { code, message, stage: run.stage, ...(provider ? { provider } : {}) };
  run.stage = 'failed';
  save(dir, run, deps);
  return run;
}

/**
 * A new run's layer target: the exact targetLayers, when given, must be within the template's allowed range for this
 * mode (1..suggested combined, 3..suggested separate for Template A). Runs before any OpenAI or fal call.
 */
export function validateLayerTarget(target: RunRecord['layerTarget'], separateHeldObject = true, natural?: number): void {
  if (!target) return;
  if (target.minLayers !== undefined || target.maxLayers !== undefined) throw new RunError('LEGACY_LAYER_RANGE', 'minLayers/maxLayers were replaced by targetLayers, an exact output layer count.');
  if (target.targetLayers === undefined) return;
  const problem = targetLayersProblem(target.templateKey, separateHeldObject, target.targetLayers, natural);
  if (problem) {
    const range = targetLayerRange(target.templateKey, separateHeldObject, natural);
    throw new RunError('INVALID_TARGET_LAYERS', problem, { suggestedLayers: target.suggestedLayers, minTargetLayers: range.min, maxTargetLayers: range.max });
  }
}
/**
 * The layer target for re-rendering an existing run at another exact count (no provider call). For templates whose
 * natural count comes from the decomposition, it is capped by that run's natural count.
 */
export function retargetLayers(run: RunRecord, targetLayers: number): LayerTarget {
  const separateHeldObject = run.separateHeldObject !== false, templateKey = templateKeyOf(run);
  const target = { templateKey, suggestedLayers: suggestedLayerCount(templateKey, separateHeldObject), targetLayers };
  validateLayerTarget(target, separateHeldObject, requireTemplate(templateKey).dynamicLayerCount ? run.layerCount?.suggestedLayers : undefined);
  return target;
}

/**
 * Saves the original upload untouched and prepares the one image both providers receive: EXIF orientation applied
 * (as PNG) only when needed, otherwise the original bytes. Rejects sizes Seedream cannot accept before any call.
 */
export async function createRun(runsDir: string, bytes: Buffer, promptSource: PromptSource = { mode: 'generated' }, options: { separateHeldObject?: boolean; layerTarget?: RunRecord['layerTarget']; templateKey?: string; templateOptions?: unknown; skipFitCheck?: boolean; semanticPlanning?: boolean; origin?: RunRecord['origin']; refinement?: boolean | Partial<RefinementOptions> } = {}): Promise<{ dir: string; run: RunRecord }> {
  const templateKey = options.templateKey ?? options.layerTarget?.templateKey ?? (promptSource.mode === 'template' ? promptSource.templateKey : undefined) ?? 'template-a';
  const template = requireTemplate(templateKey);
  // Automatic templates send Seedream no prompt: a generate request runs automatic, a saved prompt is refused.
  if (template.providerPrompt === 'automatic') {
    if (promptSource.mode === 'template') throw new RunError('PROMPT_NOT_USED', `${template.name} sends Seedream no prompt (automatic major elements), so there is no saved prompt to reuse.`);
    if (promptSource.mode === 'generated') promptSource = { mode: 'automatic' };
  }
  if (template.imageSpecificPrompt && promptSource.mode === 'template') throw new RunError('PROMPT_NOT_REUSABLE', `${template.name}'s prompt names one image's own layers, so no saved prompt is reused; generate one for this image.`);
  if (promptSource.mode === 'template' && promptSource.templateKey !== templateKey) throw new RunError('TEMPLATE_MISMATCH', `The reused prompt belongs to ${promptSource.templateName}, not the selected template.`);
  // The template's own options (Template B's), validated against what it declares; none for Template A.
  const templateOptions = templateOptionsFor(templateKey, options.templateOptions);
  let refinement: RefinementOptions | undefined;
  try { refinement = refinementOptions(options.refinement); } catch (error) { throw new RunError('INVALID_REFINEMENT', error instanceof Error ? error.message : String(error)); }
  validateLayerTarget(options.layerTarget, options.separateHeldObject ?? true);
  if (bytes.length > MAX_UPLOAD_BYTES) throw new RunError('UPLOAD_TOO_LARGE', `Images must be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try { meta = await sharp(bytes, { failOn: 'error' }).metadata(); } catch { throw new RunError('UNSUPPORTED_IMAGE', 'Upload a PNG, JPEG or WebP image.'); }
  if (!['png', 'jpeg', 'webp'].includes(meta.format ?? '') || (meta.pages ?? 1) > 1 || !meta.width || !meta.height) throw new RunError('UNSUPPORTED_IMAGE', 'Upload a single-frame PNG, JPEG or WebP image.');
  const ext = meta.format === 'jpeg' ? 'jpg' : meta.format!, mime = `image/${meta.format}`;
  const rotate = !!meta.orientation && meta.orientation !== 1;
  const input = rotate ? await sharp(bytes).rotate().png().toBuffer() : bytes;
  const inputMeta = rotate ? await sharp(input).metadata() : meta;
  // Local validation against the documented Seedream limits, before anything is sent anywhere.
  try { buildProviderInput('seedream', { imageUrl: 'https://fal.media/validation-only', width: inputMeta.width, height: inputMeta.height }); }
  catch (error) { throw new RunError('IMAGE_SIZE_UNSUPPORTED', error instanceof Error ? error.message : 'Unsupported image size.'); }
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `original.${ext}`), bytes);
  const inputFile = rotate ? 'input.png' : `original.${ext}`;
  if (rotate) writeFileSync(join(dir, inputFile), input);
  const now = new Date().toISOString();
  // Template A's held-object checkbox is only recorded for templates that have it; Template B records its own options.
  const run: RunRecord = { id, createdAt: now, updatedAt: now, ...(options.semanticPlanning ? { semanticPlanning: true } : {}), stage: 'uploaded', promptSource, templateKey, ...(template.grouping ? { separateHeldObject: options.separateHeldObject ?? true } : {}),
    ...(templateOptions ? { templateOptions } : {}), ...(options.skipFitCheck ? { skipFitCheck: true } : {}),
    ...(options.layerTarget ? { layerTarget: options.layerTarget } : {}),
    original: { file: `original.${ext}`, mime, width: meta.width, height: meta.height, bytes: bytes.length },
    input: { file: inputFile, mime: rotate ? 'image/png' : mime, width: inputMeta.width!, height: inputMeta.height!, orientationNormalized: rotate },
    seedream: { endpoint: SEEDREAM_ENDPOINT }, timings: {}, warnings: [], ...(options.origin ? { origin: options.origin } : {}), ...(refinement ? { refinement: newRefinementRecord(refinement), calls: noCalls() } : {}) };
  save(dir, run);
  return { dir, run };
}

/** Plan (or take the saved template prompt) → one Seedream submission → poll → save → render. Planner failure means zero fal calls. */
export async function executeRun(dir: string, deps: RunnerDeps): Promise<RunRecord> {
  const run = readRun(dir);
  if (run.stage !== 'uploaded') throw new RunError('RUN_ALREADY_STARTED', `This run is already ${run.stage}. Use resume instead; a run is never submitted twice.`);
  const started = Date.now();
  const image = readFileSync(join(dir, run.input.file));
  run.stage = 'planning'; save(dir, run, deps);
  // A new image/template pairing is checked first: a template run on an image without its composition asks Seedream for
  // layers that do not exist, which Seedream rejects after full inference. Retries were checked (or run) before.
  const origin = run.promptSource ?? { mode: 'generated' as const };
  const newPairing = origin.mode === 'generated' || origin.mode === 'template' || (origin.mode === 'automatic' && !origin.retryOf);
  if (deps.fitCheck && !run.semanticPlanning && !run.skipFitCheck && newPairing) {
    const template = requireTemplate(templateKeyOf(run)), t = Date.now();
    let fit: Awaited<ReturnType<FitChecker>>;
    count(run, 'fitCheck'); save(dir, run, deps);
    try { fit = await deps.fitCheck(image, run.input.mime, template.key); }
    catch (error) { return fail(dir, run, 'FIT_CHECK_FAILED', `${error instanceof Error ? error.message : String(error)}. Nothing was sent to Seedream.`, deps); }
    // Never blocks a template that plausibly fits: an ambiguous image, or a contradictory answer ("does not fit", yet the
    // selected template is the best or a plausible match).
    const fits = fit.fits || fit.bestTemplate === template.key || fit.plausibleTemplates.includes(template.key);
    run.templateFit = { fits, bestTemplate: fit.bestTemplate, plausibleTemplates: fit.plausibleTemplates, reason: fit.reason, model: fit.model, responseId: fit.responseId, durationMs: Date.now() - t };
    run.timings.fitCheckMs = run.templateFit.durationMs;
    json(dir, 'template-fit.json', { request: fit.request, response: fit.raw });
    save(dir, run, deps);
    if (!fits) {
      const best = fit.bestTemplate ? requireTemplate(fit.bestTemplate).name : undefined, reason = /[.!?]$/.test(fit.reason) ? fit.reason : `${fit.reason}.`;
      return fail(dir, run, 'TEMPLATE_NOT_SUITABLE', `This image does not fit ${template.name}: ${reason}${best ? ` It fits ${best}: run it with ${best}.` : ' No template fits it clearly.'} ${template.name} would ask Seedream for layers this image does not have, which Seedream rejects. Nothing was sent to Seedream (no charge). If the check is wrong, run it anyway.`, deps);
    }
  }
  if (run.promptSource?.mode === 'automatic') {
    // No prompt: Seedream picks the major elements itself. OpenAI is not called; roles are classified locally.
    const retryOf = run.promptSource.retryOf;
    run.warnings.push(`AUTOMATIC_MAJOR_ELEMENTS: Seedream was sent no prompt and picked the major elements itself${retryOf ? ` (explicit retry of run ${retryOf})` : ''}; roles and grouping are decided locally.`);
    run.stage = 'planned'; save(dir, run, deps);
  } else if (run.promptSource?.mode === 'template' || run.promptSource?.mode === 'retry') {
    // Reuse (or an explicit retry): the saved prompt is the base; OpenAI is not called.
    const source = run.promptSource;
    try { validatePlan({ prompt: source.prompt, planned_layers: source.planned_layers, warnings: source.warnings }); }
    catch (error) { return fail(dir, run, 'INVALID_TEMPLATE_PROMPT', error instanceof Error ? error.message : String(error), deps); }
    json(dir, source.mode === 'template' ? 'template-prompt.json' : 'retry-prompt.json', source);
    if (source.mode === 'retry' && source.providerPrompt === 'auto') run.warnings.push(`AUTOMATIC_MAJOR_ELEMENTS: explicit retry of run ${source.fromRunId} with an empty prompt: Seedream picks the major elements itself; roles and grouping are decided locally.`);
    writeFileSync(join(dir, 'prompt.txt'), source.prompt);
    run.stage = 'planned'; save(dir, run, deps);
  } else {
    try {
      const t = Date.now();
      count(run, 'planner'); save(dir, run, deps);
      const result = await deps.planner(image, run.input.mime, { separateHeldObject: run.separateHeldObject !== false, ...(templateKeyOf(run) !== 'template-a' ? { templateKey: templateKeyOf(run) } : {}),
        ...(run.templateOptions ? { templateOptions: run.templateOptions } : {}), ...(run.semanticPlanning ? { semanticPlanning: true } : {}) });
      run.planner = { model: result.model, responseId: result.responseId, usage: result.usage, durationMs: Date.now() - t, ...result.plan };
      run.timings.plannerMs = run.planner.durationMs;
      json(dir, 'openai-request.json', result.request);
      json(dir, 'openai-response.json', result.raw);
      json(dir, 'plan.json', result.plan);
      writeFileSync(join(dir, 'prompt.txt'), result.plan.prompt);
      run.stage = 'planned'; save(dir, run, deps);
    } catch (error) {
      if (error instanceof PlannerError && error.raw !== undefined) json(dir, 'openai-response.json', error.raw);
      return fail(dir, run, error instanceof PlannerError ? error.code : 'PLANNER_FAILED', error instanceof Error ? error.message : String(error), deps);
    }
  }
  // Run-level held-object grouping, with the current fixed rules. The output layer count is applied after Seedream.
  // An automatic-major-elements retry sends no prompt at all (the adapter omits an empty one).
  const automatic = run.promptSource?.mode === 'automatic' || (run.promptSource?.mode === 'retry' && run.promptSource.providerPrompt === 'auto');
  try { run.finalPrompt = automatic ? '' : run.semanticPlanning ? validatePlan({ prompt: basePromptOf(run), planned_layers: plannedLayersOf(run), warnings: [] }).prompt : promptProfile(templateKeyOf(run)).adapt(basePromptOf(run)!, run.separateHeldObject !== false, run.templateOptions); }
  catch (error) { return fail(dir, run, error instanceof PlannerError ? error.code : 'GROUPING_FAILED', error instanceof Error ? error.message : String(error), deps); }
  writeFileSync(join(dir, 'prompt.txt'), run.finalPrompt);
  save(dir, run, deps);
  let input: Record<string, unknown>;
  try { input = buildProviderInput('seedream', { imageUrl: 'https://fal.media/placeholder-until-upload', prompt: promptOf(run), imageSize: 'auto', enhancePromptMode: 'standard', width: run.input.width, height: run.input.height }); }
  catch (error) { return fail(dir, run, 'INVALID_SEEDREAM_INPUT', error instanceof Error ? error.message : String(error), deps); }
  let transport: FalTransport, imageUrl: string;
  try {
    transport = deps.transport();
    run.stage = 'uploading'; save(dir, run, deps);
    const t = Date.now();
    imageUrl = await transport.upload(image, run.input.mime);
    run.timings.uploadMs = Date.now() - t;
  } catch (error) { return fail(dir, run, 'FAL_UPLOAD_FAILED', `${describe(error)} (nothing was submitted)`, deps, error); }
  run.seedream.input = { ...input, image_url: `<fal upload of ${run.input.file}, ${run.input.width}x${run.input.height}>` };
  json(dir, 'seedream-request.json', { endpoint: SEEDREAM_ENDPOINT, input: run.seedream.input });
  run.stage = 'submitting'; count(run, 'seedreamInitial'); save(dir, run, deps);
  try {
    const { requestId } = await transport.submit(SEEDREAM_ENDPOINT, { ...input, image_url: imageUrl });
    // Persist the request ID before anything else can fail.
    run.seedream.requestId = requestId; run.seedream.submittedAt = new Date().toISOString(); run.stage = 'queued';
    json(dir, 'seedream-request.json', { endpoint: SEEDREAM_ENDPOINT, requestId, input: run.seedream.input });
    save(dir, run, deps);
  } catch (error) {
    const status = (error as { status?: number }).status;
    return fail(dir, run, 'FAL_SUBMIT_FAILED', `${describe(error)}${status && !providerFailure(error) ? ` (HTTP ${status})` : ''}. No request ID was returned; if fal accepted it anyway, check the fal dashboard and resume with --request-id. Not resubmitted.`, deps, error);
  }
  const done = await collect(dir, run, deps, true);
  done.timings.totalMs = Date.now() - started;
  save(dir, done, deps);
  return done;
}

/**
 * Poll (never submit) the saved request, save the raw response, then download and render. `fresh`: the run's first
 * execution, the only time the refinement may send its residual passes and background edit; a resume or re-render
 * reuses what they saved and sends nothing.
 */
async function collect(dir: string, run: RunRecord, deps: RunnerDeps, fresh = false): Promise<RunRecord> {
  const requestId = run.seedream.requestId!;
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  let transport: FalTransport;
  try { transport = deps.transport(); } catch (error) { return fail(dir, run, 'FAL_NOT_CONFIGURED', error instanceof Error ? error.message : String(error), deps); }
  const responseFile = join(dir, 'seedream-response.json');
  let raw: unknown;
  if (existsSync(responseFile)) raw = JSON.parse(readFileSync(responseFile, 'utf8'));
  else {
    const t = Date.now();
    let lookupFailures = 0;
    for (;;) {
      let status: string;
      try { status = await transport.status(SEEDREAM_ENDPOINT, requestId); lookupFailures = 0; }
      catch (error) {
        if (++lookupFailures >= 3) return fail(dir, run, 'FAL_STATUS_FAILED', `${describe(error)}. Request ${requestId} is saved; resume later (no resubmission).`, deps, error);
        await sleep(deps.pollIntervalMs ?? 3000); continue;
      }
      run.seedream.status = status;
      if (status === 'COMPLETED') break;
      const stage = status === 'IN_PROGRESS' ? 'in_progress' : 'queued';
      if (run.stage !== stage) { run.stage = stage; save(dir, run, deps); }
      if (Date.now() - t > (deps.pollTimeoutMs ?? 10 * 60_000)) return fail(dir, run, 'POLL_TIMEOUT', `Still ${status} after ${Math.round((Date.now() - t) / 60_000)} minutes. Request ${requestId} is saved; use Resume (no resubmission).`, deps);
      await sleep(deps.pollIntervalMs ?? 3000);
    }
    try { raw = await transport.result(SEEDREAM_ENDPOINT, requestId); }
    catch (error) {
      // A 400/422 result is fal's final answer for this request: Resume re-reads it for free but gets the same error.
      const final = error instanceof ProviderError && (error.status === 400 || error.status === 422);
      // The safety checker withheld the result: not a decomposition failure, and not retryable with another prompt.
      if (final && isSafetyRejection(providerFailure(error))) return fail(dir, run, 'PROVIDER_SAFETY_REJECTED', `${describe(error)}. ${safetyExplanation(requestId)}`, deps, error);
      // 422 after a completed request: the model ran and rejected the decomposition. Nothing is retried automatically.
      if (error instanceof ProviderError && error.status === 422) {
        const partner = isPartnerValidationFailure(providerFailure(error)) ? ` fal labels this content_policy_violation, but its reason is ${PARTNER_VALIDATION_FAILED}: the provider's own validation rejected the decomposition after inference. It is not a safety flag on the image (the same request on the same image has both passed and failed).` : '';
        return fail(dir, run, 'PROVIDER_DECOMPOSITION_REJECTED', `${describe(error)}.${partner} Seedream completed inference but did not produce a valid decomposition for this image/prompt combination. This can be transient. fal rejected the decomposition; this stored result is final for request ${requestId}, so Resume returns the same error. The output layer count is never sent to Seedream, so it is not the cause. Nothing was retried automatically; an explicit retry is one new paid Seedream call.`, deps, error);
      }
      return fail(dir, run, 'FAL_RESULT_FAILED', `${describe(error)}. Request ${requestId} is saved; ${final ? 'this result is final, so Resume would return the same error' : 'use Resume'}.`, deps, error);
    }
    json(dir, 'seedream-response.json', raw);
    run.seedream.completedAt = new Date().toISOString();
    run.seedream.queueToResultMs = run.timings.seedreamMs = Date.now() - t;
  }
  run.stage = 'downloading'; save(dir, run, deps);
  try {
    const t = Date.now();
    // The uploaded (orientation-normalized) image is the best source of real outer-background pixels.
    const sourceImage = existsSync(join(dir, run.input.file)) ? readFileSync(join(dir, run.input.file)) : undefined;
    const template = requireTemplate(templateKeyOf(run));
    const rendered = await renderLayerizeOutputs(dir, raw, url => transport.download(url), { sourceImage, rebuildOuterBackground: !run.semanticPlanning && template.outerBackgroundRebuild });
    run.timings.renderMs = Date.now() - t;
    // The recursive refinement (refined runs only): residual passes and a clean background replace the rendered layers.
    // Its failure never fails the run: the initial decomposition stays as rendered, with a warning.
    let refineWarnings: string[] = [];
    // Protected people and interactions: worn ornaments, finger fragments and risky held objects stay with their person.
    // Image-aware and refined runs only; a user who asked for a separate held object (Template A's checkbox) keeps it.
    const interactions = { semantic: run.planner?.semantic_analysis, options: { heldObjects: !(template.grouping && run.separateHeldObject !== false && !run.semanticPlanning) } };
    if (run.semanticPlanning && !run.refinement) {
      const protectedLayers = await protectRenderedLayers({ dir, canvas: rendered.canvas, layers: rendered.layers, warnings: rendered.warnings, read: file => readFileSync(join(dir, file)), sourceImage, ...interactions });
      rendered.layers = protectedLayers.layers; run.interactions = protectedLayers.record;
    }
    if (run.refinement) {
      callsOf(run); run.stage = 'refining'; save(dir, run, deps);
      const r = Date.now();
      try {
        const refined = await refineDecomposition({ dir, run, canvas: rendered.canvas, layers: rendered.layers, renderWarnings: rendered.warnings, sourceImage, transport, deps, allowNewCalls: fresh, save: () => save(dir, run, deps), interactions });
        rendered.layers = refined.layers; refineWarnings = refined.warnings;
      } catch (error) {
        Object.assign(run.refinement, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
        refineWarnings = [`REFINEMENT_FAILED: ${error instanceof Error ? error.message : String(error)}. The initial decomposition is kept as rendered.`];
      }
      run.timings.refineMs = Date.now() - r;
    }
    // Exact output layer count: local and deterministic, from the semantic layers; no provider call.
    // Template B finds its main product through the planner's hero (its first planned layer); Template A's merge ignores it.
    const plannedLayers = template.normalization === 'template-b' ? plannedLayersOf(run) : undefined;
    // Template C classifies with its own roles, from the planned layers its prompt was written from.
    const roleStrategy = template.normalization === 'template-c' ? templateCRoleStrategy(plannedLayersOf(run) as PlannedCLayer[] | undefined) : undefined;
    const normalized = await normalizeLayerCount(dir, rendered.canvas, rendered.layers, run.semanticPlanning ? undefined : run.layerTarget, run.semanticPlanning ? {} : { strategy: template.normalization, separate: run.separateHeldObject !== false, ...(plannedLayers ? { plannedLayers } : {}), ...(roleStrategy ? { roleStrategy } : {}) });
    Object.assign(run, { canvas: rendered.canvas, layers: rendered.layers, outputLayers: normalized.outputLayers, layerCount: normalized.layerCount,
      warnings: [...new Set([...run.warnings.filter(w => !/^(UNRESOLVED_PLACEMENT|NO_BASE|NO_Z0|BASE_ASPECT|FEWER_LAYERS_THAN_TARGET|UNPLACED_LAYERS_EXCLUDED|RECURSIVE_DECOMPOSITION|RESIDUAL_|BACKGROUND_|REFINEMENT_|ORDER_CYCLE|PROTECTED_)/.test(w)), ...rendered.warnings, ...refineWarnings, ...normalized.layerCount.warnings])] });
    const inAspect = run.input.width / run.input.height, outAspect = rendered.canvas.width / rendered.canvas.height;
    if (Math.abs(outAspect / inAspect - 1) > 0.01) run.warnings.push(`BASE_ASPECT_DIFFERS: base ${rendered.canvas.width}×${rendered.canvas.height} vs input ${run.input.width}×${run.input.height}.`);
  } catch (error) { return fail(dir, run, 'RENDER_FAILED', `${error instanceof Error ? error.message : String(error)}. The raw response is saved; use Resume to retry without a new paid call.`, deps); }
  delete run.error;
  run.stage = 'done';
  save(dir, run, deps);
  return run;
}

/**
 * Recovers a run from its saved response or saved fal request ID. Never plans again and never submits. A request ID
 * may be supplied only when the run has none (a submission whose response was lost); an existing one is never replaced.
 * `targetLayers` re-renders at another exact output layer count from the same saved result.
 */
export async function resumeRun(dir: string, deps: RunnerDeps, requestId?: string, options: { targetLayers?: number } = {}): Promise<RunRecord> {
  const run = readRun(dir);
  if (options.targetLayers !== undefined) run.layerTarget = retargetLayers(run, options.targetLayers);
  if (['planning', 'uploading', 'submitting'].includes(run.stage) && !run.seedream.requestId && !requestId) throw new RunError('RUN_ACTIVE_OR_AMBIGUOUS', `The run is at "${run.stage}" with no saved request ID. Nothing to recover automatically.`);
  if (requestId) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(requestId)) throw new RunError('INVALID_REQUEST_ID', 'Invalid fal request ID.');
    if (run.seedream.requestId && run.seedream.requestId !== requestId) throw new RunError('REQUEST_ID_MISMATCH', `This run already has request ${run.seedream.requestId}.`);
    run.seedream.requestId = requestId;
  }
  if (!run.seedream.requestId) throw new RunError('NO_REQUEST_ID', 'This run never reached fal (no request ID saved). Start a new run explicitly; resume never submits.');
  return collect(dir, run, deps);
}

/**
 * An explicit, user-triggered retry of a run Seedream rejected (PROVIDER_DECOMPOSITION_REJECTED): a NEW run with the same
 * uploaded image, template, grouping and target, with no OpenAI call. 'current' reuses the rejected run's base prompt with
 * the current provider rules; 'auto' (Template B only) sends an empty prompt, Seedream's automatic major-elements mode.
 * Returns the new run; the caller executes it (one new paid Seedream call). Never called automatically. A safety-checker
 * rejection is not retryable: the same image would be checked again.
 */
export async function createRetryRun(runsDir: string, failedDir: string, providerPrompt: RetryPrompt = 'current'): Promise<{ dir: string; run: RunRecord }> {
  const failed = readRun(failedDir), prompt = basePromptOf(failed);
  if (failed.error?.code === 'PROVIDER_SAFETY_REJECTED') throw new RunError('NOT_RETRYABLE', 'fal\'s safety checker rejected this image (PROVIDER_SAFETY_REJECTED). It is not retried with another prompt: the same image would be checked again. Try a different image.');
  if (failed.stage !== 'failed' || failed.error?.code !== 'PROVIDER_DECOMPOSITION_REJECTED') throw new RunError('NOT_RETRYABLE', 'Only a run Seedream rejected (PROVIDER_DECOMPOSITION_REJECTED) can be retried this way.');
  if (providerPrompt !== 'current' && providerPrompt !== 'auto') throw new RunError('INVALID_RETRY', 'providerPrompt must be "current" or "auto".');
  const template = requireTemplate(templateKeyOf(failed));
  if (providerPrompt === 'auto' && !template.emptyPromptRetry) throw new RunError('NOT_RETRYABLE', 'The automatic major-elements retry (empty prompt) is only available for Template B.');
  if (providerPrompt === 'current' && template.providerPrompt === 'automatic') throw new RunError('NOT_RETRYABLE', `${template.name} sends Seedream no prompt; retry with the automatic major-elements mode instead.`);
  const options = { ...(failed.semanticPlanning ? { semanticPlanning: true } : {}), ...(failed.refinement ? { refinement: failed.refinement.options } : {}), templateKey: template.key, separateHeldObject: failed.separateHeldObject !== false, ...(failed.layerTarget ? { layerTarget: { ...failed.layerTarget } } : {}),
    ...(failed.templateOptions ? { templateOptions: { ...failed.templateOptions } } : {}) };
  const image = readFileSync(join(failedDir, failed.original.file));
  if (providerPrompt === 'auto') return createRun(runsDir, image, { mode: 'automatic', retryOf: failed.id }, options);
  if (!prompt) throw new RunError('NOT_RETRYABLE', 'The rejected run has no prompt to retry with.');
  const plan = failed.promptSource?.mode === 'template' || failed.promptSource?.mode === 'retry' ? failed.promptSource : failed.planner!;
  return createRun(runsDir, image, { mode: 'retry', fromRunId: failed.id, prompt, planned_layers: plan.planned_layers, warnings: plan.warnings }, options);
}

export function listRuns(runsDir: string): RunRecord[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter(validRunId).filter(id => existsSync(join(runsDir, id, 'run.json'))).sort().reverse().slice(0, 20).map(id => readRun(join(runsDir, id)));
}

/**
 * The template fit check is off in this experiment: the developer picks the template, and it is trusted (no extra
 * OpenAI call before the planner). LAYERIZE_FIT_CHECK=1 turns it back on; the check itself is unchanged.
 */
export const fitCheckEnabled = (env = process.env) => env.LAYERIZE_FIT_CHECK === '1';
export function liveDeps(env = process.env): RunnerDeps {
  return { planner: createOpenAIPlanner({ apiKey: env.OPENAI_API_KEY, model: decompositionPlannerModel(env) }),
    ...(fitCheckEnabled(env) ? { fitCheck: createOpenAIFitChecker({ apiKey: env.OPENAI_API_KEY, model: plannerModel(env) }) } : {}),
    transport: () => createFalTransport(env.FAL_KEY ?? ''), backgroundReconstructor: liveBackgroundReconstructor(env) };
}
/** OpenAI's image edit for the refinement's clean background; a misconfigured model fails that one step (a fallback), not the run. */
function liveBackgroundReconstructor(env = process.env): BackgroundReconstructor {
  let model = '';
  try { model = imageModel(env); } catch { /* reported when the edit is attempted */ }
  return createOpenAIBackgroundReconstructor({ apiKey: env.OPENAI_API_KEY, model });
}

async function main() {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const log = (run: RunRecord) => console.info(`[${new Date().toISOString()}] ${run.stage}${run.seedream.requestId ? ` (fal ${run.seedream.requestId})` : ''}${run.error ? `: ${run.error.code} ${run.error.message}` : ''}`);
  const deps = { ...liveDeps(), onUpdate: log };
  const saveTemplate = arg('save-template');
  if (saveTemplate) {
    const saved = saveTemplatePrompt(resolve(arg('out') ?? DEFAULT_RUNS_DIR), saveTemplate, arg('run') ?? '', arg('notes'));
    console.info(`Saved ${saved.templateName} prompt from run ${saved.sourceRunId} (${saved.prompt.length} chars):\n${saved.prompt}`);
    return;
  }
  const resume = arg('resume');
  let run: RunRecord, dir: string;
  const targetLayers = arg('target-layers') === undefined ? undefined : Number(arg('target-layers'));
  if (resume) { dir = resolve(resume); run = await resumeRun(dir, deps, arg('request-id'), { targetLayers }); }
  else {
    const image = arg('image');
    if (!image) throw new Error('Pass --image <file> (one OpenAI call and one paid Seedream call) or --resume <run dir>.');
    const runsDir = resolve(arg('out') ?? DEFAULT_RUNS_DIR), template = arg('template'), separateHeldObject = !process.argv.includes('--combine-held-object');
    // --template <key> reuses that template's saved prompt; --template-key <key> generates a prompt for that template.
    const templateKey = template ?? arg('template-key') ?? 'template-a';
    const layerTarget = { templateKey, suggestedLayers: suggestedLayerCount(templateKey, separateHeldObject), ...(targetLayers !== undefined ? { targetLayers } : {}) };
    // --template-options '{"separateTouchingIndependentObjects":true}': the template's own options (Template B).
    const templateOptions = arg('template-options') === undefined ? undefined : JSON.parse(arg('template-options')!) as unknown;
    // --recursive: the recursive refinement (up to 2 residual Seedream calls and 1 OpenAI image edit, only when needed).
    ({ dir } = await createRun(runsDir, readFileSync(resolve(image)), template ? { mode: 'template', ...getTemplatePrompt(runsDir, template) } : { mode: 'generated' }, { separateHeldObject, layerTarget, templateKey, templateOptions, skipFitCheck: process.argv.includes('--skip-fit-check'), refinement: process.argv.includes('--recursive') }));
    run = await executeRun(dir, deps);
  }
  console.info(`\nRun folder: ${dir}`);
  if (run.templateFit) console.info(`Template fit: ${run.templateFit.fits ? 'fits' : 'does not fit'} (${run.templateFit.reason})`);
  else if (run.skipFitCheck) console.info('Template fit: not checked (--skip-fit-check)');
  if (run.promptSource?.mode === 'template') console.info(`Prompt source: ${run.promptSource.templateName} saved prompt (from run ${run.promptSource.sourceRunId}, saved ${run.promptSource.savedAt}); OpenAI not called.`);
  else if (run.promptSource?.mode === 'automatic') console.info(`Prompt source: none. Seedream automatic major elements (empty prompt); OpenAI not called.${run.promptSource.retryOf ? ` Explicit retry of run ${run.promptSource.retryOf}.` : ''}`);
  else if (run.planner) console.info(`Prompt source: OpenAI generated. Planner ${run.planner.model} (${run.planner.responseId}), usage ${JSON.stringify(run.planner.usage)}`);
  if (run.calls) console.info(`Provider calls:\n  ${callLines(run.calls).join('\n  ')}`);
  if (run.refinement) console.info(`Recursive refinement: ${run.refinement.passesExecuted ?? 1} pass(es), stopped: ${run.refinement.stopReason ?? run.refinement.state}; background ${run.refinement.background?.status ?? '-'} (${run.refinement.background?.method ?? '-'})`);
  if (run.templateOptions) console.info(`Template options: ${JSON.stringify(run.templateOptions)}`);
  else console.info(`Held object mode: ${run.separateHeldObject === false ? 'combined with subject' : 'separate'}`);
  const count = run.layerCount;
  if (count) console.info(`Layers: suggested ${count.suggestedLayers ?? '-'} · target ${count.targetLayers ?? '-'} · provider returned ${count.providerReturnedLayers} · final output ${count.finalOutputLayers}${count.normalized ? `\n  ${count.groups.map(g => `${g.name} [${g.sourceLayers.join(' + ')}]`).join('\n  ')}` : ''}`);
  const prompt = promptOf(run);
  if (prompt) console.info(`Prompt sent to Seedream (${prompt.length} chars):\n${prompt}\n`);
  if (run.layers) console.table(run.layers.map(l => ({ z: l.zIndex, name: l.name ?? '', size: `${l.pixelWidth}x${l.pixelHeight}`, placement: l.placement.kind, opaque: l.opaquePercent })));
  for (const warning of run.warnings) console.warn(warning);
  console.info(JSON.stringify({ stage: run.stage, requestId: run.seedream.requestId, timings: run.timings, error: run.error }, null, 2));
  if (run.stage === 'failed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
