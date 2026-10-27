/**
 * Master templates and their creatives over HTTP (master/service.ts), on the layerize experiment's router beside the
 * protected templates (same access guard and error format). Files are served by the protected template route
 * (`/protected-templates/:id/files/:name`). Nothing here calls a provider: the scan is local OCR, the clean background is
 * local, and creatives read stored files only. The one paid step of a master, its optional Seedream decomposition, is the
 * protected template's own confirmed request (`/protected-templates/:id/decompose`).
 */
import express, { type Request, type Router } from 'express';
import busboy from 'busboy';
import { PROTECTED_LIMITS, validCreativeId, validProtectedTemplateId, type ProtectedSourceOrigin } from '@frameflow/shared';
import { RunError } from '../../layerizeExperiment.js';
import type { MasterService } from './service.js';

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
  if (!Number.isSafeInteger(n) || (n as number) < 1) throw new RunError('INVALID_REQUEST', 'Name the revision you are changing (expectedRevision).');
  return n as number;
};
const idOf = (req: Request) => { const id = req.params.id; if (!validProtectedTemplateId(id)) throw new RunError('NOT_FOUND', 'Master template not found.'); return id as string; };
const cidOf = (req: Request) => { const id = req.params.cid; if (!validCreativeId(id)) throw new RunError('NOT_FOUND', 'Creative not found.'); return id as string; };
const json = express.json({ limit: '2mb' });
const noStore = (res: express.Response) => res.setHeader('Cache-Control', 'no-store');

export function registerMasterTemplateRoutes(router: Router, ctx: { masters: MasterService }) {
  const { masters } = ctx, base = '/master-templates';
  router.get(base, (_req, res, next) => { try { noStore(res); res.json({ masters: masters.list() }); } catch (error) { next(error); } });
  /** A new master from a creative (an upload, or a Template Studio poster's own image); its scan starts at once. */
  router.post(base, async (req, res, next) => {
    try {
      const { bytes, filename, fields } = await readUpload(req);
      if (!bytes?.length) throw new RunError('INVALID_UPLOAD', 'Choose the offer creative.');
      let origin: ProtectedSourceOrigin | undefined;
      if (fields.origin) { try { origin = JSON.parse(fields.origin) as ProtectedSourceOrigin; } catch { throw new RunError('INVALID_ORIGIN', 'Unknown source origin.'); } }
      const id = await masters.create(bytes, { name: fields.name, filename, origin });
      masters.startScan(id);
      res.status(201).json(masters.view(id));
    } catch (error) { next(error); }
  });
  router.get(`${base}/:id`, (req, res, next) => { try { noStore(res); res.json(masters.view(idOf(req))); } catch (error) { next(error); } });
  router.patch(`${base}/:id`, json, async (req, res, next) => { try { res.json(await masters.rename(idOf(req), revision(req.body?.expectedRevision), req.body?.name)); } catch (error) { next(error); } });
  /** The scan: saved per source, so asking again returns the saved result unless `force` asks to read the poster again. */
  router.post(`${base}/:id/scan`, json, (req, res, next) => {
    try { const id = idOf(req), { started } = masters.startScan(id, { force: req.body?.force === true }); res.status(started ? 202 : 200).json({ started, master: masters.view(id) }); } catch (error) { next(error); }
  });
  /** Scan again: the upload read again into suggestions (the master changes only when some are applied); apply; discard. */
  router.post(`${base}/:id/rescan`, json, (req, res, next) => {
    try { const id = idOf(req), { started } = masters.startRescan(id); res.status(started ? 202 : 200).json({ started, master: masters.view(id) }); } catch (error) { next(error); }
  });
  router.get(`${base}/:id/rescan`, (req, res, next) => { try { noStore(res); res.json(masters.rescanResult(idOf(req))); } catch (error) { next(error); } });
  router.post(`${base}/:id/rescan/apply`, json, async (req, res, next) => {
    try { res.json(await masters.applyRescan(idOf(req), revision(req.body?.expectedRevision), { expectedAnalysisRevision: req.body?.expectedAnalysisRevision, mode: req.body?.mode, wordIds: req.body?.wordIds, addWordIds: req.body?.addWordIds, addPlateIds: req.body?.addPlateIds })); } catch (error) { next(error); }
  });
  router.delete(`${base}/:id/rescan`, async (req, res, next) => { try { res.json(await masters.discardRescan(idOf(req), revision(req.query.expectedRevision))); } catch (error) { next(error); } });
  router.put(`${base}/:id/review`, json, async (req, res, next) => {
    try { res.json(await masters.saveReview(idOf(req), revision(req.body?.expectedRevision), { expectedAnalysisRevision: req.body?.expectedAnalysisRevision, words: req.body?.words, groups: req.body?.groups, logoSlots: req.body?.logoSlots, plates: req.body?.plates })); }
    catch (error) { next(error); }
  });
  router.post(`${base}/:id/review/approve-all`, json, async (req, res, next) => { try { res.json(await masters.approveAll(idOf(req), revision(req.body?.expectedRevision), req.body?.includeUncertain === true)); } catch (error) { next(error); } });
  /** What the clean background would remove now, tinted over the poster (to check before cleaning). */
  router.get(`${base}/:id/removal-preview`, async (req, res, next) => { try { noStore(res); res.type('png').send(await masters.removalPreview(idOf(req))); } catch (error) { next(error); } });
  router.post(`${base}/:id/prepare`, json, async (req, res, next) => { try { res.json(await masters.prepare(idOf(req), revision(req.body?.expectedRevision))); } catch (error) { next(error); } });
  router.post(`${base}/:id/background`, async (req, res, next) => {
    try {
      const id = idOf(req), { bytes, filename, fields } = await readUpload(req);
      if (!bytes?.length) throw new RunError('INVALID_UPLOAD', 'Choose the clean background.');
      res.json(await masters.uploadBackground(id, revision(fields.expectedRevision), bytes, filename));
    } catch (error) { next(error); }
  });
  router.post(`${base}/:id/background/approve`, json, async (req, res, next) => { try { res.json(await masters.approveBackground(idOf(req), revision(req.body?.expectedRevision), req.body?.acknowledgeEstimate === true)); } catch (error) { next(error); } });
  router.post(`${base}/:id/artwork`, json, async (req, res, next) => { try { res.json(await masters.chooseArtwork(idOf(req), revision(req.body?.expectedRevision), { mode: req.body?.mode, runId: req.body?.runId })); } catch (error) { next(error); } });
  router.post(`${base}/:id/publish`, json, async (req, res, next) => { try { res.json(await masters.publish(idOf(req), revision(req.body?.expectedRevision))); } catch (error) { next(error); } });
  router.get(`${base}/:id/revisions/:revision`, (req, res, next) => {
    try { noStore(res); res.json(masters.readSnapshot(idOf(req), Number(req.params.revision))); } catch (error) { next(error); }
  });
  // Creatives: reuse. Stored files only; no OCR, no decomposition, no image generation.
  router.get(`${base}/:id/creatives`, (req, res, next) => { try { noStore(res); res.json({ creatives: masters.listCreatives(idOf(req)) }); } catch (error) { next(error); } });
  router.post(`${base}/:id/creatives`, json, async (req, res, next) => { try { res.status(201).json(await masters.createCreative(idOf(req), { name: req.body?.name, revision: req.body?.revision })); } catch (error) { next(error); } });
  router.get(`${base}/:id/creatives/:cid`, (req, res, next) => { try { noStore(res); res.json(masters.getCreative(idOf(req), cidOf(req))); } catch (error) { next(error); } });
  router.put(`${base}/:id/creatives/:cid`, json, async (req, res, next) => {
    try { res.json(await masters.saveCreative(idOf(req), cidOf(req), { expectedRevision: req.body?.expectedRevision, creative: req.body?.creative, from: req.body?.from, designId: req.body?.designId })); } catch (error) { next(error); }
  });
  router.delete(`${base}/:id/creatives/:cid`, async (req, res, next) => { try { res.json(await masters.deleteCreative(idOf(req), cidOf(req))); } catch (error) { next(error); } });
  router.post(`${base}/:id/creatives/:cid/assets`, async (req, res, next) => {
    try {
      const id = idOf(req), cid = cidOf(req), { bytes, filename } = await readUpload(req);
      if (!bytes?.length) throw new RunError('INVALID_UPLOAD', 'Choose the picture.');
      res.status(201).json(await masters.uploadCreativeAsset(id, cid, bytes, filename));
    } catch (error) { next(error); }
  });
  // Free: a decomposition run from the creative's own layers (no planner, no Seedream, no OCR).
  router.post(`${base}/:id/creatives/:cid/decomposition`, json, async (req, res, next) => { try { res.json(await masters.decomposeCreative(idOf(req), cidOf(req))); } catch (error) { next(error); } });
  router.post(`${base}/:id/creatives/:cid/rebase`, json, async (req, res, next) => { try { res.json(await masters.rebaseCreative(idOf(req), cidOf(req), { expectedRevision: req.body?.expectedRevision })); } catch (error) { next(error); } });
  router.post(`${base}/:id/creatives/:cid/duplicate`, json, async (req, res, next) => { try { res.status(201).json(await masters.duplicateCreative(idOf(req), cidOf(req), req.body?.name)); } catch (error) { next(error); } });
  router.post(`${base}/:id/creatives/:cid/exports`, json, async (req, res, next) => { try { res.json(await masters.recordExport(idOf(req), cidOf(req), { width: req.body?.width, height: req.body?.height })); } catch (error) { next(error); } });
}
