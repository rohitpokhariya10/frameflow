/**
 * HTTP surface for the OpenAI → Seedream layerize experiment (the Template A/B/C review flow). Mounted only with
 * LAYERIZE_EXPERIMENT=1, in development and in production alike. It spends paid API credit and has no login, so it
 * only answers its own frontend: a direct request on this machine in development, or, behind a proxy, a request the
 * browser marks as coming from the app's own origin (see experimentAccess). One active run at a time; runs execute
 * in-process, no worker.
 * Runs take optional promptMode (generated | template), templateKey (default template-a; also sets the suggested layer
 * count), separateHeldObject (true | false, default true; Template A's checkbox, ignored by templates without it),
 * templateOptions (JSON object of the selected template's own options, e.g. Template B's
 * {"separateTouchingIndependentObjects":true}; rejected for a template that does not declare them), skipFitCheck (true |
 * false, default false: "Run anyway" past the template fit check) and targetLayers
 * (exact output layer count including the base, applied locally after Seedream) form fields. Resume takes an optional
 * targetLayers to re-render a finished run at another count from its saved result. Templates are listed and saved under /templates.
 */
import express, { type Request, type RequestHandler, type Router } from 'express';
import busboy from 'busboy';
import { ZipArchive } from 'archiver';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRetryRun, createRun, DEFAULT_RUNS_DIR, executeRun, liveDeps, listRuns, MAX_UPLOAD_BYTES, readRun, resumeRun, retargetLayers, RunError, validRunId, type PromptSource, type RunnerDeps } from './layerizeExperiment.js';
import { getTemplatePrompt, listTemplates, saveTemplatePrompt, suggestedLayerCount } from './layerizeTemplates.js';
import { GENERATION_ASPECT_RATIOS, GENERATION_IMAGE_SIZES, GENERATION_PROMPT_LIMITS, type GenerationTemplateKey } from '@frameflow/shared';
import { createGenerationGroup, findVariant, generateVariant, generationsDirFor, groupDir, listGroups, liveGenerationConfig, ownGroup, presentGroup, queueVariant, readGroup, recordDecomposition, variantImage, withStructure, type GenerationConfig, type GenerationGroup } from './generationGroups.js';
import { templateAHandoff } from './templateAGeneration.js';
import { templateBHandoff } from './templateBGeneration.js';
import { templateCHandoff } from './templateCGeneration.js';

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

/**
 * generation: the test generators' image generator. generationsDir: where Template A's groups are kept; generationDirs:
 * the same per template. Defaults: the app's configured generator and one folder per template. access: who may use it
 * (default: from CLIENT_ORIGIN and NODE_ENV).
 */
export function createLayerizeRouter(options: { runsDir?: string; deps?: () => RunnerDeps; generationsDir?: string; generationDirs?: Partial<Record<GenerationTemplateKey, string>>; generation?: () => GenerationConfig; access?: ExperimentAccess } = {}): Router {
  const runsDir = options.runsDir ?? DEFAULT_RUNS_DIR;
  const deps = options.deps ?? (() => liveDeps());
  let active: string | undefined;
  const router = express.Router();
  router.use(experimentAccess(options.access));
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

  // Template test generators (admin harness). One creative is generated as a group of aspect-ratio variants (1:1, 16:9,
  // 4:5): its template's fields (or the base prompt edited from them) → one prompt per ratio, built here and never sent
  // by the client → OpenAI Image 2 (aiModels.ts), one request per variant → the saved images. "Decompose image" on a
  // variant runs exactly that image as an ordinary run of the same template (planner, fal Seedream Layerize and local
  // grouping unchanged), linked both ways with the group, the variant and its ratio.
  //
  // The mechanics are shared (generationGroups.ts); the templates are not. Each template's routes are registered under
  // its own path and are bound to its own profile, handoff and folder, so a request to one template can only ever use
  // that template's fields, prompt wording, decomposition template and options. Variants are generated one at a time,
  // in the order they were asked for, whichever template they belong to; a decomposition follows the one-active-run
  // rule above.
  const generation = options.generation ?? (() => liveGenerationConfig());
  /** Variants this process has queued or is generating, as "template/group/variant". */
  const inProgress = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  for (const handoff of [templateAHandoff, templateBHandoff, templateCHandoff]) {
    const { profile } = handoff, key = profile.templateKey, at = `/${key}`;
    const generationsDir = options.generationDirs?.[key] ?? (key === 'template-a' ? options.generationsDir : undefined) ?? generationsDirFor(key);
    const own = (id: string) => ownGroup(generationsDir, key, id);
    const shown = (group: GenerationGroup) => presentGroup(withStructure(group, handoff), variantId => inProgress.has(`${key}/${group.id}/${variantId}`));
    /** Queues variants behind whatever is already being generated. Each is one paid request; none is ever resent. */
    const enqueue = (groupId: string, variantIds: string[], config: GenerationConfig, independent = false) => {
      for (const variantId of variantIds) {
        const running = `${key}/${groupId}/${variantId}`;
        queueVariant(generationsDir, groupId, variantId, inProgress.has(running));
        inProgress.add(running);
        // How the ratios are kept together is the template's: its sentence about a reference image, or none.
        queue = queue.then(() => generateVariant(generationsDir, groupId, variantId, config, { referenceInstruction: profile.referenceInstruction, independent })).catch(error => console.error('template generation', running, error)).finally(() => inProgress.delete(running));
      }
    };
    router.get(`${at}/generator`, (_req, res, next) => {
      try {
        const config = generation();
        res.json({ templateKey: key, name: profile.name, version: profile.version, family: profile.family, sameAcrossRatios: profile.sameAcrossRatios, mayDiffer: profile.mayDiffer, skeleton: profile.skeleton, fields: profile.fields, defaults: profile.defaults,
          aspectRatios: GENERATION_ASPECT_RATIOS, imageSizes: GENERATION_IMAGE_SIZES, consistency: profile.consistency, framing: profile.framing, promptLimits: GENERATION_PROMPT_LIMITS, generator: { provider: 'openai', model: config.model },
          // Whether the ratios of a new creative are made from the first finished image (the template's choice, unless switched off).
          ratioReference: Boolean(profile.referenceInstruction) && config.referenceRatios !== false });
      } catch (error) { next(error); }
    });
    router.get(`${at}/groups`, (_req, res) => res.json({ groups: listGroups(generationsDir).filter(group => group.templateKey === key).map(shown) }));
    router.get(`${at}/groups/:id`, (req, res, next) => { try { res.json(shown(own(req.params.id))); } catch (error) { next(error); } });
    router.get(`${at}/groups/:id/variants/:variant/image`, (req, res, next) => {
      try {
        const variant = findVariant(own(req.params.id), req.params.variant);
        if (!variant.image) throw new RunError('NOT_FOUND', 'This variant has no image.');
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(join(groupDir(generationsDir, req.params.id), variant.image.file));
      } catch (error) { next(error); }
    });
    // Body: { fields, basePrompt?, aspectRatios? }. A new creative is always a new group; earlier groups are never
    // changed by it. basePrompt: the shared prompt as the user edited it. aspectRatios: which variants to generate now
    // (default: all); the others stay pending and can be generated later. Answers at once; the variants follow.
    router.post(`${at}/groups`, express.json({ limit: '24kb' }), (req, res, next) => {
      try {
        const config = generation();
        const { group, requested } = createGenerationGroup(generationsDir, handoff, (req.body ?? {}) as { fields?: unknown; basePrompt?: unknown; prompt?: unknown; aspectRatios?: unknown }, config);
        enqueue(group.id, requested, config);
        res.status(202).json(shown(readGroup(generationsDir, group.id)));
      } catch (error) { next(error); }
    });
    // One variant of an existing group, generated now: a failed one again, or one not generated yet. The group's shared
    // definition and its other variants are not touched. A variant that has its image is refused.
    // Body (optional): { independent: true } generates it from its prompt alone, in a group that would make it from a
    // finished ratio's image.
    router.post(`${at}/groups/:id/variants/:variant/generate`, express.json({ limit: '1kb' }), (req, res, next) => {
      try {
        own(req.params.id);
        const independent = (req.body as { independent?: unknown } | undefined)?.independent;
        if (independent !== undefined && typeof independent !== 'boolean') throw new RunError('INVALID_REQUEST', 'independent must be true or false.');
        enqueue(req.params.id, [req.params.variant], generation(), independent === true);
        res.status(202).json(shown(own(req.params.id)));
      } catch (error) { next(error); }
    });
    // Decomposes this variant's image, and only this one, with this template. What the body may carry, and what the run
    // is given, is the template's own handoff: Template A's held-object choice, or the template's declared options.
    router.post(`${at}/groups/:id/variants/:variant/decompose`, express.json({ limit: '2kb' }), async (req, res, next) => {
      try {
        busy();
        own(req.params.id);
        const found = variantImage(generationsDir, req.params.id, req.params.variant), group = withStructure(found.group, handoff), { variant, bytes } = found;
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
        const { run: settings, entry } = handoff.decomposition(group, body);
        const { dir, run } = await createRun(runsDir, bytes, { mode: 'generated' }, { templateKey: key, ...settings,
          origin: { kind: `${key}-generation`, generationId: group.id, variantId: variant.id, aspectRatio: variant.aspectRatio } });
        recordDecomposition(generationsDir, group.id, variant.id, { runId: run.id, createdAt: run.createdAt, ...entry });
        background(run.id, () => executeRun(dir, deps()));
        res.status(202).json(run);
      } catch (error) { next(error); }
    });
  }
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
