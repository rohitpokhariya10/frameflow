/**
 * Smart edits and creative variants, under the decomposition router:
 *
 *   GET    /creative-features                                   what is available, and why not when it is not
 *   GET    /scene-analyses/lookup?imageSha256&templateId&templateVersion   the saved scene for that image (a read: no upload, no call)
 *   POST   /scene-analyses                                      multipart image, templateId, templateVersion, idempotencyKey, fresh? → analysis (one call, or the saved one unless fresh)
 *   GET    /scene-analyses/:id                                  an analysis (state, scene, template mapping)
 *   GET    /scene-analyses/:id/image                            the analyzed image
 *   POST   /scene-analyses/:id/resolutions                      multipart draft (JSON), productReference?, rulesOnly? → a resolution
 *   GET    /scene-analyses/:id/resolutions/:resolutionId        a resolution
 *   POST   /creative-variant-sets                               { analysisId, templateId, templateVersion, protectedIds, corrections?, direction?, surprise?, count?, verify?, idempotencyKey }
 *   GET    /creative-variant-sets/:id                           a set: cutout, concepts, variants and their status
 *   GET    /creative-variant-sets/:id/files/:file               a set's image
 *   POST   /creative-variant-sets/:id/cutout                    multipart cutout (PNG exported from the same image)
 *   POST   /creative-variant-sets/:id/variants/:variantId/regenerate   { scene, idempotencyKey } — one more paid image request
 *   POST   /creative-variant-sets/:id/variants/:variantId/select       { idempotencyKey } → a reviewed execution (no new call)
 *
 * Every paid call is behind an explicit POST from the app's own frontend (experimentAccess). Files are served only by
 * their validated names inside their own record's folder.
 */
import express, { type Request, type Router } from 'express';
import busboy from 'busboy';
import { MAX_UPLOAD_BYTES, RunError } from '../layerizeExperiment.js';
import type { SmartCreative, Upload } from './smartCreative.js';
import type { TemplateExecution } from '@frameflow/shared';

type Form = { fields: Record<string, string>; files: Record<string, Upload> };
function readForm(req: Request, allowed: { fields: string[]; files: string[] }): Promise<Form> {
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof busboy>;
    try { parser = busboy({ headers: req.headers, limits: { files: allowed.files.length, fields: allowed.fields.length, parts: allowed.fields.length + allowed.files.length, fieldSize: 16_000, fileSize: MAX_UPLOAD_BYTES } }); }
    catch { reject(new RunError('INVALID_UPLOAD', 'Send the image as multipart form data.')); return; }
    const fields: Record<string, string> = {}, files: Record<string, Upload> = {};
    let truncated = false;
    parser.on('field', (name, value, info) => { if (info.valueTruncated) truncated = true; if (allowed.fields.includes(name)) fields[name] = value; });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => reject(new RunError('INVALID_UPLOAD', 'Too many form parts.')));
    parser.on('file', (name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => { truncated = true; });
      stream.on('end', () => { if (allowed.files.includes(name) && chunks.length) files[name] = { bytes: Buffer.concat(chunks), fileName: info.filename, mimeType: info.mimeType }; });
    });
    parser.on('error', () => reject(new RunError('INVALID_UPLOAD', 'The upload could not be read.')));
    req.on('aborted', () => { parser.destroy(); reject(new RunError('INVALID_UPLOAD', 'The upload was interrupted.')); });
    parser.on('close', () => truncated ? reject(new RunError('UPLOAD_TOO_LARGE', `Images must be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB; settings must fit the form limits.`)) : resolve({ fields, files }));
    req.pipe(parser);
  });
}
const body = (req: Request) => req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
const only = (value: Record<string, unknown>, keys: string[], what: string) => { const extra = Object.keys(value).filter(k => !keys.includes(k)); if (extra.length) throw new RunError('INVALID_REQUEST', `${what} takes no "${extra[0]}".`); };

export function registerSmartCreativeRoutes(router: Router, ctx: { smart: SmartCreative; shownExecution: (execution: TemplateExecution) => unknown }): void {
  const { smart } = ctx;
  router.get('/creative-features', (_req, res) => res.json(smart.features()));
  router.get('/scene-analyses/lookup', (req, res, next) => {
    try { res.setHeader('Cache-Control', 'no-store'); res.json({ analysis: smart.lookup({ imageSha256: req.query.imageSha256, templateId: req.query.templateId, templateVersion: req.query.templateVersion }) ?? null }); }
    catch (error) { next(error); }
  });
  router.post('/scene-analyses', async (req, res, next) => {
    try {
      const form = await readForm(req, { fields: ['templateId', 'templateVersion', 'idempotencyKey', 'fresh'], files: ['image'] });
      if (!form.files.image) throw new RunError('INVALID_UPLOAD', 'Choose an image.');
      const { analysis, created } = await smart.analyze({ upload: form.files.image, templateId: form.fields.templateId, templateVersion: form.fields.templateVersion, idempotencyKey: form.fields.idempotencyKey, fresh: form.fields.fresh === 'true' });
      res.status(created ? 202 : 200).json(analysis);
    } catch (error) { next(error); }
  });
  router.get('/scene-analyses/:id', (req, res, next) => { try { res.json(smart.analysis(req.params.id)); } catch (error) { next(error); } });
  router.get('/scene-analyses/:id/image', (req, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); res.sendFile(smart.sourcePath(req.params.id)); } catch (error) { next(error); } });
  router.post('/scene-analyses/:id/resolutions', async (req, res, next) => {
    try {
      const form = await readForm(req, { fields: ['draft', 'rulesOnly'], files: ['productReference'] });
      let draft: unknown;
      try { draft = JSON.parse(form.fields.draft ?? '{}'); } catch { throw new RunError('INVALID_REQUEST', 'The draft must be valid JSON.'); }
      if (form.fields.rulesOnly !== undefined && !['true', 'false'].includes(form.fields.rulesOnly)) throw new RunError('INVALID_REQUEST', 'rulesOnly is true or false.');
      const { resolution, created } = await smart.resolve(req.params.id, { draft, ...(form.files.productReference ? { reference: form.files.productReference } : {}), rulesOnly: form.fields.rulesOnly === 'true' });
      res.status(created ? 201 : 200).json(resolution);
    } catch (error) { next(error); }
  });
  router.get('/scene-analyses/:id/resolutions/:resolutionId', (req, res, next) => { try { res.json(smart.resolution(req.params.id, req.params.resolutionId)); } catch (error) { next(error); } });

  router.post('/creative-variant-sets', express.json({ limit: '16kb' }), async (req, res, next) => {
    try {
      const b = body(req);
      only(b, ['analysisId', 'templateId', 'templateVersion', 'protectedIds', 'corrections', 'direction', 'surprise', 'count', 'verify', 'idempotencyKey'], 'A variant set');
      const { set, created } = await smart.startVariants(b as Parameters<SmartCreative['startVariants']>[0]);
      res.status(created ? 202 : 200).json(set);
    } catch (error) { next(error); }
  });
  router.get('/creative-variant-sets/:id', (req, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); res.json(smart.set(req.params.id)); } catch (error) { next(error); } });
  router.get('/creative-variant-sets/:id/files/:file', (req, res, next) => {
    try {
      if (!/\.png$|\.jpg$|\.webp$/.test(req.params.file)) throw new RunError('NOT_FOUND', 'File not found.');
      res.setHeader('Cache-Control', 'no-store'); res.sendFile(smart.setFilePath(req.params.id, req.params.file));
    } catch (error) { next(error); }
  });
  router.post('/creative-variant-sets/:id/cutout', async (req, res, next) => {
    try {
      const form = await readForm(req, { fields: [], files: ['cutout'] });
      if (!form.files.cutout) throw new RunError('INVALID_UPLOAD', 'Choose a cutout PNG.');
      res.status(202).json(await smart.uploadCutout(req.params.id, form.files.cutout.bytes));
    } catch (error) { next(error); }
  });
  router.post('/creative-variant-sets/:id/variants/:variantId/regenerate', express.json({ limit: '4kb' }), (req, res, next) => {
    try { const b = body(req); only(b, ['scene', 'idempotencyKey'], 'A regeneration'); res.status(202).json(smart.regenerate(req.params.id, req.params.variantId, { scene: b.scene, idempotencyKey: b.idempotencyKey })); }
    catch (error) { next(error); }
  });
  router.post('/creative-variant-sets/:id/variants/:variantId/select', express.json({ limit: '1kb' }), (req, res, next) => {
    try {
      const b = body(req); only(b, ['idempotencyKey'], 'Choosing a variant');
      const { execution, created } = smart.selectVariant(req.params.id, req.params.variantId, { idempotencyKey: b.idempotencyKey });
      res.status(created ? 201 : 200).json(ctx.shownExecution(execution));
    } catch (error) { next(error); }
  });
}
