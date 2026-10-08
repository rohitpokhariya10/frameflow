/**
 * HTTP surface for OpenAI → Seedream decomposition: direct test runs (Decompose/Test), reference creatives
 * (imageTemplates.ts) and creative templates (creativeTemplates/). Mounted only with LAYERIZE_EXPERIMENT=1, in
 * development and in production alike. It spends paid API credit and has no login, so it only answers its own
 * frontend: a direct request on this machine in development, or, behind a proxy, a request the browser marks as coming
 * from the app's own origin (see experimentAccess). One decomposition at a time; runs execute in-process, no worker.
 *
 * A direct run takes one generic option as a form field: recursive (true | false, default false: the recursive
 * refinement, recursiveDecomposition.ts, residual Seedream passes and one clean background, only as needed).
 */
import express, { type Request, type RequestHandler, type Router } from 'express';
import busboy from 'busboy';
import { ZipArchive } from 'archiver';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRetryRun, createRun, DEFAULT_RUNS_DIR, executeRun, liveDeps, listRuns, MAX_UPLOAD_BYTES, readRun, resumeRun, RunError, validRunId, type RunnerDeps } from './layerizeExperiment.js';
import { liveGenerationConfig, type GenerationConfig } from './generationGroups.js';
import { DEFAULT_IMAGE_TEMPLATES_DIR, liveImagePromptWriter, registerImageTemplateRoutes, type ImagePromptWriter } from './imageTemplates.js';
import { DEFAULT_EXECUTIONS_DIR, fileExecutionStore } from './creativeTemplates/executions.js';
import { registerCreativeTemplateRoutes } from './creativeTemplates/routes.js';
import { createTemplateExecutions } from './creativeTemplates/service.js';
import { liveStructureInspector, type StructureInspector } from './creativeTemplates/inspect.js';
import { DEFAULT_TEMPLATES_DIR, fileTemplateStore } from './creativeTemplates/store.js';
import { DEFAULT_ANALYSES_DIR, DEFAULT_VARIANTS_DIR, fileSceneStore, fileVariantStore } from './creativeTemplates/smartStores.js';
import { createSmartCreative, readSmartFeatures, type SmartFeatures, type SmartProviders } from './creativeTemplates/smartCreative.js';
import { liveChangeResolver, liveConceptWriter, liveSceneAnalyzer, liveSemanticVerifier } from './creativeTemplates/smartProviders.js';
import { liveSegmenter } from './creativeTemplates/segmenter.js';
import { registerSmartCreativeRoutes } from './creativeTemplates/smartRoutes.js';
import { cutoutProvider } from './aiModels.js';
import { readRunDiagnostics } from './runDiagnostics.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const FILE = /^[a-z0-9-]+\.(png|jpg|webp|json|txt)$/;

/** Off unless explicitly turned on, whatever the environment. */
export function layerizeExperimentEnabled(env = process.env) { return env.LAYERIZE_EXPERIMENT === '1'; }

/** clientOrigin: the deployed app's own origin (CLIENT_ORIGIN). production: NODE_ENV is production. */
export type ExperimentAccess = { clientOrigin?: string; production?: boolean };
const refuse = (message: string) => ({ error: { code: 'ORIGIN_DENIED', message } });
/**
 * Who may use the experiment.
 *
 * In development, a direct request on this machine (a loopback peer that no proxy forwarded: the Vite proxy or a local
 * browser) is answered, as it always was. That is never assumed in production, where the peer is a proxy.
 *
 * Every other request has to come from the app's own frontend, as the browser states it:
 *   - a request that changes something (every POST; these are the ones that spend credit) must carry the app's origin
 *     in `Origin`, which a browser sends on every POST and a page cannot set for itself;
 *   - a read must be same-origin. A browser sends no `Origin` on a same-origin GET, but says so in `Sec-Fetch-Site`;
 *     "none" is the user opening an address themselves, which no other site can cause.
 * Without CLIENT_ORIGIN nothing can match, so nothing that changes anything is accepted.
 *
 * This keeps other sites and stray clients out. It is not authentication: whoever can open the app can use the
 * experiment, and a script can send these headers itself.
 */
export function experimentAccess(access: ExperimentAccess = {}): RequestHandler {
  const production = access.production ?? process.env.NODE_ENV === 'production', origin = (access.clientOrigin ?? process.env.CLIENT_ORIGIN)?.trim().replace(/\/$/, '');
  return (req, res, next) => {
    if (!production && LOOPBACK.has(req.socket.remoteAddress ?? '') && !req.headers['x-forwarded-for']) return next();
    if (req.method === 'GET' || req.method === 'HEAD') {
      const site = req.headers['sec-fetch-site'];
      if (req.headers.origin ? req.headers.origin === origin : site === 'same-origin' || site === 'none') return next();
      return void res.status(403).json(refuse('The layerize experiment only answers the FrameFlow app itself.'));
    }
    if (origin && req.headers.origin === origin) return next();
    res.status(403).json(refuse(origin ? 'The layerize experiment only accepts requests from the FrameFlow app itself.' : 'Set CLIENT_ORIGIN to the app\'s own address to use the layerize experiment here.'));
  };
}

function readUpload(req: Request): Promise<{ bytes: Buffer; fields: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof busboy>;
    try { parser = busboy({ headers: req.headers, limits: { files: 1, fields: 2, parts: 3, fieldSize: 200, fileSize: MAX_UPLOAD_BYTES } }); }
    catch { reject(new RunError('INVALID_UPLOAD', 'Upload one image as multipart form data.')); return; }
    let file: Buffer | undefined, truncated = false;
    const fields: Record<string, string> = {};
    parser.on('field', (name, value) => { if (name === 'recursive') fields[name] = value; });
    parser.on('file', (_name, stream) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => { truncated = true; });
      stream.on('end', () => { file = Buffer.concat(chunks); });
    });
    parser.on('error', () => reject(new RunError('INVALID_UPLOAD', 'The upload could not be read.')));
    parser.on('close', () => truncated ? reject(new RunError('UPLOAD_TOO_LARGE', `Images must be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`)) : file?.length ? resolve({ bytes: file, fields }) : reject(new RunError('INVALID_UPLOAD', 'Choose an image to upload.')));
    req.pipe(parser);
  });
}

/**
 * runsDir: the decomposition runs. deps: the planner, fal transport and background reconstructor. generation: the image
 * model (reference creatives and template edits). access: who may use it (default: from CLIENT_ORIGIN and NODE_ENV).
 * imageTemplatesDir, imagePrompt: where reference creatives are kept and what analyzes a reference. templatesDir,
 * executionsDir: the creative template library and its executions. smart: the smart-edit and creative-variant providers
 * and folders (live OpenAI and fal by default; each feature reports itself unavailable when its keys are missing).
 * Every default is the app's own folder and providers.
 */
export function createLayerizeRouter(options: { runsDir?: string; deps?: () => RunnerDeps; generation?: () => GenerationConfig; access?: ExperimentAccess;
  imageTemplatesDir?: string; imagePrompt?: () => ImagePromptWriter; templatesDir?: string; executionsDir?: string; inspector?: () => StructureInspector;
  smart?: SmartProviders & { analysesDir?: string; variantsDir?: string; env?: NodeJS.ProcessEnv } } = {}): Router {
  const runsDir = options.runsDir ?? DEFAULT_RUNS_DIR;
  const deps = options.deps ?? (() => liveDeps());
  const generation = options.generation ?? (() => liveGenerationConfig());
  /** The work running now (a run id, or a template execution id), and the run it is decomposing. */
  let active: string | undefined, activeRun: string | undefined;
  const router = express.Router();
  router.use(experimentAccess(options.access));
  const background = (id: string, work: () => Promise<unknown>) => {
    active = id;
    if (validRunId(id) && existsSync(join(runsDir, id, 'run.json'))) activeRun = id;
    void work().catch(error => console.error('layerize experiment', id, error)).finally(() => { if (active === id) { active = undefined; activeRun = undefined; } });
  };
  const isActiveRun = (id: string) => activeRun === id || active === id;
  const dirOf = (id: string) => { if (!validRunId(id) || !existsSync(join(runsDir, id, 'run.json'))) throw new RunError('NOT_FOUND', 'Run not found.'); return join(runsDir, id); };
  const busy = () => { if (active) throw new RunError('BUSY', `${active} is still running. One decomposition at a time.`); };
  // Work that waits its turn instead of being refused: reference creatives and template executions.
  const waiting = new Set<string>();
  let line: Promise<unknown> = Promise.resolve();
  const idle = async () => { while (active) await new Promise(done => setTimeout(done, 200)); };
  const inTurn = (id: string, work: () => Promise<unknown>) => {
    waiting.add(id);
    line = line.then(async () => { await idle(); waiting.delete(id); background(id, work); await idle(); }).catch(error => console.error('decomposition turn', id, error));
  };
  const runState = (id: string) => isActiveRun(id) ? 'active' as const : waiting.has(id) ? 'waiting' as const : undefined;
  /** Image requests one at a time, in the order asked. */
  let images: Promise<unknown> = Promise.resolve();

  router.get('/runs', (_req, res) => res.json({ active: activeRun ?? active ?? null, runs: listRuns(runsDir) }));
  // A direct test run of one image: the planner analyzes it, then one Seedream call (plus the recursive cleanup when asked).
  router.post('/runs', async (req, res, next) => {
    try {
      busy();
      const { bytes, fields } = await readUpload(req);
      busy();
      const recursive = fields.recursive ?? 'false';
      if (recursive !== 'true' && recursive !== 'false') throw new RunError('INVALID_RECURSIVE', 'recursive must be "true" or "false".');
      const { dir, run } = await createRun(runsDir, bytes, { mode: 'generated' }, { refinement: recursive === 'true' });
      background(run.id, () => executeRun(dir, deps()));
      res.status(202).json(run);
    } catch (error) { next(error); }
  });

  registerImageTemplateRoutes(router, {
    dir: options.imageTemplatesDir ?? DEFAULT_IMAGE_TEMPLATES_DIR, runsDir, deps, generation, promptWriter: options.imagePrompt ?? (() => liveImagePromptWriter()),
    enqueueImage: (label, work, settled) => { images = images.then(work).catch(error => console.error('reference creative generation', label, error)).finally(settled); },
    runInTurn: inTurn, runState,
  });
  const templates = fileTemplateStore(options.templatesDir ?? DEFAULT_TEMPLATES_DIR), executions = fileExecutionStore(options.executionsDir ?? DEFAULT_EXECUTIONS_DIR);
  // Smart edits and creative variants: injected providers (tests, the offline fixture) or the live ones, configured from env.
  const smartEnv = options.smart?.env ?? process.env, injected = options.smart ?? {};
  const providers: SmartProviders = { analyzer: injected.analyzer ?? (() => liveSceneAnalyzer()), resolver: injected.resolver ?? (() => liveChangeResolver()), verifier: injected.verifier ?? (() => liveSemanticVerifier()),
    concepts: injected.concepts ?? (() => liveConceptWriter()), segmenter: injected.segmenter ?? (() => { const provider = cutoutProvider(smartEnv); return provider === 'none' ? undefined : liveSegmenter(provider, () => deps().transport()); }) };
  const features = (): SmartFeatures => {
    let cutout: string;
    try { cutout = injected.segmenter ? 'injected' : cutoutProvider(smartEnv); } catch (error) { cutout = 'none'; return { ...readSmartFeatures(smartEnv, { openai: !!injected.analyzer, fal: false, cutout, models: { analysis: '', resolver: '', verifier: '' } }), variants: { available: false, reason: error instanceof Error ? error.message : String(error), maxVariants: 4 } }; }
    return readSmartFeatures(smartEnv, { openai: !!injected.analyzer, fal: !!injected.segmenter, cutout, models: { analysis: providers.analyzer!().model, resolver: providers.resolver!().model, verifier: providers.verifier!().model } });
  };
  const smart = createSmartCreative({ scenes: fileSceneStore(injected.analysesDir ?? DEFAULT_ANALYSES_DIR), variants: fileVariantStore(injected.variantsDir ?? DEFAULT_VARIANTS_DIR), executions, templates, generation, providers, features });
  const service = createTemplateExecutions({ templates, executions, runsDir, deps, generation, smart, inspector: options.inspector ?? (() => liveStructureInspector()), inTurn: (id, work) => inTurn(id, async () => {
    // The execution's run becomes the active run as soon as it exists (its dashboard polls it).
    const watch = setInterval(() => { try { activeRun = executions.get(id).runId ?? activeRun; } catch { /* read again next tick */ } }, 200);
    try { return await work(); } finally { clearInterval(watch); }
  }) });
  const { shown } = registerCreativeTemplateRoutes(router, { templates, executions, service, runsDir, runState });
  registerSmartCreativeRoutes(router, { smart, shownExecution: shown });

  router.get('/runs/:id/diagnostics', async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await readRunDiagnostics(dirOf(req.params.id), { fx: process.env.AI_BUDGET_USD_INR, imageTemplatesDir: options.imageTemplatesDir ?? DEFAULT_IMAGE_TEMPLATES_DIR, executions }));
    } catch (error) { next(error); }
  });
  router.get('/runs/:id', (req, res, next) => { try { res.json({ ...readRun(dirOf(req.params.id)), active: isActiveRun(req.params.id) }); } catch (error) { next(error); } });
  // Explicit user action only: one NEW paid Seedream call for a run Seedream rejected, with that run's own plan. Never automatic.
  router.post('/runs/:id/retry', async (req, res, next) => {
    try {
      busy();
      const { dir, run } = await createRetryRun(runsDir, dirOf(req.params.id));
      background(run.id, () => executeRun(dir, deps()));
      res.status(202).json(run);
    } catch (error) { next(error); }
  });
  router.post('/runs/:id/resume', express.json({ limit: '2kb' }), (req, res, next) => {
    try {
      busy();
      const dir = dirOf(req.params.id);
      const requestId = typeof req.body?.requestId === 'string' && req.body.requestId.trim() ? req.body.requestId.trim() : undefined;
      const run = readRun(dir);
      if (run.stage !== 'failed' && run.stage !== 'done') throw new RunError('RUN_ACTIVE_OR_AMBIGUOUS', `The run is at "${run.stage}".`);
      if (!run.seedream.requestId && !requestId) throw new RunError('NO_REQUEST_ID', 'This run never reached fal (no request ID saved). Start a new run; resume never submits.');
      background(run.id, () => resumeRun(dir, deps(), requestId));
      res.status(202).json(run);
    } catch (error) { next(error); }
  });
  router.get('/runs/:id/files/:name', (req, res, next) => {
    try {
      const dir = dirOf(req.params.id);
      if (!FILE.test(req.params.name) || !existsSync(join(dir, req.params.name))) throw new RunError('NOT_FOUND', 'File not found.');
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(join(dir, req.params.name));
    } catch (error) { next(error); }
  });
  router.get('/runs/:id/outputs.zip', (req, res, next) => {
    try {
      const dir = dirOf(req.params.id);
      res.attachment(`layerize-${req.params.id}.zip`);
      const zip = new ZipArchive();
      zip.on('error', error => res.destroy(error));
      zip.pipe(res);
      zip.directory(dir, req.params.id);
      void zip.finalize();
    } catch (error) { next(error); }
  });
  router.use(((error: unknown, _req, res, next) => {
    void next;
    const code = error instanceof RunError ? error.code : 'INTERNAL';
    const conflict = ['BUSY', 'RUN_ACTIVE_OR_AMBIGUOUS', 'IDEMPOTENCY_CONFLICT', 'PLAN_DECISION_REQUIRED', 'REVIEW_REQUIRED', 'NOT_RETRYABLE', 'STALE_RESOLUTION', 'RESOLUTION_NEEDS_INPUT', 'ANALYSIS_NOT_READY', 'CUTOUT_REQUIRED', 'NOT_NEEDED'];
    const status = code === 'NOT_FOUND' || code === 'TEMPLATE_NOT_FOUND' ? 404 : conflict.includes(code) ? 409 : code === 'UPLOAD_TOO_LARGE' ? 413
      : code === 'SMART_EDIT_UNAVAILABLE' || code === 'VARIANTS_UNAVAILABLE' ? 503 : error instanceof RunError ? 400 : 500;
    res.status(status).json({ error: { code, message: error instanceof Error ? error.message : 'Unexpected error.', ...(error instanceof RunError ? error.details : {}) } });
  }) as express.ErrorRequestHandler);
  return router;
}
