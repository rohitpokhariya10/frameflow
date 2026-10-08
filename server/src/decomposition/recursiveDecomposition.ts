/**
 * Recursive (multi-pass) decomposition refinement for the OpenAI → Seedream layerize experiment. Runs after a run's own
 * decomposition is rendered (layerizeExperiment.ts collect) and before its layer count is applied, only for runs created
 * with the refinement option. It never changes how that first decomposition is planned or requested.
 *
 *   pass 0     the run's initial decomposition (its planner call and its one Seedream call), as rendered
 *   residual 1 Seedream's base with every extracted layer's area filled locally: what pass 0 left behind
 *   assess     assessBackgroundContamination: object-like regions left outside the extracted layers? no → stop
 *   pass 1     Seedream on residual 1 with a fixed residual prompt (no planner call); new layers minus duplicates
 *   residual 2 → assess → pass 2 (MAX_RESIDUAL_PASSES) → residual 3 is assessed for the record, never sent
 *   order      one stacking order for all layers, decided from the original where layers overlap, never by pass
 *   screen     layers worth an editor layer (layerUsefulness.ts): invented fillers, hidden guesses, faint remnants and
 *              detached shadow stains are left out; people, products and text always stay
 *   background the foreground union mask plus the cast shadows of what it removes (shadowResidue.ts), then ONE clean
 *              background: the provider base, its scene layers, a plain field continued locally, or one edit from the
 *              ORIGINAL image (cleanBackground.ts), each checked for ghosts, recreated products and leftover objects;
 *              full background plates are then the background, never a second layer on it
 *   outputs    layers.json, contact-sheet.png and reconstructed.png rewritten; decomposition-debug.json added
 *
 * Bounded and visible: at most MAX_RESIDUAL_PASSES residual Seedream calls and one background edit per run, each
 * counted in run.calls when sent and never retried. Resume and re-render reuse what was saved (residual responses, the
 * background edit) and never send anything. A failed residual pass keeps every earlier layer; a failed or unavailable
 * background edit falls back to a local fill reported as "fallback", never as clean.
 *
 * Known limits: a shadow is removed with its subject only when it is a soft, same-hue darkening touching it; broad
 * environmental lighting stays in the background by design. Text that Seedream returns as layers is kept as raster
 * layers (no OCR). Background-role layers (a backdrop panel) are left in the clean background under their own layer.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildProviderInput, endpointRegistry, normalizeProviderOutput, ProviderError, type ProviderLayerMetadata } from './providers/adapters.js';
import type { FalTransport } from './providers/falClient.js';
import { backgroundRole, composeLayers, placeLayers, writeContactSheet, type Canvas, type CleanBackgroundMethod, type CleanBackgroundStatus, type LayerInfo, type Placement } from './layerizeArtifacts.js';
import { head, layerWords, posterRole, similarity } from './layerCount.js';
import { assessBackgroundContamination, backgroundModel, compositeOnGrid, coverageOnGrid, fidelity, flattenRgba, gridFor, intersectCount, layerShape, meaningfulRegions, objectRetention, recreates, overlapStats, rgbOnGrid, unionOf,
  type ContaminationAssessment, type Fidelity, type Grid, type LayerShape, type Retention } from './backgroundContamination.js';
import { blendIntoCanvas, CLEAN_BACKGROUND_PROMPT, editInputs, featherMask, localFill, reconstructionSize, resizeMap, type BackgroundReconstructor } from './cleanBackground.js';
import { backgroundDifficulty, backgroundQuality, continuationTrust, graphicFill, plainFieldFill, type BackgroundDifficulty, type BackgroundQuality, type ContinuationTrust, type PlainRegion } from './backgroundRecovery.js';
import { grow } from './outerBackground.js';
import { castShadows, type ShadowDetection } from './shadowResidue.js';
import { isPlate, layerCategory, layerPlan, screenFillers, screenPlates, type LayerPlan, type UsefulnessDecision } from './layerUsefulness.js';
import { curateLayers, type CurationCandidate, type CurationRecord } from './layerCuration.js';
import { groupInteractions, type InteractionOptions } from './interactionGrouping.js';
import { isTemplateRole, type TemplateRole } from '@frameflow/shared';
import { EFFECT, idWords, PERSON, SCENE, TEXTISH } from './interactionTerms.js';
import type { SemanticAnalysis, SemanticElement } from './semanticPlanner.js';
import type { RunRecord } from './layerizeExperiment.js';
import { semanticAnalysisOf, semanticProtectionOf } from './runPlan.js';
import { backdropComponents, COMPONENT_ROLES, keepShapesFree, planRoles, SMOOTH_STEP, type BackdropDecision } from './backdropComponents.js';
import { agreeing, baseTone, completeHidden, convexHull, MIN_REGION, matte, over, ownerOf, parts, retainedContent, smoothReach, touchingBackdrop, uncoveredContent, type OwnerCandidate } from './coverageRecovery.js';

/** Types of planned elements that are the scene itself (held by the base or scene layers, never an extracted object). */
const SCENE_TYPE = /\b(?:background|backdrop|environment|scene|wall|floor|sky|canvas|plate|gradient|vignette|texture|backplate)\b/i;
/** With every planned element extracted, the contrast (deviation / threshold) a leftover needs to count as a missed object. */
export const PLANNED_MIN_CONTRAST = 3;
export type PlanCoverage = { planned: string[]; matched: Record<string, string>; complete: boolean };
/**
 * Whether every foreground element the planner listed (independent, after protection merges, not the scene) has an
 * extracted layer, matched by the words they share (each layer at most once). When it has, what still stands out in the
 * background is presumed to be the background's own design (a platform, soft circles, a brand shape): a residual pass
 * or a "contaminated" verdict then needs a region that stands out as strongly as a product. Undefined without a plan.
 */
export function planCoverage(semantic: SemanticAnalysis | undefined, merged: string[], layers: { file: string; name?: string; description?: string }[]): PlanCoverage | undefined {
  const planned = (semantic?.elements ?? []).filter(e => e.editable_independently && !merged.includes(e.id) && !SCENE_TYPE.test(idWords(e.type)) && !(isTemplateRole(e.type) && SCENE_ROLES.has(e.type)));
  if (!planned.length) return undefined;
  const score = (e: SemanticElement, l: { name?: string; description?: string }) => isTemplateRole(e.type) ? roleMatch(e.type, l) : similarity(layerWords(l.name, l.description), layerWords(idWords(e.id), e.description));
  const pairs = planned.flatMap(e => layers.map(l => ({ e, l, score: score(e, l) }))).sort((a, b) => b.score - a.score);
  const matched: Record<string, string> = {}, used = new Set<string>();
  for (const pair of pairs) { if (pair.score < 0.15 || matched[pair.e.id] || used.has(pair.l.file)) continue; matched[pair.e.id] = pair.l.file; used.add(pair.l.file); }
  return { planned: planned.map(e => e.id), matched, complete: planned.every(e => matched[e.id]) };
}

/**
 * Planned layers the editor does not get, for a plan with roles (a template's): each element the plan asked for as its
 * own layer (independent, not kept with a parent or merged by protection, not the base canvas) has an editor layer
 * carrying it, alone or in a protected group. If not, a warning says whether the provider returned it and it was left
 * out (and why), or never returned it as a layer of its own (backdrop components only: a missing foreground element
 * already starts residual passes). A run that lost a requested layer never reads as complete.
 */
export function plannedLayerIssues(semantic: SemanticAnalysis | undefined, roleOf: (id: string) => TemplateRole | undefined, merged: string[],
  raw: Pick<LayerInfo, 'file' | 'name' | 'semantic'>[], editor: Pick<LayerInfo, 'file' | 'semantic' | 'grouping' | 'rawFile'>[], dropped: UsefulnessDecision[], roleMatched: Record<string, string> = {}): string[] {
  const elementOf = new Map(raw.filter(l => l.semantic).map(l => [l.file, l.semantic!.id]));
  // A reused plan's roles are matched by what a layer is (planCoverage), not by words: those matches count too.
  for (const [id, file] of Object.entries(roleMatched)) if (!elementOf.has(file)) elementOf.set(file, id);
  for (const l of editor) if (l.semantic) elementOf.set(l.file, l.semantic.id);
  const shownFiles = new Set(editor.flatMap(l => [l.file, ...(l.rawFile ? [l.rawFile] : []), ...(l.grouping?.members.map(m => m.file) ?? [])]));
  const shown = new Set([...shownFiles].map(file => elementOf.get(file)).filter((id): id is string => !!id));
  for (const [id, file] of Object.entries(roleMatched)) if (shownFiles.has(file)) shown.add(id);
  const issues: string[] = [];
  for (const e of semantic?.elements ?? []) {
    const role = roleOf(e.id);
    if (!role || role === 'background' || !e.editable_independently || e.attachment?.keep_with_parent || merged.includes(e.id) || shown.has(e.id)) continue;
    const returned = raw.find(l => l.semantic?.id === e.id || roleMatched[e.id] === l.file), why = returned && dropped.find(d => d.file === returned.file);
    if (returned) issues.push(`PLANNED_LAYER_MERGED: the plan's ${role.replace(/_/g, ' ')} was returned ("${returned.name ?? returned.file}") but is not a layer of its own${why ? `: ${why.detail}` : ''}.`);
    else if (COMPONENT_ROLES.has(role)) issues.push(`PLANNED_LAYER_MISSING: the plan's ${role.replace(/_/g, ' ')} has no layer of its own: the provider merged it into another layer or did not return it.`);
  }
  return issues;
}

const SCENE_ROLES = new Set<TemplateRole>(['background', 'backdrop']);
const CTA_WORDS = /\b(?:button|cta|call to action|shop|buy|order|book|download|sign up|learn more)\b/i, BADGE_WORDS = /\b(?:badge|sticker|seal|tag|stamp|ribbon)\b/i;
const LOGO_WORDS = /\b(?:logo|logotype|wordmark|brand mark|emblem)\b/i, DECOR_WORDS = /\b(?:decor\w*|ornament\w*|graphics?|shapes?|stars?|clouds?|confetti|sparkles?|patterns?|accents?|dots?|bubbles?|circles?|swirls?|waves?|lines?|stripes?)\b/i;
/**
 * How well a layer Seedream returned fits a creative template's planned role. A template plan names roles, not content
 * ("primary subject"), while Seedream names what it sees ("Man in a blue shirt"), so roles match by what the layer is:
 * a person for a subject, text for text, and any remaining object layer for an object role. Without this every reused
 * plan would look uncovered and invite residual passes its decomposition does not need.
 */
function roleMatch(role: TemplateRole, layer: { name?: string; description?: string }): number {
  // What a layer is comes from its name. Seedream's descriptions add instructions ("preserve original shape, color, no
  // invented content") whose words read as decoration or text; they stand in only for a missing or generic name.
  const generic = !layer.name?.trim() || /^(?:layer|image|element|object)\s*\d*$/i.test(layer.name.trim());
  const words = idWords(generic ? layer.description ?? layer.name ?? '' : layer.name!);
  // A ball "held in a hand" is an object, not a person. Classify the named subject before relationship clauses.
  const subject = head(idWords(layer.name || layer.description || '')).split(/\b(?:held|worn|carried)\b/i)[0];
  const person = PERSON.test(subject), text = TEXTISH.test(words);
  const scene = SCENE.test(idWords(layer.name ?? '')), decor = DECOR_WORDS.test(words), effect = EFFECT.test(idWords(layer.name ?? ''));
  switch (role) {
    case 'primary_subject': case 'secondary_subject': return person ? 0.6 : 0;
    case 'headline': case 'body_text': case 'price': return text && !CTA_WORDS.test(words) ? 0.5 : 0;
    case 'cta': return CTA_WORDS.test(words) ? 0.6 : 0;
    case 'badge': return BADGE_WORDS.test(words) ? 0.6 : 0;
    case 'logo': return LOGO_WORDS.test(words) ? 0.6 : 0;
    case 'decoration': return decor ? 0.5 : 0;
    case 'effect': return effect ? 0.5 : 0;
    case 'held_object': case 'main_product': case 'supporting_product': case 'prop': return person || text || scene || decor || effect ? 0 : 0.3;
    default: return 0;
  }
}

/** Residual passes after the initial decomposition: a hard cap whatever a run asks for. */
export const MAX_RESIDUAL_PASSES = 2;
export type RefinementOptions = {
  /** Residual passes after the initial decomposition (0–MAX_RESIDUAL_PASSES). */
  maxDepth: number;
  /** New layers one residual pass may add; smaller extra fragments are grouped into one layer. */
  maxNewLayersPerPass: number;
  /** All layers of the result, the background included (the editor allows 60). */
  maxTotalLayers: number;
  /** A residual layer covering less of the canvas than this (%) is a fragment, not a layer. */
  minLayerAreaPercent: number;
  /** Foreground-mask growth around removed layers (fraction of the canvas's shorter side), and its feather (fraction of that growth). */
  maskDilation: number; maskFeather: number;
  /** Contamination: smallest region (% of canvas), total confident area (%) that counts, confidence a region needs. */
  minRegionPercent: number; contaminatedPercent: number; minConfidence: number;
  /** A background still shows a removed layer when this share (%) of the layer's distinctive pixels is unchanged. */
  retainedPercent: number;
  /** Duplicates: mask IoU with an existing layer, or the share of the new layer inside one. */
  duplicateIoU: number; duplicateContainment: number;
  /** One AI reconstruction of the clean background when the base is not clean; false: local fill only. */
  reconstructBackground: boolean;
  /**
   * A plain background field (flat color, gradient, glow) around every removed area is continued locally, validated,
   * before any image edit is considered: no call, and no silhouette or shadow a model could paint. false: the edit first
   * (the continuation stays its fallback). Runs saved before this option read it as true.
   */
  deterministicBackground: boolean;
};
export const REFINEMENT_DEFAULTS: RefinementOptions = { maxDepth: MAX_RESIDUAL_PASSES, maxNewLayersPerPass: 8, maxTotalLayers: 32, minLayerAreaPercent: 0.1, maskDilation: 0.008, maskFeather: 0.5,
  minRegionPercent: 0.25, contaminatedPercent: 0.6, minConfidence: 0.5, retainedPercent: 25, duplicateIoU: 0.5, duplicateContainment: 0.7, reconstructBackground: true, deterministicBackground: true };

/** Every paid or metered provider request of a run, counted when sent (a failed request still counts). */
export type CallCounts = { planner: number; seedreamInitial: number; seedreamResidual: number; backgroundReconstruction: number };
export const noCalls = (): CallCounts => ({ planner: 0, seedreamInitial: 0, seedreamResidual: 0, backgroundReconstruction: 0 });
export const callLines = (calls: CallCounts) => [`Planner (OpenAI): ${calls.planner}`, `Initial layerize (Seedream): ${calls.seedreamInitial}`,
  `Residual layerize (Seedream): ${calls.seedreamResidual}`, `Background reconstruction (OpenAI image edit): ${calls.backgroundReconstruction}`];

export type StopReason = 'clean' | 'below-threshold' | 'low-confidence' | 'not-assessable' | 'residue-only' | 'max-depth' | 'no-new-layers' | 'all-duplicates' | 'pass-failed' | 'max-total-layers' | 'resume-no-new-calls';
export type RejectedLayer = { file: string; name?: string; reason: 'unplaced' | 'fragment' | 'background-like' | 'inside-extracted-region' | 'duplicate' | 'over-total-limit'; duplicateOf?: string; iou?: number };
export type PassRecord = {
  /** 1 or 2: the residual pass (the initial decomposition is pass 0, the run's own Seedream call). */
  pass: number; state: 'submitting' | 'submitted' | 'done' | 'failed';
  input: { file: string; sha256: string; width: number; height: number }; prompt: string;
  requestId?: string; submittedAt?: string; completedAt?: string; durationMs?: number;
  returnedLayers?: number; accepted: string[]; grouped?: string[]; rejected: RejectedLayer[];
  error?: { code: string; message: string };
};
export type AssessmentRecord = ContaminationAssessment & { after: number; residual: string; sent: boolean };
export type BackgroundRecord = {
  status: CleanBackgroundStatus; method: CleanBackgroundMethod; file: string; source: 'original' | 'provider-base';
  /** Whether the provider base had to be replaced (it still showed extracted layers, or was not usable behind them). */
  needed: boolean; contaminated: boolean; reasons: string[];
  baseRetention: Retention[]; recreated: Retention[]; residual: Omit<ContaminationAssessment, 'regions'> & { regions: number };
  /** The chosen background's quality behind the foreground (backgroundRecovery.ts), and how hard that area is. */
  quality: BackgroundQuality['quality']; validation: BackgroundQuality; difficulty: BackgroundDifficulty;
  foregroundMaskCoverage: number; largestConnectedMaskCoverage: number;
  /** Every background considered, in order (provider base, scene composite, AI edit, fallback), and which one was used. */
  candidates: { method: CleanBackgroundMethod; quality: BackgroundQuality['quality']; reasons: string[]; metrics: BackgroundQuality['metrics']; chosen: boolean }[];
  /** Why an AI edit was needed; whether the deterministic fallback was used; whether an AI result was judged. */
  reconstructionReason?: string; fallbackUsed: boolean; aiTried: boolean; outsideMaskChangedPercent?: number;
  /** Cast shadows of the removed foreground, removed with it (shadowResidue.ts). */
  shadow?: Pick<ShadowDetection, 'percent' | 'assessed' | 'model' | 'components' | 'note'>;
  /** Whether the area around every removed region is a plain field (plainFieldFill), region by region. */
  plainField?: { plain: boolean; regions: PlainRegion[] };
  /** Whether a local continuation can be trusted behind the foreground (continuationTrust), and why. */
  trust?: ContinuationTrust;
  /** Every recovery step in order: chosen, rejected or skipped, why, and whether it made a paid call. */
  steps?: BackgroundStep[];
};
export type BackgroundStep = { step: 'provider-base' | 'scene-composite' | 'local-continuation' | 'ai-reconstruction' | 'fallback'; outcome: 'chosen' | 'rejected' | 'skipped'; reason: string; call?: boolean };
const LOCAL_METHODS = new Set<CleanBackgroundMethod>(['plain-field', 'graphic-fill', 'local-fill']);
export type RefinementRecord = {
  version: 1; options: RefinementOptions; state: 'pending' | 'running' | 'done' | 'failed';
  /** Residual passes that were sent (kept across resumes: their request IDs and responses are reused, never resent). */
  passes: PassRecord[];
  assessments: AssessmentRecord[];
  stopReason?: StopReason; stopDetail?: string;
  /** 1 (the initial decomposition) + residual passes that returned a result. */
  passesExecuted?: number; finalLayers?: number;
  mask?: { layers: string[]; coveragePercent: number; dilatePx: number; featherPx: number; file: string;
    /** Of the coverage: cast shadows added around the removed foreground (% of the image); their own mask file. */
    shadowPercent?: number; shadowFile?: string };
  background?: BackgroundRecord;
  /** The editor's layers: how many are meaningful, by category, and every provider layer left out and why (layerUsefulness.ts). */
  layerPlan?: LayerPlan;
  curation?: CurationRecord;
  /** Whether every foreground element the planner listed has an extracted layer (planCoverage): if so, leftovers must stand out like objects to count. */
  planCoverage?: PlanCoverage;
  /** Large scene layers judged as backdrop components (panels, cards, shapes on the base canvas) or as part of the base (backdropComponents.ts). */
  backdrops?: BackdropDecision[];
  /**
   * Original content no layer covered and the clean base lacked (coverageRecovery.ts): each region, the layer it joined
   * (null: none), and smooth backdrops whose visible pixels were corrected or hidden part completed.
   */
  coverage?: { typical: number; cut: number; regions: { areaPercent: number; meanDiff: number; smooth: boolean; owner: string | null; ofBase?: boolean }[];
    /** Per smooth backdrop: object content its layer carried (handed to the objects), visible pixels corrected, hidden pixels completed; unverified when its own pixels show the creative almost nowhere. */
    backdrops: { layer: string; verified: boolean; carriedPercent: number; correctedPercent: number; completedPercent: number }[] };
  /** The one background edit: its cache key (source + mask + size + prompt + model), so a re-render reuses it. */
  reconstruction?: { key: string; model: string; size: { width: number; height: number }; state: 'sent' | 'done' | 'failed'; sentAt: string; requestId?: string; durationMs?: number; error?: { code: string; message: string } };
  fidelity?: { before: Fidelity; after: Fidelity };
  warnings: string[]; error?: string;
};

/** The options a run is created with, or undefined when it is not refined. Partial options are clamped to the hard limits. */
export function refinementOptions(value: boolean | Partial<RefinementOptions> | undefined): RefinementOptions | undefined {
  if (!value) return undefined;
  const options = { ...REFINEMENT_DEFAULTS, ...(value === true ? {} : value) };
  for (const [key, number] of Object.entries(options)) if (typeof number === 'number' && !Number.isFinite(number)) throw new Error(`Refinement option ${key} must be a finite number.`);
  const int = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));
  return { ...options, maxDepth: int(options.maxDepth, 0, MAX_RESIDUAL_PASSES), maxNewLayersPerPass: int(options.maxNewLayersPerPass, 1, 16), maxTotalLayers: int(options.maxTotalLayers, 2, 60),
    maskDilation: Math.min(0.05, Math.max(0, options.maskDilation)), maskFeather: Math.min(1, Math.max(0, options.maskFeather)) };
}
export const newRefinementRecord = (options: RefinementOptions): RefinementRecord => ({ version: 1, options, state: 'pending', passes: [], assessments: [], warnings: [] });

export const RESIDUAL_PROMPT = 'This is the background of an offer creative after some objects were already taken out. Separate every distinct object still visible in it (products, devices, pedestals or platforms, gift boxes, major decorations, logos and text blocks) into its own layer, each complete and unchanged. Keep the plain scene (wall, floor or table surface, gradients, lighting and background patterns) as the base. Group tiny scattered decorations such as confetti into one layer. Do not invent objects.';
/** The residual prompt, with where the remaining objects were found (positions in words, never coordinates). */
export function residualPrompt(assessment: ContaminationAssessment, minConfidence: number, missingRoles: string[] = []): string {
  const where = [...new Set(assessment.regions.filter(r => r.confidence >= minConfidence).map(r => r.position))].slice(0, 6);
  return `${RESIDUAL_PROMPT}${where.length ? ` Remaining objects are around: ${where.join(', ')}.` : ''}${missingRoles.length ? ` Look for these missing planned roles if visible: ${missingRoles.slice(0, 8).map(idWords).join(', ')}. Do not duplicate already extracted layers.` : ''}`;
}

export type RefineDeps = { backgroundReconstructor?: BackgroundReconstructor; sleep?: (ms: number) => Promise<void>; pollIntervalMs?: number; pollTimeoutMs?: number };
export type RefineContext = {
  dir: string; run: RunRecord; canvas: Canvas;
  /** The rendered initial decomposition (renderLayerizeOutputs): the base and every layer. */
  layers: LayerInfo[]; renderWarnings: string[];
  /** The uploaded (orientation-normalized) image: the source of the clean background. */
  sourceImage?: Buffer;
  transport: FalTransport; deps: RefineDeps;
  /** True only for a run's first execution; resume and re-render reuse saved results and never send anything. */
  allowNewCalls: boolean;
  /** Persists run.json (request IDs and call counts are saved the moment they exist). */
  save: () => void;
  /** Protected people and interactions (interactionGrouping.ts): the planner's analysis and the run's options. */
  interactions?: { semantic?: SemanticAnalysis; options: InteractionOptions };
};

type Item = { layer: LayerInfo; png: Buffer; shape: LayerShape; pass: number; providerZ: number; kind: 'background' | 'foreground'; role: string; sourceImage: string; requestId?: string };
const ENDPOINT = endpointRegistry.seedream.endpoint;
const AI_FILE = 'clean-background-ai.png', CLEAN_FILE = 'clean-background.png', MASK_FILE = 'foreground-mask.png', SHADOW_FILE = 'shadow-mask.png', DEBUG_FILE = 'decomposition-debug.json';
const sha256 = (bytes: Buffer | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
class PassError extends Error { constructor(public readonly code: string, message: string) { super(message); } }

/** Background for a framing or scene layer large enough to be the scene; foreground otherwise (with its role, read from its name). */
export function classify(layer: LayerInfo, shape: LayerShape, grid: Grid): { kind: Item['kind']; role: string } {
  const n = grid.width * grid.height, box = shape.box;
  const boxShare = box ? (box.x1 - box.x0) * (box.y1 - box.y0) / n : 0;
  const fullSolid = !!box && box.x1 - box.x0 >= 0.9 * grid.width && box.y1 - box.y0 >= 0.9 * grid.height && shape.count / n >= 0.6;
  const framing = backgroundRole(layer.name), named = posterRole(layer), words = idWords(layer.name ?? '');
  const sceneNamed = !!framing || named === 'background' || named === 'backdrop' || named === 'border';
  // Large atmosphere and design shapes ("…glow background", "yellow curved decorative field") belong to the scene even
  // when the role reader sees an effect or a decoration; a person, product or text never does.
  const largeScene = SCENE.test(words) && (shape.count / n >= 0.15 || boxShare >= 0.5) && !PERSON.test(words) && !TEXTISH.test(words) && named !== 'product' && named !== 'text';
  // A frame-filling layer is the scene, unless it is named as a product or text (a close-up hero is still removable).
  if ((fullSolid && named !== 'product' && named !== 'text' && !PERSON.test(words)) || (sceneNamed && boxShare >= 0.5) || largeScene) return { kind: 'background', role: framing ? `${framing} background` : named === 'unknown' ? 'background' : named };
  return { kind: 'foreground', role: sceneNamed ? 'decor' : named };
}
/** A layer covering (almost) the whole canvas explains nothing about where objects are. */
const explains = (item: Item, grid: Grid) => item.shape.count > 0 && !(item.kind === 'background' && item.shape.box && item.shape.box.x1 - item.shape.box.x0 >= 0.9 * grid.width && item.shape.box.y1 - item.shape.box.y0 >= 0.9 * grid.height);
/**
 * Pixels of an image that Seedream's own scene layers explain: a scene layer is opaque there with the same color. A crisp
 * brand shape (a yellow wedge on white) is not a leftover object; something left on top of it differs from the scene
 * layer under it, so it is still found.
 */
function sceneMatch(items: Item[], rgb: Buffer): Uint8Array {
  const out = new Uint8Array(rgb.length / 3);
  for (const item of items) {
    if (item.kind !== 'background') continue;
    const { alpha, rgba } = item.shape;
    for (let i = 0; i < out.length; i++) if (alpha[i] && Math.max(Math.abs(rgba[i * 4] - rgb[i * 3]), Math.abs(rgba[i * 4 + 1] - rgb[i * 3 + 1]), Math.abs(rgba[i * 4 + 2] - rgb[i * 3 + 2])) <= 30) out[i] = 1;
  }
  return out;
}
/** Stacking priority where nothing overlaps: background, decoration, supports, secondary objects, products, text on top. */
const RANK: Record<string, number> = { decor: 1, support: 2, secondary: 3, unknown: 3, product: 4, text: 5 };
const rankOf = (item: Item) => item.kind === 'background' ? 0 : RANK[item.role] ?? 3;

/** A placement on another pass's canvas, scaled onto this run's canvas. */
function toCanvas(p: Placement, scale: number, canvas: Canvas): Placement {
  if (p.kind === 'unresolved' || scale === 1) return p;
  if (p.kind === 'full-canvas' || p.kind === 'base') return { kind: 'bbox-scaled', x: 0, y: 0, width: canvas.width, height: canvas.height };
  return { kind: 'bbox-scaled', x: Math.round(p.x * scale), y: Math.round(p.y * scale), width: Math.max(1, Math.round(p.width * scale)), height: Math.max(1, Math.round(p.height * scale)) };
}

/** Polls a submitted residual request (never resubmits): three lookup failures in a row or the timeout end it. */
async function awaitResult(transport: FalTransport, requestId: string, deps: RefineDeps): Promise<unknown> {
  const sleep = deps.sleep ?? (ms => new Promise(done => setTimeout(done, ms))), started = Date.now();
  let failures = 0;
  for (;;) {
    let status: string;
    try { status = await transport.status(ENDPOINT, requestId); failures = 0; }
    catch (error) {
      if (++failures >= 3) throw new PassError('FAL_STATUS_FAILED', `${error instanceof Error ? error.message : String(error)}. Request ${requestId} is saved; a resume reads it without resubmitting.`);
      await sleep(deps.pollIntervalMs ?? 3000); continue;
    }
    if (status === 'COMPLETED') break;
    if (Date.now() - started > (deps.pollTimeoutMs ?? 10 * 60_000)) throw new PassError('POLL_TIMEOUT', `Still ${status}. Request ${requestId} is saved; a resume reads it without resubmitting.`);
    await sleep(deps.pollIntervalMs ?? 3000);
  }
  try { return await transport.result(ENDPOINT, requestId); }
  catch (error) {
    const detail = error instanceof ProviderError && error.providerDetail ? ` fal HTTP ${error.providerDetail.status}: ${error.providerDetail.messages.map(m => m.msg).join(' | ')}` : '';
    throw new PassError(error instanceof ProviderError && error.status === 422 ? 'PROVIDER_DECOMPOSITION_REJECTED' : 'FAL_RESULT_FAILED', `${error instanceof Error ? error.message : String(error)}.${detail}`);
  }
}

/**
 * One residual pass: reuses a saved response, or polls a saved request ID, or (first execution only) uploads the residual
 * and submits it once. The request ID is saved the moment it exists; the call is counted before it is sent.
 */
async function runPass(ctx: RefineContext, record: RefinementRecord, depth: number, residual: Buffer, residualFile: string, prompt: string): Promise<{ raw: unknown; pass: PassRecord }> {
  const { dir, run } = ctx, responseFile = `pass-${depth}-seedream-response.json`, requestFile = `pass-${depth}-seedream-request.json`;
  const inputSha = sha256(residual), meta = await sharp(residual).metadata();
  let pass = record.passes.find(p => p.pass === depth);
  if (pass && existsSync(join(dir, responseFile))) {
    if (pass.input.sha256 !== inputSha) record.warnings.push(`RESIDUAL_INPUT_CHANGED: residual ${depth} is no longer byte-identical to what was sent; the saved result of request ${pass.requestId} is reused as it is (no new call).`);
    return { raw: JSON.parse(readFileSync(join(dir, responseFile), 'utf8')), pass };
  }
  if (!pass?.requestId) {
    pass = { pass: depth, state: 'submitting', input: { file: residualFile, sha256: inputSha, width: meta.width!, height: meta.height! }, prompt, accepted: [], rejected: [] };
    record.passes = [...record.passes.filter(p => p.pass !== depth), pass];
    let input: Record<string, unknown>;
    try { input = buildProviderInput('seedream', { imageUrl: 'https://fal.media/placeholder-until-upload', prompt, imageSize: 'auto', enhancePromptMode: 'standard', width: meta.width, height: meta.height }); }
    catch (error) { throw Object.assign(new PassError('INVALID_SEEDREAM_INPUT', error instanceof Error ? error.message : String(error)), { pass }); }
    let imageUrl: string;
    try { imageUrl = await ctx.transport.upload(residual, 'image/png'); }
    catch (error) { throw Object.assign(new PassError('FAL_UPLOAD_FAILED', `${error instanceof Error ? error.message : String(error)} (nothing was submitted)`), { pass }); }
    const shown = { ...input, image_url: `<fal upload of ${residualFile}, ${meta.width}x${meta.height}>` };
    writeFileSync(join(dir, requestFile), JSON.stringify({ endpoint: ENDPOINT, input: shown }, null, 2));
    run.calls!.seedreamResidual++;
    ctx.save();
    try {
      const { requestId } = await ctx.transport.submit(ENDPOINT, { ...input, image_url: imageUrl });
      Object.assign(pass, { requestId, submittedAt: new Date().toISOString(), state: 'submitted' });
      writeFileSync(join(dir, requestFile), JSON.stringify({ endpoint: ENDPOINT, requestId, input: shown }, null, 2));
      ctx.save();
    } catch (error) { throw Object.assign(new PassError('FAL_SUBMIT_FAILED', `${error instanceof Error ? error.message : String(error)}. No request ID was returned; not resubmitted.`), { pass }); }
  }
  const started = Date.now();
  try {
    const raw = await awaitResult(ctx.transport, pass.requestId!, ctx.deps);
    writeFileSync(join(dir, responseFile), JSON.stringify(raw, null, 2));
    Object.assign(pass, { completedAt: new Date().toISOString(), durationMs: Date.now() - started });
    return { raw, pass };
  } catch (error) { throw Object.assign(error instanceof PassError ? error : new PassError('FAL_RESULT_FAILED', String(error)), { pass }); }
}

/** A residual pass's layers on this run's canvas: files pass-N-layer-NN.png (downloaded once), its base resized to the canvas. */
async function renderPass(ctx: RefineContext, depth: number, raw: unknown, A: Grid, requestId?: string): Promise<{ base?: Buffer; candidates: Item[]; rawItems: Item[]; returned: number }> {
  const output = normalizeProviderOutput('seedream', raw);
  const decoded: { png: Buffer; file: string; width: number; height: number; opaque: number; meta: ProviderLayerMetadata }[] = [];
  for (const [i, image] of output.images.entries()) {
    const file = `pass-${depth}-layer-${String(i).padStart(2, '0')}.png`, local = join(ctx.dir, file);
    const png = existsSync(local) ? readFileSync(local) : await ctx.transport.download(image.url);
    if (!existsSync(local)) writeFileSync(local, png);
    const { data, info } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
    let opaque = 0; for (const a of data) if (a > 127) opaque++;
    decoded.push({ png, file, width: info.width, height: info.height, opaque: opaque / (info.width * info.height), meta: output.layers?.[i] ?? { zIndex: i } });
  }
  const { canvas: own, placements } = placeLayers(decoded);
  if (Math.abs((own.width / own.height) / (ctx.canvas.width / ctx.canvas.height) - 1) > 0.01) throw new PassError('PASS_ASPECT_MISMATCH', `Residual pass ${depth} returned a ${own.width}×${own.height} canvas, not the run's ${ctx.canvas.width}×${ctx.canvas.height} aspect.`);
  const scale = ctx.canvas.width / own.width, baseAt = placements.findIndex(p => p.kind === 'base');
  const base = baseAt >= 0 ? await sharp(decoded[baseAt].png).resize(ctx.canvas.width, ctx.canvas.height, { fit: 'fill' }).png().toBuffer() : undefined;
  const rawItems: Item[] = [];
  for (const [i, d] of decoded.entries()) {
    const layer: LayerInfo = { index: i, file: d.file, zIndex: d.meta.zIndex, ...(d.meta.name ? { name: d.meta.name } : {}), ...(d.meta.description ? { description: d.meta.description } : {}),
      ...(scale === 1 && d.meta.bboxAbsolute ? { bboxAbsolute: d.meta.bboxAbsolute } : {}), ...(d.meta.bboxNormalized ? { bboxNormalized: d.meta.bboxNormalized } : {}),
      pixelWidth: d.width, pixelHeight: d.height, opaquePercent: Math.round(d.opaque * 1000) / 10, placement: toCanvas(placements[i], scale, ctx.canvas) };
    const shape = await layerShape(d.png, layer, A), { kind, role } = classify(layer, shape, A);
    rawItems.push({ layer, png: d.png, shape, pass: depth, providerZ: d.meta.zIndex, kind, role, sourceImage: `residual-pass-${depth}.png`, ...(requestId ? { requestId } : {}) });
  }
  writeFileSync(join(ctx.dir, `pass-${depth}-raw-layers.json`), JSON.stringify({ canvas: ctx.canvas, layers: rawItems.map(item => item.layer) }, null, 2));
  return { base, candidates: rawItems.filter(item => item.layer.placement.kind !== 'base'), rawItems, returned: decoded.length };
}

/**
 * Which of a residual pass's layers are new. Rejected: unplaced; fragments; background-like layers (a residual pass looks
 * for objects); layers mostly inside an area already extracted and filled (a duplicate, or an artifact of the fill);
 * duplicates of an earlier or larger same-pass layer (mask IoU, containment, or box overlap with a similar name). The
 * earlier layer is always the one kept. Extra small layers beyond maxNewLayersPerPass become one grouped layer.
 */
async function screen(ctx: RefineContext, candidates: Item[], existing: Item[], filled: Uint8Array, options: RefinementOptions, A: Grid, depth: number): Promise<{ accepted: Item[]; rejected: (RejectedLayer & { item: Item })[]; grouped: string[] }> {
  const n = A.width * A.height, accepted: Item[] = [], rejected: (RejectedLayer & { item: Item })[] = [];
  const reject = (item: Item, reason: RejectedLayer['reason'], extra: Partial<RejectedLayer> = {}) => rejected.push({ item, file: item.layer.file, ...(item.layer.name ? { name: item.layer.name } : {}), reason, ...extra });
  for (const item of [...candidates].sort((a, b) => b.shape.count - a.shape.count)) {
    if (item.layer.placement.kind === 'unresolved') { reject(item, 'unplaced'); continue; }
    if (100 * item.shape.count / n < options.minLayerAreaPercent) { reject(item, 'fragment'); continue; }
    if (item.kind === 'background') { reject(item, 'background-like'); continue; }
    if (intersectCount(item.shape.alpha, filled) / item.shape.count >= options.duplicateContainment) {
      const owner = existing.map(e => ({ e, inter: intersectCount(item.shape.alpha, e.shape.alpha) })).sort((a, b) => b.inter - a.inter)[0];
      reject(item, 'inside-extracted-region', owner?.inter ? { duplicateOf: owner.e.layer.file } : {}); continue;
    }
    const words = layerWords(item.layer.name, item.layer.description);
    const twin = [...existing, ...accepted].map(e => ({ e, s: overlapStats(item.shape, e.shape) })).find(({ e, s }) => s.iou >= options.duplicateIoU || s.aInB >= options.duplicateContainment
      || (s.boxIoU >= 0.5 && similarity(words, layerWords(e.layer.name, e.layer.description)) >= 0.34));
    if (twin) { reject(item, 'duplicate', { duplicateOf: twin.e.layer.file, iou: round(twin.s.iou) }); continue; }
    accepted.push(item);
  }
  // Beyond the per-pass cap, the smallest extras are grouped into one layer (fragments, confetti) instead of 20 tiny ones.
  let grouped: string[] = [];
  if (accepted.length > options.maxNewLayersPerPass) {
    const extras = accepted.splice(options.maxNewLayersPerPass - 1);
    grouped = extras.map(e => e.layer.file);
    const file = `pass-${depth}-grouped.png`;
    const rgba = await compositeOnGrid(extras.map(e => ({ png: e.png, placement: e.layer.placement })), { ...ctx.canvas, scale: 1 });
    const png = await sharp(rgba, { raw: { width: ctx.canvas.width, height: ctx.canvas.height, channels: 4 } }).png().toBuffer();
    writeFileSync(join(ctx.dir, file), png);
    const layer: LayerInfo = { index: extras[0].layer.index, file, zIndex: Math.min(...extras.map(e => e.layer.zIndex)), name: `Residual details (pass ${depth})`, pixelWidth: ctx.canvas.width, pixelHeight: ctx.canvas.height,
      opaquePercent: round(100 * extras.reduce((sum, e) => sum + e.shape.count, 0) / n, 1), placement: { kind: 'full-canvas', x: 0, y: 0, width: ctx.canvas.width, height: ctx.canvas.height } };
    accepted.push({ ...extras[0], layer, png, shape: await layerShape(png, layer, A), role: 'decor', providerZ: layer.zIndex });
  }
  // The result never exceeds maxTotalLayers (the background counts as one).
  const room = Math.max(0, options.maxTotalLayers - 1 - existing.length);
  for (const item of accepted.splice(room)) reject(item, 'over-total-limit');
  return { accepted, rejected, grouped };
}

/** The layer in front where two overlap: the one whose pixels match the original there; undefined when it is unclear. */
function frontOf(a: Item, b: Item, original: Buffer): Item | undefined {
  let ea = 0, eb = 0, count = 0;
  const diff = (rgba: Buffer, i: number) => Math.max(Math.abs(rgba[i * 4] - original[i * 3]), Math.abs(rgba[i * 4 + 1] - original[i * 3 + 1]), Math.abs(rgba[i * 4 + 2] - original[i * 3 + 2]));
  for (let i = 0; i < a.shape.alpha.length; i++) if (a.shape.alpha[i] && b.shape.alpha[i]) { count++; ea += diff(a.shape.rgba, i); eb += diff(b.shape.rgba, i); }
  if (!count || Math.abs(ea - eb) / count < 6) return undefined;
  return ea < eb ? a : b;
}
/**
 * One back-to-front order for every layer. Within a pass, the provider's order holds. Across passes, where two layers
 * overlap, the one matching the original there is in front (unclear: the earlier pass's layer, since what a residual
 * pass finds was behind it). Elsewhere: background, decoration, supports, secondary objects, products, then text.
 */
export function stackOrder(items: Item[], original: Buffer): { order: Item[]; notes: string[] } {
  const n = items.length, below = items.map(() => new Set<number>()), notes: string[] = [];
  const byPass = new Map<number, number[]>();
  items.forEach((item, i) => byPass.set(item.pass, [...(byPass.get(item.pass) ?? []), i]));
  for (const list of byPass.values()) {
    list.sort((a, b) => items[a].providerZ - items[b].providerZ);
    for (let k = 1; k < list.length; k++) below[list[k]].add(list[k - 1]);
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (items[i].pass >= items[j].pass) continue;
    const s = overlapStats(items[i].shape, items[j].shape);
    if (s.inter < Math.max(20, 0.02 * Math.min(items[i].shape.count, items[j].shape.count))) continue;
    const front = frontOf(items[i], items[j], original) ?? items[i];
    if (front === items[i]) below[i].add(j); else below[j].add(i);
  }
  const key = (i: number) => [rankOf(items[i]), -items[i].pass, items[i].providerZ, i];
  const before = (x: number, y: number) => { const a = key(x), b = key(y); for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] - b[k]; return 0; };
  const placed = new Set<number>(), order: number[] = [];
  while (order.length < n) {
    const open = [...Array(n).keys()].filter(i => !placed.has(i)), ready = open.filter(i => [...below[i]].every(j => placed.has(j)));
    if (!ready.length) notes.push(`ORDER_CYCLE_BROKEN: overlaps between ${open.map(i => items[i].layer.file).join(', ')} contradict each other; ${items[open.sort(before)[0]].layer.file} was placed first.`);
    const next = (ready.length ? ready : open).sort(before)[0];
    placed.add(next); order.push(next);
  }
  return { order: order.map(i => items[i]), notes };
}

const pngOfMap = (map: Uint8Array, width: number, height: number) => sharp(Buffer.from(map.buffer, map.byteOffset, map.byteLength), { raw: { width, height, channels: 1 } }).png().toBuffer();

/**
 * Refines a rendered decomposition (see the module comment). Returns the final layers (the clean background as the base,
 * then every layer in stacking order, unplaced layers last) and warnings for the run. Updates run.refinement and
 * run.calls in place and writes every artifact; the caller persists the run.
 */
export async function refineDecomposition(ctx: RefineContext): Promise<{ layers: LayerInfo[]; warnings: string[] }> {
  const { dir, run, canvas } = ctx, record = run.refinement!, options = record.options, calls = run.calls!;
  Object.assign(record, { state: 'running', assessments: [], warnings: [] });
  for (const key of ['stopReason', 'stopDetail', 'passesExecuted', 'finalLayers', 'mask', 'background', 'fidelity', 'error', 'layerPlan', 'planCoverage', 'curation', 'backdrops', 'coverage'] as const) delete record[key];
  const merged = (semanticProtectionOf(run)?.merged ?? []).map(m => m.id);
  /** The contamination options for what is extracted so far: stricter once every planned element has its layer. */
  const assessing = (extracted: Item[]) => {
    record.planCoverage = planCoverage(ctx.interactions?.semantic ?? semanticAnalysisOf(run), merged, extracted.map(item => ({ file: item.layer.file, name: item.layer.name, description: item.layer.description })));
    return record.planCoverage?.complete ? { ...options, minContrast: PLANNED_MIN_CONTRAST } : options;
  };
  const read = (file: string) => readFileSync(join(dir, file));
  const baseAt = ctx.layers.findIndex(l => l.placement.kind === 'base');
  if (baseAt < 0) throw new Error('Seedream returned no usable base; editor curation cannot select a background. Raw assets are saved for inspection.');
  const A = gridFor(canvas, 640), M = gridFor(canvas, 2048), nA = A.width * A.height;
  const base0 = ctx.layers[baseAt], base0Png = read(base0.file);
  // The clean background's source: the uploaded image when it has the canvas aspect (it holds the real pixels), else the provider base.
  const sourceMeta = ctx.sourceImage ? await sharp(ctx.sourceImage).metadata().catch(() => undefined) : undefined;
  const source = sourceMeta?.width && sourceMeta.height && Math.abs((sourceMeta.width / sourceMeta.height) / (canvas.width / canvas.height) - 1) <= 0.01
    ? { png: ctx.sourceImage!, name: 'original' as const, file: run.input.file } : { png: base0Png, name: 'provider-base' as const, file: base0.file };
  const originalA = await rgbOnGrid(source.png, A);
  const dilateM = Math.max(1, Math.round(options.maskDilation * Math.min(M.width, M.height)));

  const items: Item[] = [];
  const rawCandidates: CurationCandidate[] = ctx.layers.map(layer => ({ layer, source: layer === base0 ? 'provider-base' : 'initial',
    ...(layer.placement.kind === 'unresolved' ? { rejected: { disposition: 'internal' as const, reason: layer.placement.reason ?? 'Unresolved placement; retained only for debugging.' } } : {}) }));
  for (const layer of ctx.layers) {
    if (layer === base0) continue;
    if (layer.placement.kind === 'unresolved') continue;
    const png = read(layer.file), shape = await layerShape(png, layer, A), { kind, role } = classify(layer, shape, A);
    items.push({ layer, png, shape, pass: 0, providerZ: layer.zIndex, kind, role, sourceImage: run.input.file, ...(run.seedream.requestId ? { requestId: run.seedream.requestId } : {}) });
    rawCandidates.find(c => c.layer === layer)!.item = items[items.length - 1];
  }

  // Residual passes: find what the decomposition so far left in the background, at most options.maxDepth times.
  const passTiles: { png: Buffer; title: string; sub: string }[] = [];
  let currentBase: Buffer = base0Png;
  const stop = (reason: StopReason, detail: string) => Object.assign(record, { stopReason: reason, stopDetail: detail });
  for (let depth = 1; ; depth++) {
    const explaining = items.filter(item => explains(item, A));
    const filledA = grow(unionOf(explaining.map(item => item.shape.alpha), nA), A.width, A.height, Math.max(1, Math.round(dilateM * A.scale / M.scale)));
    // Nothing extracted yet to fill: the residual is the base itself (already at the canvas size).
    const coreM = explaining.length ? grow(await coverageOnGrid(explaining.map(item => ({ png: item.png, placement: item.layer.placement })), M), M.width, M.height, dilateM) : undefined;
    const residual = coreM ? await localFill(currentBase, { map: coreM, width: M.width, height: M.height }, { map: featherMask(coreM, M.width, M.height, 1), width: M.width, height: M.height }, canvas) : currentBase;
    const residualFile = depth <= options.maxDepth ? `residual-pass-${depth}.png` : 'residual-final.png';
    writeFileSync(join(dir, residualFile), residual);
    const residualA = await rgbOnGrid(residual, A);
    // Cast shadows of the extracted foreground are not missed objects: the clean background removes them, and a residual
    // Seedream call on a shadow would be a paid call for nothing.
    const casting = explaining.filter(item => item.kind === 'foreground');
    const shadowsA = casting.length ? castShadows(originalA, grow(unionOf(casting.map(item => item.shape.alpha), nA), A.width, A.height, Math.max(1, Math.round(dilateM * A.scale / M.scale))), A.width, A.height).mask : new Uint8Array(nA);
    const assessOptions = assessing(items);
    const assessment = assessBackgroundContamination({ rgb: residualA, width: A.width, height: A.height, explained: unionOf([...explaining.map(item => item.shape.alpha), sceneMatch(items, residualA), shadowsA], nA) }, assessOptions);
    const entry: AssessmentRecord = { ...assessment, after: depth - 1, residual: residualFile, sent: false };
    record.assessments.push(entry);
    passTiles.push({ png: residual, title: depth <= options.maxDepth ? `Residual ${depth} (after pass ${depth - 1})` : `Residual after pass ${depth - 1}`, sub: `${assessment.verdict} · ${assessment.contaminatedPercent}% object-like` });
    if (!assessment.contaminated) { stop(assessment.verdict as StopReason, assessment.reasons.join(' ')); break; }
    // A paid residual pass only for what could be a missed element: not for shadows, residue or small marks, which the
    // clean background removes locally anyway.
    if (!meaningfulRegions(assessment, assessOptions).length) {
      stop('residue-only', `What is left is shadow-like or small residue (${assessment.regions.filter(r => r.confidence >= assessOptions.minConfidence).map(r => `${r.position} ${r.areaPercent}%${r.shadowLike ? ' shadow-like' : ''}`).slice(0, 6).join(', ')}): the clean background removes it locally; a residual call would not find an editor layer.`);
      break;
    }
    if (depth > options.maxDepth) { stop('max-depth', `Still contaminated after ${options.maxDepth} residual pass(es) (the hard limit is ${MAX_RESIDUAL_PASSES}): ${assessment.reasons.join(' ')}`); break; }
    if (items.length + 1 >= options.maxTotalLayers) { stop('max-total-layers', `The result already has ${items.length + 1} layers (limit ${options.maxTotalLayers}).`); break; }
    if (!ctx.allowNewCalls && !record.passes.find(p => p.pass === depth)?.requestId) {
      stop('resume-no-new-calls', `Residual pass ${depth} would be a new paid Seedream call, and a resume or re-render never makes one: ${assessment.reasons.join(' ')}`); break;
    }
    let raw: unknown, pass: PassRecord;
    const missingRoles = run.promptSource?.mode === 'template-plan' ? record.planCoverage?.planned.filter(id => !record.planCoverage!.matched[id]) ?? [] : [];
    try { ({ raw, pass } = await runPass(ctx, record, depth, residual, residualFile, residualPrompt(assessment, options.minConfidence, missingRoles))); entry.sent = true; }
    catch (error) {
      const failed = (error as { pass?: PassRecord }).pass, code = error instanceof PassError ? error.code : 'RESIDUAL_PASS_FAILED', message = error instanceof Error ? error.message : String(error);
      if (failed) Object.assign(failed, { state: 'failed', error: { code, message } });
      entry.sent = !!failed?.requestId;
      stop('pass-failed', `Residual pass ${depth} failed (${code}): ${message} Every earlier layer is kept.`);
      record.warnings.push(`RESIDUAL_PASS_FAILED: pass ${depth} (${code}): ${message}`);
      ctx.save(); break;
    }
    let rendered: Awaited<ReturnType<typeof renderPass>>;
    try { rendered = await renderPass(ctx, depth, raw, A, pass.requestId); }
    catch (error) {
      const code = error instanceof PassError ? error.code : 'RESIDUAL_RENDER_FAILED', message = error instanceof Error ? error.message : String(error);
      Object.assign(pass, { state: 'failed', error: { code, message } });
      stop('pass-failed', `Residual pass ${depth} could not be used (${code}): ${message} Every earlier layer is kept.`);
      record.warnings.push(`RESIDUAL_PASS_FAILED: pass ${depth} (${code}): ${message}`);
      break;
    }
    const { accepted, rejected, grouped } = await screen(ctx, rendered.candidates, items, filledA, options, A, depth);
    rawCandidates.push(...rendered.rawItems.map((item): CurationCandidate => {
      const rejection = rejected.find(r => r.file === item.layer.file);
      return { layer: item.layer, item, source: `residual-${depth}`,
        ...(item.layer.placement.kind === 'base' ? { rejected: { disposition: 'internal' as const, reason: 'Intermediate residual base; the final background is selected after all passes.' } }
          : rejection ? { rejected: { disposition: rejection.reason === 'unplaced' ? 'internal' as const : 'drop' as const, reason: `Residual candidate rejected: ${rejection.reason}${rejection.duplicateOf ? ` of ${rejection.duplicateOf}` : ''}.` } } : {}) };
    }));
    Object.assign(pass, { state: 'done', returnedLayers: rendered.returned, accepted: accepted.map(item => item.layer.file), rejected: rejected.map(({ item, ...rest }) => { void item; return rest; }), ...(grouped.length ? { grouped } : {}) });
    delete pass.error;
    for (const item of accepted) passTiles.push({ png: item.png, title: `P${depth} · ${item.layer.name ?? 'layer'}`, sub: `new · ${item.role} · ${round(100 * item.shape.count / nA, 1)}%` });
    for (const r of rejected) passTiles.push({ png: r.item.png, title: `✗ P${depth} · ${r.name ?? 'layer'}`, sub: `${r.reason}${r.duplicateOf ? ` of ${r.duplicateOf}` : ''}` });
    if (!accepted.length) {
      const duplicates = rejected.filter(r => r.reason === 'duplicate' || r.reason === 'inside-extracted-region').length;
      stop(duplicates ? 'all-duplicates' : 'no-new-layers', duplicates ? `Residual pass ${depth} returned only layers already extracted (${duplicates} duplicate(s)).` : `Residual pass ${depth} returned no new usable layer.`);
      break;
    }
    items.push(...accepted);
    currentBase = rendered.base ?? residual;
  }
  const residualPasses = record.passes.filter(p => p.state === 'done').length;
  record.passesExecuted = 1 + residualPasses;

  // One stacking order for every layer (pass provenance is not z-order).
  const stacking = stackOrder(items, originalA), renumber = stacking.order.some(item => item.pass > 0);
  record.warnings.push(...stacking.notes);
  // Final z: Seedream's own when nothing was added, else the stacking position. Groups are made on that order, so a
  // residual-pass bangle is composited onto its hand in the right depth.
  let order = stacking.order.map((item, i): Item => ({ ...item, layer: { ...item.layer, ...(renumber ? { zIndex: i + 1 } : {}) } }));
  // The layers as Seedream returned them: whether a base still shows a layer is judged per layer, never per group (a
  // group of skin and bangles would hide that the base still shows the bangles).
  let ungrouped = order;
  const coverageGroups: { file: string; members: string[] }[] = [];
  /** Uncovered content that continues the base (coverage step): the base's own, which a background rightly shows. */
  let baseContent: Uint8Array | undefined;

  // Protected people and interactions over every layer (residual-pass ones too, so a bangle or finger piece a residual
  // pass found joins its person instead of becoming a layer), before the background mask.
  const grouping = await groupInteractions({ dir, canvas, grid: A, entries: order.map(item => ({ layer: item.layer, png: item.png, shape: item.shape })),
    ...(source.name === 'original' ? { original: originalA } : {}), semantic: ctx.interactions?.semantic, options: ctx.interactions?.options ?? { heldObjects: true } });
  run.interactions = grouping.record;
  for (const candidate of rawCandidates) {
    const reconciled = ungrouped.find(item => item.layer.file === candidate.layer.file);
    if (reconciled) { candidate.item = reconciled; candidate.layer = reconciled.layer; }
  }
  if (grouping.groups.length) {
    const byLayer = new Map(order.map(item => [item.layer, item]));
    order = grouping.entries.map((entry): Item => {
      const own = byLayer.get(entry.layer);
      if (own) return own;
      const members = grouping.groups.find(g => g.entry === entry)!.members.map(m => byLayer.get(m.layer)!);
      const pass = Math.min(...members.map(m => m.pass)), top = members.filter(m => m.pass === pass).sort((a, b) => b.providerZ - a.providerZ)[0];
      const { kind, role } = classify(entry.layer, entry.shape, A);
      return { layer: entry.layer, png: entry.png, shape: entry.shape, pass, providerZ: top.providerZ, kind, role, sourceImage: top.sourceImage, ...(top.requestId ? { requestId: top.requestId } : {}) };
    });
    for (const g of grouping.groups) passTiles.push({ png: g.entry.png, title: `Group · ${g.entry.layer.name ?? g.entry.layer.file}`,
      sub: `${g.entry.layer.grouping?.protectedInteraction ? 'hand holding object' : g.entry.layer.grouping?.attachmentReason} · ${g.members.length} layers` });
    record.warnings.push(`PROTECTED_INTERACTIONS: ${grouping.groups.length} group(s) kept together (${grouping.groups.map(g => `${g.entry.layer.grouping?.protectedInteraction ? 'hand holding object' : g.entry.layer.grouping?.attachmentReason}: ${g.members.length} layers`).join('; ')}); ${grouping.record.layersBefore} → ${grouping.record.layersAfter} layers.`);
  }
  // The reconciled semantic type protects generically named people/products/text during usefulness screening.
  order = order.map(item => {
    const category = layerCategory(item, nA);
    return ['person', 'product', 'text'].includes(category) ? { ...item, kind: 'foreground' as const } : item;
  });
  // Backdrop components (a panel, a card, a shape on the base canvas) are layers of their own, never folded into the
  // background as a "plate"; the base is then judged clean behind them too, so hiding one reveals the base.
  const semantic = ctx.interactions?.semantic ?? semanticAnalysisOf(run), roleOf = planRoles(semantic, run.planner?.capture?.roles);
  const matched = new Set(order.flatMap(item => item.layer.semantic ? [item.layer.semantic.id] : []));
  const openSlots = (semantic?.elements ?? []).filter(e => e.editable_independently && !e.attachment?.keep_with_parent && !merged.includes(e.id) && !matched.has(e.id))
    .map(e => roleOf(e.id)).filter((role): role is TemplateRole => role === 'backdrop' || role === 'decoration');
  record.backdrops = backdropComponents(order, A, roleOf, openSlots);
  const components = record.backdrops.filter(d => d.component);
  if (components.length) {
    const promoted = new Set(components.map(d => d.file)), promote = (item: Item): Item => promoted.has(item.layer.file) ? { ...item, kind: 'foreground', role: 'backdrop' } : item;
    order = order.map(promote); ungrouped = ungrouped.map(promote);
  }

  // Which layers are worth an editor layer: invented fillers, hidden guesses, faint remnants and detached shadow stains
  // are left out (people, products and text always stay). Judged against the original, so only when it is the source.
  const screening = screenFillers(order.map(item => ({ layer: item.layer, shape: item.shape, kind: item.kind, role: item.role })), originalA, A, source.name === 'original');
  const droppedFiles = new Map(screening.filter(d => !d.kept).map(d => [d.file, d]));
  const removed = order.filter(item => droppedFiles.get(item.layer.file)?.action === 'remove');
  const dropped = order.filter(item => droppedFiles.has(item.layer.file));
  order = order.filter(item => !droppedFiles.has(item.layer.file));
  // Shape-only backdrops (no plan role) stay in the base when separating them would turn its free, trusted local
  // rebuild into a paid edit: judged on the real removal (after screening), as the background step will see it.
  if (source.name === 'original' && record.backdrops.some(d => d.component && d.basis === 'shape')) {
    const grown = Math.max(1, Math.round(dilateM * A.scale / M.scale)), stains = removed.map(item => item.shape.alpha);
    record.backdrops = keepShapesFree(record.backdrops, files => {
      const kept = order.filter(item => item.kind === 'foreground' && (item.role !== 'backdrop' || files.includes(item.layer.file) || !record.backdrops!.some(d => d.file === item.layer.file && d.basis === 'shape')));
      const core = grow(unionOf([...kept.map(item => item.shape.alpha), ...stains], nA), A.width, A.height, grown);
      return continuationTrust(backgroundDifficulty(originalA, core, A.width, A.height), plainFieldFill(originalA, core, A.width, A.height).plain).trusted;
    });
    const demoted = new Set(components.filter(d => !record.backdrops!.find(x => x.file === d.file)!.component).map(d => d.file));
    if (demoted.size) {
      const demote = (item: Item): Item => demoted.has(item.layer.file) ? { ...item, ...classify(item.layer, item.shape, A) } : item;
      order = order.map(demote); ungrouped = ungrouped.map(demote);
      record.warnings.push(`BACKDROP_KEPT_IN_BASE: ${[...demoted].map(file => components.find(d => d.file === file)!.name ?? file).join('; ')} stay in the base: separating ${demoted.size > 1 ? 'them' : 'it'} would need a paid background edit the plan does not ask for.`);
    }
  }
  const separated = record.backdrops.filter(d => d.component && order.some(item => item.layer.file === d.file));
  if (separated.length) record.warnings.push(`BACKDROP_LAYERS: ${separated.map(d => `${d.name ?? d.file} (${d.basis === 'plan' ? `plan: ${d.role}` : 'shape'})`).join('; ')} kept as their own layer${separated.length > 1 ? 's' : ''} above the base canvas.`);
  // Coverage: original content no layer took and the clean base lacks (an object's part Seedream left out of every layer,
  // a backdrop's missing fade) joins the layer it belongs to, cut from the original against the base; a smooth backdrop
  // shows the original where it is visible and is completed where it is hidden. Never a mask grown blindly.
  if (source.name === 'original') {
    const reference = await rgbOnGrid(base0Png, A), alphaOf = (item: Item) => { const a = new Uint8Array(nA); for (let i = 0; i < nA; i++) if (item.shape.rgba[i * 4 + 3] > 64) a[i] = 1; return a; };
    // What the editor's layers cover: foreground layers and scene layers that stay layers (a full plate is the background).
    const layered = unionOf(order.filter(item => item.kind === 'foreground' || !isPlate(item, A)).map(alphaOf), nA), found = uncoveredContent(originalA, reference, layered, A);
    // Backdrops here: the separated backdrop components, and every smooth scene layer that stays in the base without being
    // the base canvas itself (a disc kept in the base still owns its missing wedge; an object never does). The base
    // canvas, plate or not (a wall and floor with holes behind the people), is the background: what it lacks is the base's.
    const smoothFiles = new Set(record.backdrops.filter(d => d.smoothness <= SMOOTH_STEP && d.role !== 'background' && (d.component || order.some(item => item.layer.file === d.file && item.kind !== 'foreground' && !isPlate(item, A)))).map(d => d.file));
    const backdropFiles = new Set([...record.backdrops.filter(d => d.component).map(d => d.file), ...smoothFiles]);
    const candidates = order.map((item): OwnerCandidate => ({ id: item.layer.file, alpha: alphaOf(item), z: item.layer.zIndex, rgba: item.shape.rgba,
      kind: backdropFiles.has(item.layer.file) ? 'backdrop' : item.kind === 'foreground' && !['scene', 'effect'].includes(layerCategory(item, nA)) ? 'object' : 'other' }));
    const joins = new Map<string, Uint8Array[]>(), nameOf = (id: string) => order.find(item => item.layer.file === id)!.layer.name ?? id;
    record.coverage = { typical: found.typical, cut: found.cut, regions: [], backdrops: [] };
    const assign = (mask: Uint8Array, owner: OwnerCandidate | undefined, smooth: boolean, meanDiff: number, ofBase = false) => {
      let px = 0; for (const v of mask) px += v;
      record.coverage!.regions.push({ areaPercent: round(100 * px / nA), meanDiff, smooth, owner: owner ? nameOf(owner.id) : null, ...(ofBase ? { ofBase } : {}) });
      if (owner) joins.set(owner.id, [...(joins.get(owner.id) ?? []), mask]);
    };
    // Where each smooth backdrop really is (coverageRecovery.smoothReach): grown from where its own pixels already show
    // the creative, never across an edge of the original (an edge is a step of more than twice what a smooth surface
    // steps on average). Unverified, and left as the provider drew it, when its pixels show the creative almost nowhere,
    // or when the base already shows it (the original matches the base over most of it): a base that still has the
    // backdrop is no reference to cut it from (it would cut it away).
    const bridge = Math.max(2, Math.round(0.02 * Math.min(A.width, A.height))), uncovered = unionOf(found.regions.map(r => r.mask), nA);
    const objectLike = new Uint8Array(nA); for (let i = 0; i < nA; i++) if (Math.max(Math.abs(originalA[i * 3] - reference[i * 3]), Math.abs(originalA[i * 3 + 1] - reference[i * 3 + 1]), Math.abs(originalA[i * 3 + 2] - reference[i * 3 + 2])) > found.cut) objectLike[i] = 1;
    type Reach = { reach: Uint8Array; carried: Uint8Array } | null;
    const reaches = new Map<string, Reach>();
    const reachOf = (backdrop: OwnerCandidate): Reach => {
      if (reaches.has(backdrop.id)) return reaches.get(backdrop.id)!;
      let result: Reach = null;
      if (smoothFiles.has(backdrop.id)) {
        const front = unionOf(candidates.filter(c => c.z > backdrop.z).map(c => c.alpha), nA), nearFront = grow(front, A.width, A.height, 2);
        const visible = new Uint8Array(nA), domain = new Uint8Array(nA), settled = new Uint8Array(nA);
        let shown = 0, inBase = 0, settledCount = 0;
        for (let i = 0; i < nA; i++) { if (backdrop.alpha[i] && !front[i]) { visible[i] = 1; shown++; if (!nearFront[i]) { settled[i] = 1; settledCount++; if (!objectLike[i]) inBase++; } } if (visible[i] || uncovered[i]) domain[i] = 1; }
        const own = order.find(item => item.layer.file === backdrop.id)!.shape.rgba, seeds = agreeing(own, originalA, reference, settled), fits = agreeing(own, originalA, reference, visible);
        let seeded = 0; for (const v of seeds) seeded += v;
        if (shown && seeded >= 0.1 * shown && inBase < 0.5 * settledCount) {
          const reach = smoothReach(domain, seeds, front, originalA, A, 2 * SMOOTH_STEP, bridge);
          // Object content inside the backdrop's outline that the backdrop layer does not show (a lid's rim where it drew
          // its own grey): unreached, unlike the base, not what the layer has there, and part of uncovered content or as
          // large as a region. Small unreached specks (its own anti-aliased edge) stay.
          const foreign = new Uint8Array(nA); for (let i = 0; i < nA; i++) if (visible[i] && !reach[i] && objectLike[i] && !fits[i]) foreign[i] = 1;
          const nextToUncovered = grow(uncovered, A.width, A.height, 1), carried = new Uint8Array(nA);
          for (const part of parts(foreign, A, 1)) {
            let px = 0, touches = false; for (let i = 0; i < nA; i++) if (part[i]) { px++; if (nextToUncovered[i]) touches = true; }
            if (touches || px >= Math.round(MIN_REGION * nA)) for (let i = 0; i < nA; i++) if (part[i]) carried[i] = 1;
          }
          result = { reach, carried };
        }
      }
      reaches.set(backdrop.id, result);
      return result;
    };
    // The base's own missing content: what continues the base where it already shows the creative, never across an edge
    // (a wedge of a disc the base keeps, cut out of it). The base lacks it, so no object owns it: a gap, never a join.
    const baseSeeds = new Uint8Array(nA), open = new Uint8Array(nA), nearLayers = grow(layered, A.width, A.height, 2);
    for (let i = 0; i < nA; i++) { if (layered[i]) continue; open[i] = 1; if (!nearLayers[i] && Math.max(Math.abs(originalA[i * 3] - reference[i * 3]), Math.abs(originalA[i * 3 + 1] - reference[i * 3 + 1]), Math.abs(originalA[i * 3 + 2] - reference[i * 3 + 2])) <= 24) baseSeeds[i] = 1; }
    const ofBase = smoothReach(open, baseSeeds, layered, originalA, A, 2 * SMOOTH_STEP, bridge);
    baseContent = Uint8Array.from(ofBase, (v, i) => v && uncovered[i] ? 1 : 0);
    const objectParts = new Uint8Array(nA);
    for (const region of found.regions) {
      // Content touching a smooth backdrop is the backdrop where the backdrop reaches it; what the base reaches is the
      // base's; the rest (an object's part in front of it) is an object's.
      const backdrop = touchingBackdrop(region.mask, candidates, A), known = backdrop ? reachOf(backdrop) : null;
      const continues = new Uint8Array(nA), base = new Uint8Array(nA); let any = false, anyBase = false;
      for (let i = 0; i < nA; i++) if (region.mask[i]) { if (known?.reach[i]) { continues[i] = 1; any = true; } else if (ofBase[i]) { base[i] = 1; anyBase = true; } else objectParts[i] = 1; }
      if (any) assign(continues, backdrop!, true, region.meanDiff);
      if (anyBase) { let px = 0; for (const v of base) px += v; if (px >= Math.round(MIN_REGION * nA)) assign(base, undefined, region.smooth, region.meanDiff, true); }
    }
    for (const candidate of candidates) if (candidate.kind === 'backdrop') { const known = reachOf(candidate); if (known) for (let i = 0; i < nA; i++) if (known.carried[i]) objectParts[i] = 1; }
    const reached = unionOf([...reaches.values()].filter((r): r is NonNullable<Reach> => !!r).map(r => r.reach), nA);
    // An object's part is all of it the original shows: from its clear core (above the cut) out through what still
    // differs clearly from the base (a grey lid on a pale glow differs by less than the cut), never into another layer,
    // where a backdrop is verified, or into the base re-lit (the original's glow or shade the provider's base renders
    // differently). A piece the cut missed lies inside the object's outline, between its clear parts and the layers
    // around it; one open to the base along more than a quarter of its outline is the base's tone, not the object.
    // `faint`: well above the base's own tone drift.
    const faint = Math.max(24, 2 * found.typical + 12), drift = Math.max(8, found.typical);
    const elsewhere = unionOf(order.filter(item => (item.kind === 'foreground' || !isPlate(item, A)) && !reaches.get(item.layer.file)).map(alphaOf), nA), extent = new Uint8Array(nA);
    for (let i = 0; i < nA; i++) if (objectParts[i] || (!elsewhere[i] && !reached[i] && Math.max(Math.abs(originalA[i * 3] - reference[i * 3]), Math.abs(originalA[i * 3 + 1] - reference[i * 3 + 1]), Math.abs(originalA[i * 3 + 2] - reference[i * 3 + 2])) > faint && !baseTone(originalA, reference, i))) extent[i] = 1;
    const core = Uint8Array.from(objectParts), extension = new Uint8Array(nA);
    for (const part of parts(extent, A, 1)) if (part.some((v, i) => v && core[i])) for (let i = 0; i < nA; i++) if (part[i] && !core[i]) extension[i] = 1;
    for (const piece of parts(extension, A, 1)) {
      const ring = grow(piece, A.width, A.height, 1); let outline = 0, open = 0;
      for (let i = 0; i < nA; i++) if (ring[i] && !piece[i]) { outline++; if (!core[i] && !extension[i] && !elsewhere[i] && !reached[i]) open++; }
      if (open <= 0.25 * outline) for (let i = 0; i < nA; i++) if (piece[i]) objectParts[i] = 1;
    }
    // Pieces of one part split by something thin in front of it (a lid cut by an earbud's stem) are one part: grouped
    // across small gaps, each group joins the back-most object it touches.
    for (const group of parts(grow(objectParts, A.width, A.height, bridge), A, 1)) {
      const mask = new Uint8Array(nA); let px = 0;
      for (let i = 0; i < nA; i++) if (group[i] && objectParts[i]) { mask[i] = 1; px++; }
      if (px < Math.round(MIN_REGION * nA)) continue;
      const touchingAny = grow(mask, A.width, A.height, bridge), owner = ownerOf(touchingAny, candidates, A, { original: originalA, part: mask });
      const overlapping = found.regions.filter(r => r.mask.some((v, i) => v && mask[i]));
      let diff = 0; for (let i = 0; i < nA; i++) if (mask[i]) diff += Math.max(Math.abs(originalA[i * 3] - reference[i * 3]), Math.abs(originalA[i * 3 + 1] - reference[i * 3 + 1]), Math.abs(originalA[i * 3 + 2] - reference[i * 3 + 2]));
      assign(mask, owner, overlapping.length > 0 && overlapping.every(r => r.smooth), Math.round(diff / px));
    }
    const smoothBackdrops = order.filter(item => smoothFiles.has(item.layer.file));
    if (joins.size || smoothBackdrops.length) {
      const W = canvas.width, H = canvas.height, full = { width: W, height: H, scale: 1 }, nC = W * H;
      const originalC = await sharp(source.png).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer(), referenceC = await sharp(base0Png).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
      const toCanvas = (map: Uint8Array) => { const out = new Uint8Array(nC); for (let y = 0; y < H; y++) { const sy = Math.min(A.height - 1, Math.floor(y * A.height / H)); for (let x = 0; x < W; x++) out[y * W + x] = map[sy * A.width + Math.min(A.width - 1, Math.floor(x * A.width / W))]; } return out; };
      const rewrite = async (item: Item, rgba: Buffer, note: string): Promise<Item> => {
        const from = item.layer.rawFile ?? item.layer.file, file = `${from.replace(/\.png$/i, '')}-covered.png`, png = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
        writeFileSync(join(dir, file), png);
        let opaque = 0; for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 127) opaque++;
        const layer: LayerInfo = { ...item.layer, file, rawFile: from, pixelWidth: W, pixelHeight: H, opaquePercent: round(100 * opaque / nC, 1), placement: { kind: 'full-canvas', x: 0, y: 0, width: W, height: H },
          description: [item.layer.description, note].filter(Boolean).join(' ') };
        if (!coverageGroups.some(g => g.file === file)) coverageGroups.push({ file, members: [from] });
        return { ...item, png, layer, shape: await layerShape(png, layer, A) };
      };
      const replace = (next: Item, previous: string) => { order = order.map(item => item.layer.file === previous ? next : item); ungrouped = ungrouped.map(item => item.layer.file === previous ? next : item); };
      for (const [file, regions] of joins) {
        // An object's part stops where a backdrop is verified to continue (the two meet there, never overlap). Opaque where
        // it differs from the base by what made it part of the object; its one-pixel edge only where it clearly differs
        // (an anti-aliased edge, not the base's glow beside it).
        const item = order.find(x => x.layer.file === file)!, part = unionOf(regions, nA), edge = grow(part, A.width, A.height, 1);
        for (let i = 0; i < nA; i++) if (part[i] || (!smoothFiles.has(file) && reached[i])) edge[i] = 0;
        const own = await compositeOnGrid([{ png: item.png, placement: item.layer.placement }], full);
        const cut = over(matte(originalC, referenceC, toCanvas(part), drift, faint), matte(originalC, referenceC, toCanvas(edge), faint, faint + 48));
        replace(await rewrite(item, over(own, cut), 'Completed from the original where no layer showed it.'), file);
      }
      // Where a backdrop meets content an object took: completed like its hidden part, never copied from the original (the
      // object's anti-aliased edge would stay behind on the backdrop when the object moves).
      const taken = toCanvas(grow(unionOf([...joins.values()].flat(), nA), A.width, A.height, 1));
      for (const backdrop of smoothBackdrops) {
        const item = order.find(x => x.layer.rawFile === backdrop.layer.file || x.layer.file === backdrop.layer.file)!, known = reaches.get(backdrop.layer.file) ?? null;
        const rgba = await compositeOnGrid([{ png: item.png, placement: item.layer.placement }], full);
        const front = await coverageOnGrid(order.filter(x => x.layer.zIndex > item.layer.zIndex).map(x => ({ png: x.png, placement: x.layer.placement })), full);
        let corrected = 0, completed = 0, carried = 0;
        if (known) {
          for (const v of known.carried) carried += v;
          // Visible: where nothing is in front of it and it is verified to be there (or the original shows nothing the
          // base lacks), it is what the creative shows (matted against the base, above the base's own tone drift).
          const blocked = new Uint8Array(nA); for (let i = 0; i < nA; i++) if (!known.reach[i] && objectLike[i]) blocked[i] = 1;
          const blockedC = toCanvas(blocked), visible = new Uint8Array(nC);
          for (let i = 0; i < nC; i++) if (!front[i] && !blockedC[i] && !taken[i] && rgba[i * 4 + 3] > 16) visible[i] = 1;
          const shown = matte(originalC, referenceC, visible, drift, drift + 40);
          // Only where the provider's own pixel over the base does not show the creative: where it does, its own split into
          // colour and opacity is kept (a soft shadow stays a transparent darkening, not an opaque grey that looks alike here).
          for (let i = 0; i < nC; i++) {
            if (!visible[i]) continue;
            const a = rgba[i * 4 + 3] / 255;
            if ([0, 1, 2].some(c => Math.abs(rgba[i * 4 + c] * a + referenceC[i * 3 + c] * (1 - a) - originalC[i * 3 + c]) > 24)) { for (let c = 0; c < 4; c++) rgba[i * 4 + c] = shown[i * 4 + c]; corrected++; }
          }
        }
        // Hidden: inside its own outline (convex hull) and behind what is in front, continued from its own pixels (never
        // the provider's guess there: a product's grey baked into it).
        const solid = new Uint8Array(nC); for (let i = 0; i < nC; i++) if (rgba[i * 4 + 3] > 64) solid[i] = 1;
        const hull = convexHull(solid, W, H), hidden = new Uint8Array(nC);
        for (let i = 0; i < nC; i++) if (hull[i] && (front[i] || taken[i])) hidden[i] = 1;
        // Replaced only where its visible part proved the provider's colours wrong; otherwise only its holes are filled.
        const done = completeHidden(rgba, hidden, hull, W, H, corrected > 0);
        for (let i = 0; i < nC; i++) if (hidden[i] && [0, 1, 2, 3].some(c => done[i * 4 + c] !== rgba[i * 4 + c])) completed++;
        record.coverage.backdrops.push({ layer: item.layer.name ?? item.layer.file, verified: !!known, carriedPercent: round(100 * carried / nA, 2), correctedPercent: round(100 * corrected / nC, 2), completedPercent: round(100 * completed / nC, 2) });
        if (corrected || completed) replace(await rewrite(item, done, 'Visible pixels as the creative shows them; hidden part continued inside its outline.'), item.layer.file);
      }
    }
    const joined = record.coverage.regions.filter(r => r.owner), left = record.coverage.regions.filter(r => !r.owner);
    if (joined.length) record.warnings.push(`COVERAGE_COMPLETED: ${joined.map(r => `${r.areaPercent}% → ${r.owner}`).join('; ')}: original content no layer showed and the clean base lacked, cut from the original into the layer it belongs to.`);
    if (left.length) record.warnings.push(`COVERAGE_GAPS: ${left.map(r => `${r.areaPercent}% (${r.ofBase ? 'continues the base, which lacks it' : r.smooth ? 'smooth' : 'textured'})`).join('; ')} of the original is in no layer and no layer it could join touches it. Review the layers.`);
  }
  for (const item of dropped) passTiles.push({ png: item.png, title: `✗ Not a layer · ${item.layer.name ?? item.layer.file}`, sub: `${droppedFiles.get(item.layer.file)!.reason} · ${droppedFiles.get(item.layer.file)!.action === 'remove' ? 'removed' : 'kept in background'}` });

  // The foreground union mask: every foreground layer (and every removed stain), grown a little (edges, halos), feathered.
  const foreground = order.filter(item => item.kind === 'foreground' && item.shape.count > 0);
  const removal = [...foreground, ...removed];
  let coreM = removal.length ? grow(await coverageOnGrid(removal.map(item => ({ png: item.png, placement: item.layer.placement })), M), M.width, M.height, dilateM) : new Uint8Array(M.width * M.height);
  let coreA = await resizeMap(coreM, M, A, 'nearest');
  await new Promise<void>(done => setImmediate(done));
  // Plus the cast shadows of what is removed (soft, same-hue darkening touching it): removed with their subject, so no
  // background candidate keeps them and no fill smears them into the hole.
  const shadow = removal.length ? castShadows(originalA, coreA, A.width, A.height) : undefined;
  if (shadow?.percent) {
    const shadowM = grow(await resizeMap(shadow.mask, A, M, 'nearest'), M.width, M.height, Math.max(1, Math.round(M.scale / A.scale)));
    coreM = Uint8Array.from(coreM, (v, i) => v || shadowM[i]);
    coreA = Uint8Array.from(coreA, (v, i) => v || shadow.mask[i]);
    writeFileSync(join(dir, SHADOW_FILE), await pngOfMap(await resizeMap(Uint8Array.from(shadowM, v => v * 255), M, canvas, 'nearest'), canvas.width, canvas.height));
    record.warnings.push(`CAST_SHADOWS_REMOVED: ${shadow.note}`);
  }
  const featherM = Math.max(1, Math.min(dilateM, Math.round(dilateM * options.maskFeather)));
  const alphaM = featherMask(coreM, M.width, M.height, featherM);
  let covered = 0; for (const v of coreM) covered += v;
  writeFileSync(join(dir, MASK_FILE), await pngOfMap(await resizeMap(alphaM, M, canvas), canvas.width, canvas.height));
  record.mask = { layers: removal.map(item => item.layer.file), coveragePercent: round(100 * covered / (M.width * M.height), 1), dilatePx: round(dilateM / M.scale, 1), featherPx: round(featherM / M.scale, 1), file: MASK_FILE,
    ...(shadow?.percent ? { shadowPercent: shadow.percent, shadowFile: SHADOW_FILE } : {}) };

  // Does the provider base still show the extracted layers? Compared with the original where each layer is (layers left
  // out as fillers are not the creative's, so nothing is expected of them).
  const major = ungrouped.filter(item => item.kind === 'foreground' && 100 * item.shape.count / nA >= 0.3 && !droppedFiles.has(item.layer.file)).map(item => ({ file: item.layer.file, name: item.layer.name, alpha: item.shape.alpha }));
  // The original's background under the layers, estimated only when there is a layer to check against it.
  const model = major.length ? backgroundModel(originalA, A.width, A.height, grow(unionOf(foreground.map(item => item.shape.alpha), nA), A.width, A.height, 2)).model : new Float32Array(0);
  await new Promise<void>(done => setImmediate(done));
  const difficulty = backgroundDifficulty(originalA, coreA, A.width, A.height);
  // What a clean background looks like behind the foreground, continued from the original around it: the plain field
  // when every removed region sits on one, else the region-aware graphic continuation. Every candidate is compared with
  // it, so a ghost of the removed subject (a darker silhouette, a shadow) is caught however soft it is.
  const plainA = plainFieldFill(originalA, coreA, A.width, A.height);
  // A continuation judges other candidates only where it can be trusted: next to a guessed fill, a correct edit of a
  // shaded or photographic background would read as residue or darkening.
  const trust = continuationTrust(difficulty, plainA.plain);
  const expectedA = !trust.trusted ? undefined : plainA.plain ? plainA.out : graphicFill(originalA, coreA, A.width, A.height);
  // Every candidate background is judged the same way: does it still show a removed layer (per layer, never per group),
  // and is the area behind the foreground a usable continuation of its surroundings (backgroundRecovery.ts)?
  type Candidate = { method: CleanBackgroundMethod; png: Buffer; quality: BackgroundQuality; recreated: Retention[] };
  const candidates: Candidate[] = [];
  /** Lets the server answer other requests between long pixel computations (one process serves every run). */
  const breathe = () => new Promise<void>(done => setImmediate(done));
  const evaluate = async (method: CleanBackgroundMethod, png: Buffer, ai?: Buffer): Promise<Candidate> => {
    await breathe();
    const rgbA = await rgbOnGrid(png, A);
    const recreated = source.name === 'original' ? objectRetention(rgbA, originalA, model, major, A.width).filter(r => recreates(r, options.retainedPercent)) : [];
    await breathe();
    // Provider candidates must also be the creative's background outside the removed area (not a re-rendered or
    // placeholder base); candidates built from the original are that by construction.
    const provider = (method === 'provider-base' || method === 'scene-composite') && source.name === 'original';
    let quality = backgroundQuality({ rgb: rgbA, core: coreA, w: A.width, h: A.height, recreated: recreated.length, ...(expectedA ? { expected: expectedA, plain: plainA.plain } : {}), ...(provider ? { original: originalA } : {}),
      ...(ai && source.name === 'original' ? { outside: { ai: await rgbOnGrid(ai, A), source: originalA } } : {}) });
    // A local continuation of surroundings it cannot reliably continue is at best a fallback, never "usable".
    if (LOCAL_METHODS.has(method) && !trust.trusted && removal.length) quality = { ...quality, quality: quality.quality === 'usable' ? 'degraded' : quality.quality, reasons: [...quality.reasons, 'untrusted-continuation'] };
    const candidate = { method, png, quality, recreated };
    candidates.push(candidate);
    return candidate;
  };
  const acceptable = (c: Candidate) => c.quality.quality === 'usable' && !c.recreated.length;
  const baseRetention = source.name === 'original' ? objectRetention(await rgbOnGrid(base0Png, A), originalA, model, major, A.width) : [];
  const reasons: string[] = [], steps: BackgroundStep[] = [];
  const faults = (c: Candidate) => [...c.quality.reasons, ...c.recreated.map(r => `recreates ${r.name ?? r.file}`)].join(', ');
  let chosen: Candidate | undefined, reconstructionReason: string | undefined, fallbackUsed = false, aiTried = false, providerKept = false;
  // 1. Seedream's base, when it no longer shows any extracted layer and its hidden area is usable: no call.
  if (!removal.length) { chosen = await evaluate('provider-base', base0Png); reasons.push('There is no foreground layer to remove.'); }
  else if (source.name === 'original') {
    const base = await evaluate('provider-base', base0Png);
    if (acceptable(base)) { chosen = base; reasons.push('Seedream\'s base no longer shows any extracted layer, so it is kept as returned (no reconstruction call).'); }
    else reasons.push(base.recreated.length ? `Seedream's base still shows ${base.recreated.map(r => `${r.name ?? r.file} (${r.retainedPercent}%)`).join(', ')}.` : `Seedream's base is not usable behind the foreground (${base.quality.reasons.join(', ')}).`);
  } else reasons.push('The original does not match the canvas aspect, so the provider base is cleaned instead and cannot be compared.');
  steps.push(!removal.length ? { step: 'provider-base', outcome: 'chosen', reason: 'No foreground layer is removed, so Seedream\'s base is the background (no call).' }
    : source.name !== 'original' ? { step: 'provider-base', outcome: 'skipped', reason: reasons[reasons.length - 1] }
    : { step: 'provider-base', outcome: chosen ? 'chosen' : 'rejected', reason: reasons[reasons.length - 1] });
  // 2. Seedream's own scene layers (white field, brand curve, gradient) over its base: they often already hold the
  // complete background behind the person. No call.
  const scene = order.filter(item => item.kind === 'background' && item.shape.count > 0).sort((a, b) => a.layer.zIndex - b.layer.zIndex);
  if ((!chosen || (chosen.method === 'provider-base' && scene.some(item => isPlate(item, A)))) && scene.length && source.name === 'original') {
    const full = { width: canvas.width, height: canvas.height, scale: 1 };
    const rgba = await compositeOnGrid([{ png: base0Png, placement: base0.placement }, ...scene.map(item => ({ png: item.png, placement: item.layer.placement }))], full);
    const composite = await evaluate('scene-composite', await sharp(flattenRgba(rgba), { raw: { width: canvas.width, height: canvas.height, channels: 3 } }).ensureAlpha().png().toBuffer());
    if (acceptable(composite)) { chosen = composite; reasons.push(`Seedream's scene layers (${scene.map(item => item.layer.name ?? item.layer.file).join(', ')}) over its base hold a clean background behind every extracted layer (no reconstruction call).`); }
    else reasons.push(`Seedream's scene layers over its base are not clean enough (${[...composite.recreated.map(r => `still shows ${r.name ?? r.file}`), ...composite.quality.reasons].join(', ')}).`);
  }
  const sceneCandidate = candidates.find(c => c.method === 'scene-composite');
  steps.push(sceneCandidate ? { step: 'scene-composite', outcome: sceneCandidate === chosen ? 'chosen' : 'rejected', reason: reasons[reasons.length - 1] }
    : { step: 'scene-composite', outcome: 'skipped', reason: chosen ? 'Not needed: Seedream\'s base is already clean (no call).' : !scene.length ? 'Seedream returned no scene layer to rebuild the background from.' : 'The original does not match the canvas aspect.' });
  // The deterministic continuation from the ORIGINAL: the AI edit's starting image (so the model never sees the removed
  // subject) and the fallback. A plain field continues as its smooth surface; simple graphic backgrounds continue region
  // by region; anything else by local fill.
  let prefill: { method: CleanBackgroundMethod; png: Buffer } | undefined;
  const prefilled = async () => {
    if (prefill) return prefill;
    const W = gridFor(canvas, 1024), coreW = await resizeMap(coreM, M, W, 'nearest'), sourceW = await rgbOnGrid(source.png, W);
    await breathe();
    const plainW = plainA.plain ? plainFieldFill(sourceW, coreW, W.width, W.height) : undefined;
    const graphic = plainW?.plain ? undefined : difficulty.simpleGraphic ? graphicFill(sourceW, coreW, W.width, W.height) : undefined;
    await breathe();
    const sourceCanvas = await sharp(source.png).resize(canvas.width, canvas.height, { fit: 'fill' }).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();
    const fill = plainW?.plain ? { method: 'plain-field' as const, rgb: plainW.out } : graphic ? { method: 'graphic-fill' as const, rgb: graphic } : undefined;
    prefill = fill
      ? { method: fill.method, png: await blendIntoCanvas(sourceCanvas, await sharp(fill.rgb, { raw: { width: W.width, height: W.height, channels: 3 } }).png().toBuffer(), { map: alphaM, width: M.width, height: M.height }, canvas) }
      : { method: 'local-fill', png: await localFill(source.png, { map: coreM, width: M.width, height: M.height }, { map: alphaM, width: M.width, height: M.height }, canvas) };
    return prefill;
  };
  // 3. A simple background around every removed region — a plain field (flat color, gradient, glow), or a few flat brand
  // colors (a white field and a yellow curve) — is continued locally: its smooth surface, or region by region with the
  // boundaries extended. Validated like any candidate; no call, and nothing a model could repaint as a silhouette. A clean
  // simplified continuation is preferred to an edit that may be photoreal but broken.
  const simpleGraphic = difficulty.simpleGraphic && difficulty.palette.length <= 3, continuable = plainA.plain || simpleGraphic;
  if (!chosen && continuable && trust.trusted && options.deterministicBackground !== false && removal.length) {
    const start = await prefilled();
    if (start.method === 'plain-field' || start.method === 'graphic-fill') {
      const continued = await evaluate(start.method, start.png);
      if (acceptable(continued)) {
        chosen = continued;
        reasons.push(start.method === 'plain-field' ? 'The background around every removed area is a plain field (flat color or smooth gradient), so it is continued locally: the clean background with no reconstruction call.'
          : `The background around the removed areas is a simple graphic design (${difficulty.palette.length} flat colors), so it is continued region by region: the clean background with no reconstruction call.`);
      } else reasons.push(`The ${start.method === 'plain-field' ? 'plain-field' : 'graphic'} continuation is not usable (${[...continued.quality.reasons, ...continued.recreated.map(r => `recreates ${r.name ?? r.file}`)].join(', ')}).`);
    }
  }
  const localCandidate = candidates.find(c => LOCAL_METHODS.has(c.method));
  if (localCandidate) steps.push({ step: 'local-continuation', outcome: localCandidate === chosen ? 'chosen' : 'rejected', reason: reasons[reasons.length - 1] });
  else {
    const reason = chosen ? 'Not needed: an earlier background is already clean (no call).' : !removal.length ? 'Nothing was removed.'
      : options.deterministicBackground === false ? 'This run tries the reconstruction first; the continuation is only its fallback.'
      : !continuable ? 'The background is neither a plain field nor a simple graphic design, so a local continuation would be a guess.'
      : `${trust.reason} The reconstruction pass runs instead.`;
    steps.push({ step: 'local-continuation', outcome: 'skipped', reason });
    if (!chosen && removal.length) reasons.push(`No local continuation: ${reason}`);
  }
  // 4. One AI image edit from the original, validated. Never retried.
  if (!chosen) {
    reconstructionReason = reasons.join(' ');
    const size = reconstructionSize(canvas), reconstructor = ctx.deps.backgroundReconstructor;
    const key = size && reconstructor ? sha256(Buffer.from(JSON.stringify({ source: sha256(source.png), mask: sha256(coreM), size, prompt: CLEAN_BACKGROUND_PROMPT, model: reconstructor.model, prefill: plainA.plain ? 'plain-field' : difficulty.simpleGraphic ? 'graphic-fill' : 'local-fill' }))) : undefined;
    let ai: Buffer | undefined, why = '', aiCall = false, aiReused = false;
    if (key && record.reconstruction?.key === key && record.reconstruction.state === 'done' && existsSync(join(dir, AI_FILE))) { ai = read(AI_FILE); aiReused = true; }
    else if (!options.reconstructBackground) why = 'AI reconstruction is turned off for this run';
    else if (!size) why = `the canvas aspect ${canvas.width}×${canvas.height} is outside the 1:3–3:1 an image edit accepts`;
    else if (!reconstructor) why = 'no background reconstructor is configured';
    else if (!ctx.allowNewCalls) why = 'a resume or re-render never makes a new paid call';
    else if (calls.backgroundReconstruction >= 1) why = 'this run already used its one background reconstruction';
    else {
      const start = await prefilled();
      const inputs = await editInputs(source.png, { map: coreM, width: M.width, height: M.height }, size!, start.png);
      writeFileSync(join(dir, 'clean-background-mask.png'), inputs.mask);
      writeFileSync(join(dir, 'clean-background-input.png'), inputs.image);
      writeFileSync(join(dir, 'clean-background-request.json'), JSON.stringify({ method: 'images.edit', model: reconstructor.model, size: `${size!.width}x${size!.height}`, n: 1, output_format: 'png', prompt: CLEAN_BACKGROUND_PROMPT,
        image: `<clean-background-input.png: ${source.name === 'original' ? `original image ${source.file}` : `provider base ${source.file}`} with the removal area pre-filled (${start.method}), ${size!.width}x${size!.height}>`, mask: '<clean-background-mask.png: transparent = remove>',
        difficulty: difficulty.level, cacheKey: key }, null, 2));
      record.reconstruction = { key: key!, model: reconstructor.model, size: size!, state: 'sent', sentAt: new Date().toISOString() };
      calls.backgroundReconstruction++; aiCall = true;
      ctx.save();
      const started = Date.now();
      try {
        const result = await reconstructor.reconstruct({ image: inputs.image, mask: inputs.mask, prompt: CLEAN_BACKGROUND_PROMPT, size: size! });
        const meta = await sharp(result.image).metadata().catch(() => undefined);
        if (!meta?.width || !meta.height) throw new Error('The image edit returned a file that is not an image.');
        writeFileSync(join(dir, AI_FILE), result.image);
        writeFileSync(join(dir, 'clean-background-response.json'), JSON.stringify(result.response ?? {}, null, 2));
        Object.assign(record.reconstruction, { state: 'done', durationMs: Date.now() - started, ...(result.requestId ? { requestId: result.requestId } : {}) });
        ai = result.image;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Object.assign(record.reconstruction, { state: 'failed', durationMs: Date.now() - started, error: { code: 'BACKGROUND_RECONSTRUCTION_FAILED', message } });
        why = `the OpenAI image edit failed: ${message}`;
      }
    }
    let aiCandidate: Candidate | undefined;
    if (ai) {
      aiTried = true;
      const sourceCanvas = await sharp(source.png).resize(canvas.width, canvas.height, { fit: 'fill' }).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();
      aiCandidate = await evaluate('ai-reconstruction', await blendIntoCanvas(sourceCanvas, ai, { map: alphaM, width: M.width, height: M.height }, canvas), ai);
      if (acceptable(aiCandidate)) chosen = aiCandidate;
      else why = `the AI edit is ${aiCandidate.quality.quality} (${[...aiCandidate.quality.reasons, ...aiCandidate.recreated.map(r => `recreates ${r.name ?? r.file}`)].join(', ')})`;
    }
    // 5. The deterministic continuation, when the edit is unavailable, failed or not usable. A degraded edit is only kept
    // when the fallback is no better, and so is the provider's base when its only fault is its tones outside the removed
    // area: clean behind the foreground (nothing of a removed layer, no ghost), and what differs is mostly its tone, not
    // content of the creative's background it lacks (a disc's wedge missing from it: the continuation keeps that).
    if (!chosen) {
      const fill = await prefilled(), fallback = candidates.find(c => c.png === fill.png) ?? await evaluate(fill.method, fill.png);
      const rank = (c: Candidate) => (c.recreated.length ? 3 : 0) + ({ usable: 0, degraded: 1, failed: 2 } as const)[c.quality.quality];
      let providerBase = candidates.find(c => c.method === 'provider-base' && c.quality.quality === 'degraded' && !c.recreated.length && c.quality.reasons.every(r => r === 'background-mismatch'));
      if (providerBase) {
        const rgb = await rgbOnGrid(providerBase.png, A), keep = grow(coreA, A.width, A.height, 2);
        let mismatched = 0, lacking = 0;
        for (let i = 0; i < nA; i++) if (!keep[i] && Math.max(Math.abs(rgb[i * 3] - originalA[i * 3]), Math.abs(rgb[i * 3 + 1] - originalA[i * 3 + 1]), Math.abs(rgb[i * 3 + 2] - originalA[i * 3 + 2])) > 40) { mismatched++; if (baseContent?.[i]) lacking++; }
        if (lacking > 0.25 * mismatched) providerBase = undefined;
      }
      // On a tie the edit is kept, then the provider's base: each is this background, the fallback a guess at it.
      chosen = aiCandidate && aiCandidate.quality.quality !== 'failed' && rank(aiCandidate) <= rank(fallback) ? aiCandidate
        : providerBase && rank(providerBase) <= rank(fallback) ? providerBase : fallback;
      if (chosen === providerBase) providerKept = !!reasons.push(`Kept Seedream's base although its tones differ from the creative's outside the removed area (background-mismatch): it is clean behind the foreground, and the continuation is no better. Review it: it is not a verified clean background.`);
      else if (chosen === fallback) {
        fallbackUsed = true;
        reasons.push(`Fell back to a ${fill.method === 'plain-field' ? 'plain-field continuation of the surrounding background' : fill.method === 'graphic-fill' ? 'graphic continuation of the surrounding background' : 'local fill'} because ${why}. This is not an AI-reconstructed background.${chosen.quality.quality !== 'usable' ? ' Review it: it is not a verified clean background.' : ''}`);
      } else reasons.push(`Kept the AI edit although it is ${aiCandidate!.quality.quality}: the fallback is no better.`);
    }
    steps.push(aiCandidate ? { step: 'ai-reconstruction', outcome: aiCandidate === chosen ? 'chosen' : 'rejected', call: aiCall,
      reason: aiCandidate === chosen ? `The image edit is ${aiCandidate.quality.quality}${aiCandidate.quality.quality === 'usable' ? '' : ` (${faults(aiCandidate)}), and the fallback is no better`}${aiReused ? ' (the saved edit was reused: no new call)' : ''}.` : `The image edit is ${aiCandidate.quality.quality} (${faults(aiCandidate)}).` }
      : { step: 'ai-reconstruction', outcome: 'skipped', call: aiCall, reason: why ? `${why[0].toUpperCase()}${why.slice(1)}.` : 'No image edit was made.' });
    if (fallbackUsed) steps.push({ step: 'fallback', outcome: 'chosen', reason: reasons[reasons.length - 1] });
    if (providerKept) steps.push({ step: 'provider-base', outcome: 'chosen', reason: reasons[reasons.length - 1] });
  } else steps.push({ step: 'ai-reconstruction', outcome: 'skipped', reason: 'Not needed: a clean background was found without a call.' });
  const backgroundPng = chosen!.png, method = chosen!.method;
  if (method !== 'provider-base') writeFileSync(join(dir, CLEAN_FILE), backgroundPng);
  // Validation: no extracted product recreated, and nothing left that no layer holds.
  const backgroundA = await rgbOnGrid(backgroundPng, A);
  const recreated = chosen!.recreated;
  // Seedream's base kept as is with no residual layer added: it differs from residual 1 only inside the extracted layers'
  // (filled) areas, which the check ignores, so residual 1's assessment is this background's. Otherwise it is assessed.
  const unchanged = method === 'provider-base' && !record.passes.some(p => p.accepted.length) && record.assessments[0]?.after === 0;
  const leftover = unchanged ? (({ after, residual, sent, ...assessment }) => { void after; void residual; void sent; return assessment; })(record.assessments[0])
    : assessBackgroundContamination({ rgb: backgroundA, width: A.width, height: A.height, explained: unionOf([...order.filter(item => explains(item, A)).map(item => item.shape.alpha), sceneMatch(order, backgroundA)], nA) }, assessing(ungrouped));
  if (recreated.length) reasons.push(`The background still shows ${recreated.map(r => `${r.name ?? r.file} (${r.retainedPercent}% of its distinctive pixels)`).join(', ')}.`);
  if (chosen!.quality.quality !== 'usable') reasons.push(`The area behind the foreground is ${chosen!.quality.quality}: ${chosen!.quality.reasons.join(', ')}.`);
  if (leftover.contaminated) reasons.push(`Objects no layer holds remain in the background: ${leftover.reasons.join(' ')}`);
  // A background continued from the original keeps whatever no layer took: content the clean base lacks makes it
  // contaminated, whatever else it passed (the check above cannot see it between the layers around it).
  const retained = source.name === 'original' ? retainedContent(backgroundA, originalA, await rgbOnGrid(base0Png, A),
    unionOf(order.filter(item => item.kind === 'foreground' || !isPlate(item, A)).map(item => { const a = new Uint8Array(nA); for (let i = 0; i < nA; i++) if (item.shape.rgba[i * 4 + 3] > 64) a[i] = 1; return a; }), nA), A, baseContent) : [];
  if (retained.length) record.warnings.push(`BACKGROUND_RETAINS_UNEXTRACTED: the background still shows ${retained.map(r => `${r.areaPercent}%`).join(', ')} of the image that no layer holds and the clean base lacks. Review the background.`);
  const contaminated = recreated.length > 0 || leftover.contaminated || chosen!.quality.quality === 'failed' || retained.length > 0;
  const status: CleanBackgroundStatus = retained.length ? 'contaminated' : fallbackUsed || providerKept ? 'fallback' : contaminated || chosen!.quality.quality !== 'usable' ? 'contaminated'
    : method === 'provider-base' ? 'provider-clean' : method === 'scene-composite' ? 'scene-clean' : method === 'ai-reconstruction' ? 'ai-reconstructed' : 'continued-clean';
  // Full background plates are the background, never a second layer on it (merged, duplicated, or replaced by the clean
  // background); then the editor's layers in numbers.
  const toScreen = (item: Item) => ({ layer: item.layer, shape: item.shape, kind: item.kind, role: item.role });
  const plates = screenPlates(order.map(toScreen), backgroundA, method, A, (chosen!.quality.quality === 'usable' || providerKept) && !contaminated), platesOut = new Map(plates.filter(d => !d.kept).map(d => [d.file, d]));
  for (const item of order.filter(item => platesOut.has(item.layer.file))) passTiles.push({ png: item.png, title: `✗ Not a layer · ${item.layer.name ?? item.layer.file}`, sub: `${platesOut.get(item.layer.file)!.reason} · in the background` });
  order = order.filter(item => !platesOut.has(item.layer.file));
  const backgroundFile = method === 'provider-base' ? base0.file : CLEAN_FILE;
  const needed = method !== 'provider-base';
  const { regions, ...leftoverSummary } = leftover;
  const aiCandidateRecord = candidates.find(c => c.method === 'ai-reconstruction');
  record.background = { status, method, file: backgroundFile, source: source.name, needed, contaminated, reasons, baseRetention, recreated, residual: { ...leftoverSummary, regions: regions.length },
    quality: chosen!.quality.quality, validation: chosen!.quality, difficulty, foregroundMaskCoverage: difficulty.coveragePercent, largestConnectedMaskCoverage: difficulty.largestComponentPercent,
    candidates: candidates.map(c => ({ method: c.method, quality: c.quality.quality, reasons: [...c.quality.reasons, ...c.recreated.map(r => `recreates ${r.name ?? r.file}`)], metrics: c.quality.metrics, chosen: c === chosen })),
    ...(reconstructionReason ? { reconstructionReason } : {}), fallbackUsed, aiTried, ...(aiCandidateRecord?.quality.metrics.outsideMaskChangedPercent !== undefined ? { outsideMaskChangedPercent: aiCandidateRecord.quality.metrics.outsideMaskChangedPercent } : {}),
    ...(shadow ? { shadow: { percent: shadow.percent, assessed: shadow.assessed, model: shadow.model, components: shadow.components, note: shadow.note } } : {}),
    plainField: { plain: plainA.plain, regions: plainA.regions.slice(0, 12) }, trust, steps };

  // The final stack contains curated editor layers only. Unplaced and superseded assets remain in the forensic record.
  const provenance = (item: Item) => {
    const box = item.shape.box, s = 1 / A.scale;
    return { sourcePass: item.pass, sourceImage: item.sourceImage, ...(item.pass > 0 ? { parentResidualId: `residual-pass-${item.pass}` } : {}), providerFile: item.layer.file, ...(item.requestId ? { providerRequestId: item.requestId } : {}),
      providerZIndex: item.providerZ, role: item.role, ...(box ? { bbox: [Math.round(box.x0 * s), Math.round(box.y0 * s), Math.round(box.x1 * s), Math.round(box.y1 * s)] as [number, number, number, number] } : {}),
      mask: item.layer.file, areaPercent: round(100 * item.shape.count / nA, 2) };
  };
  const backgroundLayer: LayerInfo = { ...base0, name: 'Background', ...(method !== 'provider-base' ? { file: CLEAN_FILE, rawFile: base0.file, opaquePercent: 100, pixelWidth: canvas.width, pixelHeight: canvas.height } : {}),
    cleanBackground: { status, method }, provenance: { sourcePass: 0, sourceImage: run.input.file, providerFile: base0.file, ...(run.seedream.requestId ? { providerRequestId: run.seedream.requestId } : {}), providerZIndex: base0.zIndex, role: 'background', mask: backgroundFile } };
  const curation = await curateLayers({ dir, canvas, grid: A, items: order,
    background: { layer: backgroundLayer, shape: await layerShape(backgroundPng, backgroundLayer, A), kind: 'background', role: 'background' },
    candidates: [...rawCandidates, ...grouping.groups.map(g => ({ layer: g.entry.layer, item: { ...g.entry, ...classify(g.entry.layer, g.entry.shape, A) }, source: 'group' as const })),
      ...items.filter(item => !rawCandidates.some(c => c.layer.file === item.layer.file)).map(item => ({ layer: item.layer, item, source: 'group' as const }))],
    decisions: [...screening, ...plates], groups: [...coverageGroups, ...grouping.groups.map(g => ({ file: g.entry.layer.file, members: g.members.map(m => m.layer.file) })),
      ...record.passes.filter(p => p.grouped?.length).map(p => ({ file: `pass-${p.pass}-grouped.png`, members: p.grouped! }))] });
  order = curation.items; record.curation = curation.record;
  record.layerPlan = layerPlan(order.map(toScreen), [...screening, ...plates] as UsefulnessDecision[], A, plainA.plain ? 'plain' : simpleGraphic ? 'graphic' : 'scene');
  if (record.layerPlan.dropped.length) record.warnings.push(`LAYERS_LEFT_OUT: ${record.layerPlan.dropped.length} layer(s) are not editor layers (${record.layerPlan.dropped.map(d => `${d.name ?? d.file}: ${d.reason}`).join('; ')}); ${record.layerPlan.editableLayers} editable layers remain.`);
  // Requested versus returned: an element the plan asked for as its own layer has one, or the run says why not.
  record.warnings.push(...plannedLayerIssues(semantic, roleOf, merged, rawCandidates.map(c => c.layer), order.map(item => item.layer), record.layerPlan.dropped, record.planCoverage?.matched));
  const stacked = order.map((item, i) => ({ ...item.layer, ...(renumber ? { zIndex: i + 1 } : {}), provenance: provenance(item) }));
  if (renumber) backgroundLayer.zIndex = 0;
  const layers: LayerInfo[] = [backgroundLayer, ...stacked]
    .map((l, index) => ({ ...l, index }));
  record.finalLayers = layers.length;

  // Fidelity of the reconstruction, before (Seedream's base + its layers) and after the refinement, against the original.
  const placedOf = (list: { png: Buffer; placement: Placement }[]) => compositeOnGrid(list, A).then(flattenRgba);
  const before = fidelity(originalA, await placedOf([{ png: base0Png, placement: base0.placement }, ...items.filter(item => item.pass === 0).sort((a, b) => a.providerZ - b.providerZ).map(item => ({ png: item.png, placement: item.layer.placement }))]));
  const after = fidelity(originalA, await placedOf([{ png: backgroundPng, placement: base0.placement }, ...order.map(item => ({ png: item.png, placement: item.layer.placement }))]));
  record.fidelity = { before, after };

  // Outputs: layers.json (same shape, additive fields), reconstructed.png, contact-sheet.png in debugging order, debug JSON.
  const pngs = new Map<string, Buffer>([[backgroundLayer.file, backgroundPng], ...items.map(item => [item.layer.file, item.png] as const)]);
  const pngOf = (l: LayerInfo) => pngs.get(l.file) ?? read(l.file);
  const warnings = [...new Set([...ctx.renderWarnings, ...record.warnings])];
  await composeLayers(join(dir, 'reconstructed.png'), canvas, await Promise.all(layers.map(async l => ({ png: pngOf(l), zIndex: l.zIndex, placement: l.placement }))));
  const summary = { passesExecuted: record.passesExecuted, residualPasses, stopReason: record.stopReason, finalLayers: layers.length, background: { status, method }, calls: { ...calls },
    protectedGroups: run.interactions?.groups ?? 0, layersLeftOut: record.layerPlan.dropped.length };
  const rawLayers = rawCandidates.map(c => ({ ...c.layer, ...(c.item && 'pass' in c.item ? { provenance: provenance(c.item as Item) } : {}) }));
  writeFileSync(join(dir, 'layers.json'), JSON.stringify({ canvas, warnings, layers, refinement: summary, rawLayers, curation: record.curation, editorLayerFiles: layers.map(l => l.file) }, null, 2));
  const finalIndex = new Map(layers.map((l, i) => [l.file, i]));
  await writeContactSheet(join(dir, 'contact-sheet.png'), [
    { png: source.png, title: 'Original', sub: `${source.name === 'original' ? run.input.file : 'provider base (aspect differs)'} · ${canvas.width}×${canvas.height}` },
    { png: backgroundPng, title: `Background: ${status}`, sub: `${method} · ${chosen!.quality.quality} · ${difficulty.level}${contaminated ? ' · still contaminated' : ''}` },
    ...candidates.filter(c => c !== chosen).map(c => ({ png: c.png, title: `✗ Background candidate: ${c.method}`, sub: `${c.quality.quality}${c.quality.reasons.length ? `: ${c.quality.reasons.join(', ')}` : ''}${c.recreated.length ? ' · recreates layers' : ''}` })),
    ...items.filter(item => item.pass === 0).sort((a, b) => a.providerZ - b.providerZ).map(item => ({ png: item.png, title: `P0 · ${item.layer.name ?? 'layer'}`, sub: `${finalIndex.has(item.layer.file) ? `z${layers[finalIndex.get(item.layer.file)!].zIndex}` : 'not a layer'} · ${item.kind === 'background' ? 'background' : item.role} · ${round(100 * item.shape.count / nA, 1)}%` })),
    ...passTiles,
    { png: read(MASK_FILE), title: 'Foreground union mask', sub: `${record.mask.coveragePercent}% removed · grow ${record.mask.dilatePx}px · feather ${record.mask.featherPx}px${record.mask.shadowPercent ? ` · ${record.mask.shadowPercent}% cast shadow` : ''}` },
    ...(record.mask.shadowFile ? [{ png: read(record.mask.shadowFile), title: 'Cast shadows removed', sub: shadow!.note }] : []),
    { png: read('reconstructed.png'), title: 'Reconstruction', sub: `mean Δ ${after.meanAbsDiff} (before ${before.meanAbsDiff}) · changed ${after.changedPercent}%` },
  ]);
  record.state = 'done';
  writeFileSync(join(dir, DEBUG_FILE), JSON.stringify({ runId: run.id, generatedAt: new Date().toISOString(), calls: { ...calls }, callSummary: callLines(calls), summary,
    options, passes: record.passes, assessments: record.assessments, stopReason: record.stopReason, stopDetail: record.stopDetail, mask: record.mask, background: record.background, reconstruction: record.reconstruction,
    fidelity: record.fidelity, warnings: record.warnings, interactions: run.interactions, layerPlan: record.layerPlan, planCoverage: record.planCoverage,
    rawLayers, curation: record.curation, editorLayerFiles: layers.map(l => l.file),
    layers: layers.map(l => ({ file: l.file, name: l.name, zIndex: l.zIndex, placement: l.placement.kind, provenance: l.provenance, cleanBackground: l.cleanBackground, grouping: l.grouping })) }, null, 2));
  const out = [`RECURSIVE_DECOMPOSITION: ${record.passesExecuted} pass(es) (1 initial + ${residualPasses} residual); stopped: ${record.stopReason}. ${layers.length} layers. Background: ${status} (${method}).`, ...record.warnings];
  if (status === 'fallback' || status === 'contaminated') out.push(`BACKGROUND_${status.toUpperCase()}: ${reasons.join(' ')}`);
  return { layers, warnings: out };
}
