/**
 * Template executions on disk:
 *
 *   <root>/<executionId>/execution.json        the execution: mode, pinned template version, state, calls, run, error
 *   <root>/<executionId>/upload.<ext>          the uploaded image, exactly as received
 *   <root>/<executionId>/edited.<ext>          a reuse with an edit: the edited image, exactly as generated
 *   <root>/idempotency.json                    the client's submission key → its execution
 *
 * A submission is never executed twice: a repeated key (a double click, a retried request) returns the execution it
 * started, and the same upload for the same mode and template while one is still running (a refresh, a reconnect) is
 * that same execution too.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BlueprintCompatibility, ExecutionImage, ExecutionMode, ExecutionUsage, GenerationReview, TemplateEditOptions, TemplateExecution } from '@frameflow/shared';
import { RunError, validRunId } from '../layerizeExperiment.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_EXECUTIONS_DIR = resolve(here, '../../../../artifacts/decomposition/template-executions');
const RECORD = 'execution.json', KEYS = 'idempotency.json';
const KEY = /^[A-Za-z0-9_-]{8,80}$/;
export const validIdempotencyKey = (key: unknown): key is string => typeof key === 'string' && KEY.test(key);
const TERMINAL = new Set(['done', 'failed', 'generated']);

export type NewExecution = {
  /** Whether a process is still working on an execution. Work a restart left behind is not "still running". */
  live?: (id: string) => boolean;
  inspect?: boolean;
  editOptions?: TemplateEditOptions; compatibility?: BlueprintCompatibility;
  /** An optional image of the new product (the edit's second input image). */
  productReference?: { bytes: Buffer; ext: string; mimeType: string; width: number; height: number }; reviewBeforeDecompose?: boolean; slotValues?: Record<string, string>; mode: ExecutionMode; plannerReason?: 'new-structure' | 'plan-fresh'; updatesTemplate?: TemplateExecution['updatesTemplate']; idempotencyKey: string; template?: TemplateExecution['template']; upload: { bytes: Buffer; ext: string; mimeType: string; width: number; height: number; originalName?: string }; editInstruction?: string;
  /** A smart edit: the resolution its prompt was compiled from (checked by the service before this is called). */
  resolution?: TemplateExecution['resolution']; editPrompt?: string; generationPromptSource?: ExecutionUsage['generationPromptSource'];
  /** Nothing to change: review the original as it is (original), or the user's explicit new image anyway (regenerate). */
  editIntent?: 'original' | 'regenerate';
  /**
   * A creative variant chosen for review: its image already exists (no new call). It is stored as the execution's
   * generated image, waiting for the user's approval like any other.
   */
  prepared?: { image: { bytes: Buffer; ext: string; mimeType: string; width: number; height: number }; prompt: string; model: string; size: string; review: GenerationReview; files: Record<string, Buffer | object>;
    requestFile?: string; responseFile?: string; durationMs?: number; variant?: NonNullable<TemplateExecution['variant']>; variantSource?: TemplateExecution['variantSource']; verificationCalls: number; verifierModel?: string } };
export interface ExecutionStore {
  /** A new execution, or the one this submission already started (created: false). */
  create(input: NewExecution): { execution: TemplateExecution; created: boolean };
  get(id: string): TemplateExecution;
  update(id: string, change: (execution: TemplateExecution) => void): TemplateExecution;
  /** Newest first; only those of one template when asked. */
  list(filter?: { templateId?: string; limit?: number }): TemplateExecution[];
  path(id: string, file: string): string;
  writeFile(id: string, file: string, value: Buffer | string | object): void;
}

export function fileExecutionStore(root = DEFAULT_EXECUTIONS_DIR): ExecutionStore {
  const dirOf = (id: string) => { if (!validRunId(id)) throw new RunError('NOT_FOUND', 'Execution not found.'); return join(root, id); };
  const atomic = (path: string, value: Buffer | string | object) => {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    writeFileSync(temp, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    renameSync(temp, path);
  };
  const get = (id: string): TemplateExecution => {
    const path = join(dirOf(id), RECORD);
    if (!existsSync(path)) throw new RunError('NOT_FOUND', 'Execution not found.');
    return JSON.parse(readFileSync(path, 'utf8')) as TemplateExecution;
  };
  const keys = (): Record<string, string> => { const path = join(root, KEYS); return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, string> : {}; };
  const list = (filter: { templateId?: string; limit?: number } = {}) => (existsSync(root) ? readdirSync(root) : []).filter(validRunId).filter(id => existsSync(join(root, id, RECORD)))
    .sort().reverse().map(get).filter(e => !filter.templateId || e.template?.id === filter.templateId).slice(0, filter.limit ?? 50);
  return {
    create(input) {
      if (!validIdempotencyKey(input.idempotencyKey)) throw new RunError('INVALID_IDEMPOTENCY_KEY', 'Each submission needs an idempotency key of 8–80 letters, digits, "-" or "_".');
      const sha256 = createHash('sha256').update(input.upload.bytes).digest('hex');
      // Everything below runs without an await: two requests can never both pass these checks.
      const known = keys()[input.idempotencyKey];
      if (known) {
        const existing = get(known);
        if (existing.upload.sha256 !== sha256 || !!existing.automatic !== !!input.inspect || !!existing.reviewBeforeDecompose !== !!input.reviewBeforeDecompose || !input.inspect && (existing.mode !== input.mode || existing.template?.id !== input.template?.id || (existing.edit?.instruction ?? '') !== (input.editInstruction ?? ''))) throw new RunError('IDEMPOTENCY_CONFLICT', 'This submission key was already used for a different request.');
        return { execution: existing, created: false };
      }
      // A detection result waiting for the user is kept; unfinished work no process owns (a restart) never swallows a retry.
      const abandoned = (e: TemplateExecution) => e.state !== 'ready' && !!input.live && !input.live(e.id);
      const running = list({ limit: 200 }).find(e => !TERMINAL.has(e.state) && !abandoned(e) && !!e.automatic === !!input.inspect && !!e.reviewBeforeDecompose === !!input.reviewBeforeDecompose && e.upload.sha256 === sha256 && (input.inspect || e.mode === input.mode && e.template?.id === input.template?.id && (e.edit?.instruction ?? '') === (input.editInstruction ?? '')));
      if (running) { atomic(join(root, KEYS), { ...keys(), [input.idempotencyKey]: running.id }); return { execution: running, created: false }; }
      const now = new Date().toISOString(), id = `${now.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`, file = `upload.${input.upload.ext}`;
      const upload: ExecutionImage & { originalName?: string } = { file, mimeType: input.upload.mimeType, width: input.upload.width, height: input.upload.height, bytes: input.upload.bytes.length, sha256,
        ...(input.upload.originalName ? { originalName: input.upload.originalName.slice(0, 200) } : {}) };
      const prepared = input.prepared, preparedImage = prepared ? { file: `edited.${prepared.image.ext}`, mimeType: prepared.image.mimeType, width: prepared.image.width, height: prepared.image.height, bytes: prepared.image.bytes.length, sha256: createHash('sha256').update(prepared.image.bytes).digest('hex') } : undefined;
      const execution: TemplateExecution = { id, automatic: !!input.inspect, mode: input.mode, plannerReason: input.plannerReason, ...(input.updatesTemplate ? { updatesTemplate: input.updatesTemplate } : {}), idempotencyKey: input.idempotencyKey, state: input.inspect ? 'detecting' : prepared ? 'generated' : 'queued', createdAt: now, updatedAt: now, ...(input.template ? { template: input.template } : {}), upload,
        ...(input.resolution ? { resolution: input.resolution } : {}), ...(prepared?.variant ? { variant: prepared.variant } : {}), ...(prepared?.variantSource ? { variantSource: prepared.variantSource } : {}),
        ...(input.reviewBeforeDecompose ? { reviewBeforeDecompose: true } : {}), ...(input.slotValues ? { slotValues: input.slotValues } : {}),
        ...(input.editOptions ? { editOptions: input.editOptions } : {}), ...(input.compatibility ? { compatibility: input.compatibility } : {}),
        ...(input.editInstruction ? { edit: { instruction: input.editInstruction, prompt: prepared?.prompt ?? input.editPrompt ?? '', model: prepared?.model ?? '', size: prepared?.size ?? '', ...(input.editIntent ? { [input.editIntent]: true } : {}),
          ...(prepared ? { image: preparedImage, review: prepared.review, ...(prepared.requestFile ? { requestFile: prepared.requestFile } : {}), ...(prepared.responseFile ? { responseFile: prepared.responseFile } : {}), ...(prepared.durationMs ? { durationMs: prepared.durationMs } : {}) } : {}),
          ...(input.productReference ? { reference: {
          file: `product-reference.${input.productReference.ext}`, mimeType: input.productReference.mimeType, width: input.productReference.width, height: input.productReference.height,
          bytes: input.productReference.bytes.length, sha256: createHash('sha256').update(input.productReference.bytes).digest('hex') } } : {}) } } : {}),
        // A prepared variant's one image call was made in its variant set; it is this image's call, counted once here.
        usage: { plannerCalled: false, promptGenerationCalled: false, imageGenerationCalled: !!prepared, plannerCalls: 0, imageGenerationCalls: prepared ? 1 : 0, ...(prepared ? { imageModel: prepared.model, verificationCalls: prepared.verificationCalls, ...(prepared.verifierModel ? { verifierModel: prepared.verifierModel } : {}) } : {}),
          generationPromptSource: input.generationPromptSource ?? (prepared ? 'creative-variant' : input.mode === 'CREATE_TEMPLATE' ? 'planner' : 'saved-template'), decompositionPlanSource: input.mode === 'CREATE_TEMPLATE' ? 'planner' : 'saved-template', timings: { ...(prepared?.durationMs ? { generationMs: prepared.durationMs } : {}) } },
        warnings: [] };
      atomic(join(dirOf(id), file), input.upload.bytes);
      if (input.productReference && execution.edit?.reference) atomic(join(dirOf(id), execution.edit.reference.file), input.productReference.bytes);
      if (prepared && preparedImage) { atomic(join(dirOf(id), preparedImage.file), prepared.image.bytes); for (const [file, value] of Object.entries(prepared.files)) atomic(join(dirOf(id), file), value); }
      atomic(join(dirOf(id), RECORD), execution);
      atomic(join(root, KEYS), { ...keys(), [input.idempotencyKey]: id });
      return { execution, created: true };
    },
    get,
    update(id, change) {
      const execution = get(id), { id: own, mode, idempotencyKey, createdAt, upload, state } = execution;
      change(execution);
      // What was submitted never changes.
      Object.assign(execution, { id: own, mode: ['ready', 'detecting'].includes(state) ? execution.mode : mode, idempotencyKey, createdAt, upload, updatedAt: new Date().toISOString() });
      atomic(join(dirOf(id), RECORD), execution);
      return execution;
    },
    list,
    path: (id, file) => join(dirOf(id), file),
    writeFile: (id, file, value) => atomic(join(dirOf(id), file), value),
  };
}
