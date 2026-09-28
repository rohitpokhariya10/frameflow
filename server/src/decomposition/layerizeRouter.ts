/**
 * Local-only HTTP surface for the OpenAI → Seedream layerize experiment. Enabled only with LAYERIZE_EXPERIMENT=1 outside
 * production, and only answers loopback clients (the Vite proxy or a local browser): it spends paid API credit and
 * has no authentication. One active run at a time; runs execute in-process, no worker.
 */
import express, { type Request, type Router } from 'express';
import busboy from 'busboy';
import { ZipArchive } from 'archiver';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRun, DEFAULT_RUNS_DIR, executeRun, liveDeps, listRuns, MAX_UPLOAD_BYTES, readRun, resumeRun, RunError, validRunId, type RunnerDeps } from './layerizeExperiment.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const FILE = /^[a-z0-9-]+\.(png|jpg|webp|json|txt)$/;

export function layerizeExperimentEnabled(env = process.env) { return env.LAYERIZE_EXPERIMENT === '1' && env.NODE_ENV !== 'production'; }

function readUpload(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof busboy>;
    try { parser = busboy({ headers: req.headers, limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_UPLOAD_BYTES } }); }
    catch { reject(new RunError('INVALID_UPLOAD', 'Upload one image as multipart form data.')); return; }
    let file: Buffer | undefined, truncated = false;
    parser.on('file', (_name, stream) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => { truncated = true; });
      stream.on('end', () => { file = Buffer.concat(chunks); });
    });
    parser.on('error', () => reject(new RunError('INVALID_UPLOAD', 'The upload could not be read.')));
    parser.on('close', () => truncated ? reject(new RunError('UPLOAD_TOO_LARGE', `Images must be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`)) : file?.length ? resolve(file) : reject(new RunError('INVALID_UPLOAD', 'Choose an image to upload.')));
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
      const bytes = await readUpload(req);
      busy();
      const { dir, run } = await createRun(runsDir, bytes);
      background(run.id, () => executeRun(dir, deps()));
      res.status(202).json(run);
    } catch (error) { next(error); }
  });
  router.get('/runs/:id', (req, res, next) => { try { res.json({ ...readRun(dirOf(req.params.id)), active: active === req.params.id }); } catch (error) { next(error); } });
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
    const status = code === 'NOT_FOUND' ? 404 : code === 'BUSY' || code === 'RUN_ACTIVE_OR_AMBIGUOUS' ? 409 : code === 'UPLOAD_TOO_LARGE' ? 413 : error instanceof RunError ? 400 : 500;
    res.status(status).json({ error: { code, message: error instanceof Error ? error.message : 'Unexpected error.' } });
  }) as express.ErrorRequestHandler);
  return router;
}
