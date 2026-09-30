import { CANVAS_LIMITS, validateCanvasSize, type DesignLayer, type DesignVariant } from '@frameflow/shared';

/** Mirrors the server's run.json for the OpenAI → Seedream layerize experiment (server/src/decomposition/layerizeExperiment.ts). */
export type Placement = { kind: 'base' | 'full-canvas' | 'bbox-crop' | 'bbox-scaled' | 'unresolved'; x: number; y: number; width: number; height: number; reason?: string };
/** `rebuilt`: this layer's `file` was rebuilt locally (clean full-canvas outer background); `rawFile` is the untouched provider layer. */
export type ExperimentLayer = { index: number; file: string; zIndex: number; name?: string; description?: string; pixelWidth: number; pixelHeight: number; opaquePercent: number; placement: Placement;
  rawFile?: string; rebuilt?: { method: string; from: string[]; foreground?: string[]; holePercent: number; texture: string; contaminationPercent?: number; residualPercent?: number };
  /** Output layers only: the semantic layer files this one was made from (its own file when not merged). */
  sources?: string[] };
/** Server LayerCount (layerCount.ts): the exact output layer count applied locally after Seedream. */
export type LayerCount = { suggestedLayers?: number; targetLayers?: number; providerReturnedLayers: number; semanticLayers: number; finalOutputLayers: number; normalized: boolean;
  groups: { name: string; file: string; sourceLayers: string[] }[]; warnings: string[];
  /** Templates B and C: each semantic layer's locally classified role and why (attached: part of the main product; folded: into the background). */
  roles?: { file: string; name?: string; role: string; reason: string; attached?: boolean; folded?: boolean }[] };
export type PlannedLayer = { name: string; description: string };
/** A Seedream prompt saved under a template key (server/src/decomposition/layerizeTemplates.ts). */
export type SavedTemplatePrompt = {
  templateKey: string; templateName: string; prompt: string; planned_layers: PlannedLayer[]; warnings: string[]; savedAt: string; notes?: string;
  sourceRunId: string; sourceImage: { file: string; width: number; height: number }; plannerModel: string; plannerResponseId?: string;
};
/**
 * Expected semantic layers of a template; `heldObject` layers exist only when the held object is separate; `foreground`
 * layers (subject, held object) stay apart from the background in the output layer count.
 */
export type LayerRole = { name: string; heldObject?: boolean; foreground?: boolean };
/** Server TemplateDefinition (layerizeTemplates.ts): roles, the grouping checkbox texts, and whether the natural count is dynamic. */
export type TemplateGrouping = { label: string; checked: string; unchecked: string; minReason: string; modeName: string };
/** A template's own checkbox (server TemplateOption), e.g. Template B's "Separate touching / overlapping independent objects". */
export type TemplateOption = { key: string; label: string; help: string; default: boolean };
export type TemplateEntry = { key: string; name: string; description: string; layerRoles?: LayerRole[]; dynamicLayerCount?: boolean; grouping?: TemplateGrouping; saved?: SavedTemplatePrompt;
  /** 'automatic': Seedream gets no prompt; OpenAI is not called and there is no prompt to save or reuse. */
  providerPrompt?: 'planned' | 'automatic';
  /** The template's own options (Template B). A template with options does not use the held-object checkbox. */
  options?: TemplateOption[];
  /** The prompt names one image's own layers (Template B): never saved or reused. */
  imageSpecificPrompt?: boolean;
  /** A rejected run can be retried with an empty prompt (Template B). */
  emptyPromptRetry?: boolean };
/** Templates that declare their own options (Template B) own their controls; the others (Template A) use the held-object checkbox. */
export const ownsOptions = (template?: Pick<TemplateEntry, 'options'>) => !!template?.options?.length;
/** Every declared option of the template with its value (the default unless chosen), or undefined for templates without options. */
export const templateOptionValues = (template: Pick<TemplateEntry, 'options'> | undefined, chosen: Record<string, boolean> = {}) =>
  ownsOptions(template) ? Object.fromEntries(template!.options!.map(option => [option.key, chosen[option.key] ?? option.default])) : undefined;
/** Seedream layerize returns a base image plus at most 16 layers. */
export const MAX_OUTPUT_LAYERS = 17;
/** Template A's texts, for older servers or runs without template metadata. */
export const DEFAULT_GROUPING: TemplateGrouping = { label: 'Separate held object from subject', checked: 'Checked: subject and held object become separate layers.',
  unchecked: 'Unchecked: held object stays combined with the subject.', minReason: 'background, subject and held object', modeName: 'Held object mode' };
export const groupingOf = (template?: Pick<TemplateEntry, 'grouping'>) => template?.grouping ?? DEFAULT_GROUPING;
/** Output layer count for a run (including the base). minLayers/maxLayers only exist on runs made when it was a range. */
export type LayerTarget = { templateKey: string; suggestedLayers: number; targetLayers?: number; minLayers?: number; maxLayers?: number };
/** Same rule as the server's suggestedLayerCount: the template's expected layers, including the base. */
/** Same rule as the server's suggestedLayerCount: the template's expected layers, including the base; unknown before a run for dynamic templates. */
export const suggestedLayers = (template: Pick<TemplateEntry, 'layerRoles' | 'dynamicLayerCount'> | undefined, separateHeldObject: boolean) =>
  template?.dynamicLayerCount ? undefined : template?.layerRoles?.filter(role => separateHeldObject || !role.heldObject).length;
/** Same rule as the server's targetLayerRange (natural: a decomposition's natural count, for dynamic templates). */
export function targetLayerRange(template: Pick<TemplateEntry, 'layerRoles' | 'dynamicLayerCount' | 'options'> | undefined, separateHeldObject: boolean, natural?: number): { min: number; max: number } | undefined {
  // Templates with their own options (Template B) have no held-object separate mode.
  const separate = !ownsOptions(template) && separateHeldObject;
  const roles = template?.layerRoles?.filter(role => separate || !role.heldObject);
  if (!roles?.length) return undefined;
  const min = separate ? 1 + roles.filter(role => role.foreground).length : 1;
  return { min, max: template?.dynamicLayerCount ? Math.max(min, natural ?? MAX_OUTPUT_LAYERS) : roles.length };
}
/**
 * Parses the Target layers input, with the same messages as the server's targetLayersProblem. Empty means the suggested
 * count, or no target (the natural layers as returned) for dynamic templates.
 */
export function parseTargetLayers(text: string, template: Pick<TemplateEntry, 'name' | 'layerRoles' | 'dynamicLayerCount' | 'grouping' | 'options'> | undefined, separateHeldObject: boolean, natural?: number): { targetLayers?: number; error?: string } {
  const range = targetLayerRange(template, separateHeldObject, natural);
  if (!range || !template) return {};
  if (!text.trim()) return template.dynamicLayerCount ? {} : { targetLayers: range.max };
  const value = Number(text), grouping = groupingOf(template);
  if (!/^\d+$/.test(text.trim()) || value < range.min || value > range.max) {
    const why = template.dynamicLayerCount ? (natural !== undefined ? `${range.max} is this decomposition's natural semantic layer count` : `${range.max} is Seedream's layer limit; the natural count is known after decomposition`) : `${range.max} is the natural semantic layer count`;
    if (ownsOptions(template)) return { error: `Target layers must be a whole number from ${range.min} to ${range.max} for ${template.name} (${why}).` };
    return { error: separateHeldObject && /^\d+$/.test(text.trim()) && value >= 1 && value < range.min
      ? `Target layers ${value} is too low for separate mode: ${grouping.minReason} need at least ${range.min} layers. Choose ${range.min}–${range.max}, or uncheck "${grouping.label}" to allow fewer.`
      : `Target layers must be a whole number from ${range.min} to ${range.max} for ${template.name} in ${separateHeldObject ? 'separate' : 'combined'} mode (${why}).` };
  }
  return { targetLayers: value };
}
export type PromptMode = 'generated' | 'template';
/**
 * fal's own status and messages for a failed provider call (server: ProviderFailure in layerizeExperiment.ts). `reason` is
 * fal's ctx.extra_info.reason; `bodyFile` is the run file with fal's complete error response.
 */
export type ProviderFailure = { code: string; status: number; messages: { msg: string; type?: string; loc?: string; reason?: string }[]; billableUnits?: string; requestId?: string; bodyFile?: string };
export type ExperimentRun = {
  id: string; stage: string; active?: boolean; createdAt: string;
  /** Which template the run belongs to; absent on older runs (Template A). */
  templateKey?: string;
  /** Absent on runs created before template prompts existed; those generated their prompt. */
  promptSource?: { mode: 'generated' } | ({ mode: 'template' } & SavedTemplatePrompt)
    | { mode: 'retry'; fromRunId: string; providerPrompt?: 'current' | 'auto'; prompt: string; planned_layers: PlannedLayer[]; warnings: string[] }
    | { mode: 'automatic'; retryOf?: string };
  /** "Separate held object from subject" (Template A); absent on older runs, which all separated it, and on Template B runs. */
  separateHeldObject?: boolean;
  /** The template's own options (Template B: separateTouchingIndependentObjects); absent for Template A. */
  templateOptions?: Record<string, boolean>;
  /** The template fit check before planning (server layerizeTemplateFit.ts); absent when none ran. */
  templateFit?: { fits: boolean; bestTemplate: string | null; plausibleTemplates?: string[]; reason: string; model: string; durationMs: number };
  /** The user ran it anyway, without the fit check. */
  skipFitCheck?: boolean;
  /** Where the image came from when not an upload: a template's test generation (the creative's group) and, since creatives have aspect-ratio variants, which variant. */
  origin?: { kind: 'template-a-generation' | 'template-b-generation' | 'template-c-generation'; generationId: string; variantId?: string; aspectRatio?: string };
  /** The exact prompt sent to Seedream after held-object grouping; absent on older runs. */
  finalPrompt?: string;
  /** Suggested and target output layer count; absent on older runs. */
  layerTarget?: LayerTarget;
  error?: { code: string; message: string; stage: string; provider?: ProviderFailure };
  original: { file: string; width: number; height: number };
  input: { file: string; width: number; height: number; orientationNormalized: boolean };
  planner?: { model: string; responseId?: string; usage?: Record<string, number | undefined>; durationMs: number; prompt: string; planned_layers: PlannedLayer[]; warnings: string[] };
  seedream: { endpoint: string; requestId?: string; status?: string };
  timings: Record<string, number>;
  /** layers: semantic layers; outputLayers: the final layers at the target count; layerCount: the counts and merges. */
  canvas?: { width: number; height: number }; layers?: ExperimentLayer[]; outputLayers?: ExperimentLayer[]; layerCount?: LayerCount; warnings: string[];
};

/** The prompt this run sent (or will send) to Seedream, with its planned layers and warnings. */
export const runPrompt = (run: ExperimentRun) => run.promptSource?.mode === 'template' || run.promptSource?.mode === 'retry' ? run.promptSource : run.planner;

const BASE = '/api/layerize-experiment';
export const experimentFileUrl = (runId: string, file: string) => `${BASE}/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(file)}`;
export const experimentZipUrl = (runId: string) => `${BASE}/runs/${encodeURIComponent(runId)}/outputs.zip`;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 404 && !body?.error ? 'The experiment API is off. Start the server with LAYERIZE_EXPERIMENT=1.' : body?.error?.message ?? `Request failed (${response.status}).`);
  return body as T;
}
export const experimentApi = {
  list: () => call<{ active: string | null; runs: ExperimentRun[] }>('/runs'),
  get: (id: string) => call<ExperimentRun>(`/runs/${encodeURIComponent(id)}`),
  /** templateOptions: the selected template's own options (Template B); omitted for templates without them. */
  /** skipFitCheck: "Run anyway" past the template fit check (only sent when true). */
  start: (file: File, mode: PromptMode = 'generated', templateKey?: string, separateHeldObject = true, targetLayers?: number, templateOptions?: Record<string, boolean>, skipFitCheck = false) => {
    const form = new FormData();
    form.append('promptMode', mode);
    form.append('separateHeldObject', String(separateHeldObject));
    if (targetLayers !== undefined) form.append('targetLayers', String(targetLayers));
    if (templateKey) form.append('templateKey', templateKey);
    if (templateOptions) form.append('templateOptions', JSON.stringify(templateOptions));
    if (skipFitCheck) form.append('skipFitCheck', 'true');
    form.append('image', file);
    return call<ExperimentRun>('/runs', { method: 'POST', body: form });
  },
  /** fitCheck: whether new runs are checked against the template first (one extra OpenAI call); off in the test harness by default. */
  templates: () => call<{ templates: TemplateEntry[]; fitCheck?: boolean }>('/templates'),
  saveTemplate: (key: string, runId: string, notes?: string) => call<SavedTemplatePrompt>(`/templates/${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, notes }) }),
  /** targetLayers re-renders a finished run at another exact count from its saved result (no provider call). */
  /** Explicit user action: a NEW run (one paid Seedream call) for a run Seedream rejected. 'current' reuses its prompt;
   * 'auto' (Template B) sends an empty prompt, Seedream's automatic major-elements mode. */
  retry: (id: string, providerPrompt: 'current' | 'auto' = 'current') => call<ExperimentRun>(`/runs/${encodeURIComponent(id)}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerPrompt }) }),
  resume: (id: string, requestId?: string, targetLayers?: number) => call<ExperimentRun>(`/runs/${encodeURIComponent(id)}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(requestId ? { requestId } : {}), ...(targetLayers !== undefined ? { targetLayers } : {}) }) }),
};

type Assets = { putAsset(id: string, blob: Blob): Promise<unknown>; deleteAsset(id: string): Promise<unknown> };

/**
 * A completed run as a new editor version on a transparent canvas: its final output layers (the semantic layers on runs
 * without a target), the generated base at the bottom, then each layer back-to-front at its resolved placement. Unresolved layers are added hidden at their natural size and marked,
 * never stretched. Coordinates are scaled uniformly only if the base exceeds the editor canvas limit. Assets are stored
 * first; on failure they are removed and nothing is added.
 */
export async function experimentToVariant(run: Pick<ExperimentRun, 'id' | 'canvas' | 'layers' | 'outputLayers'>, fetchFile: (file: string) => Promise<Blob>, assets: Assets, newId: () => string = () => crypto.randomUUID()): Promise<DesignVariant> {
  const source = run.outputLayers ?? run.layers;
  if (!run.canvas || !source?.length) throw new Error('This run has no layers yet.');
  const scale = Math.min(1, CANVAS_LIMITS.maxSide / run.canvas.width, CANVAS_LIMITS.maxSide / run.canvas.height, Math.sqrt(CANVAS_LIMITS.maxArea / (run.canvas.width * run.canvas.height)));
  const width = Math.floor(run.canvas.width * scale), height = Math.floor(run.canvas.height * scale);
  if (!validateCanvasSize(width, height).valid) throw new Error(`The base (${run.canvas.width} × ${run.canvas.height}) does not fit the editor canvas limits.`);
  const stored: string[] = [];
  try {
    const layers: DesignLayer[] = [];
    for (const layer of [...source].sort((a, b) => a.zIndex - b.zIndex)) {
      const assetId = `layerize-${newId()}`;
      await assets.putAsset(assetId, await fetchFile(layer.file));
      stored.push(assetId);
      const p = layer.placement, unresolved = p.kind === 'unresolved';
      // Unresolved: natural size, shrunk to fit the canvas if needed, at the top-left and hidden.
      const k = unresolved ? Math.min(1, run.canvas.width / p.width, run.canvas.height / p.height) : 1;
      const label = p.kind === 'base' ? 'Generated base' : layer.name || 'Layer';
      layers.push({ id: `layer-${newId()}`, type: 'image', assetId, name: `${unresolved ? '⚠ unplaced: ' : ''}${label} (z${layer.zIndex})`.slice(0, 200),
        x: p.x * scale, y: p.y * scale, width: Math.max(1, p.width * k * scale), height: Math.max(1, p.height * k * scale), rotation: 0, opacity: 1, visible: !unresolved, locked: false });
    }
    return { id: `layerize-${newId()}`, name: `OpenAI + Seedream ${run.id.slice(0, 16)}`, revision: 0, canvas: { width, height, backgroundColor: '#FFFFFF', transparent: true }, elements: [], layers };
  } catch (error) {
    await Promise.all(stored.map(id => assets.deleteAsset(id).catch(() => undefined)));
    throw error instanceof Error ? error : new Error('The run could not be imported.');
  }
}
