/**
 * Smart-edit analyses and creative variant sets on disk:
 *
 *   <analyses>/<analysisId>/analysis.json              the binding (image sha256, template version, analysis config),
 *                                                      state, validated scene and the call's files
 *   <analyses>/<analysisId>/source.<ext>               the analyzed image, exactly as uploaded
 *   <analyses>/<analysisId>/resolutions/<id>.json      a resolution bound to its exact draft and product photo
 *   <analyses>/<analysisId>/resolutions/<id>-reference.<ext>
 *   <variants>/<setId>/set.json                        a variant set: cutout, concepts, variants and their files
 *
 * Ids are timestamps plus random hex (validRunId); every write is atomic; a client's submission key never starts the
 * same paid work twice.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChangePlan, ExecutionImage, SceneDescription, SceneDraft, SceneSlotMapping, VariantSet } from '@frameflow/shared';
import { RunError, validRunId } from '../layerizeExperiment.js';
import { validIdempotencyKey } from './executions.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ANALYSES_DIR = resolve(here, '../../../../artifacts/decomposition/scene-analyses');
export const DEFAULT_VARIANTS_DIR = resolve(here, '../../../../artifacts/decomposition/creative-variants');
const KEYS = 'idempotency.json';
export const newRecordId = () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function atomic(path: string, value: Buffer | string | object) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(temp, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  renameSync(temp, path);
}
const FILE = /^[a-z0-9][a-z0-9.-]{0,80}$/;
/** A file name inside a record's folder: never a path. */
export const validFileName = (name: string) => FILE.test(name) && !name.includes('..');

export interface SceneAnalysisRecord {
  id: string; createdAt: string; updatedAt: string; idempotencyKey: string;
  state: 'analyzing' | 'ready' | 'failed';
  /** What the scene is valid for: reused only while all of it matches. */
  binding: { imageSha256: string; templateId: string; templateVersion: number; config: string };
  upload: ExecutionImage & { originalName?: string };
  model: string; calls: number; durationMs?: number; requestFile?: string; responseFile?: string;
  scene?: SceneDescription; mapping?: SceneSlotMapping;
  error?: { code: string; message: string };
}
export interface ResolutionRecord {
  id: string; analysisId: string; createdAt: string; updatedAt: string;
  state: 'resolving' | 'ready' | 'failed';
  /** The exact inputs this plan is for: generation checks every one of them again. */
  binding: { imageSha256: string; templateId: string; templateVersion: number; config: string; draft: string; referenceSha256?: string };
  draft: SceneDraft;
  reference?: ExecutionImage;
  plan?: ChangePlan; rejected?: string[];
  /** The compiled prompt (compileResolvedEdit) when the plan is clear: what generation sends, and what the preview shows. */
  prompt?: string; summary?: string;
  resolver: { called: boolean; model?: string; requestFile?: string; responseFile?: string; durationMs?: number; error?: string;
    /** The plan was rebuilt under newer rules from this resolution's saved resolver answer (no new call). */
    reusedFrom?: string };
  /** The plan rules this resolution was made with (absent: before Step 4's rules); an older one is rebuilt, never sent. */
  rules?: string;
  /** What the AI decided instead of asking (autoResolve), and the one-line summary of the user's intent. Older ones have none. */
  auto?: { summary: string; intent: string; decisions: { id: string; question: string; choice: string }[] };
  error?: { code: string; message: string };
}

export function fileSceneStore(root = DEFAULT_ANALYSES_DIR) {
  const dirOf = (id: string) => { if (!validRunId(id)) throw new RunError('NOT_FOUND', 'Analysis not found.'); return join(root, id); };
  const keys = (): Record<string, string> => { const p = join(root, KEYS); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Record<string, string> : {}; };
  const get = (id: string): SceneAnalysisRecord => { const p = join(dirOf(id), 'analysis.json'); if (!existsSync(p)) throw new RunError('NOT_FOUND', 'Analysis not found.'); return JSON.parse(readFileSync(p, 'utf8')) as SceneAnalysisRecord; };
  const list = () => (existsSync(root) ? readdirSync(root) : []).filter(validRunId).filter(id => existsSync(join(root, id, 'analysis.json'))).sort().reverse().map(get);
  const same = (a: SceneAnalysisRecord['binding'], b: SceneAnalysisRecord['binding']) => a.imageSha256 === b.imageSha256 && a.templateId === b.templateId && a.templateVersion === b.templateVersion && a.config === b.config;
  const resolutionPath = (analysisId: string, id: string) => { if (!validRunId(id)) throw new RunError('NOT_FOUND', 'Resolution not found.'); return join(dirOf(analysisId), 'resolutions', `${id}.json`); };
  return {
    /** A ready analysis for exactly this binding (the cached scene: no call), else one still analyzing it, else none. */
    find(binding: SceneAnalysisRecord['binding'], live: (id: string) => boolean) {
      const matches = list().filter(a => same(a.binding, binding));
      return matches.find(a => a.state === 'ready') ?? matches.find(a => a.state === 'analyzing' && live(a.id));
    },
    /** fresh: an explicit new analysis of the same binding (a ready scene is not reused; one still running is). */
    create(input: { idempotencyKey: string; binding: SceneAnalysisRecord['binding']; upload: { bytes: Buffer; ext: string; mimeType: string; width: number; height: number; originalName?: string }; model: string; fresh?: boolean }, live: (id: string) => boolean): { record: SceneAnalysisRecord; created: boolean } {
      if (!validIdempotencyKey(input.idempotencyKey)) throw new RunError('INVALID_IDEMPOTENCY_KEY', 'Each submission needs an idempotency key of 8–80 letters, digits, "-" or "_".');
      const known = keys()[input.idempotencyKey];
      if (known) {
        const existing = get(known);
        if (!same(existing.binding, input.binding)) throw new RunError('IDEMPOTENCY_CONFLICT', 'This submission key was already used for a different request.');
        return { record: existing, created: false };
      }
      // Everything below runs without an await: two requests can never both start the same analysis.
      const reuse = input.fresh ? list().find(a => same(a.binding, input.binding) && a.state === 'analyzing' && live(a.id)) : this.find(input.binding, live);
      if (reuse) { atomic(join(root, KEYS), { ...keys(), [input.idempotencyKey]: reuse.id }); return { record: reuse, created: false }; }
      const id = newRecordId(), now = new Date().toISOString(), file = `source.${input.upload.ext}`;
      const record: SceneAnalysisRecord = { id, createdAt: now, updatedAt: now, idempotencyKey: input.idempotencyKey, state: 'analyzing', binding: input.binding, model: input.model, calls: 0,
        upload: { file, mimeType: input.upload.mimeType, width: input.upload.width, height: input.upload.height, bytes: input.upload.bytes.length, sha256: input.binding.imageSha256, ...(input.upload.originalName ? { originalName: input.upload.originalName.slice(0, 200) } : {}) } };
      atomic(join(dirOf(id), file), input.upload.bytes);
      atomic(join(dirOf(id), 'analysis.json'), record);
      atomic(join(root, KEYS), { ...keys(), [input.idempotencyKey]: id });
      return { record, created: true };
    },
    get,
    update(id: string, change: (record: SceneAnalysisRecord) => void): SceneAnalysisRecord {
      const record = get(id), { binding, upload, createdAt } = record;
      change(record);
      Object.assign(record, { id, binding, upload, createdAt, updatedAt: new Date().toISOString() });
      atomic(join(dirOf(id), 'analysis.json'), record);
      return record;
    },
    path: (id: string, file: string) => { if (!validFileName(file)) throw new RunError('NOT_FOUND', 'File not found.'); return join(dirOf(id), file); },
    writeFile: (id: string, file: string, value: Buffer | object) => { if (!validFileName(file)) throw new RunError('INVALID_REQUEST', 'Invalid file name.'); atomic(join(dirOf(id), file), value); },
    /** A resolution of this analysis for exactly this binding that is ready (reused: no second resolver call). */
    findResolution(analysisId: string, binding: ResolutionRecord['binding'], state: ResolutionRecord['state'] = 'ready') {
      const dir = join(dirOf(analysisId), 'resolutions');
      // The newest ready (or, when asked, failed) resolution for exactly these inputs (a rebuilt one follows the one it was rebuilt from).
      return (existsSync(dir) ? readdirSync(dir) : []).filter(f => f.endsWith('.json')).sort().reverse().map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ResolutionRecord)
        .find(r => r.state === state && JSON.stringify(r.binding) === JSON.stringify(binding));
    },
    createResolution(analysisId: string, input: Omit<ResolutionRecord, 'id' | 'analysisId' | 'createdAt' | 'updatedAt' | 'state' | 'resolver'> & { referenceBytes?: Buffer; referenceExt?: string }): ResolutionRecord {
      const id = newRecordId(), now = new Date().toISOString(), { referenceBytes, referenceExt, ...rest } = input;
      const record: ResolutionRecord = { ...rest, id, analysisId, createdAt: now, updatedAt: now, state: 'resolving', resolver: { called: false } };
      if (referenceBytes && record.reference) atomic(join(dirOf(analysisId), 'resolutions', `${id}-reference.${referenceExt}`), referenceBytes);
      if (record.reference) record.reference = { ...record.reference, file: `resolutions/${id}-reference.${referenceExt}` };
      atomic(resolutionPath(analysisId, id), record);
      return record;
    },
    getResolution(analysisId: string, id: string): ResolutionRecord {
      const p = resolutionPath(analysisId, id);
      if (!existsSync(p)) throw new RunError('NOT_FOUND', 'Resolution not found.');
      return JSON.parse(readFileSync(p, 'utf8')) as ResolutionRecord;
    },
    updateResolution(analysisId: string, id: string, change: (record: ResolutionRecord) => void): ResolutionRecord {
      const record = this.getResolution(analysisId, id), { binding, draft, createdAt } = record;
      change(record);
      Object.assign(record, { id, analysisId, binding, draft, createdAt, updatedAt: new Date().toISOString() });
      atomic(resolutionPath(analysisId, id), record);
      return record;
    },
    /** A resolution's own file (its product photo), inside the analysis folder. */
    resolutionFile: (analysisId: string, file: string) => { if (!/^resolutions\/[0-9TZ-]+-[a-f0-9]{6}-reference\.(png|jpg|webp)$/.test(file)) throw new RunError('NOT_FOUND', 'File not found.'); return join(dirOf(analysisId), file); },
  };
}
export type SceneStore = ReturnType<typeof fileSceneStore>;

export function fileVariantStore(root = DEFAULT_VARIANTS_DIR) {
  const dirOf = (id: string) => { if (!validRunId(id)) throw new RunError('NOT_FOUND', 'Variant set not found.'); return join(root, id); };
  const keys = (): Record<string, string> => { const p = join(root, KEYS); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Record<string, string> : {}; };
  const get = (id: string): VariantSet => { const p = join(dirOf(id), 'set.json'); if (!existsSync(p)) throw new RunError('NOT_FOUND', 'Variant set not found.'); return JSON.parse(readFileSync(p, 'utf8')) as VariantSet; };
  return {
    /** The set this submission key already started (created: false), or a new one written as given. */
    create(make: (id: string) => VariantSet, idempotencyKey: string, sameRequest: (existing: VariantSet) => boolean): { set: VariantSet; created: boolean } {
      if (!validIdempotencyKey(idempotencyKey)) throw new RunError('INVALID_IDEMPOTENCY_KEY', 'Each submission needs an idempotency key of 8–80 letters, digits, "-" or "_".');
      const known = keys()[idempotencyKey];
      if (known) {
        const existing = get(known);
        if (!sameRequest(existing)) throw new RunError('IDEMPOTENCY_CONFLICT', 'This submission key was already used for a different request.');
        return { set: existing, created: false };
      }
      const set = make(newRecordId());
      atomic(join(dirOf(set.id), 'set.json'), set);
      atomic(join(root, KEYS), { ...keys(), [idempotencyKey]: set.id });
      return { set, created: true };
    },
    get,
    list: (limit = 30) => (existsSync(root) ? readdirSync(root) : []).filter(validRunId).filter(id => existsSync(join(root, id, 'set.json'))).sort().reverse().slice(0, limit).map(get),
    update(id: string, change: (set: VariantSet) => void): VariantSet {
      const set = get(id), { createdAt, idempotencyKey, source, analysisId, template } = set;
      change(set);
      Object.assign(set, { id, createdAt, idempotencyKey, source, analysisId, template, updatedAt: new Date().toISOString() });
      atomic(join(dirOf(id), 'set.json'), set);
      return set;
    },
    path: (id: string, file: string) => { if (!validFileName(file)) throw new RunError('NOT_FOUND', 'File not found.'); return join(dirOf(id), file); },
    writeFile: (id: string, file: string, value: Buffer | object) => { if (!validFileName(file)) throw new RunError('INVALID_REQUEST', 'Invalid file name.'); atomic(join(dirOf(id), file), value); },
  };
}
export type VariantStore = ReturnType<typeof fileVariantStore>;
