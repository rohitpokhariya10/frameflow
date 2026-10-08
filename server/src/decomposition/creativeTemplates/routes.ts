/**
 * The creative templates API, under the decomposition router:
 *
 *   GET    /templates                              the library (active templates, newest first)
 *   GET    /templates/:id                          a template, its current version and its recent executions
 *   GET    /templates/:id/versions/:version        one exact version
 *   GET    /templates/:id/thumbnail                its source creative
 *   PATCH  /templates/:id                          { name?, description? } (metadata only; never a new version)
 *   DELETE /templates/:id                          removes it from the library (its versions stay for past executions)
 *   POST   /template-executions                    multipart: image, mode, idempotencyKey, templateId?, editInstruction?
 *   POST   /template-executions/inspect            automatic upload detection, persisted as a ready execution
 *   POST   /template-executions/:id/start          proceed with optional role values or Plan fresh
 *   GET    /template-executions/:id                an execution and its decomposition's state
 *   POST   /templates/:id/versions                 plan settings → a new version (runs keep theirs)
 *   POST   /templates/:id/replan                   an explicit new plan of the source creative (planner 1) → a new version
 *   GET    /template-executions/:id/images/:which  upload | edited | reference
 *   POST   /template-executions/:id/decompose      { plan?, acknowledgeReview? } — the user's explicit approval of a generated creative
 *   POST   /template-executions/:id/retry-extraction { plan } — an explicit new extraction after a failed one
 *   POST   /template-executions/:id/resume         a stopped run read again from fal's saved request (no new call)
 *   POST   /template-executions/:id/opened         { runId } — the result was opened in the editor
 *
 * A smart edit is a POST /template-executions with analysisId, resolutionId and draft (smartRoutes.ts resolves them):
 * the server checks the resolution's binding to that image, draft, product photo and template version before any call.
 *
 * Inspection may make one structure-only call. Starting an execution spends only what its resolved mode allows.
 */
import express, { type Request, type Router } from 'express';
import busboy from 'busboy';
import type { TemplateExecution, TemplateVersion } from '@frameflow/shared';
import { decompositionState } from '../imageTemplates.js';
import { MAX_UPLOAD_BYTES, RunError } from '../layerizeExperiment.js';
import type { ExecutionStore } from './executions.js';
import type { TemplateExecutions } from './service.js';
import { validTemplateId, type TemplateStore } from './store.js';
import { executionGenerationCost } from '../runDiagnostics.js';
import { settingsChange, templateHealth, templateText, versionWithSettings } from './templateEdits.js';

type ExecutionForm = { bytes: Buffer; fileName?: string; mimeType?: string; fields: Record<string, string>; productReference?: { bytes: Buffer; fileName?: string; mimeType?: string } };
const FORM_FIELDS = ['mode', 'idempotencyKey', 'templateId', 'templateVersion', 'editInstruction', 'values', 'options', 'planFresh', 'allowMismatch', 'reviewBeforeDecompose', 'analysisId', 'resolutionId', 'draft'];
function readExecutionForm(req: Request): Promise<ExecutionForm> {
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof busboy>;
    try { parser = busboy({ headers: req.headers, limits: { files: 2, fields: FORM_FIELDS.length, parts: FORM_FIELDS.length + 2, fieldSize: 16_000, fileSize: MAX_UPLOAD_BYTES } }); }
    catch { reject(new RunError('INVALID_UPLOAD', 'Upload one image as multipart form data.')); return; }
    let file: Buffer | undefined, fileName: string | undefined, mimeType: string | undefined, truncated = false, reference: ExecutionForm['productReference'];
    const fields: Record<string, string> = {};
    parser.on('field', (name, value, info) => { if (info.valueTruncated) truncated = true; if (FORM_FIELDS.includes(name)) fields[name] = value; });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => reject(new RunError('INVALID_UPLOAD', 'Upload one image with its settings.')));
    parser.on('file', (name, stream, info) => {
      // The creative is "image"; an optional image of the new product is "productReference".
      const isReference = name === 'productReference', chunks: Buffer[] = [];
      if (!isReference) { fileName = info.filename; mimeType = info.mimeType; }
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => { truncated = true; });
      stream.on('end', () => { if (isReference) reference = { bytes: Buffer.concat(chunks), fileName: info.filename, mimeType: info.mimeType }; else file = Buffer.concat(chunks); });
    });
    parser.on('error', () => reject(new RunError('INVALID_UPLOAD', 'The upload could not be read.')));
    req.on('aborted', () => { parser.destroy(); reject(new RunError('INVALID_UPLOAD', 'The upload was interrupted. Please upload the image again.')); });
    parser.on('close', () => truncated ? reject(new RunError('UPLOAD_TOO_LARGE', `Images must be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB; settings must fit the form limits.`))
      : file?.length ? resolve({ bytes: file, fileName, mimeType, fields, ...(reference?.bytes.length ? { productReference: reference } : {}) }) : reject(new RunError('INVALID_UPLOAD', 'Choose an image to upload.')));
    req.pipe(parser);
  });
}

export type CreativeTemplateRouteContext = { templates: TemplateStore; executions: ExecutionStore; service: TemplateExecutions; runsDir: string; runState: (runId: string) => 'active' | 'waiting' | undefined };
export function registerCreativeTemplateRoutes(router: Router, ctx: CreativeTemplateRouteContext): { shown: (execution: TemplateExecution) => unknown } {
  const { templates, executions, service } = ctx;
  const template = (id: string) => { const found = validTemplateId(id) ? templates.get(id) : undefined; if (!found || found.status !== 'active') throw new RunError('NOT_FOUND', 'Template not found.'); return found; };
  /** An execution as shown: work a stopped server left behind is shown as interrupted, with its decomposition's state. */
  const shown = (execution: TemplateExecution) => {
    const interrupted = !['done', 'failed', 'ready', 'generated'].includes(execution.state) && !service.isActive(execution.id);
    const run = execution.runId ? decompositionState(ctx.runsDir, { runId: execution.runId, createdAt: execution.createdAt }, ctx.runState) : undefined;
    return { ...execution, ...(interrupted ? { state: 'failed' as const, error: { code: 'INTERRUPTED', message: 'The server stopped before this finished. Resume it, or start it again.', state: execution.state } } : {}),
      generationCost: executionGenerationCost(execution, executions, process.env.AI_BUDGET_USD_INR), ...(run ? { decomposition: run } : {}) };
  };

  router.get('/templates', (_req, res) => res.json({ templates: templates.list() }));
  router.get('/templates/:id', async (req, res, next) => {
    try {
      const found = template(req.params.id), version = templates.current(found.id)!, recent = executions.list({ templateId: found.id, limit: 10 });
      // Every version, oldest first, with how it was made: provenance for runs that used an earlier one.
      const versions = found.versions.map(n => templates.version(found.id, n)).filter((v): v is TemplateVersion => !!v)
        .map(v => ({ version: v.version, createdAt: v.createdAt, ...(v.derivedFrom ? { derivedFrom: v.derivedFrom } : {}), runs: executions.list({ templateId: found.id }).filter(e => e.template?.version === v.version).length }));
      res.json({ template: found, version, versions, executions: recent.map(shown), health: await templateHealth(version, ctx.runsDir, recent) });
    } catch (error) { next(error); }
  });
  router.get('/templates/:id/versions/:version', (req, res, next) => {
    try {
      const version = validTemplateId(req.params.id) ? templates.version(req.params.id, Number(req.params.version)) : undefined;
      if (!version) throw new RunError('NOT_FOUND', 'Template version not found.');
      res.json(version);
    } catch (error) { next(error); }
  });
  router.get('/templates/:id/thumbnail', (req, res, next) => {
    try { const path = templates.thumbnailPath(template(req.params.id).id); if (!path) throw new RunError('NOT_FOUND', 'This template has no thumbnail.'); res.setHeader('Cache-Control', 'no-store'); res.sendFile(path); }
    catch (error) { next(error); }
  });
  router.patch('/templates/:id', express.json({ limit: '4kb' }), (req, res, next) => {
    try {
      const id = template(req.params.id).id, text = templateText(req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {});
      res.json(templates.update(id, (t) => { if (text.name !== undefined) t.name = text.name; if (text.description !== undefined) t.description = text.description; }));
    } catch (error) { next(error); }
  });
  // Plan settings: always a new version (runs keep theirs); the plan is recompiled locally, no planner call.
  router.post('/templates/:id/versions', express.json({ limit: '4kb' }), (req, res, next) => {
    try {
      const found = template(req.params.id), current = templates.current(found.id);
      if (!current) throw new RunError('STALE_TEMPLATE_VERSION', 'This template has no current version.');
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
      if (body.fromVersion !== undefined && body.fromVersion !== current.version) throw new RunError('STALE_TEMPLATE_VERSION', `This template is now at v${current.version}. Reload it before changing its settings.`);
      const { fromVersion: _from, ...settings } = body; void _from;
      const change = settingsChange(settings, current);
      const version = templates.addVersion(found.id, n => versionWithSettings(current, change, { version: n, name: found.name, description: found.description }));
      res.status(201).json({ template: templates.get(found.id), version });
    } catch (error) { next(error); }
  });
  // An explicit new plan of the template's source creative: one planner call plus extraction, saved as its next version.
  router.post('/templates/:id/replan', express.json({ limit: '1kb' }), async (req, res, next) => {
    try {
      const found = template(req.params.id), key = (req.body as Record<string, unknown> | undefined)?.idempotencyKey;
      if (typeof key !== 'string' || key.length < 8 || key.length > 100) throw new RunError('INVALID_REQUEST', 'A replan needs an idempotency key.');
      const { execution, created } = await service.replan(found.id, key);
      res.status(created ? 202 : 200).json(shown(execution));
    } catch (error) { next(error); }
  });
  router.delete('/templates/:id', (req, res, next) => {
    try { res.json(templates.update(template(req.params.id).id, (t) => { t.status = 'deleted'; })); }
    catch (error) { next(error); }
  });

  router.get('/template-executions', (_req, res) => res.json({ executions: executions.list().map(shown) }));
  router.post('/template-executions/inspect', async (req, res, next) => {
    try {
      const form = await readExecutionForm(req);
      if (Object.keys(form.fields).some(k => k !== 'idempotencyKey')) throw new RunError('INVALID_REQUEST', 'Automatic detection takes an image and submission key only.');
      const { execution, created } = await service.start({ mode: 'CREATE_TEMPLATE', inspect: true, idempotencyKey: form.fields.idempotencyKey,
        upload: { bytes: form.bytes, fileName: form.fileName, mimeType: form.mimeType } });
      res.status(created ? 202 : 200).json(shown(execution));
    } catch (error) { next(error); }
  });
  router.post('/template-executions/:id/start', express.json({ limit: '4kb' }), (req, res, next) => {
    try {
      const body = req.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['values', 'planFresh'].includes(k))) throw new RunError('INVALID_REQUEST', 'Use the detected fields or Plan fresh.');
      res.status(202).json(shown(service.proceed(req.params.id, body)));
    } catch (error) { next(error); }
  });
  router.post('/template-executions', async (req, res, next) => {
    try {
      const form = await readExecutionForm(req);
      let values: unknown, options: unknown, draft: unknown;
      if (form.fields.values !== undefined) { try { values = JSON.parse(form.fields.values); } catch { throw new RunError('INVALID_REQUEST', 'Template fields must be valid JSON.'); } }
      if (form.fields.draft !== undefined) { try { draft = JSON.parse(form.fields.draft); } catch { throw new RunError('INVALID_REQUEST', 'The smart edit draft must be valid JSON.'); } }
      if (form.fields.options !== undefined) { try { options = JSON.parse(form.fields.options); } catch { throw new RunError('INVALID_REQUEST', 'Edit options must be valid JSON.'); } }
      const { execution, created } = await service.start({ mode: form.fields.mode, values, ...(options !== undefined ? { options } : {}),
        ...(form.fields.resolutionId !== undefined ? { resolutionId: form.fields.resolutionId, analysisId: form.fields.analysisId, draft } : form.fields.analysisId !== undefined || draft !== undefined ? { analysisId: form.fields.analysisId, draft } : {}), ...(form.productReference ? { productReference: form.productReference } : {}), reviewBeforeDecompose: form.fields.reviewBeforeDecompose === 'true', allowMismatch: form.fields.allowMismatch === 'true', templateVersion: form.fields.templateVersion !== undefined ? Number(form.fields.templateVersion) : undefined,
        planFresh: form.fields.planFresh === 'true', idempotencyKey: form.fields.idempotencyKey, ...(form.fields.templateId !== undefined ? { templateId: form.fields.templateId } : {}),
        ...(form.fields.editInstruction !== undefined ? { editInstruction: form.fields.editInstruction } : {}), upload: { bytes: form.bytes, ...(form.fileName ? { fileName: form.fileName } : {}), ...(form.mimeType ? { mimeType: form.mimeType } : {}) } });
      res.status(created ? 202 : 200).json(shown(execution));
    } catch (error) { next(error); }
  });
  router.get('/template-executions/:id', (req, res, next) => { try { res.json(shown(executions.get(req.params.id))); } catch (error) { next(error); } });
  router.get('/template-executions/:id/images/:which', (req, res, next) => {
    try {
      const execution = executions.get(req.params.id), image = req.params.which === 'upload' ? execution.upload : req.params.which === 'edited' ? execution.edit?.image : undefined;
      if (!image) throw new RunError('NOT_FOUND', 'Image not found.');
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(executions.path(execution.id, image.file));
    } catch (error) { next(error); }
  });
  router.post('/template-executions/:id/resume', (req, res, next) => { try { res.status(202).json(shown(service.resume(req.params.id))); } catch (error) { next(error); } });
  router.post('/template-executions/:id/decompose', express.json({ limit: '1kb' }), (req, res, next) => {
    try { const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {}; res.status(202).json(shown(service.decompose(req.params.id, { plan: body.plan, acknowledgeReview: body.acknowledgeReview }))); }
    catch (error) { next(error); }
  });
  router.post('/template-executions/:id/retry-extraction', express.json({ limit: '1kb' }), (req, res, next) => {
    try { res.status(202).json(shown(service.retryExtraction(req.params.id, { plan: (req.body as Record<string, unknown> | undefined)?.plan }))); }
    catch (error) { next(error); }
  });
  router.post('/template-executions/:id/opened', express.json({ limit: '1kb' }), (req, res, next) => {
    try { res.json(shown(service.opened(req.params.id, typeof req.body?.runId === 'string' ? req.body.runId : ''))); }
    catch (error) { next(error); }
  });
  return { shown };
}
