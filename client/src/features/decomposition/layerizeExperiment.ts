import { CANVAS_LIMITS, validateCanvasSize, type DesignLayer, type DesignVariant } from '@frameflow/shared';

/** Mirrors the server's run.json for the OpenAI → Seedream layerize experiment (server/src/decomposition/layerizeExperiment.ts). */
export type Placement = { kind: 'base' | 'full-canvas' | 'bbox-crop' | 'bbox-scaled' | 'unresolved'; x: number; y: number; width: number; height: number; reason?: string };
/** `rebuilt`: this layer's `file` was rebuilt locally (clean full-canvas outer background); `rawFile` is the untouched provider layer. */
export type ExperimentLayer = { index: number; file: string; zIndex: number; name?: string; description?: string; pixelWidth: number; pixelHeight: number; opaquePercent: number; placement: Placement;
  rawFile?: string; rebuilt?: { method: string; from: string[]; foreground?: string[]; holePercent: number; texture: string; contaminationPercent?: number; residualPercent?: number };
  /** Output layers only: the semantic layer files this one was made from (its own file when not merged). */
  sources?: string[];
  /** Refined runs: which pass made this layer (0 = the initial decomposition, 1–2 = residual passes) and from what. */
  provenance?: LayerProvenance;
  /** A group kept together to protect a person or an interaction (server interactionGrouping.ts): its members and why. */
  grouping?: LayerGrouping;
  /** Refined runs, base layer only: how its clean background was made and whether it is verified clean. */
  cleanBackground?: { status: CleanBackgroundStatus; method: CleanBackgroundMethod } };
/** Server LayerGrouping (layerizeArtifacts.ts): members stay with `parent`; protectedInteraction: a hand and what it holds kept intact. */
export type LayerGrouping = { groupedWithParent: boolean; parent: string; protectedInteraction?: 'hand_holding_object'; attachmentReason: string;
  members: { file: string; name?: string; role: string; reason: string }[] };
/** Server InteractionRecord (interactionGrouping.ts): every grouping decision, including clean splits kept separate. */
export type InteractionRecord = { layersBefore: number; layersAfter: number; groups: number;
  decisions: { decision: 'grouped' | 'kept-separate'; role: string; file: string; name?: string; parent?: string; reason: string }[] };
/** Server LayerProvenance (layerizeArtifacts.ts). */
export type LayerProvenance = { sourcePass: number; sourceImage: string; parentResidualId?: string; providerFile: string; providerRequestId?: string; providerZIndex: number; role: string;
  bbox?: [number, number, number, number]; mask: string; areaPercent?: number; groupedFrom?: string[] };
export type CleanBackgroundStatus = 'provider-clean' | 'scene-clean' | 'continued-clean' | 'ai-reconstructed' | 'contaminated' | 'fallback';
export type CleanBackgroundMethod = 'provider-base' | 'scene-composite' | 'plain-field' | 'ai-reconstruction' | 'graphic-fill' | 'local-fill';
/** Server LayerPlan (layerUsefulness.ts): the editor's meaningful layers by category, and every layer left out and why. */
export type LayerPlan = { screenedLayers: number; editableLayers: number; byCategory: Record<string, number>; backgroundKind?: 'plain' | 'graphic' | 'scene';
  dropped: { file: string; name?: string; category: string; reason?: string; detail: string; action?: 'fold' | 'remove' }[] };
/** Server BackgroundQuality (backgroundRecovery.ts): whether the area behind the removed foreground is a usable continuation. */
export type BackgroundQualityInfo = { quality: 'usable' | 'degraded' | 'failed'; reasons: string[]; metrics: Record<string, number | undefined> };
/** Server CallCounts (recursiveDecomposition.ts): every provider request a refined run sent, counted when sent. */
export type CallCounts = { fitCheck: number; planner: number; seedreamInitial: number; seedreamResidual: number; backgroundReconstruction: number };
/** Server RefinementRecord (recursiveDecomposition.ts), the fields the panel shows. */
export type Refinement = {
  state: 'pending' | 'running' | 'done' | 'failed'; options: { maxDepth: number; maxTotalLayers: number; reconstructBackground: boolean };
  passes: { pass: number; state: string; requestId?: string; returnedLayers?: number; accepted: string[]; grouped?: string[]; rejected: { file: string; name?: string; reason: string; duplicateOf?: string }[]; error?: { code: string; message: string } }[];
  assessments: { after: number; residual: string; sent: boolean; verdict: string; contaminatedPercent: number; reasons: string[] }[];
  stopReason?: string; stopDetail?: string; passesExecuted?: number; finalLayers?: number;
  mask?: { coveragePercent: number; dilatePx: number; featherPx: number; file: string; shadowPercent?: number; shadowFile?: string };
  background?: { status: CleanBackgroundStatus; method: string; file: string; contaminated: boolean; reasons: string[];
    quality?: BackgroundQualityInfo['quality']; validation?: BackgroundQualityInfo; difficulty?: { level: string; coveragePercent: number; largestComponentPercent: number; simpleGraphic: boolean };
    candidates?: { method: CleanBackgroundMethod; quality: BackgroundQualityInfo['quality']; reasons: string[]; chosen: boolean }[]; fallbackUsed?: boolean; aiTried?: boolean; outsideMaskChangedPercent?: number;
    shadow?: { percent: number; note: string } };
  layerPlan?: LayerPlan;
  fidelity?: { before: { meanAbsDiff: number }; after: { meanAbsDiff: number } };
  warnings: string[]; error?: string };
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
  /** The recursive refinement (residual passes and a clean background); absent on runs made without it. */
  refinement?: Refinement;
  /** Refined runs: every provider request sent, by kind. */
  calls?: CallCounts;
  /** Image-aware and refined runs: people and interactions kept intact (worn ornaments, finger fragments, held objects). */
  interactions?: InteractionRecord;
};

export const BACKGROUND_STATUS_LABELS: Record<CleanBackgroundStatus, string> = { 'provider-clean': 'Clean (Seedream base, no reconstruction needed)', 'scene-clean': 'Clean (Seedream scene layers, no reconstruction needed)',
  'continued-clean': 'Clean (simple background continued locally, no reconstruction needed)', 'ai-reconstructed': 'AI reconstructed',
  contaminated: 'Contaminated (foreground left in the background)', fallback: 'Fallback: continued from the surrounding background (not AI reconstructed)' };
/** The debug lines for a refined run: passes, final layers, residual cleanup, background and every provider call. */
export function refinementSummary(run: Pick<ExperimentRun, 'refinement' | 'calls' | 'interactions'>): { label: string; value: string }[] {
  const r = run.refinement, calls = run.calls;
  if (!r) return [];
  const residual = r.passes.filter(p => p.state === 'done').length;
  return [
    { label: 'Passes', value: r.passesExecuted !== undefined ? `${r.passesExecuted} (1 initial + ${residual} residual, at most ${r.options.maxDepth})` : r.state },
    { label: 'Final layers', value: r.finalLayers !== undefined ? String(r.finalLayers) : '—' },
    { label: 'Residual cleanup', value: !r.stopReason ? r.state : residual ? `Performed (stopped: ${r.stopReason})` : `Not needed (${r.stopReason})` },
    { label: 'Background', value: r.background ? BACKGROUND_STATUS_LABELS[r.background.status] : r.state === 'failed' ? `Refinement failed: ${r.error ?? ''}` : '—' },
    ...(r.background?.quality ? [{ label: 'Background quality', value: `${r.background.quality}${r.background.validation?.reasons.length ? ` (${r.background.validation.reasons.join(', ')})` : ''} · ${r.background.difficulty?.level ?? ''}${r.background.difficulty ? ` · mask ${r.background.difficulty.coveragePercent}%, largest region ${r.background.difficulty.largestComponentPercent}%` : ''}` }] : []),
    ...(run.interactions ? [{ label: 'Protected groups', value: `${run.interactions.groups} (${run.interactions.layersBefore} → ${run.interactions.layersAfter} layers)` }] : []),
    ...(r.layerPlan ? [{ label: 'Editable layers', value: `${r.layerPlan.editableLayers}${r.layerPlan.dropped.length ? ` (left out: ${r.layerPlan.dropped.map(d => `${d.name ?? d.file} — ${(d.reason ?? '').replace(/-/g, ' ')}`).join('; ')})` : ' (nothing left out)'}` }] : []),
    ...(r.background?.shadow?.percent ? [{ label: 'Cast shadows', value: `${r.background.shadow.percent}% of the image removed with the foreground` }] : []),
    ...(calls ? [{ label: 'Calls', value: `planner ${calls.planner} · initial Seedream ${calls.seedreamInitial} · residual Seedream ${calls.seedreamResidual} · background edit ${calls.backgroundReconstruction}${calls.fitCheck ? ` · fit check ${calls.fitCheck}` : ''}` }] : []),
  ];
}
const BASE_LABELS: Record<CleanBackgroundStatus, string> = { 'provider-clean': 'Clean background', 'scene-clean': 'Clean background', 'continued-clean': 'Clean background', 'ai-reconstructed': 'Clean background', contaminated: 'Background (contaminated)', fallback: 'Background (fallback fill)' };

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
  /** recursive: the recursive refinement (up to 2 residual Seedream calls and 1 OpenAI image edit, only as needed); only sent when true. */
  start: (file: File, mode: PromptMode = 'generated', templateKey?: string, separateHeldObject = true, targetLayers?: number, templateOptions?: Record<string, boolean>, skipFitCheck = false, recursive = false) => {
    const form = new FormData();
    form.append('promptMode', mode);
    form.append('separateHeldObject', String(separateHeldObject));
    if (targetLayers !== undefined) form.append('targetLayers', String(targetLayers));
    if (templateKey) form.append('templateKey', templateKey);
    if (templateOptions) form.append('templateOptions', JSON.stringify(templateOptions));
    if (skipFitCheck) form.append('skipFitCheck', 'true');
    if (recursive) form.append('recursive', 'true');
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
      const label = p.kind === 'base' ? (layer.cleanBackground ? BASE_LABELS[layer.cleanBackground.status] : 'Generated base') : layer.name || 'Layer';
      // Layers a residual pass found say so, for debugging the refinement.
      const pass = layer.provenance && layer.provenance.sourcePass > 0 ? ` · pass ${layer.provenance.sourcePass}` : '';
      layers.push({ id: `layer-${newId()}`, type: 'image', assetId, name: `${unresolved ? '⚠ unplaced: ' : ''}${label}${pass} (z${layer.zIndex})`.slice(0, 200),
        x: p.x * scale, y: p.y * scale, width: Math.max(1, p.width * k * scale), height: Math.max(1, p.height * k * scale), rotation: 0, opacity: 1, visible: !unresolved, locked: false });
    }
    return { id: `layerize-${newId()}`, name: `OpenAI + Seedream ${run.id.slice(0, 16)}`, revision: 0, canvas: { width, height, backgroundColor: '#FFFFFF', transparent: true }, elements: [], layers };
  } catch (error) {
    await Promise.all(stored.map(id => assets.deleteAsset(id).catch(() => undefined)));
    throw error instanceof Error ? error : new Error('The run could not be imported.');
  }
}
