/**
 * Protected templates over HTTP, on the layerize experiment's router (same access guard, same one-at-a-time executor, same
 * error format). Every write names the revision it was made from. Only POST /:id/decompose spends anything: one Seedream
 * request, which waits its turn behind any other decomposition (it is sent once, when the executor is free, never twice);
 * a request repeated with its idempotency key returns the run it already made.
 */
import express, { type Request, type Router } from 'express';
import busboy from 'busboy';
import { RunError, type RunRecord } from '../layerizeExperiment.js';
import { PROTECTED_LIMITS, validProtectedTemplateId, type ProtectedSourceOrigin } from '@frameflow/shared';
import { validProtectedFile, type ProtectedStore } from './store.js';
import type { ProtectedService } from './service.js';

const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', json: 'application/json' };

/** One multipart upload: a file and a few short fields. */
function readUpload(req: Request): Promise<{ bytes?: Buffer; filename?: string; fields: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof busboy>;
    try { parser = busboy({ headers: req.headers, limits: { files: 1, fields: 8, parts: 9, fieldSize: 4000, fileSize: PROTECTED_LIMITS.maxSourceBytes } }); }
    catch { reject(new RunError('INVALID_UPLOAD', 'Upload one image as multipart form data.')); return; }
    let bytes: Buffer | undefined, filename: string | undefined, truncated = false;
    const fields: Record<string, string> = {};
    parser.on('field', (name, value) => { fields[name] = value; });
    parser.on('file', (_name, stream, info) => {
      const chunks: Buffer[] = []; filename = info.filename;
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => { truncated = true; });
      stream.on('end', () => { bytes = Buffer.concat(chunks); });
    });
    parser.on('error', () => reject(new RunError('INVALID_UPLOAD', 'The upload could not be read.')));
    req.on('aborted', () => { parser.destroy(); reject(new RunError('INVALID_UPLOAD', 'The upload was interrupted. Upload it again.')); });
    parser.on('close', () => truncated ? reject(new RunError('UPLOAD_TOO_LARGE', `Images must be at most ${PROTECTED_LIMITS.maxSourceBytes / 1024 / 1024} MB.`)) : resolve({ bytes, filename, fields }));
    req.pipe(parser);
  });
}
const revision = (value: unknown) => {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(n) || (n as number) < 1) throw new RunError('INVALID_REQUEST', 'Name the template revision you are changing (expectedRevision).');
  return n as number;
};
const idOf = (req: Request) => { const id = req.params.id; if (!validProtectedTemplateId(id)) throw new RunError('NOT_FOUND', 'Protected template not found.'); return id as string; };
const json = express.json({ limit: '512kb' });

export function registerProtectedTemplateRoutes(router: Router, ctx: { service: ProtectedService; store: ProtectedStore; inTurn: (id: string, work: () => Promise<unknown>) => void }) {
  const { service, store } = ctx, base = '/protected-templates';
  router.get(base, (_req, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); res.json({ templates: service.list() }); } catch (error) { next(error); } });
  router.post(base, async (req, res, next) => {
    try {
      const { bytes, filename, fields } = await readUpload(req);
      if (!bytes?.length) throw new RunError('INVALID_UPLOAD', 'Choose the source creative.');
      let origin: ProtectedSourceOrigin | undefined;
      if (fields.origin) { try { origin = JSON.parse(fields.origin) as ProtectedSourceOrigin; } catch { throw new RunError('INVALID_ORIGIN', 'Unknown source origin.'); } }
      const template = await service.create(bytes, { name: fields.name, filename, origin });
      res.status(201).json(service.view(template.id));
    } catch (error) { next(error); }
  });
  /** A saved run's image as the source (the creative exactly as it was decomposed, or refused). */
  router.post(`${base}/from-run`, json, async (req, res, next) => {
    try { const template = await service.createFromRun(String(req.body?.runId ?? ''), typeof req.body?.name === 'string' ? req.body.name : undefined); res.status(201).json(service.view(template.id)); } catch (error) { next(error); }
  });
  router.get(`${base}/:id`, (req, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); res.json(service.view(idOf(req))); } catch (error) { next(error); } });
  router.patch(`${base}/:id`, json, async (req, res, next) => {
    try { res.json(await service.setDetails(idOf(req), revision(req.body?.expectedRevision), { name: req.body?.name, layerInstructions: req.body?.layerInstructions })); } catch (error) { next(error); }
  });
  router.put(`${base}/:id/elements`, json, async (req, res, next) => {
    try { res.json(await service.setElements(idOf(req), revision(req.body?.expectedRevision), req.body?.elements)); } catch (error) { next(error); }
  });
  router.post(`${base}/:id/elements/:elementId/asset`, async (req, res, next) => {
    try {
      const id = idOf(req), { bytes, filename, fields } = await readUpload(req);
      if (!bytes?.length) throw new RunError('INVALID_UPLOAD', 'Choose the original file.');
      res.json(await service.attachAsset(id, revision(fields.expectedRevision), String(req.params.elementId), bytes, filename));
    } catch (error) { next(error); }
  });
  router.post(`${base}/:id/confirm-regions`, json, async (req, res, next) => { try { res.json(await service.confirmRegions(idOf(req), revision(req.body?.expectedRevision))); } catch (error) { next(error); } });
  router.post(`${base}/:id/base`, async (req, res, next) => {
    try {
      const id = idOf(req), { bytes, filename, fields } = await readUpload(req);
      if (!bytes?.length) throw new RunError('INVALID_UPLOAD', 'Choose the clean artwork.');
      const method = fields.method === 'structured-scene' ? 'structured-scene' : fields.method === 'clean-upload' || fields.method === undefined ? 'clean-upload' : null;
      if (!method) throw new RunError('INVALID_REQUEST', 'method must be clean-upload or structured-scene.');
      res.json(await service.uploadBase(id, revision(fields.expectedRevision), bytes, method, filename));
    } catch (error) { next(error); }
  });
  router.post(`${base}/:id/base/local-fill`, json, async (req, res, next) => { try { res.json(await service.fillBase(idOf(req), revision(req.body?.expectedRevision))); } catch (error) { next(error); } });
  router.post(`${base}/:id/base/approve`, json, async (req, res, next) => {
    try { res.json(await service.approveBase(idOf(req), revision(req.body?.expectedRevision), req.body?.acknowledgeUncertain === true)); } catch (error) { next(error); }
  });
  router.get(`${base}/:id/preflight`, async (req, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); res.json(await service.preflight(idOf(req))); } catch (error) { next(error); } });
  /** The paid step (one Seedream request), only ever by this explicit POST. */
  router.post(`${base}/:id/decompose`, json, async (req, res, next) => {
    try {
      const id = idOf(req), idempotencyKey = String(req.body?.idempotencyKey ?? '');
      // A repeated request (double click, retried POST) gets the run it already made, even while that run is running.
      const prior = service.runForKey(id, idempotencyKey);
      if (prior) return void res.status(200).json({ run: prior, existing: true, template: service.view(id) });
      const started = await service.startDecomposition(id, { expectedRevision: revision(req.body?.expectedRevision), idempotencyKey, confirmRepeat: req.body?.confirmRepeat === true });
      // Linked first, then queued: it counts as running from now on (no second confirmation can start another), and its one
      // request is sent when no other decomposition is running.
      if (!started.existing) ctx.inTurn(started.run.id, () => service.execute(id, started.dir));
      res.status(started.existing ? 200 : 202).json({ run: started.run as RunRecord, existing: started.existing, template: service.view(id) });
    } catch (error) { next(error); }
  });
  router.post(`${base}/:id/runs/:runId/resume`, async (req, res, next) => {
    try {
      const id = idOf(req);
      const { dir, run } = await service.resume(id, String(req.params.runId));
      ctx.inTurn(run.id, () => service.executeResume(id, dir));
      res.status(202).json({ run });
    } catch (error) { next(error); }
  });
  router.post(`${base}/:id/runs/:runId/reconstruct`, async (req, res, next) => { try { res.json(await service.reconstructRun(idOf(req), String(req.params.runId))); } catch (error) { next(error); } });
  router.post(`${base}/:id/approve`, json, async (req, res, next) => {
    try { res.json(await service.approve(idOf(req), { expectedRevision: revision(req.body?.expectedRevision), runId: String(req.body?.runId ?? ''), acknowledge: Array.isArray(req.body?.acknowledge) ? req.body.acknowledge.filter((a: unknown) => typeof a === 'string').slice(0, 10) : [] })); }
    catch (error) { next(error); }
  });
  // Words and logo slots: local recognition and an administrator's corrections. Nothing here calls a provider.
  router.post(`${base}/:id/text-analysis`, json, async (req, res, next) => { try { res.json(await service.analyseText(idOf(req), revision(req.body?.expectedRevision))); } catch (error) { next(error); } });
  router.put(`${base}/:id/text-analysis`, json, async (req, res, next) => {
    try { res.json(await service.correctText(idOf(req), revision(req.body?.expectedRevision), { expectedAnalysisRevision: req.body?.expectedAnalysisRevision, words: req.body?.words, groups: req.body?.groups, logoSlots: req.body?.logoSlots })); }
    catch (error) { next(error); }
  });
  router.post(`${base}/:id/text-analysis/logos/:slotId/asset`, async (req, res, next) => {
    try {
      const id = idOf(req), { bytes, filename, fields } = await readUpload(req);
      if (!bytes?.length) throw new RunError('INVALID_UPLOAD', 'Choose the logo file.');
      res.json(await service.replaceLogo(id, revision(fields.expectedRevision), String(req.params.slotId), bytes, filename));
    } catch (error) { next(error); }
  });
  router.delete(`${base}/:id/text-analysis/logos/:slotId/asset`, json, async (req, res, next) => {
    try { res.json(await service.restoreLogo(idOf(req), revision(req.body?.expectedRevision ?? req.query.expectedRevision), String(req.params.slotId))); } catch (error) { next(error); }
  });
  router.get(`${base}/:id/files/:name`, (req, res, next) => {
    try {
      const id = idOf(req), name = String(req.params.name);
      if (!validProtectedFile(name) || name === 'template.json' || !store.has(id, name)) throw new RunError('NOT_FOUND', 'File not found.');
      res.set({ 'Content-Type': TYPES[name.split('.').pop()!], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.sendFile(store.path(id, name));
    } catch (error) { next(error); }
  });
}
