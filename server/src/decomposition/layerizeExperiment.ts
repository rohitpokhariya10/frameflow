/**
 * OpenAI → Seedream decomposition runs. One image: the GPT planner analyzes it (or a creative template's saved plan, or a
 * rejected run's own plan, is reused without the planner), the same (orientation-normalized) image and that plan's
 * prompt go to fal `bytedance/seedream/v5/pro/layerize` exactly once, and every returned layer is saved, placed on the
 * base canvas, protected (people and what they hold) and, for refined runs, cleaned recursively. Standalone: no job,
 * worker, database or other model.
 *
 * Each run is a folder with run.json plus its artifacts. The planner output is saved before Seedream starts, the fal
 * request ID is saved the moment it exists, and nothing is ever resubmitted: timeouts and download failures are
 * recovered with resumeRun (saved response or saved request ID, no new paid call).
 *
 *   npm run decomp:layerize-experiment -w @frameflow/server -- --image ../offer.png [--recursive]   (one planner call + one paid Seedream call)
 *   npm run decomp:layerize-experiment -w @frameflow/server -- --resume <run dir> [--request-id <fal id>]
 *
 * A run made by a template execution (creativeTemplates/) records it; the execution's mode decides whether the planner
 * may be called at all, and createRun / executeRun refuse a planner call that mode forbids.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildProviderInput, endpointRegistry, ProviderError, type ProviderErrorDetail } from './providers/adapters.js';
import type { FalTransport } from './providers/falClient.js';
import { createFalTransport } from './providers/falClient.js';
import { decompositionPlannerModel, imageModel } from './aiModels.js';
import { renderLayerizeOutputs, type Canvas, type LayerInfo } from './layerizeArtifacts.js';
import { normalizeLayerCount, type LayerCount, type OutputLayer } from './layerCount.js';
import { createOpenAIPlanner, PlannerError, validatePlan, type LayerizePlan, type Planner, type PlannerUsage } from './layerizePlanner.js';
import { semanticPlan, type TemplateCapture } from './semanticPlanner.js';
import { createOpenAIBackgroundReconstructor, type BackgroundReconstructor } from './cleanBackground.js';
import { protectRenderedLayers, type InteractionRecord } from './interactionGrouping.js';
import { callLines, newRefinementRecord, noCalls, refineDecomposition, refinementOptions, type CallCounts, type RefinementOptions, type RefinementRecord } from './recursiveDecomposition.js';
import { EXECUTION_POLICY, type RunTemplateExecution } from '@frameflow/shared';
import { semanticAnalysisOf } from './runPlan.js';

export const SEEDREAM_ENDPOINT = endpointRegistry.seedream.endpoint;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RUNS_DIR = resolve(here, '../../../artifacts/decomposition/layerize-experiment');

/** 'refining': the recursive refinement (residual passes, clean background) of a run created with it. */
export type Stage = 'uploaded' | 'planning' | 'planned' | 'uploading' | 'submitting' | 'queued' | 'in_progress' | 'downloading' | 'refining' | 'done' | 'failed';
/**
 * Where the Seedream prompt comes from. `generated`: the planner analyzes this image. `retry`: an explicit user retry of a
 * rejected run, reusing that run's base prompt (the planner is not called again). `template-plan`: a creative template's
 * saved plan compiled for this run (creativeTemplates/compile.ts), the semantic plan without a planner call. Runs saved
 * before these modes may carry others in run.json; they are shown as recorded and never executed again.
 */
export type PromptSource = { mode: 'generated' }
  | ({ mode: 'retry'; fromRunId: string } & LayerizePlan)
  | ({ mode: 'template-plan'; templateId: string; templateName: string; version: number; compiledAt: string } & LayerizePlan);
export type RunRecord = {
  id: string; createdAt: string; updatedAt: string; stage: Stage;
  promptSource?: PromptSource;
  /** Every new run plans semantically (semanticPlanner.ts); runs saved before may lack it. */
  semanticPlanning?: boolean;
  /** The exact prompt sent to Seedream. Absent on older runs. */
  finalPrompt?: string;
  /** The run creates a template: its planner call also returns the template capture (creativeTemplates/). */
  templateCapture?: boolean;
  /** The template execution this run belongs to: its mode decides whether the planner may be called. */
  templateExecution?: RunTemplateExecution;
  /** `provider` is fal's own status and message for provider failures (sanitized; never the echoed input). */
  error?: { code: string; message: string; stage: Stage; provider?: ProviderFailure };
  original: { file: string; mime: string; width: number; height: number; bytes: number };
  input: { file: string; mime: string; width: number; height: number; orientationNormalized: boolean };
  planner?: { model: string; responseId?: string; usage?: PlannerUsage; durationMs: number; capture?: TemplateCapture } & LayerizePlan;
  seedream: { endpoint: string; input?: Record<string, unknown>; requestId?: string; status?: string; submittedAt?: string; completedAt?: string; queueToResultMs?: number };
  timings: Record<string, number>;
  /** layers: the semantic layers (Seedream's, with the rebuilt outer background). outputLayers: the final layers at the
   * target count (the same list when no target). layerCount: suggested / target / returned / final, and what was merged. */
  canvas?: Canvas; layers?: LayerInfo[]; outputLayers?: OutputLayer[]; layerCount?: LayerCount; warnings: string[];
  /**
   * Where the image came from, when not a direct upload. 'image-template': one size of a reference creative
   * (imageTemplates.ts; generationId is its group, variantId and aspectRatio the size). 'template-execution': a template
   * execution's upload or edited image (creativeTemplates/; generationId is the execution). Older runs may carry other kinds.
   */
  origin?: { kind: 'image-template' | 'template-execution'; generationId: string; variantId?: string; aspectRatio?: string };
  /**
   * The recursive refinement (recursiveDecomposition.ts): residual passes for objects the first decomposition left in
   * its base, then one clean background from the original. Its options are fixed when the run is created; absent on runs
   * without it (every older run), which are rendered exactly as before.
   */
  refinement?: RefinementRecord;
  /** Authoritative editor import selection; raw provider candidates live in the debug artifacts. */
  editorLayerFiles?: string[];
  /** Protected people and interactions (interactionGrouping.ts): every grouping decision. Image-aware and refined runs only. */
  interactions?: InteractionRecord;
  /** Every provider request this run sent, by kind, counted when sent. Recorded on refined runs only. */
  calls?: CallCounts;
};
export type RunnerDeps = {
  planner: Planner;
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
/** The saved plan a run reuses instead of the planner's. */
const savedPlan = (run: RunRecord) => run.promptSource?.mode === 'retry' || run.promptSource?.mode === 'template-plan' ? run.promptSource : undefined;
export const basePromptOf = (run: RunRecord) => savedPlan(run)?.prompt ?? run.planner?.prompt;
/** The planned layers behind that prompt, or undefined when none were planned. */
export const plannedLayersOf = (run: RunRecord) => savedPlan(run)?.planned_layers ?? run.planner?.planned_layers;
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
/** Persists a run record changed after its run finished. */
export const saveRunRecord = (dir: string, run: RunRecord) => save(dir, run);
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
 * Saves the original upload untouched and prepares the one image both providers receive: EXIF orientation applied
 * (as PNG) only when needed, otherwise the original bytes. Rejects sizes Seedream cannot accept before any call.
 */
export async function createRun(runsDir: string, bytes: Buffer, promptSource: PromptSource = { mode: 'generated' }, options: { origin?: RunRecord['origin']; refinement?: boolean | Partial<RefinementOptions>; templateExecution?: RunTemplateExecution; templateCapture?: boolean } = {}): Promise<{ dir: string; run: RunRecord }> {
  // The template execution's mode decides whether this run may plan: a reuse never reaches the planner.
  if (options.templateExecution) assertPlanningAllowed(options.templateExecution, promptSource);
  if (options.templateCapture && (promptSource.mode !== 'generated' || options.templateExecution?.mode !== 'CREATE_TEMPLATE')) throw new RunError('INVALID_TEMPLATE_CAPTURE', 'Only a template-creating run captures a template, from its own planner call.');
  if (promptSource.mode === 'template-plan' && !promptSource.semantic_analysis) throw new RunError('INVALID_TEMPLATE_PLAN', 'A template plan needs its compiled semantic analysis.');
  let refinement: RefinementOptions | undefined;
  try { refinement = refinementOptions(options.refinement); } catch (error) { throw new RunError('INVALID_REFINEMENT', error instanceof Error ? error.message : String(error)); }
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
  const run: RunRecord = { id, createdAt: now, updatedAt: now, semanticPlanning: true, stage: 'uploaded', promptSource,
    ...(options.templateCapture ? { templateCapture: true } : {}), ...(options.templateExecution ? { templateExecution: options.templateExecution } : {}),
    original: { file: `original.${ext}`, mime, width: meta.width, height: meta.height, bytes: bytes.length },
    input: { file: inputFile, mime: rotate ? 'image/png' : mime, width: inputMeta.width!, height: inputMeta.height!, orientationNormalized: rotate },
    seedream: { endpoint: SEEDREAM_ENDPOINT }, timings: {}, warnings: [], ...(options.origin ? { origin: options.origin } : {}), ...(refinement ? { refinement: newRefinementRecord(refinement), calls: noCalls() } : {}) };
  save(dir, run);
  return { dir, run };
}

/** A planner call a template execution's mode forbids is refused before anything is sent (reuse modes: never). */
export class PlannerNotAllowedError extends RunError {
  constructor(execution: RunTemplateExecution) { super('PLANNER_NOT_ALLOWED', `A ${execution.mode} execution never calls the GPT planner; it reuses its template's saved plan.`); this.name = 'PlannerNotAllowedError'; }
}
function assertPlanningAllowed(execution: RunTemplateExecution, promptSource: PromptSource | undefined) {
  // A reuse plans only when the user explicitly chose to refresh its decomposition plan (planRefresh).
  if ((promptSource?.mode ?? 'generated') === 'generated' && !EXECUTION_POLICY[execution.mode].planner && !execution.planRefresh) throw new PlannerNotAllowedError(execution);
}

/** Plan (or reuse a saved plan) → one Seedream submission → poll → save → render. Planner failure means zero fal calls. */
export async function executeRun(dir: string, deps: RunnerDeps): Promise<RunRecord> {
  const run = readRun(dir);
  if (run.stage !== 'uploaded') throw new RunError('RUN_ALREADY_STARTED', `This run is already ${run.stage}. Use resume instead; a run is never submitted twice.`);
  const started = Date.now();
  const image = readFileSync(join(dir, run.input.file));
  run.stage = 'planning'; save(dir, run, deps);
  const source = run.promptSource ?? { mode: 'generated' as const };
  if (source.mode === 'retry' || source.mode === 'template-plan') {
    // Reuse (an explicit retry, or a creative template's saved plan): the saved plan is the base; the planner is not called.
    try { validatePlan({ prompt: source.prompt, planned_layers: source.planned_layers, warnings: source.warnings }); }
    catch (error) { return fail(dir, run, 'INVALID_SAVED_PLAN', error instanceof Error ? error.message : String(error), deps); }
    json(dir, source.mode === 'template-plan' ? 'template-plan.json' : 'retry-prompt.json', source);
    writeFileSync(join(dir, 'prompt.txt'), source.prompt);
    run.stage = 'planned'; save(dir, run, deps);
  } else {
    try {
      if (run.templateExecution) assertPlanningAllowed(run.templateExecution, source);
      const t = Date.now();
      count(run, 'planner'); save(dir, run, deps);
      const result = await deps.planner(image, run.input.mime, run.templateCapture ? { templateCapture: true } : {});
      run.planner = { model: result.model, responseId: result.responseId, usage: result.usage, durationMs: Date.now() - t, ...(result.capture ? { capture: result.capture } : {}), ...result.plan };
      run.timings.plannerMs = run.planner.durationMs;
      json(dir, 'openai-request.json', result.request);
      json(dir, 'openai-response.json', result.raw);
      json(dir, 'plan.json', result.plan);
      writeFileSync(join(dir, 'prompt.txt'), result.plan.prompt);
      run.stage = 'planned'; save(dir, run, deps);
    } catch (error) {
      if (error instanceof PlannerError && error.raw !== undefined) json(dir, 'openai-response.json', error.raw);
      return fail(dir, run, error instanceof PlannerError || error instanceof RunError ? error.code : 'PLANNER_FAILED', error instanceof Error ? error.message : String(error), deps);
    }
  }
  try { run.finalPrompt = validatePlan({ prompt: basePromptOf(run), planned_layers: plannedLayersOf(run), warnings: [] }).prompt; }
  catch (error) { return fail(dir, run, error instanceof PlannerError ? error.code : 'INVALID_PLAN', error instanceof Error ? error.message : String(error), deps); }
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
      // A 422: fal refused this request. Whether the model ran is read from fal's own evidence, never assumed.
      if (error instanceof ProviderError && error.status === 422) {
        // What fal reported, nothing inferred: its error Date header is not when it decided (the queue reported the same
        // requests IN_PROGRESS for about a minute first), so it is no evidence of where in fal the request failed.
        const detail = providerFailure(error), partner = isPartnerValidationFailure(detail);
        const what = partner
          ? ` fal labels this content_policy_violation, but its reason is ${PARTNER_VALIDATION_FAILED}: the provider's own validation rejected the decomposition after inference. It is not a safety flag on the image (the same request on the same image has both passed and failed).`
          : ` Seedream did not produce a valid decomposition for this image/prompt combination.${detail?.billableUnits === '0' ? ' fal billed 0 units for it.' : ''} This can be transient.`;
        // How fine the plan was: rejections so far came with plans that split a photographic scene and text effects apart.
        const planned = plannedLayersOf(run)?.length, fine = planned ? ` The plan asked for ${planned} layers; a simpler grouping or a refreshed plan sends a different prompt, and plans that keep a photographic scene as one plate and text effects with their text have been accepted where finer ones were rejected.` : '';
        return fail(dir, run, 'PROVIDER_DECOMPOSITION_REJECTED', `${describe(error)}.${what}${fine} This is a layer-extraction failure, not an image-generation failure: any generated creative is kept. This stored result is final for request ${requestId}, so Resume returns the same error. The output layer count is never sent to Seedream, so it is not the cause. Nothing was retried automatically; an explicit retry is one new Seedream request.`, deps, error);
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
    const rendered = await renderLayerizeOutputs(dir, raw, url => transport.download(url));
    run.timings.renderMs = Date.now() - t;
    // The recursive refinement (refined runs only): residual passes and a clean background replace the rendered layers.
    // A failed curation must not publish raw provider internals as a finished editor result.
    let refineWarnings: string[] = [];
    // Protected people and interactions: worn ornaments, finger fragments and risky held objects stay with their person.
    const interactions = { semantic: semanticAnalysisOf(run), options: { heldObjects: true } };
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
        run.layers = []; run.outputLayers = []; run.editorLayerFiles = [];
        throw new Error(`Editor refinement failed: ${error instanceof Error ? error.message : String(error)}. Raw assets are saved; resume reprocesses them without new paid calls.`, { cause: error });
      }
      run.timings.refineMs = Date.now() - r;
    }
    const normalized = normalizeLayerCount(rendered.layers);
    Object.assign(run, { canvas: rendered.canvas, layers: rendered.layers, outputLayers: normalized.outputLayers, layerCount: normalized.layerCount,
      warnings: [...new Set([...run.warnings.filter(w => !/^(UNRESOLVED_PLACEMENT|NO_BASE|NO_Z0|BASE_ASPECT|FEWER_LAYERS_THAN_TARGET|UNPLACED_LAYERS_EXCLUDED|RECURSIVE_DECOMPOSITION|RESIDUAL_|BACKGROUND_|REFINEMENT_|ORDER_CYCLE|PROTECTED_|PLANNED_LAYER_|BACKDROP_)/.test(w)), ...rendered.warnings, ...refineWarnings, ...normalized.layerCount.warnings])] });
    if (run.refinement?.curation) {
      run.editorLayerFiles = normalized.outputLayers.map(l => l.file);
      run.layerCount!.providerReturnedLayers = run.refinement.curation.counts.providerLayers;
      for (const file of ['layers.json', 'decomposition-debug.json']) {
        const artifact = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        writeFileSync(join(dir, file), JSON.stringify({ ...artifact, editorLayerFiles: run.editorLayerFiles, outputLayers: normalized.outputLayers }, null, 2));
      }
    }
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
 */
export async function resumeRun(dir: string, deps: RunnerDeps, requestId?: string): Promise<RunRecord> {
  const run = readRun(dir);
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
 * uploaded image and the rejected run's own plan, with no planner call. Returns the new run; the caller executes it (one
 * new paid Seedream call). Never called automatically. A safety-checker rejection is not retryable: the same image would
 * be checked again. A template execution's run keeps its execution (a reuse retry still never plans).
 */
export async function createRetryRun(runsDir: string, failedDir: string): Promise<{ dir: string; run: RunRecord }> {
  const failed = readRun(failedDir);
  let prompt = basePromptOf(failed);
  if (failed.error?.code === 'PROVIDER_SAFETY_REJECTED') throw new RunError('NOT_RETRYABLE', 'fal\'s safety checker rejected this image (PROVIDER_SAFETY_REJECTED). It is not retried with another prompt: the same image would be checked again. Try a different image.');
  if (failed.stage !== 'failed' || failed.error?.code !== 'PROVIDER_DECOMPOSITION_REJECTED') throw new RunError('NOT_RETRYABLE', 'Only a run Seedream rejected (PROVIDER_DECOMPOSITION_REJECTED) can be retried this way.');
  const plan = savedPlan(failed) ?? failed.planner;
  if (!prompt || !plan) throw new RunError('NOT_RETRYABLE', 'The rejected run has no plan to retry with.');
  let repaired = false;
  // Repair old code-generated truncation only, using the already saved analysis. No planner, template change or
  // automatic retry. Keep the same independent layers; a changed inventory needs an explicit fresh plan instead.
  if (plan.semantic_analysis && plan.semantic_protection?.promptRebuilt && prompt.includes('…')) {
    const rebuilt = semanticPlan(plan.semantic_analysis);
    if (JSON.stringify(rebuilt.planned_layers.map(l => l.name)) !== JSON.stringify(plan.planned_layers.map(l => l.name)))
      throw new RunError('SAVED_PLAN_CHANGED', 'The saved layer inventory cannot be repaired unchanged. Choose Plan fresh explicitly.');
    prompt = validatePlan(rebuilt).prompt;
    repaired = true;
  }
  const image = readFileSync(join(failedDir, failed.original.file));
  const created = await createRun(runsDir, image, { mode: 'retry', fromRunId: failed.id, prompt, planned_layers: plan.planned_layers, warnings: plan.warnings, ...(plan.semantic_analysis ? { semantic_analysis: plan.semantic_analysis } : {}), ...(plan.semantic_protection ? { semantic_protection: plan.semantic_protection } : {}) },
    { ...(failed.refinement ? { refinement: failed.refinement.options } : {}), ...(failed.origin ? { origin: failed.origin } : {}), ...(failed.templateExecution ? { templateExecution: failed.templateExecution } : {}) });
  if (repaired) {
    created.run.warnings.push('PROMPT_REPAIRED_LOCALLY: Rebuilt incomplete instructions from the saved analysis; the layer inventory is unchanged and no planner was called.');
    save(created.dir, created.run);
  }
  return created;
}

export function listRuns(runsDir: string): RunRecord[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter(validRunId).filter(id => existsSync(join(runsDir, id, 'run.json'))).sort().reverse().slice(0, 20).map(id => readRun(join(runsDir, id)));
}

export function liveDeps(env = process.env): RunnerDeps {
  return { planner: createOpenAIPlanner({ apiKey: env.OPENAI_API_KEY, model: decompositionPlannerModel(env) }), transport: () => createFalTransport(env.FAL_KEY ?? ''), backgroundReconstructor: liveBackgroundReconstructor(env) };
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
  const resume = arg('resume');
  let run: RunRecord, dir: string;
  if (resume) { dir = resolve(resume); run = await resumeRun(dir, deps, arg('request-id')); }
  else {
    const image = arg('image');
    if (!image) throw new Error('Pass --image <file> (one planner call and one paid Seedream call) or --resume <run dir>.');
    // --recursive: the recursive refinement (up to 2 residual Seedream calls and 1 OpenAI image edit, only when needed).
    ({ dir } = await createRun(resolve(arg('out') ?? DEFAULT_RUNS_DIR), readFileSync(resolve(image)), { mode: 'generated' }, { refinement: process.argv.includes('--recursive') }));
    run = await executeRun(dir, deps);
  }
  console.info(`\nRun folder: ${dir}`);
  if (run.planner) console.info(`Prompt source: planner ${run.planner.model} (${run.planner.responseId}), usage ${JSON.stringify(run.planner.usage)}`);
  if (run.calls) console.info(`Provider calls:\n  ${callLines(run.calls).join('\n  ')}`);
  if (run.refinement) console.info(`Recursive refinement: ${run.refinement.passesExecuted ?? 1} pass(es), stopped: ${run.refinement.stopReason ?? run.refinement.state}; background ${run.refinement.background?.status ?? '-'} (${run.refinement.background?.method ?? '-'})`);
  if (run.layerCount) console.info(`Layers: provider returned ${run.layerCount.providerReturnedLayers} · final output ${run.layerCount.finalOutputLayers}`);
  const prompt = promptOf(run);
  if (prompt) console.info(`Prompt sent to Seedream (${prompt.length} chars):\n${prompt}\n`);
  if (run.layers) console.table(run.layers.map(l => ({ z: l.zIndex, name: l.name ?? '', size: `${l.pixelWidth}x${l.pixelHeight}`, placement: l.placement.kind, opaque: l.opaquePercent })));
  for (const warning of run.warnings) console.warn(warning);
  console.info(JSON.stringify({ stage: run.stage, requestId: run.seedream.requestId, timings: run.timings, error: run.error }, null, 2));
  if (run.stage === 'failed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
