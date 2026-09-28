/**
 * Local-only HTTP surface for the OpenAI → Seedream layerize experiment. Enabled only with LAYERIZE_EXPERIMENT=1 outside
 * production, and only answers loopback clients (the Vite proxy or a local browser): it spends paid API credit and
 * has no authentication. One active run at a time; runs execute in-process, no worker.
 * Runs take optional promptMode (generated | template), templateKey (default template-a; also sets the suggested layer
 * count), separateHeldObject (true | false, default true) and targetLayers (exact output layer count including the base,
 * applied locally after Seedream) form fields. Resume takes an optional targetLayers to re-render a finished run at
 * another count from its saved result. Templates are listed and saved under /templates.
 */
import express, { type Request, type Router } from 'express';
import busboy from 'busboy';
import { ZipArchive } from 'archiver';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRetryRun, createRun, DEFAULT_RUNS_DIR, executeRun, liveDeps, listRuns, MAX_UPLOAD_BYTES, readRun, resumeRun, retargetLayers, RunError, validRunId, type PromptSource, type RunnerDeps } from './layerizeExperiment.js';
import { getTemplatePrompt, listTemplates, saveTemplatePrompt, suggestedLayerCount } from './layerizeTemplates.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const FILE = /^[a-z0-9-]+\.(png|jpg|webp|json|txt)$/;

export function layerizeExperimentEnabled(env = process.env) { return env.LAYERIZE_EXPERIMENT === '1' && env.NODE_ENV !== 'production'; }

function readUpload(req: Request): Promise<{ bytes: Buffer; fields: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof busboy>;
    try { parser = busboy({ headers: req.headers, limits: { files: 1, fields: 6, parts: 7, fieldSize: 200, fileSize: MAX_UPLOAD_BYTES } }); }
    catch { reject(new RunError('INVALID_UPLOAD', 'Upload one image as multipart form data.')); return; }
    let file: Buffer | undefined, truncated = false;
    const fields: Record<string, string> = {};
    parser.on('field', (name, value) => { if (['promptMode', 'templateKey', 'separateHeldObject', 'targetLayers', 'minLayers', 'maxLayers'].includes(name)) fields[name] = value; });
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

export function createLayerizeRouter(options: { runsDir?: string; deps?: () => RunnerDeps } = {}): Router {
  const runsDir = options.runsDir ?? DEFAULT_RUNS_DIR;
  const deps = options.deps ?? (() => liveDeps());
  let active: string | undefined;
  const router = express.Router();
  router.use((req, res, next) => LOOPBACK.has(req.socket.remoteAddress ?? '') ? next() : res.status(403).json({ error: { code: 'LOCAL_ONLY', message: 'The layerize experiment only accepts local requests.' } }));
  const background = (id: string, work: () => Promise<unknown>) => {
    active = id;
    void work().catch(error => console.error('layerize experiment', id, error)).finally(() => { if (active === id) active = undefined; });
  };
  const dirOf = (id: string) => { if (!validRunId(id) || !existsSync(join(runsDir, id, 'run.json'))) throw new RunError('NOT_FOUND', 'Run not found.'); return join(runsDir, id); };
  const busy = () => { if (active) throw new RunError('BUSY', `Run ${active} is still active. One experiment at a time.`); };

  router.get('/runs', (_req, res) => res.json({ active: active ?? null, runs: listRuns(runsDir) }));
  router.post('/runs', async (req, res, next) => {
    try {
      busy();
      const { bytes, fields } = await readUpload(req);
      busy();
      // Reuse mode snapshots the saved template prompt into the run; generate mode (default) calls OpenAI.
      const mode = fields.promptMode ?? 'generated';
      if (mode !== 'generated' && mode !== 'template') throw new RunError('INVALID_PROMPT_MODE', 'promptMode must be "generated" or "template".');
      const source: PromptSource = mode === 'template' ? { mode, ...getTemplatePrompt(runsDir, fields.templateKey ?? '') } : { mode };
      const grouping = fields.separateHeldObject ?? 'true';
      if (grouping !== 'true' && grouping !== 'false') throw new RunError('INVALID_GROUPING', 'separateHeldObject must be "true" or "false".');
      const separateHeldObject = grouping === 'true', templateKey = fields.templateKey ?? 'template-a';
      // Empty means no target (the semantic layers as returned); createRun validates it before anything is sent.
      const count = (value?: string) => value === undefined || value.trim() === '' ? undefined : Number(value);
      const layerTarget = { templateKey, suggestedLayers: suggestedLayerCount(templateKey, separateHeldObject), targetLayers: count(fields.targetLayers), minLayers: count(fields.minLayers), maxLayers: count(fields.maxLayers) };
      const { dir, run } = await createRun(runsDir, bytes, source, { separateHeldObject, layerTarget, templateKey });
      background(run.id, () => executeRun(dir, deps()));
      res.status(202).json(run);
    } catch (error) { next(error); }
  });
  router.get('/templates', (_req, res) => res.json({ templates: listTemplates(runsDir) }));
  router.post('/templates/:key', express.json({ limit: '8kb' }), (req, res, next) => {
    try { res.json(saveTemplatePrompt(runsDir, req.params.key, String(req.body?.runId ?? ''), typeof req.body?.notes === 'string' ? req.body.notes : undefined)); }
    catch (error) { next(error); }
  });
  router.get('/runs/:id', (req, res, next) => { try { res.json({ ...readRun(dirOf(req.params.id)), active: active === req.params.id }); } catch (error) { next(error); } });
  // Explicit user action only: one NEW paid Seedream call for a run Seedream rejected. Never called automatically.
  // Body { providerPrompt: 'current' (default) | 'auto' } — 'auto' is Template B's empty-prompt, automatic major-elements retry.
  router.post('/runs/:id/retry', express.json({ limit: '2kb' }), async (req, res, next) => {
    try {
      busy();
      const providerPrompt = (req.body as { providerPrompt?: unknown } | undefined)?.providerPrompt ?? 'current';
      if (providerPrompt !== 'current' && providerPrompt !== 'auto') throw new RunError('INVALID_RETRY', 'providerPrompt must be "current" or "auto".');
      const { dir, run } = await createRetryRun(runsDir, dirOf(req.params.id), providerPrompt);
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
      const raw = req.body?.targetLayers, targetLayers = raw === undefined || raw === null || raw === '' ? undefined : Number(raw);
      if (targetLayers !== undefined) retargetLayers(run, targetLayers);
      background(run.id, () => resumeRun(dir, deps(), requestId, { targetLayers }));
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
    const status = code === 'NOT_FOUND' ? 404 : code === 'BUSY' || code === 'RUN_ACTIVE_OR_AMBIGUOUS' ? 409 : code === 'UPLOAD_TOO_LARGE' ? 413 : error instanceof RunError ? 400 : 500;
    res.status(status).json({ error: { code, message: error instanceof Error ? error.message : 'Unexpected error.', ...(error instanceof RunError ? error.details : {}) } });
  }) as express.ErrorRequestHandler);
  return router;
}
