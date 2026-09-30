import { buildGenerationVariantPrompt, GENERATION_ASPECT_RATIOS, resolveGenerationBasePrompt, type GenerationAspectRatio, type GenerationField, type GenerationFieldValues, type GenerationProfile, type GenerationTemplateKey } from '@frameflow/shared';
import { groupingOf, ownsOptions, type ExperimentRun, type TemplateEntry, type TemplateOption } from './layerizeExperiment';

/**
 * The client side of the template test generators: the mechanics every template shares (groups, variants, the form, the
 * requests). What a template's creative is made of (its fields, its prompt wording, its notes) comes from that
 * template's GenerationProfile; nothing here knows one template from another.
 *
 * Mirrors the server's generation groups (server/src/decomposition/generationGroups.ts). A group is one creative of a
 * template; its variants are that creative in each aspect ratio. Records made before groups are served as a group with
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
  /** Runs made from this image: with Template A's held-object mode, or with the template's own options. */
  decompositions: { runId: string; createdAt: string; separateHeldObject?: boolean; templateOptions?: Record<string, boolean>; targetLayers?: number }[];
};
export type GenerationGroup = {
  id: string; templateKey: GenerationTemplateKey; version: string; createdAt: string; updatedAt: string;
  /** The shared creative definition: the fields, the prompt built from them, and the base prompt actually used (edited or not). */
  fields: GenerationFieldValues; builtPrompt: string; basePrompt: string; promptEdited: boolean;
  /** Facts a decomposition's defaults follow, for templates that have any (Template A: border, held object). */
  structure?: Record<string, boolean>; notes?: string[];
  aspectRatios: string[]; variants: GenerationVariant[];
  legacy?: true;
};
export type GeneratorInfo = { templateKey: GenerationTemplateKey; name: string; version: string; family: string; sameAcrossRatios: string; mayDiffer: string; skeleton: string; fields: GenerationField[]; defaults: GenerationFieldValues;
  aspectRatios: GenerationAspectRatio[]; imageSizes: Record<string, { width: number; height: number }>; consistency: string; framing: Record<string, string>; promptLimits: { base: number; final: number }; generator: { provider: 'openai'; model: string } };
export type CreationRequest = { fields: GenerationFieldValues; basePrompt?: string; aspectRatios: GenerationAspectRatio[] };
/** What a "decompose this variant" request carries: only the settings of the group's own template. */
export type DecomposeRequest = { separateHeldObject: boolean } | { templateOptions: Record<string, boolean> };

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const at = (groupId: string, variantId: string) => `/groups/${encodeURIComponent(groupId)}/variants/${encodeURIComponent(variantId)}`;
const baseOf = (templateKey: GenerationTemplateKey) => `/api/layerize-experiment/${templateKey}`;
/** The generator requests of one template. Every path is under that template's own prefix. */
export function generationApiFor(templateKey: GenerationTemplateKey) {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseOf(templateKey)}${path}`, { credentials: 'same-origin', ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 404 && !body?.error ? 'The experiment API is off. Start the server with LAYERIZE_EXPERIMENT=1.' : body?.error?.message ?? `Request failed (${response.status}).`);
    return body as T;
  }
  return {
    info: () => call<GeneratorInfo>('/generator'),
    list: () => call<{ groups: GenerationGroup[] }>('/groups'),
    get: (id: string) => call<GenerationGroup>(`/groups/${encodeURIComponent(id)}`),
    /** A new creative: the fields, the base prompt only when it was edited, and which ratios to generate now. The server builds every variant's prompt and answers at once; the images follow. */
    create: (request: CreationRequest) => call<GenerationGroup>('/groups', json(request)),
    /** One more variant of an existing creative: a failed one again, or one not generated yet. One paid request. */
    generateVariant: (groupId: string, variantId: string) => call<GenerationGroup>(`${at(groupId, variantId)}/generate`, { method: 'POST' }),
    /** Decomposes that variant's image, and only it, with this template. */
    decompose: (groupId: string, variantId: string, request: DecomposeRequest) => call<ExperimentRun>(`${at(groupId, variantId)}/decompose`, json(request)),
  };
}
export const variantImageUrlFor = (templateKey: GenerationTemplateKey) => (groupId: string, variantId: string) => `${baseOf(templateKey)}${at(groupId, variantId)}/image`;
/** On its way: queued behind another variant, or being generated now. */
export const isUnderway = (variant: Pick<GenerationVariant, 'status'>) => variant.status === 'queued' || variant.status === 'generating';

/**
 * The generator form: one creative definition and which ratios to generate now. editedPrompt is the shared base prompt
 * as the user rewrote it, or null while it is built from the fields. Results live outside the form, so nothing entered
 * is ever lost.
 */
export type GeneratorForm = { values: GenerationFieldValues; editedPrompt: string | null; ratios: GenerationAspectRatio[] };
export type GeneratorAction = { type: 'field'; key: string; value: string } | { type: 'editPrompt'; value: string | null } | { type: 'ratio'; ratio: GenerationAspectRatio; on: boolean }
  | { type: 'load'; group: Pick<GenerationGroup, 'fields' | 'basePrompt' | 'promptEdited'> };
type Defaults = Pick<GenerationProfile, 'defaults'>;
export const initialFormFor = (profile: Defaults): GeneratorForm => ({ values: { ...profile.defaults }, editedPrompt: null, ratios: [...GENERATION_ASPECT_RATIOS] });
export const generatorReducerFor = (profile: Defaults) => (state: GeneratorForm, action: GeneratorAction): GeneratorForm => {
  switch (action.type) {
    case 'field': return { ...state, values: { ...state.values, [action.key]: action.value } };
    case 'editPrompt': return { ...state, editedPrompt: action.value };
    // Kept in the fixed order, so the variants are always asked for as 1:1, 16:9, 4:5.
    case 'ratio': return { ...state, ratios: GENERATION_ASPECT_RATIOS.filter(ratio => ratio === action.ratio ? action.on : state.ratios.includes(ratio)) };
    // Load an earlier creative back into the form (to reproduce or vary it): its fields, and its prompt if that was edited.
    case 'load': return { ...state, values: { ...profile.defaults, ...action.group.fields }, editedPrompt: action.group.promptEdited ? action.group.basePrompt : null };
  }
};
/**
 * What the form would generate, built exactly as the server builds it with the same profile: the shared base prompt
 * (from the fields, or the edit) and the exact prompt of every ratio, or why there is none.
 */
export function resolvedCreativeFor(profile: GenerationProfile, form: GeneratorForm): { values?: GenerationFieldValues; builtPrompt?: string; basePrompt?: string; promptEdited: boolean; prompts?: Record<GenerationAspectRatio, string>; errors: string[] } {
  const { values, errors } = profile.resolveFields(form.values);
  if (errors.length) return { promptEdited: form.editedPrompt !== null, errors };
  const base = resolveGenerationBasePrompt(profile, values, form.editedPrompt ?? undefined);
  if (base.errors.length) return { values, builtPrompt: base.builtPrompt || undefined, promptEdited: base.promptEdited, errors: base.errors };
  try {
    return { values, builtPrompt: base.builtPrompt, basePrompt: base.basePrompt, promptEdited: base.promptEdited, errors: [],
      prompts: Object.fromEntries(GENERATION_ASPECT_RATIOS.map(ratio => [ratio, buildGenerationVariantPrompt(profile, base.basePrompt, ratio)])) as Record<GenerationAspectRatio, string> };
  } catch (error) { return { values, builtPrompt: base.builtPrompt, promptEdited: base.promptEdited, errors: [error instanceof Error ? error.message : String(error)] }; }
}
/** The request for a new creative: the base prompt is sent only when it really differs from the one the fields build. */
export function creationRequestFor(profile: GenerationProfile, form: GeneratorForm): CreationRequest {
  const resolved = resolvedCreativeFor(profile, form);
  return { fields: form.values, ...(resolved.promptEdited && resolved.basePrompt ? { basePrompt: resolved.basePrompt } : {}), aspectRatios: form.ratios };
}

/**
 * How a variant's image is handed to its own template's decomposition. Template A has its held-object mode; Templates B
 * and C take the options they declare (read from the server's template list, never written here). Which of the two a
 * template uses is fixed per template, as on the server (its generation handoffs), so one template's control can never
 * be shown for, or sent to, another.
 */
export const GENERATION_DECOMPOSITION: Record<GenerationTemplateKey, 'held-object' | 'declared-options'> = { 'template-a': 'held-object', 'template-b': 'declared-options', 'template-c': 'declared-options' };
export type DecompositionControls =
  /** Template A: one checkbox, usable only when the creative has a held object. */
  | { kind: 'held-object'; label: string; hasObject: boolean }
  /** Templates with their own options: every declared option with its default. */
  | { kind: 'options'; options: TemplateOption[] }
  /** The template's declared options are not known (the template list has not loaded): nothing can be sent. */
  | { kind: 'unavailable' };
export function decompositionControlsFor(templateKey: GenerationTemplateKey, template: TemplateEntry | undefined, group: Pick<GenerationGroup, 'structure'>): DecompositionControls {
  if (GENERATION_DECOMPOSITION[templateKey] === 'held-object') return { kind: 'held-object', label: groupingOf(template).label, hasObject: group.structure?.heldObject === true };
  return template?.key === templateKey && ownsOptions(template) ? { kind: 'options', options: template.options! } : { kind: 'unavailable' };
}
/** Template A's held-object choice is kept under this name among a variant's choices. */
export const HELD_OBJECT_CHOICE = 'separateHeldObject';
/**
 * The decompose request of one variant: for Template A the held-object mode (separate unless unticked, and only when
 * the creative has an object); for the others every declared option, at its default unless chosen. Undefined when the
 * template's options are unknown.
 */
export function decomposeRequestFor(controls: DecompositionControls, chosen: Record<string, boolean> = {}): DecomposeRequest | undefined {
  if (controls.kind === 'held-object') return { separateHeldObject: controls.hasObject && (chosen[HELD_OBJECT_CHOICE] ?? true) };
  if (controls.kind === 'options') return { templateOptions: Object.fromEntries(controls.options.map(option => [option.key, chosen[option.key] ?? option.default])) };
  return undefined;
}
/** How an earlier decomposition of a variant is named: by its template's own settings. */
export function decompositionLabel(item: GenerationVariant['decompositions'][number], template?: Pick<TemplateEntry, 'options'>): string {
  const settings = item.templateOptions
    ? (template?.options ?? []).filter(option => option.key in item.templateOptions!).map(option => `${option.label}: ${item.templateOptions![option.key] ? 'on' : 'off'}`).join(', ') || 'template options'
    : item.separateHeldObject ? 'held object separate' : 'combined';
  return `${settings}${item.targetLayers ? `, target ${item.targetLayers}` : ''}`;
}
