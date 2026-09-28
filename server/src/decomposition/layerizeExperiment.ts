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
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildProviderInput, endpointRegistry } from './providers/adapters.js';
import type { FalTransport } from './providers/falClient.js';
import { createFalTransport } from './providers/falClient.js';
import { renderLayerizeOutputs, type Canvas, type LayerInfo } from './layerizeArtifacts.js';
import { createOpenAIPlanner, PlannerError, type LayerizePlan, type Planner, type PlannerUsage } from './layerizePlanner.js';

export const SEEDREAM_ENDPOINT = endpointRegistry.seedream.endpoint;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RUNS_DIR = resolve(here, '../../../artifacts/decomposition/layerize-experiment');

export type Stage = 'uploaded' | 'planning' | 'planned' | 'uploading' | 'submitting' | 'queued' | 'in_progress' | 'downloading' | 'done' | 'failed';
export type RunRecord = {
  id: string; createdAt: string; updatedAt: string; stage: Stage;
  error?: { code: string; message: string; stage: Stage };
  original: { file: string; mime: string; width: number; height: number; bytes: number };
  input: { file: string; mime: string; width: number; height: number; orientationNormalized: boolean };
  planner?: { model: string; responseId?: string; usage?: PlannerUsage; durationMs: number } & LayerizePlan;
  seedream: { endpoint: string; input?: Record<string, unknown>; requestId?: string; status?: string; submittedAt?: string; completedAt?: string; queueToResultMs?: number };
  timings: Record<string, number>;
  canvas?: Canvas; layers?: LayerInfo[]; warnings: string[];
};
export type RunnerDeps = {
  planner: Planner;
  /** Lazily created so a missing FAL_KEY fails at submission time, after the plan is saved. */
  transport: () => FalTransport;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number; pollTimeoutMs?: number;
  onUpdate?: (run: RunRecord) => void;
};

export class RunError extends Error { constructor(public readonly code: string, message: string) { super(message); this.name = 'RunError'; } }
const RUN_ID = /^[0-9TZ-]+-[a-f0-9]{6}$/;
export const validRunId = (id: string) => RUN_ID.test(id);

const json = (dir: string, file: string, value: unknown) => writeFileSync(join(dir, file), JSON.stringify(value, null, 2));
export const readRun = (dir: string) => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunRecord;
function save(dir: string, run: RunRecord, deps?: Pick<RunnerDeps, 'onUpdate'>) {
  run.updatedAt = new Date().toISOString();
  json(dir, 'run.json', run);
  deps?.onUpdate?.(run);
}
function fail(dir: string, run: RunRecord, code: string, message: string, deps?: Pick<RunnerDeps, 'onUpdate'>) {
  run.error = { code, message, stage: run.stage };
  run.stage = 'failed';
  save(dir, run, deps);
  return run;
}

/**
 * Saves the original upload untouched and prepares the one image both providers receive: EXIF orientation applied
 * (as PNG) only when needed, otherwise the original bytes. Rejects sizes Seedream cannot accept before any call.
 */
export async function createRun(runsDir: string, bytes: Buffer): Promise<{ dir: string; run: RunRecord }> {
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
  const run: RunRecord = { id, createdAt: now, updatedAt: now, stage: 'uploaded',
    original: { file: `original.${ext}`, mime, width: meta.width, height: meta.height, bytes: bytes.length },
    input: { file: inputFile, mime: rotate ? 'image/png' : mime, width: inputMeta.width!, height: inputMeta.height!, orientationNormalized: rotate },
    seedream: { endpoint: SEEDREAM_ENDPOINT }, timings: {}, warnings: [] };
  save(dir, run);
  return { dir, run };
}

/** Plan → one Seedream submission → poll → save → render. Planner failure means zero fal calls. */
export async function executeRun(dir: string, deps: RunnerDeps): Promise<RunRecord> {
  const run = readRun(dir);
  if (run.stage !== 'uploaded') throw new RunError('RUN_ALREADY_STARTED', `This run is already ${run.stage}. Use resume instead; a run is never submitted twice.`);
  const started = Date.now();
  const image = readFileSync(join(dir, run.input.file));
  run.stage = 'planning'; save(dir, run, deps);
  try {
    const t = Date.now();
    const result = await deps.planner(image, run.input.mime);
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
  let input: Record<string, unknown>;
  try { input = buildProviderInput('seedream', { imageUrl: 'https://fal.media/placeholder-until-upload', prompt: run.planner.prompt, imageSize: 'auto', enhancePromptMode: 'standard', width: run.input.width, height: run.input.height }); }
  catch (error) { return fail(dir, run, 'INVALID_SEEDREAM_INPUT', error instanceof Error ? error.message : String(error), deps); }
  let transport: FalTransport, imageUrl: string;
  try {
    transport = deps.transport();
    run.stage = 'uploading'; save(dir, run, deps);
    const t = Date.now();
    imageUrl = await transport.upload(image, run.input.mime);
    run.timings.uploadMs = Date.now() - t;
  } catch (error) { return fail(dir, run, 'FAL_UPLOAD_FAILED', `${error instanceof Error ? error.message : String(error)} (nothing was submitted)`, deps); }
  run.seedream.input = { ...input, image_url: `<fal upload of ${run.input.file}, ${run.input.width}x${run.input.height}>` };
  json(dir, 'seedream-request.json', { endpoint: SEEDREAM_ENDPOINT, input: run.seedream.input });
  run.stage = 'submitting'; save(dir, run, deps);
  try {
    const { requestId } = await transport.submit(SEEDREAM_ENDPOINT, { ...input, image_url: imageUrl });
    // Persist the request ID before anything else can fail.
    run.seedream.requestId = requestId; run.seedream.submittedAt = new Date().toISOString(); run.stage = 'queued';
    json(dir, 'seedream-request.json', { endpoint: SEEDREAM_ENDPOINT, requestId, input: run.seedream.input });
    save(dir, run, deps);
  } catch (error) {
    const status = (error as { status?: number }).status;
    return fail(dir, run, 'FAL_SUBMIT_FAILED', `${error instanceof Error ? error.message : String(error)}${status ? ` (HTTP ${status})` : ''}. No request ID was returned; if fal accepted it anyway, check the fal dashboard and resume with --request-id. Not resubmitted.`, deps);
  }
  const done = await collect(dir, run, deps);
  done.timings.totalMs = Date.now() - started;
  save(dir, done, deps);
  return done;
}

/** Poll (never submit) the saved request, save the raw response, then download and render. */
async function collect(dir: string, run: RunRecord, deps: RunnerDeps): Promise<RunRecord> {
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
        if (++lookupFailures >= 3) return fail(dir, run, 'FAL_STATUS_FAILED', `${error instanceof Error ? error.message : String(error)}. Request ${requestId} is saved; resume later (no resubmission).`, deps);
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
    catch (error) { return fail(dir, run, 'FAL_RESULT_FAILED', `${error instanceof Error ? error.message : String(error)}. Request ${requestId} is saved; use Resume.`, deps); }
    json(dir, 'seedream-response.json', raw);
    run.seedream.completedAt = new Date().toISOString();
    run.seedream.queueToResultMs = run.timings.seedreamMs = Date.now() - t;
  }
  run.stage = 'downloading'; save(dir, run, deps);
  try {
    const t = Date.now();
    const rendered = await renderLayerizeOutputs(dir, raw, url => transport.download(url));
    run.timings.renderMs = Date.now() - t;
    Object.assign(run, { canvas: rendered.canvas, layers: rendered.layers, warnings: [...new Set([...run.warnings.filter(w => !/^(UNRESOLVED_PLACEMENT|NO_BASE|NO_Z0|BASE_ASPECT)/.test(w)), ...rendered.warnings])] });
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

export function listRuns(runsDir: string): RunRecord[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter(validRunId).filter(id => existsSync(join(runsDir, id, 'run.json'))).sort().reverse().slice(0, 20).map(id => readRun(join(runsDir, id)));
}

export function liveDeps(env = process.env): RunnerDeps {
  return { planner: createOpenAIPlanner({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_DECOMPOSITION_MODEL }), transport: () => createFalTransport(env.FAL_KEY ?? '') };
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
    if (!image) throw new Error('Pass --image <file> (one OpenAI call and one paid Seedream call) or --resume <run dir>.');
    ({ dir } = await createRun(resolve(arg('out') ?? DEFAULT_RUNS_DIR), readFileSync(resolve(image))));
    run = await executeRun(dir, deps);
  }
  console.info(`\nRun folder: ${dir}`);
  if (run.planner) console.info(`Planner ${run.planner.model} (${run.planner.responseId}), usage ${JSON.stringify(run.planner.usage)}\nPrompt (${run.planner.prompt.length} chars):\n${run.planner.prompt}\n`);
  if (run.layers) console.table(run.layers.map(l => ({ z: l.zIndex, name: l.name ?? '', size: `${l.pixelWidth}x${l.pixelHeight}`, placement: l.placement.kind, opaque: l.opaquePercent })));
  for (const warning of run.warnings) console.warn(warning);
  console.info(JSON.stringify({ stage: run.stage, requestId: run.seedream.requestId, timings: run.timings, error: run.error }, null, 2));
  if (run.stage === 'failed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
