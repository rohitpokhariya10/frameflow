import { IMAGE_TEMPLATE_RATIOS, resolveImageTemplateName, resolveImageTemplatePrompt, type DesignVariant, type GenerationTemplateKey, type ImageTemplateRatio } from '@frameflow/shared';
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
  reference: { file: string; originalName?: string; mimeType: string; width: number; height: number; bytes: number };
  promptGeneration?: PromptGeneration; generatedPrompt?: string; prompt: string; promptEdited: boolean;
  detected?: { templateKey: GenerationTemplateKey; reason: string }; decomposeWith?: GenerationTemplateKey; decomposeWithChosen?: boolean;
  aspectRatios: ImageTemplateRatio[]; generatedAt?: string; ratioStrategy?: 'reference' | 'uploaded-reference'; variants: ImageTemplateVariant[];
};
export type ImageTemplateInfo = {
  ratios: { ratio: ImageTemplateRatio; name: string; width: number; height: number }[]; limits: { name: number; prompt: number };
  imageModel: string; promptModel: string; ratioReference: boolean; layerStyles: { key: GenerationTemplateKey; name: string; summary: string }[];
};
export type TemplateChange = Partial<{ name: string; prompt: string; aspectRatios: ImageTemplateRatio[]; decomposeWith: GenerationTemplateKey }>;

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
  /** A new draft from the reference; its prompt is asked for at once (one OpenAI request). */
  create: (image: File, name: string, aspectRatios?: ImageTemplateRatio[]) => {
    const form = new FormData();
    if (name.trim()) form.append('name', name);
    if (aspectRatios) form.append('aspectRatios', JSON.stringify(aspectRatios));
    form.append('image', image);
    return call<ImageTemplate>(BASE, { method: 'POST', body: form });
  },
  /** The prompt written again from the image (one OpenAI request); it replaces the working prompt. */
  regeneratePrompt: (id: string) => call<ImageTemplate>(at(id, '/prompt'), { method: 'POST' }),
  change: (id: string, change: TemplateChange) => call<ImageTemplate>(at(id), json('PATCH', change)),
  /** Generates each chosen ratio: one paid OpenAI image request each. */
  generate: (id: string, request: { name: string; prompt: string; aspectRatios: ImageTemplateRatio[] }) => call<ImageTemplate>(at(id, '/generate'), json('POST', request)),
  /** One ratio adapted from the original upload: a retry or a size added later. One paid request. */
  generateRatio: (id: string, variantId: string) => call<ImageTemplate>(ratioAt(id, variantId, 'generate'), { method: 'POST' }),
  /** One OpenAI planner request and one paid Seedream call; waits its turn behind any other decomposition. */
  decompose: (id: string, variantId: string) => call<ImageTemplate>(ratioAt(id, variantId, 'decompose'), { method: 'POST' }),
  /** Reads fal's saved result of a stopped decomposition: no new paid call. */
  resume: (id: string, variantId: string) => call<ImageTemplate>(ratioAt(id, variantId, 'resume'), { method: 'POST' }),
  opened: (id: string, variantId: string, runId: string) => call<ImageTemplate>(ratioAt(id, variantId, 'opened'), json('POST', { runId })),
};
export const referenceUrl = (template: Pick<ImageTemplate, 'id' | 'updatedAt'>) => at(template.id, '/reference');
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
/**
 * A finished decomposition as a new editor version, named after the template and its ratio. The layers are imported
 * by the same function the OpenAI + Seedream test panel uses (experimentToVariant), with the same checks: the editor
 * keeps at most 30 versions, and on any failure the stored layer pictures are removed again.
 */
export async function importAsVersion(run: Pick<ExperimentRun, 'id' | 'canvas' | 'layers' | 'outputLayers'>, name: string, options: { versions: number; fetchFile: (file: string) => Promise<Blob>; assets: Assets; newId?: () => string }): Promise<DesignVariant> {
  const variant = { ...(await experimentToVariant(run, options.fetchFile, options.assets, options.newId)), name: name.slice(0, 120) };
  if (!isDesignVariant(variant) || options.versions >= 30) {
    await Promise.all((variant.layers ?? []).map(layer => layer.type === 'image' && layer.assetId ? options.assets.deleteAsset(layer.assetId).catch(() => undefined) : undefined));
    throw new Error(options.versions >= 30 ? 'This design already has 30 versions. Delete one and try again.' : 'The layers could not be opened as a design version.');
  }
  return variant;
}
