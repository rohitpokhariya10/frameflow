import { IMAGE_TEMPLATE_RATIOS, resolveImageTemplateName, resolveImageTemplatePrompt, type ReferenceCreativeDraft, type ImageVisualAnalysis, type DesignVariant, type ProjectDocument, type GenerationTemplateKey, type ImageTemplateRatio } from '@frameflow/shared';
import { isDesignVariant } from '../../lib/persistence/schema';
import { experimentToVariant, type ExperimentRun } from '../decomposition/layerizeExperiment';
import type { GenerationVariant } from '../decomposition/templateGeneration';

/**
 * The client side of "Create Template from Image". Mirrors the server's records and routes
 * (server/src/decomposition/imageTemplates.ts), and decides what each result shows. Nothing here calls a provider: every
 * request goes to the app's own server, and only the ones the user starts there spend anything.
 */
export type PromptGeneration = { status: 'generating' | 'done' | 'failed'; model: string; attempts: number; startedAt: string; durationMs?: number; error?: { code: string; message: string; status?: number } };
/** A ratio's latest decomposition, as the server shows it. */
export type DecompositionState = { runId: string; templateKey: string; createdAt: string; state: 'waiting' | 'running' | 'done' | 'failed'; stage: string; layers?: number; error?: { code: string; message: string }; resumable?: boolean };
export type ImageTemplateVariant = GenerationVariant & { sourceReference?: { file: string; sha256: string; instruction: string }; decompositions: (GenerationVariant['decompositions'][number] & { templateKey?: string })[]; editor?: { runId: string; openedAt: string }; decomposition?: DecompositionState };
export type ImageTemplate = {
  id: string; kind: 'image-template'; version: string; createdAt: string; updatedAt: string; name: string;
  workflow?: 'offer-reference'; referenceCreative?: ReferenceCreativeDraft; originTemplate?: { id: string; name: string };
  productReference?: ImageTemplate['reference'];
  generationSnapshot?: { id: string; referenceSha256: string; blueprintVersion: 1; settings: ReferenceCreativeDraft; analysis: ImageVisualAnalysis; productSha256?: string; model: string; instruction: string; aspectRatios: ImageTemplateRatio[] };
  reference: { file: string; originalName?: string; mimeType: string; width: number; height: number; bytes: number; sha256?: string; hasAlpha?: boolean; warnings?: string[] };
  analysis?: ImageVisualAnalysis; promptGeneration?: PromptGeneration; generatedPrompt?: string; prompt: string; promptEdited: boolean;
  detected?: { templateKey: GenerationTemplateKey; reason: string }; decomposeWith?: GenerationTemplateKey; decomposeWithChosen?: boolean;
  aspectRatios: ImageTemplateRatio[]; generatedAt?: string; ratioStrategy?: 'reference' | 'uploaded-reference'; variants: ImageTemplateVariant[];
};
export type ImageTemplateInfo = {
  ratios: { ratio: ImageTemplateRatio; name: string; width: number; height: number }[]; limits: { name: number; prompt: number };
  productReferenceSupported?: boolean; imageModel: string; promptModel: string; ratioReference: boolean; layerStyles: { key: GenerationTemplateKey; name: string; summary: string }[];
};
export type TemplateChange = Partial<{ name: string; prompt: string; aspectRatios: ImageTemplateRatio[]; decomposeWith: GenerationTemplateKey; referenceCreative: ReferenceCreativeDraft; originTemplate: { id: string; name: string } }>;

const BASE = '/api/layerize-experiment/image-templates';
const at = (id: string, path = '') => `${BASE}/${encodeURIComponent(id)}${path}`;
const ratioAt = (id: string, variantId: string, action: string) => at(id, `/variants/${encodeURIComponent(variantId)}/${action}`);
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 404 && !body?.error ? 'Create Template from Image needs the server\'s layerize experiment. Start it with LAYERIZE_EXPERIMENT=1.' : body?.error?.message ?? `Request failed (${response.status}).`);
  return body as T;
}
export const imageTemplateApi = {
  info: () => call<ImageTemplateInfo>(`${BASE}/info`),
  list: () => call<{ templates: ImageTemplate[] }>(BASE),
  get: (id: string) => call<ImageTemplate>(at(id)),
  /** A new reference draft. Standalone analyzes immediately; the integrated deferred path waits for Analyze. */
  create: (image: File, name: string, aspectRatios?: ImageTemplateRatio[], deferred = false) => {
    const form = new FormData();
    if (name.trim()) form.append('name', name);
    if (aspectRatios) form.append('aspectRatios', JSON.stringify(aspectRatios));
    form.append('image', image);
    return call<ImageTemplate>(deferred ? `${BASE}/draft` : BASE, { method: 'POST', body: form });
  },
  product: (id: string, image: File) => {
    const form = new FormData(); form.append('image', image);
    return call<ImageTemplate>(at(id, '/product-reference'), { method: 'POST', body: form });
  },
  removeProduct: (id: string) => call<ImageTemplate>(at(id, '/product-reference'), { method: 'DELETE' }),
  /** The prompt written again from the image (one OpenAI request); it replaces the working prompt. */
  regeneratePrompt: (id: string) => call<ImageTemplate>(at(id, '/prompt'), { method: 'POST' }),
  change: (id: string, change: TemplateChange) => call<ImageTemplate>(at(id), json('PATCH', change)),
  /** Generates each chosen ratio: one paid OpenAI image request each. */
  generate: (id: string, request: { name: string; prompt: string; aspectRatios: ImageTemplateRatio[]; referenceCreative?: ReferenceCreativeDraft }) => call<ImageTemplate>(at(id, '/generate'), json('POST', request)),
  /** One ratio adapted from the original upload: a retry or a size added later. One paid request. */
  generateRatio: (id: string, variantId: string) => call<ImageTemplate>(ratioAt(id, variantId, 'generate'), { method: 'POST' }),
  /** One OpenAI planner request and one paid Seedream call, plus the recursive cleanup only while the base is contaminated
   * (at most 2 Seedream calls and 1 OpenAI image edit); waits its turn behind any other decomposition. */
  decompose: (id: string, variantId: string) => call<ImageTemplate>(ratioAt(id, variantId, 'decompose'), { method: 'POST' }),
  /** Reads fal's saved result of a stopped decomposition: no new paid call. */
  resume: (id: string, variantId: string) => call<ImageTemplate>(ratioAt(id, variantId, 'resume'), { method: 'POST' }),
  opened: (id: string, variantId: string, runId: string) => call<ImageTemplate>(ratioAt(id, variantId, 'opened'), json('POST', { runId })),
};
export const referenceUrl = (template: Pick<ImageTemplate, 'id' | 'updatedAt'>) => at(template.id, '/reference');
export const productReferenceUrl = (template: ImageTemplate) => `${at(template.id, '/product-reference')}?v=${template.productReference?.sha256?.slice(0, 12) ?? ''}`;
export const resultImageUrl = (template: Pick<ImageTemplate, 'id'>, variant: Pick<ImageTemplateVariant, 'id' | 'image'>) => `${ratioAt(template.id, variant.id, 'image')}?v=${variant.image?.sha256?.slice(0, 12) ?? ''}`;

/** The ratios, each once, in the fixed order, with one turned on or off. */
export const withRatio = (ratios: readonly ImageTemplateRatio[], ratio: ImageTemplateRatio, on: boolean) => IMAGE_TEMPLATE_RATIOS.filter(item => item === ratio ? on : ratios.includes(item));
/** Why the template cannot be generated yet, as the user is told; empty when it can. */
export function generationBlockers(input: { name: string; prompt: string; ratios: readonly ImageTemplateRatio[]; promptGeneration?: PromptGeneration['status'] }): string[] {
  const blockers: string[] = [], name = resolveImageTemplateName(input.name), prompt = resolveImageTemplatePrompt(input.prompt);
  if (name.error) blockers.push(name.name ? name.error : 'Name your template.');
  if (input.promptGeneration === 'generating') blockers.push('Wait for the prompt to be written.');
  else if (prompt.error) blockers.push(prompt.prompt ? prompt.error : 'Generate the prompt from the image, or write one.');
  if (!input.ratios.length) blockers.push('Choose at least one size.');
  return blockers;
}

/**
 * What one result shows. The image's generation comes first; once it has its image, its latest decomposition decides:
 * waiting or running is "decomposing", finished is "decomposed", and finished and opened in the editor is "ready in editor".
 * `failure` says which step failed, so the card offers the right way on.
 */
export type ResultStatus = 'not-generated' | 'generating' | 'generated' | 'decomposing' | 'decomposed' | 'in-editor' | 'failed';
export const RESULT_STATUS_LABELS: Record<ResultStatus, string> = {
  'not-generated': 'Not generated', generating: 'Generating…', generated: 'Generated', decomposing: 'Decomposing…', decomposed: 'Decomposed', 'in-editor': 'Ready in editor', failed: 'Failed',
};
export function resultStatus(variant: Pick<ImageTemplateVariant, 'status' | 'error' | 'image' | 'editor' | 'decomposition'>): { status: ResultStatus; detail: string; failure?: 'generation' | 'decomposition' } {
  if (variant.status === 'pending') return { status: 'not-generated', detail: 'This size has not been generated.' };
  if (variant.status === 'queued') return { status: 'generating', detail: 'Waiting for the image before it to finish.' };
  if (variant.status === 'generating') return { status: 'generating', detail: 'Generating the image. This usually takes under a minute.' };
  if (variant.status === 'failed' || !variant.image) return { status: 'failed', detail: variant.error?.message ?? 'The image could not be generated.', failure: 'generation' };
  const run = variant.decomposition;
  if (!run) return { status: 'generated', detail: 'Ready to be decomposed into layers.' };
  if (run.state === 'waiting') return { status: 'decomposing', detail: 'Waiting for another decomposition to finish.' };
  if (run.state === 'running') return { status: 'decomposing', detail: 'Splitting the image into layers. This can take a few minutes.' };
  if (run.state === 'failed') return { status: 'failed', detail: run.error?.message ?? 'The decomposition failed.', failure: 'decomposition' };
  const layers = `${run.layers ?? 0} layer${run.layers === 1 ? '' : 's'}`;
  return variant.editor?.runId === run.runId ? { status: 'in-editor', detail: `${layers}, opened in the editor ${new Date(variant.editor.openedAt).toLocaleString()}.` } : { status: 'decomposed', detail: `${layers} ready to open in the editor.` };
}
/** Whether anything of the template is still on its way, so it is read again. */
export const templateInProgress = (template: ImageTemplate) => template.promptGeneration?.status === 'generating'
  || template.variants.some(variant => variant.status === 'queued' || variant.status === 'generating' || variant.decomposition?.state === 'waiting' || variant.decomposition?.state === 'running');
/** A line about the template for the list. */
export function templateSummary(template: ImageTemplate): string {
  if (!template.generatedAt) {
    const prompt = template.promptGeneration?.status;
    return prompt === 'generating' ? 'Draft · writing prompt…' : prompt === 'failed' && !template.prompt ? 'Draft · prompt failed' : template.prompt ? 'Draft · prompt ready' : 'Draft';
  }
  const shown = template.variants.filter(variant => template.aspectRatios.includes(variant.aspectRatio as ImageTemplateRatio)).map(resultStatus);
  const count = (status: ResultStatus) => shown.filter(item => item.status === status).length;
  const parts = [template.aspectRatios.join(' · ')];
  if (count('generating')) parts.push('generating…');
  else if (count('decomposing')) parts.push('decomposing…');
  else if (count('in-editor') + count('decomposed')) parts.push(`${count('in-editor') + count('decomposed')} decomposed`);
  else if (count('generated')) parts.push(`${count('generated')} generated`);
  if (count('failed')) parts.push(`${count('failed')} failed`);
  return parts.join(' · ');
}
/** The list with this template in it: replaced where it is, else added first (newest first). */
export const withTemplate = (list: ImageTemplate[], template: ImageTemplate) => list.some(item => item.id === template.id) ? list.map(item => item.id === template.id ? template : item) : [template, ...list];

type Assets = { putAsset(id: string, blob: Blob): Promise<unknown>; deleteAsset(id: string): Promise<unknown> };
/** The most versions a design keeps (the persisted document's limit). */
export const MAX_VERSIONS = 30;
const removeAssets = (variant: DesignVariant, assets: Assets) => Promise.all((variant.layers ?? []).map(layer => layer.type === 'image' && layer.assetId ? assets.deleteAsset(layer.assetId).catch(() => undefined) : undefined));
/**
 * A finished decomposition as an editor version, named after the template and its ratio. The layers are imported by the
 * same function the OpenAI + Seedream test panel uses (experimentToVariant); on any failure the stored layer pictures
 * are removed again. `versions`: the design it would join, which keeps at most 30 (omitted for a design of its own).
 * `importedFrom`: the template result it comes from.
 */
export async function importAsVersion(run: Pick<ExperimentRun, 'id' | 'canvas' | 'layers' | 'outputLayers'>, name: string, options: { versions?: number; fetchFile: (file: string) => Promise<Blob>; assets: Assets; newId?: () => string; importedFrom?: ResultSource }): Promise<DesignVariant> {
  const variant: DesignVariant = { ...(await experimentToVariant(run, options.fetchFile, options.assets, options.newId)), name: name.slice(0, 120), ...(options.importedFrom ? { importedFrom: options.importedFrom } : {}) };
  const full = options.versions !== undefined && options.versions >= MAX_VERSIONS;
  if (!isDesignVariant(variant) || full) {
    await removeAssets(variant, options.assets);
    throw new Error(full ? 'This design already has 30 versions. Delete one and try again.' : 'The layers could not be opened as a design version.');
  }
  return variant;
}

/** A decomposed template result: the template, the result (its ratio) and the decomposition run it was opened from. */
export type ResultSource = { templateId: string; resultId: string; runId: string };
const sameSource = (a: ResultSource | undefined, b: ResultSource) => !!a && a.templateId === b.templateId && a.resultId === b.resultId && a.runId === b.runId;

export type OpenInEditorDeps = {
  /** The design open in the editor now, and the other designs kept on this device (lib/persistence/designLibrary.ts). */
  current: () => ProjectDocument; stored: () => { id: string; importedFrom?: ResultSource }[];
  /** Switch to a stored design, or open a new one; either way the design that was open is kept as it is. */
  openStored: (id: string) => void; openNew: (document: ProjectDocument) => void;
  select: (versionId: string) => void;
  /** Reads of the app's own server: the stored decomposition run and its files. Never a provider call. */
  run: (runId: string) => Promise<ExperimentRun>; file: (runId: string, file: string) => Promise<Blob>;
  /** Records on the server that this result was opened (for "Ready in editor"); its failure does not undo the open. */
  recordOpened: (runId: string) => Promise<unknown>;
  assets: Assets; newId?: () => string; now?: () => string;
  /** False once the caller no longer wants the result (closed, switched template): nothing is opened then. */
  wanted?: () => boolean;
};
export type OpenedResult = { documentId: string; created: boolean };
const opening = new Map<string, Promise<OpenedResult | undefined>>();
/**
 * Opens a decomposed template result in the editor, the same way for every ratio, from what is already stored: no
 * planner, image or decomposition request is ever made. A result is a design of its own: the first open creates it (one
 * version, the result's canvas and layers) and the editor switches to it; opening it again switches back to that same
 * design. It never adds a version to the design that was open, so that design's version limit never applies. A second
 * click while one is opening joins it (one design, never two).
 */
export function openResultInEditor(template: { id: string; name: string }, result: Pick<ImageTemplateVariant, 'id' | 'aspectRatio' | 'decomposition' | 'editor'>, deps: OpenInEditorDeps): Promise<OpenedResult | undefined> {
  const runId = result.decomposition?.state === 'done' ? result.decomposition.runId : undefined;
  if (!runId) return Promise.reject(new Error('This image has no finished decomposition yet.'));
  const source: ResultSource = { templateId: template.id, resultId: result.id, runId }, key = JSON.stringify(source), name = `${template.name} · ${result.aspectRatio}`.slice(0, 120);
  const pending = opening.get(key);
  if (pending) return pending;
  const work = (async (): Promise<OpenedResult | undefined> => {
    const record = () => result.editor?.runId === runId ? undefined : deps.recordOpened(runId).catch(() => undefined);
    // Already open: show its version.
    const open = deps.current(), version = open.variants.find(variant => sameSource(variant.importedFrom, source));
    if (version) { deps.select(version.id); await record(); return { documentId: open.id, created: false }; }
    // Opened before: switch back to it.
    const stored = deps.stored().find(entry => sameSource(entry.importedFrom, source));
    if (stored) {
      if (deps.wanted && !deps.wanted()) return undefined;
      deps.openStored(stored.id);
      await record();
      return { documentId: stored.id, created: false };
    }
    // First open: a new design from the stored decomposition.
    const run = await deps.run(runId), newId = deps.newId ?? (() => crypto.randomUUID()), at = deps.now?.() ?? new Date().toISOString();
    const imported = await importAsVersion(run, name, { fetchFile: file => deps.file(run.id, file), assets: deps.assets, newId, importedFrom: source });
    const document: ProjectDocument = { schemaVersion: 1, id: `design-${newId()}`, name, createdAt: at, updatedAt: at, variants: [imported] };
    if (deps.wanted && !deps.wanted()) { await removeAssets(imported, deps.assets); return undefined; }
    try { deps.openNew(document); }
    catch (error) {
      await removeAssets(imported, deps.assets);
      throw new Error(`The ${result.aspectRatio} result could not be opened: ${error instanceof Error ? error.message : 'browser storage refused it'}. The design that was open is unchanged.`, { cause: error });
    }
    await record();
    return { documentId: document.id, created: true };
  })().finally(() => opening.delete(key));
  opening.set(key, work);
  return work;
}
