/**
 * Product with Text template routes (`/product-templates`, the experiment's access guard). Files of a template are read
 * through the protected-template files route (`/protected-templates/:id/files/:name`). Detection may make the one
 * vision request when the client asks for it (`useAi`); preparing may call the cut-out service (SAM-3) only when the
 * request approves its cost (`paid: true`), and only with the picture its text and logos were removed from.
 */
import express, { type Request, type Router } from 'express';
import busboy from 'busboy';
import { PRODUCT_LIMITS, validProtectedTemplateId, type PixelRect } from '@frameflow/shared';
import { RunError } from '../../layerizeExperiment.js';
import type { ProductTemplates, ReviewInput } from './service.js';

function readUpload(req: Request): Promise<{ bytes?: Buffer; filename?: string; fields: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof busboy>;
    try { parser = busboy({ headers: req.headers, limits: { files: 1, fields: 8, parts: 9, fieldSize: 4000, fileSize: PRODUCT_LIMITS.maxUpload } }); }
    catch { reject(new RunError('INVALID_UPLOAD', 'Upload one image as multipart form data.')); return; }
    let bytes: Buffer | undefined, filename: string | undefined, truncated = false;
    const fields: Record<string, string> = {};
    parser.on('field', (name, value) => { fields[name] = value; });
    parser.on('file', (_name, stream, info) => { const chunks: Buffer[] = []; filename = info.filename; stream.on('data', (c: Buffer) => chunks.push(c)); stream.on('limit', () => { truncated = true; }); stream.on('end', () => { bytes = Buffer.concat(chunks); }); });
    parser.on('error', () => reject(new RunError('INVALID_UPLOAD', 'The upload could not be read.')));
    req.on('aborted', () => { parser.destroy(); reject(new RunError('INVALID_UPLOAD', 'The upload was interrupted. Upload it again.')); });
    parser.on('close', () => truncated ? reject(new RunError('UPLOAD_TOO_LARGE', `Images must be at most ${PRODUCT_LIMITS.maxUpload / 1024 / 1024} MB.`)) : resolve({ bytes, filename, fields }));
    req.pipe(parser);
  });
}
const idOf = (req: Request) => { const id = req.params.id; if (!validProtectedTemplateId(id)) throw new RunError('NOT_FOUND', 'Product template not found.'); return id as string; };
const json = express.json({ limit: '2mb' });
const noStore = (res: express.Response) => res.setHeader('Cache-Control', 'no-store');
const cropOf = (value: string | undefined): PixelRect | undefined => {
  if (!value) return undefined;
  try { const c = JSON.parse(value) as PixelRect; return { x: c.x, y: c.y, width: c.width, height: c.height }; } catch { throw new RunError('INVALID_CROP', 'The chosen creative could not be read.'); }
};

export function registerProductTemplateRoutes(router: Router, ctx: { products: ProductTemplates }) {
  const { products } = ctx, base = '/product-templates';
  router.get(base, (_req, res, next) => { try { noStore(res); res.json({ templates: products.list() }); } catch (error) { next(error); } });
  // Is the upload a sheet of creatives? Stores nothing.
  router.post(`${base}/sheet`, async (req, res, next) => {
    try { const { bytes } = await readUpload(req); if (!bytes?.length) throw new RunError('INVALID_UPLOAD', 'Choose an image.'); res.json(await products.sheetOf(bytes)); } catch (error) { next(error); }
  });
  router.post(base, async (req, res, next) => {
    try {
      const { bytes, filename, fields } = await readUpload(req);
      if (!bytes?.length) throw new RunError('INVALID_UPLOAD', 'Choose an image.');
      const id = await products.create(bytes, { name: fields.name, filename, crop: cropOf(fields.crop) });
      products.startDetect(id, { useAi: fields.useAi === 'true' });
      res.status(201).json(products.view(id));
    } catch (error) { next(error); }
  });
  router.get(`${base}/:id`, (req, res, next) => { try { noStore(res); res.json(products.view(idOf(req))); } catch (error) { next(error); } });
  router.post(`${base}/:id/detect`, json, (req, res, next) => {
    try { const id = idOf(req), { started } = products.startDetect(id, { force: req.body?.force === true, useAi: req.body?.useAi === true, savedAnswer: req.body?.savedAnswer === true, recover: req.body?.recover === true, newRequest: req.body?.newRequest === true }); res.status(started ? 202 : 200).json({ started, template: products.view(id) }); } catch (error) { next(error); }
  });
  router.put(`${base}/:id/review`, json, async (req, res, next) => { try { res.json(await products.review(idOf(req), req.body as ReviewInput)); } catch (error) { next(error); } });
  // The AI-read text lines moved onto their letters (on this computer, free): only when asked; a new analysis revision.
  router.post(`${base}/:id/text/fit`, json, async (req, res, next) => { try { res.json(await products.fitText(idOf(req), { expectedRevision: req.body?.expectedRevision })); } catch (error) { next(error); } });
  // A picture for the review (a logo's replacement): stored, used only when the review naming it is saved.
  router.post(`${base}/:id/review-assets`, async (req, res, next) => {
    try { const { bytes } = await readUpload(req); if (!bytes?.length) throw new RunError('INVALID_UPLOAD', 'Choose a picture.'); res.status(201).json(await products.uploadReviewAsset(idOf(req), bytes)); } catch (error) { next(error); }
  });
  // Preparing: free and local, or with the cut-out service (SAM-3) when the request approves its cost (`paid: true`).
  router.get(`${base}/:id/brief`, async (req, res, next) => { try { noStore(res); res.json(await products.brief(idOf(req))); } catch (error) { next(error); } });
  router.put(`${base}/:id/brief`, json, async (req, res, next) => { try { res.json(await products.editBrief(idOf(req), req.body ?? {})); } catch (error) { next(error); } });
  router.put(`${base}/:id/selection`, json, async (req, res, next) => { try { res.json(await products.select(idOf(req), req.body ?? {})); } catch (error) { next(error); } });
  router.get(`${base}/:id/prepare-estimate`, (req, res, next) => { try { noStore(res); res.json(products.estimate(idOf(req))); } catch (error) { next(error); } });
  router.post(`${base}/:id/prepare`, json, async (req, res, next) => {
    try { const id = idOf(req), { started } = await products.startPrepare(id, { expectedRevision: req.body?.expectedRevision, paid: req.body?.paid, engine: req.body?.engine, approveUsd: req.body?.approveUsd }); res.status(started ? 202 : 200).json({ started, template: products.view(id) }); } catch (error) { next(error); }
  });
  router.post(`${base}/:id/approve`, json, async (req, res, next) => { try { res.json(await products.approve(idOf(req), { expectedRevision: req.body?.expectedRevision, acknowledge: req.body?.acknowledge, draft: req.body?.draft })); } catch (error) { next(error); } });
  router.post(`${base}/:id/publish`, json, async (req, res, next) => { try { res.status(201).json(await products.publish(idOf(req), { expectedRevision: req.body?.expectedRevision })); } catch (error) { next(error); } });
  router.post(`${base}/:id/open-editor`, async (req, res, next) => { try { res.json(await products.openEditor(idOf(req))); } catch (error) { next(error); } });
  // Creatives: the saved template reused. Every change is a new revision of the creative (expectedRevision guards it).
  const c = products.creatives, cid = (req: Request) => String(req.params.cid), oid = (req: Request) => String(req.params.oid);
  router.get(`${base}/:id/creatives`, (req, res, next) => { try { noStore(res); res.json({ creatives: c.list(idOf(req)) }); } catch (error) { next(error); } });
  router.post(`${base}/:id/creatives`, json, async (req, res, next) => { try { res.status(201).json(await c.create(idOf(req), { name: req.body?.name, revision: req.body?.revision })); } catch (error) { next(error); } });
  router.get(`${base}/:id/creatives/:cid`, (req, res, next) => {
    try { noStore(res); const r = req.query.revision === undefined ? undefined : Number(req.query.revision); if (r !== undefined && (!Number.isInteger(r) || r < 1)) throw new RunError('NOT_FOUND', 'Revision not found.'); res.json(c.read(idOf(req), cid(req), r)); } catch (error) { next(error); }
  });
  router.put(`${base}/:id/creatives/:cid`, json, async (req, res, next) => { try { res.json(await c.save(idOf(req), cid(req), { expectedRevision: req.body?.expectedRevision, creative: req.body?.creative })); } catch (error) { next(error); } });
  router.post(`${base}/:id/creatives/:cid/objects/:oid/replace`, async (req, res, next) => {
    try {
      const { bytes, filename, fields } = await readUpload(req);
      if (!bytes?.length) throw new RunError('INVALID_UPLOAD', 'Choose a picture.');
      res.json(await c.replace(idOf(req), cid(req), oid(req), { expectedRevision: Number(fields.expectedRevision), bytes, filename }));
    } catch (error) { next(error); }
  });
  router.post(`${base}/:id/creatives/:cid/objects/:oid/restore`, json, async (req, res, next) => { try { res.json(await c.restore(idOf(req), cid(req), oid(req), { expectedRevision: req.body?.expectedRevision })); } catch (error) { next(error); } });
  router.post(`${base}/:id/creatives/:cid/duplicate`, json, async (req, res, next) => { try { res.status(201).json(await c.duplicate(idOf(req), cid(req), { name: req.body?.name })); } catch (error) { next(error); } });
  router.post(`${base}/:id/creatives/:cid/assets`, async (req, res, next) => {
    try { const { bytes, filename } = await readUpload(req); if (!bytes?.length) throw new RunError('INVALID_UPLOAD', 'Choose a picture.'); res.status(201).json(await c.uploadAsset(idOf(req), cid(req), bytes, filename)); } catch (error) { next(error); }
  });
  // Opened in the editor: an ordinary run of the creative's layers, made locally (no provider), once per revision.
  router.post(`${base}/:id/creatives/:cid/open`, async (req, res, next) => { try { const r = await c.open(idOf(req), cid(req)); res.status(r.created ? 201 : 200).json(r); } catch (error) { next(error); } });
  router.post(`${base}/:id/creatives/:cid/save-master`, json, async (req, res, next) => { try { res.json(await products.saveEditorMaster(idOf(req), cid(req), req.body ?? {})); } catch (error) { next(error); } });
  // Variations: made from the template's structure; the AI planner only when the request approves it (`ai: true`).
  const vr = products.variations, jid = (req: Request) => String(req.params.jid), nOf = (req: Request) => { const n = Number(req.params.n); if (!Number.isInteger(n) || n < 0 || n > 20) throw new RunError('NOT_FOUND', 'That variation was not found.'); return n; };
  router.get(`${base}/:id/variation-options`, (req, res, next) => { try { noStore(res); const r = req.query.revision === undefined ? undefined : Number(req.query.revision); res.json(vr.options(idOf(req), Number.isInteger(r) ? r : undefined)); } catch (error) { next(error); } });
  router.post(`${base}/:id/variation-products`, async (req, res, next) => {
    try { const { bytes, filename, fields } = await readUpload(req); if (!bytes?.length) throw new RunError('INVALID_UPLOAD', 'Choose a picture.'); res.status(201).json(await vr.addChoice(idOf(req), bytes, filename, fields.kind === 'character' ? 'character' : 'product')); } catch (error) { next(error); }
  });
  router.get(`${base}/:id/variations`, (req, res, next) => { try { noStore(res); res.json({ jobs: vr.list(idOf(req)) }); } catch (error) { next(error); } });
  router.post(`${base}/:id/variations`, json, async (req, res, next) => { try { res.status(202).json(await vr.start(idOf(req), req.body ?? {})); } catch (error) { next(error); } });
  router.get(`${base}/:id/variations/:jid`, (req, res, next) => { try { noStore(res); res.json(vr.get(idOf(req), jid(req))); } catch (error) { next(error); } });
  router.post(`${base}/:id/variations/:jid/resume`, json, async (req, res, next) => { try { res.status(202).json(await vr.resume(idOf(req), jid(req), req.body ?? {})); } catch (error) { next(error); } });
  router.post(`${base}/:id/variations/:jid/cancel`, (req, res, next) => { try { res.json(vr.cancel(idOf(req), jid(req))); } catch (error) { next(error); } });
  router.post(`${base}/:id/variations/:jid/results/:n/save`, async (req, res, next) => { try { res.status(201).json(await vr.save(idOf(req), jid(req), nOf(req))); } catch (error) { next(error); } });
  // Both decomposition actions enter review and explicit AI cost approval. Local conversion is named open-layers.
  router.post(`${base}/:id/variations/:jid/results/:n/template`, async (req, res, next) => { try { res.status(201).json(await vr.toTemplate(idOf(req), jid(req), nOf(req))); } catch (error) { next(error); } });
  router.post(`${base}/:id/variations/:jid/results/:n/decomposition`, async (req, res, next) => { try { const r = await vr.decompose(idOf(req), jid(req), nOf(req)); res.status(201).json(r); } catch (error) { next(error); } });
  router.post(`${base}/:id/variations/:jid/results/:n/open-layers`, async (req, res, next) => { try { const r = await vr.openLayers(idOf(req), jid(req), nOf(req)); res.status(r.created ? 201 : 200).json(r); } catch (error) { next(error); } });
  router.post(`${base}/:id/variations/:jid/results/:n/regenerate`, json, async (req, res, next) => { try { res.json(await vr.regenerate(idOf(req), jid(req), nOf(req), { ai: req.body?.ai, approveArtworkUsd: req.body?.approveArtworkUsd, approveProductsUsd: req.body?.approveProductsUsd })); } catch (error) { next(error); } });
  router.delete(`${base}/:id/variations/:jid/results/:n`, async (req, res, next) => { try { res.json(await vr.remove(idOf(req), jid(req), nOf(req))); } catch (error) { next(error); } });
  router.get(`${base}/:id/revisions/:revision`, (req, res, next) => {
    try { const revision = Number(req.params.revision); if (!Number.isInteger(revision) || revision < 1) throw new RunError('NOT_FOUND', 'Revision not found.'); res.json(products.snapshot(idOf(req), revision)); } catch (error) { next(error); }
  });
  // Reuse Template studio (separate from variations): drafts, the person's pictures, live preview, formats, AI placement (approved), save, editor and decomposition.
  const rv = products.reuse, did = (req: Request) => String(req.params.did);
  const ratioOf = (req: Request) => { const r = String(req.params.ratio); return r === 'original' ? r : r.replace('x', ':'); };
  router.get(`${base}/:id/reuse`, (req, res, next) => { try { noStore(res); res.json({ drafts: rv.list(idOf(req)) }); } catch (error) { next(error); } });
  router.post(`${base}/:id/reuse`, json, async (req, res, next) => { try { res.status(201).json(await rv.create(idOf(req), req.body ?? {})); } catch (error) { next(error); } });
  router.get(`${base}/:id/reuse/:did`, async (req, res, next) => { try { noStore(res); res.json(await rv.get(idOf(req), did(req))); } catch (error) { next(error); } });
  router.put(`${base}/:id/reuse/:did`, json, async (req, res, next) => { try { res.json(await rv.update(idOf(req), did(req), req.body ?? {})); } catch (error) { next(error); } });
  router.post(`${base}/:id/reuse/:did/uploads`, async (req, res, next) => {
    try {
      const id = idOf(req), u = await readUpload(req);
      if (!u.bytes?.length) throw new RunError('INVALID_UPLOAD', 'Choose an image to upload.');
      res.status(201).json(await rv.upload(id, did(req), { bytes: u.bytes, filename: u.filename, kind: u.fields.kind, target: u.fields.target || undefined, label: u.fields.label, category: u.fields.category, ...(u.fields.expectedRevision ? { expectedRevision: Number(u.fields.expectedRevision) } : {}) }));
    } catch (error) { next(error); }
  });
  router.get(`${base}/:id/reuse/:did/preview`, async (req, res, next) => { try { noStore(res); res.json(await rv.preview(idOf(req), did(req), String(req.query.ratio ?? '').replace('x', ':'))); } catch (error) { next(error); } });
  router.post(`${base}/:id/reuse/:did/generate`, json, async (req, res, next) => { try { res.json(await rv.generate(idOf(req), did(req), req.body ?? {})); } catch (error) { next(error); } });
  router.post(`${base}/:id/reuse/:did/placement`, json, async (req, res, next) => { try { res.json(await rv.placeWithAi(idOf(req), did(req), req.body ?? {})); } catch (error) { next(error); } });
  router.post(`${base}/:id/reuse/:did/save`, json, async (req, res, next) => { try { res.json(await rv.save(idOf(req), did(req), req.body ?? {})); } catch (error) { next(error); } });
  router.post(`${base}/:id/reuse/:did/outputs/:ratio/open`, async (req, res, next) => { try { res.json(await rv.open(idOf(req), did(req), ratioOf(req))); } catch (error) { next(error); } });
  router.post(`${base}/:id/reuse/:did/outputs/:ratio/decomposition`, async (req, res, next) => { try { res.status(201).json(await rv.decompose(idOf(req), did(req), ratioOf(req))); } catch (error) { next(error); } });
}
