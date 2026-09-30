import { buildTemplateAVariantPrompt, resolveTemplateABasePrompt, resolveTemplateAFields, TEMPLATE_A_ASPECT_RATIOS, TEMPLATE_A_DEFAULTS, type TemplateAAspectRatio, type TemplateAField, type TemplateAFieldKey, type TemplateAFieldValues } from '@frameflow/shared';
import type { ExperimentRun } from './layerizeExperiment';

/**
 * Mirrors the server's generation groups (server/src/decomposition/templateAGeneration.ts). A group is one Template A
 * creative; its variants are that creative in each aspect ratio. Records made before groups are served as a group with
 * one variant (`legacy`).
 */
export type VariantStatus = 'pending' | 'queued' | 'generating' | 'done' | 'failed';
export type GenerationVariant = {
  id: string; aspectRatio: string; size: { width: number; height: number }; status: VariantStatus;
  /** The ratio's framing sentence, and the exact prompt sent: the group's base prompt, the consistency sentence, this framing. */
  framing: string; prompt: string;
  generator: { provider: string; model: string; requestId?: string }; attempts: number; durationMs?: number;
  image?: { file: string; mimeType: string; width: number; height: number; bytes: number; sha256?: string };
  error?: { code: string; message: string; status?: number; messages?: { msg: string; type?: string }[]; bodyFile?: string };
  decompositions: { runId: string; createdAt: string; separateHeldObject: boolean; targetLayers?: number }[];
};
export type GenerationGroup = {
  id: string; templateKey: 'template-a'; version: string; createdAt: string; updatedAt: string;
  /** The shared creative definition: the fields, the prompt built from them, and the base prompt actually used (edited or not). */
  fields: TemplateAFieldValues; builtPrompt: string; basePrompt: string; promptEdited: boolean;
  structure: { visibleBorder: boolean; heldObject: boolean }; aspectRatios: string[]; variants: GenerationVariant[];
  legacy?: true;
};
export type GeneratorInfo = { version: string; skeleton: string; fields: TemplateAField[]; defaults: TemplateAFieldValues; aspectRatios: TemplateAAspectRatio[];
  imageSizes: Record<string, { width: number; height: number }>; consistency: string; framing: Record<string, string>; promptLimits: { base: number; final: number }; generator: { provider: 'openai'; model: string } };

const BASE = '/api/layerize-experiment/template-a';
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 404 && !body?.error ? 'The experiment API is off. Start the server with LAYERIZE_EXPERIMENT=1.' : body?.error?.message ?? `Request failed (${response.status}).`);
  return body as T;
}
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const at = (groupId: string, variantId: string) => `/groups/${encodeURIComponent(groupId)}/variants/${encodeURIComponent(variantId)}`;
export type CreationRequest = { fields: TemplateAFieldValues; basePrompt?: string; aspectRatios: TemplateAAspectRatio[] };
export const generationApi = {
  info: () => call<GeneratorInfo>('/generator'),
  list: () => call<{ groups: GenerationGroup[] }>('/groups'),
  get: (id: string) => call<GenerationGroup>(`/groups/${encodeURIComponent(id)}`),
  /** A new creative: the fields, the base prompt only when it was edited, and which ratios to generate now. The server builds every variant's prompt and answers at once; the images follow. */
  create: (request: CreationRequest) => call<GenerationGroup>('/groups', json(request)),
  /** One more variant of an existing creative: a failed one again, or one not generated yet. One paid request. */
  generateVariant: (groupId: string, variantId: string) => call<GenerationGroup>(`${at(groupId, variantId)}/generate`, { method: 'POST' }),
  /** Decomposes that variant's image, and only it. The server picks the layer target from the creative's structure. */
  decompose: (groupId: string, variantId: string, request: { separateHeldObject: boolean }) => call<ExperimentRun>(`${at(groupId, variantId)}/decompose`, json(request)),
};
export const variantImageUrl = (groupId: string, variantId: string) => `${BASE}${at(groupId, variantId)}/image`;
/** On its way: queued behind another variant, or being generated now. */
export const isUnderway = (variant: Pick<GenerationVariant, 'status'>) => variant.status === 'queued' || variant.status === 'generating';

/**
 * The generator form: one creative definition and which ratios to generate now. editedPrompt is the shared base prompt
 * as the user rewrote it, or null while it is built from the fields. Results live outside the form, so nothing entered
 * is ever lost.
 */
export type GeneratorForm = { values: TemplateAFieldValues; editedPrompt: string | null; ratios: TemplateAAspectRatio[] };
export type GeneratorAction = { type: 'field'; key: TemplateAFieldKey; value: string } | { type: 'editPrompt'; value: string | null } | { type: 'ratio'; ratio: TemplateAAspectRatio; on: boolean }
  | { type: 'load'; group: Pick<GenerationGroup, 'fields' | 'basePrompt' | 'promptEdited'> };
export const initialForm = (): GeneratorForm => ({ values: { ...TEMPLATE_A_DEFAULTS }, editedPrompt: null, ratios: [...TEMPLATE_A_ASPECT_RATIOS] });
export function generatorReducer(state: GeneratorForm, action: GeneratorAction): GeneratorForm {
  switch (action.type) {
    case 'field': return { ...state, values: { ...state.values, [action.key]: action.value } };
    case 'editPrompt': return { ...state, editedPrompt: action.value };
    // Kept in the fixed order, so the variants are always asked for as 1:1, 16:9, 4:5.
    case 'ratio': return { ...state, ratios: TEMPLATE_A_ASPECT_RATIOS.filter(ratio => ratio === action.ratio ? action.on : state.ratios.includes(ratio)) };
    // Load an earlier creative back into the form (to reproduce or vary it): its fields, and its prompt if that was edited.
    case 'load': return { ...state, values: { ...TEMPLATE_A_DEFAULTS, ...action.group.fields }, editedPrompt: action.group.promptEdited ? action.group.basePrompt : null };
  }
}
/**
 * What the form would generate, built exactly as the server builds it: the shared base prompt (from the fields, or the
 * edit) and the exact prompt of every ratio, or why there is none.
 */
export function resolvedCreative(form: GeneratorForm): { builtPrompt?: string; basePrompt?: string; promptEdited: boolean; prompts?: Record<TemplateAAspectRatio, string>; errors: string[] } {
  const { values, errors } = resolveTemplateAFields(form.values);
  if (errors.length) return { promptEdited: form.editedPrompt !== null, errors };
  const base = resolveTemplateABasePrompt(values, form.editedPrompt ?? undefined);
  if (base.errors.length) return { builtPrompt: base.builtPrompt || undefined, promptEdited: base.promptEdited, errors: base.errors };
  try {
    return { builtPrompt: base.builtPrompt, basePrompt: base.basePrompt, promptEdited: base.promptEdited, errors: [],
      prompts: Object.fromEntries(TEMPLATE_A_ASPECT_RATIOS.map(ratio => [ratio, buildTemplateAVariantPrompt(base.basePrompt, ratio)])) as Record<TemplateAAspectRatio, string> };
  } catch (error) { return { builtPrompt: base.builtPrompt, promptEdited: base.promptEdited, errors: [error instanceof Error ? error.message : String(error)] }; }
}
/** The request for a new creative: the base prompt is sent only when it really differs from the one the fields build. */
export function creationRequest(form: GeneratorForm): CreationRequest {
  const resolved = resolvedCreative(form);
  return { fields: form.values, ...(resolved.promptEdited && resolved.basePrompt ? { basePrompt: resolved.basePrompt } : {}), aspectRatios: form.ratios };
}
