/**
 * Local-only HTTP surface for the OpenAI → Seedream layerize experiment. Enabled only with LAYERIZE_EXPERIMENT=1 outside
 * production, and only answers loopback clients (the Vite proxy or a local browser): it spends paid API credit and
 * has no authentication. One active run at a time; runs execute in-process, no worker.
 * Runs take optional promptMode (generated | template), templateKey (default template-a; also sets the suggested layer
 * count), separateHeldObject (true | false, default true; Template A's checkbox, ignored by templates without it),
 * templateOptions (JSON object of the selected template's own options, e.g. Template B's
 * {"separateTouchingIndependentObjects":true}; rejected for a template that does not declare them), skipFitCheck (true |
 * false, default false: "Run anyway" past the template fit check) and targetLayers
 * (exact output layer count including the base, applied locally after Seedream) form fields. Resume takes an optional
 * targetLayers to re-render a finished run at another count from its saved result. Templates are listed and saved under /templates.
 */
import express, { type Request, type Router } from 'express';
import busboy from 'busboy';
import { ZipArchive } from 'archiver';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRetryRun, createRun, DEFAULT_RUNS_DIR, executeRun, liveDeps, listRuns, MAX_UPLOAD_BYTES, readRun, resumeRun, retargetLayers, RunError, validRunId, type PromptSource, type RunnerDeps } from './layerizeExperiment.js';
import { getTemplatePrompt, listTemplates, saveTemplatePrompt, suggestedLayerCount, targetLayersProblem } from './layerizeTemplates.js';
import { TEMPLATE_A_ASPECT_RATIOS, TEMPLATE_A_CONSISTENCY, TEMPLATE_A_DEFAULTS, TEMPLATE_A_FIELDS, TEMPLATE_A_GENERATION_VERSION, TEMPLATE_A_IMAGE_SIZES, TEMPLATE_A_PROMPT_LIMITS, TEMPLATE_A_RATIO_FRAMING, TEMPLATE_A_SKELETON } from '@frameflow/shared';
import { createGroup, DEFAULT_GENERATIONS_DIR, findVariant, generateVariant, groupDir, listGroups, liveGenerationConfig, presentGroup, queueVariant, readGroup, recordDecomposition, variantImage, type GenerationConfig, type GenerationGroup } from './templateAGeneration.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const FILE = /^[a-z0-9-]+\.(png|jpg|webp|json|txt)$/;

export function layerizeExperimentEnabled(env = process.env) { return env.LAYERIZE_EXPERIMENT === '1' && env.NODE_ENV !== 'production'; }

function readUpload(req: Request): Promise<{ bytes: Buffer; fields: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof busboy>;
    try { parser = busboy({ headers: req.headers, limits: { files: 1, fields: 8, parts: 9, fieldSize: 200, fileSize: MAX_UPLOAD_BYTES } }); }
    catch { reject(new RunError('INVALID_UPLOAD', 'Upload one image as multipart form data.')); return; }
    let file: Buffer | undefined, truncated = false, optionsTruncated = false;
    const fields: Record<string, string> = {};
    parser.on('field', (name, value, info) => {
      // A cut-off templateOptions value would silently lose an option; refuse instead.
      if (info.valueTruncated && name === 'templateOptions') { optionsTruncated = true; return; }
      if (['promptMode', 'templateKey', 'separateHeldObject', 'templateOptions', 'skipFitCheck', 'targetLayers', 'minLayers', 'maxLayers'].includes(name)) fields[name] = value;
    });
    parser.on('file', (_name, stream) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => { truncated = true; });
      stream.on('end', () => { file = Buffer.concat(chunks); });
    });
    parser.on('error', () => reject(new RunError('INVALID_UPLOAD', 'The upload could not be read.')));
    parser.on('close', () => optionsTruncated ? reject(new RunError('INVALID_TEMPLATE_OPTIONS', 'templateOptions is too long.')) : truncated ? reject(new RunError('UPLOAD_TOO_LARGE', `Images must be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`)) : file?.length ? resolve({ bytes: file, fields }) : reject(new RunError('INVALID_UPLOAD', 'Choose an image to upload.')));
    req.pipe(parser);
  });
}

/** generationsDir / generation: the Template A test generator's groups and image generator (default: the app's configured ones). */
export function createLayerizeRouter(options: { runsDir?: string; deps?: () => RunnerDeps; generationsDir?: string; generation?: () => GenerationConfig } = {}): Router {
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
      let templateOptions: unknown;
      if (fields.templateOptions !== undefined) {
        try { templateOptions = JSON.parse(fields.templateOptions); } catch { throw new RunError('INVALID_TEMPLATE_OPTIONS', 'templateOptions must be a JSON object of true/false values.'); }
      }
      // "Run anyway": the user overrides the template fit check for this run.
      const skip = fields.skipFitCheck ?? 'false';
      if (skip !== 'true' && skip !== 'false') throw new RunError('INVALID_FIT_CHECK', 'skipFitCheck must be "true" or "false".');
      const { dir, run } = await createRun(runsDir, bytes, source, { separateHeldObject, layerTarget, templateKey, templateOptions, skipFitCheck: skip === 'true' });
      background(run.id, () => executeRun(dir, deps()));
      res.status(202).json(run);
    } catch (error) { next(error); }
  });
  // fitCheck: whether new runs are checked against the template before planning (off in this experiment by default).
  router.get('/templates', (_req, res) => res.json({ templates: listTemplates(runsDir), fitCheck: Boolean(deps().fitCheck) }));

  // Template A test generator (admin harness). One creative is generated as a group of aspect-ratio variants (1:1, 16:9,
  // 4:5): the fields (or the base prompt edited from them) → one prompt per ratio, built here and never sent by the
  // client → OpenAI Image 2 (aiModels.ts), one request per variant → the saved images. "Decompose image" on a variant
  // runs exactly that image as an ordinary Template A run (planner, fal Seedream Layerize and local grouping unchanged),
  // linked both ways with the group, the variant and its ratio. Variants are generated one at a time, in the order they
  // were asked for; a decomposition follows the one-active-run rule above.
  const generationsDir = options.generationsDir ?? DEFAULT_GENERATIONS_DIR;
  const generation = options.generation ?? (() => liveGenerationConfig());
  /** Variants this process has queued or is generating, as "group/variant". */
  const inProgress = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  const shown = (group: GenerationGroup) => presentGroup(group, variantId => inProgress.has(`${group.id}/${variantId}`));
  /** Queues variants behind whatever is already being generated. Each is one paid request; none is ever resent. */
  const enqueue = (groupId: string, variantIds: string[], config: GenerationConfig) => {
    for (const variantId of variantIds) {
      const key = `${groupId}/${variantId}`;
      queueVariant(generationsDir, groupId, variantId, inProgress.has(key));
      inProgress.add(key);
      queue = queue.then(() => generateVariant(generationsDir, groupId, variantId, config)).catch(error => console.error('template A generation', key, error)).finally(() => inProgress.delete(key));
    }
  };
  router.get('/template-a/generator', (_req, res, next) => {
    try {
      res.json({ version: TEMPLATE_A_GENERATION_VERSION, skeleton: TEMPLATE_A_SKELETON, fields: TEMPLATE_A_FIELDS, defaults: TEMPLATE_A_DEFAULTS, aspectRatios: TEMPLATE_A_ASPECT_RATIOS,
        imageSizes: TEMPLATE_A_IMAGE_SIZES, consistency: TEMPLATE_A_CONSISTENCY, framing: TEMPLATE_A_RATIO_FRAMING, promptLimits: TEMPLATE_A_PROMPT_LIMITS, generator: { provider: 'openai', model: generation().model } });
    } catch (error) { next(error); }
  });
  router.get('/template-a/groups', (_req, res) => res.json({ groups: listGroups(generationsDir).map(shown) }));
  router.get('/template-a/groups/:id', (req, res, next) => { try { res.json(shown(readGroup(generationsDir, req.params.id))); } catch (error) { next(error); } });
  router.get('/template-a/groups/:id/variants/:variant/image', (req, res, next) => {
    try {
      const variant = findVariant(readGroup(generationsDir, req.params.id), req.params.variant);
      if (!variant.image) throw new RunError('NOT_FOUND', 'This variant has no image.');
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(join(groupDir(generationsDir, req.params.id), variant.image.file));
    } catch (error) { next(error); }
  });
  // Body: { fields, basePrompt?, aspectRatios? }. A new creative is always a new group; earlier groups are never changed
  // by it. basePrompt: the shared prompt as the user edited it. aspectRatios: which variants to generate now (default:
  // all); the others stay pending and can be generated later. Answers at once; the variants follow in the background.
  router.post('/template-a/groups', express.json({ limit: '24kb' }), (req, res, next) => {
    try {
      const config = generation();
      const { group, requested } = createGroup(generationsDir, (req.body ?? {}) as { fields?: unknown; basePrompt?: unknown; prompt?: unknown; aspectRatios?: unknown }, config);
      enqueue(group.id, requested, config);
      res.status(202).json(shown(readGroup(generationsDir, group.id)));
    } catch (error) { next(error); }
  });
  // One variant of an existing group, generated now: a failed one again, or one not generated yet. The group's shared
  // definition and its other variants are not touched. A variant that has its image is refused.
  router.post('/template-a/groups/:id/variants/:variant/generate', (req, res, next) => {
    try {
      enqueue(req.params.id, [req.params.variant], generation());
      res.status(202).json(shown(readGroup(generationsDir, req.params.id)));
    } catch (error) { next(error); }
  });
  // Body: { separateHeldObject?: boolean, targetLayers?: number, skipFitCheck?: boolean }. Decomposes this variant's
  // image, and only this one. Defaults follow the structure the creative's fields describe (scoped to generated images;
  // uploads keep Template A's usual defaults): held object separate only when there is one (a creative without one
  // cannot be decomposed "separate"), and a target of Template A's natural count minus the border layer when the fields
  // asked for no visible border.
  router.post('/template-a/groups/:id/variants/:variant/decompose', express.json({ limit: '2kb' }), async (req, res, next) => {
    try {
      busy();
      const body = (req.body ?? {}) as { separateHeldObject?: unknown; targetLayers?: unknown; skipFitCheck?: unknown };
      for (const key of ['separateHeldObject', 'skipFitCheck'] as const) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new RunError('INVALID_REQUEST', `${key} must be true or false.`);
      if (body.targetLayers !== undefined && typeof body.targetLayers !== 'number') throw new RunError('INVALID_TARGET_LAYERS', 'targetLayers must be a number.');
      const { group, variant, bytes } = variantImage(generationsDir, req.params.id, req.params.variant), structure = group.structure;
      if (body.separateHeldObject === true && !structure.heldObject) throw new RunError('INVALID_REQUEST', 'This generation has no held object, so it cannot be decomposed with the held object separate.');
      const separateHeldObject = structure.heldObject && body.separateHeldObject !== false;
      const expected = suggestedLayerCount('template-a', separateHeldObject)! - (structure.visibleBorder ? 0 : 1);
      const targetLayers = body.targetLayers ?? expected;
      const problem = targetLayersProblem('template-a', separateHeldObject, targetLayers);
      if (problem) throw new RunError('INVALID_TARGET_LAYERS', problem);
      const layerTarget = { templateKey: 'template-a', suggestedLayers: expected, targetLayers };
      const { dir, run } = await createRun(runsDir, bytes, { mode: 'generated' }, { templateKey: 'template-a', separateHeldObject, layerTarget, skipFitCheck: body.skipFitCheck === true,
        origin: { kind: 'template-a-generation', generationId: group.id, variantId: variant.id, aspectRatio: variant.aspectRatio } });
      recordDecomposition(generationsDir, group.id, variant.id, { runId: run.id, createdAt: run.createdAt, separateHeldObject, targetLayers });
      background(run.id, () => executeRun(dir, deps()));
      res.status(202).json(run);
    } catch (error) { next(error); }
  });
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
